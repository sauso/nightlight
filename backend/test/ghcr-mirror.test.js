// scripts/ghcr-mirror.sh copies a published image from Docker Hub to the ghcr.io mirror by digest. The subject is
// the script itself, run by a real POSIX shell (dash, as /bin/sh is on the Ubuntu runners; Git for Windows ships
// one too) against a FAKE `docker` on PATH that records every call and keeps two "registries" as files: the mirror
// (ghcr.io references) and the source (Docker Hub references). The fake answers in the shape the real CLI uses,
// checked against buildx 0.37 (Docker 29.8): `imagetools inspect --format '{{json .Manifest.Digest}}'` prints the
// digest in double quotes with no newline, and a missing tag fails with "ERROR: <reference>: not found" (a Docker
// Hub reference printed with docker.io/ in front). The real CLI was also run against a throwaway local registry
// when this was written (a copied index kept its digest and its attestation manifests); CI has no registry, so
// that is not repeated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = process.env.GHCR_MIRROR_SCRIPT || path.join(repo, 'scripts', 'ghcr-mirror.sh');

// The MSYS tools take forward slashes reliably; Windows paths with backslashes are converted only in some places.
const shPath = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
const gitUsrBin = 'C:\\Program Files\\Git\\usr\\bin';
const shell = process.platform !== 'win32' ? 'sh'
  : fs.existsSync(path.join(gitUsrBin, 'dash.exe')) ? path.join(gitUsrBin, 'dash.exe')
    : fs.existsSync('C:\\Program Files\\Git\\bin\\sh.exe') ? 'C:\\Program Files\\Git\\bin\\sh.exe' : 'sh';
const shellProbe = spawnSync(shell, ['-c', 'exit 0'], { encoding: 'utf8' });
const skipShell = shellProbe.error?.code === 'ENOENT' || shellProbe.error?.code === 'EPERM'
  ? `no POSIX shell: ${shellProbe.error.message}` : false;

const SRC = 'sauso/nightlight';
const DST = 'ghcr.io/sauso/nightlight';
const DIGEST = `sha256:${'d1'.repeat(32)}`; // the image this run published
const OLD = `sha256:${'0e'.repeat(32)}`; // what a tag pointed at before
const OTHER = `sha256:${'99'.repeat(32)}`; // what a misbehaving registry stores instead
const FORMAT = '{{json .Manifest.Digest}}';
const inspect = (ref) => ['buildx', 'imagetools', 'inspect', ref, '--format', FORMAT];
const create = (dst, src) => ['buildx', 'imagetools', 'create', '-t', dst, src];

// A stand-in for `docker buildx imagetools`. It refuses any call shape the script is not meant to make (exit 9x),
// so a change to how the script calls docker shows up here instead of on a release day. A ghcr.io reference reads
// and writes FAKE_REG (the mirror); any other reference reads FAKE_SRC (Docker Hub).
//   FAKE_INSPECT_FAIL_AT  " 1 3 ": those inspect calls (1-based, both registries) fail like an unreadable registry
//   FAKE_MISSING_MSG      what a missing MIRROR tag prints instead of the real CLI's "ERROR: <ref>: not found"
//   FAKE_CREATE_FAILS     non-empty: every copy fails
//   FAKE_LANDS_AS         a digest: a copy stores that instead of the one asked for (the read-back must catch it)
const FAKE_DOCKER = `#!/bin/sh
{ printf 'CALL'; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> "$FAKE_LOG"
if [ "$#" -lt 3 ] || [ "$1" != buildx ] || [ "$2" != imagetools ]; then echo "fake docker: unexpected call" >&2; exit 90; fi
case $3 in
  inspect)
    if [ "$#" -ne 6 ] || [ "$5" != --format ] || [ "$6" != '${FORMAT}' ]; then echo "fake docker: unexpected inspect arguments" >&2; exit 91; fi
    n=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$FAKE_COUNT"
    case " \${FAKE_INSPECT_FAIL_AT:-} " in *" $n "*) echo "ERROR: failed to authorize: 403 Forbidden" >&2; exit 1 ;; esac
    case $4 in ghcr.io/*) reg=$FAKE_REG ;; *) reg=$FAKE_SRC ;; esac
    if [ -f "$reg/\${4##*:}" ]; then printf '"%s"' "$(cat "$reg/\${4##*:}")"; exit 0; fi
    case $4 in
      ghcr.io/*) if [ -n "\${FAKE_MISSING_MSG:-}" ]; then printf '%s\\n' "$FAKE_MISSING_MSG" >&2; else echo "ERROR: $4: not found" >&2; fi ;;
      *) echo "ERROR: docker.io/$4: not found" >&2 ;;
    esac
    exit 1 ;;
  create)
    if [ "$#" -ne 6 ] || [ "$4" != -t ]; then echo "fake docker: unexpected create arguments" >&2; exit 92; fi
    if [ -n "\${FAKE_CREATE_FAILS:-}" ]; then echo "ERROR: failed to push: 502 Bad Gateway" >&2; exit 1; fi
    printf '%s' "\${FAKE_LANDS_AS:-\${6##*@}}" > "$FAKE_REG/\${5##*:}"
    exit 0 ;;
esac
echo "fake docker: unexpected imagetools command" >&2
exit 93
`;

// The fake's folder goes FIRST and nothing is removed, as publish-gate.test.js does with its fake gh: the fake
// shadows any real docker, and the tests that expect calls prove it is the one answering. (Filtering out every
// folder that holds a docker removed /bin on Ubuntu, where /bin is /usr/bin, and with it `sh`: CI went red.)
// dash on Windows is not started through Git's wrapper, so its tools (cat, mktemp, rm) need Git's usr\bin.
function searchPath(bin) {
  const entries = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const extra = process.platform === 'win32' && fs.existsSync(gitUsrBin) ? [gitUsrBin] : [];
  return [bin, ...extra, ...entries].join(path.delimiter);
}

// Inputs the script must ignore. A decoy in any of them that reaches docker's argv fails the hostile-fixture test.
const SCRUBBED = ['SRC_REPO', 'DST_REPO', 'DIGEST', 'TAGS', 'FORCE', 'GITHUB_STEP_SUMMARY', 'GITHUB_REPOSITORY'];

// registry: the mirror's tags before the run; source: Docker Hub's tags (read only by --resolve).
function run(t, { env = {}, registry = {}, source = {}, args = [], plant = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-mirror-'));
  try {
    const bin = path.join(dir, 'bin');
    const reg = path.join(dir, 'registry');
    const src = path.join(dir, 'source');
    const work = path.join(dir, 'work');
    const tmp = path.join(dir, 'tmp');
    for (const d of [bin, reg, src, work, tmp]) fs.mkdirSync(d);
    for (const [tag, digest] of Object.entries(registry)) fs.writeFileSync(path.join(reg, tag), digest);
    for (const [tag, digest] of Object.entries(source)) fs.writeFileSync(path.join(src, tag), digest);
    // Files in the working directory: what an unquoted, glob-expanded tag would turn into.
    for (const name of plant) fs.writeFileSync(path.join(work, name), '');
    fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
    const log = path.join(dir, 'calls.log');
    const summary = path.join(dir, 'summary.md');
    const base = Object.fromEntries(Object.entries(process.env)
      .filter(([k]) => !SCRUBBED.includes(k) && k.toUpperCase() !== 'PATH'));
    const result = spawnSync(shell, [shPath(script), ...args], {
      cwd: work, encoding: 'utf8', timeout: 20_000,
      env: {
        ...base,
        PATH: searchPath(bin),
        TMPDIR: shPath(tmp),
        FAKE_LOG: shPath(log), FAKE_REG: shPath(reg), FAKE_SRC: shPath(src), FAKE_COUNT: shPath(path.join(dir, 'count')),
        GITHUB_STEP_SUMMARY: shPath(summary),
        ...env,
      },
    });
    if (result.error?.code === 'EPERM') { t.skip('sandbox denied process spawning (CI runs this test on Linux)'); return null; }
    if (result.error) throw result.error;
    const calls = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\x1f').slice(1)) : [];
    return {
      status: result.status, stdout: result.stdout, out: `${result.stdout}\n${result.stderr}`, calls,
      registry: Object.fromEntries(fs.readdirSync(reg).map((f) => [f, fs.readFileSync(path.join(reg, f), 'utf8')])),
      work: fs.readdirSync(work).sort(), tmp: fs.readdirSync(tmp),
      summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const copyCalls = (r) => r.calls.filter((c) => c[2] === 'create');

test('copies each tag FROM THE DIGEST (never from a tag), reads it back, and cleans up its temp file', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: 'dev 0b0a244' } });
  if (!r) return;
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, [
    inspect(`${DST}:dev`), create(`${DST}:dev`, `${SRC}@${DIGEST}`), inspect(`${DST}:dev`),
    inspect(`${DST}:0b0a244`), create(`${DST}:0b0a244`, `${SRC}@${DIGEST}`), inspect(`${DST}:0b0a244`),
  ]);
  assert.deepEqual(r.registry, { dev: DIGEST, '0b0a244': DIGEST });
  assert.deepEqual(r.tmp, [], 'the temporary file for docker errors was left behind');
});

// The repair command a failure prints. It is a copy dispatch of docker-publish.yml (registered with GitHub, unlike a
// new workflow on dev), with no --repo: in a run log the owner's name prints as ***, so a --repo would not paste.
const RECOPY = (tag, force = false) =>
  new RegExp(`gh workflow run docker-publish\\.yml --ref dev -f copy_tags=${tag.replace(/\./g, '\\.')}${force ? ' -f force=true' : '(?! -f force)'}(\\s|$)`);

test('a copy that reads back as another digest fails with exit 4 and the re-copy command', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: 'dev', GITHUB_REPOSITORY: 'sauso/nightlight' }, registry: { dev: OLD } });
  if (!r) return;
  assert.equal(r.status, 0, `control: with an honest registry the same copy succeeds\n${r.out}`);
  // The "registry" stores OTHER for the copy, so the read-back (the second inspect) sees OTHER.
  const bad = run(t, { env: { DIGEST, TAGS: 'dev', GITHUB_REPOSITORY: 'sauso/nightlight', FAKE_LANDS_AS: OTHER },
    registry: { dev: OLD } });
  assert.equal(bad.status, 4, bad.out);
  assert.match(bad.out, new RegExp(`read back as ${OTHER}, not ${DIGEST}`));
  assert.match(bad.out, RECOPY('dev'));
  assert.doesNotMatch(bad.out, /--repo/, 'the repair command names a repository (it prints as *** in a run)');
  assert.match(bad.summary, /`ghcr\.io\/sauso\/nightlight:dev`: FAILED/);
});

test('a read-back the registry cannot answer is a failure too (exit 4), not a pass', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: 'dev', FAKE_INSPECT_FAIL_AT: '2' } });
  if (!r) return;
  assert.equal(r.status, 4, r.out);
  assert.equal(copyCalls(r).length, 1);
});

test('an existing X.Y.Z tag at another digest is REFUSED (exit 3) and never copied', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: '0.49.0' }, registry: { '0.49.0': OLD } });
  if (!r) return;
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(r.calls, [inspect(`${DST}:0.49.0`)], 'a refused tag must not be copied');
  assert.equal(r.registry['0.49.0'], OLD);
  assert.match(r.out, new RegExp(`REFUSED to move it from ${OLD} to ${DIGEST}`), 'both digests are printed');
  assert.match(r.out, RECOPY('0.49.0', true));
  assert.doesNotMatch(r.out, /re-run/, 'a re-run would only refuse again');
});

test('FORCE=true lets an existing X.Y.Z tag move; only the exact word true does', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: '0.49.0', FORCE: 'true' }, registry: { '0.49.0': OLD } });
  if (!r) return;
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(copyCalls(r), [create(`${DST}:0.49.0`, `${SRC}@${DIGEST}`)]);
  assert.equal(r.registry['0.49.0'], DIGEST);
  assert.match(r.out, new RegExp(`was ${OLD}`), 'the previous digest is logged');
  const off = run(t, { env: { DIGEST, TAGS: '0.49.0', FORCE: 'false' }, registry: { '0.49.0': OLD } });
  assert.equal(off.status, 3, off.out);
  for (const force of ['TRUE', 'yes', '1', 'true;touch pwned']) {
    const odd = run(t, { env: { DIGEST, TAGS: '0.49.0', FORCE: force }, registry: { '0.49.0': OLD } });
    assert.equal(odd.status, 2, `FORCE=${force}: ${odd.out}`);
    assert.deepEqual(odd.calls, [], `FORCE=${force} reached docker`);
  }
});

test('a new X.Y.Z tag is created, and one already at the digest is left alone (a re-run is harmless)', { skip: skipShell }, (t) => {
  const fresh = run(t, { env: { DIGEST, TAGS: '0.50.0' } });
  if (!fresh) return;
  assert.equal(fresh.status, 0, fresh.out);
  assert.equal(fresh.registry['0.50.0'], DIGEST);
  const again = run(t, { env: { DIGEST, TAGS: '0.50.0' }, registry: { '0.50.0': DIGEST } });
  assert.equal(again.status, 0, again.out);
  assert.deepEqual(again.calls, [inspect(`${DST}:0.50.0`)], 'nothing to copy');
});

test('latest, dev, X.Y and a short sha may move to a new digest', { skip: skipShell }, (t) => {
  const tags = ['latest', 'dev', '0.49', '0b0a244', 'a'.repeat(40)];
  const r = run(t, { env: { DIGEST, TAGS: tags.join(' ') }, registry: Object.fromEntries(tags.map((x) => [x, OLD])) });
  if (!r) return;
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(copyCalls(r), tags.map((x) => create(`${DST}:${x}`, `${SRC}@${DIGEST}`)));
  for (const x of tags) assert.equal(r.registry[x], DIGEST, x);
});

test('one failed tag does not stop the others; the exit code is the first failure', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: 'latest 0.49.0 0.49 0b0a244' }, registry: { '0.49.0': OLD } });
  if (!r) return;
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(r.registry, { latest: DIGEST, '0.49.0': OLD, '0.49': DIGEST, '0b0a244': DIGEST });
  const lines = r.summary.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 4, `one summary line per tag:\n${r.summary}`);
  assert.match(lines[1], /`ghcr\.io\/sauso\/nightlight:0\.49\.0`: FAILED, REFUSED/);
  assert.match(lines[3], /`ghcr\.io\/sauso\/nightlight:0b0a244`: copied `sha256:d1/);
});

test('an X.Y.Z tag whose current digest cannot be read is not copied (fail closed, exit 1)', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: '0.49.0', FAKE_INSPECT_FAIL_AT: '1' }, registry: { '0.49.0': OLD } });
  if (!r) return;
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(copyCalls(r), []);
  assert.match(r.out, /403 Forbidden/, 'the registry error is shown');
});

test('a moving tag whose current digest cannot be read is still copied (it may move anyway)', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: 'dev', FAKE_INSPECT_FAIL_AT: '1' }, registry: { dev: OLD } });
  if (!r) return;
  assert.equal(r.status, 0, r.out);
  assert.equal(r.registry.dev, DIGEST);
  assert.match(r.out, /could not read the current digest/);
});

// "The tag is absent" is the one answer that lets an X.Y.Z tag be copied with no refusal check, so it must be the
// registry's exact not-found for THAT reference, on its own line. Look-alikes that merely CONTAIN "<ref>: not found"
// are an unreadable registry: a release tag fails closed (exit 1, no copy); a moving tag is copied anyway.
const LOOKALIKES = [
  `ERROR: authorization failed; ${DST}:1.2.3: not found in token scope`,
  `ERROR: ${DST}@${OTHER}: not found`,
  `ERROR: ${DST}:1.2.3: not found, retrying`,
  `WARNING: ${DST}:1.2.3: not found`,
  `ERROR: ${DST}:1.2.30: not found`,
  `ERROR: docker.io/${DST}:1.2.3: not found`,
  `WARNING: something unrelated\nERROR: ${DST}:1.2.3: not found`,
];
for (const msg of LOOKALIKES) {
  test(`a release tag whose registry says ${JSON.stringify(msg)} is not copied (fail closed)`, { skip: skipShell }, (t) => {
    const r = run(t, { env: { DIGEST, TAGS: '1.2.3', FAKE_MISSING_MSG: msg } });
    if (!r) return;
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(copyCalls(r), [], 'a look-alike of "not found" was read as "the tag is absent"');
    const moving = run(t, { env: { DIGEST, TAGS: 'dev', FAKE_MISSING_MSG: msg.replace('1.2.3', 'dev') } });
    assert.equal(moving.status, 0, `a moving tag is copied anyway: ${moving.out}`);
    assert.equal(moving.registry.dev, DIGEST);
  });
}

test('an access-denied registry error for a release tag fails closed', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: '1.2.3', FAKE_MISSING_MSG: 'ERROR: access denied' } });
  if (!r) return;
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(copyCalls(r), []);
  assert.match(r.out, /access denied/);
});

test('the exact not-found error still means "absent", with trailing spaces or a CR', { skip: skipShell }, (t) => {
  for (const msg of [`ERROR: ${DST}:1.2.3: not found`, `ERROR: ${DST}:1.2.3: not found \r`]) {
    const r = run(t, { env: { DIGEST, TAGS: '1.2.3', FAKE_MISSING_MSG: msg } });
    if (!r) return;
    assert.equal(r.status, 0, `${JSON.stringify(msg)}: ${r.out}`);
    assert.equal(r.registry['1.2.3'], DIGEST);
  }
});

test('--resolve reads each Docker Hub tag ONCE, then copies FROM that digest', { skip: skipShell }, (t) => {
  const D2 = `sha256:${'d2'.repeat(32)}`;
  const r = run(t, { args: ['--resolve'], env: { TAGS: 'dev 0.50.0' }, source: { dev: DIGEST, '0.50.0': D2 } });
  if (!r) return;
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, [
    inspect(`${SRC}:dev`), inspect(`${DST}:dev`), create(`${DST}:dev`, `${SRC}@${DIGEST}`), inspect(`${DST}:dev`),
    inspect(`${SRC}:0.50.0`), inspect(`${DST}:0.50.0`), create(`${DST}:0.50.0`, `${SRC}@${D2}`), inspect(`${DST}:0.50.0`),
  ]);
  assert.deepEqual(r.registry, { dev: DIGEST, '0.50.0': D2 });
  assert.match(r.out, new RegExp(`${SRC}:0\\.50\\.0 is ${D2}`), 'the Docker Hub digest is logged');
});

test('--resolve: a Docker Hub tag that is missing or unreadable fails that tag (exit 1), the rest are copied', { skip: skipShell }, (t) => {
  const r = run(t, { args: ['--resolve'], env: { TAGS: '0.50.0 dev latest' },
    source: { dev: DIGEST, latest: 'sha256:not-a-digest' } });
  if (!r) return;
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(copyCalls(r), [create(`${DST}:dev`, `${SRC}@${DIGEST}`)], 'only the readable tag is copied');
  assert.match(r.out, RECOPY('0.50.0'));
  assert.match(r.out, RECOPY('latest'));
  const lines = r.summary.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 3, `one summary line per tag:\n${r.summary}`);
  assert.match(lines[0], /:0\.50\.0`: FAILED, could not read sauso\/nightlight:0\.50\.0/);
  assert.match(lines[2], /:latest`: FAILED, could not read/);
});

test('--resolve keeps the refusal rule and FORCE, and the first failure code wins', { skip: skipShell }, (t) => {
  const r = run(t, { args: ['--resolve'], env: { TAGS: '0.49.0 0.50.0' }, source: { '0.49.0': DIGEST },
    registry: { '0.49.0': OLD } });
  if (!r) return;
  assert.equal(r.status, 3, `refusal first, then a missing source tag: ${r.out}`);
  assert.deepEqual(copyCalls(r), []);
  const forced = run(t, { args: ['--resolve'], env: { TAGS: '0.49.0', FORCE: 'true' }, source: { '0.49.0': DIGEST },
    registry: { '0.49.0': OLD } });
  assert.equal(forced.status, 0, forced.out);
  assert.equal(forced.registry['0.49.0'], DIGEST);
  // A DIGEST with --resolve would claim one image for every tag: refused before any call.
  const both = run(t, { args: ['--resolve'], env: { TAGS: 'dev', DIGEST }, source: { dev: DIGEST } });
  assert.equal(both.status, 2, both.out);
  assert.deepEqual(both.calls, []);
});

test('--resolve returns the first failure code when a later tag also fails', { skip: skipShell }, (t) => {
  const r = run(t, { args: ['--resolve'], env: { TAGS: '1.2.3 dev' },
    source: { '1.2.3': DIGEST }, registry: { '1.2.3': OLD } });
  if (!r) return;
  assert.equal(r.status, 3, r.out); // release refusal (3), then missing Docker Hub dev (1)
  assert.deepEqual(copyCalls(r), []);
  assert.match(r.out, RECOPY('dev'));
});

test('a failed copy exits non-zero, prints the re-copy command, and the next tag is still tried', { skip: skipShell }, (t) => {
  const r = run(t, { env: { DIGEST, TAGS: 'dev 0b0a244', FAKE_CREATE_FAILS: '1', GITHUB_REPOSITORY: 'sauso/nightlight' } });
  if (!r) return;
  assert.equal(r.status, 1, r.out);
  assert.equal(copyCalls(r).length, 2);
  assert.match(r.out, /re-run this run's failed job if it is the newest publish/);
  assert.match(r.out, RECOPY('dev'));
  assert.match(r.out, RECOPY('0b0a244'));
  assert.doesNotMatch(r.out, /--repo/);
  // Two different failures: a refusal (3) first, then a failed copy (1). The exit code is the FIRST one's.
  const two = run(t, { env: { DIGEST, TAGS: '0.49.0 dev', FAKE_CREATE_FAILS: '1' }, registry: { '0.49.0': OLD } });
  assert.equal(two.status, 3, two.out);
});

// Each of these must stop the script before ANY registry call: exit 2, the fake docker never runs, and nothing the
// value tries to do happens. `latest` is planted in the working directory so an unquoted, glob-expanded `*` would
// turn into a valid tag and reach docker.
const HOSTILE_TAGS = [
  'latest;touch pwned', '$(touch pwned)', '`touch pwned`', 'dev\nlatest;touch${IFS}pwned', 'latest\n$(touch pwned)',
  '*', 'late?t', 'v0.49.0', 'LATEST', 'Dev', '0.49.0-rc.1', '1.2.3.4', '1', '.1.2', '1.2.', '1..2', 'abcdef',
  'a'.repeat(41), 'abcdefg', '-t', '--help', 'evil/repo:latest', `${DST}:latest`, `${SRC}:latest;x`, `${SRC}:`,
  `${SRC}`, 'latest\r', '',
];
for (const tags of HOSTILE_TAGS) {
  test(`tag list ${JSON.stringify(tags)} is refused before any docker call`, { skip: skipShell }, (t) => {
    // 'abcdefg' is a valid 7-character short sha: it is here to prove the list is checked as a WHOLE.
    const r = run(t, { env: { DIGEST, TAGS: tags === 'abcdefg' ? 'abcdefg $(touch pwned)' : tags }, plant: ['latest'] });
    if (!r) return;
    assert.equal(r.status, 2, r.out);
    assert.deepEqual(r.calls, [], 'docker was called');
    assert.deepEqual(r.work, ['latest'], 'something was created in the working directory');
    assert.match(r.out, /nothing was copied/);
  });
}

test('a bad DIGEST, SRC_REPO or DST_REPO is refused before any docker call', { skip: skipShell }, (t) => {
  const cases = [
    { DIGEST: '' }, { DIGEST: `sha256:${'d1'.repeat(31)}` }, { DIGEST: `sha256:${'D1'.repeat(32)}` },
    { DIGEST: `sha512:${'d1'.repeat(32)}` }, { DIGEST: `${DIGEST};touch pwned` }, { DIGEST: `${DIGEST}\n${DIGEST}` },
    { DIGEST: `sha256:${'g'.repeat(64)}` }, { DIGEST: `$(touch pwned)` },
    { SRC_REPO: 'sauso/nightlight;touch pwned' }, { SRC_REPO: '-t' }, { SRC_REPO: '$(touch pwned)/x' },
    { SRC_REPO: 'Sauso/Nightlight' }, { SRC_REPO: 'nightlight' }, { SRC_REPO: 'sauso/nightlight:dev' },
    { SRC_REPO: 'sauso//nightlight' }, { SRC_REPO: 'sauso/../nightlight' }, { SRC_REPO: 'sauso/nightlight/' },
    { DST_REPO: 'ghcr.io/sauso/nightlight:latest' }, { DST_REPO: '--debug/x' }, { DST_REPO: 'ghcr.io/sauso/night light' },
    { DST_REPO: 'ghcr.io/sauso/nightlight@sha256:x' },
  ];
  for (const bad of cases) {
    const r = run(t, { env: { DIGEST, TAGS: 'dev', ...bad } });
    if (!r) return;
    assert.equal(r.status, 2, `${JSON.stringify(bad)}: ${r.out}`);
    assert.deepEqual(r.calls, [], `${JSON.stringify(bad)} reached docker`);
    assert.deepEqual(r.work, [], `${JSON.stringify(bad)} created a file`);
  }
});

test('no tags, or an unknown argument, is refused', { skip: skipShell }, (t) => {
  for (const [env, args] of [[{ DIGEST, TAGS: '' }, []], [{ DIGEST, TAGS: ' \n ' }, []], [{ DIGEST, TAGS: 'dev' }, ['--force']],
    [{ DIGEST, TAGS: 'dev' }, ['--check', 'extra']], [{ TAGS: 'dev' }, ['--resolve', 'extra']], [{ TAGS: '' }, ['--resolve']]]) {
    const r = run(t, { env, args });
    if (!r) return;
    assert.equal(r.status, 2, `${JSON.stringify(env)} ${args}: ${r.out}`);
    assert.deepEqual(r.calls, []);
  }
});

// The hostile fixture: every input the script reads carries a recognisable value, and decoy variables a careless
// script might read instead (the tag or ref names Actions and other tools use) carry a marker. Docker's argv may
// hold only the fixed words and the values built from the CHECKED inputs.
test('docker only ever sees checked values: every input marked, every decoy ignored', { skip: skipShell }, (t) => {
  const src = 'markersrc/nightlight';
  const dst = 'ghcr.io/markerdst/nightlight';
  const digest = `sha256:${'abcdef01'.repeat(8)}`;
  const decoys = Object.fromEntries(['TAG', 'REF', 'IMAGE', 'VERSION', 'GITHUB_REF_NAME', 'INPUT_TAGS', 'DOCKER_TAG',
    'DOCKER_METADATA_OUTPUT_TAGS'].map((k) => [k, `NLDECOY-${k}`]));
  const r = run(t, { env: { ...decoys, SRC_REPO: src, DST_REPO: dst, DIGEST: digest, FORCE: 'false',
    TAGS: `${src}:dev\ndocker.io/${src}:0.49.0 latest` } });
  if (!r) return;
  assert.equal(r.status, 0, r.out);
  const tags = ['dev', '0.49.0', 'latest'];
  const allowed = new Set(['buildx', 'imagetools', 'inspect', 'create', '-t', '--format', FORMAT, `${src}@${digest}`,
    ...tags.map((x) => `${dst}:${x}`)]);
  const argv = r.calls.flat();
  for (const a of argv) assert.ok(allowed.has(a), `docker was given an unchecked value: ${JSON.stringify(a)}`);
  assert.doesNotMatch(argv.join(' '), /NLDECOY/);
  assert.deepEqual(copyCalls(r), tags.map((x) => create(`${dst}:${x}`, `${src}@${digest}`)));
});

test('--check prints the bare tags, reduces full references, and calls nothing (no DIGEST needed)', { skip: skipShell }, (t) => {
  const r = run(t, { args: ['--check'],
    env: { TAGS: `${SRC}:dev\n${SRC}:0b0a244\ndocker.io/${SRC}:latest\n${SRC}:0.49.0 0.49` } });
  if (!r) return;
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stdout, 'dev\n0b0a244\nlatest\n0.49.0\n0.49\n');
  assert.deepEqual(r.calls, []);
  const bad = run(t, { args: ['--check'], env: { TAGS: `${SRC}:dev other/repo:dev` } });
  assert.equal(bad.status, 2, bad.out);
});
