// Turns Playwright's JSON report into a Markdown summary for the GitHub Actions run page.
// Usage: node summarize.mjs [results.json]  (prints Markdown to stdout)
// The workflow appends the output to $GITHUB_STEP_SUMMARY.
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'results.json';

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  // Phase 1 may have failed before Playwright ran, so there's no report — say so plainly.
  console.log('## End-to-end tests\n\n_No Playwright results were produced (the UI suite did not run)._');
  process.exit(0);
}

// Flatten the suite tree (files → describe blocks → specs) into one row per test spec.
const rows = [];
function walk(suite, prefix) {
  const here = [prefix, suite.title].filter(Boolean).join(' › ');
  for (const spec of suite.specs || []) {
    let duration = 0;
    for (const t of spec.tests || []) for (const r of t.results || []) duration += r.duration || 0;
    rows.push({ title: [here, spec.title].filter(Boolean).join(' › '), ok: spec.ok, duration });
  }
  for (const child of suite.suites || []) walk(child, here);
}
for (const s of data.suites || []) walk(s, '');

const passed = rows.filter((r) => r.ok).length;
const failed = rows.length - passed;
const total = (data.stats?.duration ?? rows.reduce((a, r) => a + r.duration, 0)) / 1000;

let out = '## End-to-end tests\n\n';
out += failed === 0 ? '✅ ' : '❌ ';
out += `**${passed} passed**, **${failed} failed** — ${total.toFixed(1)}s\n\n`;
out += '| | Test | Time |\n|:--:|:--|--:|\n';
for (const r of rows) {
  out += `| ${r.ok ? '✅' : '❌'} | ${r.title.replace(/\|/g, '\\|')} | ${(r.duration / 1000).toFixed(1)}s |\n`;
}
out += '\n_Full report (with traces/screenshots on failure) is the `playwright-report` artifact._';

console.log(out);
