import { Megaphone } from 'lucide-react';

// Placeholder brand icon — lucide-compatible ({ size, color, ... }). Swap the internals for the real
// ntfy logo SVG when supplied (keep the same props shape so the Push hub needs no change).
export default function NtfyIcon(props) {
  return <Megaphone {...props} />;
}
