// #1076: a timed-out status check is unknown, so it keeps the connecting tempo instead of claiming a fault.
export function cameraState(cam) {
  if (cam.disabled) return { word: 'Disabled', dot: 'neutral' };
  if (cam.statusUnknown) return { word: 'Status unknown', dot: 'connecting' };
  if (cam.statusLevel === 'live') return { word: 'Online', dot: 'live' };
  if (cam.statusLevel === 'offline') return { word: 'Offline', dot: 'offline' };
  return { word: 'Connecting', dot: 'connecting' };
}
