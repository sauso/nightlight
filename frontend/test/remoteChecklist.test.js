import { expect, test } from 'vitest';
import { buildChecklist } from '../src/lib/remoteChecklist.js';

const host = { host: 'video.example', kind: 'name', addresses: ['8.8.8.8'], error: null, behind_cloudflare: false };
const setup = { public_host_set: true, public_hosts: [host] };
const base = { setup, network: 'remote', via: null, result: null, protocol: 'http:' };
const row = (id, overrides = {}) => buildChecklist({ ...base, ...overrides }).find((entry) => entry.id === id);

test('no setup has no checklist', () => expect(buildChecklist({ ...base, setup: undefined })).toEqual([]));

test.each([
  ['https', 'ok', { protocol: 'https:' }, /over HTTPS/],
  ['https', 'check', {}, /plain http.*Use HTTPS/],
  ['https', 'unchecked', { network: 'home' }, /fine at home/],
  ['public_host', 'ok', {}, /video.example resolves/],
  ['public_host', 'check', { setup: { public_host_set: false, public_hosts: [] } }, /isn't set/],
  ['public_host', 'check', { setup: { ...setup, public_hosts: [{ ...host, error: 'not_found', addresses: [] }] } }, /video.example: name not found/],
  ['public_host', 'unchecked', { setup: { ...setup, public_hosts: [] } }, /could not be checked/],
  ['public_host', 'unchecked', { setup: { ...setup, public_hosts: [{ ...host, addresses: [] }] } }, /could not be checked/],
  ['cloudflare', 'ok', {}, /cached or split-horizon DNS/],
  ['cloudflare', 'check', { setup: { ...setup, public_hosts: [{ ...host, behind_cloudflare: true }] } }, /grey cloud/],
  ['cloudflare', 'unchecked', { setup: { public_host_set: false, public_hosts: [] } }, /Set PUBLIC_HOST first/],
  ['cloudflare', 'unchecked', { setup: { ...setup, public_hosts: [{ ...host, behind_cloudflare: undefined }] } }, /server that reports/],
  ['cloudflare', 'unchecked', { setup: { ...setup, public_hosts: [{ ...host, error: 'timeout', addresses: [] }] } }, /needs DNS answers/],
  ['cloudflare', 'unchecked', { setup: { ...setup, public_hosts: [] } }, /needs DNS answers/],
  ['udp', 'unchecked', {}, /mobile data/],
  ['udp', 'ok', { result: { outcome: 'connected', protocol: 'udp' } }, /working forward looks like/],
  ['udp', 'check', { result: { outcome: 'connected', protocol: 'tcp' } }, /didn't connect over UDP/],
  ['udp', 'check', { result: { outcome: 'failed' } }, /camera, DNS or STUN/],
  ['udp', 'check', { result: { outcome: 'timeout' } }, /camera, DNS or STUN/],
  ['udp', 'unchecked', { result: { outcome: 'unsupported' } }, /mobile data/],
  ['udp', 'unchecked', { network: 'home', result: { outcome: 'connected', protocol: 'udp' } }, /mobile data/],
  ['udp', 'ok', { result: { outcome: 'connected', protocol: 'UDP' } }, /working forward looks like/],
  ['udp', 'unchecked', { result: { outcome: 'connected', protocol: null } }, /couldn't tell whether it used UDP/],
  ['udp', 'unchecked', { result: { outcome: 'connected' } }, /couldn't tell whether it used UDP/],
  ['udp', 'unchecked', { canTest: false }, /Start a camera, then run the test below/],
  ['public_host', 'unchecked', { setup: { ...setup, public_host_count: 11 } }, /first 1 of your 11/],
  ['cloudflare', 'unchecked', { setup: { ...setup, public_host_count: 11 } }, /needs DNS answers/],
  ['public_host', 'check', { setup: { ...setup, public_host_count: 11, public_hosts: [{ ...host, error: 'timeout', addresses: [] }] } }, /lookup timed out/],
  ['cloudflare', 'check', { setup: { ...setup, public_hosts: [{ ...host, behind_cloudflare: true }, { ...host, host: 'dead.example', error: 'timeout', addresses: [] }] } }, /grey cloud/],
  ['proxy', 'check', { via: 'proxy' }, /stray header/],
  ['proxy', 'unchecked', {}, /No untrusted forwarded address/],
])('%s reaches %s', (id, status, overrides, text) => {
  expect(row(id, overrides)).toMatchObject({ id, status, text: expect.stringMatching(text) });
});

test('every resolved hostname is needed before either DNS row says OK', () => {
  const mixed = { ...setup, public_hosts: [host, { ...host, host: 'empty.example', addresses: [] }] };
  expect(row('public_host', { setup: mixed }).status).toBe('unchecked');
  expect(row('cloudflare', { setup: mixed }).status).toBe('unchecked');
});
