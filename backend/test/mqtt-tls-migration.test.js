// db.js adds the MQTT TLS settings (#537) to an EXISTING install: same two-boot shape as
// primary-camera-migration.test.js, because on a fresh database every ALTER guard runs and a guard that is missing,
// nested wrongly or always true would pass the rest of the suite and only break a real upgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const DB_JS_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'db.js')).href;
const run = (dir, script) => execFileSync(process.execPath, ['-e', `process.env.DATA_DIR = ${JSON.stringify(dir)};\n${script}`], { encoding: 'utf8' });
const readTls = (dir) => JSON.parse(run(
  dir,
  `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
   console.log(JSON.stringify(db.prepare("SELECT mqtt_enabled, mqtt_host, mqtt_port, mqtt_tls, mqtt_tls_ca, mqtt_tls_verify FROM settings WHERE id = 'app'").get()));
   db.close();`
).trim());

test('★ an install from before TLS gains the columns, keeps plain mqtt:// and its broker, with verification on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-tlsmig-'));
  try {
    run(
      dir,
      `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       db.exec('ALTER TABLE settings DROP COLUMN mqtt_tls');
       db.exec('ALTER TABLE settings DROP COLUMN mqtt_tls_ca');
       db.exec('ALTER TABLE settings DROP COLUMN mqtt_tls_verify');
       db.prepare("UPDATE settings SET mqtt_enabled = 1, mqtt_host = 'broker.local', mqtt_port = 1883 WHERE id = 'app'").run();
       db.close();`
    );
    assert.deepEqual(readTls(dir), { mqtt_enabled: 1, mqtt_host: 'broker.local', mqtt_port: 1883, mqtt_tls: 0, mqtt_tls_ca: null, mqtt_tls_verify: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ an install that already has the columns boots again and keeps every choice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-tlsmig2-'));
  try {
    run(
      dir,
      `const { default: db } = await import(${JSON.stringify(DB_JS_URL)});
       db.prepare("UPDATE settings SET mqtt_tls = 1, mqtt_tls_ca = 'kept', mqtt_tls_verify = 0 WHERE id = 'app'").run();
       db.close();`
    );
    const got = readTls(dir);
    assert.deepEqual([got.mqtt_tls, got.mqtt_tls_ca, got.mqtt_tls_verify], [1, 'kept', 0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
