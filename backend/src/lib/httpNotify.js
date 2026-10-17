import { STATUS_CODES } from 'node:http';
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

// ⚠️ A REQUEST THAT CANNOT BE BUILT MUST NOT QUOTE ITSELF (post-merge review of PR #702). Node's fetch refuses a
// header value holding CR, LF or NUL with `Headers.append: "<the WHOLE value>" is an invalid header value.`, and a
// URL with user:pass@ in it with `Request cannot be constructed from a URL that includes credentials: <url>`
// (both measured on Node 24.18). The providers log e.message and hand it to the Test button, and their headers
// carry their token (Gotify's X-Gotify-Key, ntfy's `Authorization: Bearer`), so one stray line break in a saved
// token wrote the whole token to `docker logs`, the in-app log, the support bundle, and the 400 body of
// POST /api/<provider>/test. The logger's redaction could not catch it: it knows the `//user:pass@` and
// query-string shapes, not a bare token. So such a failure becomes this fixed sentence, which quotes nothing.
// Identified by elimination, not by matching the message: undici reports EVERY network failure as
// TypeError('fetch failed') (the reason is in `cause`), so any OTHER TypeError out of fetch() is it refusing to
// build the request. Fail-safe: a future message format we have never seen is still not quoted.
export const REQUEST_NOT_BUILT =
  'the request could not be built: a saved setting (server address, token or password) contains a character that cannot be sent; enter it again';

// A secret shorter than this is never cut out of free text, and it is also the length of the runs describeErrorReply
// looks for. Why (Opus review of PR #742, D2): replacing a 1-4 character secret shreds unrelated words AND hints at
// the secret (an ntfy password `ntfy` turned `https://ntfy.sh/docs` into `https://[redacted].sh/docs`). Eight is
// below every real token these providers generate (Gotify 15 or 27 characters, ntfy `tk_` + 29) and above any
// common English word fragment. A short secret is protected by the reply whitelist below instead, which is the
// layer that does not depend on recognising the secret at all.
export const MIN_SECRET_RUN = 8;

/**
 * `text` with every occurrence of each secret (MIN_SECRET_RUN characters or more) replaced by `[redacted]`. This is
 * the SECOND layer: what a server says is filtered by describeErrorReply first, so this only has to cover the
 * messages we build ourselves (an error's text) and the few reply fields that are kept.
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < MIN_SECRET_RUN) continue;
    // The secret as a server or proxy would WRITE IT BACK in a JSON or form-encoded echo: `"` and `\` become `\"`
    // and `\\` in JSON, a space or symbol becomes %XX (or + in a form). Found by the Codex review of PR #742. Not an
    // attempt to list every escaping there is (Go's JSON escapes, HTML entities, double encoding ... the Opus review
    // showed that cannot be won): describeErrorReply is what keeps an echo out, this catches the common spellings.
    const spellings = [s, JSON.stringify(s).slice(1, -1)];
    // encodeURIComponent THROWS (URIError) on a lone surrogate, and this runs inside the providers' catch blocks,
    // whose promise is "never throws" (Opus review of PR #742, D4). Nobody can percent-encode such a string, so it
    // cannot come back that way either: its two encoded spellings are simply skipped. (Not reachable through the
    // saved settings today, since SQLite stores a lone surrogate as U+FFFD, but this is a shared helper.)
    try {
      const enc = encodeURIComponent(s);
      spellings.push(enc, enc.replace(/%20/g, '+'));
    } catch { /* a lone surrogate: see above */ }
    // Longest first, so a shorter spelling cannot leave a fragment of a longer one behind.
    for (const v of [...new Set(spellings)].sort((a, b) => b.length - a.length)) {
      if (out.includes(v)) out = out.split(v).join('[redacted]');
    }
  }
  return out;
}

// ⚠️ A SERVER'S ERROR REPLY IS NEVER QUOTED RAW (Opus review of PR #742). The providers used to log and return the
// first 140-200 characters of whatever a failing server sent, with the token cut out by redactSecrets. That cannot
// be made safe: a server or proxy that echoes the request can write the credential back in any spelling (Go's JSON
// writes & < > as backslash-u escapes u0026 u003c u003e, HTML entities, double percent-encoding, PHP's \/,
// base64 without its `Basic ` prefix, or just the first half of it), and no list of spellings is complete. So the design is a
// WHITELIST, not a blacklist: only the reply's short, well-known message fields are kept, nothing else it said.
//   - The body must be a JSON object; anything else (HTML, text, an array) is reported as the status alone.
//   - Of it, only REPLY_FIELDS (strings or numbers), each cut to REPLY_FIELD_MAX characters. Gotify answers
//     {"error","errorCode","errorDescription"}, ntfy {"code","http","error","link"}: their words are kept.
//   - A kept field that shares any run of MIN_SECRET_RUN characters with a credential is withheld whole (a partial
//     echo is still an echo), and redactSecrets then runs over what is left, as the second layer.
//   - The status phrase is Node's standard one (http.STATUS_CODES), never the server's own reason phrase, which is
//     server-controlled text like the body.
export const REPLY_FIELDS = Object.freeze(['error', 'errorDescription', 'message', 'detail', 'title']);
export const REPLY_FIELD_MAX = 200;
const WITHHELD = '[withheld: it repeats part of a saved credential]';

function sharesRun(text, secrets) {
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < MIN_SECRET_RUN) continue;
    for (let i = 0; i + MIN_SECRET_RUN <= s.length; i++) {
      if (text.includes(s.slice(i, i + MIN_SECRET_RUN))) return true;
    }
  }
  return false;
}

/** `HTTP <status> <standard phrase>`, plus the whitelisted fields of a JSON object reply: see the warning above. */
export function describeErrorReply(status, text, secrets = [], fields = REPLY_FIELDS) {
  const head = `HTTP ${status}${STATUS_CODES[status] ? ` ${STATUS_CODES[status]}` : ''}`;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return head;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return head;
  const parts = [];
  for (const f of fields) {
    const v = Object.hasOwn(body, f) ? body[f] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) {
      parts.push(`${f}: ${v}`);
    } else if (typeof v === 'string' && v.trim()) {
      const kept = v.slice(0, REPLY_FIELD_MAX);
      parts.push(`${f}: ${sharesRun(kept, secrets) ? WITHHELD : redactSecrets(kept, secrets)}`);
    }
  }
  return parts.length ? `${head} — ${parts.join('; ')}` : head;
}

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
    // See REQUEST_NOT_BUILT above: this message may quote a header value or a URL, which carry credentials.
    if (e instanceof TypeError && e.message !== 'fetch failed') throw new Error(REQUEST_NOT_BUILT);
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
