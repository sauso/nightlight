// #381: drive dnd-kit's real keyboard sensor through the labelled tile handle.
// jsdom has no layout, so give each visible tile a distinct rectangle for neighbour finding.
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import LiveMonitor from '../src/components/LiveMonitor.jsx';
import { renderAsCaregiver } from './helpers/render.jsx';
import { api } from '../src/lib/api.js';

const CAMERAS = [
  { id: 'a', name: 'Camera A', mediamtx_path: 'a' },
  { id: 'hidden', name: 'Camera hidden', mediamtx_path: 'hidden', disabled: 1 },
  { id: 'b', name: 'Camera B', mediamtx_path: 'b' },
  { id: 'c', name: 'Camera C', mediamtx_path: 'c' },
];

const gridOrder = () => [...document.querySelectorAll('.card-grid .camera-tile__name')]
  .map((node) => node.textContent);

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    toJSON() { return this; } };
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect() {
    if (this.classList.contains('sortable-camera-tile')) {
      const index = [...this.parentElement.children].indexOf(this);
      return rect(20 + index * 120, 20, 100, 100);
    }
    return rect(0, 0, 800, 600);
  });
});
afterEach(() => vi.restoreAllMocks());

async function moveFirstCamera(user) {
  const handle = screen.getByRole('button', { name: 'Reorder Camera A' });
  handle.focus();
  expect(document.activeElement).toBe(handle);
  expect(handle.getAttribute('aria-describedby')).toBeTruthy();
  expect(document.getElementById(handle.getAttribute('aria-describedby')).textContent)
    .toContain('Use the arrow keys to move it');
  await user.keyboard('[Space]');
  // KeyboardSensor installs its document key listener on the next task.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await user.keyboard('[ArrowRight]');
  await waitFor(() => expect(screen.getByRole('status').textContent)
    .toBe('Moved Camera A to position 2 of 3'));
  await user.keyboard('[Space]');
}

test('keyboard reorder announces the visible position and saves the full order once', async () => {
  const { user } = renderAsCaregiver(<LiveMonitor />, { cameras: CAMERAS });
  expect(gridOrder()).toEqual(['Camera A', 'Camera B', 'Camera C']);
  await moveFirstCamera(user);
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  expect(api.put).toHaveBeenCalledWith('/cameras/reorder', {
    order: ['hidden', 'b', 'a', 'c'],
  });
  expect(gridOrder()).toEqual(['Camera B', 'Camera A', 'Camera C']);
  expect(screen.getByRole('status').textContent).toBe('Moved Camera A to position 2 of 3');
});

test('a keyboard move refused by the server puts the tiles back', async () => {
  const refusal = Object.assign(new Error('This move cannot be saved.'), {
    data: { reason: 'would_change_sleep_camera' },
  });
  api.put.mockRejectedValue(refusal);
  const { user } = renderAsCaregiver(<LiveMonitor />, { cameras: CAMERAS });
  await moveFirstCamera(user);
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(gridOrder()).toEqual(['Camera A', 'Camera B', 'Camera C']));
  expect(screen.getByRole('alert').textContent).toContain('This move cannot be saved.');
});

