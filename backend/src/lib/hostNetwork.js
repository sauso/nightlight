import fs from 'node:fs';

const NET = '/sys/class/net';
const HOST_NAME = /^(?:docker0|br-.+|veth.+|virbr.+|podman.+|cni.+|lxcbr0|incusbr0|vmbr.+|cali.+|flannel\..+|tailscale0|wg.+)$/;
const absent = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

function exists(path, lstat) {
  try { lstat(path); return true; } catch (err) { if (absent(err)) return false; throw err; }
}

function ownedSockets(ownedPid, readdir, readlink) {
  const inodes = new Set();
  if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0) return inodes;
  const dir = `/proc/${ownedPid}/fd`;
  let fds;
  // MEASURED 2026-11-04: the daemon runs as the app uid, so its fds are readable.
  // If that changes, exempt nothing and keep the host-network block in place.
  try { fds = readdir(dir); } catch { return inodes; }
  for (const fd of fds) {
    try {
      const inode = String(readlink(`${dir}/${fd}`)).match(/^socket:\[(\d+)\]$/)?.[1];
      if (inode) inodes.add(inode);
    } catch { /* An fd can close while /proc is scanned; it cannot be exempted. */ }
  }
  return inodes;
}

function listener(text, ownPort, ipv6, ownedInodes) {
  for (const line of String(text).split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== '0A') continue;
    const [address, hexPort] = fields[1].split(':');
    if (!address || !hexPort || parseInt(hexPort, 16) === ownPort) continue;
    // MEASURED 2026-11-04: connected tailscaled owns one wildcard TCP listener.
    // Only its socket inode is exempt; every other qualifying listener still blocks.
    if (ownedInodes.has(fields[9])) continue;
    if (ipv6) {
      // Opus fix review of #967: Tailscale netstack dials 127.0.0.1 for tailnet
      // traffic. Docker DNS listens on 127.0.0.11 in every user-defined network,
      // so other loopback addresses and ::1 cannot indicate a shared namespace.
      // Proc's mapped IPv4 addresses retain the little-endian IPv4 word.
      if (/^0{32}$/i.test(address) ||
          /^(?:0{16}FFFF0000)(?:0100007F|00000000)$/i.test(address)) return true;
    } else if (address === '00000000' || address.toUpperCase() === '0100007F') return true;
  }
  return false;
}

export function detectHostNetwork({ platform = process.platform, readdir = fs.readdirSync,
  lstat = fs.lstatSync, realpath = fs.realpathSync, readFile = fs.readFileSync,
  readlink = fs.readlinkSync, port = Number(process.env.PORT || 4000), ownedPid = null } = {}) {
  if (platform !== 'linux') return { host: false, evidence: [], unknown: 'not_linux' };
  let names;
  try { names = readdir(NET); } catch { return { host: false, evidence: [], unknown: 'no_sysfs' }; }
  if (!names.includes('lo')) return { host: false, evidence: [], unknown: 'no_lo' };
  const evidence = new Set();
  let procNames;
  try {
    const proc = String(readFile('/proc/self/net/dev', 'utf8'));
    procNames = new Set(proc.split('\n').slice(2).map((line) => line.split(':')[0].trim()).filter(Boolean));
  } catch { return { host: false, evidence: [], unknown: 'proc_mismatch' }; }
  let interfaces;
  try {
    // Opus plan review of #967: sysfs also has plain files such as bonding_masters.
    // Compare only interface entries with the real namespace's /proc names.
    interfaces = names.filter((name) => {
      const entry = `${NET}/${name}`;
      return lstat(entry).isSymbolicLink() || exists(`${entry}/ifindex`, lstat);
    });
  } catch { return { host: false, evidence: [], unknown: 'no_sysfs' }; }
  if (interfaces.length !== procNames.size || interfaces.some((name) => !procNames.has(name))) {
    return { host: false, evidence: [], unknown: 'proc_mismatch' };
  }
  try {
    for (const name of interfaces) {
      if (name === 'lo') continue;
      const entry = `${NET}/${name}`;
      // Opus plan review of #967: bonding_masters is a plain sysfs file, not an
      // interface. realpath returns an absolute path; it is never a classification alone.
      // Opus plan review of #967: readlink gives a relative target; realpath
      // must resolve it before trusting this sysfs view.
      if (!realpath(entry).startsWith('/')) return { host: false, evidence: [], unknown: 'proc_mismatch' };
      if (exists(`${entry}/device`, lstat)) evidence.add('physical_nic');
      for (const [dir, code] of [['bridge', 'bridge_dir'], ['brport', 'brport_dir'], ['bonding', 'bonding_dir']]) {
        if (exists(`${entry}/${dir}`, lstat)) evidence.add(code);
      }
      if (HOST_NAME.test(name)) evidence.add('host_iface_name');
    }
  } catch { return { host: false, evidence: [], unknown: 'no_sysfs' }; }
  try {
    // Opus plan review of #967: a shared namespace may expose another process's
    // loopback listener even when its interface shape resembles a bridge container.
    const tcp = readFile('/proc/net/tcp', 'utf8');
    // Opus fix review of #967: ipv6.disable=1 removes tcp6 entirely; that is
    // absence of IPv6 listeners, while a missing tcp remains a namespace fault.
    let tcp6;
    try { tcp6 = readFile('/proc/net/tcp6', 'utf8'); }
    catch (err) { if (err?.code !== 'ENOENT') throw err; tcp6 = ''; }
    const ownedInodes = ownedSockets(ownedPid, readdir, readlink);
    if (listener(tcp, port, false, ownedInodes) || listener(tcp6, port, true, ownedInodes)) evidence.add('foreign_listener');
  } catch { return { host: false, evidence: [], unknown: 'proc_mismatch' }; }
  return { host: evidence.size > 0, evidence: [...evidence], unknown: null };
}
