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
      login(result.token, result.user);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (needsSetup === null) return null;

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img src="/icons/icon-192.png" alt="" className="auth-icon" />
        <h1>{settings.app_name}</h1>
        <p className="tagline">
          {needsSetup ? 'Set up the first admin account to get started.' : 'Sign in to watch over the nursery.'}
        </p>
        {error && <div className="error-banner">{error}</div>}
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
      </div>
    </div>
  );
}
