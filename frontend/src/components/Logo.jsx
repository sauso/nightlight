// The Nightlight logo (frontend/public/icons/nightlight-logo.svg: the owner's periwinkle crescent and sleeping baby, on a
// transparent ground).
//
// Owner, 2026-11-05: in the header it is shown as it is, at the same size; everywhere else it sits on the header colour
// (`--bar`, #1f1a1e since 2026-11-12) in a rounded square, so the setup guide, About, the sign-in screen and the "Can't reach" screen all
// show the same tile. `tile={false}` is the header's bare logo: the header bar already is `--bar`, so it looks the same.
// The tile's corner radius is 25% of its size (the header's old 9/36, About's 16/64 and the sign-in's 22/84 were all about
// that), which is why it is a percentage and not a pixel value: every size keeps the same shape.
//
// Decorative: the app name is always written beside or below it, so the image has an empty alt and screen readers skip it.
const SRC = '/icons/nightlight-logo.svg';

export default function Logo({ size = 64, tile = true, glow = false, className = '' }) {
  if (!tile) return <img src={SRC} alt="" className={className || undefined} />;
  return (
    <span className={`logo-tile${glow ? ' logo-tile--glow' : ''}${className ? ` ${className}` : ''}`} style={{ width: size, height: size }}>
      <img src={SRC} alt="" />
    </span>
  );
}
