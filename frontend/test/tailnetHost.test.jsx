import { describe, expect, test, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAs } from './helpers/render.jsx';
import { isTailnetHost } from '../src/lib/tailnetHost.js';
import ServerUnreachable from '../src/components/ServerUnreachable.jsx';

describe('isTailnetHost', () => {
  test.each([
    'nightlight.bearded-shiner.ts.net', 'Nightlight.Example.TS.NET', 'nightlight.example.ts.net.',
    '100.64.0.0', '100.101.102.103', '100.127.255.255',
  ])('%s is a tailnet host', (host) => expect(isTailnetHost(host)).toBe(true));

  // The CGNAT boundary is the part a regex gets wrong: 100.63 and 100.128 are ordinary addresses.
  test.each([
    '100.63.255.255', '100.128.0.0', '100.64.0.256', '100.64.0', '100.64.0.1.5', '100.064.0.1', '100.64.00.1',
    '192.168.1.10', '10.0.0.5', 'localhost', 'nightlight.local', 'ts.net', 'example.com', 'notts.net', 'a.ts.net.evil.com',
    '', null, undefined, 42,
  ])('%s is not', (host) => expect(isTailnetHost(host)).toBe(false));
});

describe('ServerUnreachable wording', () => {
  const mount = (hostname) => renderAs(null, <ServerUnreachable onRetry={vi.fn()} retrying={false} hostname={hostname} />);

  test('★ on a tailnet address it tells the person to check Tailscale, not the home network', () => {
    mount('nightlight.example.ts.net');
    expect(screen.getByText(/Check that Tailscale is switched on/)).toBeTruthy();
    expect(screen.queryByText(/home network/)).toBeNull();
  });

  test('on any other address the home-network advice is unchanged', () => {
    mount('192.168.1.10');
    expect(screen.getByText(/this device is on the home network/)).toBeTruthy();
    expect(screen.queryByText(/Tailscale/)).toBeNull();
  });
});
