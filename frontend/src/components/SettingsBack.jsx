import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

// Back affordance shown at the top of every Settings sub-page, returning to the
// Settings hub (/settings). Kept as one component so the sub-pages stay consistent.
export default function SettingsBack() {
  return (
    <Link
      to="/settings"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginBottom: 12,
        color: 'var(--accent, inherit)',
        textDecoration: 'none',
        fontSize: '0.95rem',
      }}
    >
      <ChevronLeft size={18} /> Settings
    </Link>
  );
}
