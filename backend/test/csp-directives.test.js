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
//   - takes the arguments index.js passes to helmet() FROM ITS SOURCE TEXT and evaluates them with a spy on the
//     real builder, a chosen environment and a recording logger, then serves the result through a real helmet
//     and reads the header back. So a hard-coded object, an edited copy of the builder's result, a wrong env
//     (`{}`) or a dropped logger in index.js fails on BEHAVIOUR, not on spelling;
//   - pins, on tokens rather than exact text (a reformat must not fail it), that this is the only helmet() call
//     and the whole of an app.use(...) (route-permissions also pins `use helmet()` as the first registration);
//   - scans backend/src: no file but lib/cspDirectives.js names a Cloudflare origin (comments included), and no
//     code but that file names the Content-Security-Policy header or helmet's option for it (comments
//     excluded). The frontend sources are not scanned.
// ⚠️ NOT COVERED: the header a running container actually sends. That remains a source-level pin plus a real
// helmet in a test app; it is not a boot of index.js. Nor a policy set by something outside backend/src (a
// reverse proxy, a meta tag added to the frontend).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { tokenize } from './helpers/routeTable.js';
import { walkSources, stripCommentsOnly } from './helpers/sourceScan.js';
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
// Words an operator might plausibly type for "on" that are NOT on (fix round 1: the ON set must be pinned
// exactly, so a widened set fails here), plus typos. Every one is off, and warns.
const UNRECOGNISED = [
  'ok', 'enable', 'enabled', 'allow', 'y', 't', 'yep', '1.0', 'on!', 'true1',
  'maybe', 'ture', '2', 'yes please', '1 1', 'on;', '"1"', '01', 'true!', 'disabled',
];
// The exact ON set, lower-cased and trimmed. Nothing else may switch it on.
const ON_EXACTLY = new Set(['1', 'true', 'yes', 'on']);

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

  test('#562 CSP parse: the ON set is exactly 1/true/yes/on, nothing near it switches it on', () => {
    for (const v of [...ON_SPELLINGS, ...QUIET_OFF, ...UNRECOGNISED]) {
      const expected = typeof v === 'string' && ON_EXACTLY.has(v.trim().toLowerCase());
      assert.equal(parseCloudflareAnalytics(v).enabled, expected, JSON.stringify(v));
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

  test('#562 CSP log: every unrecognised word, "ok", "enable" and "disabled" included, warns exactly once', () => {
    for (const v of UNRECOGNISED) {
      const { calls, log } = recorder();
      buildHelmetOptions({ CLOUDFLARE_ANALYTICS: v }, log);
      assert.equal(calls.warn.length, 1, JSON.stringify(v));
      assert.equal(calls.info.length, 0, JSON.stringify(v));
    }
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

// Everything below works on TOKENS (helpers/routeTable.js's tokenizer: comments dropped, strings and regexes
// understood), not on the exact text, so an innocent reformat of index.js (double quotes, no semicolons, the
// call split over lines, a trailing comma) does not fail it, while a real change does (fix round 1). Each check
// returns its problems instead of asserting, so the fixtures further down can prove it fails when it should.

const INDEX_SRC = fs.readFileSync(INDEX, 'utf8');
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

function matchingClose(toks, open) {
  let depth = 0;
  for (let j = open; j < toks.length; j++) {
    const t = toks[j];
    if (t.t !== 'p') continue;
    if (OPEN.has(t.v)) depth++;
    if (CLOSE.has(t.v) && --depth === 0) return j;
  }
  throw new Error('unbalanced brackets');
}

/** Every import binding: `import x from 'y'` and `import { a, b as c } from 'y'` → Map(local -> specifier). */
function importsOf(toks) {
  const out = new Map();
  for (let k = 0; k < toks.length; k++) {
    if (!(toks[k].t === 'id' && toks[k].v === 'import')) continue;
    if (toks[k + 1]?.t === 'id' && toks[k + 2]?.v === 'from' && toks[k + 3]?.t === 'str') {
      out.set(toks[k + 1].v, toks[k + 3].v);
      continue;
    }
    if (toks[k + 1]?.v !== '{') continue;
    const close = matchingClose(toks, k + 1);
    const spec = toks[close + 1]?.v === 'from' ? toks[close + 2]?.v : undefined;
    // Split on commas; `a as b` binds b, plain `a` binds a. Only the local name matters here.
    let group = [];
    for (const t of [...toks.slice(k + 2, close), { t: 'p', v: ',' }]) {
      if (t.t === 'p' && t.v === ',') {
        if (group.length) out.set(group.at(-1).v, spec);
        group = [];
      } else if (t.t === 'id' && t.v !== 'as') group.push(t);
    }
  }
  return out;
}

/** What the evaluation below assumes about where its three names come from. */
function importProblems(src) {
  const imports = importsOf(tokenize(src));
  const want = { helmet: 'helmet', buildHelmetOptions: './lib/cspDirectives.js', logger: './lib/logger.js' };
  return Object.entries(want)
    .filter(([name, spec]) => imports.get(name) !== spec)
    .map(([name, spec]) => `\`${name}\` is not imported from '${spec}' (found: ${imports.get(name) ?? 'nothing'})`);
}

/**
 * Check that `src` registers helmet exactly as `app.use(helmet(<args>))` and evaluate <args>, taken from the
 * source text, with a spy around the real builder, `process.env` = env and `logger` = a recorder. Any other
 * free identifier in the arguments throws a ReferenceError, reported as a problem: extend this on purpose
 * rather than loosening it. Returns { problems, options, calls }.
 */
function helmetWiring(src, env) {
  const toks = tokenize(src);
  const problems = [];
  const at = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t === 'id' && toks[k].v === 'helmet' && toks[k - 1]?.v !== '.' && toks[k + 1]?.v === '(') at.push(k);
  }
  if (at.length !== 1) return { problems: [`helmet() is called ${at.length} times; expected exactly once`] };
  const [k] = at;
  const close = matchingClose(toks, k + 1);
  if (toks.slice(k - 4, k).map((t) => t.v).join(' ') !== 'app . use (') {
    problems.push('helmet(...) is not the first argument of app.use(...)');
  }
  // After helmet(...) comes app.use's own `)`, optionally after a trailing comma. Anything else is a second
  // argument to app.use: a middleware that could set or change the policy after helmet has.
  let n = close + 1;
  if (toks[n]?.v === ',') n += 1;
  if (toks[n]?.v !== ')') problems.push('app.use(helmet(...)) has a second argument');

  const argText = src.slice(toks[k + 1].at + 1, toks[close].at);
  const { calls, log } = recorder();
  const built = [];
  const spy = (...a) => { const o = buildHelmetOptions(...a); built.push(o); return o; };
  let args;
  try {
    // An array literal, so a trailing comma inside helmet( ... , ) is still valid, and every argument is seen.
    // eslint-disable-next-line no-new-func
    args = new Function('buildHelmetOptions', 'process', 'logger', `"use strict"; return [${argText}];`)(spy, { env }, log);
  } catch (err) {
    problems.push(`helmet()'s arguments \`${argText.trim()}\` could not be evaluated here: ${err.message}`);
    return { problems };
  }
  if (args.length !== 1) problems.push(`helmet() gets ${args.length} arguments; expected exactly one`);
  if (built.length !== 1) problems.push(`buildHelmetOptions is called ${built.length} times in helmet()'s arguments; expected once`);
  // The very object the builder returned, not a copy or an edit of it ({ ...built, contentSecurityPolicy: … }).
  else if (args[0] !== built[0]) problems.push("helmet()'s argument is not buildHelmetOptions's own result");
  return { problems, options: args[0], calls };
}

// The CSP header, or helmet's option for it, named in CODE (strings and identifiers; comments are stripped,
// since index.js's comment pointing at the module is fine). No file is allow-listed but lib/cspDirectives.js:
// checked 2026-10-13, the /api/csp-report route names neither (it reads the report body as text).
const NAMES_CSP = /content[-_ ]?security[-_ ]?policy/i;
function cspNamedOutsideTheModule(sources) {
  return sources.filter(({ rel, src }) => rel !== 'lib/cspDirectives.js' && NAMES_CSP.test(stripCommentsOnly(src))).map((s) => s.rel);
}
function cloudflareNamedOutsideTheModule(sources) {
  return sources.filter(({ rel, src }) => rel !== 'lib/cspDirectives.js' && /cloudflareinsights/i.test(src)).map((s) => s.rel);
}

describe('#562 CSP wiring: index.js serves the builder\'s policy, with the real environment and logger', () => {
  test('#562 CSP wiring: index.js imports helmet, the builder and the logger from where this test assumes', () => {
    assert.deepEqual(importProblems(INDEX_SRC), []);
  });

  test('#562 CSP wiring: the one helmet() call is app.use(helmet(buildHelmetOptions(...))), nothing beside it', () => {
    assert.deepEqual(helmetWiring(INDEX_SRC, {}).problems, []);
  });

  test('#562 CSP wiring: index.js\'s own helmet() argument, evaluated with no setting, serves the default header', async () => {
    const { problems, options, calls } = helmetWiring(INDEX_SRC, { ...DECOYS });
    assert.deepEqual(problems, []);
    assert.deepEqual(options, { contentSecurityPolicy: { useDefaults: false, directives: EXPECTED_DEFAULT } });
    assert.equal(await servedCsp(options), DEFAULT_HEADER);
    assert.deepEqual(calls, { warn: [], info: [] });
  });

  test('#562 CSP wiring: the environment reaches the builder (ON in process.env serves the old header)', async () => {
    // Kills index.js passing `{}`, a literal object, or anything but process.env.
    const { options } = helmetWiring(INDEX_SRC, { CLOUDFLARE_ANALYTICS: 'yes' });
    assert.equal(await servedCsp(options), PREVIOUS_HEADER);
  });

  test('#562 CSP wiring: the logger reaches the builder (a typo logs its one warning at start)', () => {
    // Kills index.js dropping the logger argument: the setting would then fail closed in silence.
    const { calls } = helmetWiring(INDEX_SRC, { CLOUDFLARE_ANALYTICS: 'enabled' });
    assert.equal(calls.warn.length, 1);
    assert.match(calls.warn[0], /CLOUDFLARE_ANALYTICS="enabled" is not a recognised value/);
  });

  test('#562 CSP wiring scan: no file in backend/src but lib/cspDirectives.js names a Cloudflare origin (comments included; frontend sources are not scanned)', () => {
    assert.deepEqual(cloudflareNamedOutsideTheModule(walkSources()), [], 'only lib/cspDirectives.js may name a Cloudflare origin');
  });

  test('#562 CSP wiring scan: no code in backend/src but lib/cspDirectives.js names the Content-Security-Policy header or helmet\'s option for it (comments excluded; frontend sources are not scanned)', () => {
    assert.deepEqual(cspNamedOutsideTheModule(walkSources()), [], 'a second place builds or sets a CSP');
  });
});

describe('#562 CSP wiring checks can fail, and do not fail on a reformat', () => {
  const HEAD = [
    'import helmet from "helmet"',
    'import { buildHelmetOptions } from "./lib/cspDirectives.js"',
    'import { logger as logger } from \'./lib/logger.js\'',
    'const app = express()',
  ].join('\n');

  test('#562 CSP wiring fixtures: double quotes, no semicolons, a multi-line call and trailing commas pass', async () => {
    const src = `${HEAD}\napp.use(\n  helmet(\n    buildHelmetOptions(\n      process.env,\n      logger,\n    ),\n  ),\n)\n`;
    assert.deepEqual(importProblems(src), []);
    const { problems, options } = helmetWiring(src, {});
    assert.deepEqual(problems, []);
    assert.equal(await servedCsp(options), DEFAULT_HEADER);
  });

  test('#562 CSP wiring fixtures: each real change is reported', () => {
    const cases = [
      ['an inline policy', 'app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["\'self\'"] } } }))', /buildHelmetOptions is called 0 times/],
      ['an edited copy of the builder\'s result', 'app.use(helmet({ ...buildHelmetOptions(process.env, logger), contentSecurityPolicy: false }))', /not buildHelmetOptions's own result/],
      ['a second helmet argument', 'app.use(helmet(buildHelmetOptions(process.env, logger), { contentSecurityPolicy: false }))', /gets 2 arguments/],
      ['a second app.use argument', 'app.use(helmet(buildHelmetOptions(process.env, logger)), (req, res, next) => next())', /has a second argument/],
      ['helmet built aside, then used', 'const h = helmet(buildHelmetOptions(process.env, logger))\napp.use(h)', /not the first argument of app\.use/],
      ['two helmet calls', 'app.use(helmet(buildHelmetOptions(process.env, logger)))\napp.use(helmet())', /called 2 times/],
      ['no options at all', 'app.use(helmet())', /gets 0 arguments/],
      ['a free name the test does not provide', 'app.use(helmet(buildHelmetOptions(otherEnv, logger)))', /could not be evaluated/],
    ];
    for (const [label, body, expected] of cases) {
      const { problems } = helmetWiring(`${HEAD}\n${body}\n`, {});
      assert.ok(problems.some((p) => expected.test(p)), `${label}: expected ${expected}, got ${JSON.stringify(problems)}`);
    }
  });

  test('#562 CSP wiring fixtures: an import from somewhere else is reported', () => {
    assert.match(importProblems('import helmet from "helmet-lookalike"\n').join('\n'), /`helmet` is not imported from 'helmet'/);
    assert.match(importProblems("import { buildHelmetOptions } from './lib/other.js'\n").join('\n'), /buildHelmetOptions/);
  });

  test('#562 CSP wiring fixtures: the scans see code and ignore comments', () => {
    const files = [
      { rel: 'lib/cspDirectives.js', src: "const x = 'Content-Security-Policy'; const y = 'https://cloudflareinsights.com';" },
      { rel: 'routes/a.js', src: "res.set('Content-Security-Policy', \"default-src *\");" },
      { rel: 'routes/b.js', src: 'app.use(helmet.contentSecurityPolicy({ directives: {} }));' },
      { rel: 'routes/c.js', src: "res.setHeader('content-security-policy-report-only', x);" },
      { rel: 'routes/d.js', src: '// Content-Security-Policy is set by lib/cspDirectives.js\n/* contentSecurityPolicy */\nconst ok = 1;' },
      { rel: 'routes/e.js', src: "const beacon = 'https://static.cloudflareinsights.com/beacon.min.js';" },
    ];
    assert.deepEqual(cspNamedOutsideTheModule(files), ['routes/a.js', 'routes/b.js', 'routes/c.js']);
    assert.deepEqual(cloudflareNamedOutsideTheModule(files), ['routes/e.js']);
  });
});
