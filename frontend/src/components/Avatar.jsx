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

// `color` is a child's STORED colour (a hex, or '' / absent for none). It is drawn as the theme-aware token for the nearest of the six child colours,
// never as the raw hex: the stored pastels are 1.61 to 3.43:1 on a white card (five of six under the 3:1 a ring needs) and white initials on them fail 4.5:1
// (lib/childColors.js, docs/design-language.md "Child colours"). No colour (a caregiver, a child with none chosen, or an unreadable value) keeps the brand accent.
//
// The colour shows two ways, and never both: with a photo it is a 3px RING around the photo (owner, 2026-11-15: around the photo
// only, never around the card it sits on); without one the initials disc is filled with it. No colour, no ring: a plain photo.
// The ring is a box-shadow, so it takes no layout and every place an avatar sits keeps its size. It is outside the avatar's box,
// so the parents that hold one need to leave room for 3px (none clips it: the list card, the night card and the edit screens
// do not set overflow). No gap between photo and ring: a gap would have to be painted in the surface colour, and the surfaces
// differ (the navy gradient of the night card, the white card, the page), so a mismatch would show as a halo; the ring's own
// contrast (>= 3:1 on the surface, docs/design-language.md "Child colours") is what makes it read, not a gap.
// `surface="night"` is for the child page's night card only: it is the same navy in both themes, so the ring takes the `-night`
// shade, which is measured on that navy; everywhere else it takes the themed shade.
export default function Avatar({ name, src, color, size = 40, surface }) {
  const base = { width: size, height: size, borderRadius: '50%', flexShrink: 0 };
  const vars = childColorVars(color);
  if (src) {
    if (!vars) return <img src={src} alt="" style={{ ...base, objectFit: 'cover' }} />;
    const ring = surface === 'night' ? vars.ringOnNight : vars.ring;
    return <img src={src} alt="" data-child-ring="" style={{ ...base, objectFit: 'cover', boxShadow: `0 0 0 3px ${ring}` }} />;
  }
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
