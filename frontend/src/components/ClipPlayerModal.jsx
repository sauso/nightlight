import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import MediaPlayerModal from './MediaPlayerModal.jsx';

// The in-app clip player: a detection event's recorded clip, with download and (optional) delete.
// Extracted from AlertList so the Recent-activity feed, each child's detail screen, AND the sleep
// wake↔alert correlation all open the exact same player. The player chrome itself lives in
// MediaPlayerModal, shared with the nightly timelapse. `ev` is a detection event row (id, camera_name,
// type, snapshot, created_at, clip_duration_s). Pass onDeleted to enable the delete action (the caller
// refreshes its own data); omit it for read-only contexts like the sleep view, where the clips belong
// to the alert feed and shouldn't be torn out from under a sleep timeline.
const TYPE_LABEL = { motion: 'Motion', sound: 'Sound' };
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

export default function ClipPlayerModal({ ev, onClose, onDeleted }) {
  const [del, setDel] = useState(''); // '' | 'confirm' | 'deleting' | 'error'

  function close() {
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

  const confirming = del === 'confirm' || del === 'deleting' || del === 'error';

  return (
    <MediaPlayerModal
      title={`${ev.camera_name} · ${TYPE_LABEL[ev.type] || ev.type}`}
      videoPath={`/cameras/alerts/${ev.id}/clip`}
      posterPath={ev.snapshot ? `/cameras/alerts/${ev.id}/snapshot` : null}
      filename={`${ev.camera_name}-${ev.id}.mp4`}
      meta={`${parseUtc(ev.created_at).toLocaleString()}${ev.clip_duration_s ? ` · ${ev.clip_duration_s}s` : ''}`}
      onClose={close}
      headerAction={
        onDeleted ? (
          <button type="button" className="icon-btn icon-btn--danger" aria-label="Delete clip"
            onClick={() => setDel('confirm')} disabled={del === 'deleting'}>
            <Trash2 size={17} />
          </button>
        ) : null
      }
      footer={
        confirming ? (
          <div className="clip-confirm">
            <span>{del === 'error' ? 'Couldn’t delete — try again.' : 'Delete this clip? The alert stays.'}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setDel('')} disabled={del === 'deleting'}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={deleteClipNow} disabled={del === 'deleting'}>
                {del === 'deleting' ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        ) : null
      }
    />
  );
}
