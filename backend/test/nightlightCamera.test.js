// A Nightlight Camera's local API, the parts that need no database: the host rule, the login choice, the groups, the
// request helper (against a faked global fetch: no network) and the reading of /health and /sensors.
//
// Every claim here is about what a hostile or faulty DEVICE can make Nightlight do: any machine on the camera's network can
// answer /health, so the fixtures plant a recognisable marker in every field that could carry what the code must drop.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNightlightHost, cameraHost, cameraLogin, parseGroups, usesApiClimate, fetchLanJson, readHealth, readCapabilities,
  parseSensors, METRIC_GROUP, GROUPS, NLCAM_SOURCE,
} from '../src/lib/nightlightCamera.js';

const IP = '192.168.3.50';
const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
let calls;
function fakeFetch(impl) {
  calls = [];
  mock.method(globalThis, 'fetch', async (url, opts) => { calls.push({ url: String(url), opts }); return impl(url, opts); });
}
afterEach(() => { mock.restoreAll(); });

test('only a literal private IPv4 that is not link-local is ever contacted', async () => {
  for (const ok of ['192.168.3.142', '10.0.0.5', '172.16.0.9', '172.31.255.1']) assert.equal(isNightlightHost(ok), true, ok);
  for (const bad of ['169.254.169.254', '169.254.1.1', '127.0.0.1', '8.8.8.8', 'camera.local', '', null, undefined, 5,
    '192.168.1.1.evil.com', '0xc0a80101', '192.168.1.1:80', '[::1]', 'fe80::1']) {
    assert.equal(isNightlightHost(bad), false, String(bad));
  }
  // The request helper refuses before any network call, for each of them.
  fakeFetch(() => json({}));
  for (const bad of ['169.254.169.254', '127.0.0.1', '8.8.8.8', 'camera.local']) {
    assert.deepEqual(await fetchLanJson(bad, '/api/v1/health'), { ok: false, reason: 'host' }, bad);
  }
  assert.deepEqual(await fetchLanJson(IP, '/api/v1/health', { port: 0 }), { ok: false, reason: 'host' });
  assert.deepEqual(await fetchLanJson(IP, '/api/v1/health', { port: 70000 }), { ok: false, reason: 'host' });
  assert.equal(calls.length, 0, 'nothing was sent to a refused host');
});

test('the camera login is the stream login in rtsp_url first, the ONVIF pair only as a fallback, and decoded', () => {
  const cam = { rtsp_url: 'rtsp://nightlight:p%40ss%3Aword@192.168.3.50:554/main', onvif_username: 'old', onvif_password: 'stale' };
  assert.deepEqual(cameraLogin(cam), { username: 'nightlight', password: 'p@ss:word' });
  assert.equal(cameraHost(cam), '192.168.3.50');
  assert.deepEqual(cameraLogin({ rtsp_url: 'rtsp://192.168.3.50/main', onvif_username: 'u', onvif_password: 'p' }), { username: 'u', password: 'p' });
  assert.equal(cameraLogin({ rtsp_url: 'rtsp://192.168.3.50/main' }), null);
  assert.equal(cameraLogin({ rtsp_url: 'not a url' }), null);
  assert.equal(cameraHost({ rtsp_url: 'not a url' }), '');
});

test('groups default to all on, take only booleans, and decide which camera the MQTT sampler may use', () => {
  assert.deepEqual(parseGroups(null), { climate: true, radar: true, light: true, pad: true });
  assert.deepEqual(parseGroups('{"radar":false,"light":"no","extra":false}'), { climate: true, radar: false, light: true, pad: true });
  assert.deepEqual(parseGroups('not json'), { climate: true, radar: true, light: true, pad: true });
  assert.equal(usesApiClimate({ sensor_source: NLCAM_SOURCE, sensor_groups: null }), true);
  assert.equal(usesApiClimate({ sensor_source: NLCAM_SOURCE, sensor_groups: '{"climate":false}' }), false, 'climate off hands the camera back to MQTT');
  assert.equal(usesApiClimate({ sensor_source: null, sensor_groups: null }), false);
  assert.deepEqual(GROUPS, ['climate', 'radar', 'light', 'pad']);
});

// A /sensors answer in the camera's documented shape, every reading ok.
const sensorsAnswer = (over = {}) => ({
  simulated: false,
  radar: { presence: { value: true, state: 'ok' }, heart_rate_bpm: { value: 92, state: 'ok' }, breathing_rate_bpm: { value: 22, state: 'ok' },
    distance_cm: { value: 80, state: 'ok' }, link: 'up' },
  environment: { temperature_c: { value: 21.4, state: 'ok' }, humidity_pct: { value: 45, state: 'ok' } },
  ambient_light_lux: { value: 3, state: 'ok' },
  pressure: { kind: 'digital', occupied: { value: true, state: 'ok' }, level: { value: 100, state: 'ok' }, weight_kg: { value: 9.5, state: 'ok' } },
  ...over,
});
// Every {value, state} leaf in the fixture, found by walking it, so a field added to the fixture is covered without editing the test.
function leaves(node, path = []) {
  if (!node || typeof node !== 'object') return [];
  if ('state' in node && 'value' in node) return [path];
  return Object.entries(node).flatMap(([k, v]) => leaves(v, [...path, k]));
}
const setAt = (root, path, patch) => { const o = structuredClone(root); let n = o; for (const k of path.slice(0, -1)) n = n[k]; Object.assign(n[path.at(-1)], patch); return o; };

test('every reading is kept only when its state is ok: a planted value under any other state stores nothing', () => {
  const base = sensorsAnswer();
  const found = leaves(base);
  assert.equal(found.length, 10, 'the fixture has ten readings, so the walk found them all');
  assert.ok(Object.values(parseSensors(base).metrics).every((v) => v !== null), 'precondition: all ok means all kept');
  for (const state of ['stale', 'unavailable', 'uncertain', 'OK', 'ok ', undefined, null, 5]) {
    for (const path of found) {
      const answer = setAt(base, path, { state, value: path.includes('presence') || path.includes('occupied') ? true : 12 });
      const kept = Object.values(parseSensors(answer).metrics).filter((v) => v !== null);
      assert.equal(kept.length, 9, `${path.join('.')} with state ${state} must be dropped, the other nine kept`);
    }
  }
  // Everything planted at once.
  let all = base;
  for (const path of found) all = setAt(all, path, { state: 'stale', value: 12 });
  assert.deepEqual(Object.values(parseSensors(all).metrics).filter((v) => v !== null), []);
  // Every metric has an owning group, so no stored quantity can escape its switch.
  assert.deepEqual(Object.keys(parseSensors(base).metrics).sort(), Object.keys(METRIC_GROUP).sort());
});

test('an implausible or mistyped value is dropped like a reading that is not ok', () => {
  const bad = (path, value) => parseSensors(setAt(sensorsAnswer(), path, { value })).metrics;
  assert.equal(bad(['environment', 'temperature_c'], 1e308).temperature, null);
  assert.equal(bad(['environment', 'temperature_c'], -41).temperature, null);
  assert.equal(bad(['environment', 'temperature_c'], '21.4').temperature, null, 'a numeric string is not a number');
  assert.equal(bad(['environment', 'humidity_pct'], 101).humidity, null);
  assert.equal(bad(['environment', 'humidity_pct'], -1).humidity, null);
  assert.equal(bad(['radar', 'heart_rate_bpm'], 0).heart_rate, null, 'zero is "no measurement" on this camera');
  assert.equal(bad(['radar', 'heart_rate_bpm'], 251).heart_rate, null);
  assert.equal(bad(['radar', 'breathing_rate_bpm'], 500).breathing_rate, null);
  assert.equal(bad(['radar', 'distance_cm'], null).distance_cm, null, 'null is never read as zero');
  assert.equal(bad(['radar', 'presence'], 1).presence, null, 'presence must be a real boolean');
  assert.equal(bad(['pressure', 'occupied'], 'true').pad_occupied, null);
  assert.equal(parseSensors(sensorsAnswer({ ambient_light_lux: { value: Infinity, state: 'ok' } })).metrics.light_lux, null);
  assert.equal(parseSensors(sensorsAnswer({ ambient_light_lux: { value: 3e9, state: 'ok' } })).metrics.light_lux, null);
  // Whole-shape garbage never throws.
  for (const junk of [null, undefined, 'x', 5, [], { radar: 'x', environment: [], pressure: null }]) {
    assert.deepEqual(Object.values(parseSensors(junk).metrics).filter((v) => v !== null), [], String(junk));
  }
});

test('a sample is simulated unless the camera says an explicit false', () => {
  assert.equal(parseSensors(sensorsAnswer({ simulated: false })).simulated, false);
  assert.equal(parseSensors(sensorsAnswer({ simulated: true })).simulated, true);
  for (const odd of ['false', 0, null, undefined, 'no', {}]) {
    const a = sensorsAnswer(); a.simulated = odd;
    assert.equal(parseSensors(a).simulated, true, `simulated: ${JSON.stringify(odd)} fails toward simulated`);
  }
  const absent = sensorsAnswer(); delete absent.simulated;
  assert.equal(parseSensors(absent).simulated, true);
});

const health = (over = {}) => ({ ok: true, api: 'v1', device_id: 'nlcam-c011cb72ca2a', name: 'Nightlight Camera', model: 'nightlight-camera',
  board: 'raspberrypi-zero2w', firmware: '0.1.0', simulated: true, ...over });

test('readHealth recognises only a Nightlight Camera, and returns validated fields', async () => {
  fakeFetch(() => json(health()));
  assert.deepEqual(await readHealth(IP), { device_id: 'nlcam-c011cb72ca2a', firmware: '0.1.0', simulated: true, api_port: 8080 });
  assert.equal(calls[0].url, `http://${IP}:8080/api/v1/health`);
  assert.equal(calls[0].opts.redirect, 'manual');
  assert.equal(calls[0].opts.headers.Authorization, undefined, 'health is asked without a login');
  fakeFetch(() => json(health({ simulated: false })));
  assert.equal((await readHealth(IP)).simulated, false);
  // Not a Nightlight Camera, in every way a host can fail to be one.
  fakeFetch(() => json(health({ model: 'sonoff' })));
  assert.equal(await readHealth(IP), null);
  fakeFetch(() => json(health({ model: 'Nightlight-Camera' })));
  assert.equal(await readHealth(IP), null, 'the model must match exactly');
  fakeFetch(() => json({ error: 'nope' }, { status: 404 }));
  assert.equal(await readHealth(IP), null);
  fakeFetch(() => new Response('<html>router</html>', { headers: { 'content-type': 'text/html' } }));
  assert.equal(await readHealth(IP), null);
  fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://evil.example/' } }));
  assert.equal(await readHealth(IP), null);
  fakeFetch(() => { throw new TypeError('fetch failed'); });
  assert.equal(await readHealth(IP), null);
  fakeFetch(() => json(['not', 'an', 'object']));
  assert.equal(await readHealth(IP), null);
  assert.equal(await readHealth('camera.local'), null);
});

test('a hostile /health is capped, filtered, and never echoed', async () => {
  const MARK = 'ZZMARKERZZ';
  // A 1 MB body, declared and undeclared.
  fakeFetch(() => json({ ...health(), pad: 'x'.repeat(1_000_000) }, { headers: { 'content-length': '1000100' } }));
  assert.equal(await readHealth(IP), null);
  fakeFetch(() => new Response(JSON.stringify({ ...health(), pad: 'x'.repeat(1_000_000) }), { headers: { 'content-type': 'application/json' } }));
  assert.equal(await readHealth(IP), null, 'a body past the cap is refused even with no declared length');
  // A long or markup-bearing id is not a Nightlight Camera; a bad firmware string is dropped, not shown.
  fakeFetch(() => json(health({ device_id: 'n'.repeat(300) })));
  assert.equal(await readHealth(IP), null);
  fakeFetch(() => json(health({ device_id: `<script>${MARK}</script>` })));
  assert.equal(await readHealth(IP), null);
  fakeFetch(() => json(health({ firmware: `<b>${MARK}</b>` })));
  const r = await readHealth(IP);
  assert.equal(r.firmware, null);
  assert.ok(!JSON.stringify(r).includes(MARK), 'nothing from the answer that failed the filter is returned');
  // simulated that is not a real false fails toward simulated.
  for (const odd of ['yes', 'false', 0, null]) {
    fakeFetch(() => json(health({ simulated: odd })));
    assert.equal((await readHealth(IP)).simulated, true, JSON.stringify(odd));
  }
  // An error body is never carried in the result.
  fakeFetch(() => new Response(`boom ${MARK}`, { status: 500, headers: { 'content-type': 'text/plain' } }));
  const failed = await fetchLanJson(IP, '/api/v1/health');
  assert.deepEqual(failed, { ok: false, reason: 'status', status: 500 });
});

test('fetchLanJson sends the login as Basic, times out, and stops on an abort', async () => {
  fakeFetch(() => json({ fine: true }));
  await fetchLanJson(IP, '/api/v1/sensors', { login: { username: 'nightlight', password: 'p@ss:w' } });
  assert.equal(calls[0].opts.headers.Authorization, `Basic ${Buffer.from('nightlight:p@ss:w').toString('base64')}`);
  // A request that never answers is abandoned at the timeout.
  fakeFetch((url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  assert.deepEqual(await fetchLanJson(IP, '/x', { timeoutMs: 20 }), { ok: false, reason: 'timeout' });
  // The caller's own signal (a stop) ends it and says so.
  const ctrl = new AbortController();
  const pending = fetchLanJson(IP, '/x', { timeoutMs: 5000, signal: ctrl.signal });
  ctrl.abort();
  assert.deepEqual(await pending, { ok: false, reason: 'aborted' });
  assert.deepEqual(await fetchLanJson(IP, '/x', { signal: ctrl.signal }), { ok: false, reason: 'aborted' }, 'already aborted: nothing is sent');
});

test('readCapabilities reads what is fitted, leniently, and gives null for an unusable answer', async () => {
  const login = { username: 'nightlight', password: 'pw' };
  fakeFetch(() => json({ sensors: { radar: true, environment: true, pressure: { kind: 'none' } } }));
  assert.deepEqual(await readCapabilities(IP, login), { radar: true, environment: true, pressure: false });
  fakeFetch(() => json({ sensors: { radar: false, environment: 'none', pressure: { kind: 'digital' } } }));
  assert.deepEqual(await readCapabilities(IP, login), { radar: false, environment: false, pressure: true });
  fakeFetch(() => json({ other: 1 }));
  assert.equal(await readCapabilities(IP, login), null);
  fakeFetch(() => json({}, { status: 401 }));
  assert.equal(await readCapabilities(IP, login), null);
});
