import { useEffect, useState } from 'react';
import { Play, Film, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { formatDayKey } from '../lib/homeTime.js';
import MediaPlayerModal from './MediaPlayerModal.jsx';
import ModalActions from './ModalActions.jsx';

// "Timelapse" card on a NIGHT's page (pages/SleepDetail.jsx, directly under the Timeline card): the sleep timelapse of THAT
// night (see lib/timelapse.js), as a hero thumbnail that plays in a modal. It used to sit on the child's page with a strip of
// recent nights to pick from; it moved here (owner, 2026-11-15) because a timelapse is one night's memory, so the night is the
// natural place to look for it and the strip of nights is no longer needed (the page's own night navigator does that job).
// Renders nothing when that night has no timelapse (the card is not drawn at all, never an empty placeholder): a child with
// no timelapse, a night that is too short, one the detector scored empty, or a timelapse switched off.

// `night_date` is a calendar date the server worked out in HOME time (the night that began that evening),
// so it is already the same for every viewer and has no clock to convert. It is printed through
// formatDayKey (#561), which builds it in UTC, so no device zone can shift it to a neighbouring day or
// land it in a daylight-saving gap the way `new Date(date + 'T00:00:00')` (local midnight) could.
function nightLabel(nightDate) {
  return formatDayKey(nightDate, { weekday: 'short', day: 'numeric', month: 'short' });
}

// `nightDate` is the night's `YYYY-MM-DD`, the same key as `sleep_nights.night_date` and `timelapses.night_date`, so the
// match below is an exact string comparison and no date maths (or timezone) is involved.
export default function TimelapseCard({ childId, nightDate }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  // The child's whole list (no backend change: the endpoint already returns every night's row), fetched when the card mounts
  // or the child changes, then the row for the shown night picked from it. SleepDetail keys this card by child only, so a
  // `nightDate` change on a card that stays mounted costs no request. (On the real page the card does not stay mounted from one
  // night to the next: see the note where SleepDetail mounts it.)
  const [list, setList] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [del, setDel] = useState(''); // '' | 'confirm' | 'deleting' | 'error'

  function load(alive = { current: true }) {
    // Promise.resolve: a test double (or a future caller) whose `get` returns nothing must not throw during render.
    return Promise.resolve(api.get(`/timelapses/child/${childId}`))
      .then((rows) => {
        if (!alive.current) return;
        setList(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {});
  }

  useEffect(() => {
    const alive = { current: true };
    load(alive);
    return () => { alive.current = false; };
  }, [childId]);

  // The card stays mounted while the page steps from night to night (it is keyed by child only), so a player left open, or a
  // half-answered delete confirmation, must not wait there and reappear when the page comes back to a night that has a timelapse.
  useEffect(() => {
    setPlaying(false);
    setDel('');
  }, [nightDate]);

  const sel = list.find((t) => t && t.night_date === nightDate);
  if (!sel) return null;
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

      {playing && (
        <MediaPlayerModal
          title={`Timelapse · ${nightLabel(sel.night_date)}`}
          videoPath={`/timelapses/${sel.id}/video`}
          posterPath={`/timelapses/${sel.id}/thumb`}
          filename={`timelapse-${sel.night_date}.mp4`}
          meta={heroMeta}
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
                <ModalActions>
                  <button type="button" className="btn btn-secondary" onClick={() => setDel('')} disabled={del === 'deleting'}>Cancel</button>
                  <button type="button" className="btn btn-danger" onClick={deleteNow} disabled={del === 'deleting'}>
                    {del === 'deleting' ? 'Deleting…' : 'Delete'}
                  </button>
                </ModalActions>
              </div>
            ) : null
          }
        />
      )}
    </div>
  );
}
