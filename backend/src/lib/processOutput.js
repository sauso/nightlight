import { StringDecoder } from 'node:string_decoder';

// Child-process `data` events are arbitrary byte chunks, not lines. Splitting each chunk separately
// can publish `rtsp://user:sec` and `ret@host` as two apparently harmless fragments, defeating any
// URL redactor at the logger. This small accumulator makes a complete line the unit passed onward.
//
// A malformed process can emit an indefinitely long line. Once a line crosses the cap, discard it
// through its newline rather than forwarding a credential-bearing prefix or growing memory forever.
// Exported so a test can assert the cap is actually enforced by VALUE, not just infer it from final
// output shape — a buggy cap can still produce the right final lines (the `discarding` flag alone
// suppresses the eventual oversized content once a newline arrives) while still growing `pending`
// unboundedly in between, which only a direct size check catches. See pendingLength() below.
export const MAX_LINE_CHARS = 64 * 1024;
const OMITTED_LINE = '[output line omitted: exceeded 64 KiB]';

// A `//user:pass` shape that never reached its closing '@' before the stream ended (the process died
// mid-write, or simply never emits a trailing newline) — redactCredentials can only redact a COMPLETE
// `//user:pass@` occurrence, so an incomplete one at genuine end-of-stream would otherwise be echoed
// raw by the final emit() below. Reduce rather than echo, matching urlCredentials.js's own "input that
// cannot be shown to be safe is reduced rather than echoed" policy. Found by adversarial review.
const INCOMPLETE_URL_AUTHORITY = /\/\/[^/\s:@]*:[^/\s@]*$/;

export function createLineBuffer(onLine) {
  if (typeof onLine !== 'function') throw new TypeError('onLine must be a function');

  const decoder = new StringDecoder('utf8');
  let pending = '';
  let discarding = false;
  let ended = false;

  const emit = (line) => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > 0) onLine(line);
  };

  const consume = (text, final = false) => {
    pending += text;
    let newlineAt;
    while ((newlineAt = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newlineAt);
      pending = pending.slice(newlineAt + 1);
      if (discarding || line.length > MAX_LINE_CHARS) {
        onLine(OMITTED_LINE);
        discarding = false;
      } else {
        emit(line);
      }
    }

    // ⚠️ No `!discarding &&` guard here — found by adversarial review. Once discarding starts, later
    // chunks keep hitting `pending += text` above before this check runs; without re-clearing on
    // EVERY call (not just the transition into discarding), `pending` grows unboundedly for as long
    // as the process keeps emitting a line with no newline — defeating the whole point of the cap.
    if (pending.length > MAX_LINE_CHARS) {
      pending = '';
      discarding = true;
    }

    if (final) {
      if (discarding) onLine(OMITTED_LINE);
      // Found by adversarial review: a genuinely truncated final line (no trailing newline) that
      // ends mid-credential must not be echoed raw — see INCOMPLETE_URL_AUTHORITY above.
      else emit(pending.replace(INCOMPLETE_URL_AUTHORITY, '//[truncated]'));
      pending = '';
      discarding = false;
    }
  };

  return {
    write(chunk) {
      if (ended) return;
      if (typeof chunk === 'string') consume(chunk);
      else consume(decoder.write(chunk));
    },
    end() {
      if (ended) return;
      ended = true;
      consume(decoder.end(), true);
    },
    // Test-only accessor (see MAX_LINE_CHARS's comment) — no real caller needs this.
    pendingLength: () => pending.length,
  };
}

// `ChildProcess` emits `exit` when the OS process ends, which can happen BEFORE stdout/stderr finish
// draining. Flushing there can publish half of a credential-bearing URL and let the second half arrive
// afterward. A readable stream's `end` is the real line-buffer boundary; the process `close` event is
// a fallback that is documented to run only after all stdio streams have closed.
export function forwardProcessLines(proc, stream, onLine) {
  const lines = createLineBuffer(onLine);
  stream.on('data', (chunk) => lines.write(chunk));
  stream.once('end', () => lines.end());
  proc.once('close', () => lines.end());
  return lines;
}
