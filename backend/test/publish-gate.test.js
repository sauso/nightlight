// The fake gh emits real CLI-shaped JSON. Each call can return a new snapshot,
// including a changed attempt of the same run; the publish script is the subject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = process.env.PUBLISH_GATE_SCRIPT || path.join(repo, 'scripts', 'publish-gate.sh');
const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const bash = process.platform === 'win32' && fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const bashProbe = spawnSync(bash, ['-c', 'exit 0'], { encoding: 'utf8' });
const skipBash = bashProbe.error?.code === 'ENOENT' || bashProbe.error?.code === 'EPERM'
  ? `bash unavailable: ${bashProbe.error.message}` : false;

function run(id, status = 'completed', conclusion = 'success', headSha = sha, createdAt = '2026-11-16T00:00:00Z') {
  return { databaseId: id, headSha, status, conclusion,
    createdAt, url: `https://github.com/example/repo/actions/runs/${id}` };
}

function exercise(t, snapshots, expected, timeout = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gate-'));
  try {
    snapshots.forEach((snapshot, i) => fs.writeFileSync(path.join(dir, `${i + 1}.json`),
      typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot)));
    const fakeGh = `#!/usr/bin/env bash
set -eu
expected="run list --workflow test.yml --commit $GITHUB_SHA --event push --branch main --json databaseId,headSha,status,conclusion,createdAt,url --limit 20"
if [ "$*" != "$expected" ]; then echo "wrong gh arguments: $*" >&2; exit 90; fi
count=$(cat "$GATE_TEST_COUNT" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$GATE_TEST_COUNT"
if [ "$count" -gt "$GATE_TEST_CASES" ]; then count=$GATE_TEST_CASES; fi
fixture="$GATE_TEST_FIXTURES/$count.json"
if [ "$(cat "$fixture")" = '__GH_FAILURE__' ]; then
  echo 'fake gh failed' >&2
  exit 1
fi
cat "$fixture"
`;
    fs.writeFileSync(path.join(dir, 'gh'), fakeGh, { mode: 0o755 });
    const result = spawnSync(bash, [script], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        GITHUB_SHA: sha, GATE_TIMEOUT_S: String(timeout), GATE_POLL_S: '0',
        GATE_TEST_COUNT: path.join(dir, 'count'), GATE_TEST_CASES: String(snapshots.length),
        GATE_TEST_FIXTURES: dir },
    });
    if (result.error?.code === 'EPERM') { t.skip('sandbox denied process spawning (CI runs this test on Linux)'); return; }
    if (result.error) throw result.error;
    assert.equal(result.status, expected.status, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, expected.message);
    if (expected.calls) assert.equal(Number(fs.readFileSync(path.join(dir, 'count'), 'utf8')), expected.calls);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('passing newest run allows publishing', { skip: skipBash }, t => {
  exercise(t, [[run(10)]], { status: 0, message: /test run 10 passed/, calls: 1 });
});
for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
  test(`${conclusion} run blocks publishing immediately`, { skip: skipBash }, t => {
    exercise(t, [[run(10, 'completed', conclusion)]],
      { status: 1, message: new RegExp(`test run 10 ended ${conclusion}.*\/10`), calls: 1 });
  });
}
test('missing test run times out without publishing', { skip: skipBash }, t => {
  exercise(t, [[]], { status: 2, message: /no test run for this commit: it is never published untested/ }, 0);
});
test('in-progress run is polled until it passes', { skip: skipBash }, t => {
  exercise(t, [[run(10, 'in_progress', '')], [run(10)]],
    { status: 0, message: /waiting for test run 10.*test run 10 passed/s, calls: 2 });
});
test('newer failure beats older success', { skip: skipBash }, t => {
  exercise(t, [[run(10), run(11, 'completed', 'failure', sha, '2026-11-16T01:00:00Z')]],
    { status: 1, message: /test run 11 ended failure/, calls: 1 });
});
test('newer in-progress run must finish before older success counts', { skip: skipBash }, t => {
  exercise(t, [[run(10), run(11, 'in_progress', '', sha, '2026-11-16T01:00:00Z')],
    [run(10), run(11, 'completed', 'success', sha, '2026-11-16T01:00:00Z')]],
    { status: 0, message: /waiting for test run 11.*test run 11 passed/s, calls: 2 });
});
test('success for another full SHA is ignored', { skip: skipBash }, t => {
  exercise(t, [[run(10, 'completed', 'success', otherSha)]],
    { status: 2, message: /no test run for this commit: it is never published untested/ }, 0);
});
test('a re-run of the same run id uses its current attempt', { skip: skipBash }, t => {
  exercise(t, [[run(10, 'in_progress', '')], [run(10, 'completed', 'success')]],
    { status: 0, message: /waiting for test run 10.*test run 10 passed/s, calls: 2 });
});

test('a transient gh error is retried until a run passes', { skip: skipBash }, t => {
  // stdout and stderr are joined in that order, so the stderr retry notice follows the stdout pass line: match both, any order.
  exercise(t, ['__GH_FAILURE__', [run(10)]],
    { status: 0, message: /^(?=[\s\S]*gh run list failed, retrying)(?=[\s\S]*test run 10 passed)/, calls: 2 });
});
test('persistent gh errors time out closed with the last error', { skip: skipBash }, t => {
  exercise(t, ['__GH_FAILURE__'],
    { status: 2, message: /timed out.*fake gh failed/s }, 0);
});
test('invalid gh JSON is retried until a run passes', { skip: skipBash }, t => {
  exercise(t, ['not JSON', [run(10)]],
    { status: 0, message: /^(?=[\s\S]*gh run list failed, retrying)(?=[\s\S]*test run 10 passed)/, calls: 2 });
});

// Check the control flow by YAML keys and expression tokens, not exact formatting.
test('publish workflow has a read-only gate and accepts a skipped gate for dev', () => {
  const yaml = fs.readFileSync(process.env.PUBLISH_GATE_WORKFLOW ||
    path.join(repo, '.github/workflows/docker-publish.yml'), 'utf8');
  const gate = /^  gate:[^\n]*\n([\s\S]*?)(?=^  build-and-push:)/m.exec(yaml)?.[1];
  const build = /^  build-and-push:\s*$([\s\S]*)/m.exec(yaml)?.[1];
  assert.ok(gate, 'gate job is missing');
  assert.ok(build, 'build-and-push job is missing');
  assert.match(yaml, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+gate_only:/);
  assert.match(yaml, /group:.*github\.sha.*inputs\.gate_only/);
  assert.match(gate, /github\.ref.*refs\/heads\/main.*refs\/tags\/v.*inputs\.gate_only/);
  // The gate job's `permissions:` block must grant actions: read. Read line by line, not with a nested-quantifier
  // regex: CodeQL flagged the first version as a ReDoS (js/redos, found on the 0.49.0 release PR), and a block read
  // by indentation is also clearer about where the block ends.
  const gateLines = gate.split(/\r?\n/);
  const permAt = gateLines.findIndex((l) => /^\s*permissions:\s*$/.test(l));
  assert.ok(permAt >= 0, 'gate job has no permissions block');
  const permIndent = gateLines[permAt].search(/\S/);
  const permBlock = [];
  for (let i = permAt + 1; i < gateLines.length && (gateLines[i].trim() === '' || gateLines[i].search(/\S/) > permIndent); i++) {
    permBlock.push(gateLines[i].trim());
  }
  assert.ok(permBlock.includes('actions: read'), `gate permissions are ${JSON.stringify(permBlock)}, expected actions: read`);
  assert.match(gate, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  // Only a branch dispatch uses its branch's test run; a tag dispatch needs main's.
  assert.match(gate, /GATE_BRANCH:.*workflow_dispatch.*startsWith\(github\.ref,\s*'refs\/tags\/'\).*github\.ref_name.*'main'/);
  assert.match(build, /needs:\s*(?:\[[^\]]*\bgate\b[^\]]*\]|gate\b)/);
  assert.match(build, /if:.*needs\.gate\.result.*skipped/);
  assert.match(build, /if:.*!inputs\.gate_only/);
});
