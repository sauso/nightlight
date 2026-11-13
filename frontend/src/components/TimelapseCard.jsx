import { useEffect, useState } from 'react';
import { Play, Film, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { formatDayKey } from '../lib/homeTime.js';
import MediaPlayerModal from './MediaPlayerModal.jsx';

// "Timelapse" card on a child's detail page: the nightly sleep timelapse (see lib/timelapse.js). Shows
// the most recent night as a hero thumbnail that plays in a modal; recent nights sit in a strip below as small
// weekday-labelled thumbnails to pick from (UI refresh PR D). Renders nothing until the first timelapse exists, so it
// never shows an empty placeholder (a child with no timelapse, or one whose timelapse is off, gets no card at all).

// `night_date` is a calendar date the server worked out in HOME time (the night that began that evening),
// so it is already the same for every viewer and has no clock to convert. It is printed through
// formatDayKey (#561), which builds it in UTC, so no device zone can shift it to a neighbouring day or
// land it in a daylight-saving gap the way `new Date(date + 'T00:00:00')` (local midnight) could.
function nightLabel(nightDate) {
  return formatDayKey(nightDate, { weekday: 'short', day: 'numeric', month: 'short' });
}

// The strip's short label: the weekday of the same calendar date, built the same way (see above), so it can never disagree
// with the full label next to it. An unparseable date comes back as the raw text, like nightLabel.
function weekdayLabel(nightDate) {
  return formatDayKey(nightDate, { weekday: 'short' });
}

export default function TimelapseCard({ childId }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [list, setList] = useState([]);
  const [selId, setSelId] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [del, setDel] = useState(''); // '' | 'confirm' | 'deleting' | 'error'

  function load(alive = { current: true }) {
    return api
      .get(`/timelapses/child/${childId}`)
      .then((rows) => {
        if (!alive.current) return;
        const arr = Array.isArray(rows) ? rows : [];
        setList(arr);
        // Keep the current pick if it survived the refresh, else fall back to the newest.
        setSelId((prev) => (arr.some((t) => t.id === prev) ? prev : arr.length ? arr[0].id : null));
      })
      .catch(() => {});
  }

  useEffect(() => {
    const alive = { current: true };
    load(alive);
    return () => { alive.current = false; };
  }, [childId]);

  if (!list.length) return null;
  const sel = list.find((t) => t.id === selId) || list[0];
  const confirming = del === 'confirm' || del === 'deleting' || del === 'error';
  const heroMeta = `${nightLabel(sel.night_date)}${sel.duration_s ? ` · ${sel.duration_s}s` : ''}`;

  function closePlayer() {
    setDel('');
    setPlaying(false);
  }

  // Admin-only, and irreversible: unlike an alert clip (whose alert and snapshot survive), a timelapse
  // is the only copy — its source frames are deleted as soon as it's assembled. Confirmed in-app, never
  // with a browser dialog.
  async function deleteNow() {
    setDel('deleting');
    try {
      await api.del(`/timelapses/${sel.id}`);
      closePlayer();
      await load();
    } catch {
      setDel('error');
    }
  }

  return (
    <div className="card timelapse-card">
      <div className="card-title">
        <Film size={16} aria-hidden="true" /> Timelapse
      </div>

      {/* The name STARTS with the text printed on the button, duration included (WCAG 2.5.3, label in name): it used to be
          "Play Tue, 1 Sept timelapse", which does not contain the visible "Tue, 1 Sept · 42s", so a voice-control user saying
          what they see got no match. The verb moves to the end. */}
      <button type="button" className="timelapse-hero" onClick={() => setPlaying(true)} aria-label={`${heroMeta}, play timelapse`}>
        <img className="timelapse-hero__thumb" src={api.url(`/timelapses/${sel.id}/thumb`)} alt="" loading="lazy" />
        <span className="timelapse-play"><Play size={26} aria-hidden="true" /></span>
        <span className="timelapse-hero__meta">{heroMeta}</span>
      </button>

      {list.length > 1 && (
        <div className="timelapse-strip">
          {list.map((t) => (
            // The tile prints only the weekday (the design: "Tue", "Mon"), over the thumbnail. A weekday alone repeats once a
            // week, so the FULL date is the accessible name and the tooltip, and the picture is decoration (alt="") so a
            // screen reader hears "Tue, 1 Sept timelapse" once, not the date twice. The name opens with the printed weekday
            // (WCAG 2.5.3, label in name; it was "Show Tue, 1 Sept timelapse"), and aria-pressed says it picks the night.
            <button
              key={t.id}
              type="button"
              className={`timelapse-strip__item${t.id === sel.id ? ' timelapse-strip__item--active' : ''}`}
              onClick={() => setSelId(t.id)}
              title={nightLabel(t.night_date)}
              aria-label={`${weekdayLabel(t.night_date)}, ${formatDayKey(t.night_date, { day: 'numeric', month: 'short' })} timelapse`}
              aria-pressed={t.id === sel.id}
            >
              <img src={api.url(`/timelapses/${t.id}/thumb`)} alt="" loading="lazy" />
              <span>{weekdayLabel(t.night_date)}</span>
            </button>
          ))}
        </div>
      )}

      {playing && (
        <MediaPlayerModal
          title={`Timelapse · ${nightLabel(sel.night_date)}`}
          videoPath={`/timelapses/${sel.id}/video`}
          posterPath={`/timelapses/${sel.id}/thumb`}
          filename={`timelapse-${sel.night_date}.mp4`}
          meta={`${nightLabel(sel.night_date)}${sel.duration_s ? ` · ${sel.duration_s}s` : ''}`}
          onClose={closePlayer}
          headerAction={
            isAdmin ? (
              <button type="button" className="icon-btn icon-btn--danger" aria-label="Delete timelapse"
                onClick={() => setDel('confirm')} disabled={del === 'deleting'}>
                <Trash2 size={17} />
              </button>
            ) : null
          }
          footer={
            confirming ? (
              <div className="clip-confirm">
                <span>
                  {del === 'error'
                    ? 'Couldn’t delete — try again.'
                    : 'Delete this timelapse? It can’t be rebuilt — the frames it was made from are gone.'}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn" onClick={() => setDel('')} disabled={del === 'deleting'}>Cancel</button>
                  <button type="button" className="btn btn-danger" onClick={deleteNow} disabled={del === 'deleting'}>
                    {del === 'deleting' ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            ) : null
          }
        />
      )}
    </div>
  );
}
