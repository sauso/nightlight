import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useAuth } from './AuthContext.jsx';
import { FONT_PRESETS, DEFAULT_FONT_CHOICE } from './fonts.js';

// Exported so tests can inject a value directly — chiefly to render a screen as an admin and
// again as a caregiver, since role gating is real in this UI and is where bugs hide.
export const SettingsContext = createContext(null);

const DEFAULTS = {
  app_name: 'Nightlight',
  accent_color: '#f4c56a',
  live_color: '#7FBFA3',
  offline_color: '#E08585',
  timezone: 'UTC',
  font_choice: DEFAULT_FONT_CHOICE,
  temp_unit: 'C',
};

function applyTheme(settings) {
  const root = document.documentElement.style;
  root.setProperty('--accent', settings.accent_color);
  root.setProperty('--live', settings.live_color);
  root.setProperty('--offline', settings.offline_color);
  const font = FONT_PRESETS[settings.font_choice] || FONT_PRESETS[DEFAULT_FONT_CHOICE];
  root.setProperty('--font-display', font.display);
  root.setProperty('--font-body', font.body);
  document.title = settings.app_name;
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  // Optional: tests render this provider outside an AuthProvider, and it must still work there —
  // it then simply never re-fetches, which is the pre-existing mount-only behaviour.
  const { user } = useAuth() || {};
  // Which refresh is current, so a slow earlier response can't overwrite a newer one (see refresh).
  const reqSeq = useRef(0);
  // Whether real settings have ever arrived, so a later failure doesn't reset a working theme.
  const loadedOnce = useRef(false);

  async function refresh() {
    // Ignore a response that a newer refresh has already superseded. Signing in fires a second fetch
    // while the anonymous one may still be in flight, and the anonymous reply landing last would
    // overwrite the admin settings with the 7 public fields — SettingsRecording does setForm(settings),
    // a replace rather than a merge, so its form would silently blank.
    const seq = ++reqSeq.current;
    try {
      const data = await api.get('/settings');
      if (seq !== reqSeq.current) return;
      loadedOnce.current = true;
      setSettings(data);
      applyTheme(data);
    } catch {
      // Only fall back to defaults if we have never had real settings. This catch exists so a FIRST
      // failure doesn't block the app from loading — not to undo a good load. Re-applying DEFAULTS
      // after a success would reset the palette and the tab title while `settings` state kept the real
      // values, leaving a branded install half-themed after one transient failure, with no error and
      // no retry. Harmless before this file re-fetched on sign-in, because it only ever ran at mount
      // when the state genuinely was DEFAULTS.
      if (seq === reqSeq.current && !loadedOnce.current) applyTheme(DEFAULTS);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  // Re-fetch whenever the signed-in identity changes, not only at mount. GET /settings is an
  // allow-list keyed on role — an anonymous caller gets the presentation fields the login screen
  // needs, an admin also gets the config the settings forms bind. Signing in does not reload the page
  // (Login navigates), so fetching only at mount would leave every session that began at the login
  // screen holding the anonymous response, and the admin settings forms would seed from fields that
  // were never sent. Runs on mount too (user is undefined then), so the theme still applies
  // immediately rather than waiting for auth to resolve.
  useEffect(() => {
    refresh();
  }, [user?.id, user?.role]);

  // Publish a settings object a caller already HAS — a PUT's response body — as the new committed
  // state, instead of asking the caller to call refresh() and re-fetch it. #449 (Codex review F1):
  // `refresh()`'s catch above swallows a failed GET and leaves `settings` unchanged, so "save, clear
  // the local drafts, then refresh()" can show the OLD value next to a "Saved ✓" banner if that
  // refresh's request happens to fail — and the next Save would then write that stale value back over
  // the one the server actually has. A PUT's response is the server's own word on what it just wrote,
  // so a caller holding one (PUT /settings returns the full, normalised admin settings — see
  // backend/src/routes/settings.js) should commit it directly rather than trusting a second, separate
  // read that can fail independently of the write that already succeeded. Bumps reqSeq first so an
  // older refresh() already in flight can't land after this and overwrite it with a stale read.
  function commit(serverSettings) {
    ++reqSeq.current;
    loadedOnce.current = true;
    setSettings(serverSettings);
    applyTheme(serverSettings);
    // A commit IS an authoritative load, same as a successful refresh() (see its `finally` above) —
    // it's the server's own word on the current settings, just delivered via a PUT response instead of
    // a GET. Without this, a commit landing while the initial (or post-login) refresh() is still
    // in-flight never clears `loading`: refresh()'s `finally` only fires for the request whose `seq`
    // still matches `reqSeq.current`, and bumping reqSeq above means that in-flight refresh's `finally`
    // now targets a stale seq and skips its `setLoading(false)` — so `loading` would stay true forever
    // with real settings already on screen.
    setLoading(false);
  }

  return (
    <SettingsContext.Provider value={{ settings, loading, refresh, commit }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
