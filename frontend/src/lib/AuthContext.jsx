import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, refreshMediaToken, clearMediaToken, onUnauthorized } from './api.js';
import { unregisterPushNotifications, resetPushRegistration } from './pushNotifications.js';
import { useAutoRetry } from './useAutoRetry.js';

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
    setToken(null);
    setUser(null);
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
