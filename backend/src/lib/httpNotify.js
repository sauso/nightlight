import { logger } from './logger.js';

// One bounded HTTP POST, shared by every notification provider (ntfy, Gotify, Pushover).
//
// The defect this exists for (issue #262): all four provider calls were a bare `fetch` with no
// AbortController, so the only bound was undici's default `headersTimeout` of 300 SECONDS. Two
// symptoms, both real:
//   1. The admin Test button hangs for five minutes with no feedback. Self-hosted ntfy and Gotify are
//      the common case for those two providers, and a half-up server that accepts the TCP connection
//      and then stops answering is exactly the failure they exhibit.
//   2. Memory is pinned. Alert sends are fire-and-forget so they never block detection — but a hung
//      Pushover send holds its JPEG snapshot buffer for the full 300s, and a camera flapping during a
//      network partition stacks those up.
//
// ⚠️ THE TIMER MUST OUTLIVE THE FETCH, and that is the part it is easy to get wrong. `fetch` resolves
// as soon as the response HEADERS arrive; the body can then hang indefinitely on its own. Every caller
// reads a body (`res.text()` / `res.json()`), so clearing the timeout the moment fetch resolves would
// leave that read unbounded and reintroduce the bug through the back door. This helper therefore reads
// the body ITSELF, inside the same abort window, and hands back plain text — which is also why callers
// get `text` and parse it rather than being handed a live Response they could accidentally await.
//
// Modelled on fetchHttpSnapshot in snapshot.js, which already did this correctly.

// A doorbell, not a durable queue: a notification nobody has accepted within ten seconds is not going
// to be useful by the time it arrives. Long enough that a slow uplink pushing a ~200KB snapshot still
// gets through, short enough that the Test button gives an answer while someone is still looking at it.
export const NOTIFY_TIMEOUT_MS = 10_000;

/**
 * POST with a hard upper bound covering both the request and the body read.
 *
 * Resolves `{ ok, status, text }` — never a live Response. Throws on network failure or timeout, with
 * a message the provider's existing catch block can show a user as-is.
 */
export async function postWithTimeout(url, options = {}, { timeoutMs = NOTIFY_TIMEOUT_MS, label = 'http' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    // Read inside the abort window — see the warning above.
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      // ⚠️ A BLANKET `.catch(() => '')` HERE IS A BUG, and it is the one this file was written to fix.
      // It swallows the abort too, so a server that sends headers and then holds the body open forever
      // returns `{ ok: true, text: '' }` after the timeout instead of failing — the request is bounded,
      // but the caller is told it succeeded. Caught by notify-timeouts.test.js on its first run.
      // A body we cannot read for any OTHER reason is still not fatal: callers only use it to quote the
      // provider's error text, so an empty string degrades the message rather than the delivery.
      if (ctrl.signal.aborted) throw e;
    }
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    // AbortError's own message ("This operation was aborted") tells a user nothing about what to do,
    // and these strings are surfaced verbatim in the app by the Test buttons.
    // Keyed on the signal rather than `e.name`: whatever the runtime chooses to throw out of an
    // aborted body read, the reason we stopped is the same one.
    if (ctrl.signal.aborted || e?.name === 'AbortError') {
      const secs = Math.round(timeoutMs / 1000);
      logger.error(`[${label}] request timed out after ${secs}s — the server accepted the connection but stopped responding`);
      throw new Error(`timed out after ${secs}s — the server accepted the connection but stopped responding`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Providers return JSON on both success and error paths; this keeps the "malformed body is not a
// crash" handling in one place rather than four `.catch(() => ({}))` copies.
export function parseJson(text) {
  try {
    return JSON.parse(text) || {};
  } catch {
    return {};
  }
}
