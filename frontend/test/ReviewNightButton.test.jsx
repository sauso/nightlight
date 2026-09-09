// The "Was this night right?" button on the sleep detail page.
//
// ⚠️ THIS TEST EXISTS BECAUSE THE BUTTON SHIPPED DEAD. It was written inline inside SleepDetail's
// `NightBody`, which is a separate function component from `SleepDetail` itself — so the `navigate` it
// called was never in scope and every click threw a ReferenceError. It rendered perfectly and did
// absolutely nothing. Nothing caught it: the build does not resolve identifiers, and no test clicked
// it. The owner found it, and it was the only route back into a night they had recorded wrongly.
//
// The lesson is narrow and worth keeping: a control with behaviour needs a test that PRESSES it. A
// test that only asserts it renders would have passed against the broken version.

import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import ReviewNightButton from '../src/components/ReviewNightButton.jsx';

afterEach(() => vi.restoreAllMocks());

// Rendered against real routes so pressing it has to actually navigate somewhere — mocking the
// navigate hook would have hidden the very bug this file is here for.
const at = (renderer, props = {}) =>
  renderer(
    <Routes>
      <Route path="/x" element={<ReviewNightButton childId="c-1" date="2026-08-29" {...props} />} />
      <Route path="/children/:id/review/:date" element={<div>REVIEW SCREEN</div>} />
    </Routes>,
    { route: '/x' }
  );

describe('the button reaches the review', () => {
  test('pressing it opens that night\'s review', async () => {
    const { user } = at(renderAsAdmin);
    await user.click(screen.getByRole('button', { name: /Was this night right/ }));
    expect(await screen.findByText('REVIEW SCREEN')).toBeInTheDocument();
  });

  test('a caregiver can press it too', async () => {
    // Not admin-gated: the person who was in the room at 5am is the one who knows what happened.
    const { user } = at(renderAsCaregiver);
    await user.click(screen.getByRole('button', { name: /Was this night right/ }));
    expect(await screen.findByText('REVIEW SCREEN')).toBeInTheDocument();
  });

  test('it says something different once the night has been corrected', async () => {
    // The label is the only signal on that page that a night carries your answer rather than ours.
    at(renderAsAdmin, { corrected: true });
    expect(screen.getByRole('button', { name: /Change what you told us/ })).toBeInTheDocument();
  });

  test('it renders nothing without a night to review', () => {
    // The sleep detail page mounts before its date resolves; a button pointing at /review/undefined
    // would 'work' and land on a broken screen.
    const { container } = renderAsAdmin(<ReviewNightButton childId="c-1" date={null} />);
    expect(container.querySelector('button')).toBeNull();
  });
});
