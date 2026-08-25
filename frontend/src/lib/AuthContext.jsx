import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, refreshMediaToken, clearMediaToken } from './api.js';
import { unregisterPushNotifications } from './pushNotifications.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get('/auth/me');
      // Fetch the media token before rendering the authed app, so the first <img>/HLS load already
      // has one (never blocks sign-in on failure — getMediaToken() retries lazily).
      await refreshMediaToken().catch(() => {});
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

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
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
