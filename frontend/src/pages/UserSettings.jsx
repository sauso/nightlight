import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import Modal from '../components/Modal.jsx';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
import { loadDraft, clearDraft } from '../lib/formDraft.js';
import { useDraftKey, useFormDraft } from '../lib/useFormDraft.js';
import { fileToAvatarDataUrl } from '../lib/imageResize.js';

const BLANK = { username: '', password: '', role: 'caregiver', first_name: '', last_name: '', photo: null };

// What a reload-surviving draft may store (#377). Not the password (a secret) and not the photo (an existing
// account's photo saves the moment it is chosen, and a data URL is not what a draft keeps).
const DRAFT_FIELDS = ['username', 'first_name', 'last_name', 'role'];

// The screen is reused across caregivers (one route, `:id`). Keyed by the id so each caregiver gets a FRESH copy of
// the whole component: a draft, a baseline or a "loaded" flag from one account can then never be written under
// another's key while the new account's data is still loading (#377 plan review).
export default function UserSettings() {
  const { id } = useParams();
  return <UserSettingsForm key={id || 'new'} />;
}

// Add / edit a caregiver on its own routed screen (replaces the modal), reached from the Family
// hub or User management. Admin-only (gated by the route). The username stays editable here (an
// admin action), unlike self-service on the Account screen.
function UserSettingsForm() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const { user: me, refresh: refreshMe } = useAuth();

  // Unsaved edits survive the background reload and a trip to another screen (#377, formDraft.js).
  const draftKey = useDraftKey(isNew ? 'user:new' : `user:${id}`);
  // A new caregiver's form starts from any draft; an existing one's is restored once the account has loaded.
  const [restoredDraft] = useState(() => (isNew ? loadDraft(draftKey, DRAFT_FIELDS) : null));
  const [form, setForm] = useState(() => ({ ...BLANK, ...restoredDraft }));
  // The form as last loaded: what "unsaved" is measured against. Typing never touches it.
  const [baseline, setBaseline] = useState(BLANK);
  const [restored, setRestored] = useState(!!restoredDraft);
  const [formReady, setFormReady] = useState(isNew);
  const [loaded, setLoaded] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [resettingMfa, setResettingMfa] = useState(false);
  const [mfaResetBusy, setMfaResetBusy] = useState(false);
  // The failure of each dialog's OWN request, rendered inside that dialog (#378). `error` is a banner in
  // <main>, which sits under the modal overlay, so a refused Remove / Reset used to look like the button did
  // nothing. One state each (not shared): the two dialogs can never be open together, but a stale message
  // from one must not appear in the other the next time it opens.
  const [removeError, setRemoveError] = useState('');
  const [resetError, setResetError] = useState('');
  const [photoStatus, setPhotoStatus] = useState(''); // '' | 'saving' | 'saved'
  // #441: true only when this account IS an admin AND is the only one. The backend enforces the
  // invariant either way (routes/auth.js's keepingAnAdmin) - this just explains it before a demotion
  // is even attempted, instead of the caregiver-list screen only learning about it from a 409.
  const [onlyAdmin, setOnlyAdmin] = useState(false);

  // Persist just the photo immediately for an existing caregiver (no Save press). A new caregiver
  // has no record yet, so their photo rides along when the form is first saved.
  async function persistPhoto(photo) {
    if (isNew) return;
    setPhotoStatus('saving');
    try {
      await api.put(`/auth/users/${id}`, { photo }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
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
    // Reset immediately, not just on success below: this effect re-runs when `id` changes (this is a
    // routed screen reused across caregivers), and the previous account's restriction must not still
    // be showing while the new one's data is still loading.
    setOnlyAdmin(false);
    if (isNew) return;
    api.get('/auth/users').then((users) => {
      const u = users.find((x) => x.id === id);
      if (u) {
        const loadedForm = { username: u.username, password: '', role: u.role, first_name: u.first_name || '', last_name: u.last_name || '', photo: u.photo || null };
        const draft = loadDraft(draftKey, DRAFT_FIELDS);
        setBaseline(loadedForm);
        setForm({ ...loadedForm, ...draft });
        setRestored(!!draft);
        setFormReady(true);
        setMfaEnabled(!!u.mfa_enabled);
        setOnlyAdmin(u.role === 'admin' && users.filter((x) => x.role === 'admin').length === 1);
      }
      setLoaded(true);
    }).catch((err) => { setError(err.message); setLoaded(true); });
  }, [id, isNew]); // eslint-disable-line react-hooks/exhaustive-deps

  // True while anything on screen differs from what is saved, INCLUDING a typed password (never stored).
  const unsaved = useFormDraft({ key: draftKey, allow: DRAFT_FIELDS, form, baseline, ready: formReady, secrets: [form.password] });

  // Back to what is saved. The photo is left as it is: an existing account's photo already saved on its own.
  function discardDraft() {
    setForm((f) => ({ ...baseline, photo: f.photo }));
    setRestored(false);
  }

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
      // Saved, so the draft is stale. Cleared outright rather than left to useFormDraft's effect: we navigate away
      // on the next line, and the effect would not necessarily run before this screen is gone.
      clearDraft(draftKey);
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
    setResetError('');
    try {
      await api.del(`/auth/users/${id}/mfa`);
      setMfaEnabled(false);
      setResettingMfa(false);
    } catch (err) {
      setResetError(err.message);
    } finally {
      setMfaResetBusy(false);
    }
  }

  async function confirmRemove() {
    setRemoveBusy(true);
    setError('');
    setRemoveError('');
    try {
      await api.del(`/auth/users/${id}`);
      clearDraft(draftKey);
      navigate(back.to);
    } catch (err) {
      // Dialog stays open, button re-enabled: the person can read why and retry or cancel.
      setRemoveError(err.message);
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
            {unsaved && (
              <UnsavedNotice restored={restored} onDiscard={discardDraft}
                note={isNew || form.password ? 'The password is not kept if this page reloads; enter it again.' : ''} />
            )}

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
                  {/* Disabled, not omitted: the account IS a caregiver-eligible role in general, just not
                      from here while it's the only admin - a caregiver option no one can currently pick
                      would be more confusing than one that's visibly there but greyed out. */}
                  <option value="caregiver" disabled={onlyAdmin}>Caregiver</option>
                  <option value="admin">Admin</option>
                </select>
                <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                  Caregivers can view cameras and manage children/cameras, but can't manage accounts or change app-wide settings.
                </div>
                {onlyAdmin && (
                  <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                    This is the only admin. Make another account an admin before changing this one to caregiver.
                  </div>
                )}
              </div>
            </div>

            {!isNew && mfaEnabled && (
              <div className="card">
                <div className="card-title">Two-factor</div>
                <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
                  This account has two-factor enabled. If they've lost their authenticator and backup
                  codes, reset it so they can sign in with just their password and set it up again.
                </div>
                <button className="btn btn-danger" type="button" onClick={() => { setResetError(''); setResettingMfa(true); }}>
                  Reset two-factor
                </button>
              </div>
            )}

            {/* Save sits below the two-factor tile, per the settings layout. */}
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : isNew ? 'Add caregiver' : 'Save changes'}
            </button>
            {!isNew && id !== me?.id && (
              <button className="btn btn-danger" type="button" style={{ marginTop: 10 }} onClick={() => { setRemoveError(''); setRemoving(true); }}>
                Remove caregiver
              </button>
            )}
          </form>
        )}
      </main>

      {resettingMfa && (
        <Modal title="Reset two-factor" placement="top" error={resetError} onClose={() => (mfaResetBusy ? null : setResettingMfa(false))}>
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
        <Modal title="Remove caregiver" placement="top" error={removeError} onClose={() => (removeBusy ? null : setRemoving(false))}>
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
