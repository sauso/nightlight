// The shared Modal (src/components/Modal.jsx): the `error` prop added for #378.
//
// WHAT THIS PROVES. That an `error` renders as an alert INSIDE the dialog card, below the title and above
// the caller's own content; that an empty/absent one renders nothing at all (so every caller that does not
// pass it is unchanged); and that the existing dismiss rules are untouched by it.
//
// WHAT IT DOES NOT PROVE. Anything visual. jsdom paints no overlay and does no layout, so "the message is
// readable above the scrim on a phone" is not browser-checked; the per-page tests (cameras, cameraSettings,
// childSettings, users) prove each Remove/Reset dialog actually passes its failure in.
import { describe, test, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from '../src/components/Modal.jsx';

describe('Modal error (#378)', () => {
  test('★ an error is an alert INSIDE the dialog, after the title and before the content', () => {
    render(
      <Modal title="Remove camera" onClose={() => {}} error="Could not remove it #378">
        <p>The body</p>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('Could not remove it #378');
    expect(alert).toHaveClass('error-banner');
    // Order: heading, then the alert, then the caller's children. The error is the first thing under the
    // title, not appended after a long body that could be scrolled out of view.
    const heading = within(dialog).getByRole('heading', { name: 'Remove camera' });
    const body = within(dialog).getByText('The body');
    expect(heading.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('no error, or an empty one, renders no alert at all', () => {
    const { rerender } = render(<Modal title="T" onClose={() => {}}><p>x</p></Modal>);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<Modal title="T" onClose={() => {}} error=""><p>x</p></Modal>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('.error-banner')).toBeNull();
  });

  test('the error clears when the caller clears it', () => {
    const { rerender } = render(<Modal title="T" onClose={() => {}} error="boom"><p>x</p></Modal>);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<Modal title="T" onClose={() => {}} error=""><p>x</p></Modal>);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an error does not change how the dialog closes: ✕ still closes, a click inside does not', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Modal title="T" onClose={onClose} error="boom"><p>content</p></Modal>);
    await user.click(screen.getByRole('alert'));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// #376: the page behind an open dialog must not scroll. The lock itself is lib/scrollLock.js (own tests); this is
// the wiring: a Modal locks while it is mounted, and one dialog never unlocks the page under another.
//
// WHAT THIS PROVES. The class is on <html> exactly while at least one Modal is mounted, including a dialog opened
// over another and a dialog replaced by the next. WHAT IT DOES NOT PROVE. That the page really stops scrolling
// (jsdom does no layout: real-device line on the release checklist), nor that there is no gap in a chain: React
// runs the first dialog's cleanup before the next one's effect, so the class can be removed and put back inside
// ONE commit, with no frame painted between. Only the settled state before and after is observable here.
describe('Modal scroll lock (#376)', () => {
  const LOCKED = 'modal-scroll-locked';
  const locked = () => document.documentElement.classList.contains(LOCKED);

  test('★ locked while a Modal is open, unlocked when it closes', () => {
    const { rerender } = render(<Modal title="One" onClose={() => {}}><p>x</p></Modal>);
    expect(locked()).toBe(true);
    rerender(<div />);
    expect(locked()).toBe(false);
  });

  test('★ a dialog opened over another: closing the inner one keeps the page locked', () => {
    const tree = (inner) => (
      <Modal title="Outer" onClose={() => {}}>
        {inner && <Modal title="Inner" onClose={() => {}}><p>y</p></Modal>}
      </Modal>
    );
    const { rerender } = render(tree(true));
    expect(locked()).toBe(true);
    rerender(tree(false));
    expect(locked(), 'the outer dialog is still open').toBe(true);
    rerender(<div />);
    expect(locked()).toBe(false);
  });

  test('a chain (one dialog replaced by the next) ends locked, then unlocked when the last one closes', async () => {
    function Chain() {
      const [step, setStep] = useState('a');
      if (step === 'done') return null;
      return (
        <Modal key={step} title={`Step ${step}`} onClose={() => {}}>
          <button onClick={() => setStep(step === 'a' ? 'b' : 'done')}>Next</button>
        </Modal>
      );
    }
    const user = userEvent.setup();
    render(<Chain />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Step b' })).toBeTruthy();
    expect(locked()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(locked()).toBe(false);
  });
});
