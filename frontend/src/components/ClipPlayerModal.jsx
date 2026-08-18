import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { isNativeApp, saveBlobToDownloads } from '../lib/nativeBridge.js';
import Modal from './Modal.jsx';

// The in-app clip player: a modal <video> for a detection event's recorded clip, with download and
// (optional) delete. Extracted from AlertList so the Recent-activity feed, each child's detail screen,
// AND the sleep wake↔alert correlation all open the exact same player. `ev` is a detection event row
// (id, camera_name, type, snapshot, created_at, clip_duration_s). Pass onDeleted to enable the delete
// action (the caller refreshes its own data); omit it for read-only contexts like the sleep view, where
// the clips belong to the alert feed and shouldn't be torn out from under a sleep timeline.
const TYPE_LABEL = { motion: 'Motion', sound: 'Sound' };
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

export default function ClipPlayerModal({ ev, onClose, onDeleted }) {
  const [dl, setDl] = useState(''); // '' | 'saving' | 'saved' | 'shared' | 'error'
  const [del, setDel] = useState(''); // '' | 'confirm' | 'deleting' | 'error'

  function close() {
    setDl('');
    setDel('');
    onClose?.();
  }

  // Delete the open clip (video only — the alert + snapshot stay). In-app confirm, never a browser one.
  async function deleteClipNow() {
    setDel('deleting');
    try {
      await api.del(`/cameras/alerts/${ev.id}/clip`);
      close();
      onDeleted?.();
    } catch {
      setDel('error');
    }
  }

  // Download the open clip. In the Android/iOS shell a browser-style <a download> silently does
  // nothing (WebView limitation), so fetch the bytes and hand them to the native Download plugin
  // (Downloads folder) with a share-sheet fallback. In a real browser, a plain anchor download works.
  async function downloadClip() {
    const filename = `${ev.camera_name}-${ev.id}.mp4`.replace(/[^\w.-]+/g, '_');
    const url = api.url(`/cameras/alerts/${ev.id}/clip`);
    if (!isNativeApp()) {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
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
      const handled = await saveBlobToDownloads(filename, blob, 'video/mp4');
      setDl(handled ? 'saved' : 'error');
    } catch {
      setDl('error');
    }
    setTimeout(() => setDl(''), 3000);
  }

  return (
    <Modal
      title={`${ev.camera_name} · ${TYPE_LABEL[ev.type] || ev.type}`}
      onClose={close}
      headerAction={
        onDeleted ? (
          <button type="button" className="icon-btn icon-btn--danger" aria-label="Delete clip"
            onClick={() => setDel('confirm')} disabled={del === 'deleting'}>
            <Trash2 size={17} />
          </button>
        ) : null
      }
    >
      <video
        className="clip-player"
        src={api.url(`/cameras/alerts/${ev.id}/clip`)}
        poster={ev.snapshot ? api.url(`/cameras/alerts/${ev.id}/snapshot`) : undefined}
        controls
        autoPlay
        playsInline
      />
      <div className="clip-player__meta">
        {parseUtc(ev.created_at).toLocaleString()}
        {ev.clip_duration_s ? ` · ${ev.clip_duration_s}s` : ''}
      </div>
      {del === 'confirm' || del === 'deleting' || del === 'error' ? (
        <div className="clip-confirm">
          <span>{del === 'error' ? 'Couldn’t delete — try again.' : 'Delete this clip? The alert stays.'}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={() => setDel('')} disabled={del === 'deleting'}>Cancel</button>
            <button type="button" className="btn btn-danger" onClick={deleteClipNow} disabled={del === 'deleting'}>
              {del === 'deleting' ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-block" onClick={downloadClip} disabled={dl === 'saving'}>
          {dl === 'saving' ? 'Saving…'
            : dl === 'saved' ? 'Saved to Downloads ✓'
            : dl === 'shared' ? 'Shared ✓'
            : dl === 'error' ? 'Couldn’t save — try again'
            : 'Download clip'}
        </button>
      )}
    </Modal>
  );
}
