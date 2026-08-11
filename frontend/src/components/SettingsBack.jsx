import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

// Back affordance at the top of every Settings sub-page. Defaults to the Settings hub,
// but honours a `state.from` origin when the page was reached from elsewhere (e.g.
// Caregivers opened from the Family hub returns to Family, not Settings).
export default function SettingsBack() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || { to: '/settings', label: 'Settings' };

  return (
    <button
      type="button"
      onClick={() => navigate(from.to)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginBottom: 12,
        padding: 0,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'var(--accent, inherit)',
        fontSize: '0.95rem',
        fontFamily: 'inherit',
      }}
    >
      <ChevronLeft size={18} /> {from.label}
    </button>
  );
}
