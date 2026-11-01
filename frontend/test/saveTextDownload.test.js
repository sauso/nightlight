// lib/saveTextDownload.js: save a text file in a browser (a normal download) or in the native app (Downloads folder,
// then the share sheet), with a message fit to show when it cannot.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as bridge from '../src/lib/nativeBridge.js';
import { saveTextDownload } from '../src/lib/saveTextDownload.js';

afterEach(() => vi.restoreAllMocks());

describe('in a browser', () => {
  beforeEach(() => {
    vi.spyOn(bridge, 'isNativeApp').mockReturnValue(false);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
  });

  test('★ downloads a CSV blob under the given name, and shows no message', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { this.dataset.clicked = this.download; });
    expect(await saveTextDownload('esphome-1.csv', 'a,b\r\n', 'text/csv')).toBe('');
    expect(click).toHaveBeenCalledTimes(1);
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('text/csv');
    expect(await blob.text()).toBe('a,b\r\n');
    expect(document.querySelector('a[download]'), 'the link is removed again').toBeNull();
  });
});

describe('in the native app', () => {
  beforeEach(() => vi.spyOn(bridge, 'isNativeApp').mockReturnValue(true));

  test('★ an app build without the file plugins gets the "update the app" explanation, and nothing is attempted', async () => {
    vi.spyOn(bridge, 'hasFileExport').mockReturnValue(false);
    const save = vi.spyOn(bridge, 'saveToDownloads');
    await expect(saveTextDownload('f.csv', 'x', 'text/csv')).rejects.toThrow(/Update to the latest app version/);
    expect(save).not.toHaveBeenCalled();
  });

  test('saves to Downloads when it can', async () => {
    vi.spyOn(bridge, 'hasFileExport').mockReturnValue(true);
    const save = vi.spyOn(bridge, 'saveToDownloads').mockResolvedValue(true);
    expect(await saveTextDownload('f.csv', 'x', 'text/csv')).toBe('Saved to your Downloads folder.');
    expect(save).toHaveBeenCalledWith('f.csv', 'x', 'text/csv');
  });

  test('falls back to the share sheet, then says plainly that it could not save', async () => {
    vi.spyOn(bridge, 'hasFileExport').mockReturnValue(true);
    vi.spyOn(bridge, 'saveToDownloads').mockResolvedValue(false);
    const share = vi.spyOn(bridge, 'saveTextFile').mockResolvedValue(true);
    expect(await saveTextDownload('f.csv', 'x', 'text/csv')).toMatch(/Shared/);
    share.mockResolvedValue(false);
    await expect(saveTextDownload('f.csv', 'x', 'text/csv')).rejects.toThrow(/Couldn't save the file on this device/);
  });
});
