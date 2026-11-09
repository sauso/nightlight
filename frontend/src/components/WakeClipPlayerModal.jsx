import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import MediaPlayerModal from './MediaPlayerModal.jsx';
import { ProtectButton, ProtectedBadge, ProtectionNote } from './ClipProtection.jsx';

export default function WakeClipPlayerModal({ clip, title, onClose, onProtectedChange }) {
  const { user } = useAuth() || {};
  const isAdmin = user?.role === 'admin';
  const [isProtected, setProtected] = useState(!!clip.protected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function toggleProtection() {
    if (busy || !isAdmin) return;
    setBusy(true);
    setError('');
    try {
      const next = !isProtected;
      await api.put(`/recordings/${clip.id}/protected`, { protected: next });
      setProtected(next);
      onProtectedChange?.(clip.id, next);
    } catch (err) {
      setError(err?.message || 'Couldn’t change protection. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return <MediaPlayerModal
    title={title || `Wake-up clip · ${clip.child_name || clip.camera_name}`}
    videoPath={`/recordings/${clip.id}/video`}
    posterPath={`/recordings/${clip.id}/thumb`}
    filename={`wake-${clip.id}.mp4`}
    meta={<>Recorded automatically{clip.duration_s ? ` · ${clip.duration_s}s` : ''}{!isAdmin && isProtected && <> · <ProtectedBadge /></>}</>}
    afterMeta={<ProtectionNote protected={isProtected} error={error} />}
    headerAction={isAdmin ? <span className="clip-player__actions"><ProtectButton protected={isProtected} busy={busy} onClick={toggleProtection} /></span> : null}
    onClose={onClose}
  />;
}
