import { useState } from 'react';
import { api } from '../lib/api.js';
import { isNativeApp, saveBlobToDownloads } from '../lib/nativeBridge.js';
import Modal from './Modal.jsx';

// The shared in-app video player: a modal <video> with a meta line and a Download button. Used by BOTH
// the alert clip player (ClipPlayerModal) and the nightly timelapse, so a recording and a keepsake look
// and behave identically — same chrome, same controls, same download behaviour.
//
// `videoPath` / `posterPath` are API paths (not URLs); they're resolved through api.url() here so the
// short-lived media token is attached, which a bare <video>/<img> can't do via a header.
//
// `footer` replaces the Download button when a caller needs the space for something else (the clip
// player's delete confirmation); omit it for the normal download affordance.
export default function MediaPlayerModal({
  title,
  videoPath,
  posterPath,
  filename,
  meta,
  onClose,
  headerAction,
  footer,
}) {
  const [dl, setDl] = useState(''); // '' | 'saving' | 'saved' | 'error'

  // Download the open video. In the Android/iOS shell a browser-style <a download> silently does
  // nothing (WebView limitation), so fetch the bytes and hand them to the native Download plugin
  // (Downloads folder) with a share-sheet fallback. In a real browser, a plain anchor download works.
  async function download() {
    const safeName = String(filename || 'video.mp4').replace(/[^\w.-]+/g, '_');
    const url = api.url(videoPath);
    if (!isNativeApp()) {
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    setDl('saving');
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const handled = await saveBlobToDownloads(safeName, blob, 'video/mp4');
      setDl(handled ? 'saved' : 'error');
    } catch {
      setDl('error');
    }
    setTimeout(() => setDl(''), 3000);
  }

  return (
    // `wide`: on a desktop window this becomes a centred dialog instead of a 440px phone sheet, so the
    // video actually uses the screen. No effect below the breakpoint — phones keep the sheet.
    <Modal title={title} onClose={onClose} headerAction={headerAction} wide>
      <video
        className="clip-player"
        src={api.url(videoPath)}
        poster={posterPath ? api.url(posterPath) : undefined}
        controls
        autoPlay
        playsInline
      />
      {meta ? <div className="clip-player__meta">{meta}</div> : null}
      {footer ?? (
        <button type="button" className="btn btn-block" onClick={download} disabled={dl === 'saving'}>
          {dl === 'saving' ? 'Saving…'
            : dl === 'saved' ? 'Saved to Downloads ✓'
            : dl === 'error' ? 'Couldn’t save — try again'
            : 'Download'}
        </button>
      )}
    </Modal>
  );
}
