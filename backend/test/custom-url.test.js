import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomUrl, customUrl } from '../src/lib/customUrl.js';
import { logger } from '../src/lib/logger.js';

const original = process.env.CUSTOM_URL;
afterEach(() => {
  if (original === undefined) delete process.env.CUSTOM_URL;
  else process.env.CUSTOM_URL = original;
});

test('CUSTOM_URL accepts only canonical HTTPS DNS origins', () => {
  const max = Array(4).fill('a'.repeat(61)).join('.');
  for (const [raw, url] of [
    [undefined, null], ['', null], ['  ', null],
    [' HTTPS://Example.COM:8443/ ', 'https://example.com:8443'],
    ['https://example.com:443', 'https://example.com'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
    [`https://${'a'.repeat(63)}.example`, `https://${'a'.repeat(63)}.example`],
    [`https://${max}`, `https://${max}`],
    ['https://example.com:1', 'https://example.com:1'],
    ['https://example.com:65535', 'https://example.com:65535'],
  ]) assert.deepEqual(parseCustomUrl(raw), { url, warning: null }, String(raw));
});

test('CUSTOM_URL refuses unsafe shapes before URL canonicalisation', () => {
  const max = Array(4).fill('a'.repeat(61)).join('.');
  for (const raw of [
    'http://example.com', 'https://', 'https://example.com/path', 'https://example.com//',
    'https://example.com?x=1', 'https://example.com#x', 'https://u:p@example.com',
    'https://exa mple.com', 'https://example.com,https://other.example',
    'https://example.com:0', 'https://example.com:65536', 'https://localhost',
    'https://hello.local', 'https://hello.ts.net', 'https://ts.net',
    'https://192.168.1.1', 'https://[2001:db8::1]', 'https://bare',
    'https://bad_name.example', 'https://bad..example', 'https://example.com.',
    'https://hello.ts.net.', 'https://hello.local.', 'https://-bad.example', 'https://bad-.example',
    `https://${'a'.repeat(64)}.example`, `https://${'a'.repeat(62)}.${'b'.repeat(62)}.${'c'.repeat(62)}.${'d'.repeat(62)}`,
    'https://bücher.example', `https://${max}/`, // 256 chars after the slash
  ]) {
    // A single final slash is allowed even at the length limit only if the whole string remains <=255.
    const parsed = parseCustomUrl(raw);
    assert.equal(parsed.url, null, raw);
    assert.match(parsed.warning, /^CUSTOM_URL .*ignored:/, raw);
  }
});

test('CUSTOM_URL reads the environment at call time and warns once for each bad value', () => {
  const warn = mock.method(logger, 'warn', () => {});
  try {
    process.env.CUSTOM_URL = 'https://one.example';
    assert.equal(customUrl(), 'https://one.example');
    process.env.CUSTOM_URL = 'http://invalid.example';
    assert.equal(customUrl(), null);
    assert.equal(customUrl(), null);
    process.env.CUSTOM_URL = 'https://bad.local';
    assert.equal(customUrl(), null);
    assert.equal(warn.mock.callCount(), 2);
  } finally { warn.mock.restore(); }
});
