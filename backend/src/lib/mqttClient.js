import mqtt from 'mqtt';
import db from '../db.js';
import { logger } from './logger.js';

let client = null;
let currentConfigKey = null;
const readings = new Map(); // topic -> { temperature?, humidity?, receivedAt }

function getMqttSettings() {
  return db
    .prepare('SELECT mqtt_enabled, mqtt_host, mqtt_port, mqtt_username, mqtt_password FROM settings WHERE id = ?')
    .get('app');
}

function configKey(cfg) {
  return JSON.stringify(cfg);
}

export function getReading(topic) {
  if (!topic) return null;
  return readings.get(topic) || null;
}

function subscribeAllCameraTopics() {
  if (!client) return;
  const topics = db
    .prepare("SELECT DISTINCT mqtt_topic FROM cameras WHERE mqtt_topic IS NOT NULL AND mqtt_topic != ''")
    .all()
    .map((r) => r.mqtt_topic);
  if (topics.length === 0) return;
  client.subscribe(topics, (err) => {
    if (err) logger.error('[mqtt] Failed to subscribe to camera topics:', err.message);
  });
}

// Called on startup, after a settings save, and after any camera add/edit/delete that
// touches an MQTT topic - cheap to call liberally, since it no-ops if nothing actually
// changed (aside from re-subscribing, which is itself a no-op for already-subscribed
// topics).
export function refreshMqttConnection() {
  const cfg = getMqttSettings();

  // Disabled counts the same as unconfigured: tear down any live connection and,
  // critically, don't leave a client endlessly retrying a broker that's deliberately
  // off. The saved broker config itself is untouched - re-enabling picks it back up.
  if (!cfg.mqtt_host || !cfg.mqtt_enabled) {
    if (client) {
      client.end(true);
      client = null;
      currentConfigKey = null;
      readings.clear();
      logger.info('[mqtt] Disconnected (disabled or unconfigured).');
    }
    return;
  }

  const key = configKey(cfg);
  if (key === currentConfigKey) {
    subscribeAllCameraTopics(); // broker config unchanged, but camera topics might not be
    return;
  }

  if (client) client.end(true);
  currentConfigKey = key;
  readings.clear();

  client = mqtt.connect(`mqtt://${cfg.mqtt_host}:${cfg.mqtt_port || 1883}`, {
    username: cfg.mqtt_username || undefined,
    password: cfg.mqtt_password || undefined,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    logger.info('[mqtt] Connected to broker.');
    subscribeAllCameraTopics();
  });

  client.on('reconnect', () => {
    logger.info('[mqtt] Reconnecting to broker...');
  });

  client.on('error', (err) => {
    logger.error('[mqtt] Connection error:', err.message);
  });

  client.on('message', (topic, payload) => {
    // Fails silently on anything unexpected (not JSON, no recognizable fields) -
    // this is meant to degrade gracefully for an unrelated topic/payload shape,
    // not spam errors for something that was never meant to be a temp/humidity reading.
    try {
      const data = JSON.parse(payload.toString());
      const reading = { receivedAt: Date.now() };
      if (typeof data.temperature === 'number') reading.temperature = data.temperature;
      if (typeof data.humidity === 'number') reading.humidity = data.humidity;
      if (reading.temperature !== undefined || reading.humidity !== undefined) {
        readings.set(topic, reading);
      }
    } catch {
      // Ignore.
    }
  });
}

export function stopMqtt() {
  if (client) client.end(true);
}

export { subscribeAllCameraTopics };
