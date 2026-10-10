import { useState } from 'react';
import { Zap, AudioLines, Play } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useHomeTime } from '../lib/useHomeTime.js';
import ClipPlayerModal from './ClipPlayerModal.jsx';

// A single-card alert list (matching the design mockup): one row per alert — snapshot thumbnail,
// camera name, a motion/sound type icon + label, and the time. When an alert has a recorded video
// clip (clip_status === 'ready'), its thumbnail becomes a play button that opens the clip in a modal
// player (the shared ClipPlayerModal). Shared by the Live "Recent activity" list and each child's
// detail screen.
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

export default function AlertList({ alerts, onChanged, title }) {
  const [clipFor, setClipFor] = useState(null); // the alert whose clip is open in the player
  // Deleting a clip is admin-only (#538; the server refuses a caregiver), so only an admin's player gets
  // the delete action. Everyone can still watch and download. `|| {}`: rendered outside an AuthContext
  // (some tests), nobody is signed in, so nobody is an admin.
  const { user } = useAuth() || {};
  const isAdmin = user?.role === 'admin';
  // The row shows an age ("3h ago", the same wherever you are); the tooltip carries the clock time, in
  // HOME time with a zone label when this device is elsewhere (#561).
  const home = useHomeTime();

  if (!alerts || alerts.length === 0) return null;
  return (
    <>
      <div className="card tight alert-list">
        {title && <div className="card-title">{title}</div>}
        {alerts.map((ev) => {
          const t = TYPE[ev.type] || { label: ev.type, Icon: Zap };
          const Icon = t.Icon;
          const when = parseUtc(ev.created_at);
          const hasClip = ev.clip_status === 'ready';
          const clipPending = ev.clip_status === 'pending';
          const Thumb = ev.snapshot ? (
            <img className="alert-item__thumb" src={api.url(`/cameras/alerts/${ev.id}/snapshot`)} alt="" loading="lazy" />
          ) : (
            <span className="alert-item__thumb alert-item__thumb--empty" aria-hidden="true"><Icon size={16} /></span>
          );
          return (
            <div key={ev.id} className="alert-item">
              {hasClip ? (
                <button type="button" className="alert-item__thumbwrap" onClick={() => setClipFor(ev)}
                  aria-label={`Play clip from ${ev.camera_name}`}>
                  {Thumb}
                  <span className="alert-item__play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
                </button>
              ) : (
                <span className="alert-item__thumbwrap">{Thumb}</span>
              )}
              <div className="alert-item__body">
                <div className="alert-item__name">
                  <span className="alert-item__nametext">{ev.camera_name}</span>
                  {clipPending && (
                    <span className="rec-badge" title="Recording clip…">
                      <span className="rec-dot" aria-hidden="true" />REC
                    </span>
                  )}
                </div>
                <div className="alert-item__meta">
                  <Icon size={14} className="alert-item__ico" aria-hidden="true" />
                  {t.label}{ev.detail ? ` · ${ev.detail}` : ''}
                </div>
              </div>
              <time className="alert-item__time" dateTime={when.toISOString()} title={home.dateTime(when)}>
                {relTime(when)}
              </time>
            </div>
          );
        })}
      </div>

      {clipFor && (
        <ClipPlayerModal ev={clipFor} onClose={() => setClipFor(null)} onDeleted={isAdmin ? onChanged : undefined} />
      )}
    </>
  );
}
