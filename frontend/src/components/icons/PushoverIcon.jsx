import { Send } from 'lucide-react';

// Placeholder brand icon — lucide-compatible ({ size, color, ... }). Swap the internals for the real
// Pushover logo SVG when supplied (keep the same props shape so the Push hub needs no change).
export default function PushoverIcon(props) {
  return <Send {...props} />;
}
