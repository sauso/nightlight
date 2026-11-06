import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken, refreshMediaToken, clearMediaToken, onUnauthorized } from './api.js';
import { saveNativeSession, adoptNativeSession, clearNativeSession } from './nativeBridge.js';
import { unregisterPushNotifications, resetPushRegistration } from './pushNotifications.js';
import { useAutoRetry } from './useAutoRetry.js';
import { clearAllDrafts } from './formDraft.js';
import { getIceServers } from './iceServers.js';

function warmIceServersForSignedInUser() {
  // #739: /api/about requires a session. Start this before showing the first tile, so its 1s ICE
  // lookup budget usually finds a cached answer. Do not wait for it: a slow /about must not hold sign-in,
  // and it can run alongside the media-token fetch. getIceServers() shares an in-flight request and never
  // rejects. Keep that cache across sign-out: STUN_SERVERS is server-wide, not tied to a user.
  void getIceServers();
}

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

  // One sign-in across the Android app's two addresses (lib/nativeBridge.js adoptNativeSession): a page with no token asks the app
  // for the saved one, ONCE per page load (refresh() runs again from several screens, and a revoked token must not be fetched
  // again and again). `loading` stays true while it asks (a 6 s deadline inside adoptNativeSession), so the sign-in form never
  // flashes before a saved sign-in arrives. The app only ever answers the page on the saved Tailscale address.
  const adoptedWhenSignedOut = useRef(false);
  const adoptedAfterRejection = useRef(false);
  const adoptedToken = useRef(null); // the token this page took from the app, if any

  async function refresh() {
    if (!getToken() && !adoptedWhenSignedOut.current) {
      adoptedWhenSignedOut.current = true;
      const saved = await adoptNativeSession();
      if (saved && !getToken()) {
        adoptedToken.current = saved;
        setToken(saved); // it still goes through the /auth/me check below
      }
    }
    if (!getToken()) {
      setUser(null);
      setUnreachable(false);
      setFailures(0);
      setLoading(false);
      return;
    }
    setRetrying(true);
    const sent = getToken(); // the token this check carries, so a rejection below can tell WHICH token was refused
    const placeBefore = window.location.hash; // api.js sends a 401 to #/login; if the saved sign-in is taken, put the person back
    try {
      const me = await api.get('/auth/me');
      warmIceServersForSignedInUser();
      // Fetch the media token before rendering the authed app, so the first <img>/HLS load already
      // has one (never blocks sign-in on failure — getMediaToken() retries lazily).
      await refreshMediaToken().catch(() => {});
      setUser(me);
      setUnreachable(false);
      setFailures(0);
    } catch (err) {
      if (err?.status === 401 && getToken() && getToken() !== sent) {
        // This check carried a token that has since been REPLACED by a newer sign-in (api.js ignored its late refusal for that
        // reason). Nothing to do: the newer sign-in stays, and this answer must not spend the one ask of the app or sign it out
        // (Opus review: two overlapping refreshes, Account's or the auto-retry's).
      } else if (err?.status === 401) {
        // The server answered and refused this sign-in: api.js has already cleared the token (and told the app to drop that
        // exact token, see the listener below). The app may hold a DIFFERENT, newer saved sign-in (this address kept an old one
        // while the other address signed in again): take it once and check it. A saved token that is the one just refused was
        // dropped by the listener, so there is nothing to take and no loop.
        // (A token this page itself just took from the app and that was refused needs no second look: the app was just told to drop it.)
        if (!adoptedAfterRejection.current && adoptedToken.current !== sent) {
          adoptedAfterRejection.current = true;
          const saved = await adoptNativeSession();
          if (saved && saved !== sent && !getToken()) {
            adoptedToken.current = saved;
            setToken(saved);
            // The refusal above sent the page to #/login (api.js). The person was somewhere (a camera, a setting) and is about to
            // be signed in again, so put them back: if the saved token is refused too, its own 401 sends them to #/login again.
            // (A cold start has no fragment at all: that means the home screen, so '' goes back to '#/', not to the sign-in route.)
            if (!placeBefore.startsWith('#/login')) window.location.hash = placeBefore || '#/';
            await refresh();
            return;
          }
        }
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
  useEffect(() => onUnauthorized((rejectedToken) => {
    // The Android app keeps a copy of the token for the other address. Drop it ONLY if it is the token the server just refused,
    // and only when that request carried a token: a wrong password or MFA code on the sign-in form is a 401 with none, and an old
    // token's 401 must not delete a newer saved sign-in.
    if (rejectedToken) void clearNativeSession(rejectedToken);
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
    // Keep it in the Android app too, for the other address (best effort, never blocks or breaks signing in). The app stamps it
    // with the addresses known now; the app shell saves it again once the Tailscale address has been learned (App.jsx).
    void saveNativeSession(token);
    warmIceServersForSignedInUser();
    await refreshMediaToken().catch(() => {});
    setUser(userObj);
  }

  function logout() {
    // Stop this device receiving alerts (best-effort, while the token is still valid).
    unregisterPushNotifications().catch(() => {});
    // Forget the Android app's saved copy first, whatever happens to the server call: it needs no network, so an offline sign-out
    // still ends the sign-in on this phone (the server session stays until it expires, exactly as for the stored token below).
    void clearNativeSession();
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
