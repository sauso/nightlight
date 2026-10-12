// The Content-Security-Policy, and Cloudflare Web Analytics as an opt-in (#562 bullet 6).
//
// THE CHANGE. Until #562 the policy allowed Cloudflare's beacon origins (script-src and connect-src) on every
// install, "by choice". It is now allowed only when CLOUDFLARE_ANALYTICS is on; every other directive and
// helmet option must be exactly what it was. So the expected values below are COPIED from index.js at
// origin/dev 528e58a, not derived from the code under test: a builder that drops, adds or reorders anything
// else fails here.
//
// THE WIRING (plan review 2026-10-13: the builder's tests can all pass while the live header still comes from
// a hard-coded copy in index.js). index.js cannot be booted by a test (it spawns MediaMTX, MQTT and an HTTP
// listener; route-permissions.test.js and suite-exits-cleanly.test.js rest on that). A subprocess boot was
// considered and rejected: it would launch a real MediaMTX wherever one is on PATH, bind fixed ports, and on
// Windows a kill leaves that grandchild running. What this file does instead, in the "wiring" block:
//   - takes the argument index.js passes to helmet() FROM ITS SOURCE TEXT and evaluates it with the real
//     builder, a chosen environment and a recording logger, then serves the result through a real helmet and
//     reads the header back. So a hard-coded object, a wrong env (`{}`) or a dropped logger in index.js fails
//     on BEHAVIOUR, not on spelling;
//   - pins that this expression is the only helmet() call and is registered with app.use (route-permissions
//     also pins `use helmet()` as the first registration), and that no source file but lib/cspDirectives.js
//     names a Cloudflare origin.
// ⚠️ NOT COVERED: the header a running container actually sends. That remains a source-level pin plus a real
// helmet in a test app; it is not a boot of index.js.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { tokenize } from './helpers/routeTable.js';
import { walkSources } from './helpers/sourceScan.js';
import {
  buildCspDirectives, buildHelmetOptions, parseCloudflareAnalytics,
  CLOUDFLARE_SCRIPT_ORIGIN, CLOUDFLARE_BEACON_ORIGIN,
} from '../src/lib/cspDirectives.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(HERE, '..', 'src', 'index.js');

// Verbatim from backend/src/index.js at origin/dev 528e58a (before #562). Do not "update" this to match the
// code: it is the reference the change is measured against.
const PREVIOUS_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", 'https://static.cloudflareinsights.com'],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  mediaSrc: ["'self'", 'blob:'],
  workerSrc: ["'self'", 'blob:'],
  connectSrc: ["'self'", 'stun.l.google.com:19302', 'https://cloudflareinsights.com'],
  fontSrc: ["'self'", 'data:'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  reportUri: ['/api/csp-report'],
};
const CF_ORIGINS = ['https://static.cloudflareinsights.com', 'https://cloudflareinsights.com'];
const EXPECTED_DEFAULT = Object.fromEntries(
  Object.entries(PREVIOUS_DIRECTIVES).map(([k, v]) => [k, v.filter((s) => !CF_ORIGINS.includes(s))]),
);

// The header helmet serves for each, written out by hand so a serialisation change is visible too.
const DEFAULT_HEADER = "default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;" +
  "media-src 'self' blob:;worker-src 'self' blob:;connect-src 'self' stun.l.google.com:19302;" +
  "font-src 'self' data:;object-src 'none';base-uri 'self';form-action 'self';frame-ancestors 'none';" +
  'report-uri /api/csp-report';
const PREVIOUS_HEADER = "default-src 'self';script-src 'self' https://static.cloudflareinsights.com;" +
  "style-src 'self';img-src 'self' data:;media-src 'self' blob:;worker-src 'self' blob:;" +
  "connect-src 'self' stun.l.google.com:19302 https://cloudflareinsights.com;font-src 'self' data:;" +
  "object-src 'none';base-uri 'self';form-action 'self';frame-ancestors 'none';report-uri /api/csp-report";

// Hostile environment: names a careless lookup could read instead of the real one, each set to "on". None of
// them may switch the allowance on.
const DECOYS = {
  CLOUDFLARE_ANALYTICS_ENABLED: '1', cloudflare_analytics: 'true', CF_ANALYTICS: 'yes', CLOUDFLARE: 'on',
  ANALYTICS: '1', CLOUDFLARE_WEB_ANALYTICS: 'true',
};

const ON_SPELLINGS = ['1', 'true', 'yes', 'on', 'TRUE', 'Yes ', ' On', '\tyes\n', 'YES', 'tRuE'];
const QUIET_OFF = [undefined, '', '   ', '0', 'false', 'no', 'off', 'FALSE', ' No ', 'OFF'];
const UNRECOGNISED = ['enabled', 'maybe', 'ture', '2', 'y', 'yes please', '1 1', 'on;', '"1"', '01', 'true!'];

function recorder() {
  const calls = { warn: [], info: [] };
  return { calls, log: { warn: (m) => calls.warn.push(m), info: (m) => calls.info.push(m) } };
}

const servers = [];
after(async () => { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))); });

/** Serve helmet(options) on a bare app and return the Content-Security-Policy header it sends. */
async function servedCsp(options) {
  const app = express();
  app.use(helmet(options));
  app.get('/x', (_req, res) => res.send('ok'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/x`);
  await res.text();
  return res.headers.get('content-security-policy');
}

describe('#562 CSP the reference values are what this file says they are', () => {
  test('#562 CSP reference: the copied policy holds each Cloudflare origin exactly once, and the default drops exactly those two', () => {
    // Guards the fixture itself: if the filter above removed nothing, EXPECTED_DEFAULT would equal the old
    // policy and the default test would be checking the wrong thing.
    const flat = Object.values(PREVIOUS_DIRECTIVES).flat();
    for (const o of CF_ORIGINS) assert.equal(flat.filter((s) => s === o).length, 1, o);
    assert.equal(Object.values(EXPECTED_DEFAULT).flat().length, flat.length - 2);
    assert.deepEqual([CLOUDFLARE_SCRIPT_ORIGIN, CLOUDFLARE_BEACON_ORIGIN], CF_ORIGINS);
  });
});

describe('#562 CSP default: Cloudflare is blocked and nothing else moved', () => {
  test('#562 CSP default: unset, blank and decoy variables give the old policy minus the two Cloudflare origins, exactly', () => {
    for (const env of [{}, { CLOUDFLARE_ANALYTICS: '' }, { CLOUDFLARE_ANALYTICS: '  ' }, DECOYS]) {
      const d = buildCspDirectives(env);
      assert.deepEqual(d, EXPECTED_DEFAULT, JSON.stringify(env));
      assert.doesNotMatch(JSON.stringify(d), /cloudflareinsights/i, JSON.stringify(env));
    }
  });

  test('#562 CSP default: buildHelmetOptions is the whole helmet options object, nothing more', () => {
    // Deep-equal on the OUTER object too: a helmet option added or dropped here changes every other header
    // the app sends, and index.js now passes this object as it is.
    assert.deepEqual(buildHelmetOptions({}), { contentSecurityPolicy: { useDefaults: false, directives: EXPECTED_DEFAULT } });
    assert.deepEqual(buildHelmetOptions(DECOYS), { contentSecurityPolicy: { useDefaults: false, directives: EXPECTED_DEFAULT } });
  });

  test('#562 CSP default: with no argument the builders read process.env', () => {
    const saved = process.env.CLOUDFLARE_ANALYTICS;
    try {
      delete process.env.CLOUDFLARE_ANALYTICS;
      assert.deepEqual(buildCspDirectives(), EXPECTED_DEFAULT);
      assert.deepEqual(buildHelmetOptions().contentSecurityPolicy.directives, EXPECTED_DEFAULT);
      process.env.CLOUDFLARE_ANALYTICS = 'yes';
      assert.deepEqual(buildCspDirectives(), PREVIOUS_DIRECTIVES);
      assert.deepEqual(buildHelmetOptions().contentSecurityPolicy.directives, PREVIOUS_DIRECTIVES);
    } finally {
      if (saved === undefined) delete process.env.CLOUDFLARE_ANALYTICS; else process.env.CLOUDFLARE_ANALYTICS = saved;
    }
  });

  test('#562 CSP default: every call returns fresh arrays, so mutating one result cannot loosen the next', () => {
    const first = buildCspDirectives({});
    first.scriptSrc.push('https://evil.example');
    first.connectSrc.push('*');
    assert.deepEqual(buildCspDirectives({}), EXPECTED_DEFAULT);
  });
});

describe('#562 CSP on: the old policy, byte for byte', () => {
  test('#562 CSP on: every ON spelling restores exactly the pre-#562 directives, origins at their old positions', () => {
    for (const v of ON_SPELLINGS) {
      assert.deepEqual(buildCspDirectives({ ...DECOYS, CLOUDFLARE_ANALYTICS: v }), PREVIOUS_DIRECTIVES, JSON.stringify(v));
    }
  });
});

describe('#562 CSP parse: what counts as on, off, and a typo', () => {
  test('#562 CSP parse: 1/true/yes/on, trimmed and in any case, are ON with no warning', () => {
    for (const v of ON_SPELLINGS) assert.deepEqual(parseCloudflareAnalytics(v), { enabled: true, warning: null }, JSON.stringify(v));
  });

  test('#562 CSP parse: unset, blank and 0/false/no/off are OFF with no warning', () => {
    for (const v of QUIET_OFF) assert.deepEqual(parseCloudflareAnalytics(v), { enabled: false, warning: null }, JSON.stringify(v));
    // Not a string at all (a test or a caller passing something odd) is the default, not a crash.
    for (const v of [null, 1, true, {}]) assert.deepEqual(parseCloudflareAnalytics(v), { enabled: false, warning: null }, String(v));
  });

  test('#562 CSP parse: an unrecognised value is OFF, fails closed, and says so naming the value', () => {
    for (const v of UNRECOGNISED) {
      const r = parseCloudflareAnalytics(v);
      assert.equal(r.enabled, false, `${JSON.stringify(v)} switched the allowance ON`);
      assert.match(r.warning ?? '', /^CLOUDFLARE_ANALYTICS=".*" is not a recognised value/, JSON.stringify(v));
      assert.ok(r.warning.includes(JSON.stringify(v.trim())), `the warning does not name ${JSON.stringify(v)}`);
      assert.match(r.warning, /stays BLOCKED/);
      assert.deepEqual(buildCspDirectives({ CLOUDFLARE_ANALYTICS: v }), EXPECTED_DEFAULT, JSON.stringify(v));
    }
  });
});

describe('#562 CSP log: one line at start, only when there is something to say', () => {
  test('#562 CSP log: an unrecognised value logs exactly one warning and no info line', () => {
    const { calls, log } = recorder();
    buildHelmetOptions({ CLOUDFLARE_ANALYTICS: 'maybe' }, log);
    assert.equal(calls.warn.length, 1);
    assert.match(calls.warn[0], /^\[http\] CLOUDFLARE_ANALYTICS="maybe" is not a recognised value/);
    assert.equal(calls.info.length, 0);
  });

  test('#562 CSP log: ON logs one info line and no warning', () => {
    const { calls, log } = recorder();
    buildHelmetOptions({ CLOUDFLARE_ANALYTICS: ' TRUE ' }, log);
    assert.deepEqual(calls.warn, []);
    assert.deepEqual(calls.info, ['[http] CSP allows Cloudflare Web Analytics (CLOUDFLARE_ANALYTICS is on)']);
  });

  test('#562 CSP log: unset, blank and a recognised OFF log nothing', () => {
    for (const v of QUIET_OFF) {
      const { calls, log } = recorder();
      buildHelmetOptions(v === undefined ? {} : { CLOUDFLARE_ANALYTICS: v }, log);
      assert.deepEqual(calls, { warn: [], info: [] }, JSON.stringify(v));
    }
  });
});

describe('#562 CSP header: what a real helmet serves from these options', () => {
  test('#562 CSP header: the default policy as served has no Cloudflare origin', async () => {
    assert.equal(await servedCsp(buildHelmetOptions({})), DEFAULT_HEADER);
  });

  test('#562 CSP header: ON serves the pre-#562 header exactly', async () => {
    assert.equal(await servedCsp(buildHelmetOptions({ CLOUDFLARE_ANALYTICS: 'on' })), PREVIOUS_HEADER);
  });
});

// ---- the wiring: index.js really serves this --------------------------------------------------------------

const INDEX_SRC = fs.readFileSync(INDEX, 'utf8');
const TOKS = tokenize(INDEX_SRC);
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

function matchingClose(open) {
  let depth = 0;
  for (let j = open; j < TOKS.length; j++) {
    const t = TOKS[j];
    if (t.t !== 'p') continue;
    if (OPEN.has(t.v)) depth++;
    if (CLOSE.has(t.v) && --depth === 0) return j;
  }
  throw new Error('unbalanced brackets in index.js');
}

/** Named imports, `import { a, b as c } from 'x'` → Map(local -> specifier). */
function namedImports() {
  const out = new Map();
  for (let k = 0; k < TOKS.length; k++) {
    if (!(TOKS[k].t === 'id' && TOKS[k].v === 'import' && TOKS[k + 1]?.v === '{')) continue;
    const close = matchingClose(k + 1);
    const spec = TOKS[close + 1]?.v === 'from' ? TOKS[close + 2]?.v : undefined;
    // Split on commas; `a as b` binds b, plain `a` binds a. Only the local name matters here.
    let group = [];
    for (const t of [...TOKS.slice(k + 2, close), { t: 'p', v: ',' }]) {
      if (t.t === 'p' && t.v === ',') {
        if (group.length) out.set(group.at(-1).v, spec);
        group = [];
      } else if (t.t === 'id' && t.v !== 'as') group.push(t);
    }
  }
  return out;
}

/** The one `helmet(...)` call: its argument text, and what surrounds it. */
function helmetCall() {
  const calls = [];
  for (let k = 0; k < TOKS.length; k++) {
    if (TOKS[k].t === 'id' && TOKS[k].v === 'helmet' && TOKS[k - 1]?.v !== '.' && TOKS[k + 1]?.v === '(') calls.push(k);
  }
  assert.equal(calls.length, 1, `index.js must call helmet() exactly once; found ${calls.length}`);
  const [k] = calls;
  const close = matchingClose(k + 1);
  return {
    argText: INDEX_SRC.slice(TOKS[k + 1].at + 1, TOKS[close].at),
    before: TOKS.slice(k - 4, k).map((t) => t.v).join(' '),
    after: TOKS.slice(close + 1, close + 3).map((t) => t.v).join(' '),
  };
}

/**
 * Evaluate index.js's own argument to helmet() with the real builder, `process.env` = env and `logger` = a
 * recorder. Any other free identifier in that expression throws a ReferenceError, which fails the test with
 * the expression in the message: extend this on purpose rather than loosening it.
 */
function evaluateIndexHelmetArgument(env) {
  const { argText } = helmetCall();
  const { calls, log } = recorder();
  // eslint-disable-next-line no-new-func
  const fn = new Function('buildHelmetOptions', 'process', 'logger', `"use strict"; return (${argText});`);
  let options;
  try {
    options = fn(buildHelmetOptions, { env }, log);
  } catch (err) {
    throw new Error(`index.js's helmet() argument \`${argText.trim()}\` could not be evaluated here: ${err.message}`);
  }
  return { options, calls };
}

describe('#562 CSP wiring: index.js serves the builder\'s policy, with the real environment and logger', () => {
  test('#562 CSP wiring: index.js imports helmet, the builder and the logger from where this test assumes', () => {
    assert.match(INDEX_SRC, /^import helmet from 'helmet';\r?$/m);
    const named = namedImports();
    assert.equal(named.get('buildHelmetOptions'), './lib/cspDirectives.js');
    assert.equal(named.get('logger'), './lib/logger.js');
  });

  test('#562 CSP wiring: the one helmet() call is registered with app.use, as the whole argument', () => {
    const { before, after: rest } = helmetCall();
    assert.equal(before, 'app . use (', 'helmet(...) must be the argument of app.use(...)');
    assert.equal(rest, ') ;', 'app.use(helmet(...)) must have no second argument');
  });

  test('#562 CSP wiring: index.js\'s own helmet() argument, evaluated with no setting, serves the default header', async () => {
    const { options, calls } = evaluateIndexHelmetArgument({ ...DECOYS });
    assert.deepEqual(options, { contentSecurityPolicy: { useDefaults: false, directives: EXPECTED_DEFAULT } });
    assert.equal(await servedCsp(options), DEFAULT_HEADER);
    assert.deepEqual(calls, { warn: [], info: [] });
  });

  test('#562 CSP wiring: the environment reaches the builder (ON in process.env serves the old header)', async () => {
    // Kills index.js passing `{}`, a literal object, or anything but process.env.
    const { options } = evaluateIndexHelmetArgument({ CLOUDFLARE_ANALYTICS: 'yes' });
    assert.equal(await servedCsp(options), PREVIOUS_HEADER);
  });

  test('#562 CSP wiring: the logger reaches the builder (a typo logs its one warning at start)', () => {
    // Kills index.js dropping the logger argument: the setting would then fail closed in silence.
    const { calls } = evaluateIndexHelmetArgument({ CLOUDFLARE_ANALYTICS: 'enabled' });
    assert.equal(calls.warn.length, 1);
    assert.match(calls.warn[0], /CLOUDFLARE_ANALYTICS="enabled" is not a recognised value/);
  });

  test('#562 CSP wiring: no Cloudflare origin and no inline policy anywhere in index.js or any other source file', () => {
    assert.doesNotMatch(INDEX_SRC, /cloudflareinsights/i, 'index.js names a Cloudflare origin again');
    assert.ok(!TOKS.some((t) => t.t === 'id' && t.v === 'contentSecurityPolicy'), 'index.js builds a CSP of its own again');
    const others = walkSources().filter(({ rel, src }) => rel !== 'lib/cspDirectives.js' && /cloudflareinsights/i.test(src));
    assert.deepEqual(others.map((o) => o.rel), [], 'only lib/cspDirectives.js may name a Cloudflare origin');
  });
});
