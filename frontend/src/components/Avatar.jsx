// Circular avatar. Shows an image when `src` is set, otherwise the initials from `name` on a
// coloured disc. Shared by caregivers, children and the Settings account row — the single place
// an image would slot in once avatar upload exists.
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
  return (
    <span
      aria-hidden="true"
      style={{
        ...base,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: color || 'var(--peri)',
        color: '#fff',
        fontWeight: 700,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initials(name)}
    </span>
  );
}
