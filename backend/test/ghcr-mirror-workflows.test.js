// The two workflows that write to the ghcr.io mirror (docker-publish.yml's mirror-ghcr and copy-tags jobs,
// weekly-rebuild.yml's steps after a promotion) are checked here by STRUCTURE: YAML keys found by indentation, then the
// values read as tokens, never as whole-file string matches, so a reformat or a comment cannot break it. There is no
// YAML parser in the backend's dependencies (and none is added for this), so blocks are split by indentation the way
// publish-gate.test.js reads the gate job's permissions. What is pinned, and why:
// - `packages: write` (the token that can push to ghcr.io) is granted ONLY to the jobs that copy, never at the top
//   level, never to gate or build-and-push.
// - A ghcr.io login or outage can never stop the Docker Hub publish or promotion: the mirror is its own job in
//   docker-publish.yml, and comes after the promotion in weekly-rebuild.yml.
// - Inputs reach the script only through env:, never as ${{ }} inside run: (where a value would become shell code).
// - Every action is pinned to a commit SHA, the same one in both files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.env.GHCR_WORKFLOW_DIR || path.join(repo, '.github', 'workflows');
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/);

const indentOf = (l) => l.search(/\S/);
const isNoise = (l) => l.trim() === '' || /^\s*#/.test(l);

// The lines nested under line i: everything after it that is indented deeper (blank and comment lines kept).
function childLines(ls, i) {
  const ind = indentOf(ls[i]);
  const out = [];
  for (let j = i + 1; j < ls.length; j++) {
    if (!isNoise(ls[j]) && indentOf(ls[j]) <= ind) break;
    out.push(ls[j]);
  }
  return out;
}

// The keys of a mapping: the lines at the block's smallest indent. Each key has its inline value (a trailing
// ` # comment` removed) and its nested lines.
function mapping(ls) {
  const real = ls.filter((l) => !isNoise(l));
  if (!real.length) return {};
  const ind = Math.min(...real.map(indentOf));
  const out = {};
  ls.forEach((l, i) => {
    if (isNoise(l) || indentOf(l) !== ind) return;
    const m = /^\s*([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(l);
    if (m) out[m[1]] = { value: (m[2] || '').replace(/\s+#.*$/, '').trim(), lines: childLines(ls, i) };
  });
  return out;
}

// A sequence of mappings (`steps:`): each `- ` item becomes a mapping.
function sequence(ls) {
  const items = [];
  for (const l of ls) {
    if (/^\s*- /.test(l) && !isNoise(l)) items.push([l.replace(/- /, '  ')]);
    else if (items.length) items.at(-1).push(l);
  }
  return items.map(mapping);
}

const sub = (node, key) => mapping(node?.[key]?.lines || []);
const val = (node, key) => node?.[key]?.value;

function workflow(name) {
  const top = mapping(read(name));
  const jobs = sub(top, 'jobs');
  const jobOf = (id) => {
    const job = mapping(jobs[id]?.lines || []);
    return { job, steps: sequence(job.steps?.lines || []), permissions: sub(job, 'permissions') };
  };
  return { top, jobs, jobOf };
}

// Every `packages:` line in a file (comments excluded), and how many sit in the permission blocks we expect.
function packagesGrants(name) {
  return read(name).filter((l) => !isNoise(l) && /^\s*packages\s*:/.test(l)).map((l) => l.trim());
}
const perms = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.value]));

// A `run:` body: its inline value, or a block scalar's nested lines.
const runText = (s) => (s.run ? [s.run.value, ...s.run.lines].join('\n') : '');
const runBodies = (steps) => steps.filter((s) => s.run).map(runText);
const allSteps = (wf) => Object.keys(wf.jobs).flatMap((id) => wf.jobOf(id).steps);
const stepIndex = (steps, pred, what) => {
  const i = steps.findIndex(pred);
  assert.ok(i >= 0, `no step ${what}`);
  return i;
};
const usesAction = (s, action) => (val(s, 'uses') || '').startsWith(`${action}@`);
const ghcrLogin = (s) => usesAction(s, 'docker/login-action') && val(sub(s, 'with'), 'registry') === 'ghcr.io';
const runsMirror = (s) => /\bghcr-mirror\.sh\b/.test(runText(s)) && !/--check/.test(runText(s));
const runsCheck = (s) => /\bghcr-mirror\.sh --check\b/.test(runText(s));

function assertGhcrLogin(step) {
  const w = sub(step, 'with');
  assert.equal(val(w, 'registry'), 'ghcr.io');
  assert.match(val(w, 'username'), /^\$\{\{\s*github\.actor\s*\}\}$/);
  assert.match(val(w, 'password'), /^\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}$/);
}

test('docker-publish.yml: publish and copy dispatch have only the intended triggers and inputs', () => {
  const wf = workflow('docker-publish.yml');
  assert.deepEqual(Object.keys(sub(wf.top, 'on')), ['push', 'workflow_dispatch']);
  const inputs = sub(sub(sub(wf.top, 'on'), 'workflow_dispatch'), 'inputs');
  assert.deepEqual(Object.keys(inputs), ['gate_only', 'copy_tags', 'force']);
  assert.equal(val(sub(inputs, 'copy_tags'), 'type'), 'string');
  assert.equal(val(sub(inputs, 'copy_tags'), 'default'), "''");
  assert.equal(val(sub(inputs, 'force'), 'type'), 'boolean');
  assert.equal(val(sub(inputs, 'force'), 'default'), 'false');
  assert.match(val(wf.jobOf('gate').job, 'if'), /inputs\.copy_tags\s*==\s*''/);
  assert.match(val(wf.jobOf('build-and-push').job, 'if'), /inputs\.copy_tags\s*==\s*''/);
  const copyIf = val(wf.jobOf('copy-tags').job, 'if');
  assert.match(copyIf, /^\$\{\{\s*inputs\.copy_tags\s*!=\s*''\s*&&\s*!inputs\.gate_only\s*\}\}$/,
    'copy-tags must run only for a copy dispatch that is not gate_only');
  assert.doesNotMatch(copyIf, /always\(\)|\|\|/, 'an OR or always() could bypass the copy gate');
});

test('docker-publish.yml: packages: write is granted only to mirror-ghcr and copy-tags', () => {
  const wf = workflow('docker-publish.yml');
  assert.deepEqual(perms(sub(wf.top, 'permissions')), { contents: 'read' }, 'top-level permissions changed');
  assert.deepEqual(Object.keys(wf.jobs), ['gate', 'build-and-push', 'mirror-ghcr', 'copy-tags']);
  assert.deepEqual(perms(wf.jobOf('mirror-ghcr').permissions), { contents: 'read', packages: 'write' });
  assert.deepEqual(perms(wf.jobOf('copy-tags').permissions), { contents: 'read', packages: 'write' });
  assert.equal(wf.jobOf('gate').permissions.packages, undefined, 'gate can write packages');
  assert.equal(wf.jobOf('build-and-push').permissions.packages, undefined, 'build-and-push can write packages');
  assert.deepEqual(packagesGrants('docker-publish.yml'), ['packages: write', 'packages: write'], 'an extra packages grant somewhere');
  assert.ok(!read('docker-publish.yml').some((l) => !isNoise(l) && /write-all/.test(l)));
});

// The two jobs that can write packages log in to Docker Hub only to READ; they must use the read-only token, so a
// bug or a compromise there cannot push to Docker Hub. The push token stays in build-and-push (the publish) only.
test('docker-publish.yml: the packages: write jobs log in to Docker Hub with the READ-ONLY token, never the push token', () => {
  const wf = workflow('docker-publish.yml');
  for (const id of ['mirror-ghcr', 'copy-tags']) {
    const hubLogins = wf.jobOf(id).steps.filter((s) => usesAction(s, 'docker/login-action') && !ghcrLogin(s));
    assert.equal(hubLogins.length, 1, `${id}: expected exactly one Docker Hub login`);
    assert.match(val(sub(hubLogins[0], 'with'), 'password'), /^\$\{\{\s*secrets\.DOCKERHUB_READ_TOKEN\s*\}\}$/, `${id} must use the read-only token`);
  }
  // The push token is used by exactly one job: the publish.
  const jobsUsingPush = Object.keys(wf.jobs).filter((id) => wf.jobOf(id).steps.some((s) => /secrets\.DOCKERHUB_TOKEN\b/.test(val(sub(s, 'with'), 'password') || '')));
  assert.deepEqual(jobsUsingPush, ['build-and-push']);
});

test('docker-publish.yml: mirror-ghcr runs after a successful build-and-push, on its own, with env-only inputs', () => {
  const wf = workflow('docker-publish.yml');
  const { job, steps } = wf.jobOf('mirror-ghcr');
  assert.match(val(job, 'needs'), /^(\[\s*)?build-and-push(\s*\])?$/);
  const cond = val(job, 'if');
  // !cancelled() replaces the implicit success(), which a dev push (gate skipped) would turn false.
  assert.match(cond, /!cancelled\(\)/);
  assert.match(cond, /needs\.build-and-push\.result\s*==\s*'success'/);
  assert.match(cond, /&&\s*needs\.build-and-push\.result\s*==\s*'success'\s*&&/, 'an OR could mirror a skipped or failed build');
  assert.doesNotMatch(cond, /\|\|/, 'an OR could bypass the build result');
  assert.match(cond, /!inputs\.gate_only/);
  const login = stepIndex(steps, ghcrLogin, 'logging in to ghcr.io');
  assertGhcrLogin(steps[login]);
  const checkout = stepIndex(steps, (s) => usesAction(s, 'actions/checkout'), 'checking out the script');
  const copy = stepIndex(steps, runsMirror, 'running ghcr-mirror.sh');
  assert.ok(checkout < copy && login < copy, 'the script runs before its checkout or the login');
  const env = sub(steps[copy], 'env');
  assert.match(val(env, 'DIGEST'), /^\$\{\{\s*needs\.build-and-push\.outputs\.digest\s*\}\}$/);
  assert.match(val(env, 'TAGS'), /^\$\{\{\s*needs\.build-and-push\.outputs\.tags\s*\}\}$/);
  assert.equal(val(env, 'FORCE'), undefined, 'the publish must never force a release tag');
  assert.equal(val(sub(steps[checkout], 'with'), 'persist-credentials'), 'false');
  assert.equal(val(steps[copy], 'continue-on-error'), undefined);
});

test('docker-publish.yml: build-and-push stays Docker Hub only and hands over the digest and BARE tags', () => {
  const { job, steps } = workflow('docker-publish.yml').jobOf('build-and-push');
  assert.equal(steps.filter(ghcrLogin).length, 0, 'a ghcr.io login inside build-and-push could fail it before the push');
  assert.ok(!steps.some(runsMirror), 'the copy runs inside build-and-push');
  const outputs = sub(job, 'outputs');
  assert.match(val(outputs, 'digest'), /^\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}$/);
  const build = stepIndex(steps, (s) => val(s, 'id') === 'build', 'with id build');
  assert.ok(usesAction(steps[build], 'docker/build-push-action'));
  // NOT steps.meta.outputs.tags: those are full references (sauso/nightlight:dev), and the runner drops a job output
  // that contains a secret's value; the Docker Hub username secret is the repository owner's name.
  const tagsRef = /^\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.tags\s*\}\}$/.exec(val(outputs, 'tags'));
  assert.ok(tagsRef, `tags output is ${val(outputs, 'tags')}`);
  assert.notEqual(tagsRef[1], 'meta', 'full references would be dropped as "may contain secret"');
  const list = stepIndex(steps, (s) => val(s, 'id') === tagsRef[1], `with id ${tagsRef[1]}`);
  assert.ok(list > build, 'the tag list step runs before the push (it could then block it)');
  assert.equal(val(steps[list], 'continue-on-error'), 'true', 'the tag list step can fail the Docker Hub job');
  assert.ok(runsCheck(steps[list]), 'the tag list is not made by ghcr-mirror.sh --check');
  assert.equal(val(steps[list], 'continue-on-error'), 'true');
  assert.match(val(sub(steps[list], 'env'), 'TAGS'), /^\$\{\{\s*steps\.meta\.outputs\.tags\s*\}\}$/);
});

test('weekly-rebuild.yml: the ghcr.io copy comes after the Docker Hub promotion and only after it promoted', () => {
  const wf = workflow('weekly-rebuild.yml');
  assert.deepEqual(Object.keys(sub(wf.top, 'on')), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(perms(sub(wf.top, 'permissions')), { contents: 'read' });
  assert.deepEqual(Object.keys(wf.jobs), ['rebuild']);
  assert.deepEqual(perms(wf.jobOf('rebuild').permissions), { contents: 'read', packages: 'write' });
  assert.deepEqual(packagesGrants('weekly-rebuild.yml'), ['packages: write']);
  const { steps } = wf.jobOf('rebuild');
  const promote = stepIndex(steps, (s) => val(s, 'id') === 'promote', 'with id promote');
  const ghcrSteps = steps.map((s, i) => [s, i]).filter(([s]) =>
    ghcrLogin(s) || runsMirror(s) || /ghcr-mirror/.test(val(sub(s, 'with'), 'path') || ''));
  assert.equal(ghcrSteps.length, 3, 'expected the script checkout, the login and the copy');
  for (const [s, i] of ghcrSteps) {
    assert.ok(i > promote, `"${val(s, 'name')}" runs before the promotion: a ghcr.io failure could then stop it`);
    assert.match(val(s, 'if') || '', /steps\.promote\.outputs\.result\s*==\s*'promoted'/, `"${val(s, 'name')}" is not gated on a promotion`);
  }
  assertGhcrLogin(ghcrSteps.find(([s]) => ghcrLogin(s))[0]);
  const copy = ghcrSteps.find(([s]) => runsMirror(s))[0];
  assert.match(val(sub(copy, 'env'), 'DIGEST'), /^\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}$/);
  assert.match(val(sub(copy, 'env'), 'TAGS'), /^\$\{\{\s*matrix\.tag\s*\}\}$/);
  assert.equal(val(sub(copy, 'env'), 'FORCE'), undefined);
  assert.equal(val(copy, 'continue-on-error'), undefined);
  // The promote step must still write result=promoted only on its PROMOTE path, after the race check.
  const body = runText(steps[promote]);
  const race = body.indexOf('git ls-remote');
  const promoteBranch = body.indexOf('if [ "$PROMOTE" = "true" ]');
  const promoted = body.indexOf('result=promoted');
  assert.ok(race >= 0 && promoteBranch > race && promoted > promoteBranch, 'result=promoted is not behind the race check and PROMOTE');
  // The script comes from this workflow's commit, not from the matrix checkout (main has none before a release).
  const checkout = ghcrSteps.find(([s]) => usesAction(s, 'actions/checkout'))[0];
  assert.match(val(sub(checkout, 'with'), 'ref'), /^\$\{\{\s*github\.sha\s*\}\}$/);
  assert.equal(val(sub(checkout, 'with'), 'persist-credentials'), 'false');
  const matrixCheckout = steps.find((s) => usesAction(s, 'actions/checkout') && val(sub(s, 'with'), 'ref') === '${{ matrix.ref }}');
  assert.ok(matrixCheckout, 'matrix checkout missing');
  assert.equal(val(sub(matrixCheckout, 'with'), 'persist-credentials'), 'false');
});

test('docker-publish.yml: copy-tags resolves through the script, after validation and login, with weekly concurrency', () => {
  const wf = workflow('docker-publish.yml');
  const weekly = sub(workflow('weekly-rebuild.yml').top, 'concurrency');
  const { job, steps } = wf.jobOf('copy-tags');
  const conc = sub(job, 'concurrency');
  assert.equal(val(conc, 'group'), val(weekly, 'group'), 'not the weekly-rebuild group: a copy could race a promotion');
  assert.equal(val(conc, 'cancel-in-progress'), 'false');
  const check = stepIndex(steps, runsCheck, 'checking the tags');
  const logins = steps.map((s, i) => [s, i]).filter(([s]) => usesAction(s, 'docker/login-action'));
  assert.equal(logins.length, 2, 'expected a Docker Hub and a ghcr.io login');
  for (const [, i] of logins) assert.ok(i > check, 'a login runs before the tags are checked');
  assertGhcrLogin(logins.find(([s]) => ghcrLogin(s))[0]);
  assert.match(val(sub(steps[check], 'env'), 'COPY_TAGS'), /^\$\{\{\s*inputs\.copy_tags\s*\}\}$/);
  const copy = stepIndex(steps, runsMirror, 'running ghcr-mirror.sh');
  assert.ok(copy > Math.max(...logins.map(([, i]) => i)));
  const copyRun = runText(steps[copy]);
  assert.match(copyRun, /^\s*export TAGS="\$\{COPY_TAGS\/\/,\/ \}"\s*$/m,
    'Copy each tag must use the input, converting commas to spaces');
  assert.match(copyRun, /\bsh scripts\/ghcr-mirror\.sh --resolve\b/);
  assert.match(val(sub(steps[copy], 'env'), 'COPY_TAGS'), /^\$\{\{\s*inputs\.copy_tags\s*\}\}$/);
  assert.match(val(sub(steps[copy], 'env'), 'FORCE'), /^\$\{\{\s*inputs\.force\s*\}\}$/);
  assert.equal(val(steps[copy], 'continue-on-error'), undefined);
  for (const s of steps.filter((s) => usesAction(s, 'actions/checkout')))
    assert.equal(val(sub(s, 'with'), 'persist-credentials'), 'false');
});

test('no ${{ }} inside any run: block of the two workflows (inputs go through env:)', () => {
  for (const name of ['docker-publish.yml', 'weekly-rebuild.yml']) {
    for (const body of runBodies(allSteps(workflow(name)))) {
      assert.doesNotMatch(body, /\$\{\{/, `${name}: an expression inside run:\n${body}`);
    }
  }
});

test('every action in the two workflows is pinned to a commit SHA, the same one in each file', () => {
  const pins = new Map();
  for (const name of ['docker-publish.yml', 'weekly-rebuild.yml']) {
    const uses = read(name).filter((l) => !isNoise(l)).map((l) => /^\s*(?:- )?uses:\s*(\S+)/.exec(l)?.[1]).filter(Boolean);
    assert.ok(uses.length > 0, `${name}: no actions found`);
    for (const u of uses) {
      const m = /^([\w.-]+\/[\w./-]+)@([0-9a-f]{40})$/.exec(u);
      assert.ok(m, `${name}: ${u} is not pinned to a full commit SHA`);
      if (!pins.has(m[1])) pins.set(m[1], new Set());
      pins.get(m[1]).add(m[2]);
    }
  }
  for (const [action, shas] of pins) assert.equal(shas.size, 1, `${action} is pinned to ${[...shas].join(' and ')}`);
});
