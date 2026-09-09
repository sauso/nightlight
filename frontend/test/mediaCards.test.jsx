// The shared media chrome — Modal, MediaPlayerModal, ClipPlayerModal — plus RecordingsCard and
// ClipDatePicker. All were at 0–54%.
//
// What matters here:
//   1. MediaPlayerModal IS SHARED by the alert clip player, the recordings card and the nightly
//      timelapse, on purpose, so all three look and behave identically. That makes every one of its
//      branches a THREE-PLACE bug when it is wrong.
//   2. THE DOWNLOAD PATH FORKS ON THE SHELL. In the Android/iOS WebView a browser-style `<a download>`
//      silently does NOTHING, so the native path fetches the bytes and hands them to a plugin. "Silently
//      does nothing" is exactly the failure a test has to pin, because it looks fine in a browser.
//   3. FILENAMES ARE SANITISED. A camera called "Raffa's Room / cot" would otherwise produce a path,
//      not a filename.
//   4. DELETING A CLIP DELETES THE VIDEO, NOT THE ALERT — and deleting a RECORDING is permanent,
//      because recordings have no automatic retention. The two confirmations say different things
//      for that reason, and swapping them would be a quietly serious mistake.
//   5. ClipDatePicker only enables days that HAVE clips, and its month arrows stop at the data.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAsAdmin } from './helpers/render.jsx';
import Modal from '../src/components/Modal.jsx';
import MediaPlayerModal from '../src/components/MediaPlayerModal.jsx';
import ClipPlayerModal from '../src/components/ClipPlayerModal.jsx';
import RecordingsCard from '../src/components/RecordingsCard.jsx';
import ClipDatePicker from '../src/components/ClipDatePicker.jsx';
import { api } from '../src/lib/api.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';

afterEach(() => vi.restoreAllMocks());

// --- Modal --------------------------------------------------------------------------------------

describe('Modal', () => {
  test('announces itself as a dialog labelled by its visible heading', () => {
    render(<Modal title="Remove camera" onClose={() => {}}><p>body</p></Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // aria-labelledby points at the heading already on screen rather than duplicating the text,
    // which is what stops the announced name drifting away from the visible one.
    expect(dialog).toHaveAccessibleName('Remove camera');
  });

  test('clicking the backdrop closes, clicking the card does NOT', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<Modal title="T" onClose={onClose}><p>body</p></Modal>);
    await user.click(screen.getByText('body'));
    expect(onClose).not.toHaveBeenCalled(); // the card stops propagation
    await user.click(container.querySelector('.modal-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('the ✕ button closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal title="T" onClose={onClose}><p>body</p></Modal>);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('placement and wide are classes, not inline styles', () => {
    const { container, unmount } = render(<Modal title="T" placement="top" onClose={() => {}} />);
    expect(container.querySelector('.modal-overlay')).toHaveClass('modal-overlay--top');
    expect(container.querySelector('.modal-overlay')).not.toHaveClass('modal-overlay--wide');
    unmount();
    // ⚠️ These MUST stay classes: a media query cannot reach an inline style, and inline styles beat
    // stylesheet rules — so a desktop rule expressed inline would silently lose.
    const w = render(<Modal title="T" wide onClose={() => {}} />);
    expect(w.container.querySelector('.modal-overlay')).toHaveClass('modal-overlay--wide');
  });

  test('a headerAction is rendered beside the close button', () => {
    render(<Modal title="T" onClose={() => {}} headerAction={<button>Delete</button>} />);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  describe('the on-screen keyboard', () => {
    let listeners;
    beforeEach(() => {
      listeners = {};
      window.visualViewport = {
        height: 500,
        offsetTop: 0,
        addEventListener: (e, fn) => { listeners[e] = fn; },
        removeEventListener: (e) => { delete listeners[e]; },
      };
    });
    afterEach(() => { delete window.visualViewport; });

    test('sizes the overlay to the visual viewport, and follows it when the keyboard opens', () => {
      const { container } = render(<Modal title="T" onClose={() => {}} />);
      const overlay = container.querySelector('.modal-overlay');
      expect(overlay.style.height).toBe('500px');

      window.visualViewport.height = 260;
      window.visualViewport.offsetTop = 40;
      listeners.resize();
      // ⚠️ Without this the focused field on a tall form disappears under the keyboard — the field
      // the user is typing into is the one they cannot see.
      expect(overlay.style.height).toBe('260px');
      expect(overlay.style.top).toBe('40px');
    });

    test('detaches its listeners on unmount', () => {
      const { unmount } = render(<Modal title="T" onClose={() => {}} />);
      expect(Object.keys(listeners).sort()).toEqual(['resize', 'scroll']);
      unmount();
      expect(Object.keys(listeners)).toHaveLength(0);
    });
  });
});

// --- MediaPlayerModal ---------------------------------------------------------------------------

describe('MediaPlayerModal', () => {
  const base = {
    title: 'Raffa Room · Motion',
    videoPath: '/cameras/alerts/ev-1/clip',
    posterPath: '/cameras/alerts/ev-1/snapshot',
    filename: 'Raffa Room-ev-1.mp4',
    meta: '2 Sep, 10:00 · 12s',
    onClose: () => {},
  };

  beforeEach(() => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}?token=abc`);
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
  });

  test('resolves both media paths through api.url so the media token is attached', () => {
    const { container } = render(<MediaPlayerModal {...base} />);
    const video = container.querySelector('video');
    // ⚠️ A bare <video>/<img> cannot send an Authorization header, which is why these go through
    // api.url() and pick up a short-lived token in the query string instead.
    expect(video).toHaveAttribute('src', 'http://host/cameras/alerts/ev-1/clip?token=abc');
    expect(video).toHaveAttribute('poster', 'http://host/cameras/alerts/ev-1/snapshot?token=abc');
    expect(screen.getByText('2 Sep, 10:00 · 12s')).toBeInTheDocument();
  });

  test('omits the poster attribute entirely when there is no snapshot', () => {
    const { container } = render(<MediaPlayerModal {...base} posterPath={null} />);
    expect(container.querySelector('video')).not.toHaveAttribute('poster');
  });

  test('omits the meta line when there is nothing to say', () => {
    const { container } = render(<MediaPlayerModal {...base} meta={null} />);
    expect(container.querySelector('.clip-player__meta')).toBeNull();
  });

  test('a footer REPLACES the download button rather than sitting beside it', () => {
    render(<MediaPlayerModal {...base} footer={<div>confirm delete</div>} />);
    expect(screen.getByText('confirm delete')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  test('in a browser it downloads with a plain anchor', async () => {
    const user = userEvent.setup();
    const clicks = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = () => clicks.push({ href: el.href, download: el.download });
      return el;
    });
    render(<MediaPlayerModal {...base} />);
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(clicks).toHaveLength(1);
    expect(clicks[0].href).toContain('/cameras/alerts/ev-1/clip');
  });

  test('the filename is sanitised to something a filesystem will accept', async () => {
    const user = userEvent.setup();
    const clicks = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = () => clicks.push(el.download);
      return el;
    });
    render(<MediaPlayerModal {...base} filename="Raffa's Room / cot: 2am.mp4" />);
    await user.click(screen.getByRole('button', { name: 'Download' }));
    // Slashes make it a path, colons are illegal on Windows, and apostrophes break shell quoting.
    expect(clicks[0]).toBe('Raffa_s_Room_cot_2am.mp4');
    expect(clicks[0]).not.toMatch(/[/:'\s]/);
  });

  test('falls back to a default name when the caller supplies none', async () => {
    const user = userEvent.setup();
    const clicks = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = () => clicks.push(el.download);
      return el;
    });
    render(<MediaPlayerModal {...base} filename={undefined} />);
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(clicks[0]).toBe('video.mp4');
  });

  describe('in the native shell', () => {
    beforeEach(() => {
      vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => vi.useRealTimers());

    test('fetches the bytes and hands them to the native downloader', async () => {
      const user = userEvent.setup();
      const blob = new Blob(['x'], { type: 'video/mp4' });
      global.fetch = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) });
      const save = vi.spyOn(nativeBridge, 'saveBlobToDownloads').mockResolvedValue(true);

      render(<MediaPlayerModal {...base} />);
      await user.click(screen.getByRole('button', { name: 'Download' }));
      // ⚠️ THE REASON THIS FORK EXISTS: in a WebView `<a download>` silently does nothing at all —
      // no error, no file. It looks perfect in a browser and is completely broken in the app.
      await waitFor(() => expect(save).toHaveBeenCalledWith('Raffa_Room-ev-1.mp4', blob, 'video/mp4'));
      expect(await screen.findByRole('button', { name: 'Saved to Downloads ✓' })).toBeInTheDocument();
    });

    test('reports a refusal, and an HTTP failure, as a retryable error', async () => {
      const user = userEvent.setup();
      global.fetch = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob()) });
      vi.spyOn(nativeBridge, 'saveBlobToDownloads').mockResolvedValue(false);
      const { unmount } = render(<MediaPlayerModal {...base} />);
      await user.click(screen.getByRole('button', { name: 'Download' }));
      expect(await screen.findByRole('button', { name: 'Couldn’t save — try again' })).toBeInTheDocument();
      unmount();

      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      render(<MediaPlayerModal {...base} />);
      await user.click(screen.getByRole('button', { name: 'Download' }));
      expect(await screen.findByRole('button', { name: 'Couldn’t save — try again' })).toBeInTheDocument();
    });

    test('the button returns to Download after three seconds', async () => {
      const user = userEvent.setup();
      global.fetch = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob()) });
      vi.spyOn(nativeBridge, 'saveBlobToDownloads').mockResolvedValue(true);
      render(<MediaPlayerModal {...base} />);
      await user.click(screen.getByRole('button', { name: 'Download' }));
      await screen.findByRole('button', { name: 'Saved to Downloads ✓' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    });
  });
});

// --- ClipPlayerModal ----------------------------------------------------------------------------

describe('ClipPlayerModal', () => {
  const EV = {
    id: 'ev-1',
    camera_name: 'Raffa Room',
    type: 'motion',
    snapshot: 1,
    created_at: '2026-09-02 10:00:00',
    clip_duration_s: 12,
  };

  beforeEach(() => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    vi.spyOn(api, 'del').mockResolvedValue({});
  });

  test('titles itself with the camera and a friendly event type', () => {
    render(<ClipPlayerModal ev={EV} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Raffa Room · Motion');
  });

  test('an unknown event type falls back to the raw value rather than blank', () => {
    render(<ClipPlayerModal ev={{ ...EV, type: 'doorbell' }} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Raffa Room · doorbell');
  });

  test('the delete action appears ONLY when the caller passes onDeleted', () => {
    const { unmount } = render(<ClipPlayerModal ev={EV} onClose={() => {}} />);
    // ⚠️ Read-only contexts (the sleep timeline) show clips that belong to the alert feed; a delete
    // button there tears data out from under a different screen.
    expect(screen.queryByRole('button', { name: 'Delete clip' })).not.toBeInTheDocument();
    unmount();
    render(<ClipPlayerModal ev={EV} onClose={() => {}} onDeleted={() => {}} />);
    expect(screen.getByRole('button', { name: 'Delete clip' })).toBeInTheDocument();
  });

  test('deleting confirms IN-APP, says the alert survives, and calls the clip-only route', async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    render(<ClipPlayerModal ev={EV} onClose={onClose} onDeleted={onDeleted} />);

    await user.click(screen.getByRole('button', { name: 'Delete clip' }));
    // The wording is the contract: this removes the video only. A confirmation that implied the
    // alert went too would be a lie about what the button does.
    expect(screen.getByText('Delete this clip? The alert stays.')).toBeInTheDocument();
    expect(api.del).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/cameras/alerts/ev-1/clip'));
    expect(onClose).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalled();
  });

  test('cancelling the delete returns to the player without a request', async () => {
    const user = userEvent.setup();
    render(<ClipPlayerModal ev={EV} onClose={() => {}} onDeleted={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Delete clip' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(api.del).not.toHaveBeenCalled();
  });

  test('a failed delete keeps the confirmation open with a retry', async () => {
    const user = userEvent.setup();
    api.del.mockRejectedValue(new Error('gone'));
    const onDeleted = vi.fn();
    render(<ClipPlayerModal ev={EV} onClose={() => {}} onDeleted={onDeleted} />);
    await user.click(screen.getByRole('button', { name: 'Delete clip' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Couldn’t delete — try again.')).toBeInTheDocument();
    // The caller must NOT be told to refresh — nothing was deleted.
    expect(onDeleted).not.toHaveBeenCalled();
  });

  test('a clip with no duration and no snapshot still renders', () => {
    const { container } = render(
      <ClipPlayerModal ev={{ ...EV, snapshot: null, clip_duration_s: null }} onClose={() => {}} />
    );
    expect(container.querySelector('video')).not.toHaveAttribute('poster');
    expect(screen.queryByText(/· 12s/)).not.toBeInTheDocument();
  });
});

// --- RecordingsCard -----------------------------------------------------------------------------

describe('RecordingsCard', () => {
  const ROWS = [
    { id: 'r-1', camera_name: 'Raffa Room', started_at: '2026-09-02 10:00:00', duration_s: 30 },
    { id: 'r-2', camera_name: null, started_at: '2026-09-01 20:15:00', duration_s: null },
  ];

  beforeEach(() => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    vi.spyOn(api, 'del').mockResolvedValue({});
  });

  test('renders NOTHING at all until a recording exists', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([]);
    const { container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/recordings/child/kid-1'));
    // An empty "Recordings" card on every child page for everyone who has never pressed Record is
    // clutter that has to be explained; absent is the right answer.
    expect(container.querySelector('.card')).toBeNull();
  });

  test('a failed or malformed load stays silent rather than showing a broken card', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ not: 'an array' });
    const { container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.querySelector('.card')).toBeNull();
  });

  test('lists each recording with a thumbnail and a readable time', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(ROWS);
    const { container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    expect(await screen.findByText('Recordings')).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('.rec-strip__item')).toHaveLength(2));
    expect(container.querySelector('.rec-strip__item img')).toHaveAttribute('src', 'http://host/recordings/r-1/thumb');
  });

  // --- failed recordings (issue #276) ---
  // The API now returns 'failed' rows as well as 'ready' ones. Before this, a recording that could not
  // be saved was filtered out server-side and the user saw NOTHING — no error, no entry, no way to tell
  // it apart from the app having ignored the Record press. These cases pin the two halves: it is shown,
  // and it is shown as un-playable.
  const FAILED_ROWS = [
    { id: 'r-ok', status: 'ready', camera_name: 'Raffa Room', started_at: '2026-09-02 10:00:00', duration_s: 30 },
    { id: 'r-bad', status: 'failed', camera_name: 'Renz Room', started_at: '2026-09-02 09:00:00', duration_s: 12 },
  ];

  test('a FAILED recording appears in the strip instead of vanishing', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(FAILED_ROWS);
    const { container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    await screen.findByText('Recordings');
    await waitFor(() => expect(container.querySelectorAll('.rec-strip__item')).toHaveLength(2));
    expect(container.querySelectorAll('.rec-strip__item--failed')).toHaveLength(1);
    expect(screen.getByText('Couldn’t be saved')).toBeInTheDocument();
  });

  test('it never requests media it cannot have — no thumbnail, no play affordance', async () => {
    // Not cosmetic. The server refuses to serve a non-ready row, so an <img> pointed at its thumb
    // renders a broken-image glyph, and a play badge invites a click that can only fail.
    vi.spyOn(api, 'get').mockResolvedValue(FAILED_ROWS);
    const { container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    await screen.findByText('Recordings');
    const failedTile = await waitFor(() => {
      const el = container.querySelector('.rec-strip__item--failed');
      expect(el).not.toBeNull();
      return el;
    });
    expect(failedTile.querySelector('img')).toBeNull();
    expect(failedTile.querySelector('.rec-strip__play')).toBeNull();
    // ...while the ready one still has both, so this is not passing because the strip is empty.
    const okTile = container.querySelector('.rec-strip__item:not(.rec-strip__item--failed)');
    expect(okTile.querySelector('img')).not.toBeNull();
    expect(okTile.querySelector('.rec-strip__play')).not.toBeNull();
  });

  test('opening it explains what happened rather than launching a player', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(FAILED_ROWS);
    const { user, container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    await screen.findByText('Recordings');
    await user.click(await waitFor(() => {
      const el = container.querySelector('.rec-strip__item--failed');
      expect(el).not.toBeNull();
      return el;
    }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Recording couldn’t be saved');
    // The distinguishing assertion: MediaPlayerModal renders a <video>. This must not.
    expect(dialog.querySelector('video')).toBeNull();
    expect(dialog.textContent).toContain('Renz Room');
  });

  test('a failed recording can still be removed, so failures do not pile up forever', async () => {
    // Recordings have NO automatic retention, so anything that can appear on this card has to be
    // removable from it or it stays there for the life of the install.
    vi.spyOn(api, 'get').mockResolvedValue(FAILED_ROWS);
    const { user, container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    await screen.findByText('Recordings');
    await user.click(await waitFor(() => {
      const el = container.querySelector('.rec-strip__item--failed');
      expect(el).not.toBeNull();
      return el;
    }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/recordings/r-bad'));
  });

  test('reloads when the parent bumps the refresh nonce', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(ROWS);
    const { rerenderWith } = renderAsAdmin(<RecordingsCard childId="kid-1" refreshNonce={0} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    rerenderWith({ ui: <RecordingsCard childId="kid-1" refreshNonce={1} /> });
    // The tile's Record button finishes on a different screen, so the only way this card learns a
    // new recording exists is the parent nudging it.
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  test('opening a recording plays it, and a nameless camera does not render "null"', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(ROWS);
    const { user, container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    await screen.findByText('Recordings');
    await user.click(container.querySelectorAll('.rec-strip__item')[1]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(within(dialog).queryByText(/null/)).not.toBeInTheDocument();
    expect(dialog.textContent).toContain('Recording ·');
  });

  test('deleting a recording says it is PERMANENT — recordings have no retention', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(ROWS);
    const { user, container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    await screen.findByText('Recordings');
    await user.click(container.querySelectorAll('.rec-strip__item')[0]);
    await user.click(await screen.findByRole('button', { name: 'Delete recording' }));

    // ⚠️ Deliberately DIFFERENT wording from the clip player's "the alert stays": alert clips are
    // pruned automatically, recordings are not, so deleting one here is the only way to reclaim the
    // space and there is nothing left behind.
    expect(screen.getByText('Delete this recording? This can’t be undone.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/recordings/r-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // It re-reads the list rather than trusting its own copy.
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  test('a failed delete keeps the player open with a retry', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(ROWS);
    api.del.mockRejectedValue(new Error('busy'));
    const { user, container } = renderAsAdmin(<RecordingsCard childId="kid-1" />);
    await screen.findByText('Recordings');
    await user.click(container.querySelectorAll('.rec-strip__item')[0]);
    await user.click(await screen.findByRole('button', { name: 'Delete recording' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Couldn’t delete — try again.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('an unparseable timestamp is shown raw rather than as "Invalid Date"', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([{ id: 'r-9', camera_name: 'Cam', started_at: 'not a date' }]);
    renderAsAdmin(<RecordingsCard childId="kid-1" />);
    expect(await screen.findByText('not a date')).toBeInTheDocument();
  });
});

// --- ClipDatePicker -----------------------------------------------------------------------------

describe('ClipDatePicker', () => {
  const DAYS = new Set(['2026-08-30', '2026-09-01', '2026-09-02']);
  const labelFor = (k) => `on ${k}`;

  const setup = (selected = new Set(), over = {}) => {
    const onToggle = vi.fn();
    const onClear = vi.fn();
    const r = render(
      <ClipDatePicker
        selected={selected}
        onToggle={onToggle}
        onClear={onClear}
        availableDays={DAYS}
        labelFor={labelFor}
        {...over}
      />
    );
    return { ...r, onToggle, onClear, user: userEvent.setup() };
  };

  test('the trigger says All dates, the day itself, or a count', () => {
    const a = setup();
    expect(screen.getByRole('button', { name: /All dates/ })).toBeInTheDocument();
    a.unmount();
    const b = setup(new Set(['2026-09-01']));
    expect(screen.getByRole('button', { name: /on 2026-09-01/ })).toBeInTheDocument();
    b.unmount();
    setup(new Set(['2026-09-01', '2026-09-02']));
    expect(screen.getByRole('button', { name: /2 days/ })).toBeInTheDocument();
  });

  test('falls back to the raw key when the parent has no label for it', () => {
    setup(new Set(['2026-09-01']), { labelFor: () => null });
    expect(screen.getByRole('button', { name: /2026-09-01/ })).toBeInTheDocument();
  });

  test('opens onto the month of the latest SELECTED day, not today', async () => {
    const { user } = setup(new Set(['2026-08-30']));
    await user.click(screen.getByRole('button', { name: /on 2026-08-30/ }));
    expect(screen.getByText('August 2026')).toBeInTheDocument();
  });

  test('with nothing selected it opens onto the most recent month that HAS clips', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /All dates/ }));
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });

  test('only days with clips are tappable, and the rest are disabled', async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: /All dates/ }));
    // button.clip-cal__day, not .clip-cal__day: the leading/trailing padding cells are SPANs with
    // the same class and no disabled property, so they slip through a naive !b.disabled filter.
    const enabled = [...container.querySelectorAll('button.clip-cal__day')].filter((b) => !b.disabled);
    // Two of the three available days fall in September; the third is in August.
    expect(enabled.map((b) => b.textContent)).toEqual(['1', '2']);
    expect(enabled[0]).toHaveClass('has-clips');
  });

  test('tapping an available day toggles it through the parent', async () => {
    const { user, onToggle } = setup();
    await user.click(screen.getByRole('button', { name: /All dates/ }));
    // Two days in this month have clips, so this must be getAll — getBy would fail on ambiguity,
    // and a fixture with only one available day could not tell a per-day handler from a shared one.
    const days = screen.getAllByRole('button', { name: /clips available/ });
    expect(days).toHaveLength(2);
    await user.click(days[0]);
    expect(onToggle).toHaveBeenCalledWith('2026-09-01');
  });

  test('a selected day is marked pressed, so the state is not colour-only', async () => {
    const { user, container } = setup(new Set(['2026-09-02']));
    await user.click(screen.getByRole('button', { name: /on 2026-09-02/ }));
    const day2 = [...container.querySelectorAll('.clip-cal__day')].find((b) => b.textContent === '2');
    expect(day2).toHaveAttribute('aria-pressed', 'true');
    expect(day2).toHaveClass('is-sel');
  });

  test('the month arrows stop at the first and last month that have clips', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /All dates/ }));
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled(); // September is the last
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByText('August 2026')).toBeInTheDocument();
    // ⚠️ Paging past the data is a dead end that looks like a bug: an empty calendar with no clue
    // which way is back.
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled();
  });

  test('both arrows are disabled when there are no clips at all', async () => {
    const { user } = setup(new Set(), { availableDays: new Set() });
    await user.click(screen.getByRole('button', { name: /All dates/ }));
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  test('Clear is dead until something is selected, then clears', async () => {
    const a = setup();
    await a.user.click(screen.getByRole('button', { name: /All dates/ }));
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
    a.unmount();

    const b = setup(new Set(['2026-09-01']));
    await b.user.click(screen.getByRole('button', { name: /on 2026-09-01/ }));
    await b.user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(b.onClear).toHaveBeenCalled();
  });

  test('closes on Done, on Escape, and on an outside click', async () => {
    const { user } = setup();
    const open = () => user.click(screen.getByRole('button', { name: /All dates/ }));

    await open();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await open();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await open();
    await user.click(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('the trigger itself toggles the calendar shut again', async () => {
    const { user } = setup();
    const trigger = screen.getByRole('button', { name: /All dates/ });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('the grid is padded to whole weeks so the columns line up', async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: /All dates/ }));
    expect(container.querySelectorAll('.clip-cal__day').length % 7).toBe(0);
    expect(container.querySelectorAll('.clip-cal__dow span')).toHaveLength(7);
  });
});
