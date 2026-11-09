// Discovery only suggests literal LAN IPv4 addresses. Reject alternate spellings so neither
// a browser nor a future caller can turn a hostname or public address into a probe target (#945).
export function isPrivateLanIPv4(ip) {
  if (typeof ip !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip)) return false;
  const [a, b, c, d] = ip.split('.').map(Number);
  if ([a, b, c, d].some((part) => part > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254);
}
