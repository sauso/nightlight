// STUN_SERVERS (#558): one setting, three consumers.
//
// THE DEFECT. Google's public STUN server was written into the browser (WhepPlayer.jsx), MediaMTX
// (mediamtx.yml) and the CSP's connect-src (cspDirectives.js) by hand. Each STUN request tells the operator of
// that server the viewer's public IP and when each live view connected, README.md said "no cloud", and there
// was no way to turn it off.
//
// WHAT THIS FILE PINS.
//   1. parseStunServers: unset = Google (exactly the old value), blank = none, junk is dropped with ONE warning,
//      and "every entry junk" is NONE, never Google.
//   2. The three consumers follow the one parse. "Blank" is checked on the REAL artefacts each consumer
//      produces (the CSP header text, the MediaMTX config file written to disk, GET /api/about over real HTTP),
//      asserting that no STUN host appears in any of them: so a consumer that kept a copy of the default fails
//      here on BEHAVIOUR.
//   3. A source scan: no file in backend/src or frontend/src but lib/stunServers.js names Google's STUN host, so a
//      new hard-coded copy cannot be added unnoticed.
// NOT COVERED: a real browser or MediaMTX. The browser half (the player uses what /api/about says) is in
// frontend/test/iceServers.test.jsx; that MediaMTX accepts the generated file (a `webrtcICEServers2` list of
// `- url:` entries is the shape it had before this change) was not run, and no packet capture shows nothing
// leaves the container.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, call, mountRouter } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: aboutRoutes } = await import('../src/routes/about.js');
const {
  parseStunServers, parseStunUrl, stunCspSource, renderMediamtxConfig, writeMediamtxConfig,
  DEFAULT_STUN_SERVERS, MEDIAMTX_ICE_LINE,
} = await import('../src/lib/stunServers.js');
const { buildCspDirectives } = await import('../src/lib/cspDirectives.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_YML = path.resolve(HERE, '..', '..', 'mediamtx', 'mediamtx.yml');
const GOOGLE = 'stun:stun.l.google.com:19302';

describe('#558 parseStunServers', () => {
  test('#558 unset is exactly the previous default: Google, no warning', () => {
    assert.deepEqual(parseStunServers(undefined), { urls: [GOOGLE], warning: null });
    assert.deepEqual(DEFAULT_STUN_SERVERS, [GOOGLE]);
  });

  test('#558 blank and whitespace mean NO STUN, not the default, with no warning', () => {
    for (const raw of ['', '   ', ' , ,']) {
      assert.deepEqual(parseStunServers(raw), { urls: [], warning: null }, JSON.stringify(raw));
    }
  });

  test('#558 a valid list is kept in order, trimmed, de-duplicated', () => {
    const r = parseStunServers(' stun:a.example.org:3478 ,stun:b.example.org, stun:a.example.org:3478,stun:10.0.0.5:19302,stun:[2001:db8::1]:3478');
    assert.deepEqual(r.urls, ['stun:a.example.org:3478', 'stun:b.example.org', 'stun:10.0.0.5:19302', 'stun:[2001:db8::1]:3478']);
    assert.equal(r.warning, null);
  });

  test('#558 anything that is not a stun: URL is dropped with ONE warning naming every dropped entry', () => {
    const r = parseStunServers('stun:ok.example.org:3478, turn:relay.example.org, stuns:x.example.org, google.com:19302, stun:bad host, stun:h:99999, stun:h:0, stun:;evil');
    assert.deepEqual(r.urls, ['stun:ok.example.org:3478']);
    assert.equal(typeof r.warning, 'string');
    for (const bad of ['turn:relay.example.org', 'stuns:x.example.org', 'google.com:19302', 'stun:bad host', 'stun:h:99999', 'stun:h:0', 'stun:;evil']) {
      assert.ok(r.warning.includes(JSON.stringify(bad)), `warning names ${bad}`);
    }
    assert.ok(r.warning.includes('Using stun:ok.example.org:3478'));
  });

  test('#558 every entry invalid = STUN OFF (never Google), and the warning says so', () => {
    const r = parseStunServers('stun.l.google.com:19302');
    assert.deepEqual(r.urls, []);
    assert.match(r.warning, /STUN is OFF/);
  });

  test('#701 a DNS label is at most 63 characters, in the first label and in every later one', () => {
    // RFC 1035 section 2.3.4. The regex bounds each label to 1 + 61 + 1; the bound exists so a pasted value
    // cannot make the pattern run unbounded, and so an over-long name (which no resolver accepts) is reported
    // as a typo instead of being written into the MediaMTX file and the CSP.
    const l63 = 'a'.repeat(63);
    const l64 = 'a'.repeat(64);
    assert.deepEqual(parseStunUrl(`stun:${l63}.example.org`), { host: `${l63}.example.org`, port: 3478 }, '63 is the longest allowed');
    assert.deepEqual(parseStunUrl(`stun:example.${l63}`), { host: `example.${l63}`, port: 3478 });
    assert.equal(parseStunUrl(`stun:${l64}.example.org`), null, 'a 64-character FIRST label is refused');
    assert.equal(parseStunUrl(`stun:${l64}`), null, 'a 64-character single label is refused');
    assert.equal(parseStunUrl(`stun:example.${l64}`), null, 'a 64-character LATER label is refused');
    assert.equal(parseStunUrl(`stun:example.${l64}.org`), null);
    assert.ok(parseStunServers(`stun:${l64}.example.org`).warning, 'and the setting reports it');
  });

  test('#558 stun URL host/port rules, and the CSP source for each', () => {
    assert.deepEqual(parseStunUrl('stun:h.example.org'), { host: 'h.example.org', port: 3478 }, 'no port = 3478');
    assert.equal(stunCspSource('stun:h.example.org'), 'h.example.org:3478');
    assert.equal(stunCspSource(GOOGLE), 'stun.l.google.com:19302');
    assert.equal(parseStunUrl('stun:h:65535')?.port, 65535);
    assert.equal(parseStunUrl('stun:h:65536'), null);
    assert.equal(parseStunUrl('stun:-bad.example.org'), null);
    assert.equal(parseStunUrl('stun:h.example.org:3478?transport=udp'), null);
    assert.equal(parseStunUrl('STUN:h.example.org'), null, 'scheme is lower case, as the URL scheme is written everywhere else here');
    assert.equal(parseStunUrl('stun:[::1 ::2]:3478'), null, 'a bracketed host may hold only hex digits, colons and dots');
    assert.deepEqual(parseStunUrl('stun:[::1]:3478'), { host: '[::1]', port: 3478 });
    assert.equal(stunCspSource('nonsense'), null);
  });
});

describe('#558 MediaMTX config', () => {
  test('#558 the base file has the placeholder line exactly once, and names no STUN server itself', () => {
    const text = fs.readFileSync(BASE_YML, 'utf8');
    assert.equal(text.split('\n').filter((l) => l.trimEnd() === MEDIAMTX_ICE_LINE).length, 1);
    assert.ok(!/stun/i.test(text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')), 'no STUN in the non-comment lines');
    assert.ok(!/google/i.test(text), 'the base file must not contain Google at all, comments included');
  });

  test('#558 a list is written as `- url:` entries; the rest of the file is untouched', () => {
    const base = fs.readFileSync(BASE_YML, 'utf8');
    const out = renderMediamtxConfig(base, ['stun:a.example.org:3478', GOOGLE]);
    assert.ok(out.includes('webrtcICEServers2:\n  - url: stun:a.example.org:3478\n  - url: stun:stun.l.google.com:19302\n'));
    assert.equal(out.replace(/webrtcICEServers2:\n {2}- url: .*\n {2}- url: .*\n/, `${MEDIAMTX_ICE_LINE}\n`), base);
  });

  test('#558 an empty list leaves the empty list, so MediaMTX is given no STUN server', () => {
    const base = fs.readFileSync(BASE_YML, 'utf8');
    assert.equal(renderMediamtxConfig(base, []), base);
  });

  test('#558 a template that lost its placeholder line throws instead of starting MediaMTX with the wrong list', () => {
    assert.throws(() => renderMediamtxConfig('rtsp: yes\n', [GOOGLE]), /no "webrtcICEServers2: \[\]" line/);
  });

  test('#558 writeMediamtxConfig writes the filled copy to the temp dir, and the original is not modified', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-stun-'));
    try {
      const before = fs.readFileSync(BASE_YML, 'utf8');
      const out = writeMediamtxConfig(BASE_YML, [GOOGLE], { tmpDir: tmp });
      assert.equal(path.dirname(out), tmp);
      assert.match(fs.readFileSync(out, 'utf8'), /webrtcICEServers2:\n {2}- url: stun:stun\.l\.google\.com:19302\n/);
      assert.equal(fs.readFileSync(BASE_YML, 'utf8'), before);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('#558 when the copy cannot be written the BASE file is used (empty list = no STUN), and it is logged', () => {
    const logged = [];
    const out = writeMediamtxConfig(BASE_YML, [GOOGLE], { tmpDir: path.join(os.tmpdir(), 'nl-no-such-dir-558', 'x'), log: { error: (m) => logged.push(m) } });
    assert.equal(out, BASE_YML);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /no STUN servers/);
  });
});

describe('#558 the CSP follows the setting', () => {
  test('#558 unset: connect-src has Google at the position it always had', () => {
    assert.deepEqual(buildCspDirectives({}).connectSrc, ["'self'", 'stun.l.google.com:19302']);
  });
  test('#558 a custom list replaces Google, one source each', () => {
    assert.deepEqual(
      buildCspDirectives({ STUN_SERVERS: 'stun:a.example.org:3478,stun:b.example.org' }).connectSrc,
      ["'self'", 'a.example.org:3478', 'b.example.org:3478']
    );
  });
  test('#558 Cloudflare, when on, still comes last', () => {
    assert.deepEqual(
      buildCspDirectives({ STUN_SERVERS: 'stun:a.example.org', CLOUDFLARE_ANALYTICS: '1' }).connectSrc,
      ["'self'", 'a.example.org:3478', 'https://cloudflareinsights.com']
    );
  });
});

describe('#558 BLANK means nothing contacts Google, in all three places', () => {
  let srv;
  let token;
  const saved = process.env.STUN_SERVERS;
  before(async () => {
    makeUser(db, { id: 'u-stun', username: 'stun-user', role: 'caregiver' });
    token = signToken({ id: 'u-stun', username: 'stun-user', role: 'caregiver', sid: makeSession(db, 'u-stun') });
    srv = await mountRouter('/api/about', aboutRoutes);
  });
  after(async () => {
    if (saved === undefined) delete process.env.STUN_SERVERS; else process.env.STUN_SERVERS = saved;
    await srv.close();
    cleanupTempDataDirs();
  });

  test('#558 blank: the CSP, the MediaMTX file and /api/about name no STUN host at all', async () => {
    process.env.STUN_SERVERS = '';
    const csp = JSON.stringify(buildCspDirectives(process.env));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-stun-'));
    try {
      const yml = fs.readFileSync(writeMediamtxConfig(BASE_YML, parseStunServers(process.env.STUN_SERVERS).urls, { tmpDir: tmp }), 'utf8');
      const about = await call(`${srv.url}/api/about`, { token });
      assert.equal(about.status, 200);
      assert.deepEqual(about.body.stunServers, []);
      for (const [name, text] of [['CSP', csp], ['MediaMTX config', yml], ['/api/about', JSON.stringify(about.body.stunServers)]]) {
        assert.ok(!/google/i.test(text), `${name} mentions Google`);
        assert.ok(!/stun/i.test(name === 'MediaMTX config' ? text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n') : text), `${name} names a STUN server`);
      }
      assert.deepEqual(JSON.parse(csp).connectSrc, ["'self'"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('#558 unset: the same three artefacts all carry the previous default', async () => {
    delete process.env.STUN_SERVERS;
    const about = await call(`${srv.url}/api/about`, { token });
    assert.deepEqual(about.body.stunServers, [GOOGLE]);
    assert.ok(about.body.version !== undefined, 'the existing fields are still there (additive change)');
  });

  test('#558 custom: /api/about returns exactly the validated list', async () => {
    process.env.STUN_SERVERS = 'stun:a.example.org:3478, junk';
    assert.deepEqual((await call(`${srv.url}/api/about`, { token })).body.stunServers, ['stun:a.example.org:3478']);
  });

  test('#558 /api/about still needs a sign-in', async () => {
    assert.equal((await call(`${srv.url}/api/about`)).status, 401);
  });
});

describe('#558 no second copy of the default', () => {
  test('#558 no file in backend/src or frontend/src but lib/stunServers.js names Google\'s STUN host', () => {
    const roots = [path.resolve(HERE, '..', 'src'), path.resolve(HERE, '..', '..', 'frontend', 'src')];
    const offenders = [];
    // Own walk (not helpers/sourceScan.js): that one reads .js only, and the player is a .jsx.
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(jsx?|mjs)$/.test(e.name) && /stun\.l\.google\.com/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    roots.forEach(walk);
    // The one allowed home of the default.
    const allowed = path.resolve(HERE, '..', 'src', 'lib', 'stunServers.js');
    const found = offenders.filter((f) => f !== allowed);
    assert.deepEqual(found, []);
    assert.ok(offenders.includes(allowed), 'the scan does find the default where it lives (so an empty result means something)');
  });
});

describe('#558 index.js wiring (source text only: index.js cannot be booted by a test)', () => {
  // Comments are stripped BEFORE the assertions (#701 review): a call that was commented out, or one merely
  // quoted in a comment, still contains the text, so a plain substring test passed with MediaMTX never started.
  // `(^|\s)//` and not a bare `//` so a URL such as http://... in code is left alone. (A `//` inside a string
  // literal preceded by whitespace would also be cut; index.js has none near these calls, and the cost of a
  // wrong cut is a test failing, not passing.)
  const src = fs.readFileSync(path.resolve(HERE, '..', 'src', 'index.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ');
  test('#558 MediaMTX is started from the config written for the parsed STUN_SERVERS, never from the raw base file', () => {
    assert.ok(src.includes('parseStunServers(process.env.STUN_SERVERS)'), 'the setting is read from the environment');
    assert.ok(src.includes('writeMediamtxConfig(mediamtxBasePath, stun.urls,'), 'the parsed list is what is written');
    assert.ok(src.includes('startMediaMTX(mediamtxConfigPath);'), 'the written copy is what is started (as a statement, in code, not in a comment)');
    assert.ok(!src.includes('startMediaMTX(mediamtxBasePath)'));
  });
});
