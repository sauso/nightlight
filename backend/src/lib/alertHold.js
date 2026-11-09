import db from '../db.js';
import { logger } from './logger.js';
import { childTracksSleep, childWindowKeyNow } from './sleepAnalysis.js';
import { isChildAsleep } from './wakeWatcher.js';

// #919: owner/design choice, not measured. The watcher's existing onset needs 15 quiet minutes.
export const HOLD_CAP_MS = 45 * 60 * 1000;
const firstHeld = new Map(); // child id -> { key, firstAt, expired }

// A live alert calls this only after schedule and cooldown eligibility. Held alerts are dropped.
export function shouldHold(camera, nowMs = Date.now()) {
  try {
    if (!camera?.id) return false;
    const row = db.prepare(`SELECT c.child_id, k.hold_alerts_until_asleep
      FROM cameras c LEFT JOIN children k ON k.id = c.child_id WHERE c.id = ?`).get(camera.id);
    if (!row?.child_id || row.hold_alerts_until_asleep !== 1) return false;
    const childId = row.child_id;
    // #919: the setting needs Track sleep; without it the watcher cannot detect asleep, so allow alerts.
    if (!childTracksSleep(childId)) return false;
    const asleep = isChildAsleep(childId);
    if (asleep === true) return false;
    // Owner decision, 2026-11-10: alerts reached a phone before the window opened on staging.
    // Outside the gate the watcher cannot report asleep, so hold without a clock, cap, or per-alert log.
    if (asleep === undefined) return true;
    // The 45-minute cap is a design choice, not measured, and applies only inside the gate.
    const key = childWindowKeyNow(childId);
    if (key === null) return false;
    let entry = firstHeld.get(childId);
    if (!entry || entry.key !== key) {
      entry = { key, firstAt: nowMs, expired: false };
      firstHeld.set(childId, entry);
      logger.info(`[alert-hold] started child ${childId}`);
    }
    if (nowMs - entry.firstAt >= HOLD_CAP_MS || nowMs < entry.firstAt) {
      if (!entry.expired) logger.info(`[alert-hold] expired child ${childId}`);
      entry.expired = true;
      return false;
    }
    return !entry.expired;
  } catch {
    // #919: a failed hold check must never silence a live detector or leak household data in a log.
    logger.error('[alert-hold] check failed; alerts allowed');
    return false;
  }
}

export function _reset() { firstHeld.clear(); }
// Test-only snapshot: prove an ineligible alert never starts a child's clock.
export function _state() { return new Map(firstHeld); }
