// The Children tab and a child's detail screen — the pages actually used every day.
//
// Three things here are worth pinning and none of them are cosmetic:
//   1. ROLE GATING ON THE CAMERA ROWS. A caregiver must not be able to tap through to camera settings.
//      The row renders as a <button> for an admin and a plain <div> otherwise, so the difference is
//      visible to a test exactly as it is to a person.
//   2. ALERTS ARE FILTERED TO THIS CHILD'S CAMERAS, client-side, by camera_id. Get that wrong and one
//      child's page shows the other child's room — which is both a bug and a small privacy failure.
//   3. AN UNKNOWN CHILD RENDERS A PLACEHOLDER, NOT A CRASH. `kids` arrives from a context that is empty
//      on first paint, so every deep link hits this branch for a moment before the data lands.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAs, renderAsAdmin, renderAsCaregiver, forEachRole } from './helpers/render.jsx';
import Children from '../src/pages/Children.jsx';
import ChildDetail from '../src/pages/ChildDetail.jsx';
import { api } from '../src/lib/api.js';

const KIDS = [
  { id: 'kid-1', name: 'Raffa', birthday: '2023-03-01', color: '#f4c56a', photo: null },
  { id: 'kid-2', name: 'Renz', birthday: null, color: '#7FBFA3', photo: null },
];

// cam-hall belongs to no child: it must never be counted or listed against either of them.
const CAMS = [
  { id: 'cam-a1', name: 'Raffa Room', child_id: 'kid-1', statusLevel: 'live' },
  { id: 'cam-a2', name: 'Raffa Cot', child_id: 'kid-1', statusLevel: 'offline' },
  { id: 'cam-b1', name: 'Renz Room', child_id: 'kid-2', statusLevel: 'live' },
  { id: 'cam-hall', name: 'Hallway', child_id: null, statusLevel: 'live' },
];

const alert = (cameraId, i = 0) => ({
  id: `ev-${cameraId}-${i}`,
  camera_id: cameraId,
  camera_name: cameraId,
  type: 'motion',
  created_at: '2026-08-30 09:00:00',
});

// Path-aware so the child cards (sleep summary, morning review, timelapses, recordings) each get
// something harmless while the test drives only the alerts feed.
function mockApi({ alerts = [] } = {}) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    if (String(path).includes('/cameras/alerts')) return Promise.resolve(alerts);
    return Promise.resolve(null);
  });
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'del').mockResolvedValue({});
}

const detailRoutes = <Routes><Route path="/children/:id" element={<ChildDetail />} /></Routes>;
const atChild = (id = 'kid-1') => ({ route: `/children/${id}`, kids: KIDS, cameras: CAMS });

afterEach(() => vi.restoreAllMocks());

// --- the Children tab ---------------------------------------------------------------------------

describe('the Children tab', () => {
  test('shows one card per child, for either role', async () => {
    await forEachRole(async (_name, who) => {
      const { unmount } = renderAs(who, <Children />, { kids: KIDS, cameras: CAMS });
      expect(screen.getByText('Raffa')).toBeTruthy();
      expect(screen.getByText('Renz')).toBeTruthy();
      unmount();
    });
  });

  test('counts only the cameras assigned to that child, and pluralises', () => {
    // The unassigned hallway camera is the point: it exists, and it belongs to neither of them.
    renderAsAdmin(<Children />, { kids: KIDS, cameras: CAMS });
    expect(screen.getByText(/2 cameras/)).toBeTruthy();
    expect(screen.getByText(/1 camera(?!s)/)).toBeTruthy();
  });

  test('an age is shown only when a birthday is known', () => {
    renderAsAdmin(<Children />, { kids: KIDS, cameras: CAMS });
    // Raffa has a birthday, so his meta line carries an age after the camera count; Renz's does not.
    expect(screen.getByText(/2 cameras ·/)).toBeTruthy();
    expect(screen.getByText(/^1 camera$/)).toBeTruthy();
  });

  test('with no children it says so instead of rendering an empty page', () => {
    renderAsAdmin(<Children />, { kids: [], cameras: [] });
    expect(screen.getByText(/No children yet/)).toBeTruthy();
  });
});

// --- a child's detail screen --------------------------------------------------------------------

describe('a child detail screen', () => {
  beforeEach(() => mockApi());

  test('lists only that child\'s cameras', async () => {
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    expect(await screen.findByText('Raffa Room')).toBeTruthy();
    expect(screen.getByText('Raffa Cot')).toBeTruthy();
    expect(screen.queryByText('Renz Room')).toBeNull();
    expect(screen.queryByText('Hallway')).toBeNull();
    expect(screen.getByText('Cameras · 2')).toBeTruthy();
  });

  test('a child with no cameras is told how to assign one', async () => {
    renderAsAdmin(detailRoutes, { ...atChild('kid-1'), cameras: [] });
    expect(await screen.findByText(/No cameras assigned yet/)).toBeTruthy();
  });

  // ★ The role gate. CameraRow renders a <button> when it is given an onClick and a <div> when it is
  // not, so "can this person tap through to camera settings" is directly observable.
  test('an admin can tap a camera row through to its settings', async () => {
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    const row = await screen.findByText('Raffa Room');
    expect(row.closest('button')).toBeTruthy();
  });

  test('a caregiver sees the same cameras but cannot tap into them', async () => {
    renderAsCaregiver(detailRoutes, atChild('kid-1'));
    const row = await screen.findByText('Raffa Room');
    expect(row).toBeTruthy();
    expect(row.closest('button')).toBeNull();
  });

  test('an unknown child renders a placeholder rather than crashing', async () => {
    // `kids` is empty on first paint, so every deep link passes through this branch.
    renderAsAdmin(detailRoutes, { ...atChild('nobody'), kids: [] });
    expect(await screen.findByText('Loading…')).toBeTruthy();
  });

  test('a child with no birthday is invited to add one', async () => {
    renderAsAdmin(detailRoutes, atChild('kid-2'));
    expect(await screen.findByText(/Tap to add birthday & photo/)).toBeTruthy();
  });

  test('a child WITH a birthday shows an age instead of the invitation', async () => {
    // Both halves are needed. Asserting only the prompt lets an implementation that ALWAYS prompts
    // pass, which is precisely what a mutant doing that proved.
    // Anchored on the camera name, which appears once — "Raffa" itself is in both the page header and
    // the hero, so querying for it is ambiguous.
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    expect(await screen.findByText('Raffa Room')).toBeTruthy();
    expect(screen.queryByText(/Tap to add birthday & photo/)).toBeNull();
  });
});

// --- the alerts feed ------------------------------------------------------------------------------

describe('the alerts feed on a child screen', () => {
  // ⚠️ These assert a POSITIVE count, never "the empty message is showing". The empty message is on
  // screen from the very first paint, before the fetch resolves — so `findByText(/No alerts/)` passes
  // instantly whatever the filter does, and removing the filter entirely still left it green. Counting
  // the rows that actually rendered is what discriminates.
  test('shows only alerts from this child\'s cameras', async () => {
    // Three alerts arrive: this child's, the sibling's, and an unassigned camera's. Exactly one is his.
    mockApi({ alerts: [alert('cam-a1'), alert('cam-b1'), alert('cam-hall')] });
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(screen.getAllByText('Motion').length).toBe(1));
  });

  test('a child with no alerts of his own shows the empty state once the feed has loaded', async () => {
    mockApi({ alerts: [alert('cam-b1'), alert('cam-hall')] });
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    // Wait for the request to have been made AND its state update to flush, so this is a statement
    // about the settled screen rather than about the first frame.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cameras/alerts'));
    await waitFor(() => expect(screen.queryByText('Motion')).toBeNull());
    expect(screen.getByText(/No alerts for Raffa yet/)).toBeTruthy();
  });

  test('the feed is capped at 20 however many arrive', async () => {
    mockApi({ alerts: Array.from({ length: 25 }, (_, i) => alert('cam-a1', i)) });
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(screen.getAllByText('Motion').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Motion').length).toBe(20);
  });

  test('a response that is not a list leaves the page usable', async () => {
    // The server has changed a response shape out from under a running client before, and a page that
    // throws here is a blank screen for someone who cannot reload the app.
    //
    // ⚠️ This does NOT isolate the `Array.isArray` guard. Removing it makes `.filter` throw, which the
    // surrounding try/catch swallows, leaving the feed empty either way — so the two are observably
    // identical here and a mutant dropping the guard survives. Saying so rather than implying a
    // coverage this cannot give.
    mockApi({ alerts: { unexpected: 'shape' } });
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    expect(await screen.findByText('Raffa Room')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Motion')).toBeNull());
  });

  test('a failed alerts request leaves the rest of the page intact', async () => {
    vi.spyOn(api, 'get').mockImplementation((path) =>
      String(path).includes('/cameras/alerts') ? Promise.reject(new Error('offline')) : Promise.resolve(null));
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    // The cameras card still renders — a dead feed must not take the screen down with it.
    expect(await screen.findByText('Raffa Room')).toBeTruthy();
  });
});
