import db from '../db.js';
import { logger } from './logger.js';
import { safeInterval, reportGuardFailure } from './processGuards.js';
import { openDevice, classifyEsphomeError } from './esphomeTransport.js';

const MAX_DEVICES = 8;
const MAX_ENTITIES = 200;
const MINUTE_MS = 60000;
// How long after a minute boundary the minute tick is aimed. A judgment, not a measurement: a few milliseconds keeps a
// timer that fires a little early (timers and the wall clock are separate clocks) from landing just before the boundary.
// One that still lands early flushes nothing and re-arms for the boundary a moment later (see armMinuteTick).
const TICK_SLACK_MS = 10;
const devices = new Map();
let samplerRunning = false;
let samplerTimer = null;
let pruneInterval = null;
let flushing = false;
let testBusy = false;
let pruning = false;
let stopPrune = false;

const insert = db.prepare(`INSERT OR IGNORE INTO esphome_readings
  (entity_id, bucket, last, mean, min, max, n, nmiss) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const zero = (bucket = null) => ({ bucket, n: 0, nmiss: 0, sum: 0, min: Infinity, max: -Infinity, last: null });
const minute = (now) => Math.floor(now / MINUTE_MS);

function changed(entry, state) {
  if (entry.state === state.state && entry.error_code === state.error_code && entry.encrypted === state.encrypted) return;
  const previous = entry.state;
  entry.state = state.state;
  entry.encrypted = state.encrypted;
  entry.error_code = state.error_code;
  entry.error = state.error;
  if (state.state !== 'connected') for (const item of entry.entities.values()) {
    item.aggregate = zero(); item.pending = null; item.value = null; item.updatedAt = null;
  }
  if (state.state === 'connected' && previous !== 'connected') {
    entry.bucket = minute(entry.clock());
    for (const item of entry.entities.values()) { item.aggregate = zero(entry.bucket); item.pending = null; }
  }
  logger.info(`[esphome] device #${entry.id} ${state.state}${state.error_code ? ` (${state.error_code})` : ''}`);
}

function acceptEntities(entry, discovered) {
  try {
    if (discovered.length > MAX_ENTITIES && !entry.capLogged) {
      entry.capLogged = true;
      logger.warn(`[esphome] device #${entry.id} entity limit reached`);
    }
    // #506 review (M2): the transport keeps the first entity with an object_id and flags a later one with another key.
    // Logged once per device (like the cap above) and without names: entity names are the user's own labels.
    if (!entry.duplicateLogged && discovered.slice(0, MAX_ENTITIES).some((e) => e.duplicate === true)) {
      entry.duplicateLogged = true;
      logger.warn(`[esphome] device #${entry.id} duplicate entity id ignored`);
    }
    const usable = discovered.slice(0, MAX_ENTITIES).filter((e) => !e.ignored);
    db.transaction(() => {
      const seen = new Set();
      for (const e of usable) {
        if (!e.object_id || seen.has(e.object_id)) continue;
        seen.add(e.object_id);
        const active = db.prepare('SELECT id, child_id, kind FROM esphome_entities WHERE device_id = ? AND object_id = ? AND active = 1')
          .get(entry.id, e.object_id);
        if (active && (active.child_id !== entry.child_id || active.kind !== e.kind)) {
          // A direct database edit or a firmware type change also starts a new history epoch.
          db.prepare('UPDATE esphome_entities SET active = 0 WHERE id = ?').run(active.id);
        }
        db.prepare(`INSERT INTO esphome_entities
          (device_id, object_id, child_id, kind, name, device_class, unit, state_class, entity_category, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(device_id, object_id) WHERE active = 1 DO UPDATE SET
            name=excluded.name, device_class=excluded.device_class, unit=excluded.unit,
            state_class=excluded.state_class, entity_category=excluded.entity_category,
            last_seen_at=datetime('now')`)
          .run(entry.id, e.object_id, entry.child_id, e.kind, e.name, e.device_class,
            e.unit, e.state_class, e.entity_category);
      }
      // Entity identity is scoped to a discovery epoch; retired rows keep their readings.
      for (const existing of db.prepare('SELECT id, object_id FROM esphome_entities WHERE device_id = ? AND active = 1').all(entry.id)) {
        if (!seen.has(existing.object_id)) db.prepare('UPDATE esphome_entities SET active = 0 WHERE id = ?').run(existing.id);
      }
    })();
    entry.entities.clear();
    for (const row of db.prepare('SELECT id, object_id, kind FROM esphome_entities WHERE device_id = ? AND active = 1').all(entry.id)) {
      entry.entities.set(row.object_id, { ...row, aggregate: zero(entry.bucket), pending: null,
        value: null, updatedAt: null });
    }
  } catch {
    changed(entry, { state: 'failed', encrypted: false, error_code: 'OTHER', error: 'Could not talk to the device.' });
  }
}

function acceptState(entry, state, now = Date.now()) {
  try {
    if (entry.state !== 'connected') return;
    const item = entry.entities.get(state.objectId);
    if (!item || item.kind !== state.kind) return;
    const bucket = minute(now);
    if (bucket < entry.bucket) return;
    if (item.aggregate.bucket !== bucket) {
      // Keep one ended bucket until the timer writes it. This boundary costs O(1) per update.
      // A long event-loop stall may leave a gap; it never fabricates a numeric value.
      // Accepted limit (#506 review, L2): `pending` and the in-progress `aggregate` live only in memory. A disconnect, an
      // edit of the device or a server restart discards both, so up to about two minutes around a disconnect or restart
      // are not recorded (docs/esphome.md says so). Writing them early would need a partial-minute row, which `n` and
      // `nmiss` cannot describe.
      item.pending = item.aggregate.bucket >= entry.bucket
        ? { ...item.aggregate, carry: item.value } : null;
      item.aggregate = zero(bucket);
    }
    const a = item.aggregate;
    if (state.missing || !Number.isFinite(state.value)) { a.nmiss++; return; }
    const value = state.kind === 'binary_sensor' ? (state.value ? 1 : 0) : state.value;
    a.n++; a.sum += value; a.min = Math.min(a.min, value); a.max = Math.max(a.max, value);
    a.last = value; item.value = value; item.updatedAt = now;
  } catch { /* per-frame work cannot escape into a device callback */ }
}

// One transaction per ended minute; a restart cannot double a row because the key is (entity, bucket).
export function flushEsphomeMinute(now = Date.now()) {
  if (flushing) return;
  flushing = true;
  try {
    const current = minute(now);
    const ended = [];
    db.transaction(() => {
      for (const entry of devices.values()) {
        if (entry.state !== 'connected' || entry.bucket == null || entry.bucket >= current) continue;
        if (current - entry.bucket > 1) {
          // A stalled event loop cannot prove coverage for skipped minutes. Leave gaps and
          // keep this one transaction bounded instead of backfilling hours of stale values.
          for (const item of entry.entities.values()) {
            item.pending = null;
            if (item.aggregate.bucket < current) item.aggregate = zero(current);
          }
          entry.bucket = current;
          continue;
        }
        for (let bucket = entry.bucket; bucket < current; bucket++) {
          for (const item of entry.entities.values()) {
            const a = item.pending?.bucket === bucket ? item.pending
              : item.aggregate.bucket === bucket ? item.aggregate : zero(bucket);
            if (a.n) insert.run(item.id, bucket, a.last, a.sum / a.n, a.min, a.max, a.n, a.nmiss);
            else if (item.kind === 'sensor' && a.nmiss) insert.run(item.id, bucket, null, null, null, null, 0, a.nmiss);
            else if (item.kind === 'binary_sensor') {
              // A state received just AFTER the boundary cannot rewrite the prior minute's carry.
              const carried = item.pending?.bucket === bucket ? item.pending.carry
                : item.aggregate.bucket > bucket ? null : item.value;
              // #506 review (M1): the minute's missing updates are kept on the binary row too. The first version wrote
              // the carry with nmiss 0, and wrote nothing at all for a missing-only minute with no earlier value, so a
              // binary sensor's missing flags were never stored. A missing flag does not clear the carried value.
              if (carried !== null) insert.run(item.id, bucket, carried, carried, carried, carried, 0, a.nmiss);
              else if (a.nmiss) insert.run(item.id, bucket, null, null, null, null, 0, a.nmiss);
            }
          }
        }
        ended.push(entry);
      }
    })();
    // Only discard the in-memory minute after the one database transaction commits.
    for (const entry of ended) {
      for (const item of entry.entities.values()) {
        if (item.pending?.bucket < current) item.pending = null;
        if (item.aggregate.bucket < current) item.aggregate = zero(current);
      }
      entry.bucket = current;
    }
  } catch { /* the next tick can retry the unchanged in-memory aggregates */ }
  finally { flushing = false; }
}

function attemptOpen(entry, row, open, clock, retryMs) {
  entry.abort = new AbortController();
  const timeout = setTimeout(() => entry.abort.abort(), 30000);
  void Promise.resolve().then(() => open({ host: row.host, port: row.port, key: row.encryption_key }, {
    signal: entry.abort.signal,
    onEntities: (entities) => { if (devices.get(row.id) === entry) acceptEntities(entry, entities); },
    onState: (state) => { if (devices.get(row.id) === entry) acceptState(entry, state, clock()); },
    onConnection: (status) => { if (devices.get(row.id) === entry) changed(entry, status); },
  })).then((handle) => {
    clearTimeout(timeout);
    if (devices.get(row.id) === entry) entry.handle = handle;
    else handle.close();
  }).catch((error) => {
    clearTimeout(timeout);
    if (devices.get(row.id) !== entry) return;
    const safe = classifyEsphomeError(error);
    changed(entry, { state: 'failed', encrypted: false, error_code: safe.code, error: safe.message });
    if (!['KEY_INVALID', 'KEY_WRONG', 'KEY_NEEDED', 'NOT_ENCRYPTED'].includes(safe.code) &&
        error?.name !== 'NegotiationFailedError') {
      // The library can reconnect only after it has returned a client. A failed first open
      // has no client to supervise, so retry transient failures quietly with the same config.
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        if (devices.get(row.id) === entry) attemptOpen(entry, row, open, clock, retryMs);
      }, retryMs);
      entry.retryTimer.unref?.();
    }
  });
}

function startOne(row, open = openDevice, clock = Date.now, retryMs = 30000) {
  const entry = { id: row.id, child_id: row.child_id, state: 'connecting', encrypted: false,
    error_code: null, error: null, entities: new Map(), bucket: minute(clock()), clock, handle: null,
    abort: null, retryTimer: null,
    config: JSON.stringify([row.host, row.port, row.encryption_key, row.child_id]) };
  devices.set(row.id, entry);
  logger.info(`[esphome] device #${row.id} connecting`);
  attemptOpen(entry, row, open, clock, retryMs);
}

function closeEntry(entry) {
  try { entry.abort?.abort(); } catch { /* continue closing other devices */ }
  clearTimeout(entry.retryTimer);
  try { entry.handle?.close(); } catch { /* shutdown must stay synchronous and continue */ }
}

export function refreshEsphome({ open = openDevice, clock = Date.now, retryMs = 30000 } = {}) {
  try {
    const rows = db.prepare('SELECT * FROM esphome_devices WHERE enabled = 1 ORDER BY id LIMIT ?').all(MAX_DEVICES);
    const wanted = new Set(rows.map((r) => r.id));
    for (const [id, entry] of devices) if (!wanted.has(id)) {
      closeEntry(entry); devices.delete(id);
    }
    for (const row of rows) {
      const config = JSON.stringify([row.host, row.port, row.encryption_key, row.child_id]);
      const old = devices.get(row.id);
      if (old?.config === config) continue;
      if (old) { closeEntry(old); devices.delete(row.id); }
      startOne(row, open, clock, retryMs);
    }
  } catch { /* a bad stored row must not fail boot or another integration */ }
}

export function stopEsphome() {
  for (const entry of devices.values()) closeEntry(entry);
  devices.clear();
}

// A child purge deletes entity IDs from SQLite. Close the matching live clients before a
// later minute tick can write those IDs again, then discover new unassigned entity IDs.
export function reconcileEsphomeChildDeletion(childId, options = {}) {
  let changedAny = false;
  for (const [id, entry] of devices) if (entry.child_id === childId) {
    closeEntry(entry);
    devices.delete(id);
    changedAny = true;
  }
  if (changedAny) refreshEsphome(options);
}

// Milliseconds from `now` to just after the next minute boundary. Pure, so the timer arithmetic is testable.
export function msToNextMinute(now) {
  return MINUTE_MS - (now % MINUTE_MS) + TICK_SLACK_MS;
}

// #506 review (L1): the minute tick re-aims at the next boundary from the clock every time. The first version was a
// setInterval(60000), which drifts later by the time each tick takes; once the drift passed a minute, one tick saw two
// ended minutes, and the stall rule in flushEsphomeMinute (current - bucket > 1) dropped both without a word. A tick that
// runs late now re-arms for the NEXT boundary, not for 60 s after itself.
function armMinuteTick(clock) {
  samplerTimer = setTimeout(() => {
    samplerTimer = null;
    // flushEsphomeMinute catches its own errors; this catch is what keeps any future throw from ending the loop.
    try { flushEsphomeMinute(clock()); } catch (err) { reportGuardFailure('esphome-minute', err); }
    if (samplerRunning) armMinuteTick(clock);
  }, msToNextMinute(clock()));
}

// `clock` is a test seam only; the server calls this with no arguments.
export function startEsphomeSampler({ clock = Date.now } = {}) {
  if (samplerRunning) return;
  samplerRunning = true;
  stopPrune = false;
  armMinuteTick(clock);
  // #506: retention is independent of the minute writer and runs in bounded batches.
  pruneInterval = safeInterval('esphome-prune', 24 * 60 * MINUTE_MS, () => pruneEsphome());
  void pruneEsphome(clock());
}

export function stopEsphomeSampler() {
  samplerRunning = false;
  stopPrune = true;
  clearTimeout(samplerTimer);
  clearInterval(pruneInterval);
  samplerTimer = null; pruneInterval = null;
}

export function esphomeStatus() {
  const now = minute(Date.now());
  return db.prepare('SELECT id, enabled FROM esphome_devices ORDER BY id').all().map((row) => {
    const live = devices.get(row.id);
    // #506 review (L7): one primary-key lookup, MAX(bucket) for (entity_id), per entity of the device (retired ones
    // included, as before). The first version walked the whole `bucket` index newest first, so a device with no rows
    // read every other device's history on each status call.
    const last = db.prepare(`SELECT MAX((SELECT MAX(r.bucket) FROM esphome_readings r WHERE r.entity_id = e.id)) AS bucket
      FROM esphome_entities e WHERE e.device_id = ?`).get(row.id);
    const recent = db.prepare(`SELECT COUNT(*) AS n FROM esphome_readings r
      JOIN esphome_entities e ON e.id = r.entity_id WHERE r.bucket >= ? AND e.device_id = ?`).get(now - 60, row.id);
    return { id: row.id, enabled: !!row.enabled, state: live?.state || 'disabled',
      encrypted: live?.encrypted === true, error_code: live?.error_code || null, error: live?.error || null,
      entity_count: db.prepare('SELECT COUNT(*) AS n FROM esphome_entities WHERE device_id = ? AND active = 1').get(row.id).n,
      last_row_at: last?.bucket == null ? null : new Date(last.bucket * MINUTE_MS).toISOString(),
      rows_last_hour: recent.n, coverage: { rows_last_hour: recent.n } };
  });
}

export function guessEsphomeCategory(entity) {
  const cls = String(entity.device_class || '').toLowerCase();
  if (['occupancy', 'illuminance', 'distance', 'temperature', 'humidity'].includes(cls)) return cls;
  const name = `${entity.name || ''} ${entity.object_id || ''}`.toLowerCase();
  if (/heart.?rate/.test(name)) return 'heart_rate';
  if (/(respirat\w*|breath).?rate/.test(name)) return 'respiratory_rate';
  if (/target.?number|num.?targets/.test(name)) return 'target_number';
  return null;
}

export function getEsphomeEntities(deviceId) {
  const live = devices.get(Number(deviceId));
  const now = Date.now();
  return db.prepare('SELECT id, object_id, child_id, kind, name, device_class, unit, state_class, entity_category FROM esphome_entities WHERE device_id = ? AND active = 1 ORDER BY id').all(deviceId)
    .map((e) => { const v = live?.entities.get(e.object_id); return { ...e, category: guessEsphomeCategory(e),
      value: v?.value ?? null, age_s: v?.updatedAt == null ? null : Math.floor((now - v.updatedAt) / 1000) }; });
}

export async function testEsphomeDevice(config, { signal, open = openDevice } = {}) {
  if (testBusy) return { busy: true };
  testBusy = true;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 10000);
  let handle;
  try {
    handle = await open(config, { signal: controller.signal });
    return { ok: true, encrypted: handle.encrypted, entities: handle.entities };
  } catch (error) {
    const safe = classifyEsphomeError(error);
    return { ok: false, error_code: safe.code, error: safe.message };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort); handle?.close(); testBusy = false;
  }
}

// Bounded delete batches keep a large 30-day history from pinning the SQLite writer for one long statement.
export async function deleteEsphomeDevice(deviceId) {
  const entry = devices.get(deviceId);
  if (entry) { closeEntry(entry); devices.delete(deviceId); }
  const nextBucket = db.prepare(`SELECT MIN(r.bucket) AS bucket FROM esphome_readings r
    JOIN esphome_entities e ON e.id = r.entity_id WHERE e.device_id = ? AND r.bucket >= ?`);
  const remove = db.prepare(`DELETE FROM esphome_readings WHERE (entity_id, bucket) IN
    (SELECT r.entity_id, r.bucket FROM esphome_readings r JOIN esphome_entities e ON e.id = r.entity_id
     WHERE e.device_id = ? AND r.bucket >= ? AND r.bucket < ? LIMIT 1000)`);
  let bucket = nextBucket.get(deviceId, -Number.MAX_SAFE_INTEGER).bucket;
  while (bucket != null) {
    const end = bucket + 60;
    while (remove.run(deviceId, bucket, end).changes) await new Promise((resolve) => setImmediate(resolve));
    bucket = nextBucket.get(deviceId, end).bucket;
  }
  db.transaction(() => {
    db.prepare('DELETE FROM esphome_entities WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM esphome_devices WHERE id = ?').run(deviceId);
  })();
  refreshEsphome();
}

export async function pruneEsphome(now = Date.now()) {
  if (pruning) return;
  pruning = true;
  try {
    const days = db.prepare("SELECT esphome_retention_days AS days FROM settings WHERE id = 'app'").get()?.days || 30;
    const cutoff = minute(now) - days * 1440;
    const nextBucket = db.prepare('SELECT MIN(bucket) AS bucket FROM esphome_readings WHERE bucket >= ? AND bucket < ?');
    const remove = db.prepare(`DELETE FROM esphome_readings WHERE (entity_id, bucket) IN
      (SELECT entity_id, bucket FROM esphome_readings WHERE bucket >= ? AND bucket < ? LIMIT 1000)`);
    let bucket = nextBucket.get(-Number.MAX_SAFE_INTEGER, cutoff).bucket;
    while (!stopPrune && bucket != null) {
      const end = Math.min(bucket + 60, cutoff);
      while (!stopPrune && remove.run(bucket, end).changes) await new Promise((resolve) => setImmediate(resolve));
      bucket = nextBucket.get(end, cutoff).bucket;
    }
    if (!stopPrune) db.prepare('DELETE FROM esphome_entities WHERE active = 0 AND NOT EXISTS (SELECT 1 FROM esphome_readings WHERE entity_id = esphome_entities.id)').run();
  } catch { /* retry at the next daily pass */ }
  finally { pruning = false; }
}
