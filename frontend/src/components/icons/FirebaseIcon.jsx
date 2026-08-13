import { Flame } from 'lucide-react';

// Placeholder brand icon — lucide-compatible ({ size, color, ... }). Swap the internals for the real
// Firebase logo SVG when supplied (keep the same props shape so the Push hub needs no change).
export default function FirebaseIcon(props) {
  return <Flame {...props} />;
}
