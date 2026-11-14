import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SwitchRow from '../src/components/SwitchRow.jsx';

test('SwitchRow ties each visible label to a unique switch, preserves notes and disabled state', async () => {
  const onChange = vi.fn();
  render(<>
    <SwitchRow label="Track sleep" checked={false} onChange={onChange}>
      Tracking applies to this child.
    </SwitchRow>
    <SwitchRow label="Send report" checked disabled onChange={vi.fn()} />
  </>);
  const track = screen.getByRole('switch', { name: 'Track sleep' });
  const report = screen.getByRole('switch', { name: 'Send report' });
  expect(track.id).not.toBe(report.id);
  expect(screen.getByText('Track sleep').htmlFor).toBe(track.id);
  expect(screen.getByText('Send report').htmlFor).toBe(report.id);
  expect(screen.getByText('Tracking applies to this child.').closest('.switch-row__note')).toBeTruthy();
  expect(report).toBeDisabled();
  await userEvent.click(screen.getByText('Track sleep'));
  expect(onChange).toHaveBeenCalledTimes(1);
});
