import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderAsAdmin } from './helpers/render.jsx';
import CameraTile from '../src/components/CameraTile.jsx';

const camera = {
  id: 'c1', name: 'Camera', mediamtx_path: 'p1', child_id: 'child-1',
  can_record: true, talk_configured: true, ptz_supported: true,
};

afterEach(() => {
  delete window.Capacitor;
  delete document.fullscreenElement;
  vi.restoreAllMocks();
});

test('PiP hides every rendered video overlay button, including Record', () => {
  const { container } = renderAsAdmin(<CameraTile camera={camera} />);
  const wrap = container.querySelector('.camera-tile__video-wrap');
  const buttonClasses = [...wrap.querySelectorAll(':scope > button')]
    .flatMap((button) => [...button.classList].filter((name) => name.endsWith('-btn')));
  expect(buttonClasses).toContain('rec-btn');

  // jsdom does not paint index.css here. Inspect selector tokens in the one PiP hide rule,
  // while deriving the required button classes from the rendered tile itself.
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
  const hidden = new Set(css.split('}').flatMap((block) => {
    const [selectorList, declarations] = block.split('{');
    if (!selectorList || !declarations || !/display\s*:\s*none\s*!important\s*;?/.test(declarations)) return [];
    return selectorList.replace(/\/\*[\s\S]*?\*\//g, '').split(',')
      .map((selector) => selector.trim())
      .filter((selector) => selector.startsWith('body.in-pip .'))
      .map((selector) => selector.slice('body.in-pip .'.length));
  }));
  for (const name of buttonClasses) expect(hidden.has(name), name).toBe(true);
});

describe('fullscreen native bars for this tile', () => {
  test('enters, exits, ignores another tile, and restores bars on unmount', async () => {
    const { container, unmount } = renderAsAdmin(<CameraTile camera={camera} />);
    const wrap = container.querySelector('.camera-tile__video-wrap');
    const setEnabled = vi.fn().mockResolvedValue(undefined);
    window.Capacitor = { isNativePlatform: () => true, Plugins: { Immersive: { setEnabled } } };
    const change = (element) => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: element });
      act(() => document.dispatchEvent(new Event('fullscreenchange')));
    };

    change(document.createElement('div'));
    expect(setEnabled).not.toHaveBeenCalled();
    change(wrap);
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ enabled: true }));
    change(null);
    await waitFor(() => expect(setEnabled).toHaveBeenLastCalledWith({ enabled: false }));
    change(wrap);
    unmount();
    await waitFor(() => expect(setEnabled).toHaveBeenLastCalledWith({ enabled: false }));
  });
});
