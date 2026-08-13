// ntfy logo (line art), as a lucide-compatible icon ({ size, color }). Stroke-based → tints via `color`.
export default function NtfyIcon({ size = 24, color = 'currentColor', ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 50.8 50.8"
      fill="none"
      stroke={color}
      strokeWidth={3.175}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeMiterlimit={3}
      aria-hidden="true"
      {...props}
    >
      <path d="M44.98 39.952V10.848H7.407v27.814l-1.587 4.2 8.393-2.91Z" />
      <path d="M27.781 31.485h8.202" />
      <path d="m65.979 100.011 9.511 5.492-9.511 5.491" transform="translate(-51.81 -80.758)" />
    </svg>
  );
}
