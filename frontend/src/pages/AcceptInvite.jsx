import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import { holdReload } from '../lib/reloadGuard.js';
import { stashInviteToken, readInviteToken, clearInviteToken } from '../lib/inviteToken.js';
import Logo from '../components/Logo.jsx';

// The page a caregiver lands on from an invite link or QR code (#1094): `#/invite/<token>`. PUBLIC: it sits outside the signed-in shell
// (App.jsx), because the person has no account to sign in to yet, and it is styled like the sign-in page.
//
// THE TOKEN, and why this page is careful with it:
//  * It is a one-time secret that lets whoever holds it choose the password for this account. It arrives after the `#`, so no server
//    or proxy sees it. This page takes it from the route and MOVES it to sessionStorage, then replaces the address with `#/invite`,
//    so it is not left in the address bar or in history (lib/inviteToken.js, which main.jsx also calls before React starts: that one
//    covers a device whose stale sign-in would otherwise bounce it to the sign-in page before this page exists).
//  * It is only ever sent in a POST body (never a query string), to `/auth/invite/check` once and `/auth/invite/redeem` on submit.
//  * It is never logged, put in a title or an aria-label, or kept in localStorage (where the session lives).
//
// THE CHECK RUNS ONCE. The server counts failures per source address, so a page that re-asked on every render, every retry or every
// StrictMode double-run would burn the visitor's own allowance. The ref below survives StrictMode's mount/unmount/mount probe (the
// same pattern as Login's signInStarted), and there is deliberately no retry: a failed check says so and the visitor reloads.
//
// A visitor who is ALREADY signed in is never silently replaced: they are told who they are signed in as and choose. Redeeming would
// otherwise overwrite their session with a stranger's account.
//
// Background reload is held for as long as this page is open (lib/reloadGuard.js): a reload would not lose the token (it is in
// sessionStorage) but would lose what the person has typed and restart the one check.

const MIN_PASSWORD = 8;

const GENERIC_BUSY = 'Just a moment. If you just chose a password, try signing in with it.';
const GENERIC_LIMIT = 'Too many attempts. Please wait a few minutes and try again.';

export default function AcceptInvite() {
  const { token: routeToken } = useParams();
  const navigate = useNavigate();
  const { user, login, logout } = useAuth();
  const { settings } = useSettings();

  // Read from the route on the first render, else from where an earlier visit (or main.jsx) put it. Stashing here is idempotent, so
  // React's double-invoked initialiser does no harm.
  const [token] = useState(() => {
    if (routeToken) { stashInviteToken(routeToken); return routeToken; }
    return readInviteToken();
  });

  // The `?` in the route (`/invite/:token?`) keeps this ONE mounted component across the replace below, so the ref guard holds.
  useEffect(() => {
    if (routeToken) navigate('/invite', { replace: true });
  }, [routeToken, navigate]);

  useEffect(() => holdReload(), []);

  // 'checking' | 'ready' | 'invalid' | 'failed'
  const [phase, setPhase] = useState('checking');
  const [invite, setInvite] = useState(null); // { first_name, username, app_name } once the check passes
  const [failure, setFailure] = useState('');
  const checkStarted = useRef(false);

  useEffect(() => {
    // Signed in: nothing to check until they choose to sign out (then `user` goes null and this runs).
    if (user) return;
    if (checkStarted.current) return;
    checkStarted.current = true;
    if (!token) { setPhase('invalid'); return; }
    api.post('/auth/invite/check', { token }).then((found) => {
      setInvite(found);
      setPhase('ready');
    }).catch((err) => {
      // The server answers 404 for EVERY unusable link (unknown, used, expired, revoked, malformed), by design, so nothing finer can
      // be said and nothing is guessed.
      if (err.status === 404) { clearInviteToken(); setPhase('invalid'); return; }
      setFailure(err.status === 429 ? GENERIC_LIMIT : err.message);
      setPhase('failed');
    });
  }, [user, token]);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false); // show the validation messages even for a field not yet typed in
  const [pending, setPending] = useState(false);
  const [finished, setFinished] = useState(false);   // redeemed: signing in, so do not flash the "already signed in" view
  const [error, setError] = useState(null);          // { text, signIn } from a refused submit

  const tooShort = password.length < MIN_PASSWORD;
  const mismatch = password !== confirm;
  const showShort = tooShort && (password.length > 0 || submitted);
  const showMismatch = !tooShort && mismatch && (confirm.length > 0 || submitted);

  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    setSubmitted(true);
    if (tooShort || mismatch) return;
    setPending(true);
    setError(null);
    try {
      const result = await api.post('/auth/invite/redeem', { token, password });
      if (result.mfaRequired) {
        // Not reachable through the API today (a pending account cannot have two-factor on). Handled so it fails safe: the password
        // IS set, and the sign-in page asks for the code.
        clearInviteToken();
        setFinished(true);
        navigate('/login', { replace: true });
        return;
      }
      clearInviteToken(); // the token is spent; it must not outlive the redeem in this tab
      setFinished(true);
      // Must await: login() fetches the media token before setting the user, and navigating first would let Protected see a null
      // user and bounce back to /login (the same rule as Login.jsx).
      await login(result.token, result.user);
      navigate('/', { replace: true });
    } catch (err) {
      if (err.status === 404) { clearInviteToken(); setPhase('invalid'); }
      else if (err.status === 409) setError({ text: GENERIC_BUSY, signIn: true });
      else if (err.status === 429) setError({ text: GENERIC_LIMIT, signIn: false });
      else setError({ text: err.message, signIn: false });
      setFinished(false);
    } finally {
      setPending(false);
    }
  }

  const appName = invite?.app_name || settings?.app_name || 'Nightlight';
  const shell = (children) => (
    <div className="auth-screen">
      <div className="auth-card">
        <Logo size={84} glow className="auth-icon" />
        <h1>{appName}</h1>
        {children}
      </div>
    </div>
  );

  if (finished) return shell(<p className="tagline" role="status">Signing you in…</p>);

  if (user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;
    return shell(
      <>
        <p className="tagline">
          You are already signed in as {name}. Opening an invite replaces nothing: sign out first if this link is for someone else.
        </p>
        <button className="btn btn-primary" type="button" onClick={() => { clearInviteToken(); navigate('/', { replace: true }); }}>
          Go to Nightlight
        </button>
        <button className="btn btn-secondary" type="button" style={{ marginTop: 8 }} onClick={logout}>Sign out</button>
      </>
    );
  }

  if (phase === 'checking') return shell(<p className="tagline" role="status">Checking your invite…</p>);

  if (phase === 'invalid') {
    return shell(
      <>
        <p className="tagline" role="alert">
          This invite isn&rsquo;t valid any more. If you never used this link, tell the person who invited you. If you just chose a password, try signing in with it.
        </p>
        <Link className="btn btn-primary" to="/login" onClick={clearInviteToken}>Go to sign in</Link>
      </>
    );
  }

  if (phase === 'failed') {
    return shell(
      <>
        <div className="error-banner" role="alert">{failure}</div>
        <Link className="btn btn-secondary" to="/login" onClick={clearInviteToken}>Go to sign in</Link>
      </>
    );
  }

  const welcomeName = invite?.first_name?.trim();
  return shell(
    <>
      <p className="tagline">{welcomeName ? `Welcome, ${welcomeName}.` : 'Welcome.'} Choose a password to finish setting up your account.</p>
      {error && (
        <div className="error-banner" role="alert">
          {error.text}
          {error.signIn && <> <Link to="/login" onClick={clearInviteToken}>Go to sign in</Link></>}
        </div>
      )}
      <form onSubmit={submit} noValidate>
        {/* The username is shown as text, and held in a hidden field so a password manager saves the username WITH the new password
            (otherwise it saves a password with no account to attach it to). Off-screen rather than display:none or `hidden`, which
            some password managers skip. */}
        <p className="camera-tile__sub" style={{ marginTop: 0 }}>Your username is <strong>{invite?.username}</strong></p>
        <input type="text" name="username" autoComplete="username" value={invite?.username || ''} readOnly tabIndex={-1} aria-hidden="true"
          style={{ position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 }} />
        <div className="field">
          <label htmlFor="invite-password">Choose a password</label>
          <input id="invite-password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} value={password}
            onChange={(e) => setPassword(e.target.value)} aria-describedby="invite-password-help"
            aria-invalid={showShort ? 'true' : undefined} />
          {showShort
            ? <div id="invite-password-help" role="alert" className="camera-tile__sub" style={{ color: 'var(--offline)' }}>Use at least {MIN_PASSWORD} characters.</div>
            : <div id="invite-password-help" className="camera-tile__sub">At least {MIN_PASSWORD} characters.</div>}
        </div>
        <div className="field">
          <label htmlFor="invite-confirm">Confirm password</label>
          <input id="invite-confirm" type="password" autoComplete="new-password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} aria-describedby={showMismatch ? 'invite-confirm-error' : undefined}
            aria-invalid={showMismatch ? 'true' : undefined} />
          {showMismatch && <div id="invite-confirm-error" role="alert" className="camera-tile__sub" style={{ color: 'var(--offline)' }}>The two passwords do not match.</div>}
        </div>
        <button className="btn btn-primary" type="submit" disabled={pending}>{pending ? 'Please wait…' : 'Set password and sign in'}</button>
      </form>
    </>
  );
}
