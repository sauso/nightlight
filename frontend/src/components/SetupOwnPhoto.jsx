import { useEffect, useRef, useState } from 'react';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { fileToAvatarDataUrl } from '../lib/imageResize.js';
import { useDemoStatus } from '../lib/demoStatus.js';
import AvatarEditor from './AvatarEditor.jsx';

// The signed-in admin's own photo, offered on the guide's Welcome step (owner, 2026-11-05). It makes the same two calls as
// Account's photo: PUT /auth/me { photo }, then refresh the signed-in user. It is NOT shared with Account on purpose: Account's
// photo path carries timer logic with its own tests (#855) that this change should not disturb, so this keeps a smaller
// status line of its own (a fixed "Saved ✓" that stays until the next change) instead of a timed one.
export default function SetupOwnPhoto() {
  const { user, refresh } = useAuth();
  const demo = useDemoStatus();
  const [status, setStatus] = useState(''); // '' | 'saving' | 'saved'
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || 'You';

  async function save(photo) {
    setError('');
    setStatus('saving');
    try {
      await api.put('/auth/me', { photo }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      await refresh();
      if (alive.current) setStatus('saved');
    } catch (err) {
      if (alive.current) { setError(err.message); setStatus(''); }
    }
  }

  async function pick(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    try {
      await save(await fileToAvatarDataUrl(file));
    } catch (err) {
      setError(err.message);
    }
  }

  if (demo !== null) return null; // a read-only demo cannot change anyone's photo
  return (
    <div className="setup-ownphoto">
      <AvatarEditor name={name} src={user?.photo} size={64} onChange={pick} />
      <div>
        <div>Add your photo <span className="camera-tile__sub">(optional)</span></div>
        {status && <div className="camera-tile__sub" style={{ color: 'var(--accent-text)' }}>{status === 'saving' ? 'Saving…' : 'Saved ✓'}</div>}
        {user?.photo && <button type="button" className="icon-btn" style={{ padding: 0 }} onClick={() => save(null)}>Remove</button>}
        {error && <div className="camera-tile__sub" role="alert" style={{ color: 'var(--offline)' }}>{error}</div>}
      </div>
    </div>
  );
}
