import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken,
  mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { computeAndStoreNight, lastCompletedNightDate } = await import('../src/lib/sleepAnalysis.js');
const { rewritePastNights: rewriteRaw, undoRewrite, latestRewrite } = await import('../src/lib/sleepRewrite.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');
const { demoGuard } = await import('../src/middleware/demoMode.js');
const { purgeChild, purgeCamera } = await import('../src/lib/entityPurge.js');

const CHILD = 'rewrite-child';
const CAM = 'rewrite-camera';
const DATE = '2026-07-01';
const sql = (date) => date.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const at = (h, m, day = 0) => new Date(Date.UTC(2026, 6, 1 + day, h - 10, m));
const rows = () => db.prepare('SELECT * FROM sleep_nights ORDER BY id').all();
const backups = () => db.prepare('SELECT * FROM sleep_night_rewrites ORDER BY batch_id').all();
function rewritePastNights(options = {}) {
  if (options.apply === true && options.expect === undefined) {
    return rewriteRaw({ ...options, expect: rewriteRaw({ apply: false }).preview });
  }
  return rewriteRaw(options);
}
let server;
let adminToken;
let careToken;

function samples() {
  const insert = db.prepare(`INSERT INTO activity_samples
    (camera_id, bucket_start, motion_level, motion_peak, sound_level, sound_peak, motion_frames, sound_windows)
    VALUES (?, ?, ?, ?, 0, 0, 1, 0)`);
  // The 3 h look-behind must survive pruning, even though the scoring window itself starts later.
  insert.run(CAM, sql(at(16, 30)), 0.004, 0.004);
  for (let t = at(18, 20); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    const moving = (t >= at(19, 30) && t < at(19, 40)) || (t >= at(6, 0, 1) && t < at(6, 20, 1));
    insert.run(CAM, sql(t), moving ? 0.4 : 0.004, moving ? 0.4 : 0.004);
  }
}
function stored() {
  samples();
  const result = computeAndStoreNight(CHILD, DATE);
  assert.equal(result.status, 'ok');
  return rows()[0];
}
function stale() {
  const original = stored();
  db.prepare(`UPDATE sleep_nights SET onset_at = '2026-07-01 06:56:00',
    asleep_minutes = 1, notified_at = '2026-07-02 00:00:00',
    avg_temperature = 21, avg_humidity = 42, wake_at_sensor = '2026-07-01 20:00:00', sensor_rejects = 3
    WHERE child_id = ?`).run(CHILD);
  return { original, before: rows()[0] };
}
function applyChecked(options = {}) {
  const preview = rewritePastNights({ apply: false });
  return rewritePastNights({ apply: true, expect: preview.preview, ...options });
}

before(async () => {
  db.prepare("UPDATE settings SET timezone = 'Australia/Melbourne', classify_alert_audio = 0 WHERE id = 'app'").run();
  const admin = makeUser(db, { id: 'rewrite-admin', username: 'rewrite-admin' });
  const care = makeUser(db, { id: 'rewrite-care', username: 'rewrite-care', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: admin.username });
  careToken = signToken({ id: care.id, sid: makeSession(db, care.id), role: 'caregiver', username: care.username });
  server = await mountRouter('/api/settings', settingsRouter, { middleware: [demoGuard] });
});
beforeEach(() => {
  db.prepare('DELETE FROM sleep_night_rewrites').run();
  db.prepare('DELETE FROM sleep_reviews').run();
  db.prepare('DELETE FROM sleep_nights').run();
  db.prepare('DELETE FROM activity_samples').run();
  db.prepare('DELETE FROM detection_events').run();
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  db.prepare("UPDATE settings SET classify_alert_audio = 0 WHERE id = 'app'").run();
  db.prepare("INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end) VALUES (?, 'A child', 1, '19:30', '07:00')").run(CHILD);
  db.prepare("INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled) VALUES (?, 'A camera', 'rtsp://example/x', ?, 'rewrite', 0, 0)").run(CAM, CHILD);
});
after(async () => { await server.close(); db.close(); cleanupTempDataDirs(); });

test('preview rolls back every row and exactly predicts the apply; evidence and notification ledger survive', () => {
  const { before } = stale();
  const preview = rewritePastNights({ apply: false, userId: 'rewrite-admin' });
  assert.deepEqual(rows(), [before]);
  assert.deepEqual(backups(), []);
  assert.equal(preview.changed, 1);
  const applied = rewritePastNights({ apply: true, expect: preview.preview, userId: 'rewrite-admin' });
  assert.deepEqual(applied, preview);
  const after = rows()[0];
  assert.notEqual(after.onset_at, before.onset_at);
  for (const name of ['notified_at', 'notified_wake_at', 'avg_temperature', 'avg_humidity', 'wake_at_sensor', 'sensor_rejects']) {
    assert.equal(after[name], before[name], name);
  }
  assert.equal(backups().length, 1);
  assert.deepEqual(JSON.parse(backups()[0].before_json), before);
  assert.deepEqual(JSON.parse(backups()[0].after_json), after);
});

test('unchanged night stays byte-identical with no backup', () => {
  stored();
  db.prepare("UPDATE sleep_nights SET computed_at = '2026-07-02 03:00:00' WHERE child_id = ?").run(CHILD);
  const before = rows()[0];
  const result = applyChecked();
  assert.equal(result.children[0].unchanged, 1);
  assert.deepEqual(rows(), [before]);
  assert.deepEqual(backups(), []);
});

test('every compared column changes the verdict, including facts only', () => {
  const original = stored();
  const exclude = new Set(['id', 'child_id', 'night_date', 'computed_at', 'scoring_context',
    'notified_at', 'notified_wake_at', 'avg_temperature', 'avg_humidity', 'wake_at_sensor', 'sensor_rejects']);
  const compared = db.prepare('PRAGMA table_info(sleep_nights)').all().map((c) => c.name).filter((n) => !exclude.has(n));
  for (const name of compared) {
    const marker = typeof original[name] === 'number' ? original[name] + 1
      : name === 'window_start' ? '2026-07-01 10:00:00'
        : name === 'window_end' ? '2026-07-01 20:00:00'
          : name === 'status' ? 'empty'
          : `${original[name] ?? ''}marker`;
    db.prepare(`UPDATE sleep_nights SET "${name}" = ? WHERE child_id = ?`).run(marker, CHILD);
    const preview = rewritePastNights({ apply: false });
    assert.equal(preview.changed, 1, name);
    if (name === 'summary_facts') {
      assert.equal(preview.facts_only, 1);
      assert.equal(preview.figures_changed, 0);
    }
    assert.deepEqual(rows()[0][name], marker);
    db.prepare(`UPDATE sleep_nights SET "${name}" = ? WHERE child_id = ?`).run(original[name], CHILD);
  }
});

test('corrected, answered and dismissed reviews all protect the exact stored row', () => {
  const { before } = stale();
  for (const values of [
    { dismissed: 1 },
    { answered_by_user_id: 'rewrite-admin' },
    { true_onset_at: '2026-07-01 10:00:00' },
  ]) {
    const names = Object.keys(values);
    db.prepare(`INSERT INTO sleep_reviews (child_id, night_date, ${names.join(', ')})
      VALUES (?, ?, ${names.map(() => '?').join(', ')})`).run(CHILD, DATE, ...Object.values(values));
    assert.equal(rewritePastNights({ apply: true }).children[0].skipped.has_review, 1);
    assert.deepEqual(rows(), [before]);
    assert.deepEqual(backups(), []);
    db.prepare('DELETE FROM sleep_reviews').run();
  }
});

test('tracking off skips before computing', () => {
  stale();
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
  assert.equal(rewritePastNights({ apply: true }).children[0].skipped.tracking_off, 1);
});

test('partial minute data skips even with most window minutes present', () => {
  stale();
  db.prepare('DELETE FROM activity_samples WHERE bucket_start < ?').run(sql(at(21, 0)));
  assert.equal(rewritePastNights({ apply: true }).children[0].skipped.partial_data, 1);
});

test('legacy settings, missing camera, lost score and missing alert history have distinct skips', () => {
  stale();
  db.prepare('UPDATE sleep_nights SET scoring_context = NULL WHERE child_id = ?').run(CHILD);
  assert.equal(rewritePastNights({ apply: true }).children[0].skipped.no_saved_settings, 1);
  const context = JSON.stringify({ v: 1, camera_id: CAM, tz: 'Australia/Melbourne',
    window: { start: '19:30', end: '07:00' }, algo: 'older' });
  db.prepare('UPDATE sleep_nights SET scoring_context = ? WHERE child_id = ?').run(context, CHILD);
  purgeCamera(CAM);
  assert.equal(applyChecked().children[0].skipped.stored_camera_missing, 1);
  db.prepare("INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path) VALUES (?, 'A camera', 'rtsp://example/x', ?, 'rewrite')").run(CAM, CHILD);
  samples();
  db.prepare('UPDATE activity_samples SET motion_frames = 0 WHERE camera_id = ?').run(CAM);
  assert.equal(rewritePastNights({ apply: true }).children[0].skipped.would_downgrade, 1);
  db.prepare('UPDATE activity_samples SET motion_frames = 1 WHERE camera_id = ?').run(CAM);
  db.prepare("UPDATE settings SET classify_alert_audio = 1 WHERE id = 'app'").run();
  assert.equal(rewritePastNights({ apply: true }).children[0].skipped.partial_data, 1);
});

test('an old early write is replayed while the last completed provisional night belongs to the job', () => {
  stale();
  db.prepare("UPDATE sleep_nights SET computed_at = '2026-07-01 10:00:00' WHERE child_id = ?").run(CHILD);
  assert.equal(rewritePastNights({ apply: true }).changed, 1);
  const currentLast = db.prepare('SELECT night_date FROM sleep_nights WHERE child_id = ?').get(CHILD);
  const last = lastCompletedNightDate(CHILD);
  db.prepare("UPDATE sleep_nights SET night_date = ?, computed_at = '2026-07-01 10:00:00', onset_at = '2026-07-01 06:56:00' WHERE child_id = ?")
    .run(last, CHILD);
  assert.equal(rewritePastNights({ apply: true }).children[0].skipped.owned_by_nightly_job, 1);
  assert.notEqual(currentLast.night_date, last);
});

test('earlier stored nights are rewritten before a later night reads their wake history', () => {
  const { original } = stale();
  db.prepare(`INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak,
    sound_level, sound_peak, motion_frames, sound_windows)
    SELECT camera_id, datetime(bucket_start, '+1 day'), motion_level, motion_peak,
      sound_level, sound_peak, motion_frames, sound_windows FROM activity_samples`).run();
  db.prepare(`INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status,
    onset_at, asleep_minutes, scoring_context, computed_at)
    VALUES (?, '2026-07-02', '2026-07-02 09:30:00', '2026-07-02 21:00:00', 'ok',
      '2026-07-02 06:56:00', 1, ?, '2026-07-03 00:00:00')`).run(CHILD, rows()[0].scoring_context);
  // #700's later-night history query reads the stored predecessor. If the loop is reversed,
  // this trigger makes the later save fail while that predecessor still has its stale figure.
  db.exec(`CREATE TRIGGER require_earlier_rewrite BEFORE UPDATE ON sleep_nights
    WHEN NEW.night_date = '2026-07-02'
      AND (SELECT asleep_minutes FROM sleep_nights WHERE child_id = '${CHILD}' AND night_date = '${DATE}') = 1
    BEGIN SELECT RAISE(ABORT, 'earlier night not rewritten'); END`);
  try {
    const result = rewritePastNights({ apply: true });
    assert.equal(result.changed, 2);
    assert.equal(result.children[0].skipped.error, undefined);
    assert.equal(rows()[0].asleep_minutes, original.asleep_minutes);
  } finally { db.exec('DROP TRIGGER require_earlier_rewrite'); }
});

test('a night that would become empty is left unchanged', () => {
  const { before } = stale();
  db.prepare('UPDATE activity_samples SET motion_level = 0, motion_peak = 0 WHERE camera_id = ?').run(CAM);
  const result = rewritePastNights({ apply: true });
  assert.equal(result.children[0].skipped.would_become_empty, 1);
  assert.deepEqual(rows(), [before]);
});

test('a notified wake is never blanked by a replay', () => {
  stale();
  db.prepare("UPDATE sleep_nights SET notified_wake_at = '2026-07-01 20:00:00' WHERE child_id = ?").run(CHILD);
  db.prepare('UPDATE activity_samples SET motion_level = 0.004, motion_peak = 0.004 WHERE bucket_start >= ?')
    .run(sql(at(6, 0, 1)));
  const before = rows()[0];
  const result = rewritePastNights({ apply: true });
  assert.equal(result.children[0].skipped.would_blank_notified_wake, 1, JSON.stringify(result));
  assert.deepEqual(rows(), [before]);
});

test('a per-night SQL failure rolls back that night, and the flag clears for the next run', () => {
  const { before } = stale();
  db.function('reject_rewrite', () => { throw new Error('injected failure'); });
  db.exec(`CREATE TRIGGER reject_rewrite_once BEFORE UPDATE ON sleep_nights
    WHEN NEW.asleep_minutes <> OLD.asleep_minutes BEGIN SELECT reject_rewrite(); END`);
  try {
    const result = rewritePastNights({ apply: true });
    assert.equal(result.children[0].skipped.error, 1);
    assert.deepEqual(rows(), [before]);
    assert.deepEqual(backups(), []);
  } finally { db.exec('DROP TRIGGER reject_rewrite_once'); }
  assert.equal(rewritePastNights({ apply: true }).changed, 1);
});

test('a second run during the write is refused with a 409 reason', () => {
  stale();
  let refusal;
  db.function('try_rewrite_again', () => {
    try { rewritePastNights({ apply: true }); }
    catch (error) { refusal = error; }
    return 1;
  });
  db.exec(`CREATE TRIGGER reenter_rewrite BEFORE UPDATE ON sleep_nights
    WHEN NEW.asleep_minutes <> OLD.asleep_minutes BEGIN SELECT try_rewrite_again(); END`);
  try { assert.equal(rewritePastNights({ apply: true }).changed, 1); }
  finally { db.exec('DROP TRIGGER reenter_rewrite'); }
  assert.equal(refusal.status, 409);
  assert.equal(refusal.reason, 'in_progress');
});

test('a review added after an update blocks undo, and deleting a child removes its backups', () => {
  stale();
  rewritePastNights({ apply: true });
  const batch = latestRewrite().batch_id;
  db.prepare('INSERT INTO sleep_reviews (child_id, night_date, dismissed) VALUES (?, ?, 1)').run(CHILD, DATE);
  assert.equal(undoRewrite({ batchId: batch }).skipped.corrected_since, 1);
  purgeChild(CHILD);
  assert.deepEqual(backups(), []);
});

test('undo restores every field except notification ledger and refuses a same-minute re-save', () => {
  const { before } = stale();
  rewritePastNights({ apply: true });
  const batch = latestRewrite().batch_id;
  db.prepare("UPDATE sleep_nights SET notified_at = '2026-07-03 00:00:00' WHERE child_id = ?").run(CHILD);
  assert.equal(undoRewrite({ batchId: batch }).restored, 1);
  assert.deepEqual({ ...rows()[0], notified_at: before.notified_at }, before);
  stale();
  rewritePastNights({ apply: true });
  const second = latestRewrite().batch_id;
  db.prepare("UPDATE sleep_nights SET asleep_minutes = asleep_minutes + 1 WHERE child_id = ?").run(CHILD);
  assert.equal(undoRewrite({ batchId: second }).skipped.saved_again_since, 1);
});

test('undo restores marker values in every schema column it owns', () => {
  stale();
  const original = rows()[0];
  const columns = db.prepare('PRAGMA table_info(sleep_nights)').all().map(({ name }) => name);
  for (const name of columns) {
    if (['id', 'child_id', 'night_date', 'notified_at', 'notified_wake_at'].includes(name)) continue;
    let marker = typeof original[name] === 'number' ? original[name] + 1 : `${original[name] ?? ''}marker`;
    if (name === 'window_start') marker = '2026-07-01 10:00:00';
    if (name === 'window_end') marker = '2026-07-01 20:00:00';
    if (name === 'status') marker = 'empty';
    if (name === 'computed_at') marker = '2026-07-01 10:00:00';
    if (name === 'scoring_context') marker = JSON.stringify({ ...JSON.parse(original.scoring_context), algo: 'marker' });
    db.prepare(`UPDATE sleep_nights SET "${name}" = ? WHERE child_id = ?`).run(marker, CHILD);
  }
  const before = rows()[0];
  assert.equal(rewritePastNights({ apply: true }).changed, 1);
  const batch = latestRewrite().batch_id;
  db.prepare("UPDATE sleep_nights SET notified_at = '2026-07-04 00:00:00' WHERE child_id = ?").run(CHILD);
  assert.equal(undoRewrite({ batchId: batch }).restored, 1);
  const restored = rows()[0];
  for (const name of columns) {
    if (name.startsWith('notified_')) continue;
    assert.deepEqual(restored[name], before[name], name);
  }
  assert.equal(restored.notified_at, '2026-07-04 00:00:00');
});

test('a stale preview returns 409 and writes nothing', async () => {
  stale();
  const preview = rewritePastNights({ apply: false });
  db.prepare('UPDATE sleep_nights SET awake_minutes = awake_minutes + 1 WHERE child_id = ?').run(CHILD);
  const before = rows();
  const res = await call(`${server.url}/api/settings/sleep-rewrite`, { method: 'POST', token: adminToken,
    body: { apply: true, expect: preview.preview } });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'changed_since_preview');
  assert.deepEqual(rows(), before);
  assert.deepEqual(backups(), []);
});

test('apply requires a valid check hash through both HTTP and the module', async () => {
  stale();
  const before = rows();
  for (const expect of [undefined, 'invalid']) {
    assert.throws(() => rewriteRaw({ apply: true, expect }), { status: 400, reason: 'preview_required' });
    const res = await call(`${server.url}/api/settings/sleep-rewrite`, { method: 'POST', token: adminToken,
      body: { apply: true, ...(expect === undefined ? {} : { expect }) } });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, 'preview_required');
    assert.equal(res.body.error, 'Check what would change first, then update.');
  }
  assert.deepEqual(rows(), before);
  assert.deepEqual(backups(), []);
});

test('a review on an unchanged candidate invalidates the preview without writing', () => {
  stored();
  const preview = rewriteRaw({ apply: false });
  assert.equal(preview.children[0].unchanged, 1);
  db.prepare('INSERT INTO sleep_reviews (child_id, night_date, dismissed) VALUES (?, ?, 1)').run(CHILD, DATE);
  const before = rows();
  assert.throws(() => rewriteRaw({ apply: true, expect: preview.preview }), { reason: 'changed_since_preview' });
  assert.deepEqual(rows(), before);
  assert.deepEqual(backups(), []);
});

test('the three-hour look-behind needs its first sample at or before the boundary', () => {
  stale();
  db.prepare('DELETE FROM activity_samples WHERE bucket_start < ?').run(sql(at(18, 20)));
  const insert = db.prepare(`INSERT INTO activity_samples
    (camera_id, bucket_start, motion_level, motion_peak, sound_level, sound_peak, motion_frames, sound_windows)
    VALUES (?, ?, 0.004, 0.004, 0, 0, 1, 0)`);
  insert.run(CAM, sql(at(16, 29)));
  assert.equal(rewriteRaw({ apply: false }).changed, 1);
  db.prepare('DELETE FROM activity_samples WHERE bucket_start = ?').run(sql(at(16, 29)));
  insert.run(CAM, sql(at(16, 31)));
  const before = rows();
  assert.equal(rewriteRaw({ apply: false }).children[0].skipped.partial_data, 1);
  assert.deepEqual(rows(), before);
});

test('an in-progress old night remains owned by the nightly job', () => {
  stale();
  // A manual early save can exist outside the last completed date; the live end still belongs to the job.
  db.prepare("UPDATE sleep_nights SET window_end = datetime('now', '+1 hour') WHERE child_id = ?").run(CHILD);
  const before = rows();
  assert.equal(rewriteRaw({ apply: false }).children[0].skipped.owned_by_nightly_job, 1);
  assert.deepEqual(rows(), before);
});

test('an empty stored night can be replayed without the would-become-empty guard', () => {
  stored();
  db.prepare("UPDATE sleep_nights SET status = 'empty', asleep_minutes = 1 WHERE child_id = ?").run(CHILD);
  db.prepare('UPDATE activity_samples SET motion_level = 0, motion_peak = 0 WHERE camera_id = ?').run(CAM);
  const check = rewriteRaw({ apply: false });
  assert.equal(check.children[0].skipped.would_become_empty, undefined);
  assert.equal(check.changed + check.children[0].unchanged, 1);
});

test('protected clips cannot stand in for deleted ordinary alert history', () => {
  db.prepare("UPDATE settings SET classify_alert_audio = 1 WHERE id = 'app'").run();
  db.prepare(`INSERT INTO detection_events (camera_id, camera_name, type, audio_label, created_at)
    VALUES (?, 'A camera', 'sound', 'cry', ?)`).run(CAM, sql(at(16, 0)));
  stored();
  db.prepare('DELETE FROM detection_events WHERE protected = 0').run();
  db.prepare(`INSERT INTO detection_events (camera_id, camera_name, type, protected, created_at)
    VALUES (?, 'A camera', 'sound', 1, ?)`).run(CAM, '2026-06-01 00:00:00');
  const before = rows();
  const check = rewriteRaw({ apply: false });
  assert.equal(check.children[0].skipped.partial_data, 1);
  assert.deepEqual(rows(), before);
  assert.deepEqual(backups(), []);
});

test('replay retains the saved room climate after another sensor camera is assigned', () => {
  samples();
  db.prepare('INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, 20, 40, ?)')
    .run(CAM, sql(at(20, 0)));
  assert.equal(computeAndStoreNight(CHILD, DATE).status, 'ok');
  const original = rows()[0];
  db.prepare("INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path) VALUES ('other-camera', 'Other camera', 'rtsp://example/y', ?, 'other')").run(CHILD);
  db.prepare('INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, 30, 80, ?)')
    .run('other-camera', sql(at(20, 0)));
  db.prepare('UPDATE sleep_nights SET asleep_minutes = 1 WHERE child_id = ?').run(CHILD);
  const before = rows()[0];
  assert.equal(applyChecked().changed, 1);
  const after = rows()[0];
  assert.equal(after.avg_temperature, original.avg_temperature);
  assert.equal(after.avg_humidity, original.avg_humidity);
  assert.deepEqual(JSON.parse(after.summary_facts).climate, JSON.parse(before.summary_facts).climate);
});

test('a legacy facts object without climate does not acquire today\'s climate', () => {
  stale();
  const facts = JSON.parse(rows()[0].summary_facts);
  delete facts.climate;
  db.prepare('UPDATE sleep_nights SET summary_facts = ? WHERE child_id = ?').run(JSON.stringify(facts), CHILD);
  db.prepare('INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, 26, 60, ?)')
    .run(CAM, sql(at(20, 0)));
  assert.equal(applyChecked().changed, 1);
  assert.equal(Object.hasOwn(JSON.parse(rows()[0].summary_facts), 'climate'), false);
});

test('a null saved facts value does not acquire today\'s climate', () => {
  stale();
  db.prepare('UPDATE sleep_nights SET summary_facts = NULL WHERE child_id = ?').run(CHILD);
  db.prepare('INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, 26, 60, ?)')
    .run(CAM, sql(at(20, 0)));
  assert.equal(applyChecked().changed, 1);
  assert.equal(Object.hasOwn(JSON.parse(rows()[0].summary_facts), 'climate'), false);
});

test('late minute evidence changes the after values and invalidates the preview', () => {
  stale();
  const preview = rewriteRaw({ apply: false });
  assert.equal(preview.changed, 1);
  db.prepare(`UPDATE activity_samples SET motion_level = 0.4, motion_peak = 0.4
    WHERE bucket_start >= ? AND bucket_start < ?`).run(sql(at(19, 40)), sql(at(21, 0)));
  const nextPreview = rewriteRaw({ apply: false });
  assert.equal(nextPreview.changed, 1);
  assert.notEqual(nextPreview.preview, preview.preview);
  const before = rows();
  assert.throws(() => rewriteRaw({ apply: true, expect: preview.preview }), { reason: 'changed_since_preview' });
  assert.deepEqual(rows(), before);
  assert.deepEqual(backups(), []);
});

test('a failure after a night write rolls its savepoint back and later nights continue', () => {
  const { before } = stale();
  db.prepare(`INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak,
    sound_level, sound_peak, motion_frames, sound_windows)
    SELECT camera_id, datetime(bucket_start, '+1 day'), motion_level, motion_peak,
      sound_level, sound_peak, motion_frames, sound_windows FROM activity_samples`).run();
  db.prepare(`INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status,
    onset_at, asleep_minutes, scoring_context, computed_at)
    VALUES (?, '2026-07-02', '2026-07-02 09:30:00', '2026-07-02 21:00:00', 'ok',
      '2026-07-02 06:56:00', 1, ?, '2026-07-03 00:00:00')`).run(CHILD, before.scoring_context);
  db.exec(`CREATE TRIGGER fail_backup AFTER INSERT ON sleep_night_rewrites
    WHEN NEW.night_date = '${DATE}' BEGIN SELECT RAISE(ABORT, 'injected backup failure'); END`);
  try {
    const result = applyChecked();
    assert.equal(result.children[0].skipped.error, 1);
    assert.equal(result.changed, 1);
    assert.deepEqual(rows()[0], before);
    assert.equal(backups().length, 1);
    assert.equal(backups()[0].night_date, '2026-07-02');
  } finally { db.exec('DROP TRIGGER fail_backup'); }
});

test('one undo attempt closes reviewed and re-saved rows', () => {
  stale();
  applyChecked();
  const batch = latestRewrite().batch_id;
  const rewritten = rows()[0];
  db.prepare('INSERT INTO sleep_reviews (child_id, night_date, dismissed) VALUES (?, ?, 1)').run(CHILD, DATE);
  assert.equal(undoRewrite({ batchId: batch }).skipped.corrected_since, 1);
  db.prepare('DELETE FROM sleep_reviews').run();
  assert.equal(latestRewrite().undoable, false);
  assert.equal(latestRewrite().left, 1);
  assert.equal(latestRewrite().restored, 0);
  assert.throws(() => undoRewrite({ batchId: batch }), { reason: 'already_undone' });
  assert.deepEqual(rows(), [rewritten]);
  assert.equal(backups()[0].undo_skip_reason, 'corrected_since');
});

test('a re-saved night remains closed after the later save is put back', () => {
  stale();
  applyChecked();
  const batch = latestRewrite().batch_id;
  const rewritten = rows()[0];
  db.prepare('UPDATE sleep_nights SET asleep_minutes = asleep_minutes + 1 WHERE child_id = ?').run(CHILD);
  assert.equal(undoRewrite({ batchId: batch }).skipped.saved_again_since, 1);
  db.prepare('UPDATE sleep_nights SET asleep_minutes = ? WHERE child_id = ?').run(rewritten.asleep_minutes, CHILD);
  assert.equal(latestRewrite().undoable, false);
  assert.throws(() => undoRewrite({ batchId: batch }), { reason: 'already_undone' });
  assert.deepEqual(rows(), [rewritten]);
});

test('a restored batch is not undoable and older batches are refused', () => {
  stale();
  applyChecked();
  const first = latestRewrite().batch_id;
  assert.equal(undoRewrite({ batchId: first }).restored, 1);
  assert.equal(latestRewrite().undoable, false);
  assert.equal(latestRewrite().restored, 1);
  assert.throws(() => undoRewrite({ batchId: first }), { reason: 'already_undone' });
  applyChecked();
  assert.notEqual(latestRewrite().batch_id, first);
  assert.throws(() => undoRewrite({ batchId: first }), { reason: 'not_latest' });
});

test('undo during a running update is refused, and a deleted night is left as it is', () => {
  stale();
  applyChecked();
  const batch = latestRewrite().batch_id;
  db.prepare('UPDATE sleep_nights SET asleep_minutes = 1 WHERE child_id = ?').run(CHILD);
  let refusal;
  db.function('try_undo_during_update', () => {
    try { undoRewrite({ batchId: batch }); } catch (error) { refusal = error; }
    return 1;
  });
  db.exec(`CREATE TRIGGER try_undo_during_update BEFORE UPDATE ON sleep_nights
    WHEN NEW.asleep_minutes <> OLD.asleep_minutes BEGIN SELECT try_undo_during_update(); END`);
  try { applyChecked(); } finally { db.exec('DROP TRIGGER try_undo_during_update'); }
  assert.equal(refusal.reason, 'in_progress');
  assert.equal(refusal.status, 409);
  const second = latestRewrite().batch_id;
  db.prepare('DELETE FROM sleep_nights WHERE child_id = ?').run(CHILD);
  assert.equal(undoRewrite({ batchId: second }).skipped.saved_again_since, 1);
  assert.equal(latestRewrite().undoable, false);
});

test('the admin HTTP flow previews, applies strictly true, reads latest and undoes', async () => {
  stale();
  const endpoint = `${server.url}/api/settings/sleep-rewrite`;
  const check = await call(endpoint, { method: 'POST', token: adminToken, body: { apply: false } });
  assert.equal(check.status, 200);
  assert.equal(check.body.changed, 1);
  assert.deepEqual(backups(), []);
  const invalid = await call(endpoint, { method: 'POST', token: adminToken, body: { apply: 'true' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.reason, 'invalid_apply');
  const applied = await call(endpoint, { method: 'POST', token: adminToken,
    body: { apply: true, expect: check.body.preview } });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body, check.body);
  assert.equal(backups()[0].applied_by_user_id, 'rewrite-admin');
  const latest = await call(endpoint, { token: adminToken });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.undoable, true);
  const undone = await call(`${endpoint}/undo`, { method: 'POST', token: adminToken,
    body: { batch_id: latest.body.batch_id } });
  assert.equal(undone.status, 200);
  assert.equal(undone.body.restored, 1);
});

test('caregiver is forbidden on all routes; demo blocks writes', async () => {
  for (const [method, path, body] of [['GET', '', undefined], ['POST', '', { apply: false }],
    ['POST', '/undo', { batch_id: 'x' }]]) {
    const res = await call(`${server.url}/api/settings/sleep-rewrite${path}`, { method, token: careToken, body });
    assert.equal(res.status, 403);
  }
  process.env.DEMO_MODE = 'true';
  try {
    for (const path of ['', '/undo']) {
      const res = await call(`${server.url}/api/settings/sleep-rewrite${path}`, { method: 'POST', token: adminToken, body: {} });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /read-only public demo/);
    }
  } finally { delete process.env.DEMO_MODE; }
});
