// Keyboard and screen-reader behaviour of the shared dialog (#376): focus goes in, Tab stays in, Escape closes
// where it may, the page behind is inert, and focus goes back to what opened it.
//
// jsdom cannot tell us what a real screen reader announces or whether a browser really skips an inert subtree
// when tabbing; these tests pin what the component DOES (where focus is, which attributes are set, what the key
// handlers prevent), which is the part that can be checked without a device.
import { describe, test, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from '../src/components/Modal.jsx';

// A page with something before and after the opener, so "the rest of the app" is more than one element.
function Page({ dismissible = true, withInput = true, nested = false }) {
  const [open, setOpen] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <div id="app">
      <nav><button>Nav item</button></nav>
      <main>
        <button onClick={() => setOpen(true)}>Open it</button>
        <button>Other page button</button>
        {open && (
          <Modal title="Remove camera" dismissible={dismissible} onClose={() => setOpen(false)}>
            {withInput && <input aria-label="Reason" />}
            <button onClick={() => (nested ? setInner(true) : setOpen(false))}>Confirm</button>
            {inner && (
              <Modal title="Are you sure" onClose={() => setInner(false)}>
                <button>Really</button>
              </Modal>
            )}
          </Modal>
        )}
      </main>
    </div>
  );
}

const openIt = async (user) => {
  await user.click(screen.getByRole('button', { name: 'Open it' }));
  return screen.getByRole('dialog');
};

describe('★ focus goes into the dialog and comes back', () => {
  test('on open, focus moves to the first control in the dialog (not the close button)', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const dialog = await openIt(user);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('Reason'));
  });

  test('a dialog with no field starts on its first action', async () => {
    const user = userEvent.setup();
    render(<Page withInput={false} />);
    await openIt(user);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
  });

  test('closing returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await openIt(user);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open it' }));
  });

  test('so does closing with Escape', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await openIt(user);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open it' }));
  });
});

describe('★ Tab and Shift+Tab cannot leave the dialog', () => {
  test('forward from the last control wraps to the first', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const dialog = await openIt(user);
    // Reason -> Confirm -> (close ✕ is in the header, before them in DOM order) so walk the whole ring twice.
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  test('backward from the first control wraps to the last', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const dialog = await openIt(user);
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  test('if focus is somehow outside, Tab brings it back in', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const dialog = await openIt(user);
    screen.getByRole('button', { name: 'Other page button' }, { hidden: true }).focus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe('★ Escape', () => {
  test('closes an ordinary dialog', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await openIt(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('does NOT close a dialog that is not dismissible', async () => {
    const user = userEvent.setup();
    render(<Page dismissible={false} />);
    await openIt(user);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('with one dialog over another, Escape closes only the top one', async () => {
    const user = userEvent.setup();
    render(<Page nested />);
    await openIt(user);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    await user.keyboard('{Escape}');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Remove camera' })).toBeTruthy();
  });
});

describe('★ the page behind an open dialog is inert', () => {
  test('everything outside the dialog is unreachable while it is open, and reachable again after', async () => {
    const user = userEvent.setup();
    const { container } = render(<Page />);
    expect(container.querySelector('[inert]')).toBeNull();
    await openIt(user);

    // Inside an inert subtree: out of the Tab order and the accessibility tree in a real browser. (Testing
    // Library's role queries do not model `inert`, so this checks the ancestor itself.)
    expect(screen.getByRole('button', { name: 'Nav item' }).closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Other page button' }).closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Open it' }).closest('[inert]')).not.toBeNull();
    // The dialog itself is not inert, nor are the elements it lives inside.
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull();

    await user.keyboard('{Escape}');
    expect(container.querySelector('[inert]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Nav item' }).closest('[inert]')).toBeNull();
  });

  test('closing does not remove an inert that something else had set', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <div data-testid="hidden-view" inert=""><button>Inside hidden view</button></div>
        <Page />
      </>
    );
    // React 18 passes `inert=""` through as an attribute; set it directly so the test does not depend on that.
    container.querySelector('[data-testid="hidden-view"]').setAttribute('inert', '');
    await openIt(user);
    await user.keyboard('{Escape}');
    expect(container.querySelector('[data-testid="hidden-view"]').hasAttribute('inert')).toBe(true);
  });
});

// A dialog that replaces another in the same step (#768): two-factor set-up is password -> QR code -> backup codes,
// and each one is opened by a click INSIDE the one that disappears. `swapOpener` also swaps the page's opener for a
// different button when the chain starts, as the Two-factor card does ("Set up" becomes "Turn off").
function Chain({ swapOpener = false }) {
  const [step, setStep] = useState(0);
  const [started, setStarted] = useState(false);
  return (
    <div id="app">
      <nav><button>Nav item</button></nav>
      <main>
        <div data-testid="card">
          {swapOpener && started
            ? <button>Turn off</button>
            : <button onClick={() => { setStep(1); if (swapOpener) setStarted(true); }}>Set up</button>}
        </div>
        <button>Other page button</button>
      </main>
      {step === 1 && (
        <Modal title="Password" onClose={() => setStep(0)}>
          <input aria-label="Password" />
          <button onClick={() => setStep(2)}>Continue</button>
        </Modal>
      )}
      {step === 2 && (
        <Modal title="Code" onClose={() => setStep(0)}>
          <input aria-label="Code" />
          <button onClick={() => setStep(3)}>Confirm</button>
        </Modal>
      )}
      {step === 3 && (
        <Modal title="Backup codes" dismissible={false} onClose={() => setStep(0)}>
          <button onClick={() => setStep(0)}>I have saved them</button>
        </Modal>
      )}
    </div>
  );
}

const walkChain = async (user) => {
  await user.click(screen.getByRole('button', { name: 'Set up' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(screen.getByRole('dialog', { name: 'Backup codes' })).toBeTruthy();
};

describe('★ a dialog that replaces another hands focus back to where the chain began (#768)', () => {
  test('closing the last of three dialogs focuses the control that opened the first', async () => {
    const user = userEvent.setup();
    render(<Chain />);
    await walkChain(user);
    await user.click(screen.getByRole('button', { name: 'I have saved them' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Not "something on the page": the exact original opener. On the unfixed code focus is on <body> here.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Set up' }));
  });

  test('an intermediate dialog closing by itself still returns to the opener', async () => {
    const user = userEvent.setup();
    render(<Chain />);
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Set up' }));
  });

  test('when the original opener was swapped for another control, focus goes to its replacement, not <body>', async () => {
    const user = userEvent.setup();
    render(<Chain swapOpener />);
    await walkChain(user);
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'I have saved them' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Turn off' }));
  });

  test('a region with nothing to press in it takes focus itself, and its tabindex is not left behind', async () => {
    // The opener is the only thing in its region, and the dialog's action removes it.
    function Lonely() {
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      return (
        <main>
          <div data-testid="empty-region">{!gone && <button onClick={() => setOpen(true)}>Lonely opener</button>}</div>
          {open && (
            <Modal title="Lonely" onClose={() => setOpen(false)}>
              <button onClick={() => setGone(true)}>Remove opener</button>
              <button onClick={() => setOpen(false)}>Done</button>
            </Modal>
          )}
        </main>
      );
    }
    const user = userEvent.setup();
    const { container } = render(<Lonely />);
    const region = container.querySelector('[data-testid="empty-region"]');
    await user.click(screen.getByRole('button', { name: 'Lonely opener' }));
    await user.click(screen.getByRole('button', { name: 'Remove opener' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(region);
    expect(region.getAttribute('tabindex')).toBe('-1');
    // It is a temporary stop, not a new tab stop for the rest of the session.
    region.blur();
    expect(region.hasAttribute('tabindex')).toBe(false);
  });

  test('with the whole chain gone from the page, closing does not throw and does not invent a focus', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<Modal title="T" onClose={() => {}}><button>Go</button></Modal>);
    opener.remove();
    expect(() => unmount()).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  test('a dialog opened from inside another that stays open still returns to its own opener, not the page behind', async () => {
    const user = userEvent.setup();
    render(<Page nested />);
    await openIt(user);
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    await user.click(confirm);
    await user.keyboard('{Escape}');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(document.activeElement).toBe(confirm);
  });

  test('focus is never handed to something the dialog still beneath keeps inert', async () => {
    // The inner dialog's opener is removed as it opens; the only fallbacks are behind the outer dialog.
    function Over() {
      const [outer, setOuter] = useState(false);
      const [inner, setInner] = useState(false);
      return (
        <main>
          <button onClick={() => setOuter(true)}>Open outer</button>
          {outer && (
            <Modal title="Outer" onClose={() => setOuter(false)}>
              {!inner && <button onClick={() => setInner(true)}>Open inner</button>}
              <button>Outer other</button>
              {inner && <Modal title="Inner" onClose={() => setInner(false)}><button>Inner action</button></Modal>}
            </Modal>
          )}
        </main>
      );
    }
    const user = userEvent.setup();
    render(<Over />);
    await user.click(screen.getByRole('button', { name: 'Open outer' }));
    await user.click(screen.getByRole('button', { name: 'Open inner' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeTruthy();
    // Whatever has focus, it is not the inert page behind the outer dialog.
    expect(document.activeElement.closest('[inert]')).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Open outer' }, { hidden: true }));
  });
});

describe('the dialog keeps its semantics', () => {
  test('still a labelled modal dialog', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const dialog = await openIt(user);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  });

  test('onClose is still called by the ✕ button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Modal title="T" onClose={onClose}><button>Go</button></Modal>);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
