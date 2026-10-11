// The Record button on the camera tile (#680): ring-and-dot icon when idle, the old solid disc +
// timer in the red chip while recording.
//
// WHY this exists: the idle icon used to be lucide's solid `<Circle fill="currentColor" />`, which is a
// lot of white on a bedside screen at night. The owner asked for the classic record symbol (ring with a
// smaller centre dot) for the IDLE state only; the ACTIVE state (red chip, timer, pulse) must stay as it
// was. Both halves are pinned here, plus the things that must NOT have changed (label, pressed state).
//
// The tile is rendered through LiveMonitor, as liveMonitor.test.jsx does: jsdom mounts it fine (it logs a
// "not implemented: HTMLMediaElement.load" notice and nothing throws).
//
// ⚠️ What this cannot check: how the ring and dot actually LOOK at 16px, at night, on a phone. jsdom has
// no layout or paint. The geometry is asserted as numbers (below) so it cannot drift silently, but the
// look itself needs eyes on a real screen.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAsAdmin } from './helpers/render.jsx';
import LiveMonitor from '../src/components/LiveMonitor.jsx';
import RecordIcon from '../src/components/icons/RecordIcon.jsx';
import { api } from '../src/lib/api.js';

const camera = (extra = {}) => ({
  id: 'c1', name: 'Nursery', mediamtx_path: 'p1', child_id: 'kid-1', can_record: true, ...extra,
});
const KIDS = [{ id: 'kid-1', name: 'Child B' }];
const mount = (extra) => renderAsAdmin(<LiveMonitor />, { cameras: [camera(extra)], kids: KIDS });

// The lucide `Circle` renders `<svg class="lucide lucide-circle">`; the hand-written icon is
// `svg.record-icon`. Looking them up by class is how the tests tell the two apart.
const ring = (btn) => btn.querySelector('.record-icon .record-icon__ring');
const dot = (btn) => btn.querySelector('.record-icon .record-icon__dot');
const solidDisc = (btn) => btn.querySelector('svg.lucide-circle');

afterEach(() => vi.restoreAllMocks());

describe('Record button, idle', () => {
  test('★ shows the ring-and-dot icon: both a ring and a centre dot', () => {
    mount();
    const btn = screen.getByRole('button', { name: 'Record Nursery' });
    expect(ring(btn)).not.toBeNull();
    expect(dot(btn)).not.toBeNull();
    // The ring is an outline (stroke, no fill) and the dot is solid (fill, no stroke); both take the
    // button's colour so the white + glow of the other tile controls carries over.
    expect(ring(btn).getAttribute('fill')).toBe('none');
    expect(ring(btn).getAttribute('stroke')).toBe('currentColor');
    expect(dot(btn).getAttribute('fill')).toBe('currentColor');
  });

  test('★ is NOT the solid disc any more', () => {
    mount();
    const btn = screen.getByRole('button', { name: 'Record Nursery' });
    expect(solidDisc(btn)).toBeNull();
  });

  test('keeps the 16px footprint, so the tap target is unchanged', () => {
    mount();
    const svg = screen.getByRole('button', { name: 'Record Nursery' }).querySelector('svg');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  test('no timer and the idle label, title and pressed state are unchanged', () => {
    mount();
    const btn = screen.getByRole('button', { name: 'Record Nursery' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('title')).toBe('Record this moment');
    expect(btn.classList.contains('rec-btn--active')).toBe(false);
    expect(btn.querySelector('.rec-btn__time')).toBeNull();
  });
});

describe('Record button, recording', () => {
  test('★ pressing it switches to the red chip: solid disc and the timer, not the ring', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ recording: true, elapsed_s: 65 });
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Record Nursery' }));

    const btn = await screen.findByRole('button', { name: 'Stop recording Nursery' });
    expect(api.post).toHaveBeenCalledWith('/cameras/c1/record/start', {});
    expect(btn.classList.contains('rec-btn--active')).toBe(true);
    expect(btn.querySelector('.rec-btn__time').textContent).toBe('1:05');
    // The old behaviour, kept: the solid disc, and no ring/dot.
    expect(solidDisc(btn)).not.toBeNull();
    expect(solidDisc(btn).getAttribute('fill')).toBe('currentColor');
    expect(ring(btn)).toBeNull();
    expect(dot(btn)).toBeNull();
  });

  test('a camera that is already recording (from the server) opens in the active state', () => {
    mount({ recording: 1, recording_elapsed_s: 5 });
    const btn = screen.getByRole('button', { name: 'Stop recording Nursery' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('title')).toBe('Tap to stop and save');
    expect(btn.querySelector('.rec-btn__time').textContent).toBe('0:05');
    expect(solidDisc(btn)).not.toBeNull();
    expect(ring(btn)).toBeNull();
  });

  test('stopping goes back to the ring-and-dot icon', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({});
    mount({ recording: 1, recording_elapsed_s: 5 });
    await userEvent.click(screen.getByRole('button', { name: 'Stop recording Nursery' }));

    const btn = await screen.findByRole('button', { name: 'Record Nursery' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(ring(btn)).not.toBeNull();
    expect(dot(btn)).not.toBeNull();
    expect(solidDisc(btn)).toBeNull();
    expect(btn.querySelector('.rec-btn__time')).toBeNull();
  });
});

describe('RecordIcon', () => {
  // The geometry is the owner's reference (a 24-unit box; a thick-ish ring, a dot about half the outer
  // diameter). Pinned as numbers so a "tidy-up" cannot turn it back into a fat ring or a pinprick.
  test('★ geometry: ring r 10.2 / stroke 1.7 inside a 24 box, dot r 5.6 at the centre', () => {
    const { container } = renderAsAdmin(<RecordIcon />);
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('width')).toBe('24');
    const r = container.querySelector('.record-icon__ring');
    const d = container.querySelector('.record-icon__dot');
    expect([r.getAttribute('cx'), r.getAttribute('cy'), r.getAttribute('r')]).toEqual(['12', '12', '10.2']);
    expect(r.getAttribute('stroke-width')).toBe('1.7');
    expect([d.getAttribute('cx'), d.getAttribute('cy'), d.getAttribute('r')]).toEqual(['12', '12', '5.6']);
    // The ring's outer edge must stay inside the viewBox or it clips: r + stroke/2 <= 12.
    expect(10.2 + 1.7 / 2).toBeLessThanOrEqual(12);
  });

  test('size and color props are honoured, and extra props pass through', () => {
    const { container } = renderAsAdmin(<RecordIcon size={16} color="#e0555f" data-x="1" />);
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('data-x')).toBe('1');
    expect(container.querySelector('.record-icon__ring').getAttribute('stroke')).toBe('#e0555f');
    expect(container.querySelector('.record-icon__dot').getAttribute('fill')).toBe('#e0555f');
  });
});
