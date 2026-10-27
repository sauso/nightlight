// Remove every "/" at the END of a string, without a regular expression.
//
// WHY NOT A REGULAR EXPRESSION (a slash, one or more times, then the end-of-string anchor, passed to replace()), WHICH
// THIS REPLACES (CodeQL js/polynomial-redos, alerts #12 and #13). The pattern is deliberately not written out here:
// strip-trailing-slashes.test.js scans every source file for it. It is quadratic on a string with many slashes that is
// NOT followed only by slashes (the engine tries every start position and fails at the end anchor each time). Measured 2026-10-27 on Node 24: 20,000 slashes then one other character took 0.24 s,
// 50,000 took 1.5 s and 100,000 took 6.0 s, all on the single thread that serves every request, camera watchdog and
// push. The input is an admin-entered server address (ntfy, Gotify) and the body limit is 100 kB, so an admin (or a
// stolen admin session) could freeze the server for several seconds per request. This loop takes 0.06 ms for the same
// 100,000 characters. The result is identical to the regular expression for every input.
export function stripTrailingSlashes(value) {
  const s = String(value ?? '');
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--; // 47 is "/"
  return end === s.length ? s : s.slice(0, end);
}
