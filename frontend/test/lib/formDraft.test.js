// formDraft.js (#377): reload-surviving drafts of settings forms.
//
// What matters here, in order: (1) a SECRET is never written, whatever a caller asks for; (2) a draft
// expires and is scoped to a person; (3) broken storage is survivable. Every test plants real values in the
// real sessionStorage that jsdom provides: nothing is mocked except the one case that needs storage to fail.
import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  DRAFT_PREFIX, draftKey, pickDraftFields, saveDraft, loadDraft, clearDraft, clearAllDrafts,
} from '../../src/lib/formDraft.js';

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const allStoredText = () => Object.keys(sessionStorage).map((k) => `${k}=${sessionStorage.getItem(k)}`).join('\n');

describe('★ secrets are never stored', () => {
  const SECRET = 'planted-secret-value-9f3';

  test('a credential-named field is dropped even when the caller allows it', () => {
    // The allow-list is the primary defence; this is the backstop for a careless one. Each name below is a
    // field this app really has or is shaped like one (cameras, push providers, MQTT).
    const names = ['rtsp_password', 'talk_password', 'app_token', 'api_key', 'user_key', 'client_secret', 'auth_header', 'credentials'];
    const values = Object.fromEntries(names.map((n) => [n, SECRET]));
    values.name = 'Nursery';
    saveDraft('k', values, [...names, 'name']);
    expect(allStoredText()).not.toContain(SECRET);
    expect(loadDraft('k', [...names, 'name'])).toEqual({ name: 'Nursery' });
  });

  test('a field that is not on the allow-list is dropped even when its name looks harmless', () => {
    saveDraft('k', { name: 'Nursery', notes: SECRET }, ['name']);
    expect(allStoredText()).not.toContain(SECRET);
  });

  test('an old entry holding a secret cannot be read back through a narrower allow-list', () => {
    // Simulates an entry left by an earlier build that stored more. Loading filters AGAIN.
    sessionStorage.setItem('k', JSON.stringify({ at: Date.now(), values: { name: 'x', rtsp_password: SECRET } }));
    expect(loadDraft('k', ['name', 'rtsp_password'])).toEqual({ name: 'x' });
  });

  test('non-primitive values (a photo object, a nested object) are not stored', () => {
    expect(pickDraftFields({ name: 'a', photo: { url: 'x' }, list: [1] }, ['name', 'photo', 'list'])).toEqual({ name: 'a' });
  });
});

describe('storing and restoring', () => {
  test('round-trips strings, numbers and booleans', () => {
    saveDraft('k', { a: 'x', b: 0, c: false, d: null }, ['a', 'b', 'c', 'd']);
    expect(loadDraft('k', ['a', 'b', 'c', 'd'])).toEqual({ a: 'x', b: 0, c: false, d: null });
  });

  test('no entry, or an entry with nothing usable, is null', () => {
    expect(loadDraft('missing', ['a'])).toBeNull();
    saveDraft('k', { a: 'x' }, ['a']);
    expect(loadDraft('k', ['other'])).toBeNull();
  });

  test('★ an entry older than the time limit is ignored and removed', () => {
    // docs/architecture.md promises a 6-hour lifetime (#738). Keep the literal independent of the implementation.
    const now = 1_800_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    saveDraft('k', { a: 'x' }, ['a']);
    spy.mockReturnValue(now + 6 * 60 * 60 * 1000 - 60 * 1000);
    expect(loadDraft('k', ['a'])).toEqual({ a: 'x' });
    spy.mockReturnValue(now + 6 * 60 * 60 * 1000 + 60 * 1000);
    expect(loadDraft('k', ['a'])).toBeNull();
    expect(sessionStorage.getItem('k')).toBeNull();
  });

  test('corrupt JSON is treated as no draft', () => {
    sessionStorage.setItem('k', '{not json');
    expect(loadDraft('k', ['a'])).toBeNull();
  });

  test('clearDraft removes one; clearAllDrafts removes every draft and nothing else', () => {
    saveDraft(draftKey('u1', 'a'), { x: 1 }, ['x']);
    saveDraft(draftKey('u2', 'b'), { x: 1 }, ['x']);
    sessionStorage.setItem('unrelated', 'keep');
    clearDraft(draftKey('u1', 'a'));
    expect(loadDraft(draftKey('u1', 'a'), ['x'])).toBeNull();
    expect(loadDraft(draftKey('u2', 'b'), ['x'])).toEqual({ x: 1 });
    clearAllDrafts();
    expect(loadDraft(draftKey('u2', 'b'), ['x'])).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('keep');
  });

  test('a draft is keyed by person: another user never sees it', () => {
    expect(draftKey('u1', 'child:1')).toBe(`${DRAFT_PREFIX}u1:child:1`);
    saveDraft(draftKey('u1', 'f'), { a: 'mine' }, ['a']);
    expect(loadDraft(draftKey('u2', 'f'), ['a'])).toBeNull();
  });
});

describe('broken storage does not break a form', () => {
  test('every call survives a storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => saveDraft('k', { a: 1 }, ['a'])).not.toThrow();
    expect(loadDraft('k', ['a'])).toBeNull();
    expect(() => clearDraft('k')).not.toThrow();
    expect(() => clearAllDrafts()).not.toThrow();
  });
});
