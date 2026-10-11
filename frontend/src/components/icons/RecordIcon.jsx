// The classic "record" symbol: a ring with a smaller solid dot in the middle, as a lucide-compatible
// icon ({ size, color }). Used for the camera tile's IDLE Record button (#680).
//
// WHY a hand-written icon and not lucide's `<Circle fill="currentColor" />`: that is a solid white disc,
// which is a lot of white on a bedside screen at night. The ring keeps the same footprint with much less
// lit area, and still reads as "record". Geometry (24-unit viewBox) is the owner's reference: a thick-ish
// ring (r 10.2, stroke 1.7 -> outer edge 11.05, inside the 12-unit box) and a dot about half the outer
// diameter (r 5.6).
//
// Both parts take `color`, so it tints from the button's `currentColor` like the other overlay icons.
// The class names are how the tests tell this icon from the solid disc the ACTIVE state keeps.
export default function RecordIcon({ size = 24, color = 'currentColor', ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="record-icon"
      aria-hidden="true"
      {...props}
    >
      <circle className="record-icon__ring" cx="12" cy="12" r="10.2" stroke={color} strokeWidth="1.7" fill="none" />
      <circle className="record-icon__dot" cx="12" cy="12" r="5.6" fill={color} stroke="none" />
    </svg>
  );
}
