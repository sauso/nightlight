import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { getResolvedTheme, setTheme, subscribeTheme } from '../lib/theme.js';

export default function ThemeToggle() {
  const resolved = useSyncExternalStore(subscribeTheme, getResolvedTheme);
  const next = resolved === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} mode`;
  const Icon = next === 'light' ? Sun : Moon;

  return (
    <button
      type="button"
      className="app-header__theme"
      aria-label={label}
      title={label}
      onClick={() => setTheme(next)}
    >
      <Icon size={20} aria-hidden="true" />
    </button>
  );
}
