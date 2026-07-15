import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';
import { FONT_PRESETS, DEFAULT_FONT_CHOICE } from './fonts.js';

const SettingsContext = createContext(null);

const DEFAULTS = {
  app_name: 'The Nursery',
  accent_color: '#F5D9A8',
  live_color: '#7FBFA3',
  offline_color: '#E08585',
  timezone: 'UTC',
  font_choice: DEFAULT_FONT_CHOICE,
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

  async function refresh() {
    try {
      const data = await api.get('/settings');
      setSettings(data);
      applyTheme(data);
    } catch {
      // Fall back to defaults silently — this shouldn't block the app from loading.
      applyTheme(DEFAULTS);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, loading, refresh }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
