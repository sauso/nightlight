// UI consistency (PR-C): ModalActions is the one dialog action row (equal-width pair, or one full-width action).
// The equal widths are CSS (jsdom does not load index.css), so what is pinned here is the structure the CSS hangs on: every dialog's
// buttons sit inside one `.modal-actions`, in the order Cancel then confirm, with the variant classes and busy rules unchanged.
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ModalActions from '../src/components/ModalActions.jsx';
import RemoveCameraDialog from '../src/components/RemoveCameraDialog.jsx';

test('the row holds a secondary Cancel and a danger confirmation, in that order', () => {
  const { container } = render(<ModalActions>
    <button className="btn btn-secondary">Cancel</button>
    <button className="btn btn-danger">Remove</button>
  </ModalActions>);
  const row = container.querySelector('.modal-actions');
  expect([...row.children].map((b) => b.textContent)).toEqual(['Cancel', 'Remove']);
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('btn-secondary');
  expect(screen.getByRole('button', { name: 'Remove' })).toHaveClass('btn-danger');
});

test('a single action is the only child of the same row (the CSS makes it full width)', () => {
  const { container } = render(<ModalActions><button className="btn btn-primary">OK</button></ModalActions>);
  expect(container.querySelector('.modal-actions').children).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'OK' })).toHaveClass('btn-primary');
});

test('★ a real dialog (Remove camera) uses the row, and busy still disables BOTH buttons and shows the progress label', () => {
  render(<RemoveCameraDialog camera={{ name: 'Cam' }} error="" busy onClose={vi.fn()} onConfirm={vi.fn()} />);
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  const confirm = screen.getByRole('button', { name: 'Removing…' });
  expect(cancel.closest('.modal-actions')).toBe(confirm.closest('.modal-actions'));
  expect(cancel.closest('.modal-actions')).not.toBeNull();
  expect(cancel).toBeDisabled();
  expect(confirm).toBeDisabled();
  expect(confirm).toHaveClass('btn-danger');
});
