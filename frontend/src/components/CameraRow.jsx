import { ChevronRight } from 'lucide-react';

// A richer, read-only camera row: a small live thumbnail (green pulse when online, greyed when not),
// the name with an Online / Offline / Disabled pill, and capability badges. Optionally an assigned
// child chip. Used on the Child detail screen (and reusable elsewhere).
export default function CameraRow({ cam, child, onClick }) {
  const online = cam.statusLevel === 'live' && !cam.disabled;
  const pill = cam.disabled
    ? { cls: 'status-badge--off', text: 'Disabled' }
    : online
      ? { cls: 'status-badge--ok', text: 'Online' }
      : { cls: 'status-badge--bad', text: 'Offline' };

  const caps = [];
  if (cam.detect_motion_enabled) caps.push('MOTION');
  if (cam.detect_sound_enabled) caps.push('SOUND');
  if (cam.ptz_supported) caps.push('PTZ');
  if (cam.talk_configured) caps.push('TALK');

  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className="cam-row" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <span className={`cam-thumb${online ? '' : ' off'}`}>{online && <span className="cam-thumb__dot" aria-hidden="true" />}</span>
      <span className="cam-row__main">
        <span className="cam-row__top">
          <span className="cam-row__name">{cam.name}</span>
          <span className={`status-badge ${pill.cls} status-badge--sm`}>{pill.text}</span>
        </span>
        <span className="cam-row__meta">
          {child && (
            <span className="cam-chip">
              <span className="cam-chip__mini" style={{ background: child.color || 'var(--peri)' }}>
                {child.photo
                  ? <img src={child.photo} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                  : (child.name || '?')[0].toUpperCase()}
              </span>
              {child.name}
            </span>
          )}
          {caps.map((c) => <span key={c} className="cam-badge cam-badge--ok">{c}</span>)}
        </span>
      </span>
      {onClick && <ChevronRight size={17} style={{ opacity: 0.4, flexShrink: 0 }} aria-hidden="true" />}
    </Tag>
  );
}
