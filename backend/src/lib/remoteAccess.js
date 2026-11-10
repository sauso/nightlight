import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { configuredPublicHosts, getLastAdvertisedHosts, resolveWebrtcUdpAddress } from './mediamtxProcess.js';
import { parseStunServers } from './stunServers.js';
import { isLoopbackAddress, isLoopbackExposed } from './loopbackExposure.js';

const home4 = new BlockList();
for (const [address, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]]) {
  home4.addSubnet(address, prefix, 'ipv4');
}
const vpn4 = new BlockList();
vpn4.addSubnet('100.64.0.0', 10, 'ipv4');
const home6 = new BlockList();
for (const [address, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]]) {
  home6.addSubnet(address, prefix, 'ipv6');
}
// Cloudflare's published proxy ranges (https://www.cloudflare.com/ips-v4 and
// https://www.cloudflare.com/ips-v6), fetched
// 2026-11-10. Re-check them as Cloudflare can change the list. Cached or split-horizon DNS can
// also mislead this check. docs/remote-access.md names a proxied PUBLIC_HOST as a common mistake:
// its web proxy cannot carry UDP video.
const cloudflare = new BlockList();
for (const subnet of '173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22'.split(' ')) {
  const [address, prefix] = subnet.split('/');
  cloudflare.addSubnet(address, Number(prefix), 'ipv4');
}
for (const subnet of '2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32'.split(' ')) {
  const [address, prefix] = subnet.split('/');
  cloudflare.addSubnet(address, Number(prefix), 'ipv6');
}

function behindCloudflare(addresses) {
  return addresses.some((address) => {
    const family = isIP(address);
    // Node's BlockList also checks IPv4 subnets against IPv4-mapped IPv6 answers.
    return family && cloudflare.check(address, family === 4 ? 'ipv4' : 'ipv6');
  });
}

export function classifyClient({ ip, forwardedHeaderPresent = false, trustedProxyChain = false, loopbackExposed = isLoopbackExposed() }) {
  // A LAN reverse proxy can send X-Forwarded-For while the default loopback trust setting ignores it.
  // In that case req.ip is the proxy, not the caller; reporting "home" would be misleading.
  if (forwardedHeaderPresent && !trustedProxyChain) return 'unknown';
  if (typeof ip !== 'string') return 'unknown';
  const family = isIP(ip);
  if (!family) return 'unknown';
  // MEASURED 2026-11-03: userspace tailscaled delivers every tailnet peer to the app as a
  // connection from 127.0.0.1. The socket could also be a local process, so its network is unknown.
  if (loopbackExposed && isLoopbackAddress(ip)) return 'unknown';
  if (family === 4) {
    if (home4.check(ip, 'ipv4')) return 'home';
    if (vpn4.check(ip, 'ipv4')) return 'vpn';
    return 'remote';
  }
  // BlockList checks IPv4 ranges against mapped IPv6 in both dotted and hex spelling.
  if (home4.check(ip, 'ipv6')) return 'home';
  if (vpn4.check(ip, 'ipv6')) return 'vpn';
  return home6.check(ip, 'ipv6') ? 'home' : 'remote';
}

export function classifyClientVia({ ip, forwardedHeaderPresent = false, trustedProxyChain = false, loopbackExposed = isLoopbackExposed() }) {
  // #962: Serve peers arrive on loopback, which can also carry a forwarded header. Preserve the
  // existing unknown network classification while showing the tunnel before proxy guidance.
  if (loopbackExposed && isLoopbackAddress(ip)) return 'tailscale';
  if (forwardedHeaderPresent && !trustedProxyChain) return 'proxy';
  return null;
}

function dnsError(error) {
  if (error?.code === 'ENOTFOUND' || error?.code === 'ENODATA') return 'not_found';
  if (error?.code === 'REMOTE_ACCESS_TIMEOUT') return 'timeout';
  return 'failed';
}

async function resolveEntry(host, resolver, timeoutMs) {
  if (isIP(host)) return { host, kind: 'ip', addresses: [host], error: null, behind_cloudflare: behindCloudflare([host]) };
  let timer;
  try {
    // DNS is only for operator-configured names. A short race bounds the HTTP response even if lookup stalls.
    const answers = await Promise.race([
      resolver(host, { all: true, family: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'REMOTE_ACCESS_TIMEOUT' })), timeoutMs);
      }),
    ]);
    const addresses = [...new Set(answers.map((answer) => answer.address))];
    return { host, kind: 'name', addresses, error: null, behind_cloudflare: behindCloudflare(addresses) };
  } catch (error) {
    return { host, kind: 'name', addresses: [], error: dnsError(error), behind_cloudflare: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildRemoteAccess({ env = process.env, ip, forwardedHeaderPresent = false, trustedProxyChain = false, trustProxy, resolver = lookup, timeoutMs = 3000 } = {}) {
  // The exposed-loopback flag is read when each classifier runs (after the DNS lookups below), exactly as before #962:
  // snapshotting it here would let `network` differ from the old answer if the daemon attaches during a slow lookup.
  const client = { ip, forwardedHeaderPresent, trustedProxyChain };
  // More than ten PUBLIC_HOST entries is not a real setup; cap DNS work per request.
  const hosts = configuredPublicHosts(env).slice(0, 10);
  const publicHosts = await Promise.all(hosts.map((host) => resolveEntry(host, resolver, timeoutMs)));
  const stunServers = parseStunServers(env.STUN_SERVERS).urls;
  const udp = resolveWebrtcUdpAddress(env).value;
  const override = (env.MTX_WEBRTCLOCALUDPADDRESS || '').trim();
  const overridePort = override.match(/:(\d{1,5})$/)?.[1];
  return {
    app_port: Number(env.PORT || 4000),
    webrtc_udp_port: overridePort ? Number(overridePort) : udp ? Number(udp.slice(1)) : 8189,
    public_host_set: configuredPublicHosts(env).length > 0,
    // How many hosts are configured; public_hosts below is capped at 10 (DNS work per request), so the page needs this to avoid
    // calling an eleventh, unchecked host fine (Codex review of #1025).
    public_host_count: configuredPublicHosts(env).length,
    public_hosts: publicHosts,
    advertised_hosts: getLastAdvertisedHosts(env),
    stun: { enabled: stunServers.length > 0, servers: stunServers },
    trust_proxy: String(trustProxy),
    client: { network: classifyClient(client), via: classifyClientVia(client) },
  };
}
