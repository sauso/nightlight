import fetch from 'node-fetch';

// Host networking means MediaMTX's API is reachable on localhost from the backend container.
const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://127.0.0.1:9997';

// Turn a camera name + id into a safe MediaMTX path name (alphanumeric, dashes, underscores).
export function toPathName(id) {
  return `cam_${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

// The path has no pull source — it's publisher-only. Our FFmpeg transcoder (see
// transcoder.js) pulls the camera's RTSP feed itself and publishes the (audio
// re-encoded) result straight into this path, rather than MediaMTX pulling the
// camera directly. This is what lets HLS carry audio even from cameras using G711,
// a codec HLS can't transport at all.
export async function upsertPath(pathName) {
  const body = { source: 'publisher' };
  // MediaMTX: try PATCH (path exists) first, fall back to POST (create new).
  let res = await fetch(`${MEDIAMTX_API}/v3/config/paths/patch/${pathName}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 404) {
    res = await fetch(`${MEDIAMTX_API}/v3/config/paths/add/${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MediaMTX rejected path config (${res.status}): ${text}`);
  }
}

// Checks whether a path is already correctly configured, WITHOUT changing anything.
// Important: any actual config write (upsertPath above) forces MediaMTX to reload the
// path, disconnecting whatever is currently publishing to it. This lets periodic
// reconciliation skip that disruption entirely for paths that are already fine.
export async function isPathConfiguredCorrectly(pathName) {
  try {
    const res = await fetch(`${MEDIAMTX_API}/v3/config/paths/get/${pathName}`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.source === 'publisher';
  } catch {
    return false;
  }
}

export async function removePath(pathName) {
  const res = await fetch(`${MEDIAMTX_API}/v3/config/paths/delete/${pathName}`, {
    method: 'DELETE',
  });
  // 404 just means it was already gone — fine.
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`MediaMTX failed to remove path (${res.status}): ${text}`);
  }
}

export async function getPathStatus(pathName) {
  try {
    const res = await fetch(`${MEDIAMTX_API}/v3/paths/get/${pathName}`);
    if (!res.ok) return { ready: false };
    const data = await res.json();
    return { ready: !!data.ready, readers: data.readers?.length || 0 };
  } catch {
    return { ready: false };
  }
}
