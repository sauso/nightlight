import { useEffect, useState } from 'react';
import { Play, Film, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import MediaPlayerModal from './MediaPlayerModal.jsx';

// "Memories" card on a child's detail page: the nightly sleep timelapse (see lib/timelapse.js). Shows
// the most recent night as a hero thumbnail that plays in a modal; older nights sit in a strip below to
// pick from. Renders nothing until the first timelapse exists, so it never shows an empty placeholder.

function nightLabel(nightDate) {
  const d = new Date(nightDate + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return nightDate;
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
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

      <button type="button" className="timelapse-hero" onClick={() => setPlaying(true)} aria-label={`Play ${nightLabel(sel.night_date)} timelapse`}>
        <img className="timelapse-hero__thumb" src={api.url(`/timelapses/${sel.id}/thumb`)} alt="" loading="lazy" />
        <span className="timelapse-play"><Play size={26} aria-hidden="true" /></span>
        <span className="timelapse-hero__meta">
          {nightLabel(sel.night_date)}{sel.duration_s ? ` · ${sel.duration_s}s` : ''}
        </span>
      </button>

      {list.length > 1 && (
        <div className="timelapse-strip">
          {list.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`timelapse-strip__item${t.id === sel.id ? ' timelapse-strip__item--active' : ''}`}
              onClick={() => setSelId(t.id)}
              title={nightLabel(t.night_date)}
            >
              <img src={api.url(`/timelapses/${t.id}/thumb`)} alt={nightLabel(t.night_date)} loading="lazy" />
              <span>{nightLabel(t.night_date)}</span>
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
