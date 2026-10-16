import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, refreshMediaToken, clearMediaToken, onUnauthorized } from './api.js';
import { unregisterPushNotifications, resetPushRegistration } from './pushNotifications.js';
import { useAutoRetry } from './useAutoRetry.js';
import { clearAllDrafts } from './formDraft.js';

// Exported so tests can inject a value directly — chiefly to render a screen as an admin and
// again as a caregiver, since role gating is real in this UI and is where bugs hide.
export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // #382: the server could not be reached (network failure, timeout, 5xx) while checking a stored sign-in.
  // That is NOT "signed out": only a 401 is. `failures` counts attempts in a row, for useAutoRetry's backoff.
  const [unreachable, setUnreachable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [failures, setFailures] = useState(0);

  async function refresh() {
    if (!getToken()) {
      setUser(null);
      setUnreachable(false);
      setFailures(0);
      setLoading(false);
      return;
    }
    setRetrying(true);
    try {
      const me = await api.get('/auth/me');
      // Fetch the media token before rendering the authed app, so the first <img>/HLS load already
      // has one (never blocks sign-in on failure — getMediaToken() retries lazily).
      await refreshMediaToken().catch(() => {});
      setUser(me);
      setUnreachable(false);
      setFailures(0);
    } catch (err) {
      if (err?.status === 401) {
        // The server answered and refused this sign-in: api.js has already cleared the token.
        setUser(null);
        setUnreachable(false);
        setFailures(0);
      } else if (!getToken()) {
        // The sign-in ended while this request was out: a 401 on another request (api.js dropped the token and
        // the onUnauthorized listener below reset everything) or Sign out got there first. This failure is about a
        // session that no longer exists, so it says nothing about the server. Marking it unreachable here put
        // "Can't reach Nightlight" in place of the sign-in form until the 5 s retry found no token (found in the
        // review of #715). Nothing to do: whoever dropped the token has already set the signed-out state, and
        // this older answer must not overwrite it.
        // WHY a token check and not a request generation counter: the one case a counter would add is a sign-in
        // REPLACED by a new one while this request was out, and that is harmless here (the new user is set, so the
        // app stays on screen, and the next retry, with the new token, clears the flag).
      } else {
        // Keep the stored token and any user already signed in (this is also what Account's and
        // UserSettings' refresh() calls hit): a blip must not sign anyone out, nor show a sign-in form.
        setUnreachable(true);
        setFailures((n) => n + 1);
      }
    } finally {
      setLoading(false);
      setRetrying(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useAutoRetry(failures, refresh);

  // A 401 on ANY request means this sign-in is over (#562; see onUnauthorized in api.js). api.js has
  // already cleared the stored token; dropping the user here is what makes the router show the sign-in
  // form instead of bouncing #/login back to a screen whose every request now fails. The media token goes
  // too, so nothing on screen keeps loading media with it. Not logout(): the server already ended this
  // session, so there is nothing to sign out of and no token left to unregister push with (and an
  // unregister request would answer 401 and fire this listener again). resetPushRegistration() only forgets
  // locally that push was registered, so signing in again in this same page registers push afresh under the
  // new session instead of hitting initPushNotifications()'s "already registered" early return.
  // The effect returns onUnauthorized's unsubscribe, so an unmounted provider is never called.
  useEffect(() => onUnauthorized(() => {
    clearMediaToken();
    resetPushRegistration();
    setUser(null);
    // A real 401 supersedes an earlier "unreachable" from a failed refresh(): the server has answered, so
    // Shell must show the sign-in screen now, not ServerUnreachable until the backoff retry (up to 30 s)
    // finally clears it. Zeroing `failures` also cancels that pending retry.
    setUnreachable(false);
    setFailures(0);
  }), []);

  // Keep the in-memory media token fresh while signed in (its own TTL is 12h; refresh hourly so any
  // newly-built media URL always carries a comfortably-valid token).
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => { refreshMediaToken().catch(() => {}); }, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [user]);

  async function login(token, userObj) {
    setToken(token);
    await refreshMediaToken().catch(() => {});
    setUser(userObj);
  }

  function logout() {
    // Stop this device receiving alerts (best-effort, while the token is still valid).
    unregisterPushNotifications().catch(() => {});
    api.post('/auth/logout', {}).catch(() => {}); // best-effort - clear local state regardless
    clearMediaToken();
    // An explicit sign-out: whatever the last person left half-typed must not be offered to the next. A session
    // that merely EXPIRES (onUnauthorized above) keeps its drafts on purpose, so signing back in resumes them;
    // drafts are keyed by user id, so a different person signing in still never sees them (#377).
    clearAllDrafts();
    setToken(null);
    setUser(null);
    // Signed out is not unreachable. A refresh() that failed earlier in this session (a blip after a save on
    // Account) leaves `unreachable` set and a backoff retry pending; with the user gone, Shell then showed
    // "Can't reach Nightlight" instead of the sign-in form until that retry (5-30 s) found no token (found in the
    // review of #715). Zeroing `failures` also cancels the pending retry. Same reset as the 401 listener above.
    setUnreachable(false);
    setFailures(0);
  }

  return (
    <AuthContext.Provider value={{ user, loading, unreachable, retrying, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
