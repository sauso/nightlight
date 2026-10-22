import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPort, configureEnvironment } from '../../windows/launch.mjs';

describe('native Windows service configuration', () => {
  test('reads the server port, including Windows INI line endings and a BOM', () => {
    assert.equal(readPort('\uFEFF[Server]\r\nPort=4080\r\n'), 4080);
    assert.equal(readPort('[Other]\nPort=9999\n[server]\nport = 4081\n'), 4081);
    assert.equal(readPort('; comment\n[Other]\nPort=9999\n'), 4000);
  });
  test('refuses invalid ports instead of starting on another port silently', () => {
    for (const port of ['0', '65536', '-1', '4e3', '4000x', '4000;other=value', '']) {
      assert.throws(() => readPort(`[Server]\nPort=${port}\n`), /whole number/);
    }
  });
  test('sets data and binary paths before backend imports, without losing the OS environment', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-native-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installDir = path.join(root, 'Program Files with spaces', 'Nightlight');
    const dataDir = path.join(root, 'ProgramData', 'Nightlight');
    const env = { Path: 'existing-system-path', SystemRoot: 'windows-root', PORT: '9999', DATA_DIR: 'wrong-place' };
    configureEnvironment({ installDir, dataDir, ini: '[Server]\nPort=4080\n', env });
    assert.equal(env.DATA_DIR, dataDir);
    assert.equal(env.PORT, '4080');
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.PATH, `${path.join(installDir, 'bin')}${path.delimiter}existing-system-path`);
    assert.equal(env.SystemRoot, 'windows-root');
    assert.equal(env.PUBLIC_HOST, '127.0.0.1');
    assert.equal(env.STUN_SERVERS, '');
    assert.equal(env.TEMP, path.join(dataDir, 'tmp'));
    assert.equal(env.TMP, env.TEMP);
    assert.ok(fs.statSync(env.TEMP).isDirectory());
  });
  test('does not accept a relative data or installation path', () => {
    assert.throws(() => configureEnvironment({ installDir: '.', dataDir: '/data', ini: '' }), /absolute/);
    assert.throws(() => configureEnvironment({ installDir: process.cwd(), dataDir: '.', ini: '' }), /absolute/);
  });
  test('preserves explicit remote networking settings while retaining local viewing', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-native-network-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { PUBLIC_HOST: 'remote.example,127.0.0.1', STUN_SERVERS: 'stun:stun.example:3478' };
    configureEnvironment({ installDir: root, dataDir: path.join(root, 'data'), ini: '', env });
    assert.equal(env.PUBLIC_HOST, '127.0.0.1,remote.example');
    assert.equal(env.STUN_SERVERS, 'stun:stun.example:3478');
  });
});
