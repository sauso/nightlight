import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let theme;
let media;

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  media = {
    matches: false,
    addEventListener: vi.fn(),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  theme = await import('../../src/lib/theme.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('resolved theme', () => {
  test('reads explicit light and dark choices', () => {
    localStorage.setItem('nightlight_theme', 'light');
    expect(theme.getResolvedTheme()).toBe('light');
    localStorage.setItem('nightlight_theme', 'dark');
    expect(theme.getResolvedTheme()).toBe('dark');
  });

  test('resolves System from the device and reapplies when it changes', () => {
    localStorage.setItem('nightlight_theme', 'system');
    expect(theme.getResolvedTheme()).toBe('dark');
    theme.applyTheme();
    const callback = vi.fn();
    theme.subscribeTheme(callback);
    media.matches = true;
    expect(theme.getResolvedTheme()).toBe('light');
    media.addEventListener.mock.calls[0][1]();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('subscribers hear theme changes until they unsubscribe', () => {
    const callback = vi.fn();
    const unsubscribe = theme.subscribeTheme(callback);
    theme.setTheme('light');
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
    theme.setTheme('dark');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('a choice still resolves for this session when storage is blocked', () => {
    localStorage.setItem('nightlight_theme', 'light');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    theme.setTheme('dark');
    expect(theme.getResolvedTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
