// Unit tests for useSettingsDraft (issue #449) — the derived-state hook that replaced
// SettingsRecording's old `useEffect(() => setForm(settings), [settings])` sync effect (see
// useSettingsDraft.js's own comment for why that effect was the bug). These pin the same properties
// settingsRecording.test.jsx exercises through the UI, but directly against the hook, so a future
// page that adopts it (Wave 5: SettingsGeneral.jsx / SettingsCamera.jsx have the milder version of
// the same "server wins on refresh" pattern) has something to test against without re-deriving these
// from scratch.
import { describe, test, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSettingsDraft } from '../../src/lib/useSettingsDraft.js';

function setup(initialSettings) {
  return renderHook(({ settings }) => useSettingsDraft(settings), {
    initialProps: { settings: initialSettings },
  });
}

describe('form derivation', () => {
  test('an untouched key tracks the server settings object across a refresh', () => {
    const { result, rerender } = setup({ a: 1, b: 2 });
    expect(result.current.form).toEqual({ a: 1, b: 2 });
    rerender({ settings: { a: 1, b: 5 } }); // a fresh object, as a real refresh() would publish
    expect(result.current.form.b).toBe(5);
  });

  test('a drafted key overrides the server value, and SURVIVES a settings change — the #449 bug', () => {
    const { result, rerender } = setup({ a: 1, b: 2 });
    act(() => result.current.setField('a', 99));
    expect(result.current.form.a).toBe(99);
    // A fresh object with the SAME values is exactly what tripped the old sync effect: it re-fires
    // on any new reference, not only a real value change.
    rerender({ settings: { a: 1, b: 2 } });
    expect(result.current.form.a).toBe(99);
    expect(result.current.form.b).toBe(2); // untouched key still tracks settings
  });

  test('a stored ZERO is not mistaken for "unset" — setField(key, 0) is a real draft', () => {
    // Recording settings use 0 to mean "no limit" (docs/recording.md). If setField ever used `||`
    // instead of always recording the value, typing 0 would vanish.
    const { result } = setup({ a: 5 });
    act(() => result.current.setField('a', 0));
    expect(result.current.form.a).toBe(0);
    expect(result.current.dirtyKeys).toEqual(['a']);
  });

  test('setFields records several drafts at once', () => {
    const { result } = setup({ a: 1, b: 2, c: 3 });
    act(() => result.current.setFields({ b: 20, c: 30 }));
    expect(result.current.form).toEqual({ a: 1, b: 20, c: 30 });
    expect(result.current.dirtyKeys.sort()).toEqual(['b', 'c']);
  });
});

describe('markSaved', () => {
  test('drops a draft whose current value matches what was sent', () => {
    const { result } = setup({ a: 1 });
    act(() => result.current.setField('a', 5));
    act(() => result.current.markSaved({ a: 5 }));
    expect(result.current.dirtyKeys).toEqual([]);
    expect(result.current.form.a).toBe(1); // now tracks settings again — nothing shadows it
  });

  test('keeps a draft edited AGAIN after the value that was sent — an in-flight edit is not lost', () => {
    const { result } = setup({ a: 1 });
    act(() => result.current.setField('a', 5)); // this is what gets "sent"
    act(() => result.current.setField('a', 9)); // edited again before the save resolves
    act(() => result.current.markSaved({ a: 5 })); // the request that went out carried the OLD value
    expect(result.current.form.a).toBe(9);
    expect(result.current.dirtyKeys).toEqual(['a']);
  });

  test('leaves a key that was never a draft alone, even if markSaved is told about it', () => {
    // markSaved only ever REMOVES drafts — it has no way to (and must not) update `settings` itself;
    // that is commit()'s job, one layer up. So once 'a' drops out of drafts, `form.a` falls back to
    // whatever `settings.a` already was (1, unchanged here) — NOT to the value that was sent.
    const { result } = setup({ a: 1, b: 2 });
    act(() => result.current.setField('a', 5));
    act(() => result.current.markSaved({ a: 5, b: 2 })); // b was never touched
    expect(result.current.dirtyKeys).toEqual([]);
    expect(result.current.form).toEqual({ a: 1, b: 2 });
  });

  test('a later, different settings value shows through once the draft is dropped — proof it actually cleared', () => {
    const { result, rerender } = setup({ a: 1 });
    act(() => result.current.setField('a', 5));
    act(() => result.current.markSaved({ a: 5 }));
    rerender({ settings: { a: 45 } }); // e.g. a later save from elsewhere, or an admin editing directly
    expect(result.current.form.a).toBe(45);
  });
});

describe('dirtyKeys', () => {
  test('is empty with nothing edited', () => {
    const { result } = setup({ a: 1 });
    expect(result.current.dirtyKeys).toEqual([]);
  });
});
