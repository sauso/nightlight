import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThemeToggle from '../src/components/ThemeToggle.jsx';
import { applyTheme, setTheme } from '../src/lib/theme.js';

describe('header theme toggle', () => {
  test('switches both the displayed theme and the saved choice', async () => {
    setTheme('light');
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const button = screen.getByRole('button', { name: 'Switch to dark mode' });
    expect(button).toHaveAttribute('title', 'Switch to dark mode');
    await user.click(button);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('nightlight_theme')).toBe('dark');
    expect(button).toHaveAccessibleName('Switch to light mode');
    expect(button).toHaveAttribute('title', 'Switch to light mode');
  });

  test('System pins the opposite of the mode currently shown', async () => {
    localStorage.setItem('nightlight_theme', 'system');
    applyTheme();
    const shown = document.documentElement.getAttribute('data-theme');
    const next = shown === 'dark' ? 'light' : 'dark';
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button', { name: `Switch to ${next} mode` }));
    expect(document.documentElement).toHaveAttribute('data-theme', next);
    expect(localStorage.getItem('nightlight_theme')).toBe(next);
  });

  test('two mounted toggles stay in sync', async () => {
    setTheme('light');
    const user = userEvent.setup();
    render(<><ThemeToggle /><ThemeToggle /></>);
    await user.click(screen.getAllByRole('button', { name: 'Switch to dark mode' })[0]);
    expect(screen.getAllByRole('button', { name: 'Switch to light mode' })).toHaveLength(2);
  });
});
