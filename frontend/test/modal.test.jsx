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
