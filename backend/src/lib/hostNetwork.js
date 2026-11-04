import fs from 'node:fs';

const NET = '/sys/class/net';
const HOST_NAME = /^(?:docker0|br-.+|veth.+|virbr.+|podman.+|cni.+|lxcbr0|incusbr0|vmbr.+|cali.+|flannel\..+|tailscale0|wg.+)$/;
const absent = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

function exists(path, lstat) {
  try { lstat(path); return true; } catch (err) { if (absent(err)) return false; throw err; }
}

function listener(text, ownPort, ipv6) {
  for (const line of String(text).split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== '0A') continue;
    const [address, hexPort] = fields[1].split(':');
    if (!address || !hexPort || parseInt(hexPort, 16) === ownPort) continue;
    if (ipv6) {
      // Opus plan review of #967: proc's IPv4-mapped IPv6 addresses retain the IPv4
      // little-endian word; wildcard sockets also expose this namespace.
      if (/^0{32}$/i.test(address) ||
          /^0{16}FFFF0000[0-9A-F]{8}$/i.test(address) &&
          address.slice(-8).toUpperCase() !== '0200007F' &&
          (address.slice(-8) === '00000000' || address.slice(-8).toUpperCase().endsWith('7F'))) return true;
    } else if (address === '00000000' ||
      (address.slice(-2).toUpperCase() === '7F' && address.toUpperCase() !== '0200007F')) return true;
  }
  return false;
}

export function detectHostNetwork({ platform = process.platform, readdir = fs.readdirSync,
  lstat = fs.lstatSync, realpath = fs.realpathSync, readFile = fs.readFileSync,
  port = Number(process.env.PORT || 4000) } = {}) {
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
    if (listener(readFile('/proc/net/tcp', 'utf8'), port, false) ||
        listener(readFile('/proc/net/tcp6', 'utf8'), port, true)) evidence.add('foreign_listener');
  } catch { return { host: false, evidence: [], unknown: 'proc_mismatch' }; }
  return { host: evidence.size > 0, evidence: [...evidence], unknown: null };
}
