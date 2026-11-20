// What the screens need to know about a Nightlight Camera's own sensors (the server half is
// backend/src/lib/nightlightCamera.js and cameraSensors.js; the plan and limits are in docs/cameras.md).

export const SENSOR_SOURCE = 'nightlight-api';
export const SENSOR_GROUPS = ['climate', 'radar', 'light', 'pad'];

// The per-group switches as the server stores them (JSON text on the camera row, NULL = all on). Anything that does not
// parse, or a key that is not a boolean, keeps the default "on": the same rule the server applies.
export function parseSensorGroups(text) {
  const groups = Object.fromEntries(SENSOR_GROUPS.map((g) => [g, true]));
  if (typeof text !== 'string' || !text) return groups;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') for (const g of SENSOR_GROUPS) if (typeof parsed[g] === 'boolean') groups[g] = parsed[g];
  } catch { /* keep the defaults */ }
  return groups;
}

// True when this camera's room temperature and humidity come from the camera itself (the server then ignores its MQTT
// readings), so the tile and the chart show the camera's, not MQTT's.
export function usesCameraClimate(camera) {
  return camera?.sensor_source === SENSOR_SOURCE && parseSensorGroups(camera.sensor_groups).climate;
}

// The words for a poll status the server reports (cameraSensors.js liveSensors).
export const STATUS_TEXT = {
  ok: 'Connected',
  connecting: 'Connecting…',
  offline: 'Camera not answering',
  login_failed: 'Sensor login failed',
  wrong_device: 'A different device answers at this address',
  off: 'Off',
};
