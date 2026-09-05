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
