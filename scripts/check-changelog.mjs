#!/usr/bin/env node
// Structural check for CHANGELOG.md.
//
// Why this exists: [Unreleased] accumulated TWO `### Added` blocks and TWO `### Changed` blocks over
// PRs #179-#186. Nothing was lost, but the section stopped being readable as "what's on dev", and the
// duplicates are invisible in a PR diff — each one looks like a correct single addition in isolation.
// A reviewer only sees it by reading the whole rendered section, which nobody does on every PR.
//
// So this is a check, not a convention: it runs in CI on every push and PR, and as a gate in the
// release flow. Same reasoning as the backend's core-logic coverage gate — a rule that lives only in
// a checklist is a rule that gets skipped on the busy day.
//
// It checks STRUCTURE only. It has no opinion about wording, and it never rewrites the file.
//
//   node scripts/check-changelog.mjs [path-to-changelog]
//
// Exit 0 = clean. Exit 1 = problems, listed on stderr.

import { readFileSync } from 'node:fs';

// Keep a Changelog's six types, in the order it specifies.
const ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

const file = process.argv[2] ?? 'CHANGELOG.md';
const lines = readFileSync(file, 'utf8').split(/\r?\n/);

const problems = [];
const fail = (line, msg) => problems.push(`${file}:${line}: ${msg}`);

// --- split into version sections ---------------------------------------------------------------
// A section runs from its `## [x]` heading to the line before the next one.
const sections = [];
lines.forEach((text, i) => {
  const m = /^## \[([^\]]+)\]/.exec(text);
  if (m) sections.push({ name: m[1], start: i, headingLine: i + 1 });
});
sections.forEach((s, i) => {
  s.end = i + 1 < sections.length ? sections[i + 1].start : lines.length;
});

if (sections.length === 0) fail(1, 'no version sections found — expected at least "## [Unreleased]"');
if (sections[0] && sections[0].name !== 'Unreleased') {
  fail(sections[0].headingLine, `the first section must be "## [Unreleased]", found "${sections[0].name}"`);
}

// --- check each section's type headings ---------------------------------------------------------
for (const section of sections) {
  const seen = new Map(); // type -> first line it appeared on
  const sequence = [];

  for (let i = section.start + 1; i < section.end; i++) {
    const m = /^### (.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const type = m[1];
    const at = i + 1;

    if (!ORDER.includes(type)) {
      fail(at, `[${section.name}] "### ${type}" is not a Keep a Changelog type (${ORDER.join(', ')})`);
      continue;
    }

    // The whole point of this script.
    if (seen.has(type)) {
      fail(
        at,
        `[${section.name}] duplicate "### ${type}" (already at line ${seen.get(type)}) — ` +
          'merge the entries under the first one'
      );
    } else {
      seen.set(type, at);
      sequence.push({ type, at });
    }

    // A heading with no entries under it reads as an empty promise in the rendered changelog.
    let hasEntry = false;
    for (let j = i + 1; j < section.end; j++) {
      if (/^#{2,3} /.test(lines[j])) break;
      if (lines[j].trim() !== '') { hasEntry = true; break; }
    }
    if (!hasEntry) fail(at, `[${section.name}] "### ${type}" has no entries under it`);
  }

  // Order is a readability rule, not a correctness one, but it costs nothing to keep.
  for (let i = 1; i < sequence.length; i++) {
    const prev = sequence[i - 1];
    const cur = sequence[i];
    if (ORDER.indexOf(cur.type) < ORDER.indexOf(prev.type)) {
      fail(
        cur.at,
        `[${section.name}] "### ${cur.type}" should come before "### ${prev.type}" ` +
          `(Keep a Changelog order: ${ORDER.join(' > ')})`
      );
    }
  }
}

// --- released sections need a date ---------------------------------------------------------------
for (const section of sections) {
  if (section.name === 'Unreleased') continue;
  if (!/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\s*$/.test(lines[section.start])) {
    fail(section.headingLine, `[${section.name}] released sections need "## [x.y.z] - YYYY-MM-DD"`);
  }
}

// --- a version must not be released twice --------------------------------------------------------
// The release flow edits this file by hand; #147 already dropped a version header once.
const versions = new Map();
for (const section of sections) {
  if (versions.has(section.name)) {
    fail(section.headingLine, `duplicate section "## [${section.name}]" (already at line ${versions.get(section.name)})`);
  } else {
    versions.set(section.name, section.headingLine);
  }
}

if (problems.length) {
  console.error(`CHANGELOG structure check FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nKeep a Changelog: one heading per type per version, in the order');
  console.error(`  ${ORDER.join(' > ')}`);
  process.exit(1);
}

console.log(`CHANGELOG structure OK — ${sections.length} section(s), no duplicate or misordered headings.`);
