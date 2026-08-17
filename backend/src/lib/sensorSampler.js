import db from '../db.js';
import { logger } from './logger.js';
import { getReading } from './mqttClient.js';

// Persists each camera's latest MQTT temperature/humidity reading over time so the app can chart
// trends (and, in Stage 2, correlate overnight warmth with wake-ups). MQTT readings are otherwise
// live-only (getReading in mqttClient keeps just the most recent value per topic in memory). This is
// the "sensor analytics" groundwork the sleep-tracking plan depends on.

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000; // take a sample every 5 minutes
// Only record a reading the sensor actually published recently. getReading returns the last value it
// ever saw for a topic and holds it indefinitely, so a sensor that goes quiet would otherwise get its
// stale value re-recorded every tick — flat-lining the chart instead of showing a gap. 15 min covers
// missing a sample or two without treating a dead sensor as live.
const FRESH_MS = 15 * 60 * 1000;
const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const insertReading = db.prepare(
  'INSERT INTO sensor_readings (camera_id, temperature, humidity) VALUES (?, ?, ?)'
);

// One pass: for every enabled camera with a temp/humidity topic, record a row if its latest reading
// is fresh and has at least one of temperature/humidity. Returns how many rows were written.
export function sampleSensorReadings() {
  let cams;
  try {
    cams = db
      .prepare(
        `SELECT id, mqtt_topic FROM cameras
           WHERE mqtt_topic IS NOT NULL AND mqtt_topic != '' AND (disabled IS NULL OR disabled = 0)`
      )
      .all();
  } catch {
    return 0;
  }
  const now = Date.now();
  let written = 0;
  for (const cam of cams) {
    const r = getReading(cam.mqtt_topic);
    if (!r || now - (r.receivedAt || 0) > FRESH_MS) continue;
    const temperature = typeof r.temperature === 'number' ? r.temperature : null;
    const humidity = typeof r.humidity === 'number' ? r.humidity : null;
    if (temperature === null && humidity === null) continue;
    try {
      insertReading.run(cam.id, temperature, humidity);
      written++;
    } catch {
      /* a single bad insert shouldn't stop the rest */
    }
  }
  return written;
}

export function pruneSensorReadings() {
  try {
    const { changes } = db
      .prepare(`DELETE FROM sensor_readings WHERE created_at < datetime('now', '-${RETENTION_DAYS} days')`)
      .run();
    if (changes > 0) logger.info(`[sensors] Pruned ${changes} reading(s) older than ${RETENTION_DAYS} days.`);
  } catch {
    /* ignore */
  }
}

let sampleTimer = null;
let pruneTimer = null;

// Start the periodic sampler + a daily prune. Idempotent — safe to call once at startup.
export function startSensorSampler() {
  if (sampleTimer) return;
  sampleSensorReadings();
  pruneSensorReadings();
  sampleTimer = setInterval(sampleSensorReadings, SAMPLE_INTERVAL_MS);
  pruneTimer = setInterval(pruneSensorReadings, PRUNE_INTERVAL_MS);
  logger.info(
    `[sensors] Sampling temperature/humidity every ${SAMPLE_INTERVAL_MS / 60000} min, keeping ${RETENTION_DAYS} days.`
  );
}
