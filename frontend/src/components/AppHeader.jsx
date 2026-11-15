import { useNavigate } from 'react-router-dom';
import BackLink from './BackLink.jsx';
import DemoBanner from './DemoBanner.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import Logo from './Logo.jsx';

// The app's sticky top header. Top-level pages (Live, Alerts, Family, Settings) show the
// logo on the left, which taps home to Live. Sub-pages pass `back={{ to, label }}` to show
// a labelled back affordance instead (see BackLink) that returns to where they came from.
//
// Navigation that used to live in a hamburger here (Settings / Account / Change server /
// About / Sign out) now lives in the bottom-nav Settings tab + its hub, so the header stays
// a single logo/back + title row. The theme toggle is Live-only by the owner's 2026-11-01
// decision: other pages keep title room and use Account → Appearance to change the theme.
// It's pinned (position: sticky) rather than floating, which
// sidesteps mobile-browser quirks with top-anchored fixed elements drifting during the
// address-bar hide/show animation.
//
// `actions` (UI refresh PR E): a node pinned to the right of the title row, e.g. the sleep page's "⋯" menu. It sits where
// the theme toggle sits (that is Live-only, so the two never meet).
// `bandLine` (same PR): a thin line along the bottom edge of the bar in the band colour of the night on show, so the
// page says how the night went before anything is read. A band key ('great' | 'good' | 'fair' | 'low' | 'early', from
// bandOf) or 'none' for a neutral line; undefined = no line at all (every other page). It is a modifier class on the
// <header> itself (an inset shadow in CSS), NOT a child element: that way it is painted over the bar's own navy and can
// never end up drawn on the page background, where the band colours do not reach 3:1 (review of PR #1061). There is nothing
// in the accessibility tree: the score and its word are on the page, and a band colour is never the only signal or any text.
export default function AppHeader({ title, back, actions = null, bandLine, showDemoBanner = true, showThemeToggle = false }) {
  const navigate = useNavigate();

  return (
    <>
      <header className={`app-header${bandLine ? ` app-header--band-${bandLine}` : ''}`}>
        <div className="app-header__top-row">
          {back ? (
            <BackLink fallback={back} />
          ) : (
            <button
              className="app-header__icon-btn"
              onClick={() => navigate('/')}
              aria-label="Go to Live"
            >
              <Logo tile={false} className="app-header__icon" />
            </button>
          )}
          <h1>{title}</h1>
          {showThemeToggle && <ThemeToggle />}
          {actions && <div className="app-header__actions">{actions}</div>}
        </div>
      </header>
      {showDemoBanner && <DemoBanner />}
    </>
  );
}
