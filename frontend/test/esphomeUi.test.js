// The pure rules behind the ESPHome settings page and its hub row (lib/esphomeUi.js).
import { describe, test, expect } from 'vitest';
import {
  validRetention, stateBadge, encryptionNote, hubBadge, relativeAge, exportRange, exportLongestDays,
  EXPORT_BUDGET_BYTES, EXPORT_MAX_DAYS,
} from '../src/lib/esphomeUi.js';

describe('validRetention (the server: a whole number of days, 1 to 365)', () => {
  test.each([[1, true], [30, true], [365, true], ['45', true], [0, false], [366, false], [1.5, false], ['', false], ['abc', false], [null, false], [-3, false]])(
    '%j -> %s', (value, ok) => expect(validRetention(value)).toBe(ok));
});

describe('stateBadge', () => {
  const dev = (state, over = {}) => ({ enabled: true, status: { state }, ...over });
  test.each([
    ['connected', 'Connected', 'status-badge--ok'],
    ['connecting', 'Connecting', 'status-badge--off'],
    ['disconnected', 'Disconnected', 'status-badge--bad'],
    ['failed', 'Failed', 'status-badge--bad'],
    ['disabled', 'Off', 'status-badge--off'],
  ])('%s', (state, text, cls) => expect(stateBadge(dev(state))).toEqual({ text, cls }));

  test('a switched-off device is Off whatever a stale status says', () => {
    expect(stateBadge(dev('connected', { enabled: false })).text).toBe('Off');
  });
  test('an unknown state is shown, not hidden; no status at all is Unknown', () => {
    expect(stateBadge(dev('paused')).text).toBe('paused');
    expect(stateBadge({ enabled: true }).text).toBe('Unknown');
  });
});

describe('encryptionNote: the warning is only for a CONNECTED plaintext session', () => {
  test('connected and encrypted', () => {
    expect(encryptionNote({ key_set: true, status: { state: 'connected', encrypted: true } })).toEqual({ text: 'Encrypted', warn: false });
  });
  test('★ connected and not encrypted is the warning', () => {
    const note = encryptionNote({ key_set: false, status: { state: 'connected', encrypted: false } });
    expect(note.warn).toBe(true);
    expect(note.text).toMatch(/Not encrypted/);
  });
  test.each(['connecting', 'disconnected', 'failed', 'disabled'])(
    '★ %s with a key configured does NOT claim the connection is unencrypted (status.encrypted is false in every one of these)', (state) => {
      const note = encryptionNote({ key_set: true, status: { state, encrypted: false } });
      expect(note).toEqual({ text: 'Encryption key set', warn: false });
    });
  test('with no key configured and not connected it says so, without a warning', () => {
    expect(encryptionNote({ key_set: false, status: { state: 'failed', encrypted: false } })).toEqual({ text: 'No encryption key', warn: false });
  });
});

describe('hubBadge', () => {
  const d = (state, enabled = true) => ({ enabled, status: { state } });
  test('not a list (not loaded, or a failed request) -> no badge', () => {
    expect(hubBadge(null)).toBeNull();
    expect(hubBadge({ enabled: true })).toBeNull();
  });
  test('no devices, or only switched-off ones -> Off', () => {
    expect(hubBadge([]).text).toBe('Off');
    expect(hubBadge([d('disabled', false)]).text).toBe('Off');
  });
  test('every enabled device connected -> Connected, and a switched-off one is not a fault', () => {
    expect(hubBadge([d('connected'), d('disabled', false)])).toEqual({ text: 'Connected', cls: 'status-badge--ok' });
  });
  test('★ one enabled device not connected -> Disconnected', () => {
    expect(hubBadge([d('connected'), d('failed')])).toEqual({ text: 'Disconnected', cls: 'status-badge--bad' });
    expect(hubBadge([d('connecting')]).text).toBe('Disconnected');
  });
});

describe('relativeAge', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  test.each([
    ['2026-10-31T11:59:30Z', 'less than a minute ago'],
    ['2026-10-31T11:57:00Z', '3 min ago'],
    ['2026-10-31T09:00:00Z', '3 h ago'],
    ['2026-10-28T12:00:00Z', '3 days ago'],
  ])('%s -> %s', (iso, text) => expect(relativeAge(iso, now)).toBe(text));
  test('nothing or rubbish -> null (the card says "none yet")', () => {
    expect(relativeAge(null, now)).toBeNull();
    expect(relativeAge('not a date', now)).toBeNull();
  });
});

describe('exportRange (whole UTC days, both included; the server wants an exclusive end)', () => {
  test('★ the request ends on the day AFTER the last one chosen', () => {
    expect(exportRange('2026-10-01', '2026-10-07', 7)).toMatchObject({ ok: true, from: '2026-10-01', to: '2026-10-08', days: 7 });
  });
  test('one day is a valid range, and the end rolls over a month and a year', () => {
    expect(exportRange('2026-10-31', '2026-10-31', 7)).toMatchObject({ ok: true, to: '2026-11-01', days: 1 });
    expect(exportRange('2026-12-31', '2026-12-31', 7)).toMatchObject({ ok: true, to: '2027-01-01' });
  });
  test('★ 31 days is allowed and 32 is refused (the server limit)', () => {
    expect(exportRange('2026-10-01', '2026-10-31', 7)).toMatchObject({ ok: true, days: 31 });
    expect(exportRange('2026-10-01', '2026-11-01', 7)).toEqual({ ok: false, error: `Choose no more than ${EXPORT_MAX_DAYS} days.` });
  });
  test('an end before the start, a missing date and an impossible date are refused', () => {
    expect(exportRange('2026-10-07', '2026-10-01', 7).ok).toBe(false);
    expect(exportRange('', '2026-10-01', 7).ok).toBe(false);
    expect(exportRange('2026-02-31', '2026-03-02', 7).ok).toBe(false); // would silently roll over to March
    expect(exportRange('10/01/2026', '2026-10-02', 7).ok).toBe(false);
  });
  test('★ a typical device (7 entities) can export the full 31 days', () => {
    const r = exportRange('2026-10-01', '2026-10-31', 7);
    expect(r.ok).toBe(true);
    expect(r.bytes).toBeLessThan(EXPORT_BUDGET_BYTES);
  });
  test('★ a 200-entity device is held to the longest range that fits, with that range in the message', () => {
    expect(exportLongestDays(200)).toBe(1);
    expect(exportRange('2026-10-01', '2026-10-01', 200).ok).toBe(true);
    const refused = exportRange('2026-10-01', '2026-10-07', 200);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/200 entities/);
    expect(refused.error).toMatch(/Try up to 1 day\b/);
  });
  test('the longest range scales with the entity count and never exceeds the server limit', () => {
    expect(exportLongestDays(1)).toBe(EXPORT_MAX_DAYS);
    expect(exportLongestDays(60)).toBe(4); // 60 x 1440 x 75 = 6.48 MB a day
    expect(exportLongestDays(0)).toBe(EXPORT_MAX_DAYS); // an unknown count is treated as one entity, not as no limit
  });
});
