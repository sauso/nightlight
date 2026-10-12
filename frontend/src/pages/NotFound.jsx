import { useNavigate } from 'react-router-dom';
import AppHeader from '../components/AppHeader.jsx';

// What an address that matches no screen shows (#379). Before this the inner <Routes> in App.jsx had no
// catch-all, so a mistyped or stale link (a bookmark to a screen that was renamed, an old notification
// deep link) rendered the app chrome around a blank page, with nothing saying it was the address that was
// wrong. Deliberately small: one sentence and a way out. It does NOT try to tell "no such child/camera"
// from "still loading" for a real route with a missing id: that is a different problem (#375).
//
// No `back` on the header: a not-found page has no parent to go back to, so the logo (home) is the header's
// own way out, and the button below says the same thing in words.
export default function NotFound() {
  const navigate = useNavigate();
  return (
    <>
      <AppHeader title="Page not found" />
      <main className="app-main">
        <div className="empty-state">
          <p style={{ marginTop: 0 }}>
            There is nothing at this address. The link may be out of date, or mistyped.
          </p>
          <button className="btn btn-primary" type="button" onClick={() => navigate('/')}>Go to Live</button>
        </div>
      </main>
    </>
  );
}
