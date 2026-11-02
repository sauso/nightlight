// #937: the mDNS announcer (lib/mdnsAnnounce.js) and its wiring into index.js.
//
// ⚠️ THE REAL LIBRARY IS NOT USED HERE, and that is the negative space of this file: CI cannot bind UDP 5353 or reach
// a real network, so real multicast was checked by hand (the Connect & Discovery spike, and a smoke test of this module
// on a Windows PC for #937). What these tests can and do hold is everything the module decides: exactly what it
// publishes, that it never constructs the library when told not to, and that every failure path the real library has
// (checked in bonjour-service 1.4.4 and multicast-dns 7.2.5) is survived. The fake copies the two that crash a process:
//   * multicast-dns emits a failed bind as 'error' on its own emitter (`bonjour.server.mdns`); the fake's emitter is a
//     plain EventEmitter with NO other listener, so an 'error' the module did not handle genuinely throws here;
//   * bonjour-service's error callback defaults to `throw err`; the fake keeps that default.
import { test, describe, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';
import { tokenize } from './helpers/routeTable.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const {
  startMdnsAnnounce, stopMdnsAnnounce, parseMdnsAnnounce, publishOptions, UP_WATCHDOG_MS, STOP_CAP_MS,
} = await import('../src/lib/mdnsAnnounce.js');

const APP_NAME_MARK = 'APPNAME-MARK-937';
let serverId;
before(() => {
  db.prepare("UPDATE settings SET app_name = ? WHERE id = 'app'").run(APP_NAME_MARK);
  serverId = db.prepare("SELECT server_id FROM settings WHERE id = 'app'").get().server_id;
});
after(() => {
  db.close();
  cleanupTempDataDirs();
});

// A stand-in for bonjour-service with the same surface the module uses. `goodbye`: 'async' calls unpublishAll's
// callback on a later turn (as the library does once the packet is sent), 'never' never calls it (a wedged socket).
function fakeBonjour({ goodbye = 'async', publishThrows = false, noMdns = false } = {}) {
  const f = { created: 0, ctorOpts: null, errorCallback: null, published: [], unpublished: 0, destroyed: 0, events: [] };
  f.mdns = new EventEmitter();
  f.service = new EventEmitter();
  f.create = (opts, errorCallback) => {
    f.created++;
    f.ctorOpts = opts;
    f.errorCallback = errorCallback ?? ((err) => { throw err; }); // the library's own default (mdns-server.js)
    return {
      server: noMdns ? {} : { mdns: f.mdns },
      publish(cfg) {
        if (publishThrows) throw new Error('publish exploded');
        f.published.push(structuredClone(cfg));
        return f.service;
      },
      unpublishAll(cb) {
        f.unpublished++;
        f.events.push('unpublishAll');
        if (goodbye === 'async') setImmediate(() => { f.events.push('goodbye sent'); cb(); });
      },
      destroy(cb) {
        f.destroyed++;
        f.events.push('destroy');
        if (cb) setImmediate(() => { f.events.push('socket closed'); cb(); });
      },
    };
  };
  return f;
}

const ON = { MDNS_ANNOUNCE: undefined };
let warn;
let info;
const warnings = () => warn.mock.calls.map((c) => String(c.arguments[0]));
const settle = () => new Promise((r) => setImmediate(r));
// At most `ms` of waiting, on a REAL timer that is cleared afterwards. Used where a broken stop would never resolve:
// a hook left awaiting it would end the file as "cancelled", which the mutation run reads as an error, not a kill.
const bounded = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((r) => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t));
};

describe('the announcer', () => {
  // Every test leaves the module stopped, so the next one starts clean; mock timers are reset first so a stop's
  // cap is a real (short) timer again.
  afterEach(async () => {
    mock.timers.reset();
    await bounded(stopMdnsAnnounce(), 3000);
    warn?.mock.restore();
    info?.mock.restore();
  });
  const quiet = () => {
    warn = mock.method(logger, 'warn', () => {});
    info = mock.method(logger, 'info', () => {});
  };

  test('★ publishes exactly this, and nothing else', () => {
    quiet();
    const f = fakeBonjour();
    startMdnsAnnounce({ port: '4000', createBonjour: f.create, env: ON });
    const short = serverId.replace(/-/g, '').slice(0, 8);
    assert.equal(f.created, 1);
    assert.deepEqual(f.published, [{
      name: `Nightlight-${short}`,
      host: `nightlight-${short}.local`, // set, so the library's default (the machine's host name) is not broadcast
      type: 'nightlight',
      protocol: 'tcp',
      port: 4000, // the environment's string, as a number
      disableIPv6: true,
      txt: { v: '1', id: serverId }, // only these two: the name is read from /api/health
    }]);
  });

  test('★ the app name and the machine\'s host name are nowhere in what is published', () => {
    quiet();
    const f = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    const wire = JSON.stringify({ ctor: f.ctorOpts, published: f.published }).toLowerCase();
    assert.ok(!wire.includes(APP_NAME_MARK.toLowerCase()), `the app name was announced: ${wire}`);
    const host = os.hostname().toLowerCase();
    assert.ok(host.length >= 3, `precondition: a host name long enough to search for (${host})`);
    assert.ok(!wire.includes(host), `the machine's host name ${host} was announced: ${wire}`);
  });

  test('two servers with different ids publish different names (the library silently stops a duplicate)', () => {
    const a = publishOptions({ id: '0a1b2c3d-0000-4000-8000-000000000000', port: 4000 });
    const b = publishOptions({ id: '9f8e7d6c-0000-4000-8000-000000000000', port: 4000 });
    assert.notEqual(a.name, b.name);
    assert.notEqual(a.host, b.host);
  });

  test('★ MDNS_ANNOUNCE off: the library is never constructed (no socket at all)', () => {
    quiet();
    for (const value of ['false', '0', 'no', 'off', 'FALSE', ' Off ']) {
      const f = fakeBonjour();
      startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: { MDNS_ANNOUNCE: value } });
      assert.equal(f.created, 0, `MDNS_ANNOUNCE=${JSON.stringify(value)} still constructed the library`);
    }
    assert.deepEqual(warnings(), [], 'turning it off is not a warning');
  });

  test('parseMdnsAnnounce: on by default, the usual spellings of off, and a typo stays on with a warning', () => {
    for (const v of [undefined, '', '  ', 'true', '1', 'yes', 'on', 'ON']) {
      assert.deepEqual(parseMdnsAnnounce(v), { enabled: true, warning: null }, JSON.stringify(v));
    }
    for (const v of ['false', '0', 'no', 'off', 'No']) {
      assert.deepEqual(parseMdnsAnnounce(v), { enabled: false, warning: null }, JSON.stringify(v));
    }
    const typo = parseMdnsAnnounce('flase');
    assert.equal(typo.enabled, true);
    assert.match(typo.warning, /"flase".*not a recognised value/);
  });

  test('a port that is not a port number announces nothing', () => {
    quiet();
    for (const port of [undefined, '', 'abc', '0', '65536', '4000.5']) {
      const f = fakeBonjour();
      startMdnsAnnounce({ port, createBonjour: f.create, env: ON });
      assert.equal(f.created, 0, `port ${JSON.stringify(port)}`);
    }
  });

  test('★ publish throwing does not throw, logs one WARN, and still closes the socket', async () => {
    quiet();
    const f = fakeBonjour({ publishThrows: true });
    assert.doesNotThrow(() => startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON }));
    assert.equal(warnings().length, 1, warnings().join('\n'));
    assert.match(warnings()[0], /publish exploded/);
    assert.equal(f.destroyed, 1, 'the half-made announcer was not closed');
    await stopMdnsAnnounce();
    assert.equal(f.destroyed, 1, 'closed twice');
  });

  test('★ an \'error\' on the underlying mDNS socket (a failed bind) is survived: one WARN, socket closed', () => {
    quiet();
    const f = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    const err = Object.assign(new Error('bind EADDRINUSE 0.0.0.0:5353'), { code: 'EADDRINUSE' });
    // multicast-dns emits a failed bind TWICE (the socket's 'error', then the bind callback). With no listener, the
    // first emit throws: this is the uncaught exception the module must prevent.
    assert.doesNotThrow(() => { f.mdns.emit('error', err); f.mdns.emit('error', err); });
    assert.equal(warnings().length, 1, warnings().join('\n'));
    assert.match(warnings()[0], /EADDRINUSE/);
    assert.equal(f.destroyed, 1);
  });

  test('a bind failure with another code (a \'warning\' first, then the \'error\') is still one WARN', () => {
    // What the real library did in the #937 smoke test with an interface address the machine does not have.
    quiet();
    const f = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    const err = Object.assign(new Error('bind EADDRNOTAVAIL 203.0.113.1:5353'), { code: 'EADDRNOTAVAIL', syscall: 'bind' });
    f.mdns.emit('warning', err);
    f.mdns.emit('error', err);
    assert.equal(warnings().length, 1, warnings().join('\n'));
    assert.match(warnings()[0], /could not announce.*EADDRNOTAVAIL/);
  });

  test('★ the library\'s error callback (default: throw) is replaced: survived, one WARN, announcer keeps going', () => {
    quiet();
    const f = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    assert.doesNotThrow(() => { f.errorCallback(new Error('send ENETUNREACH')); f.errorCallback(new Error('again')); });
    assert.doesNotThrow(() => f.mdns.emit('warning', new Error('decode failed')));
    assert.equal(warnings().length, 1, 'one WARN for the non-fatal problems, not one each');
    assert.equal(f.destroyed, 0, 'a non-fatal problem stopped the announcer');
    f.service.emit('up');
    assert.ok(info.mock.calls.some((c) => /announcing this server/.test(String(c.arguments[0]))), 'no "announcing" line');
  });

  test('a library without the mDNS emitter is not allowed to publish (its errors could not be caught)', () => {
    quiet();
    const f = fakeBonjour({ noMdns: true });
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    assert.equal(f.published.length, 0);
    assert.equal(warnings().length, 1);
    assert.equal(f.destroyed, 1);
  });

  test('★ no `up` within 10 s (name already in use, or no multicast) logs exactly one WARN naming the name', () => {
    quiet();
    mock.timers.enable({ apis: ['setTimeout'] });
    const f = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    mock.timers.tick(UP_WATCHDOG_MS - 1);
    assert.deepEqual(warnings(), [], 'warned before the 10 s were up');
    mock.timers.tick(1);
    assert.equal(warnings().length, 1);
    assert.ok(warnings()[0].includes(f.published[0].name), warnings()[0]);
    mock.timers.tick(UP_WATCHDOG_MS * 5);
    assert.equal(warnings().length, 1, 'warned more than once');
  });

  test('an `up` in time means no WARN at all', () => {
    quiet();
    mock.timers.enable({ apis: ['setTimeout'] });
    const f = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    mock.timers.tick(1000);
    f.service.emit('up');
    mock.timers.tick(UP_WATCHDOG_MS * 2);
    assert.deepEqual(warnings(), []);
  });

  test('start twice is one announcer; stop before start, and stop twice, are safe', async () => {
    quiet();
    await assert.doesNotReject(stopMdnsAnnounce()); // never started
    const f = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    assert.equal(f.created, 1);
    const one = stopMdnsAnnounce();
    const two = stopMdnsAnnounce();
    assert.equal(one, two, 'a second stop during the first should wait for the same goodbye');
    await one;
    await assert.doesNotReject(stopMdnsAnnounce());
    assert.equal(f.unpublished, 1);
    assert.equal(f.destroyed, 1);
    // ...and after a stop, a start works again (a fresh announcer).
    const g = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: g.create, env: ON });
    assert.equal(g.created, 1);
  });

  test('★ stop resolves only after the goodbye is sent and the socket is closed', async () => {
    quiet();
    const f = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    let resolved = false;
    const p = stopMdnsAnnounce().then(() => { resolved = true; });
    assert.deepEqual(f.events, ['unpublishAll']);
    assert.equal(resolved, false, 'resolved before the goodbye was sent');
    await p;
    assert.deepEqual(f.events, ['unpublishAll', 'goodbye sent', 'destroy', 'socket closed']);
  });

  test('★ a goodbye that never completes: stop still resolves, at the cap, and still closes the socket', async () => {
    quiet();
    mock.timers.enable({ apis: ['setTimeout'] });
    const f = fakeBonjour({ goodbye: 'never' });
    startMdnsAnnounce({ port: 4000, createBonjour: f.create, env: ON });
    let resolved = false;
    stopMdnsAnnounce().then(() => { resolved = true; });
    mock.timers.tick(STOP_CAP_MS - 1);
    await settle();
    assert.equal(resolved, false, 'gave up on the goodbye before the cap');
    mock.timers.tick(1);
    await settle();
    // Asserted, not awaited: without the cap `p` never settles, and awaiting it would cancel the file, not fail it.
    assert.equal(resolved, true, 'stop did not resolve at the cap: shutdown would wait for ever');
    assert.equal(f.destroyed, 1, 'the socket was left open after giving up on the goodbye');
  });

  test('stop never rejects, even when unpublishAll throws', async () => {
    quiet();
    const f = fakeBonjour();
    startMdnsAnnounce({ port: 4000, createBonjour: (...a) => {
      const b = f.create(...a);
      b.unpublishAll = () => { throw new Error('unpublish exploded'); };
      return b;
    }, env: ON });
    await assert.doesNotReject(stopMdnsAnnounce());
    assert.equal(f.destroyed, 1);
  });

  test('the cap is short: it bounds the end of shutdown, which awaits it last', () => {
    // shutdown() starts the stop first and awaits it just before process.exit, so the cap only matters if every
    // other stop finished sooner than it. Kept well inside recordings-shutdown.test.js's 5 s margin regardless.
    assert.ok(STOP_CAP_MS > 0 && STOP_CAP_MS <= 2000, `STOP_CAP_MS is ${STOP_CAP_MS}`);
  });
});

// ---- index.js wiring ------------------------------------------------------------------------------------------
// index.js cannot be imported, so its wiring is read from the source, on TOKENS (helpers/routeTable.js drops comments
// and keeps strings whole): a call mentioned in a comment does not count, and a reformat cannot break these.
describe('index.js wiring', () => {
  const toks = tokenize(fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'));
  const OPEN = new Set(['(', '{', '[']);
  const CLOSE = new Set([')', '}', ']']);
  const closeOf = (open) => {
    let depth = 0;
    for (let j = open; j < toks.length; j++) {
      if (toks[j].t === 'p' && OPEN.has(toks[j].v)) depth++;
      if (toks[j].t === 'p' && CLOSE.has(toks[j].v) && --depth === 0) return j;
    }
    throw new Error('unbalanced');
  };
  // Index of the first token of `seq` (token values) at or after `from`, or -1.
  const find = (seq, from = 0, to = toks.length) => {
    for (let k = from; k <= to - seq.length; k++) if (seq.every((v, i) => toks[k + i].v === v)) return k;
    return -1;
  };
  const callAt = (name, from, to) => {
    for (let k = from; k < to; k++) {
      if (toks[k].t === 'id' && toks[k].v === name && toks[k + 1]?.v === '(' && toks[k - 1]?.v !== '.') return k;
    }
    return -1;
  };
  const imports = (name, spec) => {
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].v !== 'import' || toks[k + 1]?.v !== '{') continue;
      const end = closeOf(k + 1);
      if (toks[end + 1]?.v === 'from' && toks[end + 2]?.v === spec && toks.slice(k + 2, end).some((t) => t.v === name)) return true;
    }
    return false;
  };

  test('★ the announcer starts inside the listen callback, after markBootComplete, on PORT', () => {
    const listen = find(['app', '.', 'listen', '(']);
    assert.ok(listen !== -1, 'no app.listen( in index.js');
    const open = listen + 3;
    const end = closeOf(open);
    const boot = callAt('markBootComplete', open, end);
    const start = callAt('startMdnsAnnounce', open, end);
    assert.ok(boot !== -1, 'markBootComplete() is no longer called in the listen callback');
    assert.ok(start !== -1, 'startMdnsAnnounce() is not called in the listen callback');
    assert.ok(start > boot, 'the server is announced before boot is complete');
    const args = toks.slice(start + 2, closeOf(start + 1)).map((t) => t.v);
    assert.deepEqual(args, ['{', 'port', ':', 'PORT', '}'], `startMdnsAnnounce(${args.join(' ')})`);
  });

  test('★ shutdown starts the stop before its first await and awaits it just before process.exit(0)', () => {
    const fn = find(['async', 'function', 'shutdown', '(']);
    assert.ok(fn !== -1, 'no async function shutdown( in index.js');
    const bodyOpen = find(['{'], closeOf(fn + 3));
    const bodyEnd = closeOf(bodyOpen);
    const started = find(['const', 'mdnsStopped', '=', 'stopMdnsAnnounce', '(', ')'], bodyOpen, bodyEnd);
    const firstAwait = find(['await'], bodyOpen, bodyEnd);
    assert.ok(started !== -1, 'shutdown() does not start stopMdnsAnnounce() into mdnsStopped');
    assert.ok(started < firstAwait, 'the mDNS stop starts only after an awaited stop: it no longer overlaps them');
    const awaited = find(['await', 'mdnsStopped', ';'], bodyOpen, bodyEnd);
    assert.ok(awaited !== -1, 'mdnsStopped is never awaited: process.exit can cut off the goodbye');
    assert.equal(
      find(['process', '.', 'exit', '(', '0', ')'], awaited + 3, bodyEnd), awaited + 3,
      'the await of mdnsStopped is not the statement right before process.exit(0)'
    );
  });

  test('the names called are the ones imported (a call to an unimported name throws at boot or at shutdown)', () => {
    assert.ok(imports('startMdnsAnnounce', './lib/mdnsAnnounce.js'));
    assert.ok(imports('stopMdnsAnnounce', './lib/mdnsAnnounce.js'));
    assert.ok(imports('healthHandler', './lib/serverIdentity.js'));
    assert.ok(find(['app', '.', 'get', '(', '/api/health', ',', 'healthHandler', ')']) !== -1, '/api/health is not healthHandler');
  });
});
