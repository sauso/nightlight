import { afterEach, describe, expect, test, vi } from 'vitest';
import { copyText } from '../src/lib/copyText.js';

// Owner testing 2026-11-05: Copy did nothing over plain http (no navigator.clipboard) and worked at the https address.
const setClipboard = (value) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

afterEach(() => {
  vi.restoreAllMocks();
  delete navigator.clipboard;
  delete document.execCommand;
});

describe('copyText', () => {
  test('uses the clipboard API when it exists', async () => {
    const writeText = vi.fn().mockResolvedValue();
    setClipboard({ writeText });
    document.execCommand = vi.fn();
    expect(await copyText('hello')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(document.execCommand, 'the old way is not needed').not.toHaveBeenCalled();
  });

  test('★ over plain http (no clipboard API) it copies with execCommand, from a temporary box that is then removed', async () => {
    setClipboard(undefined);
    let copiedFrom = null;
    document.execCommand = vi.fn((command) => {
      copiedFrom = document.querySelector('textarea')?.value ?? null;
      return command === 'copy';
    });
    expect(await copyText('https://nightlight.example.ts.net/')).toBe('copied');
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(copiedFrom, 'the text was in a selectable box at the moment of the copy').toBe('https://nightlight.example.ts.net/');
    expect(document.querySelector('textarea'), 'the box is gone afterwards').toBeNull();
  });

  test('a refused clipboard API falls through to execCommand', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    document.execCommand = vi.fn(() => true);
    expect(await copyText('x')).toBe('copied');
  });

  test('★ when nothing works it says so instead of throwing, and still removes its box', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);
    expect(await copyText('x')).toBe('manual');
    expect(document.querySelector('textarea')).toBeNull();
    document.execCommand = vi.fn(() => { throw new Error('not allowed'); });
    expect(await copyText('x')).toBe('manual');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
