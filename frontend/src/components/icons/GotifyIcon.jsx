import { Server } from 'lucide-react';

// Placeholder brand icon — lucide-compatible ({ size, color, ... }). Swap the internals for the real
// Gotify logo SVG when supplied (keep the same props shape so the Push hub needs no change).
export default function GotifyIcon(props) {
  return <Server {...props} />;
}
