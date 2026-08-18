import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import Modal from '../components/Modal.jsx';
import { fileToAvatarDataUrl } from '../lib/imageResize.js';

const BLANK = { username: '', password: '', role: 'caregiver', first_name: '', last_name: '', photo: null };

// Add / edit a caregiver on its own routed screen (replaces the modal), reached from the Family
// hub or User management. Admin-only (gated by the route). The username stays editable here (an
// admin action), unlike self-service on the Account screen.
export default function UserSettings() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const { user: me, refresh: refreshMe } = useAuth();

  const [form, setForm] = useState(BLANK);
  const [loaded, setLoaded] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [resettingMfa, setResettingMfa] = useState(false);
  const [mfaResetBusy, setMfaResetBusy] = useState(false);
  const [photoStatus, setPhotoStatus] = useState(''); // '' | 'saving' | 'saved'

  // Persist just the photo immediately for an existing caregiver (no Save press). A new caregiver
  // has no record yet, so their photo rides along when the form is first saved.
  async function persistPhoto(photo) {
    if (isNew) return;
    setPhotoStatus('saving');
    try {
      await api.put(`/auth/users/${id}`, { photo });
      if (id === me?.id) await refreshMe();
      setPhotoStatus('saved');
      setTimeout(() => setPhotoStatus(''), 2000);
    } catch (err) {
      setError(err.message);
      setPhotoStatus('');
    }
  }
  async function onPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      setForm((f) => ({ ...f, photo: dataUrl }));
      await persistPhoto(dataUrl);
    } catch (err) {
      setError(err.message);
    }
  }
  function removePhoto() {
    setForm((f) => ({ ...f, photo: null }));
    persistPhoto(null);
  }

  const back = { to: '/settings/users', label: 'Caregivers' };

  useEffect(() => {
    if (isNew) return;
    api.get('/auth/users').then((users) => {
      const u = users.find((x) => x.id === id);
      if (u) {
        setForm({ username: u.username, password: '', role: u.role, first_name: u.first_name || '', last_name: u.last_name || '', photo: u.photo || null });
        setMfaEnabled(!!u.mfa_enabled);
      }
      setLoaded(true);
    }).catch((err) => { setError(err.message); setLoaded(true); });
  }, [id, isNew]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (isNew) {
        await api.post('/auth/users', form);
      } else {
        const payload = { username: form.username, role: form.role, first_name: form.first_name, last_name: form.last_name };
        if (form.password) payload.password = form.password;
        await api.put(`/auth/users/${id}`, payload);
        if (id === me?.id) await refreshMe();
      }
      navigate(back.to);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmResetMfa() {
    setMfaResetBusy(true);
    setError('');
    try {
      await api.del(`/auth/users/${id}/mfa`);
      setMfaEnabled(false);
      setResettingMfa(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setMfaResetBusy(false);
    }
  }

  async function confirmRemove() {
    setRemoveBusy(true);
    setError('');
    try {
      await api.del(`/auth/users/${id}`);
      navigate(back.to);
    } catch (err) {
      setError(err.message);
      setRemoveBusy(false);
    }
  }

  const fullName = [form.first_name, form.last_name].filter(Boolean).join(' ') || form.username || 'Caregiver';

  return (
    <>
      <AppHeader title={isNew ? 'Add caregiver' : (fullName || 'Caregiver')} back={back} />
      <main className="app-main">
        {!loaded ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <form onSubmit={save}>
            {error && <div className="error-banner">{error}</div>}

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <Avatar name={fullName} src={form.photo} size={84} />
              <div style={{ display: 'flex', gap: 8 }}>
                <label className="btn btn-peri" style={{ width: 'auto', cursor: 'pointer' }}>
                  {form.photo ? 'Change photo' : 'Add photo'}
                  <input type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} />
                </label>
                {form.photo && (
                  <button type="button" className="btn btn-danger" style={{ width: 'auto' }} onClick={removePhoto}>Remove</button>
                )}
              </div>
              {photoStatus && (
                <div className="camera-tile__sub" style={{ color: 'var(--peri)' }}>
                  {photoStatus === 'saving' ? 'Saving photo…' : 'Photo saved ✓'}
                </div>
              )}
            </div>

            {/* Identity fields live in their own titled tile, matching the other settings pages. */}
            <div className="card">
              <div className="card-title">Caregiver details</div>
              <div className="onvif-box__row">
                <div className="field">
                  <label htmlFor="u-first">First name</label>
                  <input id="u-first" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="u-last">Last name</label>
                  <input id="u-last" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
                </div>
              </div>

              <div className="field">
                <label htmlFor="u-username">Username (login)</label>
                <input id="u-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
                  required autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              </div>

              <div className="field">
                <label htmlFor="u-password">{isNew ? 'Password' : 'Reset password (optional)'}</label>
                <input id="u-password" type="password" minLength={8} value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  required={isNew} placeholder={isNew ? '' : 'Leave blank to keep current password'} />
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="u-role">Role</label>
                <select id="u-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="caregiver">Caregiver</option>
                  <option value="admin">Admin</option>
                </select>
                <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                  Caregivers can view cameras and manage children/cameras, but can't manage accounts or change app-wide settings.
                </div>
              </div>
            </div>

            {!isNew && mfaEnabled && (
              <div className="card">
                <div className="card-title">Two-factor</div>
                <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
                  This account has two-factor enabled. If they've lost their authenticator and backup
                  codes, reset it so they can sign in with just their password and set it up again.
                </div>
                <button className="btn btn-danger" type="button" onClick={() => setResettingMfa(true)}>
                  Reset two-factor
                </button>
              </div>
            )}

            {/* Save sits below the two-factor tile, per the settings layout. */}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : isNew ? 'Add caregiver' : 'Save changes'}
            </button>
            {!isNew && id !== me?.id && (
              <button className="btn btn-danger" type="button" style={{ marginTop: 10 }} onClick={() => setRemoving(true)}>
                Remove caregiver
              </button>
            )}
          </form>
        )}
      </main>

      {resettingMfa && (
        <Modal title="Reset two-factor" placement="top" onClose={() => (mfaResetBusy ? null : setResettingMfa(false))}>
          <p style={{ marginTop: 0 }}>
            Turn off two-factor for <strong>{fullName}</strong>? They'll be able to sign in with just their
            password and will need to set two-factor up again.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setResettingMfa(false)} disabled={mfaResetBusy}>Cancel</button>
            <button className="btn btn-danger" type="button" onClick={confirmResetMfa} disabled={mfaResetBusy}>
              {mfaResetBusy ? 'Resetting…' : 'Reset two-factor'}
            </button>
          </div>
        </Modal>
      )}

      {removing && (
        <Modal title="Remove caregiver" placement="top" onClose={() => (removeBusy ? null : setRemoving(false))}>
          <p style={{ marginTop: 0 }}>Remove <strong>{fullName}</strong>? They'll be signed out everywhere and can no longer log in.</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setRemoving(false)} disabled={removeBusy}>Cancel</button>
            <button className="btn btn-danger" type="button" onClick={confirmRemove} disabled={removeBusy}>
              {removeBusy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
