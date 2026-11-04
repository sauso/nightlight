import assert from 'node:assert/strict';
import { detectHostNetwork } from '../backend/src/lib/hostNetwork.js';

const result = detectHostNetwork();
console.log(JSON.stringify(result));
try {
  if (process.argv[2] === 'host') {
    assert.equal(result.host, true);
    assert.ok(result.evidence.includes('physical_nic'));
    assert.ok(result.evidence.includes('host_iface_name'));
  } else if (process.argv[2] === 'bridge') {
    assert.deepEqual(result, { host: false, evidence: [], unknown: null });
  } else if (process.argv[2] === 'shared') {
    assert.equal(result.host, true);
    assert.ok(result.evidence.includes('foreign_listener'));
  } else {
    throw Error('A probe mode is required.');
  }
} catch (err) {
  // Opus fix review of #967: distinguish a wrong detector result from a
  // runner that cannot start an optional network's container.
  console.error(err);
  process.exitCode = 42;
}
