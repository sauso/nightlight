import qrcode from 'qrcode-generator';

// A QR code drawn as an inline SVG (no image request, nothing leaves the page). Shared by the Tailscale card (its sign-in link
// and secure address) and the caregiver invite panel (#1094); it began life inside TailscaleCard.jsx and was moved here
// unchanged, so the two cannot drift apart. The class names keep the `tailscale-` prefix because index.css styles them and
// renaming them would be churn for no behaviour.
//
// `value` is encoded as given: the caller is responsible for only passing something it is happy to show as a code. `label` is
// both the figure's caption and the SVG's accessible name, so it must NOT contain the value (an invite link carries a secret).
export default function QrCode({ value, label }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const cells = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) cells.push(<rect key={`${row}-${column}`} x={column + 4} y={row + 4} width="1" height="1" />);
    }
  }
  return <figure className="tailscale-qr">
    <svg role="img" aria-label={label} viewBox={`0 0 ${count + 8} ${count + 8}`} xmlns="http://www.w3.org/2000/svg">
      <rect width={count + 8} height={count + 8} className="tailscale-qr__background" />
      <g className="tailscale-qr__modules">{cells}</g>
    </svg>
    <figcaption>{label}</figcaption>
  </figure>;
}
