// The logo (owner, 2026-11-05): the header shows the SVG as it is; every other place shows it on the header colour in a
// rounded tile, the same tile everywhere (the setup guide's used to be square and About's rounded).
import { afterEach, describe, expect, test, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAs, renderAsAdmin } from './helpers/render.jsx';
import Logo from '../src/components/Logo.jsx';
import AppHeader from '../src/components/AppHeader.jsx';
import About from '../src/pages/About.jsx';
import ServerUnreachable from '../src/components/ServerUnreachable.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

const SVG = '/icons/nightlight-logo.svg';

describe('Logo', () => {
  test('★ the default is a tile of the given size holding the SVG, decorative (empty alt)', () => {
    const { container } = renderAs(null, <Logo size={72} />);
    const tile = container.querySelector('.logo-tile');
    expect(tile).not.toBeNull();
    expect(tile.style.width).toBe('72px');
    expect(tile.style.height).toBe('72px');
    const img = tile.querySelector('img');
    expect(img.getAttribute('src')).toBe(SVG);
    expect(img.getAttribute('alt')).toBe('');
  });

  test('glow and a caller class are added to the tile; neither is there by default', () => {
    const plain = renderAs(null, <Logo />);
    expect(plain.container.querySelector('.logo-tile--glow')).toBeNull();
    plain.unmount();
    const { container } = renderAs(null, <Logo glow className="auth-icon" />);
    expect(container.querySelector('.logo-tile.logo-tile--glow.auth-icon')).not.toBeNull();
  });

  test('★ tile={false} is the bare SVG with the caller class and no tile (the header)', () => {
    const { container } = renderAs(null, <Logo tile={false} className="app-header__icon" />);
    expect(container.querySelector('.logo-tile')).toBeNull();
    const img = container.querySelector('img.app-header__icon');
    expect(img.getAttribute('src')).toBe(SVG);
    expect(img.getAttribute('alt')).toBe('');
  });
});

describe('where the logo appears', () => {
  test('★ the header shows the bare SVG, not a tile', () => {
    const { container } = renderAsAdmin(<AppHeader title="Nightlight" />);
    expect(container.querySelector('.app-header img.app-header__icon').getAttribute('src')).toBe(SVG);
    expect(container.querySelector('.logo-tile')).toBeNull();
  });

  test('★ About shows the tile', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ version: 'test' });
    const { container } = renderAsAdmin(<About />);
    await screen.findByText(/Self-hosted baby monitor/);
    expect(container.querySelector('.about-hero .logo-tile img').getAttribute('src')).toBe(SVG);
  });

  test('the "Can\'t reach" screen shows the tile', () => {
    const { container } = renderAs(null, <ServerUnreachable onRetry={() => {}} retrying={false} hostname="192.168.1.10" />);
    expect(container.querySelector('.auth-card .logo-tile img').getAttribute('src')).toBe(SVG);
  });
});
