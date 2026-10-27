import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { validateHost } from '../lib/mqttClient.js';
import { validEsphomeKey } from '../lib/esphomeTransport.js';
import { refreshEsphome, esphomeStatus, getEsphomeEntities, testEsphomeDevice, deleteEsphomeDevice } from '../lib/esphomeManager.js';

const router = Router();
router.use(requireAuth, requireAdmin);
const bad = (res, error) => res.status(400).json({ error });
const configErrors = new Set([
  'A device configuration is required.', 'Name must be 1 to 100 characters.',
  "Use the device's IP address; names ending in .local do not resolve inside the container.",
  'Host must be a valid IP address or hostname.', 'Port must be a whole number from 1 to 65535.',
  'Choose an existing child.', 'Key must be text.',
  'The encryption key must be a base64 value of 32 bytes.',
]);
const safeConfigError = (error) => configErrors.has(error?.message) ? error.message : 'Could not save the device.';
const publicDevice = (row, status) => ({ id: row.id, name: row.name, host: row.host, port: row.port,
  child_id: row.child_id, enabled: !!row.enabled, created_at: row.created_at,
  key_set: !!row.encryption_key, status });
const idOf = (raw) => { const n = Number(raw); return Number.isSafeInteger(n) && n > 0 ? n : null; };

function config(body, previous = null) {
  if (!body || typeof body !== 'object') throw new Error('A device configuration is required.');
  const name = body.name === undefined ? previous?.name : body.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Name must be 1 to 100 characters.');
  const enteredHost = body.host === undefined && previous?.host?.includes(':')
    ? `[${previous.host}]` : (body.host === undefined ? previous?.host : body.host);
  if (typeof enteredHost === 'string' && /\.local\.?$/i.test(enteredHost.trim()))
    throw new Error("Use the device's IP address; names ending in .local do not resolve inside the container.");
  let host;
  try { host = validateHost(enteredHost); } catch { throw new Error('Host must be a valid IP address or hostname.'); }
  const rawPort = body.port === undefined ? (previous?.port || 6053) : body.port;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be a whole number from 1 to 65535.');
  const childId = body.child_id === undefined ? (previous?.child_id || null) : (body.child_id || null);
  if (childId !== null && (typeof childId !== 'string' || !db.prepare('SELECT id FROM children WHERE id = ?').get(childId)))
    throw new Error('Choose an existing child.');
  const enabled = body.enabled === undefined ? (previous?.enabled ?? 1) : (body.enabled ? 1 : 0);
  const rawKey = body.key;
  if (rawKey && typeof rawKey !== 'string') throw new Error('Key must be text.');
  let key = previous?.encryption_key || null;
  if (body.clear_key === true) key = null;
  else if (typeof rawKey === 'string' && rawKey.trim()) {
    try { key = validEsphomeKey(rawKey.trim()); } catch { throw new Error('The encryption key must be a base64 value of 32 bytes.'); }
  }
  // net.connect expects a bare IPv6 address; only the stored and dialled form is unbracketed.
  return { name: name.trim(), host: host.startsWith('[') ? host.slice(1, -1) : host,
    port, childId, enabled, key };
}

router.get('/devices', (req, res) => {
  const statuses = new Map(esphomeStatus().map((s) => [s.id, s]));
  res.json(db.prepare('SELECT * FROM esphome_devices ORDER BY id').all().map((row) => publicDevice(row, statuses.get(row.id))));
});

router.post('/devices', (req, res) => {
  try {
    if (db.prepare('SELECT COUNT(*) AS n FROM esphome_devices').get().n >= 8) return bad(res, 'A maximum of 8 devices is supported.');
    const c = config(req.body);
    const id = db.prepare('INSERT INTO esphome_devices (name, host, port, encryption_key, child_id, enabled) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.name, c.host, c.port, c.key, c.childId, c.enabled).lastInsertRowid;
    refreshEsphome();
    res.status(201).json(publicDevice(db.prepare('SELECT * FROM esphome_devices WHERE id = ?').get(id), esphomeStatus().find((s) => s.id === id)));
  } catch (error) { bad(res, safeConfigError(error)); }
});

router.put('/devices/:id', (req, res) => {
  const id = idOf(req.params.id);
  const previous = id && db.prepare('SELECT * FROM esphome_devices WHERE id = ?').get(id);
  if (!previous) return res.status(404).json({ error: 'Device not found.' });
  try {
    const c = config(req.body, previous);
    db.transaction(() => {
      db.prepare('UPDATE esphome_devices SET name = ?, host = ?, port = ?, encryption_key = ?, child_id = ?, enabled = ? WHERE id = ?')
        .run(c.name, c.host, c.port, c.key, c.childId, c.enabled, id);
      if (c.childId !== previous.child_id) {
        // #506: keep old rows attributed to the child who had the device when recorded.
        const old = db.prepare('SELECT * FROM esphome_entities WHERE device_id = ? AND active = 1').all(id);
        db.prepare('UPDATE esphome_entities SET active = 0 WHERE device_id = ? AND active = 1').run(id);
        const add = db.prepare(`INSERT INTO esphome_entities
          (device_id, object_id, child_id, kind, name, device_class, unit, state_class, entity_category)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const e of old) add.run(id, e.object_id, c.childId, e.kind, e.name, e.device_class,
          e.unit, e.state_class, e.entity_category);
      }
    })();
    refreshEsphome();
    res.json(publicDevice(db.prepare('SELECT * FROM esphome_devices WHERE id = ?').get(id), esphomeStatus().find((s) => s.id === id)));
  } catch (error) { bad(res, safeConfigError(error)); }
});

router.delete('/devices/:id', asyncHandler(async (req, res) => {
  const id = idOf(req.params.id);
  if (!id || !db.prepare('SELECT id FROM esphome_devices WHERE id = ?').get(id))
    return res.status(404).json({ error: 'Device not found.' });
  await deleteEsphomeDevice(id);
  res.json({ ok: true });
}));

router.get('/devices/:id/entities', (req, res) => {
  const id = idOf(req.params.id);
  if (!id || !db.prepare('SELECT id FROM esphome_devices WHERE id = ?').get(id))
    return res.status(404).json({ error: 'Device not found.' });
  res.json(getEsphomeEntities(id));
});

router.post('/test', asyncHandler(async (req, res) => {
  let target;
  if (req.body?.device_id !== undefined) {
    const id = idOf(req.body.device_id);
    const row = id && db.prepare('SELECT host, port, encryption_key FROM esphome_devices WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Device not found.' });
    target = { host: row.host, port: row.port, key: row.encryption_key };
  } else {
    try {
      const c = config({ ...req.body, name: 'Device' });
      target = { host: c.host, port: c.port, key: c.key };
    } catch (error) { return bad(res, safeConfigError(error)); }
  }
  const result = await testEsphomeDevice(target);
  if (result.busy) return res.status(409).json({ error: 'A connection test is already running.' });
  res.status(result.ok ? 200 : 400).json(result);
}));

router.get('/settings', (req, res) => {
  res.json({ retention_days: db.prepare("SELECT esphome_retention_days FROM settings WHERE id = 'app'").get()?.esphome_retention_days ?? 30 });
});
router.put('/settings', (req, res) => {
  const days = req.body?.retention_days;
  if (!Number.isInteger(days) || days < 1 || days > 365) return bad(res, 'Retention must be a whole number from 1 to 365 days.');
  db.prepare("UPDATE settings SET esphome_retention_days = ? WHERE id = 'app'").run(days);
  res.json({ retention_days: days });
});

const csvCell = (value) => {
  if (value == null) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
};
router.get('/export', asyncHandler(async (req, res) => {
  const id = idOf(req.query.device);
  if (!id || !db.prepare('SELECT id FROM esphome_devices WHERE id = ?').get(id))
    return res.status(404).json({ error: 'Device not found.' });
  const from = typeof req.query.from === 'string' ? Date.parse(req.query.from) : NaN;
  const to = typeof req.query.to === 'string' ? Date.parse(req.query.to) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 31 * 86400000)
    return bad(res, 'Enter valid from and to dates no more than 31 days apart.');
  res.type('text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="esphome-${id}.csv"`);
  res.write('minute_utc,device,entity,child,last,mean,min,max,n,nmiss\r\n');
  const rows = db.prepare(`SELECT r.bucket, e.name, e.object_id, e.child_id, r.last, r.mean, r.min, r.max, r.n, r.nmiss
    FROM esphome_readings r JOIN esphome_entities e ON e.id = r.entity_id
    WHERE e.device_id = ? AND r.bucket >= ? AND r.bucket < ? ORDER BY r.bucket, e.id`)
    .iterate(id, Math.floor(from / 60000), Math.ceil(to / 60000));
  for (const row of rows) {
    if (res.destroyed) break;
    const fields = [new Date(row.bucket * 60000).toISOString(), `#${id}`, row.name || row.object_id,
      row.child_id, row.last, row.mean, row.min, row.max, row.n, row.nmiss];
    if (!res.write(fields.map(csvCell).join(',') + '\r\n')) {
      await new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done); res.once('close', done);
      });
    }
  }
  res.end();
}));

export default router;
