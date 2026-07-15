export default function BreathingDot({ status }) {
  // status: 'live' | 'connecting' | 'offline'
  return (
    <span className={`breathing breathing--${status}`}>
      <span className="breathing__ring" />
      <span className="breathing__core" />
    </span>
  );
}
