import crypto from 'node:crypto';
import appDb from '../db.js';

export const STEPS = Object.freeze(['welcome', 'children', 'camera', 'monitor_test', 'review']);
const TTL_MS = 10 * 60_000;
const CAP = 16;
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export class SetupError extends Error {
  constructor(status, code, message, missing) {
    super(message);
    this.status = status;
    this.code = code;
    this.missing = missing;
  }
}

export function createSetupState({ db = appDb, clock = () => Date.now() } = {}) {
  // WHY: the browser's frame report is an attestation, not a server measurement. Only a hash of
  // playback inputs is retained; the RTSP credential stays in the camera row and never reaches JSON.
  const proofs = new Map();
  const camera = (id) => db.prepare('SELECT id, rtsp_url, sub_rtsp_url, child_id, disabled FROM cameras WHERE id = ?').get(id);
  const eligible = (row) => row && row.child_id && !row.disabled
    && !!db.prepare('SELECT 1 FROM children WHERE id = ?').get(row.child_id);
  const fingerprint = (row) => crypto.createHash('sha256').update(JSON.stringify([
    row.rtsp_url, row.sub_rtsp_url, row.child_id, row.disabled,
  ])).digest('hex');
  const prune = () => {
    for (const [id, proof] of proofs) if (proof.expiresAtMs <= clock()) proofs.delete(id);
  };
  const put = (id, proof) => {
    prune();
    proofs.set(id, proof);
    while (proofs.size > CAP) proofs.delete(proofs.keys().next().value);
  };
  const state = () => db.prepare("SELECT status, active_step, flow_version, row_version FROM setup_state WHERE id = 'app'").get();
  const readiness = (sessionId) => {
    prune();
    const hasChild = !!db.prepare('SELECT 1 FROM children LIMIT 1').get();
    const assigned = db.prepare(`SELECT c.id, c.rtsp_url, c.sub_rtsp_url, c.child_id, c.disabled
      FROM cameras c JOIN children ch ON ch.id = c.child_id WHERE c.disabled = 0`).all();
    const cameraAssigned = assigned.length > 0;
    const playbackAttested = assigned.some((row) => [...proofs.values()].some((proof) =>
      proof.verifiedAt && proof.sessionId === sessionId && proof.cameraId === row.id
      && proof.fingerprint === fingerprint(row)));
    const missing = [];
    if (!hasChild) missing.push('CHILD');
    if (!cameraAssigned) missing.push('CAMERA');
    if (!playbackAttested) missing.push('PLAYBACK');
    return { hasChild, cameraAssigned, playbackAttested, ready: missing.length === 0, missing };
  };
  const read = (sessionId) => {
    const row = state();
    return { status: row.status, activeStep: row.active_step, flowVersion: row.flow_version,
      rowVersion: row.row_version, steps: [...STEPS], readiness: readiness(sessionId) };
  };
  const advance = (activeStep, expectedRowVersion, sessionId) => {
    if (!STEPS.includes(activeStep) || !Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 0) {
      throw new SetupError(400, 'INVALID_PROGRESS', 'Choose a valid setup step and row version.');
    }
    const row = state();
    if (row.row_version !== expectedRowVersion) throw new SetupError(409, 'STALE_VERSION', 'Setup changed. Reload and try again.');
    if (!['not_started', 'in_progress'].includes(row.status)) {
      throw new SetupError(409, 'SETUP_FINISHED', 'This setup state cannot be moved backwards.');
    }
    const result = db.prepare(`UPDATE setup_state SET status = 'in_progress', active_step = ?,
      row_version = row_version + 1, updated_at = datetime('now')
      WHERE id = 'app' AND row_version = ? AND status IN ('not_started', 'in_progress')`)
      .run(activeStep, expectedRowVersion);
    if (!result.changes) throw new SetupError(409, 'STALE_VERSION', 'Setup changed. Reload and try again.');
    return read(sessionId);
  };
  const startTest = (cameraId, sessionId) => {
    if (!uuid(cameraId)) throw new SetupError(400, 'INVALID_CAMERA', 'Choose a valid camera.');
    const row = camera(cameraId);
    if (!row) throw new SetupError(404, 'CAMERA_NOT_FOUND', 'Camera not found.');
    if (!eligible(row)) throw new SetupError(409, 'CAMERA_NOT_READY', 'Assign and enable the camera first.');
    const testId = crypto.randomUUID();
    const expiresAtMs = clock() + TTL_MS;
    put(testId, { cameraId, sessionId, fingerprint: fingerprint(row), expiresAtMs });
    return { testId, expiresAt: new Date(expiresAtMs).toISOString() };
  };
  const confirm = (testId, cameraId, sessionId) => {
    if (!uuid(testId) || !uuid(cameraId)) throw new SetupError(400, 'INVALID_TEST', 'Choose a valid monitor test and camera.');
    const proof = proofs.get(testId);
    if (!proof || proof.verifiedAt || proof.expiresAtMs <= clock()) {
      if (proof && proof.expiresAtMs <= clock()) proofs.delete(testId);
      throw new SetupError(409, 'TEST_UNAVAILABLE', 'This monitor test has expired or was already confirmed.');
    }
    // WHY: a test id alone cannot attest a second session or a different camera. Camera edits,
    // reassignment, disablement and deletion invalidate even a previously confirmed attestation.
    const row = camera(cameraId);
    if (proof.sessionId !== sessionId || proof.cameraId !== cameraId || !eligible(row)
      || proof.fingerprint !== fingerprint(row)) {
      throw new SetupError(409, 'TEST_CHANGED', 'The camera or session changed. Start a new monitor test.');
    }
    put(testId, { ...proof, verifiedAt: new Date(clock()).toISOString() });
    return { ok: true };
  };
  const complete = (limited, sessionId) => {
    if (typeof limited !== 'boolean') throw new SetupError(400, 'INVALID_COMPLETION', 'Limited must be true or false.');
    const row = state();
    if (row.status === 'completed') return { status: 'completed' };
    const ready = readiness(sessionId);
    if (!limited && !ready.ready) throw new SetupError(409, 'NOT_READY', 'Complete the missing setup steps first.', ready.missing);
    if (limited && row.status === 'legacy_completed') return { status: 'legacy_completed' };
    if (limited && row.status === 'completed_limited') return { status: 'completed_limited' };
    const status = limited ? 'completed_limited' : 'completed';
    const changed = db.prepare(`UPDATE setup_state SET status = ?, active_step = 'review',
      row_version = row_version + 1, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = 'app' AND row_version = ? AND status != 'completed'`).run(status, row.row_version);
    if (!changed.changes) throw new SetupError(409, 'STALE_VERSION', 'Setup changed. Reload and try again.');
    return { status };
  };
  return { read, advance, startTest, confirm, complete };
}

export default createSetupState();
