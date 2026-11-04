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

export function getTailnetAddress() { return address; }
export function tailnetAddressEpoch() { return epoch; }
export function setTailnetAddress(value) {
  address = vettedTailnetIPv4([value]);
  if (address === null) epoch++;
}
