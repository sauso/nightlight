// #549: the app's own startup line, `[data-dir] app umask 077; private/babymonitor.db mode 600`. It is the evidence that the
// mask entrypoint.sh sets actually reached the app process (and so FFmpeg and MediaMTX, which inherit it); the
// entrypoint's line only shows what was set. Pure formatting and parsing, so this runs everywhere, Windows included
// (the entrypoint itself is tested in entrypoint-umask.test.js, on Linux only).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUmask, formatDataDirModes, logDataDirModes } from '../src/lib/dataDirModes.js';

// A real /proc/self/status excerpt (Linux 6.x), Umask on the second line as the kernel prints it.
const STATUS = 'Name:\tnode\nUmask:\t0077\nState:\tS (sleeping)\nTgid:\t1\n';

describe('parseUmask (reads /proc/self/status, never process.umask())', () => {
  test('reads the Umask line as octal', () => {
    assert.equal(parseUmask(STATUS), 0o077);
    assert.equal(parseUmask(STATUS.replace('0077', '0022')), 0o022);
    assert.equal(parseUmask(STATUS.replace('0077', '0000')), 0);
  });

  test('anything else is null (an older kernel without the line, no /proc, not a string)', () => {
    assert.equal(parseUmask('Name:\tnode\nState:\tS\n'), null);
    assert.equal(parseUmask('Umask:\tzz\n'), null);
    assert.equal(parseUmask('NotUmask:\t0077\n'), null);
    assert.equal(parseUmask(''), null);
    assert.equal(parseUmask(undefined), null);
  });
});

describe('formatDataDirModes', () => {
  test('three octal digits each, the way `stat -c %a` and the entrypoint line print them', () => {
    assert.equal(formatDataDirModes({ umask: 0o077, dbMode: 0o100600 }), '[data-dir] app umask 077; babymonitor.db mode 600');
    assert.equal(formatDataDirModes({ umask: 0o022, dbMode: 0o100644 }), '[data-dir] app umask 022; babymonitor.db mode 644');
    assert.equal(formatDataDirModes({ umask: 0o027, dbMode: 0o100640 }), '[data-dir] app umask 027; babymonitor.db mode 640');
  });

  test('a zero mask is 000, not unknown (0 is falsy; only a missing value is unknown)', () => {
    assert.equal(formatDataDirModes({ umask: 0, dbMode: 0o100666 }), '[data-dir] app umask 000; babymonitor.db mode 666');
  });

  test('a value that could not be read says so', () => {
    assert.equal(formatDataDirModes({ umask: null, dbMode: null }), '[data-dir] app umask unknown; babymonitor.db mode unknown');
    assert.equal(formatDataDirModes({ umask: undefined, dbMode: 0o100600 }), '[data-dir] app umask unknown; babymonitor.db mode 600');
  });
});

describe('logDataDirModes', () => {
  test('logs exactly one line, from the status text and the database file the app opened', () => {
    const lines = [];
    const statted = [];
    logDataDirModes('/data', {
      dbPath: path.join('/data', 'private', 'babymonitor.db'),
      readStatus: () => STATUS,
      stat: (p) => { statted.push(p); return { mode: 0o100600 }; },
      log: (l) => lines.push(l),
    });
    assert.deepEqual(lines, ['[data-dir] app umask 077; private/babymonitor.db mode 600']);
    assert.deepEqual(statted, [path.join('/data', 'private', 'babymonitor.db')]);
  });

  test('never throws: no /proc and no database still log one line (a fresh install names private/)', () => {
    const lines = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-data-dir-modes-'));
    try {
      assert.doesNotThrow(() => logDataDirModes(dir, {
        readStatus: () => { throw new Error('ENOENT: no /proc here'); },
        log: (l) => lines.push(l),
      }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(lines, ['[data-dir] app umask unknown; private/babymonitor.db mode unknown']);
  });

  // #553 phase 2a: before this the line stat-ed DATA_DIR/babymonitor.db by name, so after the move into private/ it
  // would have said `unknown` forever. Without a dbPath it resolves the way db.js does.
  for (const [layout, rel] of [['legacy', ['babymonitor.db']], ['private', ['private', 'babymonitor.db']]]) {
    test(`#553 with the real fs (${layout} layout): the mode logged is that database file's own, named by its place`, () => {
      const lines = [];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-data-dir-modes-'));
      try {
        const db = path.join(dir, ...rel);
        fs.mkdirSync(path.dirname(db), { recursive: true });
        fs.writeFileSync(db, 'x');
        // Whatever this platform reports (NTFS cannot show 0600), the line must carry the same three digits.
        const want = (fs.statSync(db).mode & 0o777).toString(8).padStart(3, '0');
        logDataDirModes(dir, { readStatus: () => STATUS, log: (l) => lines.push(l) });
        assert.deepEqual(lines, [`[data-dir] app umask 077; ${rel.join('/')} mode ${want}`]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
