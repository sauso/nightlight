import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';
import { holdReload } from '../lib/reloadGuard.js';
import { isNativeApp } from '../lib/nativeBridge.js';

// A touch device, where the authenticator is likely on the same phone and a QR code cannot be scanned from
// the screen it is on. Guarded because jsdom (and old browsers) have no matchMedia.
const isTouchDevice = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

// The password step in front of each set-up entry point (review of #765): its title, and what the step leads to.
const PASSWORD_STEP = {
  start: { title: 'Set up two-factor', text: 'Enter your password to start setting up two-factor.' },
  resume: { title: 'Continue set-up', text: 'Enter your password to show the same QR code and key again.' },
  restart: {
    title: 'Start over',
    text: 'Enter your password to make a new key. The entry you may already have added to your authenticator app will stop working.',
  },
};

// Account → Two-factor authentication. Self-service TOTP: set up (QR + manual key → confirm a code →
// one-time backup codes), and turn off (password-confirmed). Works everywhere (no secure-context
// requirement), unlike the passkeys planned for a later phase.
export default function TwoFactorSection() {
  const [status, setStatus] = useState(null); // { enabled, backup_codes_remaining } | null
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [setup, setSetup] = useState(null); // { secret, otpauth_uri, qr, resumed?, notContinued } while enrolling
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null); // shown once after enabling
  const [copied, setCopied] = useState(false);

  const [disabling, setDisabling] = useState(false);
  // Which set-up the password step is for: 'start' | 'resume' | 'restart' | null. Every set-up call needs the
  // account password (review of #765): otherwise a borrowed signed-in device could read the key the owner is
  // setting up, or plant one it knows for the owner to confirm. One small step serves all three entry points.
  // Shares `password` with the turn-off dialog; the two are never open together (one needs two-factor on, the
  // other off).
  const [passwordStep, setPasswordStep] = useState(null);
  const [password, setPassword] = useState('');

  async function loadStatus() {
    try {
      setStatus(await api.get('/auth/me/mfa'));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { loadStatus(); }, []);

  // While the set-up panel is open the page must not reload itself after a spell in the background (#765):
  // on a phone the person leaves for the authenticator app and comes back, and a reload would lose the
  // secret, the QR and the typed code. The cleanup releases it on confirm, cancel or leaving the page.
  const setupOpen = !!setup;
  useEffect(() => (setupOpen ? holdReload() : undefined), [setupOpen]);

  // Always opens with an EMPTY field: a password typed and then abandoned (the dialog closed) must not be waiting
  // pre-filled for whoever opens the step next, on a shared or borrowed device.
  function openPasswordStep(kind) {
    setPassword(''); setError(''); setPasswordStep(kind);
  }

  // Sends the set-up with the typed password. `restart` replaces any pending key; without it the server hands
  // back the pending one, or makes a first one (#765). A failure (a wrong password included) keeps the password
  // step open with the message in it, so the password can be retyped.
  async function confirmPasswordStep(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const body = passwordStep === 'restart' ? { restart: true, password } : { password };
      const res = await api.post('/auth/me/mfa/setup', body);
      // "Continue set-up" chosen, but nothing was pending any more (an admin reset or a password change on
      // another device discarded it), so the server made a NEW key: `resumed` is absent. Say so in the panel,
      // or the person enters the code from the entry they already have, which can never match (review of #765).
      setSetup({ ...res, notContinued: passwordStep === 'resume' && res.resumed !== true });
      setCode('');
      setPasswordStep(null); setPassword('');
      setStatus((st) => (st ? { ...st, setup_pending: true } : st));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnable(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const res = await api.post('/auth/me/mfa/enable', { code: code.trim() });
      setSetup(null);
      setBackupCodes(res.backup_codes);
      setCopied(false);
      await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDisable(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      await api.post('/auth/me/mfa/disable', { password });
      setDisabling(false); setPassword('');
      await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function copyCodes() {
    navigator.clipboard?.writeText(backupCodes.join('\n')).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
      () => {},
    );
  }

  const enabled = !!status?.enabled;
  // ⚠️ "not on" and "we could not find out" are different, and only one of them is safe to assert.
  // `enabled` is false in both cases, so without this the card said a confident **Off** — and
  // "Require a 6-digit code…" underneath it — to someone whose account may well have two-factor ON.
  // Telling a protected account it is unprotected is the one wrong answer this card can give: it
  // invites an enrolment that will fail, and it undermines trust in every other status in the app.
  // Unknown is shown as unknown. The set-up button is already `disabled={busy || !status}`, so no
  // action is offered on a state we cannot see — this only stops the CLAIM being made.
  const unknown = !status && !!error;

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">Two-factor authentication</div>
        {error && !setup && !disabling && !passwordStep && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ShieldCheck size={22} color={enabled ? 'var(--live)' : 'var(--text-secondary)'} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{unknown ? 'Unknown' : enabled ? 'On' : 'Off'}</div>
            <div className="camera-tile__sub">
              {unknown
                ? "Couldn't check whether two-factor is on for this account."
                : enabled
                ? `${status.backup_codes_remaining} backup code${status.backup_codes_remaining === 1 ? '' : 's'} left`
                : 'Require a 6-digit code from an authenticator app at login.'}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          {enabled ? (
            <button className="btn btn-danger" onClick={() => { setPassword(''); setError(''); setDisabling(true); }}>
              Turn off two-factor
            </button>
          ) : status?.setup_pending ? (
            <>
              <button className="btn btn-primary" onClick={() => openPasswordStep('resume')} disabled={busy}>
                Continue set-up
              </button>
              <button className="btn btn-secondary" onClick={() => openPasswordStep('restart')} disabled={busy} style={{ marginTop: 8 }}>
                Start over
              </button>
              <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                Start over makes a new key and replaces the one you may already have added to your authenticator
                app, so delete that entry and add the new one.
              </div>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => openPasswordStep('start')} disabled={busy || !status}>
              Set up two-factor
            </button>
          )}
        </div>
      </div>

      {setup && (
        <Modal title="Set up two-factor" onClose={() => (busy ? null : setSetup(null))}>
          {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
          {setup.notContinued && (
            <div className="form-warning" role="status">
              There was no set-up to continue, so this is a new key. Add it to your authenticator app (delete any
              entry you added before).
            </div>
          )}
          <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
            Scan this with an authenticator app (Google Authenticator, Authy, 1Password…), or type the key in by hand.
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <img src={setup.qr} alt="Two-factor setup QR code" width={200} height={200} style={{ borderRadius: 8, background: '#fff' }} />
          </div>
          {isTouchDevice() && !isNativeApp() && (
            // Not in the native app: a WebView navigating to an unknown scheme can replace the app with an
            // error page. On a phone the QR cannot be scanned from its own screen; this hands the key over.
            <div style={{ textAlign: 'center', marginBottom: 12 }}>
              <a href={setup.otpauth_uri}>Open in your authenticator app</a>
            </div>
          )}
          <div className="field">
            <label>Manual key</label>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, wordBreak: 'break-all', background: 'var(--bg-elevated-2)', padding: '8px 10px', borderRadius: 8 }}>
              {setup.secret}
            </div>
          </div>
          <form onSubmit={confirmEnable}>
            <div className="field">
              <label htmlFor="mfa-confirm">Enter the 6-digit code to confirm</label>
              <input id="mfa-confirm" value={code} onChange={(e) => setCode(e.target.value)}
                inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Verifying…' : 'Turn on'}
            </button>
          </form>
        </Modal>
      )}

      {backupCodes && (
        // dismissible={false}: these codes exist only in this component's state and the server will never
        // show them again, so a stray tap outside the card (easy on a phone) must not discard them (#557).
        // The only way out is the explicit button below; onClose is still wired for it and for the type.
        <Modal title="Save your backup codes" dismissible={false} onClose={() => setBackupCodes(null)}>
          <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
            Keep these somewhere safe. Each one works <strong>once</strong> if you lose your authenticator.
            They won't be shown again.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 14, marginBottom: 12 }}>
            {backupCodes.map((c) => (
              <div key={c} style={{ background: 'var(--bg-elevated-2)', padding: '8px 10px', borderRadius: 8, textAlign: 'center' }}>{c}</div>
            ))}
          </div>
          <button className="btn btn-secondary" onClick={copyCodes} style={{ marginBottom: 8 }}>
            {copied ? 'Copied ✓' : 'Copy codes'}
          </button>
          <button className="btn btn-primary" onClick={() => setBackupCodes(null)}>I've saved them</button>
        </Modal>
      )}

      {passwordStep && (
        // The same pattern as the turn-off dialog below: password field, the server's message inside the dialog,
        // and a wrong password keeps the dialog open so it can be retyped.
        <Modal title={PASSWORD_STEP[passwordStep].title} onClose={() => (busy ? null : setPasswordStep(null))}>
          <form onSubmit={confirmPasswordStep}>
            {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>{PASSWORD_STEP[passwordStep].text}</div>
            <div className="field">
              <label htmlFor="mfa-setup-pass">Password</label>
              <input id="mfa-setup-pass" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Please wait…' : 'Continue'}
            </button>
          </form>
        </Modal>
      )}

      {disabling && (
        <Modal title="Turn off two-factor" onClose={() => (busy ? null : setDisabling(false))}>
          <form onSubmit={confirmDisable}>
            {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>Enter your password to confirm.</div>
            <div className="field">
              <label htmlFor="mfa-disable-pass">Password</label>
              <input id="mfa-disable-pass" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </div>
            <button className="btn btn-danger" type="submit" disabled={busy}>
              {busy ? 'Turning off…' : 'Turn off two-factor'}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
