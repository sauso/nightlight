// A throwaway repo-shaped tree around a COPY of scripts/mutate.mjs, for the tests of the mutation harness
// (mutate-kill-safety.test.js, mutants-catalogue.test.js).
//
// ⚠️ WHY A COPY OF THE TREE AND NOT THE REAL ONE: the harness writes mutants into source files. A test that
// pointed it at the repo's own source would mutate the code the rest of the suite is importing, and would
// make every `--full` mutation pass see these files fail for a reason that has nothing to do with the mutant.
// The fixture's tiny modules are all that is ever mutated. (The one test that DOES read the real catalogue,
// mutants-catalogue.test.js, runs `--check`, which never writes.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REAL_REPO = path.resolve(HERE, '..', '..', '..');
export const REAL_HARNESS = path.join(REAL_REPO, 'scripts', 'mutate.mjs');

const trees = [];

// `files` maps a repo-relative path to its text. package.json for the backend is always written, as ESM: without
// "type": "module" the fixture's `.js` files load as CommonJS, every test file fails to load, and that reads as a
// KILLED mutant, which would make a case pass or fail for the wrong reason.
export function buildTree(catalogue, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-mutate-fx-'));
  trees.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(REAL_HARNESS, path.join(dir, 'scripts', 'mutate.mjs'));
  fs.writeFileSync(path.join(dir, 'scripts', 'mutants.json'), JSON.stringify(catalogue, null, 2));
  fs.mkdirSync(path.join(dir, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backend', 'package.json'), '{"type":"module"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    // Buffer in, bytes out: a case about line endings must control every byte, so no helper rewrites them.
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

export function cleanupTrees() {
  for (const d of trees.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

// Start the harness and hand back the child plus a promise of its result, so a case can act while it runs
// (kill it mid-mutation) as well as just wait for it.
export function startHarness(dir, extraArgs = [], env = {}) {
  const child = spawn(process.execPath, [path.join(dir, 'scripts', 'mutate.mjs'), ...extraArgs], {
    cwd: dir, env: { ...process.env, ...env }, windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => {
    // A harness that has regressed to waiting forever must fail THIS case, not hang the whole suite.
    const bail = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 90 * 1000);
    child.on('close', (code, signal) => { clearTimeout(bail); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, done };
}

export const runHarness = (dir, extraArgs, env) => startHarness(dir, extraArgs, env).done;

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export async function waitDead(pid, ms = 8000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}
export async function waitFor(predicate, ms = 30000) {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return predicate();
}
