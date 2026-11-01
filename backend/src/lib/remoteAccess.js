import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { configuredPublicHosts, getLastAdvertisedHosts, resolveWebrtcUdpAddress } from './mediamtxProcess.js';
import { parseStunServers } from './stunServers.js';

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

export function classifyClient({ ip, forwardedHeaderPresent = false, trustedProxyChain = false }) {
  // A LAN reverse proxy can send X-Forwarded-For while the default loopback trust setting ignores it.
  // In that case req.ip is the proxy, not the caller; reporting "home" would be misleading.
  if (forwardedHeaderPresent && !trustedProxyChain) return 'unknown';
  if (typeof ip !== 'string') return 'unknown';
  const family = isIP(ip);
  if (!family) return 'unknown';
  if (family === 4) {
    if (home4.check(ip, 'ipv4')) return 'home';
    if (vpn4.check(ip, 'ipv4')) return 'vpn';
    return 'remote';
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return classifyClient({ ip: mapped[1] });
  return home6.check(ip, 'ipv6') ? 'home' : 'remote';
}

function dnsError(error) {
  if (error?.code === 'ENOTFOUND' || error?.code === 'ENODATA') return 'not_found';
  if (error?.code === 'REMOTE_ACCESS_TIMEOUT') return 'timeout';
  return 'failed';
}

async function resolveEntry(host, resolver, timeoutMs) {
  if (isIP(host)) return { host, kind: 'ip', addresses: [host], error: null };
  let timer;
  try {
    // DNS is only for operator-configured names. A short race bounds the HTTP response even if lookup stalls.
    const answers = await Promise.race([
      resolver(host, { all: true, family: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'REMOTE_ACCESS_TIMEOUT' })), timeoutMs);
      }),
    ]);
    return { host, kind: 'name', addresses: [...new Set(answers.map((answer) => answer.address))], error: null };
  } catch (error) {
    return { host, kind: 'name', addresses: [], error: dnsError(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildRemoteAccess({ env = process.env, ip, forwardedHeaderPresent = false, trustedProxyChain = false, trustProxy, resolver = lookup, timeoutMs = 3000 } = {}) {
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
    public_hosts: publicHosts,
    advertised_hosts: getLastAdvertisedHosts(env),
    stun: { enabled: stunServers.length > 0, servers: stunServers },
    trust_proxy: String(trustProxy),
    client: { network: classifyClient({ ip, forwardedHeaderPresent, trustedProxyChain }) },
  };
}
