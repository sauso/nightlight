// The app needs time to stop, and every way of creating the container must SAY so.
//
// Issue #279, found by soak-testing #256's fix against a real container. Shutdown now finishes an
// in-flight recording before exiting — but nothing told Docker that, and Docker Engine 29 documents no
// default stop timeout (the container config carries `StopTimeout=<nil>`, so the daemon picks). On the
// soak box a bare `docker stop` SIGKILLed at ~3969ms, while a clean stop with a recording in flight
// took ~4600ms. Same lost recording as #256, re-created by deployment configuration rather than code.
//
// So this file checks the OTHER half of the fix, the half that lives outside backend/src: that the
// grace is declared wherever a container is created, and that what is declared still covers what the
// app can actually take. `recordings-shutdown.test.js` owns the app-side bound; this owns the config.
//
// ⚠️ WHY IT SCANS RATHER THAN CHECKING A LIST I TYPED. A hand-written list of files cannot fail when
// someone adds a sixth deployment example next year — and an example that ships without the flag is
// exactly how a user ends up with the bug again. Compose services are discovered from the compose
// files, `docker run` examples are discovered from the markdown, and the required duration is derived
// from the source constants. The same reasoning as the PRAGMA-derived fixture in
// recordings-shutdown.test.js: derive the thing you are asserting over, never restate it.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

// The real exported value rather than one parsed back out of the source: if the budget changes, the
// requirement must change with it, and an import cannot drift from what shutdown() actually uses.
const { SHUTDOWN_BUDGET_MS } = await import('../src/lib/recordings.js');

after(() => cleanupTempDataDirs());

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

// ── What the deployment must allow for ────────────────────────────────────────────────────────────
//
// Derived, not typed. Every stage of shutdown() that can block is bounded by its own timer: the
// recording save by SHUTDOWN_BUDGET_MS, and each spawned-process stop by its module's own
// FORCE_KILL_TIMEOUT_MS (transcoder, motion detector, sound detector today).
//
// ⚠️ The sum is deliberately PESSIMISTIC — it assumes every stage runs in series. Today they do not
// (the recording wait overlaps the detector stops, giving a real bound of 9s — see
// recordings-shutdown.test.js), but encoding that overlap here would make this check quietly wrong the
// day someone reorders shutdown. An upper bound that survives reordering is the useful one, and there
// is no cost to it: a container exits as soon as it has finished, so a generous grace is never waited
// out. What matters is only that the DECLARED grace is never smaller than what the app may take.
const FORCE_KILL_MS = (() => {
  const libDir = path.join(REPO, 'backend/src/lib');
  const found = [];
  for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith('.js'))) {
    const m = /^const FORCE_KILL_TIMEOUT_MS = (\d+);/m.exec(
      fs.readFileSync(path.join(libDir, f), 'utf8').replace(/\r\n/g, '\n')
    );
    if (m) found.push({ file: f, ms: Number(m[1]) });
  }
  return found;
})();

const REQUIRED_MS = SHUTDOWN_BUDGET_MS + FORCE_KILL_MS.reduce((a, b) => a + b.ms, 0);
const REQUIRED_S = Math.ceil(REQUIRED_MS / 1000);

// ── Discovering what is declared ──────────────────────────────────────────────────────────────────

// Every file in the repo that could create a Nightlight container. Walked, not listed, so a new
// compose file or a new documented `docker run` is covered the day it lands.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage', 'data'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(path.relative(REPO, p).split(path.sep).join('/'));
  }
  return out;
}
const ALL_FILES = walk(REPO);

// A compose service block, keyed by name, so `image:` and `stop_grace_period:` can be read together.
// Deliberately a small hand parser rather than a YAML dependency: the backend suite has no dev deps
// beyond node:test, and the shapes here are two files we control.
function composeServices(text) {
  const out = [];
  let inServices = false;
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (!inServices) continue;
    // ⚠️ Blank lines and column-0 COMMENTS are not the end of the section. Treating them as one
    // truncated the service list silently: adversarial review of #279 added a second, undeclared
    // service after a `#` comment and the scan simply stopped before it, with the suite green and
    // `docker compose config` calling the file valid.
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break; // a genuine new top-level key ends the section
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (m) { cur = { name: m[1], body: [] }; out.push(cur); continue; }
    if (cur) cur.body.push(line);
  }
  return out.map((s) => ({ name: s.name, body: s.body.join('\n') }));
}

// Services running a Nightlight image, from every compose file in the repo.
// ⚠️ `compose.yaml` and `compose.yml` count too, and are in fact the Compose Specification's PREFERRED
// names — `docker compose` looks for them BEFORE `docker-compose.yml`. Matching only the legacy prefix
// let review of #279 drop a `compose.yaml` with an undeclared Nightlight service into the repo root
// with the suite still green: the file Docker would have picked first was the one not checked.
const COMPOSE_FILE = /(^|\/)(docker-compose|compose)[^/]*\.ya?ml$/;
const NIGHTLIGHT_SERVICES = ALL_FILES
  .filter((f) => COMPOSE_FILE.test(f))
  .flatMap((f) =>
    composeServices(read(f))
      .filter((s) => /^\s*image:.*nightlight/m.test(s.body))
      .map((s) => ({ file: f, ...s }))
  );

// Documented `docker run` invocations from every markdown file in the repo. Backslash continuations
// are folded so a multi-line example is one logical command; prose that merely mentions `docker run`
// is excluded because the command must START the line.
//
// ⚠️ `[ \t]*` BEFORE the newline is load-bearing, and its absence was a real hole. With a plain
// `\\\n`, adding ONE TRAILING SPACE after the backslash in the README's quick-start command stopped
// the fold, so the command's first line no longer reached its own image name and the whole example
// dropped out of the scan — while the count guard still passed on the remaining examples. Review of
// #279 removed `--stop-timeout` from that same command and the suite stayed green. A trailing space
// after a `\` is invisible in a diff and breaks the command for anyone who copies it, too.
function dockerRunLines(text) {
  return text
    .replace(/\\[ \t]*\n\s*/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('docker run'));
}

const MARKDOWN = ALL_FILES.filter((f) => f.endsWith('.md'));
const DOCKER_RUN_EXAMPLES = MARKDOWN.flatMap((f) =>
  dockerRunLines(read(f))
    .filter((cmd) => /nightlight/.test(cmd))
    .map((cmd) => ({ file: f, cmd }))
);

// ★ FOLDING IS LOSSLESS — asserted from the RAW text, so a parser that quietly drops a command cannot
// pass. Counts every line that STARTS a `docker run`, before any folding or filtering, and requires
// the folded parse to produce exactly as many. This is deliberately independent of whether a command
// mentions Nightlight: it tests the parser, not the subject.
const DOCKER_RUN_RAW_STARTS = MARKDOWN.map((f) => ({
  file: f,
  raw: read(f).split('\n').filter((l) => l.trim().startsWith('docker run')).length,
  parsed: dockerRunLines(read(f)).length,
})).filter((x) => x.raw > 0 || x.parsed > 0);

const parseSeconds = (v) => (/^(\d+)m$/.test(v) ? Number(RegExp.$1) * 60 : Number(String(v).replace(/s$/, '')));

describe('the shutdown grace this deployment needs', () => {
  test('is derived from the source, and the derivation actually found the constants', () => {
    // ★ ANTI-VACUOUS GUARD. If the FORCE_KILL_TIMEOUT_MS scan silently matched nothing — a renamed
    // constant, a changed declaration style — REQUIRED_MS would collapse to the budget alone and every
    // assertion below would pass for the wrong reason. That is the failure mode this repo keeps
    // finding in its own tests, so it is asserted rather than assumed.
    assert.ok(SHUTDOWN_BUDGET_MS > 0, 'the recording shutdown budget was not read from recordings.js');
    assert.ok(
      FORCE_KILL_MS.length >= 3,
      `only found FORCE_KILL_TIMEOUT_MS in ${FORCE_KILL_MS.length} module(s) ` +
        `(${FORCE_KILL_MS.map((f) => f.file).join(', ') || 'none'}) — the scan has stopped matching, ` +
        'so the required grace is being under-computed'
    );
    // The three process-owning modules shutdown() waits on. Named, because a module dropping out of
    // the scan is the same silent under-count as the constant being renamed.
    for (const f of ['transcoder.js', 'motionDetector.js', 'soundDetector.js']) {
      assert.ok(FORCE_KILL_MS.some((x) => x.file === f), `${f} no longer contributes to the bound`);
    }
  });

  test('every compose service running a Nightlight image declares stop_grace_period', () => {
    // Discovered, so e2e's stack and any future compose file are covered without being listed here.
    assert.ok(
      NIGHTLIGHT_SERVICES.length >= 2,
      `the compose scan found only ${NIGHTLIGHT_SERVICES.length}: ` +
        `[${NIGHTLIGHT_SERVICES.map((s) => `${s.file}#${s.name}`).join(', ')}] — it has stopped working`
    );
    assert.ok(
      NIGHTLIGHT_SERVICES.some((s) => s.file === 'docker-compose.yml'),
      'the production compose file was not scanned'
    );

    for (const svc of NIGHTLIGHT_SERVICES) {
      const m = /^\s*stop_grace_period:\s*(\S+)\s*$/m.exec(svc.body);
      assert.ok(m, `${svc.file}: service '${svc.name}' runs Nightlight but declares no stop_grace_period`);
      assert.ok(
        parseSeconds(m[1]) >= REQUIRED_S,
        `${svc.file}: '${svc.name}' allows ${m[1]}, but shutdown can take up to ${REQUIRED_S}s`
      );
    }
  });

  test('every documented `docker run` passes --stop-timeout', () => {
    // A `docker run` with no --stop-timeout leaves StopTimeout unset on the container, which is the
    // exact state measured SIGKILLing at ~4s. Every copyable example must therefore carry it —
    // including the build-from-source one, which creates just as real a container.
    assert.ok(
      DOCKER_RUN_EXAMPLES.length >= 3,
      `the markdown scan found only ${DOCKER_RUN_EXAMPLES.length}: ` +
        `[${DOCKER_RUN_EXAMPLES.map((e) => e.file).join(', ')}] — it has stopped working`
    );
    // Nothing was lost on the way in. See DOCKER_RUN_RAW_STARTS: one trailing space used to be enough
    // to drop a whole command from the scan, and a count-based guard with slack never noticed.
    for (const f of DOCKER_RUN_RAW_STARTS) {
      assert.equal(
        f.parsed,
        f.raw,
        `${f.file}: ${f.raw} \`docker run\` command(s) in the file but ${f.parsed} parsed — a line ` +
          'continuation is not being folded (a trailing space after a `\\` does exactly this), so a ' +
          'documented command is escaping this check entirely'
      );
    }
    assert.ok(
      DOCKER_RUN_EXAMPLES.some((e) => e.file === 'README.md'),
      'the README quick-start example was not scanned'
    );

    for (const ex of DOCKER_RUN_EXAMPLES) {
      const m = /--stop-timeout[ =](\d+)/.exec(ex.cmd);
      assert.ok(m, `${ex.file}: a documented \`docker run\` omits --stop-timeout:\n    ${ex.cmd}`);
      assert.ok(
        Number(m[1]) >= REQUIRED_S,
        `${ex.file}: --stop-timeout ${m[1]} is below the ${REQUIRED_S}s shutdown can take`
      );
    }
  });

  test('the Unraid template declares it too — Unraid never sees the compose file', () => {
    // Unraid builds the container from this template's ExtraParams, so it is the only place the flag
    // can come from there. (An existing install keeps its saved template until edited by hand — that
    // upgrade note is in the README, not enforceable from here.)
    const m = /<ExtraParams>([^<]*)<\/ExtraParams>/.exec(read('unraid-template.xml'));
    assert.ok(m, 'unraid-template.xml has no ExtraParams element');
    const t = /--stop-timeout[ =](\d+)/.exec(m[1]);
    assert.ok(t, `unraid-template.xml ExtraParams omits --stop-timeout: "${m[1].trim()}"`);
    assert.ok(Number(t[1]) >= REQUIRED_S, `the template allows ${t[1]}s, below the required ${REQUIRED_S}s`);
  });

  test('all of them declare the SAME value, so one place cannot drift', () => {
    // Not pedantry: these are eight copies of one decision across six files, and a reader who finds
    // two different numbers has no way to tell which is current. Raising the requirement must move
    // all of them.
    const declared = new Set([
      ...NIGHTLIGHT_SERVICES.map((s) => parseSeconds(/stop_grace_period:\s*(\S+)/.exec(s.body)[1])),
      ...DOCKER_RUN_EXAMPLES.map((e) => Number(/--stop-timeout[ =](\d+)/.exec(e.cmd)[1])),
      Number(/--stop-timeout[ =](\d+)/.exec(/<ExtraParams>([^<]*)<\/ExtraParams>/.exec(read('unraid-template.xml'))[1])[1]),
    ]);
    assert.equal(declared.size, 1, `the declared grace differs between files: ${[...declared].sort().join('s, ')}s`);
  });

  test('the README mentions the flag in PROSE, not only inside a copyable command', () => {
    // The definition of done: if a person can see it, it is documented. A bare flag in a copyable
    // command with no explanation is how the --log-opt flags ended up needing a retrofitted section.
    //
    // Fenced code blocks are stripped first, so the quick-start command cannot satisfy this on its
    // own — the flag has to be discussed somewhere a reader would find it.
    //
    // ⚠️ WHAT THIS DOES NOT CHECK, said plainly: whether the prose is CORRECT, or still true. A first
    // version of this case asserted that the word "recording" appeared within 400 characters of the
    // flag, and a mutant that replaced the entire explanatory sentence with "does something
    // unrelated" SURVIVED it — the nearby word was still there. No assertion over free text
    // distinguishes a good explanation from a bad one; this one only proves an explanation exists.
    // ⚠️ AND BOTH CHECKS ARE SECTION-SCOPED, because unscoped ones do not discriminate. The first
    // version searched the whole 570-line README for "Extra Parameters" — a mutant deleting the entire
    // Unraid upgrade note SURVIVED, because that phrase also appears in the Logs section and in the
    // quick-start paragraph. A reader meets documentation where they are standing, so the assertion
    // has to look where they are standing too.
    const readme = read('README.md');
    const section = (heading) => {
      const m = new RegExp(`## ${heading}\\n([\\s\\S]*?)\\n## `).exec(readme);
      assert.ok(m, `the README no longer has a "${heading}" section to check`);
      return m[1].replace(/```[\s\S]*?```/g, ''); // fenced commands stripped: a flag in the command
    };                                             // it is explaining cannot explain itself

    assert.match(
      section('Quick start'),
      /--stop-timeout/,
      'Quick start shows --stop-timeout in the command but never explains it'
    );
    // Existing installs do NOT pick this up automatically — Unraid rebuilds from its own saved
    // template, so a container created before this template change keeps the old ExtraParams until
    // someone edits it by hand. That upgrade note is part of the fix, not a nicety.
    assert.match(
      section('Running on Unraid'),
      /--stop-timeout/,
      'the Unraid section no longer tells existing installs to add the flag themselves'
    );
  });
});
