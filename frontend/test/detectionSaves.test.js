// Unit tests for the per-camera detection save queue (issue #444) — the module that decides when a
// PUT /:id/detection actually goes out, for both DetectionSettings.jsx and CameraTile.jsx's quick
// toggles. These test the queue directly, with an injected `send` returning controllable promises, so
// they can pin the three defects the old per-component debounce had (a save cancelled by navigating
// away, a failure that looked like success, two writes racing) without rendering a page.
//
// Page-level behaviour (what actually shows on screen, real debounce timing) is covered instead in
// detectionSettings.test.jsx (T1-T7) — fake timers and a real 700ms debounce interact badly, so this
// file avoids the timer question entirely: every test either uses `immediate: true` (skips the
// debounce) or drives the debounce explicitly via `flush()`.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  queuePatch, flush, retry, toPartialPayload, useDetectionSave, pendingPatch, __resetForTests,
} from '../src/lib/detectionSaves.js';

beforeEach(() => {
  __resetForTests();
});

// A promise this test controls the settlement of, plus the functions to do it with.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Lets every microtask queued so far run, including ones chained through an ADOPTED promise (the
// queue's `.then(() => sendFn(...))` step takes an extra microtask hop to adopt whatever `sendFn`
// returns) — a bare `await somePromise` in a test can resolve before that hop completes. A real
// macrotask boundary (setTimeout) is what actually guarantees the microtask queue has drained.
const flushAsync = () => new Promise((r) => setTimeout(r, 0));

function watch(cameraId) {
  return renderHook(() => useDetectionSave(cameraId));
}

describe('Q1 — a single change', () => {
  test('produces one send, then saved, with the pending patch cleared', async () => {
    const { result } = watch('cam-1');
    const calls = [];
    const onSaved = vi.fn();
    const d = deferred();
    act(() => {
      queuePatch('cam-1', { sound_sensitivity: 30 }, {
        kind: 'sound', immediate: true, onSaved,
        send: (payload) => { calls.push(payload); return d.promise; },
      });
    });
    expect(calls).toEqual([{ sound_sensitivity: 30 }]);
    expect(result.current.state).toBe('saving');

    await act(async () => { d.resolve(); await flushAsync(); });
    expect(result.current.state).toBe('saved');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(pendingPatch('cam-1')).toEqual({});
    expect(calls.length, 'no second send fired on its own').toBe(1);
  });
});

describe('Q2 — serialization (the core of defect 3)', () => {
  test('a send in flight blocks later patches from sending; exactly one further send fires once it resolves, carrying the latest value', async () => {
    const calls = [];
    const deferreds = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const send = (payload) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(payload);
      const dfd = deferred();
      deferreds.push(dfd);
      return dfd.promise.finally(() => { inFlight -= 1; });
    };

    act(() => { queuePatch('cam-1', { sensitivity: 10 }, { kind: 'motion', immediate: true, send }); }); // A
    expect(calls.length).toBe(1);
    act(() => { queuePatch('cam-1', { sensitivity: 20 }, { kind: 'motion', immediate: true, send }); }); // B
    act(() => { queuePatch('cam-1', { sensitivity: 30 }, { kind: 'motion', immediate: true, send }); }); // C
    // Neither B nor C sent yet — A is still in flight.
    expect(calls.length).toBe(1);
    expect(maxInFlight).toBe(1);

    await act(async () => { deferreds[0].resolve(); await flushAsync(); });
    expect(calls.length, 'exactly one further send, not two').toBe(2);
    expect(calls[1], 'carries C, the latest value — not B').toEqual({ sensitivity: 30 });

    await act(async () => { deferreds[1].resolve(); await flushAsync(); });
    expect(maxInFlight, 'never more than one in flight at once').toBe(1);
  });
});

describe('Q3 — failure', () => {
  test('a rejected send fails visibly; Retry resends the same value and can then succeed', async () => {
    const { result } = watch('cam-1');
    const calls = [];
    const dq = [];
    const send = (payload) => {
      calls.push(payload);
      const dfd = deferred();
      dq.push(dfd);
      return dfd.promise;
    };

    act(() => { queuePatch('cam-1', { sensitivity: 40 }, { kind: 'motion', immediate: true, send }); });
    await act(async () => { dq[0].reject(new Error('camera offline')); await flushAsync(); });
    expect(result.current.state).toBe('failed');
    expect(pendingPatch('cam-1'), 'the value is retained, not discarded').toEqual({ sensitivity: 40 });

    act(() => { retry('cam-1'); });
    expect(calls[1], 'retry resends the SAME value').toEqual({ sensitivity: 40 });
    expect(result.current.state).toBe('saving');

    await act(async () => { dq[1].resolve(); await flushAsync(); });
    expect(result.current.state).toBe('saved');
    expect(pendingPatch('cam-1')).toEqual({});
  });
});

describe('Q4 — cameras are independent', () => {
  test('a failure on one camera does not block or alter another', async () => {
    const a = watch('cam-A');
    const b = watch('cam-B');
    const dA = deferred();
    act(() => { queuePatch('cam-A', { sensitivity: 1 }, { kind: 'motion', immediate: true, send: () => dA.promise }); });
    await act(async () => { dA.reject(new Error('down')); await flushAsync(); });
    expect(a.result.current.state).toBe('failed');
    expect(b.result.current.state, 'untouched by A').toBe('idle');

    const dB = deferred();
    const onSavedB = vi.fn();
    act(() => {
      queuePatch('cam-B', { sensitivity: 2 }, { kind: 'motion', immediate: true, send: () => dB.promise, onSaved: onSavedB });
    });
    await act(async () => { dB.resolve(); await flushAsync(); });
    expect(b.result.current.state).toBe('saved');
    expect(onSavedB).toHaveBeenCalledTimes(1);
    expect(a.result.current.state, 'B succeeding does not clear A\'s failure').toBe('failed');
  });
});

describe('Q5 — a stale success (Codex F2)', () => {
  test('A in flight, B queued, A resolves: never reports saved while B is unsent, onSaved does not fire for A alone, and B sends immediately', async () => {
    const { result } = watch('cam-1');
    const calls = [];
    const dq = [];
    const onSaved = vi.fn();
    const send = (payload) => {
      calls.push(payload);
      const dfd = deferred();
      dq.push(dfd);
      return dfd.promise;
    };

    act(() => { queuePatch('cam-1', { sensitivity: 1 }, { kind: 'motion', immediate: true, send, onSaved }); }); // A
    act(() => { queuePatch('cam-1', { sensitivity: 2 }, { kind: 'motion', immediate: true, send, onSaved }); }); // B (blocked)
    expect(calls.length).toBe(1);

    await act(async () => { dq[0].resolve(); await flushAsync(); }); // A's (stale) response lands
    expect(result.current.state, 'must never show saved while B is still unsent').toBe('saving');
    expect(onSaved, 'onSaved must not fire for the stale A response alone').not.toHaveBeenCalled();
    expect(calls.length, 'B is sent right away, not after another debounce').toBe(2);
    expect(calls[1]).toEqual({ sensitivity: 2 });

    await act(async () => { dq[1].resolve(); await flushAsync(); });
    expect(result.current.state).toBe('saved');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe('Q6 — a stale failure', () => {
  test('A in flight, B queued (a different field), A fails: Retry sends the merge, with B winning on overlap', async () => {
    const { result } = watch('cam-1');
    const calls = [];
    const dq = [];
    const send = (payload) => {
      calls.push(payload);
      const dfd = deferred();
      dq.push(dfd);
      return dfd.promise;
    };

    act(() => { queuePatch('cam-1', { sensitivity: 1, cooldown_s: 5 }, { kind: 'motion', immediate: true, send }); }); // A
    act(() => { queuePatch('cam-1', { sensitivity: 2 }, { kind: 'motion', immediate: true, send }); }); // B: overlaps `sensitivity`
    await act(async () => { dq[0].reject(new Error('offline')); await flushAsync(); });
    expect(result.current.state).toBe('failed');
    expect(pendingPatch('cam-1'), "B's sensitivity wins; A's untouched cooldown_s survives").toEqual({ sensitivity: 2, cooldown_s: 5 });

    act(() => { retry('cam-1'); });
    expect(calls[1]).toEqual({ sensitivity: 2, cooldown_s: 5 });
    await act(async () => { dq[1].resolve(); await flushAsync(); });
    expect(result.current.state).toBe('saved');
  });
});

describe('Q7 — no stale Saved', () => {
  test('a new patch right after a save shows saving immediately', async () => {
    const { result } = watch('cam-1');
    const d1 = deferred();
    act(() => { queuePatch('cam-1', { sensitivity: 1 }, { kind: 'motion', immediate: true, send: () => d1.promise }); });
    await act(async () => { d1.resolve(); await flushAsync(); });
    expect(result.current.state).toBe('saved');

    const d2 = deferred();
    act(() => { queuePatch('cam-1', { sensitivity: 2 }, { kind: 'motion', immediate: true, send: () => d2.promise }); });
    expect(result.current.state, 'no stale "Saved" left showing').toBe('saving');
  });
});

describe('Q8 — flush is idempotent', () => {
  test('calling flush twice, or again after it has already sent, produces exactly one send per revision', async () => {
    const calls = [];
    const d1 = deferred();
    // Not immediate: nothing sends until flush() (or the real debounce) fires.
    queuePatch('cam-1', { sensitivity: 1 }, { kind: 'motion', send: (p) => { calls.push(p); return d1.promise; } });
    expect(calls.length).toBe(0);

    flush('cam-1');
    expect(calls.length, 'the first flush sends').toBe(1);
    flush('cam-1');
    flush('cam-1');
    expect(calls.length, 'later flushes with nothing new pending are no-ops').toBe(1);

    await act(async () => { d1.resolve(); await flushAsync(); });
    flush('cam-1'); // after a successful send, still nothing pending
    expect(calls.length).toBe(1);
  });
});

describe('Q9 — payload shape', () => {
  test('a payload carries only the changed keys; a blank snapshot_password sends nothing at all', async () => {
    // Updated for issue #444 fix 4 (adversarial review round): sendability used to be checked on the
    // RAW patch, so `{ snapshot_password: '' }` — non-empty as a patch — still reached `send` with an
    // EMPTY converted payload `{}`, once carrying nothing but a blank password. This test used to
    // assert exactly that (`calls[1]` was the empty send). Fixed: `doSend` now checks the CONVERTED
    // payload, so a patch that converts away to nothing is never sent at all — see the F4 test below
    // for the queue-level assertion on that guard directly.
    const calls = [];
    const send = (p) => { calls.push(p); return Promise.resolve(); };

    queuePatch('cam-1', { start: '21:30' }, { kind: 'schedule', immediate: true, send });
    await flushAsync();
    expect(calls[0]).toEqual({ start: 1290 });
    expect(Object.keys(calls[0])).toEqual(['start']);

    queuePatch('cam-1', { snapshot_password: '' }, { kind: 'motion', immediate: true, send });
    await flushAsync();
    expect(calls.length, 'a blank password produces no send at all, not an empty one').toBe(1);

    queuePatch('cam-1', { snapshot_password: 'typed-pw' }, { kind: 'motion', immediate: true, send });
    await flushAsync();
    expect(calls[1]).toEqual({ snapshot_password: 'typed-pw' });
  });

  test('toPartialPayload applies the same conversion toPayload-style callers rely on', () => {
    expect(toPartialPayload({ motion_enabled: 1, sensitivity: '40', start: '20:00', end: '07:00', zone: undefined }))
      .toEqual({ motion_enabled: true, sensitivity: 40, start: 1200, end: 420, zone: null });
    // A full `d`-shaped object round-trips exactly like the old full-payload toPayload did — the two
    // were never two functions to keep in sync, they are the same function.
    expect(toPartialPayload({ source: 'mqtt', motion_mqtt_topic: 'a/b' })).toEqual({ source: 'mqtt', motion_mqtt_topic: 'a/b' });
  });
});

describe('Q10 — reset invalidates stale promises', () => {
  test('__resetForTests makes a late resolution from before the reset a no-op', async () => {
    const dq = [];
    const send = () => { const dfd = deferred(); dq.push(dfd); return dfd.promise; };
    const onSaved = vi.fn();
    queuePatch('cam-1', { sensitivity: 1 }, { kind: 'motion', immediate: true, send, onSaved });

    __resetForTests();

    const send2 = vi.fn(() => Promise.resolve());
    const onSaved2 = vi.fn();
    queuePatch('cam-1', { sensitivity: 2 }, { kind: 'motion', immediate: true, send: send2, onSaved: onSaved2 });
    await flushAsync();

    // The pre-reset send finally settles — after the reset, after a fresh entry already exists.
    dq[0].resolve();
    await flushAsync();

    expect(onSaved, 'the stale completion must not fire the OLD callback').not.toHaveBeenCalled();
    expect(onSaved2, 'the fresh entry saved normally').toHaveBeenCalledTimes(1);
    expect(pendingPatch('cam-1'), 'the stale resolution must not touch the fresh entry').toEqual({});
  });
});

// -------------------------------------------------------------------------------------------
// Adversarial review round on this same queue (still issue #444) found four more defects — F1-F4
// below, one test per fix. On the pre-review code `queuePatch()` returned nothing at all (implicit
// undefined), so F1 and F3 both fail immediately with a TypeError calling `.then()` on it — the same
// root cause the plan calls out ("ONE design fixes both" F1 and F3). F2 and F4 fail on their own,
// distinct assertions against the pre-review behaviour of `pendingPatch()` and `doSend()`.

describe('F1 — queuePatch() returns a per-call promise (fix 1: the old CameraTile wrapper)', () => {
  test('a call queued behind an in-flight send gets its OWN promise, resolved once the batch that actually carries it succeeds — via the LATEST send', async () => {
    const dq = [];
    function makeSend() {
      return vi.fn(() => {
        const d = deferred();
        dq.push(d);
        return d.promise;
      });
    }
    const sendA = makeSend(); // the page: a slow PUT, already in flight
    const sendB = makeSend(); // the tile: queues its own toggle while A is in flight
    const sendC = makeSend(); // the page: queues ANOTHER change, after B, with yet another send

    act(() => { queuePatch('cam-1', { sensitivity: 1 }, { kind: 'motion', immediate: true, send: sendA }); });
    expect(sendA).toHaveBeenCalledTimes(1);

    const bPromise = queuePatch('cam-1', { sound_enabled: true }, { kind: null, immediate: true, send: sendB });
    let bSettled = false;
    bPromise.then(() => { bSettled = true; }, () => { bSettled = true; });

    queuePatch('cam-1', { cooldown_s: 90 }, { kind: 'motion', immediate: true, send: sendC });

    expect(sendB, 'B must not have sent yet — A is still in flight').not.toHaveBeenCalled();
    expect(sendC, 'C must not have sent yet either').not.toHaveBeenCalled();
    expect(bSettled, "B's own promise must not settle before ITS batch actually sends").toBe(false);

    // A resolves. Stale (B and C arrived meanwhile): must not settle B's promise, and the coalesced
    // B+C patch must go out through the LATEST send (C's) — the whole point of the old design
    // breaking, since the entry has only one `send` slot and B's queuePatch call already lost it.
    await act(async () => { dq[0].resolve(); await flushAsync(); });
    expect(sendB, 'B never gets its own send — it is coalesced into the next batch').not.toHaveBeenCalled();
    expect(sendC, 'the send used for the coalesced batch is the latest (C)').toHaveBeenCalledTimes(1);
    expect(sendC.mock.calls[0][0], 'the batch carries BOTH B and C — nothing lost').toEqual({ sound_enabled: true, cooldown_s: 90 });
    expect(bSettled, "B's promise still must not resolve — the batch carrying it hasn't completed").toBe(false);

    await act(async () => { dq[1].resolve(); await flushAsync(); });
    expect(bSettled, 'resolves once the batch actually carrying B (merged with C) is saved').toBe(true);
    await expect(bPromise).resolves.toBeUndefined();
  });
});

describe('F2 — pendingPatch() includes the in-flight snapshot (fix 2)', () => {
  test('a send in flight is still visible to pendingPatch(); gone once it succeeds', async () => {
    const d = deferred();
    act(() => {
      queuePatch('cam-1', { sensitivity: 42 }, { kind: 'motion', immediate: true, send: () => d.promise });
    });
    // doSend has already cleared `pending` the instant the send started — pendingPatch() must still
    // report these keys via inFlightPatch, or a screen revisited right now (while "Saving…" shows)
    // would seed its form from the stale CamerasContext values instead (issue #444 fix 2).
    expect(pendingPatch('cam-1'), "an in-flight patch's keys must still be visible").toEqual({ sensitivity: 42 });

    await act(async () => { d.resolve(); await flushAsync(); });
    expect(pendingPatch('cam-1'), 'nothing left pending once the send has succeeded').toEqual({});
  });
});

describe('F3 — queuePatch() awaits onSaved before resolving (fix 3)', () => {
  test("a slow onSaved delays the caller's promise", async () => {
    const d = deferred();
    const savedGate = deferred();
    const promise = queuePatch('cam-1', { sensitivity: 5 }, {
      kind: 'motion', immediate: true, send: () => d.promise, onSaved: () => savedGate.promise,
    });
    let settled = false;
    promise.then(() => { settled = true; });

    await act(async () => { d.resolve(); await flushAsync(); });
    expect(settled, 'must not resolve while the refresh it triggered is still pending').toBe(false);

    await act(async () => { savedGate.resolve(); await flushAsync(); });
    expect(settled, 'resolves once the refresh has settled too').toBe(true);
  });

  test('a REJECTING onSaved still resolves the save promise — a refresh failure is not a save failure', async () => {
    const d = deferred();
    const promise = queuePatch('cam-2', { sensitivity: 6 }, {
      kind: 'motion', immediate: true, send: () => d.promise,
      onSaved: () => Promise.reject(new Error('refresh failed')),
    });
    await act(async () => { d.resolve(); await flushAsync(); });
    await expect(promise, 'the PUT succeeded — the save promise must resolve regardless of the refresh').resolves.toBeUndefined();
  });
});

describe('F4 — an empty CONVERTED payload never sends (fix 4)', () => {
  test('a patch that converts away to nothing (a cleared snapshot_password) never calls send, and settles cleanly', async () => {
    const { result } = watch('cam-1');
    const send = vi.fn(() => Promise.resolve());
    let promise;
    act(() => {
      promise = queuePatch('cam-1', { snapshot_password: '' }, { kind: 'motion', immediate: true, send });
    });
    await flushAsync();
    expect(send, 'a blank password converts to an empty payload — nothing to send').not.toHaveBeenCalled();
    expect(result.current.state, 'settles as idle, not stuck "saving" forever').toBe('idle');
    expect(pendingPatch('cam-1')).toEqual({});
    await expect(promise, "the caller's own promise still resolves — nothing was left undone").resolves.toBeUndefined();
  });
});
