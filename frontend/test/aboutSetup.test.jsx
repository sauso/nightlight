import { afterEach, describe, test, expect, vi } from 'vitest';
import * as nativeBridge from '../src/lib/nativeBridge.js';
import { screen, waitFor, within } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import About from '../src/pages/About.jsx';
import { api } from '../src/lib/api.js';
import { setupApi } from '../src/lib/setupApi.js';

const LINK = { name: 'Setup status and picture check' };

afterEach(() => { vi.restoreAllMocks(); });

function mockSetup(status) {
  vi.spyOn(api, 'get').mockResolvedValue({ version: 'test' });
  return vi.spyOn(setupApi, 'read').mockResolvedValue({ status });
}

// Owner 2026-11-05: the row is clutter once setup is complete. Only `completed` hides it: a limited setup still needs the
// picture check, and an install upgraded from before the guide uses this link for diagnostics.
test.each(['not_started', 'in_progress', 'completed_limited', 'legacy_completed'])(
  '★ an admin sees the setup status and picture check link while setup is %s', async (status) => {
    mockSetup(status);
    renderAsAdmin(<About />);
    expect(await screen.findByRole('link', LINK)).toHaveAttribute('href', '/setup');
  });

test('★ an admin does not see the link once setup is completed', async () => {
  const read = mockSetup('completed');
  renderAsAdmin(<About />);
  await waitFor(() => expect(read).toHaveBeenCalled());
  await screen.findByText(/Self-hosted baby monitor/);
  expect(screen.queryByRole('link', LINK)).not.toBeInTheDocument();
});

test('the link stays hidden while the status is unknown (no flash on a finished install)', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ version: 'test' });
  vi.spyOn(setupApi, 'read').mockImplementation(() => new Promise(() => {}));
  renderAsAdmin(<About />);
  await screen.findByText(/Self-hosted baby monitor/);
  expect(screen.queryByRole('link', LINK)).not.toBeInTheDocument();
});

// Owner 2026-11-06: in the Android app the About page says which address the session is on and whether the Tailscale address is
// saved (there was no way to see either). Nothing is shown in a browser or an app without the feature.
// Owner 2026-11-06 (tidy): the lines moved out of the crowded header into their own "Connection" card, as label + value rows.
describe('the Android app Connection card', () => {
  const route = (value) => {
    mockSetup('completed');
    return vi.spyOn(nativeBridge, 'getConnectionRoute').mockResolvedValue(value);
  };
  // The card the rows are in: the header card holds only who and what this is.
  const connectionCard = async () => (await screen.findByText('Connection')).closest('.card');
  // [[label, value], ...] for the facts of a card (a small label over its value).
  const rowsOf = (card) => [...card.querySelectorAll('.fact')].map((fact) => [fact.querySelector('.fact__label').textContent, fact.querySelector('.fact__value').textContent]);

  // The muted line under a fact's value (the saved note or the reason).
  const noteOf = (card) => card.querySelector('.fact__note')?.textContent ?? null;

  test('★ on the Tailscale address with it saved: the address itself is shown (owner, 2026-11-07)', async () => {
    route({ via: 'tailscale', tailscaleSaved: true, address: 'nightlight.example.ts.net', why: null });
    renderAsAdmin(<About />);
    const card = await connectionCard();
    expect(rowsOf(card)).toEqual([
      ['Connected through', 'Tailscale address'],
      ['Tailscale address', 'nightlight.example.ts.net'],
    ]);
    expect(noteOf(card)).toBe('Saved for use away from home.');
  });

  test('a saved address the shell gave no readable host for says "Saved" rather than nothing', async () => {
    route({ via: 'saved', tailscaleSaved: true, address: null, why: null });
    renderAsAdmin(<About />);
    expect(rowsOf(await connectionCard())[1]).toEqual(['Tailscale address', 'Saved']);
  });

  test('★ not saved: each reason is its own sentence, nothing is guessed when none is known, and a saved address never shows one', async () => {
    const reasons = {
      'server-none': /isn't offering one.*Settings → Remote Access/,
      unknown: /couldn't say just now.*each time it starts/,
      unreachable: /couldn't reach it. Turn Tailscale on in the phone, then restart/,
      different: /different server, so it was not saved/,
      refused: /did not accept the address/,
    };
    for (const [why, pattern] of Object.entries(reasons)) {
      vi.restoreAllMocks();
      route({ via: 'saved', tailscaleSaved: false, address: null, why });
      const { unmount } = renderAsAdmin(<About />);
      const card = await connectionCard();
      expect(rowsOf(card)[1], why).toEqual(['Tailscale address', 'Not saved']);
      expect(noteOf(card), why).toMatch(pattern);
      unmount();
    }
    for (const why of [null, 'saved', 'something-new']) {
      vi.restoreAllMocks();
      route({ via: 'saved', tailscaleSaved: false, address: null, why });
      const { unmount } = renderAsAdmin(<About />);
      expect(noteOf(await connectionCard()), String(why)).toBeNull();
      unmount();
    }
    vi.restoreAllMocks();
    route({ via: 'saved', tailscaleSaved: true, address: 'a.ts.net', why: 'unreachable' });
    renderAsAdmin(<About />);
    expect(noteOf(await connectionCard())).toBe('Saved for use away from home.');
  });

  test('★ on the saved address with no Tailscale address saved', async () => {
    route({ via: 'saved', tailscaleSaved: false, address: null, why: null });
    renderAsAdmin(<About />);
    expect(rowsOf(await connectionCard())).toEqual([
      ['Connected through', 'Saved address'],
      ['Tailscale address', 'Not saved'],
    ]);
  });

  test('an unrecognised address names nothing but still says whether a Tailscale address is saved', async () => {
    route({ via: 'other', tailscaleSaved: true, address: 'nightlight.example.ts.net', why: null });
    renderAsAdmin(<About />);
    expect(rowsOf(await connectionCard())).toEqual([['Tailscale address', 'nightlight.example.ts.net']]);
  });

  test('★ the rows are in their own card, not in the header (the header card is the one with the tagline)', async () => {
    route({ via: 'saved', tailscaleSaved: true });
    renderAsAdmin(<About />);
    const card = await connectionCard();
    const header = screen.getByText(/Self-hosted baby monitor/).closest('.card');
    expect(header).not.toBe(card);
    expect(within(header).queryByText(/Connected through|Tailscale address/)).not.toBeInTheDocument();
  });

  test('★ nothing in a browser or an app without the feature, and a caregiver sees the same card as an admin', async () => {
    route(null);
    renderAsAdmin(<About />);
    await screen.findByText(/Self-hosted baby monitor/);
    expect(screen.queryByText('Connection')).not.toBeInTheDocument();
    expect(screen.queryByText('Connected through')).not.toBeInTheDocument();
    vi.restoreAllMocks();
    route({ via: 'saved', tailscaleSaved: true });
    renderAsCaregiver(<About />);
    expect(rowsOf(await connectionCard())[0]).toEqual(['Connected through', 'Saved address']);
  });
});

test('a caregiver never sees the link and never asks for the setup status', async () => {
  const read = mockSetup('in_progress');
  renderAsCaregiver(<About />);
  await screen.findByText(/Self-hosted baby monitor/);
  expect(screen.queryByRole('link', LINK)).not.toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
});
