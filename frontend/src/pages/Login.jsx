import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';

export default function Login() {
  const [needsSetup, setNeedsSetup] = useState(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // When a login needs a second factor, /auth/login hands back a short-lived token instead of a
  // session; we hold it here and swap the form for the code step.
  const [mfaToken, setMfaToken] = useState(null);
  const [code, setCode] = useState('');
  const { login } = useAuth();
  const { settings } = useSettings();
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/auth/status').then((s) => setNeedsSetup(s.needsSetup)).catch(() => setNeedsSetup(false));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = needsSetup
        ? { username, password, first_name: firstName, last_name: lastName }
        : { username, password };
      const result = await api.post(needsSetup ? '/auth/setup' : '/auth/login', payload);
      if (result.mfaRequired) {
        setMfaToken(result.mfaToken);
        setBusy(false);
        return;
      }
      login(result.token, result.user);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleMfaSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api.post('/auth/login/mfa', { mfaToken, code: code.trim() });
      login(result.token, result.user);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function cancelMfa() {
    setMfaToken(null);
    setCode('');
    setPassword('');
    setError('');
  }

  if (needsSetup === null) return null;

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img src="/icons/icon-192.png" alt="" className="auth-icon" />
        <h1>{settings.app_name}</h1>
        <p className="tagline">
          {mfaToken
            ? 'Enter the 6-digit code from your authenticator app.'
            : needsSetup
              ? 'Set up the first admin account to get started.'
              : 'Sign in to watch over the nursery.'}
        </p>
        {error && <div className="error-banner">{error}</div>}
        {mfaToken ? (
          <form onSubmit={handleMfaSubmit}>
            <div className="field">
              <label htmlFor="mfa-code">Verification code</label>
              <input
                id="mfa-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
                placeholder="123456"
                required
              />
              <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                Lost your authenticator? Enter one of your backup codes instead.
              </div>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button className="btn btn-secondary" type="button" onClick={cancelMfa} style={{ marginTop: 8 }}>
              Back
            </button>
          </form>
        ) : (
        <form onSubmit={handleSubmit}>
          {needsSetup && (
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="first-name">First name</label>
                <input
                  id="first-name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoComplete="given-name"
                  required
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="last-name">Last name</label>
                <input
                  id="last-name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  autoComplete="family-name"
                  required
                />
              </div>
            </div>
          )}
          <div className="field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              minLength={needsSetup ? 8 : undefined}
              required
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : needsSetup ? 'Create admin account' : 'Sign in'}
          </button>
        </form>
        )}
      </div>
    </div>
  );
}
