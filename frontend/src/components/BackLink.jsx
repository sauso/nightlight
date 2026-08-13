import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

// Labelled back affordance for the top-left of a sub-page's header. It returns to
// wherever the user came from: a page can be reached from more than one place (e.g.
// a camera opened from Family → Cameras, or later from the tile's gear sheet), so the
// navigating page passes { state: { from: { to, label } } } and this honours it,
// falling back to the page's default parent when no origin was supplied (direct link,
// refresh). Keeps the "‹ Family" / "‹ Live" wording pointing at the real origin.
export default function BackLink({ fallback }) {
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || fallback;
  if (!from) return null;
  return (
    <button
      type="button"
      className="app-header__back"
      onClick={() => navigate(from.to)}
      aria-label={`Back to ${from.label}`}
    >
      <ChevronLeft size={22} aria-hidden="true" />
      <span>{from.label}</span>
    </button>
  );
}
