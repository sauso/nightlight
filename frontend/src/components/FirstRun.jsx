import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { fileToAvatarDataUrl } from '../lib/imageResize.js';
import SetupStepShell from './SetupStepShell.jsx';
import AvatarEditor from './AvatarEditor.jsx';
import ChangeServerLink from './ChangeServerLink.jsx';
import Logo from './Logo.jsx';

// What a brand-new installation shows before anyone has signed in (owner, 2026-11-06): first the welcome screen with the steps
// of the setup guide, THEN the form that creates the first admin, in the same card and look as the guide's caregiver form.
// (It used to be the other way round: a bare account form first, and the welcome screen only after signing in.)
//
// The server step is unchanged: POST /auth/setup with { username, password, first_name, last_name }. It takes no photo, so a
// photo picked here is saved with PUT /auth/me right after the new admin is signed in. The photo is optional, so if that
// second request fails the new admin is signed in and continues anyway; they can add it under Account (said on the screen).
const BLANK = { first_name: '', last_name: '', username: '', password: '', photo: null };

export default function FirstRun() {
  const { login, refresh } = useAuth();
  const navigate = useNavigate();
  const [stage, setStage] = useState('welcome'); // 'welcome' | 'account'
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fullName = [form.first_name, form.last_name].map((part) => part.trim()).filter(Boolean).join(' ');
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  async function pickPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    try {
      const photo = await fileToAvatarDataUrl(file);
      setForm((current) => ({ ...current, photo }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    // The field's `minLength` stops a short password in a browser, but the check is repeated here so it never depends on the
    // browser's form validation; the server's message is the same words (routes/auth.js).
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/auth/setup', {
        username: form.username.trim(), password: form.password, first_name: form.first_name, last_name: form.last_name,
      });
      // Must await: login() fetches the media token before setting the user, and navigating first would let Protected see
      // a null user and bounce straight back to /login.
      await login(result.token, result.user);
      if (form.photo) {
        try {
          await api.put('/auth/me', { photo: form.photo }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
          await refresh();
        } catch { /* optional: the admin is already signed in, and Account has the photo control */ }
      }
      navigate('/');
    } catch (err) {
      // A failed account creation keeps what was typed (password included, as the sign-in form does) so a taken username can be fixed.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'welcome') {
    return (
      <SetupStepShell step="welcome" primary={{ label: 'Get started', onClick: () => setStage('account') }}>
        <Logo size={72} className="setup-welcome-icon" />
        <ul className="setup-checklist"><li>Add your child</li><li>Connect your camera</li><li>Test your monitor</li><li>Invite caregivers (optional)</li><li>Watch from anywhere (optional)</li></ul>
        <p>First, you'll create your account. You can save your progress and finish later.</p>
        <ChangeServerLink />
      </SetupStepShell>
    );
  }

  return (
    <SetupStepShell
      step="account"
      error={error}
      busy={busy}
      onBack={() => { setError(''); setStage('welcome'); }}
      primary={{ label: busy ? 'Please wait…' : 'Create admin account', form: 'first-run-form' }}
    >
      <form id="first-run-form" className="setup-caregivers" onSubmit={submit}>
        <div className="setup-caregivers__photo">
          <AvatarEditor name={fullName || 'You'} src={form.photo} size={64} onChange={pickPhoto} />
          {form.photo && <button type="button" className="icon-btn" onClick={() => setForm((current) => ({ ...current, photo: null }))}>Remove</button>}
        </div>
        <div className="onvif-box__row">
          <div className="field">
            <label htmlFor="fr-first">First name</label>
            <input id="fr-first" value={form.first_name} onChange={set('first_name')} autoComplete="given-name" required disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="fr-last">Last name</label>
            <input id="fr-last" value={form.last_name} onChange={set('last_name')} autoComplete="family-name" required disabled={busy} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="fr-username">Username</label>
          <input id="fr-username" value={form.username} onChange={set('username')} autoComplete="username" autoCapitalize="none" required disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="fr-password">Password</label>
          <input id="fr-password" type="password" minLength={8} value={form.password} onChange={set('password')} autoComplete="new-password" required disabled={busy} />
          <div className="camera-tile__sub">At least 8 characters.</div>
        </div>
        <p className="camera-tile__sub">A photo is optional. You can add or change it later under Account.</p>
      </form>
    </SetupStepShell>
  );
}
