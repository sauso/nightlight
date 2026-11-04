import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHostNetwork } from '../src/lib/hostNetwork.js';

const tcp = (address = null, port = 9000, state = '0A', inode = '123') =>
  '  sl  local_address rem_address   st\n' +
  (address ? `   0: ${address}:${port.toString(16).padStart(4, '0')} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}\n` : '');
function fixture({ names = ['lo', 'eth0'], plain = [], attrs = {}, procNames = names.filter((n) => !plain.includes(n)),
  tcp4 = tcp(), tcp6 = tcp() } = {}) {
  const dirs = new Set(Object.entries(attrs).flatMap(([name, parts]) => parts.map((part) => `/sys/class/net/${name}/${part}`)));
  return { platform: 'linux', readdir: () => names,
    lstat: (p) => {
      if (dirs.has(p) || p.endsWith('/ifindex') && !plain.includes(p.split('/').at(-2))) {
        return { isSymbolicLink: () => false };
      }
      if (names.includes(p.split('/').at(-1))) {
        return { isSymbolicLink: () => !plain.includes(p.split('/').at(-1)) };
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    realpath: (p) => `/sys/devices/virtual/net/${p.split('/').at(-1)}`,
    readFile: (p) => p === '/proc/self/net/dev'
      ? `Inter-| Receive\n face | bytes\n${procNames.map((n) => `${n}: 0`).join('\n')}\n`
      : p === '/proc/net/tcp' ? tcp4 : tcp6,
    port: 4000 };
}

test('#967 structural evidence is fixed codes, including virtual NIC bridges and bus devices', () => {
  for (const [attr, code] of [['device', 'physical_nic'], ['bridge', 'bridge_dir'],
    ['brport', 'brport_dir'], ['bonding', 'bonding_dir']]) {
    const got = detectHostNetwork(fixture({ attrs: { eth0: [attr] } }));
    assert.deepEqual(got, { host: true, evidence: [code], unknown: null });
  }
  const named = detectHostNetwork(fixture({ names: ['lo', 'br0.10'] }));
  assert.equal(named.host, false);
  assert.doesNotMatch(JSON.stringify(named), /br0\.10/);
  assert.deepEqual(detectHostNetwork(fixture({ names: ['lo', 'docker0'] })).evidence, ['host_iface_name']);
});

test('#967 plain bonding_masters is ignored; no lo and proc mismatch refuse', () => {
  assert.deepEqual(detectHostNetwork(fixture({ names: ['lo', 'eth0', 'bonding_masters'], plain: ['bonding_masters'] })),
    { host: false, evidence: [], unknown: null });
  assert.equal(detectHostNetwork(fixture({ names: ['eth0'] })).unknown, 'no_lo');
  assert.equal(detectHostNetwork(fixture({ procNames: ['lo', 'different'] })).unknown, 'proc_mismatch');
  assert.equal(detectHostNetwork({ ...fixture(), realpath: () => '../../devices/virtual/net/eth0' }).unknown, 'proc_mismatch');
  assert.equal(detectHostNetwork({ ...fixture(), readdir: () => { throw Error('unreadable'); } }).unknown, 'no_sysfs');
  assert.equal(detectHostNetwork({ ...fixture(), lstat: () => { throw Error('unreadable'); } }).unknown, 'no_sysfs');
  assert.deepEqual(detectHostNetwork({ platform: 'win32' }), { host: false, evidence: [], unknown: 'not_linux' });
});

test('#967 only dialled loopback and wildcard LISTEN sockets count as foreign listeners', () => {
  for (const address of ['0100007F', '00000000']) {
    assert.deepEqual(detectHostNetwork(fixture({ tcp4: tcp(address) })).evidence, ['foreign_listener']);
  }
  for (const address of ['00000000000000000000000000000000',
    '0000000000000000FFFF00000100007F', '0000000000000000FFFF000000000000']) {
    assert.deepEqual(detectHostNetwork(fixture({ tcp6: tcp(address) })).evidence, ['foreign_listener']);
  }
  // Opus fix review of #967: Docker DNS binds 127.0.0.11 on user-defined
  // networks, and netstack dials only 127.0.0.1, not ::1 or another 127/8 IP.
  for (const address of ['0200007F', '0B00007F']) {
    assert.deepEqual(detectHostNetwork(fixture({ tcp4: tcp(address) })).evidence, []);
  }
  assert.deepEqual(detectHostNetwork(fixture({ tcp6: tcp('00000000000000000000000001000000') })).evidence, []);
  assert.deepEqual(detectHostNetwork(fixture({ tcp4: tcp('0100007F', 4000) })).evidence, []);
  assert.deepEqual(detectHostNetwork(fixture({ tcp4: tcp('00000000', 4000) })).evidence, []);
  assert.deepEqual(detectHostNetwork(fixture({ tcp4: tcp('0100007F', 9000, '01') })).evidence, []);
});

test('#967 absent tcp6 means no IPv6 listeners; absent tcp is unknown', () => {
  const base = fixture();
  const readFile = (p, enc) => {
    if (p === '/proc/net/tcp6') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return base.readFile(p, enc);
  };
  assert.deepEqual(detectHostNetwork({ ...base, readFile }), { host: false, evidence: [], unknown: null });
  assert.equal(detectHostNetwork({ ...base, readFile: (p, enc) => {
    if (p === '/proc/net/tcp') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return base.readFile(p, enc);
  } }).unknown, 'proc_mismatch');
});

test('#971 only socket inodes owned by the live daemon are exempt', () => {
  const base = fixture({ tcp4: tcp('00000000') });
  const pid = 321;
  const dir = `/proc/${pid}/fd`;
  const owned = { ...base, ownedPid: pid,
    readdir: (p) => p === dir ? ['3', '4'] : base.readdir(p),
    readlink: (p) => p === `${dir}/3` ? 'socket:[123]' : 'pipe:[456]' };
  assert.deepEqual(detectHostNetwork(owned).evidence, []);
  assert.deepEqual(detectHostNetwork({ ...owned,
    readFile: (p) => p === '/proc/net/tcp' ? tcp('00000000', 9000, '0A', '456') : base.readFile(p) }).evidence,
  ['foreign_listener']);
  assert.deepEqual(detectHostNetwork({ ...owned, readFile: (p) => p === '/proc/net/tcp6'
    ? tcp('00000000000000000000000000000000') : base.readFile(p) }).evidence, []);
  assert.deepEqual(detectHostNetwork({ ...owned, readdir: (p) => {
    if (p === dir) throw Error('permission denied');
    return base.readdir(p);
  } }).evidence, ['foreign_listener']);
  assert.deepEqual(detectHostNetwork({ ...owned,
    readFile: (p) => p === '/proc/net/tcp' ? tcp('00000000', 4000) : base.readFile(p) }).evidence, []);
  for (const invalid of [null, NaN]) {
    assert.deepEqual(detectHostNetwork({ ...owned, ownedPid: invalid }).evidence, ['foreign_listener']);
  }
});
