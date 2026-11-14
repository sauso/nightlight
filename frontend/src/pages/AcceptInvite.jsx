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

// A DIFFERENT invite opened in the same tab (review of #1096). The route is `/invite/:token?`, so the router keeps ONE mounted
// AcceptInvite across `#/invite/A` -> `#/invite` -> `#/invite/B`, and the page below holds its token, its one-time check and its form
// in state that was set up for A. Left alone, B's token would be scrubbed from the address without ever being kept, and a submit
// would redeem A while the visitor believes they opened B. So when a NEW, non-empty route token differs from the last one seen, the
// page below is REMOUNTED (the `key`): fresh state, a fresh one-time check for B, B stashed over A. The ordinary transition where
// the page itself replaces `#/invite/<token>` with `#/invite` makes the route token EMPTY, which is not a new token, so it never
// remounts and the check is not repeated.
export default function AcceptInvite() {
  const { token: routeToken } = useParams();
  const [seen, setSeen] = useState(routeToken || null);
  const [generation, setGeneration] = useState(0);
  // Adjusting state while rendering (React's documented pattern for "reset on a changed prop"): unlike a ref write in render, it is
  // safe under StrictMode's double render.
  if (routeToken && routeToken !== seen) {
    setSeen(routeToken);
    setGeneration((g) => g + 1);
  }
  return <InvitePage key={generation} routeToken={routeToken} />;
}

function InvitePage({ routeToken }) {
  const navigate = useNavigate();
  const { user, login, logout } = useAuth();
  const { settings } = useSettings();

  // Read from the route on the first render, else from where an earlier visit (or main.jsx) put it. Stashing here is idempotent, so
  // React's double-invoked initialiser does no harm, and it overwrites (so removes) any token an earlier invite left behind.
  // Set to null once the invite is redeemed, so a spent token cannot be sent again.
  const [token, setToken] = useState(() => {
    if (routeToken) { stashInviteToken(routeToken); return routeToken; }
    return readInviteToken();
  });

  // False once this page is gone. A request started for an invite that has since been replaced by another must not touch the page
  // state or (worse) clear the NEW invite's stored token when it fails. The effect re-arms it so StrictMode's probe (mount, unmount,
  // mount) leaves it true.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

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
      if (!alive.current) return;
      setInvite(found);
      setPhase('ready');
    }).catch((err) => {
      if (!alive.current) return; // another invite replaced this page: its stored token is not ours to clear
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
  const [claimed, setClaimed] = useState(false);     // the password IS set, but signing in with it failed (see submit)

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
    // TWO steps with two different failure meanings, so two try blocks (review of #1096). A failed REDEEM means nothing happened and
    // the form can be tried again; a failed LOGIN after a good redeem means the invite is spent and the password is set, so going
    // back to the form would only retry a redeem that now answers 404 ("invalid").
    let result;
    try {
      result = await api.post('/auth/invite/redeem', { token, password });
    } catch (err) {
      if (!alive.current) return; // a different invite replaced this page meanwhile: its stored token is not ours to clear
      if (err.status === 404) { clearInviteToken(); setPhase('invalid'); }
      else if (err.status === 409) setError({ text: GENERIC_BUSY, signIn: true });
      else if (err.status === 429) setError({ text: GENERIC_LIMIT, signIn: false });
      else setError({ text: err.message, signIn: false });
      setPending(false);
      return;
    }
    // If a different invite replaced this page while the request was out, the stored token is now THAT invite's: leave it alone.
    if (!alive.current) return;
    // The token is spent: it must not outlive the redeem, in storage or in this page's memory.
    clearInviteToken();
    setToken(null);
    if (result.mfaRequired) {
      // Not reachable through the API today (a pending account cannot have two-factor on). Handled so it fails safe: the password
      // IS set, and the sign-in page asks for the code.
      setFinished(true);
      setPending(false);
      navigate('/login', { replace: true });
      return;
    }
    setFinished(true);
    try {
      // Must await: login() fetches the media token before setting the user, and navigating first would let Protected see a null
      // user and bounce back to /login (the same rule as Login.jsx).
      await login(result.token, result.user);
      navigate('/', { replace: true });
    } catch {
      // The password is set; only the automatic sign-in failed (a network blip while fetching the media token, say).
      setClaimed(true);
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

  // The invite was redeemed (the password is set) but the automatic sign-in failed. No form and no retry: the invite is spent.
  if (claimed) {
    return shell(
      <>
        <p className="tagline" role="alert">
          Your password is set. Sign in with your username and the password you just chose.
        </p>
        <Link className="btn btn-primary" to="/login">Go to sign in</Link>
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
