import { useNavigate } from 'react-router-dom';
import BackLink from './BackLink.jsx';

// The app's sticky top header. Top-level pages (Live, Alerts, Family, Settings) show the
// logo on the left, which taps home to Live. Sub-pages pass `back={{ to, label }}` to show
// a labelled back affordance instead (see BackLink) that returns to where they came from.
//
// Navigation that used to live in a hamburger here (Settings / Account / Change server /
// About / Sign out) now lives in the bottom-nav Settings tab + its hub, so the header stays
// a single logo/back + title row. It's pinned (position: sticky) rather than floating, which
// sidesteps mobile-browser quirks with top-anchored fixed elements drifting during the
// address-bar hide/show animation.
export default function AppHeader({ title, back }) {
  const navigate = useNavigate();

  return (
    <header className="app-header">
      <div className="app-header__top-row">
        {back ? (
          <BackLink fallback={back} />
        ) : (
          <button
            className="app-header__icon-btn"
            onClick={() => navigate('/')}
            aria-label="Go to Live"
          >
            <img src="/icons/icon-192.png" alt="" className="app-header__icon" />
          </button>
        )}
        <h1>{title}</h1>
      </div>
    </header>
  );
}
