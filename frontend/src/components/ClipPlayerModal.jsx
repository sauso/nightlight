import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useHomeTime } from '../lib/useHomeTime.js';
import MediaPlayerModal from './MediaPlayerModal.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import { ProtectButton, ProtectedBadge, ProtectionNote } from './ClipProtection.jsx';

// The in-app clip player: a detection event's recorded clip, with download and (optional) delete.
// Extracted from AlertList so the Recent-activity feed, each child's detail screen, AND the sleep
// wake↔alert correlation all open the exact same player. The player chrome itself lives in
// MediaPlayerModal, shared with the nightly timelapse. `ev` is a detection event row (id, camera_name,
// type, snapshot, created_at, clip_duration_s). Pass onDeleted to enable the delete action (the caller
// refreshes its own data); omit it for contexts like the sleep view, where the clips belong
// to the alert feed and shouldn't be torn out from under a sleep timeline. The protect control is
// admin-only even where deletion is unavailable (#932).
const TYPE_LABEL = { motion: 'Motion', sound: 'Sound' };
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

// The text for a failed delete. A 403 or 409 carries the server's own reason (permission, read-only
// demo, or a clip protected by another admin) and retrying cannot change it, so show that reason.
// Any other failure may be transient, so it keeps the retry wording. Shared with
// RecordingsCard, whose deletes fail the same way.
export function deleteFailureText(err, fallback) {
  return (err?.status === 403 || err?.status === 409) && err.message ? err.message : fallback;
}

export default function ClipPlayerModal({ ev, onClose, onDeleted, onProtectedChange }) {
  const [del, setDel] = useState(''); // '' | 'confirm' | 'deleting' | 'error'
  const [delError, setDelError] = useState('');
  const [isProtected, setProtected] = useState(!!ev.protected);
  const [protectBusy, setProtectBusy] = useState(false);
  const [protectError, setProtectError] = useState('');
  const { user } = useAuth() || {};
  const isAdmin = user?.role === 'admin';
  // When the clip was captured, in HOME time (zone label when this device is elsewhere) — #561.
  const home = useHomeTime();

  function close() {
    setDel('');
    onClose?.();
  }

  // Delete the open clip (video only — the alert + snapshot stay). In-app confirm, never a browser one.
  async function deleteClipNow() {
    if (isProtected) return;
    setDel('deleting');
    try {
      await api.del(`/cameras/alerts/${ev.id}/clip`);
      close();
      onDeleted?.();
    } catch (err) {
      if (err?.status === 409) {
        // Another admin protected the clip after this player opened. Adopt the server's state so
        // the still-open confirmation cannot offer another destructive attempt (#932).
        setProtected(true);
        setProtectError(err.message);
        setDel('');
        onProtectedChange?.(ev.id, true);
        return;
      }
      setDelError(deleteFailureText(err, 'Couldn’t delete — try again.'));
      setDel('error');
    }
  }

  async function toggleProtection() {
    if (protectBusy || !isAdmin) return;
    setProtectBusy(true);
    setProtectError('');
    try {
      const next = !isProtected;
      await api.put(`/cameras/alerts/${ev.id}/protected`, { protected: next });
      setProtected(next);
      setDel('');
      onProtectedChange?.(ev.id, next);
    } catch (err) {
      setProtectError(err?.message || 'Couldn’t change protection. Try again.');
    } finally {
      setProtectBusy(false);
    }
  }

  const confirming = del === 'confirm' || del === 'deleting' || del === 'error';

  return (
    <MediaPlayerModal
      title={`${ev.camera_name} · ${TYPE_LABEL[ev.type] || ev.type}`}
      videoPath={`/cameras/alerts/${ev.id}/clip`}
      posterPath={ev.snapshot ? `/cameras/alerts/${ev.id}/snapshot` : null}
      filename={`${ev.camera_name}-${ev.id}.mp4`}
      meta={<>{home.dateTime(parseUtc(ev.created_at))}{ev.clip_duration_s ? ` · ${ev.clip_duration_s}s` : ''}{!isAdmin && isProtected && <> · <ProtectedBadge /></>}</>}
      afterMeta={<ProtectionNote protected={isProtected} error={protectError} />}
      onClose={close}
      headerAction={
        isAdmin ? <span className="clip-player__actions">
          <ProtectButton protected={isProtected} busy={protectBusy} onClick={toggleProtection} />
          {onDeleted && <button type="button" className="icon-btn icon-btn--danger" aria-label="Delete clip"
            title={isProtected ? 'Unprotect to delete' : 'Delete clip'}
            onClick={() => setDel('confirm')} disabled={isProtected || del === 'deleting'}>
            <Trash2 size={17} aria-hidden="true" />
          </button>}
        </span> : null
      }
      footer={
        confirming ? (
          <div className="clip-confirm">
            <span>{del === 'error' ? delError : 'Delete this clip? The alert stays.'}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setDel('')} disabled={del === 'deleting'}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={deleteClipNow} disabled={isProtected || del === 'deleting'}>
                {del === 'deleting' ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        ) : null
      }
    />
  );
}
