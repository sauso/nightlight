import { CloudOff, RotateCw } from 'lucide-react';

// What a tile's player overlay says when MediaMTX's status call timed out (the camera list carries
// `status: { ready: false, unknown: true }`, #505/#480). That is NOT "the camera is offline": Nightlight
// has lost sight of the stream status, and the camera itself may be fine. The wording says so, so a parent
// is not sent to check a camera's power for a fault inside the server.
//
// Icon + text, never colour alone, and `--text-secondary` rather than `--offline` on purpose: red is the
// "this camera is down" colour and this state is not that. `role="status"` makes a screen reader read it
// once when it appears. Retry reuses the player's own reconnect (the caller passes it), no new mechanism.
export default function StreamUnavailableNotice({ onRetry }) {
  return (
    <div className="stream-unavailable" role="status">
      <CloudOff size={24} aria-hidden="true" />
      <span>Streaming service unavailable. Your camera may still be online.</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
        <RotateCw size={16} aria-hidden="true" /> Retry
      </button>
    </div>
  );
}
