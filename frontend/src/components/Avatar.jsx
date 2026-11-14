// Circular avatar. Shows an image when `src` is set, otherwise the initials from `name` on a
// coloured disc. Shared by caregivers, children and the Settings account row — the single place
// an image would slot in once avatar upload exists.
import { childColorVars } from '../lib/childColors.js';

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Avatar({ name, src, color, size = 40 }) {
  const base = { width: size, height: size, borderRadius: '50%', flexShrink: 0 };
  if (src) {
    return <img src={src} alt="" style={{ ...base, objectFit: 'cover' }} />;
  }
  // `color` is a child's STORED colour (a hex). It is drawn as the theme-aware token for the nearest of the six child colours,
  // never as the raw hex: the stored pastels are 1.61 to 3.43:1 on a white card (five of six under the 3:1 a ring needs) and white initials on them fail 4.5:1
  // (lib/childColors.js, docs/design-language.md "Child colours"). No colour (a caregiver, or an unreadable value) keeps the brand accent.
  const vars = childColorVars(color);
  return (
    <span
      aria-hidden="true"
      style={{
        ...base,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: vars ? vars.fill : 'var(--accent)',
        color: vars ? vars.on : 'var(--on-accent)',
        fontWeight: 700,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initials(name)}
    </span>
  );
}
