// NavRow: the 56px "go deeper" row used by the Detection group on Edit camera (#1076). It replaced DetectionRow, a
// <div role="button"> whose keyboard support was a hand-written handler. What is worth pinning is what a person who
// does not look at the screen gets: a real button (or link), a name that STARTS with the visible label, and a row that
// Enter and Space both activate.
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import NavRow from '../src/components/NavRow.jsx';

const Icon = (props) => <svg {...props} data-testid="icon" />;
const ui = (props) => <MemoryRouter><NavRow Icon={Icon} label="Motion detection" {...props} /></MemoryRouter>;

describe('NavRow', () => {
  test('is a real button whose accessible name starts with the visible label and ends with the current value', () => {
    render(ui({ value: 'On', onClick: vi.fn() }));
    const row = screen.getByRole('button', { name: /^Motion detection/ });
    expect(row.tagName).toBe('BUTTON');
    // type="button": a row inside a <form> must never submit it (Edit camera's rows sit inside the camera form).
    expect(row).toHaveAttribute('type', 'button');
    expect(row).toHaveAccessibleName('Motion detection On');
  });

  test('Enter and Space both activate it, and an unrelated key does not', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(ui({ onClick }));
    await user.tab();
    expect(screen.getByRole('button', { name: /Motion detection/ })).toHaveFocus();
    await user.keyboard('{Escape}a{ArrowDown}');
    expect(onClick).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  test('shows the value and a chevron, both outside the accessible name apart from the value text', () => {
    const { container } = render(ui({ value: '20:00–07:00', onClick: vi.fn() }));
    expect(screen.getByText('20:00–07:00')).toBeInTheDocument();
    // The icon chip and the chevron are decoration: aria-hidden, so the name is the words only.
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    svgs.forEach((svg) => expect(svg).toHaveAttribute('aria-hidden', 'true'));
  });

  test('the sub line and the value are optional and absent when not given', () => {
    const { container, rerender } = render(ui({ onClick: vi.fn() }));
    expect(container.querySelector('.nav-row__sub')).toBeNull();
    expect(container.querySelector('.nav-row__value')).toBeNull();
    rerender(ui({ sub: 'Alerts when something moves', value: 'Off', onClick: vi.fn() }));
    expect(screen.getByText('Alerts when something moves')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAccessibleName('Motion detection Alerts when something moves Off');
  });

  test('given `to`, it is a link to that route and not a button', () => {
    render(ui({ to: '/cameras/cam-1/motion', value: 'On' }));
    expect(screen.queryByRole('button')).toBeNull();
    const link = screen.getByRole('link', { name: /^Motion detection/ });
    expect(link).toHaveAttribute('href', '/cameras/cam-1/motion');
  });
});
