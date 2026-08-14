import { useState } from 'react';
import { Zap, AudioLines, Play, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { isNativeApp, saveBlobToDownloads } from '../lib/nativeBridge.js';
import Modal from './Modal.jsx';

// A single-card alert list (matching the design mockup): one row per alert — snapshot thumbnail,
// camera name, a motion/sound type icon + label, and the time. When an alert has a recorded video
// clip (clip_status === 'ready'), its thumbnail becomes a play button that opens the clip in a modal
// player. Shared by the Live "Recent activity" list and each child's detail screen.
const TYPE = {
  motion: { label: 'Motion', Icon: Zap },
  sound: { label: 'Sound', Icon: AudioLines },
};
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
function relTime(d) {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function AlertList({ alerts, onChanged }) {
  const [clipFor, setClipFor] = useState(null); // the alert whose clip is open in the player
  const [dl, setDl] = useState(''); // '' | 'saving' | 'saved' | 'shared' | 'error'
  const [del, setDel] = useState(''); // '' | 'confirm' | 'deleting' | 'error'

  function closePlayer() {
    setClipFor(null);
    setDl('');
    setDel('');
  }

  // Delete the open clip (video only — the alert + snapshot stay). In-app confirm, never a browser one.
  async function deleteClipNow(ev) {
    setDel('deleting');
    try {
      await api.del(`/cameras/alerts/${ev.id}/clip`);
      closePlayer();
      onChanged?.();
    } catch {
      setDel('error');
    }
  }

  // Download the open clip. In the Android/iOS shell a browser-style <a download> silently does
  // nothing (WebView limitation), so fetch the bytes and hand them to the native Download plugin
  // (Downloads folder) with a share-sheet fallback. In a real browser, a plain anchor download works.
  async function downloadClip(ev) {
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

  if (!alerts || alerts.length === 0) return null;
  return (
    <>
      <div className="card tight alert-list">
        {alerts.map((ev) => {
          const t = TYPE[ev.type] || { label: ev.type, Icon: Zap };
          const Icon = t.Icon;
          const when = parseUtc(ev.created_at);
          const hasClip = ev.clip_status === 'ready';
          const clipPending = ev.clip_status === 'pending';
          const Thumb = ev.snapshot ? (
            <img className="alert-item__thumb" src={api.url(`/cameras/alerts/${ev.id}/snapshot`)} alt="" loading="lazy" />
          ) : (
            <span className="alert-item__thumb alert-item__thumb--empty" aria-hidden="true"><Icon size={16} /></span>
          );
          return (
            <div key={ev.id} className="alert-item">
              {hasClip ? (
                <button type="button" className="alert-item__thumbwrap" onClick={() => setClipFor(ev)}
                  aria-label={`Play clip from ${ev.camera_name}`}>
                  {Thumb}
                  <span className="alert-item__play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
                </button>
              ) : (
                <span className="alert-item__thumbwrap">{Thumb}</span>
              )}
              <div className="alert-item__body">
                <div className="alert-item__name">
                  <span className="alert-item__nametext">{ev.camera_name}</span>
                  {clipPending && (
                    <span className="rec-badge" title="Recording clip…">
                      <span className="rec-dot" aria-hidden="true" />REC
                    </span>
                  )}
                </div>
                <div className="alert-item__meta">
                  <Icon size={14} className="alert-item__ico" aria-hidden="true" />
                  {t.label}{ev.detail ? ` · ${ev.detail}` : ''}
                </div>
              </div>
              <time className="alert-item__time" dateTime={when.toISOString()} title={when.toLocaleString()}>
                {relTime(when)}
              </time>
            </div>
          );
        })}
      </div>

      {clipFor && (
        <Modal
          title={`${clipFor.camera_name} · ${(TYPE[clipFor.type] || {}).label || clipFor.type}`}
          onClose={closePlayer}
          headerAction={
            <button type="button" className="icon-btn icon-btn--danger" aria-label="Delete clip"
              onClick={() => setDel('confirm')} disabled={del === 'deleting'}>
              <Trash2 size={17} />
            </button>
          }
        >
          <video
            className="clip-player"
            src={api.url(`/cameras/alerts/${clipFor.id}/clip`)}
            poster={clipFor.snapshot ? api.url(`/cameras/alerts/${clipFor.id}/snapshot`) : undefined}
            controls
            autoPlay
            playsInline
          />
          <div className="clip-player__meta">
            {parseUtc(clipFor.created_at).toLocaleString()}
            {clipFor.clip_duration_s ? ` · ${clipFor.clip_duration_s}s` : ''}
          </div>
          {del === 'confirm' || del === 'deleting' || del === 'error' ? (
            <div className="clip-confirm">
              <span>{del === 'error' ? 'Couldn’t delete — try again.' : 'Delete this clip? The alert stays.'}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setDel('')} disabled={del === 'deleting'}>Cancel</button>
                <button type="button" className="btn btn-danger" onClick={() => deleteClipNow(clipFor)} disabled={del === 'deleting'}>
                  {del === 'deleting' ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-block" onClick={() => downloadClip(clipFor)}
              disabled={dl === 'saving'}>
              {dl === 'saving' ? 'Saving…'
                : dl === 'saved' ? 'Saved to Downloads ✓'
                : dl === 'shared' ? 'Shared ✓'
                : dl === 'error' ? 'Couldn’t save — try again'
                : 'Download clip'}
            </button>
          )}
        </Modal>
      )}
    </>
  );
}
