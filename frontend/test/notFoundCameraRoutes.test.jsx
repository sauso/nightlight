// An address that matches the camera routes but names nothing must end on the same "Page not found" screen
// as any other bad address (#379), instead of a blank settings page or "Loading…" forever.
import { describe, test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import DetectionSettings from '../src/pages/DetectionSettings.jsx';
import CameraSettings from '../src/pages/CameraSettings.jsx';

const CAM = { id: 'cam-1', name: 'Nursery', status: { ready: true } };

const routes = (
  <Routes>
    <Route path="/cameras/:id" element={<CameraSettings />} />
    <Route path="/cameras/:id/:kind" element={<DetectionSettings />} />
  </Routes>
);

const mount = (route, opts = {}) => renderAsAdmin(routes, { cameras: [CAM], route, ...opts });

describe('camera addresses that name nothing', () => {
  test('an unknown detection kind shows Page not found with a way back to Live', () => {
    mount('/cameras/cam-1/bogus');
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(within(screen.getByRole('main')).getByRole('button', { name: 'Go to Live' })).toBeTruthy();
  });

  test('a kind that is only an inherited object property is not a screen', () => {
    mount('/cameras/cam-1/constructor');
    expect(screen.getByText('Page not found')).toBeTruthy();
  });

  test('an unknown camera id on a detection screen shows Page not found once the list has loaded', () => {
    mount('/cameras/nope/motion');
    expect(screen.getByText('Page not found')).toBeTruthy();
  });

  test('an unknown camera id on the camera page shows Page not found once the list has loaded', () => {
    mount('/cameras/nope');
    expect(screen.getByText('Page not found')).toBeTruthy();
  });

  test('while the list is still loading it says Loading, not Page not found', () => {
    mount('/cameras/cam-1/motion', { cameras: [], camerasLoaded: false });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  test('after a failed load it offers Retry, not Page not found', () => {
    mount('/cameras/cam-1', { cameras: [], camerasLoaded: false, error: 'Network down' });
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeTruthy();
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  test('a real camera and kind are unaffected', () => {
    mount('/cameras/cam-1/motion');
    expect(screen.queryByText('Page not found')).toBeNull();
    expect(screen.getByText(/Turn on to configure how motion is detected/)).toBeTruthy();
  });
});
