// #974: Only a Tailscale IPv4 address may become a WebRTC host. Keep this state independent of
// MediaMTX so a status read cannot accidentally advertise an unvetted CLI value.
let address = null;
let epoch = 0;

export function vettedTailnetIPv4(list) {
  if (!Array.isArray(list)) return null;
  return list.find((value) => {
    if (typeof value !== 'string') return false;
    const parts = value.split('.');
    return parts.length === 4 && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255) &&
      parts[0] === '100' && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
  }) ?? null;
}

// True when a web origin ("https://x.ts.net", "http://100.101.102.103:4000") names a Tailscale host: a `.ts.net` name or an address in
// 100.64.0.0/10. Used to keep such an origin from becoming the server's GLOBAL public address (lib/push.js): a phone that is
// away and reaches us over Tailscale is not telling us where the household's alert links should point.
export function isTailnetOrigin(origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return host.endsWith('.ts.net') || vettedTailnetIPv4([host]) !== null;
}

export function getTailnetAddress() { return address; }
export function tailnetAddressEpoch() { return epoch; }
export function setTailnetAddress(value) {
  address = vettedTailnetIPv4([value]);
  if (address === null) epoch++;
}
