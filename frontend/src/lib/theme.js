// Per-device light/dark theme. Stored in localStorage like the other per-device tile prefs
// (mute, quality, stopped) — deliberately not synced through the account, so a phone and a
// wall-mounted tablet can each pick what suits them. Three choices: 'light' | 'dark' |
// 'system' (follow the OS). We resolve 'system' to a concrete light/dark here in JS and stamp
// it as data-theme on <html>, so the CSS only ever deals with [data-theme='light' | 'dark'].
const THEME_KEY = 'nightlight_theme';
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

export function getTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

function resolve(choice) {
  if (choice === 'light' || choice === 'dark') return choice;
  return prefersLight.matches ? 'light' : 'dark';
}

export function applyTheme(choice = getTheme()) {
  document.documentElement.setAttribute('data-theme', resolve(choice));
}

export function setTheme(choice) {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Private browsing / storage disabled — still applies for this session.
  }
  applyTheme(choice);
}

// While following the system, re-resolve when the OS flips light/dark.
prefersLight.addEventListener?.('change', () => {
  if (getTheme() === 'system') applyTheme('system');
});
