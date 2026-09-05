// Walking the backend source for guards that must FAIL CLOSED.
//
// Two suites need this and they need it to behave identically: `notify-timeouts.test.js` proves no
// unbounded `fetch` exists, and `suite-exits-cleanly.test.js` proves no periodic job lacks a stop.
// Both guard a property whose violation is silent, and both are only worth anything if they see EVERY
// file — a hard-coded list of filenames fails OPEN, which is the one shape a regression guard must
// never have (that mistake let a `discord.js` with an unbounded fetch through in #262).
//
// ⚠️ Shared rather than copied deliberately. #287's review found a tested helper sitting dead beside
// an untested inline copy of the same logic in a workflow; two implementations of a security-shaped
// check drift, and the one that drifts is the one nobody is running.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..', '..', 'src');

/** Every .js under backend/src, as { rel, src }. `rel` is relative to src/, forward-slashed. */
export function walkSources(root = SRC_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) {
        out.push({ rel: path.relative(root, full).split(path.sep).join('/'), src: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Remove comments and string literals before matching.
 *
 * ⚠️ A TEXT SCAN IS FOOLED IN BOTH DIRECTIONS, and both directions have actually happened here. A real
 * unbounded call hid from a scan because the scan only looked at some files; separately, the literal
 * `"await fetch("` sitting inside an explanatory COMMENT made a scan fail on correct code. Anything
 * matching against source has to strip both first.
 *
 * ⚠️ Block comments are stripped with a non-greedy match, which is not a parser: it cannot tell a
 * `/*` inside a string from a real comment. Strings are therefore blanked in the same pass, and the
 * order matters — an earlier attempt at this in a different file deleted 4kB of a source file because
 * a block-comment regex matched inside a string literal.
 */
export function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// ---------------------------------------------------------------------------------------------
// Finding repeating timers, and the exports that start and stop them. Issue #286.
//
// ⚠️ THE FIRST VERSION OF THIS GUARD LEAKED LIKE A SIEVE, and I only found out by attacking it: of
// eight ways to write an unstoppable repeating timer, SIX walked straight past it. It matched exactly
// `export function startX` and the literal `setInterval(`, so every one of these was invisible:
//
//     export const startX = () => { t = setInterval(...) }      arrow-function export
//     function foo(){...}; export { foo as startX }             renamed export
//     const si = setInterval; si(...)                           aliased, the same indirection that
//                                                               beat the unbounded-fetch scan in #262
//     const t = setInterval(...)                                module-level, no start function
//     function tick(){ setTimeout(tick, n) }                    self-rescheduling — a repeating timer
//                                                               with no setInterval anywhere
//     class Z { startX(){ setInterval(...) } }                  class method
//
// A guard that only catches the shape its author happened to write is not a guard; it is a comment.
//
// ⚠️ AND IT IS STILL REGEX, NOT AN AST. It cannot see every indirection and does not pretend to —
// what it does is catch the shapes people actually write, and fail CLOSED on the module level so a
// timer with no start function at all is still flagged. If this ever needs to be airtight it needs a
// real parser; that limit is stated here rather than left for someone to discover.

/**
 * Comments removed, STRING LITERALS KEPT.
 *
 * ⚠️ THE FULL STRIPPER CREATES A FALSE NEGATIVE HERE, which adversarial review of #286 demonstrated
 * with a real hang: `globalThis['setInterval'](fn, ms)` becomes `globalThis['']` once strings are
 * blanked, so the timer is invisible to any scan that runs afterwards. Strings must stay visible when
 * looking for a timer, and must be blanked when looking for exports — they are different questions.
 */
export function stripCommentsOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*/g, '$1');
}

/**
 * Ways a module can create a repeating timer. Returns the reasons found, or [].
 *
 * ⚠️ PASS SOURCE WITH COMMENTS REMOVED BUT STRINGS INTACT (`stripCommentsOnly`). Comments are stripped
 * so a module merely *discussing* setInterval is not swept in; strings are kept so computed access
 * cannot hide the identifier.
 */
export function periodicEvidence(code) {
  const reasons = [];
  // The IDENTIFIER, not `setInterval(` — catches `const si = setInterval`, `globalThis.setInterval`,
  // `globalThis['setInterval']`, and destructuring, as well as a direct call.
  if (/\bsetInterval\b/.test(code)) reasons.push('setInterval');
  return reasons;
}

// ⚠️ KNOWN LIMIT, STATED RATHER THAN HIDDEN: a self-rescheduling `setTimeout` —
// `function tick(){ setTimeout(tick, n) }` — is a repeating timer this does NOT detect.
//
// It was detected, briefly, by looking for `setTimeout(fn, …)` where `fn` is declared in the same
// file. That heuristic false-positived on the FIRST real file it met: `lib/onvif.js` does
// `setTimeout(done, REQUEST_TIMEOUT_MS)` to guard against a hung callback, which is a ONE-SHOT with a
// named callback, not a reschedule. Telling those apart needs to know whether the call sits inside
// the body of the function it names, which is a parser's job, not a regex's.
//
// Removed deliberately rather than left noisy: this repo's own rule is that a check which cries wolf
// gets clicked past, and a guard people learn to ignore is worse than no guard. If this gap ever
// matters, it needs an AST — say so, don't approximate it.

/** Every exported name, across the export forms this codebase actually uses. */
export function exportedNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export { a, b as c } — take the EXPORTED name (after `as` when present).
  for (const block of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] ?? as[0]).trim());
    }
  }
  return names;
}

/** Method names declared inside a class body — `startX(){}` is a start too. */
export function classMethodNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) names.add(m[1]);
  return names;
}

/** Roughly, does the module unref every interval it creates? */
export function unrefsEverything(code) {
  const intervals = (code.match(/\bsetInterval\s*\(/g) || []).length;
  const unrefs = (code.match(/\.unref\s*\?*\.?\s*\(/g) || []).length;
  return intervals > 0 && unrefs >= intervals;
}

/**
 * The whole rule, as a pure function so it can be tested against synthetic sources rather than only
 * against whatever happens to be in src/ today.
 *
 * ⚠️ IT IS A PURE FUNCTION FOR A REASON. The first version of this guard was inline in the test and
 * could only ever be exercised by the real tree — so the only way to find out which leak shapes it
 * missed was to plant files in `src/` by hand, which is what I did, and six of eight walked past it.
 * Now those shapes are fixtures in the suite instead of something someone remembers to re-check.
 *
 * @returns {string[]} human-readable offences, empty when the module is fine
 */
export function unstoppableTimerOffences(rel, rawSrc) {
  // ⚠️ TWO DIFFERENT VIEWS OF THE SAME FILE, and using one for both was a demonstrated bypass.
  // Timer detection needs strings INTACT (`globalThis['setInterval']` is a string); export detection
  // needs them blanked, or a name mentioned inside a string reads as an export.
  const forTimers = stripCommentsOnly(rawSrc);
  const code = stripCommentsAndStrings(rawSrc);

  const evidence = periodicEvidence(forTimers);
  if (!evidence.length) return [];

  const exported = exportedNames(code);
  const methods = classMethodNames(code);
  const starts = [...exported, ...methods].filter((n) => /^start[A-Z]/.test(n) || n === 'start');
  const offences = [];

  // RULE A — pairing. Every startX, however it is exported, needs a teardown.
  //
  // ⚠️ `close` counts as well as `stop`. twoWayAudio's talk session tears down in `close()`, which
  // really does clearInterval its keepalive — insisting on the word "stop" would flag correct code,
  // and a guard that flags correct code is one people learn to ignore.
  //
  // ⚠️ Note this applies EVEN WHEN THE TIMER IS UNREF'D. That is deliberate, and it is the rule that
  // caught clipStorage: an unref'd timer cannot cause the #278 hang, but shutdown should still be able
  // to stop a job explicitly rather than relying on process.exit to take it down. One rule with no
  // exceptions is easier to keep than one with a carve-out to remember.
  for (const startName of starts) {
    const base = startName.replace(/^start/, '');
    const teardowns = [`stop${base}`, `close${base}`, 'stop', 'close'];
    if (!teardowns.some((n) => exported.has(n) || methods.has(n))) {
      offences.push(`${rel}: ${startName}() has no stop${base}() or close${base}()`);
    }
  }

  // RULE B — module level, and this is the half that fails CLOSED. A repeating timer with NO start
  // function at all still keeps the process alive, and rule A cannot see it because there is nothing
  // named startX to pair with.
  //
  // ⚠️ NO unref() EXEMPTION HERE ANY MORE. It used to allow a module through if it appeared to unref
  // everything, judged by counting `.unref(` against `setInterval(` — and adversarial review defeated
  // that with a real hang: a module-level interval that is never unref'd, sitting beside two decoy
  // `.unref?.()` calls on unrelated objects, satisfies the count. A counting heuristic cannot tell
  // WHICH object was unref'd, so it is gone. A module-level timer now simply needs a teardown, which
  // no module in this codebase relies on being excused from.
  if (!starts.length && ![...exported].some((n) => /^(stop|close)/.test(n))) {
    offences.push(`${rel}: creates a repeating timer (${evidence.join(', ')}) with no stop or close export`);
  }
  return offences;
}
