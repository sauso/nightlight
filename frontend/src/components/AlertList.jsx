import { useState } from 'react';
import { Zap, AudioLines, Play, Bell, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useHomeTime } from '../lib/useHomeTime.js';
import ClipPlayerModal from './ClipPlayerModal.jsx';
import { ProtectedBadge } from './ClipProtection.jsx';

// A child's "Recent alerts" card (UI refresh PR D, the approved design): one row per alert with a snapshot thumbnail, the kind
// (icon + word) and the CLOCK TIME it happened, in the home timezone. It used to say "3h ago"; a parent reading the page
// in the morning wants "was that the 3 a.m. one?", not arithmetic, and a relative time also goes stale between the 15 s polls.
// A time on an earlier day carries the day ("Wed, 11 Nov, 3:12 AM"), because three newest alerts can span several quiet days.
//
// Only a row WITH a clip is a button (the whole row opens the player, accessible name "Play clip from <camera>", as the
// thumbnail's was before). A row without one has nothing to open, so it is a plain row with no chevron: a chevron that goes
// nowhere is the kind of control this app has been taking out. The camera name is no longer printed on the row (a child's page
// is one child's; the design drops "<child> camera"), but it stays in the accessible name (a clip row) and the row's tooltip.
//
// `previewCount` (the child page passes 3) shows only the newest few and adds a "See all alerts" row that expands the rest in
// place. There is no alerts page to go to ("/alerts" redirects to Children), and the page already fetches the newest 20, so
// expanding is the whole of "all": nothing new is requested. The row is only offered when there IS more to show.
const TYPE = {
  motion: { label: 'Motion', Icon: Zap },
  sound: { label: 'Sound', Icon: AudioLines },
};
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const EARLIER_DAY = { weekday: 'short', day: 'numeric', month: 'short' };

export default function AlertList({ alerts, onChanged, title, previewCount = Infinity }) {
  const [clipFor, setClipFor] = useState(null); // the alert whose clip is open in the player
  const [protection, setProtection] = useState({});
  const [showAll, setShowAll] = useState(false);
  // Deleting a clip is admin-only (#538; the server refuses a caregiver), so only an admin's player gets
  // the delete action. Everyone can still watch and download. `|| {}`: rendered outside an AuthContext
  // (some tests), nobody is signed in, so nobody is an admin.
  const { user } = useAuth() || {};
  const isAdmin = user?.role === 'admin';
  // The row shows the clock time in HOME time (with a zone label when this device is elsewhere, #561); the tooltip has the full date.
  const home = useHomeTime();

  if (!alerts || alerts.length === 0) return null;
  const hasMore = alerts.length > previewCount;
  const shown = hasMore && !showAll ? alerts.slice(0, previewCount) : alerts;
  const clock = (d) => (home.dayKey(d) === home.todayKey() ? home.time(d) : `${home.day(d, EARLIER_DAY)}, ${home.time(d)}`);

  return (
    <>
      <div className="card tight alert-list">
        {title && (
          // The text is its own <span> so it stays a leaf element: the docs-screenshot run finds this heading by its text (e2e/walkthrough/capture.mjs).
          <div className="card-title alert-list__title"><Bell size={16} aria-hidden="true" /><span>{title}</span></div>
        )}
        {shown.map((ev) => {
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
          const content = (
            <>
              <span className="alert-item__thumbwrap">
                {Thumb}
                {hasClip && <span className="alert-item__play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>}
              </span>
              <span className="alert-item__body">
                <span className="alert-item__name">
                  <Icon size={16} className="alert-item__ico" aria-hidden="true" />
                  <span className="alert-item__nametext">{t.label}</span>
                  {clipPending && (
                    <span className="rec-badge" title="Recording clip…">
                      <span className="rec-dot" aria-hidden="true" />REC
                    </span>
                  )}
                  {hasClip && !!(protection[ev.id] ?? ev.protected) && <ProtectedBadge />}
                </span>
                <span className="alert-item__meta">
                  <time className="alert-item__time" dateTime={when.toISOString()} title={home.dateTime(when)}>
                    {clock(when)}
                  </time>
                  {ev.detail ? ` · ${ev.detail}` : ''}
                </span>
              </span>
              {hasClip && <ChevronRight size={18} className="alert-item__chev" aria-hidden="true" />}
            </>
          );
          return hasClip ? (
            <button key={ev.id} type="button" className="alert-item alert-item--btn" title={ev.camera_name} onClick={() => setClipFor(ev)}
              aria-label={`Play clip from ${ev.camera_name}`}>
              {content}
            </button>
          ) : (
            <div key={ev.id} className="alert-item" title={ev.camera_name}>{content}</div>
          );
        })}
        {hasMore && (
          <button type="button" className="alert-list__more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : 'See all alerts'}
          </button>
        )}
      </div>

      {clipFor && (
        <ClipPlayerModal ev={clipFor} onClose={() => setClipFor(null)} onDeleted={isAdmin ? onChanged : undefined}
          onProtectedChange={(id, value) => { setProtection((prev) => ({ ...prev, [id]: value })); onChanged?.(id, value); }} />
      )}
    </>
  );
}
