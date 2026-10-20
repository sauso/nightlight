// lib/scrollLock.js (#376): the counted lock that keeps the page behind a dialog from scrolling.
//
// WHAT THIS PROVES. The class and padding bookkeeping: locked while ANY release is outstanding, unlocked by the
// last one, a release is idempotent, and the padding is the width of the scrollbar that disappears.
// WHAT IT DOES NOT PROVE. That the page really stops scrolling or keeps its scroll position: jsdom does no
// layout. That is the real-device line on the release checklist (open a dialog on a long page, scroll behind it).
import { afterEach, describe, expect, test } from 'vitest';
import { lockScroll } from '../../src/lib/scrollLock.js';

const root = document.documentElement;
const LOCKED = 'modal-scroll-locked';
const pending = [];
const lock = () => { const release = lockScroll(); pending.push(release); return release; };

afterEach(() => {
  // A test that fails half way must not leave the module-level count raised for the next one.
  while (pending.length) pending.pop()();
  delete root.clientWidth;
});

describe('lockScroll (#376)', () => {
  test('locks on the first lock and unlocks only when the LAST one is released', () => {
    expect(root.classList.contains(LOCKED)).toBe(false);
    const a = lock();
    const b = lock();
    expect(root.classList.contains(LOCKED)).toBe(true);
    a();
    expect(root.classList.contains(LOCKED), 'a still-open dialog must keep the page locked').toBe(true);
    b();
    expect(root.classList.contains(LOCKED)).toBe(false);
  });

  test('a release called twice releases once (it cannot unlock under another holder)', () => {
    const a = lock();
    lock();
    a();
    a();
    expect(root.classList.contains(LOCKED)).toBe(true);
  });

  test('pads <html> by the scrollbar that disappears, and puts it back', () => {
    window.innerWidth = 1024;
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1009 });
    const release = lock();
    expect(root.style.paddingRight).toBe('15px');
    release();
    expect(root.style.paddingRight).toBe('');
  });

  test('no padding where the scrollbar overlays the page (width 0)', () => {
    window.innerWidth = 1024;
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1024 });
    const release = lock();
    expect(root.style.paddingRight).toBe('');
    release();
  });
});
