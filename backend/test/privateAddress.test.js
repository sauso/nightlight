import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateLanIPv4 } from '../src/lib/privateAddress.js';

test('accepts only literal private or link-local dotted-quad IPv4', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254',
    '192.168.1.1', '169.254.1.2']) assert.equal(isPrivateLanIPv4(ip), true, ip);
  for (const ip of ['127.0.0.1', '8.8.8.8', '172.15.0.1', '172.32.0.1',
    '192.169.1.1', '169.253.1.1', '::1', '::ffff:192.168.1.1', '010.0.0.1',
    '192.168.1.1:80', '192.168.1.256', 'cam-a', '', ' 10.0.0.1', '1.2.3', null, 42]) {
    assert.equal(isPrivateLanIPv4(ip), false, String(ip));
  }
});
