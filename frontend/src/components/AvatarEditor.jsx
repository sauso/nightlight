import { Camera } from 'lucide-react';
import Avatar from './Avatar.jsx';

// A tappable avatar: the photo (or the initials on their colour) with a small camera badge at the bottom-right; tapping it
// opens the file picker. The same control on the child's settings and on your own account, so the two look alike (owner,
// 2026-11-05, from a reference image: a round photo with a rounded-square camera badge; the badge border is the brand violet
// rather than the reference's green).
//
// This is ONLY the picker. What happens with the file (resize, save now or hold until Save, the status text, the Remove
// button) stays with the page, because those differ: a child's photo and your own are saved through different requests, and
// a brand-new child holds its photo until the first save. `onChange` is the plain file-input change handler.
//
// Accessibility: the real <input type="file"> is invisible but covers the whole avatar, so a tap, a click and keyboard focus
// all land on it, and its aria-label gives it its name ("Add photo" / "Change photo"; the label's own text would be the
// initials). Keyboard focus draws a ring around the whole avatar (index.css); a click or tap draws none.
export default function AvatarEditor({ name, src, color, size = 88, onChange }) {
  const badge = Math.max(24, Math.round(size * 0.34));
  return (
    <label className="avatar-editor" style={{ width: size, height: size }}>
      <Avatar name={name} src={src} color={color} size={size} />
      <span className="avatar-editor__badge" aria-hidden="true" style={{ width: badge, height: badge }}>
        <Camera size={Math.round(badge * 0.58)} />
      </span>
      <input className="avatar-editor__input" type="file" accept="image/*" aria-label={src ? 'Change photo' : 'Add photo'} onChange={onChange} />
    </label>
  );
}
