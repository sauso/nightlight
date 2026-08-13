import { Zap, AudioLines } from 'lucide-react';
import { api } from '../lib/api.js';

// A single-card alert list (matching the design mockup): one row per alert — snapshot thumbnail,
// camera name, a motion/sound type icon + label, and the time. Shared by the Live "Recent activity"
// list and each child's detail screen. Renders nothing when there are no alerts.
const TYPE = {
  motion: { label: 'Motion', Icon: Zap },
  sound: { label: 'Sound', Icon: AudioLines },
};
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
function relTime(d) {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function AlertList({ alerts }) {
  if (!alerts || alerts.length === 0) return null;
  return (
    <div className="card tight alert-list">
      {alerts.map((ev) => {
        const t = TYPE[ev.type] || { label: ev.type, Icon: Zap };
        const Icon = t.Icon;
        const when = parseUtc(ev.created_at);
        return (
          <div key={ev.id} className="alert-item">
            {ev.snapshot ? (
              <img className="alert-item__thumb" src={api.url(`/cameras/alerts/${ev.id}/snapshot`)} alt="" loading="lazy" />
            ) : (
              <span className="alert-item__thumb alert-item__thumb--empty" aria-hidden="true"><Icon size={16} /></span>
            )}
            <div className="alert-item__body">
              <div className="alert-item__name">{ev.camera_name}</div>
              <div className="alert-item__meta">
                <Icon size={14} className="alert-item__ico" aria-hidden="true" />
                {t.label}{ev.detail ? ` · ${ev.detail}` : ''}
              </div>
            </div>
            <time className="alert-item__time" dateTime={when.toISOString()} title={when.toLocaleString()}>
              {relTime(when)}
            </time>
          </div>
        );
      })}
    </div>
  );
}
