import { test, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import About from '../src/pages/About.jsx';
import { api } from '../src/lib/api.js';

test('only admins see the setup status and picture check link', () => {
  vi.spyOn(api, 'get').mockResolvedValue({ version: 'test' });
  const admin = renderAsAdmin(<About />);
  expect(screen.getByRole('link', { name: 'Setup status and picture check' })).toHaveAttribute('href', '/setup');
  admin.unmount();
  renderAsCaregiver(<About />);
  expect(screen.queryByRole('link', { name: 'Setup status and picture check' })).not.toBeInTheDocument();
  vi.restoreAllMocks();
});
