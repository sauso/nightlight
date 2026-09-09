// The two route guards in App.jsx.
//
// These four-line components are the only thing standing between a caregiver and every admin screen —
// camera setup, detection tuning, user management, all the settings pages. Nothing else in the UI
// re-checks the role, so a defect here is not one broken page, it is all of them at once.
//
// Three branches, and the LOADING one is the least obvious and the most damaging:
//   * loading      -> render nothing, and above all do NOT redirect. Auth resolves asynchronously on
//                     every page load, so a guard that redirected while loading would bounce a
//                     perfectly valid session to the login screen on every refresh.
//   * no user      -> /login.
//   * wrong role   -> "/" and NOT /login. A caregiver IS signed in; sending them to a login screen
//                     would tell them their session was bad, which is a different and wrong message.
//
// Testing the guards directly rather than each protected page is deliberate: it is one test file for
// a rule that applies to ~15 routes, and it cannot rot as pages are added.
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../src/lib/AuthContext.jsx';
import { Protected, AdminProtected } from '../src/App.jsx';

// Mount a guard at /secret with somewhere recognisable to be redirected TO, so the test can tell the
// difference between "rendered nothing" and "sent to the login screen" — which is exactly the
// distinction the loading branch turns on.
function mount(Guard, auth) {
  return render(
    <AuthContext.Provider value={{ loading: false, user: null, login: () => {}, logout: () => {}, refresh: () => {}, ...auth }}>
      <MemoryRouter initialEntries={['/secret']}>
        <Routes>
          <Route path="/secret" element={<Guard><div>secret content</div></Guard>} />
          <Route path="/login" element={<div>login screen</div>} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

const ADMIN = { id: 'u1', username: 'nacho', role: 'admin' };
const CAREGIVER = { id: 'u2', username: 'nanny', role: 'caregiver' };

describe('Protected — any signed-in user', () => {
  test('lets a signed-in user through, whatever their role', () => {
    for (const user of [ADMIN, CAREGIVER]) {
      const { unmount } = mount(Protected, { user });
      expect(screen.getByText('secret content')).toBeTruthy();
      unmount();
    }
  });

  test('sends a signed-out visitor to the login screen', () => {
    mount(Protected, { user: null });
    expect(screen.getByText('login screen')).toBeTruthy();
    expect(screen.queryByText('secret content')).toBeNull();
  });

  test('while auth is still loading it renders nothing and redirects NOWHERE', () => {
    // The branch that matters. `loading` is true on every page load until the session is checked; a
    // guard that redirected here would send a valid session to /login on every single refresh.
    mount(Protected, { user: null, loading: true });
    expect(screen.queryByText('secret content')).toBeNull();
    expect(screen.queryByText('login screen')).toBeNull();
    expect(screen.queryByText('home')).toBeNull();
  });
});

describe('AdminProtected — admins only', () => {
  test('lets an admin through', () => {
    mount(AdminProtected, { user: ADMIN });
    expect(screen.getByText('secret content')).toBeTruthy();
  });

  test('sends a caregiver home, NOT to the login screen', () => {
    // A caregiver is signed in and their session is fine. Bouncing them to /login would claim
    // otherwise, and would invite them to re-authenticate against a door that will never open.
    mount(AdminProtected, { user: CAREGIVER });
    expect(screen.getByText('home')).toBeTruthy();
    expect(screen.queryByText('login screen')).toBeNull();
    expect(screen.queryByText('secret content')).toBeNull();
  });

  test('sends a signed-out visitor to the login screen', () => {
    mount(AdminProtected, { user: null });
    expect(screen.getByText('login screen')).toBeTruthy();
  });

  test('while auth is still loading it renders nothing and redirects NOWHERE', () => {
    mount(AdminProtected, { user: null, loading: true });
    expect(screen.queryByText('secret content')).toBeNull();
    expect(screen.queryByText('login screen')).toBeNull();
    expect(screen.queryByText('home')).toBeNull();
  });

  test('loading wins over a role that would otherwise be refused', () => {
    // Order matters: if the role check ran first, a caregiver would be redirected home a moment before
    // auth finished resolving — and an admin whose user object had not yet arrived would be treated as
    // a caregiver and thrown off the page they are entitled to.
    mount(AdminProtected, { user: CAREGIVER, loading: true });
    expect(screen.queryByText('home')).toBeNull();
    expect(screen.queryByText('secret content')).toBeNull();
  });

  test('an unknown or missing role is refused, not admitted by default', () => {
    // Fail closed. A user row with a null/typo'd role must never fall through to admin.
    for (const role of [undefined, null, '', 'Admin', 'ADMIN', 'superuser']) {
      const { unmount } = mount(AdminProtected, { user: { id: 'u3', username: 'x', role } });
      expect(screen.queryByText('secret content')).toBeNull();
      expect(screen.getByText('home')).toBeTruthy();
      unmount();
    }
  });
});
