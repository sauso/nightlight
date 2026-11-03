// TRUST_PROXY parsing — issue #248.
//
// ⚠️ THE REASON THIS FILE EXISTS IS AN OUTAGE, NOT A MISCONFIGURATION. `app.set('trust proxy', 'true')`
// THROWS synchronously out of proxy-addr (`invalid IP address: true`). That happens during startup,
// before the server is listening, so the crash guard exits non-zero — and because the bad value is an
// environment variable, the next container start reads the same value and dies identically. One typo
// gives a permanent restart loop on a baby monitor, clearable only by an operator finding the log.
//
// ★ And `true` is the likeliest typo: it is the canonical example in Express's own `trust proxy`
// docs, where the setting takes a real boolean. Here it is a string environment variable.
//
// Found by adversarial review of the PR that introduced the setting. The review also found the parsing
// had NO coverage at all — a mutant removing the numeric coercion survived the entire suite, because
// nothing ever executed index.js or inspected the result.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { parseTrustProxy, applyTrustProxy, DEFAULT_TRUST_PROXY } from '../src/lib/trustProxy.js';
import { isLoopbackAddress, setLoopbackExposed } from '../src/lib/loopbackExposure.js';

afterEach(() => setLoopbackExposed(false));

test('#959 compiled trust function rejects every loopback spelling while exposed', () => {
  // Fails on the old code: its compiled function trusts each loopback hop, including mapped IPv6.
  for (const raw of [undefined, '127.0.0.1', '1', 'true']) {
    const app = express();
    assert.equal(applyTrustProxy(app, raw), parseTrustProxy(raw).value);
    assert.equal(app.get('trust proxy'), parseTrustProxy(raw).value);
    const trust = app.get('trust proxy fn');
    setLoopbackExposed(true);
    for (const addr of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(isLoopbackAddress(addr), true, `${addr} was not recognised`);
      assert.equal(trust(addr, 0), false, `${JSON.stringify(raw)} trusted ${addr}`);
    }
    assert.equal(trust('::ffff:127.255.255.255', 1), false);
    setLoopbackExposed(false);
  }
});

test('#959 compiled trust function preserves non-loopback proxy trust', () => {
  // Fails on the old code's always-trusted loopback, and if the gate blocks LAN proxy hops.
  const app = express();
  applyTrustProxy(app, '10.0.0.20');
  setLoopbackExposed(true);
  assert.equal(app.get('trust proxy fn')('10.0.0.20', 0), true);
  assert.equal(app.get('trust proxy fn')('10.0.0.20', 1), true);
  assert.equal(app.get('trust proxy fn')('127.0.0.1', 1), false);
  assert.equal(app.get('trust proxy fn')('10.0.0.21', 0), false);
  assert.equal(isLoopbackAddress('10.0.0.20'), false);
  const wide = express();
  applyTrustProxy(wide, 'true');
  assert.equal(wide.get('trust proxy fn')('127.0.0.1', 0), false);
  assert.equal(wide.get('trust proxy fn')('10.0.0.20', 1), true);
});

test('#959 flag off retains default loopback trust', () => {
  // Fails if the gate becomes unconditional.
  const app = express();
  applyTrustProxy(app);
  assert.equal(app.get('trust proxy fn')('127.0.0.1', 0), true);
  setLoopbackExposed(true);
  assert.equal(app.get('trust proxy fn')('127.0.0.1', 0), false);
  setLoopbackExposed(false);
  assert.equal(app.get('trust proxy fn')('127.0.0.1', 0), true);
});

test('#959 Express rejection fallback also guards loopback', () => {
  // Fails if only the normal app.set path installs the wrapper.
  const app = express();
  const originalSet = app.set.bind(app);
  let rejected = false;
  app.set = (key, ...values) => {
    if (key === 'trust proxy' && !rejected) {
      rejected = true;
      throw new Error('test rejection');
    }
    return originalSet(key, ...values);
  };
  assert.equal(applyTrustProxy(app, '10.0.0.20'), DEFAULT_TRUST_PROXY);
  assert.equal(app.get('trust proxy'), DEFAULT_TRUST_PROXY);
  setLoopbackExposed(true);
  assert.equal(app.get('trust proxy fn')('127.0.0.1', 0), false);
});

describe('nothing an operator can type takes the app down', () => {
  // ★ THE CASE THAT MATTERS. Each of these went through `app.set` unchecked before, and the ones that
  // throw would have crash-looped the container. Asserting on the real Express machinery rather than a
  // stub, because the throw comes from proxy-addr compiling the value — a stub would not reproduce it.
  const hostile = [
    'true', 'false', 'not-an-ip', 'yes', 'on', 'TRUE', '1.2.3', '999.1.1.1',
    '10.0.0.1/999', 'a/b/c', '::gg', ' ', '', 'localhost', 'proxy.example.com',
  ];

  for (const raw of hostile) {
    test(`TRUST_PROXY=${JSON.stringify(raw)} never throws`, () => {
      const app = express();
      assert.doesNotThrow(() => applyTrustProxy(app, raw), `startup would have crash-looped on ${JSON.stringify(raw)}`);
      // And the resulting value must actually be usable — proxy-addr compiles lazily, so a value that
      // is going to throw does so on the first request, not at set() time.
      assert.doesNotThrow(() => app.get('trust proxy fn'), `${JSON.stringify(raw)} throws on first use`);
    });
  }
});

describe('valid values are honoured exactly', () => {
  test('#753 the unset default is literally loopback', () => {
    // README promises loopback; widening this changes which peers can choose a forwarded client IP.
    assert.equal(DEFAULT_TRUST_PROXY, 'loopback');
    assert.equal(parseTrustProxy(undefined).value, 'loopback');
  });

  test('unset or blank is the previous behaviour, unchanged', () => {
    // The compatibility promise: an existing install must behave exactly as it did before the setting
    // existed. Anything else is a silent change to who can forge a client address.
    for (const raw of [undefined, '', '   ', null]) {
      assert.equal(parseTrustProxy(raw).value, DEFAULT_TRUST_PROXY, `${JSON.stringify(raw)} changed the default`);
    }
  });

  test('★ a bare integer becomes a NUMBER, not a string', () => {
    // Express reads the STRING '1' as an IP address to trust, which matches nothing — so the setting
    // silently does nothing at all, which is the worst outcome: it looks configured and is inert.
    // A mutant removing this coercion survived the whole suite before this test existed.
    for (const raw of ['1', ' 1 ', '01', '2']) {
      const { value } = parseTrustProxy(raw);
      assert.equal(typeof value, 'number', `${JSON.stringify(raw)} stayed a string and is inert`);
    }
    assert.equal(parseTrustProxy('1').value, 1);
    assert.equal(parseTrustProxy('01').value, 1);
  });

  test('an IP, a CIDR, a list and a named range all pass through', () => {
    assert.equal(parseTrustProxy('10.0.0.20').value, '10.0.0.20');
    assert.equal(parseTrustProxy('172.18.0.0/16').value, '172.18.0.0/16');
    assert.equal(parseTrustProxy('10.0.0.20, 172.18.0.0/16').value, '10.0.0.20, 172.18.0.0/16');
    assert.equal(parseTrustProxy('uniquelocal').value, 'uniquelocal');
  });

  test('an invalid value falls back to the default AND says so', () => {
    const { value, warning } = parseTrustProxy('not-an-ip');
    assert.equal(value, DEFAULT_TRUST_PROXY, 'a bad value must not silently become something permissive');
    assert.match(warning, /not a valid value/, 'an operator gets no clue their setting was ignored');
  });

  test('`true` is honoured but never silently — it disables the protection', () => {
    // Honoured because someone typing it meant "trust the proxy", and refusing would be its own
    // surprise. But it trusts EVERY upstream, so any client can forge X-Forwarded-For and pick its own
    // rate-limit bucket — that has to be loud.
    const { value, warning } = parseTrustProxy('true');
    assert.equal(value, true);
    assert.match(warning, /forge X-Forwarded-For/, '`true` was accepted with no warning at all');
  });

  test('a partly-bad list is rejected whole, not partly applied', () => {
    // Applying the good half of a list would trust some upstreams the operator did not intend to
    // separate out, which is a silent half-configuration.
    const { value, warning } = parseTrustProxy('10.0.0.20, garbage');
    assert.equal(value, DEFAULT_TRUST_PROXY);
    assert.match(warning, /garbage/, 'the warning does not name the offending entry');
  });
});
