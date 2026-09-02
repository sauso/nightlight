import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';

// Account → Two-factor authentication. Self-service TOTP: set up (QR + manual key → confirm a code →
// one-time backup codes), and turn off (password-confirmed). Works everywhere (no secure-context
// requirement), unlike the passkeys planned for a later phase.
export default function TwoFactorSection() {
  const [status, setStatus] = useState(null); // { enabled, backup_codes_remaining } | null
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [setup, setSetup] = useState(null); // { secret, otpauth_uri, qr } while enrolling
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null); // shown once after enabling
  const [copied, setCopied] = useState(false);

  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');

  async function loadStatus() {
    try {
      setStatus(await api.get('/auth/me/mfa'));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { loadStatus(); }, []);

  async function startSetup() {
    setError(''); setBusy(true);
    try {
      setSetup(await api.post('/auth/me/mfa/setup', {}));
      setCode('');
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
        {error && !setup && !disabling && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
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
          ) : (
            <button className="btn btn-primary" onClick={startSetup} disabled={busy || !status}>
              {busy ? 'Please wait…' : 'Set up two-factor'}
            </button>
          )}
        </div>
      </div>

      {setup && (
        <Modal title="Set up two-factor" onClose={() => (busy ? null : setSetup(null))}>
          {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
          <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
            Scan this with an authenticator app (Google Authenticator, Authy, 1Password…), or type the key in by hand.
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <img src={setup.qr} alt="Two-factor setup QR code" width={200} height={200} style={{ borderRadius: 8, background: '#fff' }} />
          </div>
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
        <Modal title="Save your backup codes" onClose={() => setBackupCodes(null)}>
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
