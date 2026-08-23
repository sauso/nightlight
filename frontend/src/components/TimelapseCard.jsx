import { useEffect, useState } from 'react';
import { Play, Film } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';

// "Memories" card on a child's detail page: the nightly sleep timelapse (see lib/timelapse.js). Shows
// the most recent night as a hero thumbnail that plays in a modal; older nights sit in a strip below to
// pick from. Renders nothing until the first timelapse exists, so it never shows an empty placeholder.

function nightLabel(nightDate) {
  const d = new Date(nightDate + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return nightDate;
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function TimelapseCard({ childId }) {
  const [list, setList] = useState([]);
  const [selId, setSelId] = useState(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get(`/timelapses/child/${childId}`)
      .then((rows) => {
        if (!alive) return;
        const arr = Array.isArray(rows) ? rows : [];
        setList(arr);
        setSelId(arr.length ? arr[0].id : null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [childId]);

  if (!list.length) return null;
  const sel = list.find((t) => t.id === selId) || list[0];

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
        <Modal title={`Timelapse · ${nightLabel(sel.night_date)}`} onClose={() => setPlaying(false)}>
          <video
            className="timelapse-player"
            src={api.url(`/timelapses/${sel.id}/video`)}
            poster={api.url(`/timelapses/${sel.id}/thumb`)}
            controls
            autoPlay
            playsInline
          />
        </Modal>
      )}
    </div>
  );
}
