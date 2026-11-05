// Is this page being served over Tailscale? True for a MagicDNS name (`*.ts.net`) and for a Tailscale address
// (100.64.0.0/10, the shared-address range Tailscale hands out). Used only to word an error: when the server cannot be
// reached over a tailnet, "check you are on the home network" is the wrong advice and "is Tailscale on?" is the right one.
// Measured 2026-11-05: switching Tailscale off on a phone with the app open ends in a connection timeout, and nothing
// on the server can say why, so the page has to guess from the address it was opened at.
// A guess, not proof: a reverse proxy on your own domain in front of a tailnet is not recognised, and says the old text.
export function isTailnetHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (/^(?:[a-z0-9-]+\.)+ts\.net$/.test(host)) return true;
  // No leading zeros: a browser canonicalises 100.064.0.1 to 100.52.0.1 (outside the range), so reading it as 64 would be wrong.
  // Found by the PR #984 review; real callers pass the browser's own hostname, so this only guards direct input.
  const match = /^100\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  // 64..127 in the second octet is 100.64.0.0/10; every octet must also be a real byte.
  return octets.every((octet) => octet <= 255) && octets[0] >= 64 && octets[0] <= 127;
}
