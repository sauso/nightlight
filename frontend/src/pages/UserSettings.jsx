import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { useLater } from '../lib/useLater.js';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import MoreMenu from '../components/MoreMenu.jsx';
import ModalActions from '../components/ModalActions.jsx';
import { Trash2 } from 'lucide-react';
import AvatarEditor from '../components/AvatarEditor.jsx';
import Modal from '../components/Modal.jsx';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
import { loadDraft, clearDraft } from '../lib/formDraft.js';
import { useDraftKey, useFormDraft } from '../lib/useFormDraft.js';
import { fileToAvatarDataUrl } from '../lib/imageResize.js';
import { holdReload } from '../lib/reloadGuard.js';
import InvitePanel from '../components/InvitePanel.jsx';

const BLANK = { username: '', password: '', role: 'caregiver', first_name: '', last_name: '', photo: null };

// What a reload-surviving draft may store (#377). Not the password (a secret) and not the photo (an existing
// account's photo saves the moment it is chosen, and a data URL is not what a draft keeps).
const DRAFT_FIELDS = ['username', 'first_name', 'last_name', 'role'];

// How a NEW account gets its password (#1094). 'password': the admin types one (the long-standing way, and the default so nothing
// changes for anyone who does not look). 'invite': the admin hands over a one-time link or QR code and the person chooses their own.
// Deliberately NOT in DRAFT_FIELDS: a draft that reopened the page already on "invite" would hide the password box a person expected.
const MODE_PASSWORD = 'password';
const MODE_INVITE = 'invite';

// The screen is reused across caregivers (one route, `:id`). Keyed by the id so each caregiver gets a FRESH copy of
// the whole component: a draft, a baseline or a "loaded" flag from one account can then never be written under
// another's key while the new account's data is still loading (#377 plan review).
export default function UserSettings() {
  const { id } = useParams();
  return <UserSettingsForm key={id || 'new'} />;
}

// Add / edit a caregiver on its own routed screen (replaces the modal), reached from the Family
// hub or Users. Admin-only (gated by the route). The username stays editable here (an
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
  const later = useLater(); // blanks the "Photo saved" tick; cancelled when the page goes away (#855)
  // #441: true only when this account IS an admin AND is the only one. The backend enforces the
  // invariant either way (routes/auth.js's keepingAnAdmin) - this just explains it before a demotion
  // is even attempted, instead of the caregiver-list screen only learning about it from a 409.
  const [onlyAdmin, setOnlyAdmin] = useState(false);
  // #1094. New accounts only: which way the password is set (see MODE_* above).
  const [mode, setMode] = useState(MODE_PASSWORD);
  const inviteMode = isNew && mode === MODE_INVITE;
  // The invite just made or re-issued, while its panel is on screen: { userId, token, expiresAt, firstName }. The token exists ONLY
  // here: the server answers it once, it is never stored or logged, and a reload loses it (the admin makes a new one).
  const [invitePanel, setInvitePanel] = useState(null);
  // An existing account that has not chosen a password yet (password_set === false in GET /auth/users): `null` for everyone else.
  // `expires` is the live invite's expiry, or null when there is none ("no usable invite": expired, revoked or never made).
  const [pending, setPending] = useState(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const panelOpen = !!invitePanel;

  // While the panel shows, the page must not reload itself after a spell in the background (lib/reloadGuard.js, the same hold the
  // two-factor set-up panel takes): the token cannot be fetched again, and on a phone the admin leaves for a messaging app to send
  // the link and comes back. The cleanup releases it on Done, Revoke or leaving the page.
  useEffect(() => (panelOpen ? holdReload() : undefined), [panelOpen]);

  // Persist just the photo immediately for an existing caregiver (no Save press). A new caregiver
  // has no record yet, so their photo rides along when the form is first saved.
  async function persistPhoto(photo) {
    if (isNew) return;
    setPhotoStatus('saving');
    try {
      await api.put(`/auth/users/${id}`, { photo }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      if (id === me?.id) await refreshMe();
      setPhotoStatus('saved');
      later(() => setPhotoStatus(''), 2000);
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

  const back = { to: '/settings/users', label: 'Users' };

  useEffect(() => {
    // Reset immediately, not just on success below: this effect re-runs when `id` changes (this is a
    // routed screen reused across caregivers), and the previous account's restriction must not still
    // be showing while the new one's data is still loading.
    setOnlyAdmin(false);
    setPending(null);
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
        // `=== false`, not falsy: a server older than this feature sends no `password_set`, and that account is a normal one.
        setPending(u.password_set === false ? { expires: u.invite_expires_at ?? null } : null);
      }
      setLoaded(true);
    }).catch((err) => { setError(err.message); setLoaded(true); });
  }, [id, isNew]); // eslint-disable-line react-hooks/exhaustive-deps

  // True while anything on screen differs from what is saved, INCLUDING a typed password (never stored).
  // An invite-mode form has no password box, so a password typed before switching is not an unsaved edit.
  const unsaved = useFormDraft({ key: draftKey, allow: DRAFT_FIELDS, form, baseline, ready: formReady, secrets: inviteMode ? [] : [form.password] });

  // Back to what is saved. An EXISTING account's photo is left as it is: it already saved on its own the moment it
  // was chosen. A NEW account has nothing saved, so its chosen photo is part of what is being discarded.
  function discardDraft() {
    setForm((f) => ({ ...baseline, photo: isNew ? baseline.photo : f.photo }));
    setRestored(false);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (inviteMode) {
        // No `password` key at all (the server refuses both together) and the role is fixed: an invite can only make a caregiver, so
        // a leaked link can never be an admin takeover (the server enforces it; this just does not offer it).
        const created = await api.post('/auth/users', {
          username: form.username, first_name: form.first_name, last_name: form.last_name, photo: form.photo,
          role: 'caregiver', invite: true,
        });
        // The account exists now, so the draft is stale. Cleared outright: this screen stays up (the panel), so nothing else would.
        clearDraft(draftKey);
        setInvitePanel({ userId: created.id, token: created.invite.token, expiresAt: created.invite.expires_at, firstName: form.first_name.trim() });
        return;
      }
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

  // Make a fresh invite for an account that has not chosen a password. The old link stops working the moment this succeeds.
  async function reissueInvite() {
    setInviteBusy(true);
    setError('');
    try {
      const res = await api.post(`/auth/users/${id}/invite`);
      setPending({ expires: res.invite.expires_at });
      setInvitePanel({ userId: id, token: res.invite.token, expiresAt: res.invite.expires_at, firstName: form.first_name.trim() });
    } catch (err) {
      setError(err.message);
    } finally {
      setInviteBusy(false);
    }
  }

  // Revoke the open invite: the account stays, still unable to sign in, until a new invite is made or a password is set.
  async function revokeInvite(userId, { leave }) {
    setError('');
    try {
      await api.del(`/auth/users/${userId}/invite`);
      if (leave) { navigate(back.to); return; }
      setPending((p) => (p ? { ...p, expires: null } : p));
    } catch (err) {
      setError(err.message);
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
      <AppHeader title={isNew ? 'Add user' : (fullName || 'Caregiver')} back={back}
        // Offered only once the user record has loaded (formReady is set when the GET found it).
        // Remove used to sit inside the form, which does not exist while loading; in the header it was
        // reachable then, so an admin could confirm and send a DELETE for someone the page had not
        // shown yet (PR #1088 review).
        actions={!isNew && formReady && id !== me?.id ? <MoreMenu label="More options for this user" menuLabel="User">
          <button type="button" role="menuitem" className="more-menu__item dev-card__delete"
            onClick={() => { setRemoveError(''); setRemoving(true); }}>
            <Trash2 size={16} aria-hidden="true" />Remove user
          </button>
        </MoreMenu> : null} />
      <main className="app-main">
        {!loaded ? (
          <div className="empty-state">Loading…</div>
        ) : invitePanel ? (
          <>
            {error && <div className="error-banner">{error}</div>}
            <InvitePanel token={invitePanel.token} expiresAt={invitePanel.expiresAt} firstName={invitePanel.firstName}
              onDone={() => navigate(back.to)}
              onRevoke={() => revokeInvite(invitePanel.userId, { leave: true })} />
          </>
        ) : (
          <form onSubmit={save}>
            {error && <div className="error-banner">{error}</div>}
            {unsaved && (
              <UnsavedNotice restored={restored} onDiscard={discardDraft}
                note={(isNew && !inviteMode) || form.password ? 'The password is not kept if this page reloads; enter it again.' : ''} />
            )}

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <AvatarEditor name={fullName} src={form.photo} size={88} onChange={onPhoto} />
              {form.photo && (
                <button type="button" className="icon-btn" onClick={removePhoto}>Remove</button>
              )}
              {photoStatus && (
                <div className="camera-tile__sub" style={{ color: 'var(--accent-text)' }}>
                  {photoStatus === 'saving' ? 'Saving photo…' : 'Photo saved ✓'}
                </div>
              )}
            </div>

            {/* Identity fields live in their own titled tile, matching the other settings pages. */}
            <div className="card">
              <h2 className="card-heading">Details</h2>
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

              {isNew && (
                <div className="field">
                  <div className="seg-track" role="group" aria-label="How they get a password">
                    <button type="button" aria-pressed={!inviteMode} className={`seg-track__btn${!inviteMode ? ' seg-track__btn--active' : ''}`}
                      onClick={() => setMode(MODE_PASSWORD)}>Set a password</button>
                    <button type="button" aria-pressed={inviteMode} className={`seg-track__btn${inviteMode ? ' seg-track__btn--active' : ''}`}
                      // The typed password is dropped: a hidden field must not keep a secret the person can no longer see.
                      onClick={() => { setMode(MODE_INVITE); setForm((f) => ({ ...f, password: '' })); }}>Send an invite</button>
                  </div>
                  {inviteMode && (
                    <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                      You get a link and a QR code to give them. They open it and choose their own password.
                    </div>
                  )}
                </div>
              )}

              {!inviteMode && (
                <div className="field">
                  <label htmlFor="u-password">{isNew ? 'Password' : 'Reset password (optional)'}</label>
                  <input id="u-password" type="password" minLength={8} value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required={isNew} placeholder={isNew ? '' : 'Leave blank to keep current password'} />
                </div>
              )}

              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="u-role">Role</label>
                {/* An invite always makes a caregiver, so the select shows that and cannot be changed (the server refuses an
                    invite for an admin: a leaked link must never be an admin account). */}
                <select id="u-role" value={inviteMode ? 'caregiver' : form.role} disabled={inviteMode}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {/* Disabled, not omitted: the account IS a caregiver-eligible role in general, just not
                      from here while it's the only admin - a caregiver option no one can currently pick
                      would be more confusing than one that's visibly there but greyed out. */}
                  <option value="caregiver" disabled={onlyAdmin}>Caregiver</option>
                  <option value="admin">Admin</option>
                </select>
                <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                  {inviteMode
                    ? 'Invites are for caregivers.'
                    : 'Caregivers can view cameras and manage children/cameras, but can\'t manage accounts or change app-wide settings.'}
                </div>
                {onlyAdmin && (
                  <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                    This is the only admin. Make another account an admin before changing this one to caregiver.
                  </div>
                )}
              </div>
            </div>

            {!isNew && pending && (
              <div className="card">
                <h2 className="card-heading">Invite</h2>
                <div className="camera-tile__sub" style={{ marginBottom: 10 }} role="status">
                  {pending.expires
                    ? `Waiting for ${form.first_name.trim() || form.username} to choose a password`
                    : 'No usable invite'}
                </div>
                <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
                  This account cannot sign in yet. Setting a password below makes it a normal account and ends any open invite.
                </div>
                <div className="form-actions" style={{ marginTop: 0 }}>
                  <button className="btn btn-secondary" type="button" onClick={reissueInvite} disabled={inviteBusy}>Show a new invite</button>
                  {pending.expires && (
                    <button className="btn btn-secondary" type="button" onClick={() => revokeInvite(id, { leave: false })} disabled={inviteBusy}>Revoke invite</button>
                  )}
                </div>
              </div>
            )}

            {!isNew && mfaEnabled && (
              <div className="card">
                <h2 className="card-heading">Two-factor</h2>
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
            <div className="form-actions">
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {inviteMode ? (busy ? 'Creating…' : 'Create and show invite') : busy ? 'Saving…' : isNew ? 'Add user' : 'Save changes'}
              </button>
            </div>
          </form>
        )}
      </main>

      {resettingMfa && (
        <Modal title="Reset two-factor" placement="top" error={resetError} onClose={() => (mfaResetBusy ? null : setResettingMfa(false))}>
          <p style={{ marginTop: 0 }}>
            Turn off two-factor for <strong>{fullName}</strong>? They'll be able to sign in with just their
            password and will need to set two-factor up again.
          </p>
          <ModalActions>
            <button className="btn btn-secondary" type="button" onClick={() => setResettingMfa(false)} disabled={mfaResetBusy}>Cancel</button>
            <button className="btn btn-danger" type="button" onClick={confirmResetMfa} disabled={mfaResetBusy}>
              {mfaResetBusy ? 'Resetting…' : 'Reset two-factor'}
            </button>
          </ModalActions>
        </Modal>
      )}

      {removing && (
        <Modal title="Remove user" placement="top" error={removeError} onClose={() => (removeBusy ? null : setRemoving(false))}>
          <p style={{ marginTop: 0 }}>Remove <strong>{fullName}</strong>? They'll be signed out everywhere and can no longer log in.</p>
          <ModalActions>
            <button className="btn btn-secondary" type="button" onClick={() => setRemoving(false)} disabled={removeBusy}>Cancel</button>
            <button className="btn btn-danger" type="button" onClick={confirmRemove} disabled={removeBusy}>
              {removeBusy ? 'Removing…' : 'Remove'}
            </button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}
