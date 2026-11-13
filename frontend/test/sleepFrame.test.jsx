// UI refresh PR E: the frame at the top of the sleep page. The pieces that stand alone: the "⋯" menu (MoreMenu), the header's
// band line and actions slot (AppHeader), and which nights the seven-night strip shows (stripDates). The page-level
// behaviour (what is IN the menu, the strip's requests, the band following the night) is in sleepDetail.test.jsx, which
// has the page's fixtures.
//
// WHAT THIS PROTECTS, in order of how silently it would break:
//   - the menu closing on Escape / outside press / choosing, and focus coming back to its button (a keyboard user is
//     otherwise dropped at the top of the page, or a dialog opened from an item has nowhere to return to);
//   - the panel staying MOUNTED while closed (Recompute's item is portaled into it and its dialog must outlive the menu);
//   - the band line being decorative (aria-hidden) and absent on every page that does not ask for it.
import { describe, test, expect, vi } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';
import MoreMenu from '../src/components/MoreMenu.jsx';
import AppHeader from '../src/components/AppHeader.jsx';
import { stripDates, STRIP_NIGHTS } from '../src/components/SleepNightStrip.jsx';

function Menu({ onPick = vi.fn(), disabledSecond = false }) {
  return (
    <div>
      <button type="button">before</button>
      <MoreMenu label="More" menuLabel="Things">
        <button type="button" role="menuitem" className="more-menu__item" onClick={() => onPick('first')}>First</button>
        <button type="button" role="menuitem" className="more-menu__item" disabled={disabledSecond} onClick={() => onPick('second')}>Second</button>
        <button type="button" role="menuitem" className="more-menu__item" onClick={() => onPick('third')}>Third</button>
      </MoreMenu>
      <button type="button">after</button>
    </div>
  );
}
const menuButton = () => screen.getByRole('button', { name: 'More' });

describe('MoreMenu: the button', () => {
  test('is a menu button, closed at first, with its panel out of reach', () => {
    render(<Menu />);
    const btn = menuButton();
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe(document.querySelector('[role="menu"]').id);
    // `hidden`, so neither the tab order nor the accessibility tree can reach an item of a closed menu.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'First' })).toBeNull();
  });

  test.each([['Enter', '{Enter}'], ['Space', ' ']])('%s opens it and puts focus on the first item', async (_name, key) => {
    const user = userEvent.setup();
    render(<Menu />);
    menuButton().focus();
    await user.keyboard(key);
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu', { name: 'Things' })).toBeVisible();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
  });

  test('ArrowDown on the closed button opens it too', async () => {
    const user = userEvent.setup();
    render(<Menu />);
    menuButton().focus();
    await user.keyboard('{ArrowDown}');
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
  });

  test('pressing the button again closes it', async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(menuButton());
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    await user.click(menuButton());
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('MoreMenu: moving through the items', () => {
  test('Up and Down wrap round, Home and End jump, and a disabled item is skipped', async () => {
    const user = userEvent.setup();
    render(<Menu disabledSecond />);
    await user.click(menuButton());
    const first = screen.getByRole('menuitem', { name: 'First' });
    const third = screen.getByRole('menuitem', { name: 'Third' });
    expect(document.activeElement).toBe(first);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(third); // Second is disabled
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(first); // wraps
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(third); // wraps the other way
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(third);
  });
});

describe('MoreMenu: closing', () => {
  test('★ Escape closes it and puts focus back on the button', async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(menuButton());
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
    await user.keyboard('{Escape}');
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menuButton());
  });

  test('★ choosing an item runs it, closes the menu and puts focus back on the button', async () => {
    // Focus on the button, not left on an item that is about to be hidden: a dialog the item opens remembers the focused
    // element and returns to it, and "the item that has just disappeared" is no place to return to.
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Menu onPick={onPick} />);
    await user.click(menuButton());
    await user.click(screen.getByRole('menuitem', { name: 'Third' }));
    expect(onPick).toHaveBeenCalledWith('third');
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menuButton());
  });

  test('★ a press outside closes it WITHOUT stealing focus from what was pressed', async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'after' }));
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
  });

  test('★ tabbing out of it closes it', async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(menuButton());
    // Focus is on the first item; tab through the other two and out the end, onto "after".
    await user.tab(); await user.tab(); await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });

  test('a press inside the open menu does not close it unless it is an item', async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(menuButton());
    await user.click(screen.getByRole('menu', { name: 'Things' }));
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('MoreMenu: the slot', () => {
  test('★ hands the page an element INSIDE the panel, which exists while the menu is closed', () => {
    // RecomputeNight portals its item into this; if the slot only existed while open, the item could not keep its dialog
    // across the menu closing.
    let got = null;
    render(<MoreMenu onSlot={(el) => { got = el; }} />);
    expect(got).toBeInstanceOf(HTMLElement);
    expect(got.closest('[role="menu"]')).not.toBeNull();
    expect(got.closest('[role="menu"]').hidden).toBe(true);
  });

  test('★ an item portaled into the slot is focused on open, chosen with the keyboard, and closes the menu', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    function WithSlot() {
      const [slot, setSlot] = useState(null);
      return (
        <>
          <MoreMenu label="More" onSlot={setSlot} />
          {slot && createPortal(<button type="button" role="menuitem" onClick={() => onPick('portaled')}>Portaled</button>, slot)}
        </>
      );
    }
    render(<WithSlot />);
    await user.click(menuButton());
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Portaled' }));
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('portaled');
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('AppHeader: the frame additions', () => {
  const renderHeader = (props) => render(<MemoryRouter><AppHeader title="Sleep" showDemoBanner={false} {...props} /></MemoryRouter>);

  test('★ no band line and no actions slot unless asked for: every other page is unchanged', () => {
    const { container } = renderHeader({});
    expect(container.querySelector('.app-header__band')).toBeNull();
    expect(container.querySelector('.app-header__actions')).toBeNull();
  });

  test('★ the band line is decorative: aria-hidden, and it names the band in a modifier class only', () => {
    const { container } = renderHeader({ bandLine: 'fair' });
    const line = container.querySelector('.app-header__band');
    expect(line.getAttribute('aria-hidden')).toBe('true');
    expect(line.className).toContain('app-header__band--fair');
    expect(line.textContent).toBe(''); // a colour is never text
  });

  test('actions are rendered in the title row', () => {
    const { container } = renderHeader({ actions: <button type="button">act</button> });
    expect(container.querySelector('.app-header__top-row .app-header__actions button').textContent).toBe('act');
  });
});

describe('stripDates: which nights the strip shows', () => {
  const row = (d) => ({ night_date: d });

  test('seven calendar dates ending at the newest night, oldest first', () => {
    const rows = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'].map(row);
    expect(stripDates('2026-08-30', rows)).toEqual(['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30']);
    expect(STRIP_NIGHTS).toBe(7);
  });

  test('★ a child with fewer than seven nights sees what exists, not seven', () => {
    expect(stripDates('2026-08-30', [row('2026-08-29'), row('2026-08-28')])).toEqual(['2026-08-28', '2026-08-29', '2026-08-30']);
  });

  test('the live night (no stored row yet) is still in the strip, because the page lands on it', () => {
    expect(stripDates('2026-08-31', [row('2026-08-30'), row('2026-08-29')]).at(-1)).toBe('2026-08-31');
  });

  test('a gap in the stored nights stays a (dash) item: it is a night someone may open', () => {
    const dates = stripDates('2026-08-30', [row('2026-08-30'), row('2026-08-28'), row('2026-08-24')]);
    expect(dates).toContain('2026-08-29');
    expect(dates).toHaveLength(7);
  });

  test('crosses a month and a year boundary by calendar, not by subtracting 1 from the day', () => {
    expect(stripDates('2027-01-02', [row('2026-12-20')])).toEqual(['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  test('★ nothing to show for no rows, a non-list, rows without a usable date, or no newest night', () => {
    expect(stripDates('2026-08-30', [])).toEqual([]);
    expect(stripDates('2026-08-30', null)).toEqual([]);
    expect(stripDates('2026-08-30', { nights: [] })).toEqual([]);
    expect(stripDates('2026-08-30', [{}, { night_date: 5 }, { night_date: 'soon' }, null])).toEqual([]);
    expect(stripDates(null, [row('2026-08-30')])).toEqual([]);
  });
});
