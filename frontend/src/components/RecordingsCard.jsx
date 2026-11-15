import { useCallback, useEffect, useId, useState } from 'react';
import { Play, Video, Trash2, AlertTriangle, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useHomeTime } from '../lib/useHomeTime.js';
import MediaPlayerModal from './MediaPlayerModal.jsx';
import Modal from './Modal.jsx';
import ModalActions from './ModalActions.jsx';
import { deleteFailureText } from './ClipPlayerModal.jsx';

// "Recordings" card on a child's detail page: the clips someone captured with the tile's Record button
// (see lib/recordings.js). Deliberately its own card rather than entries in the alert feed — these are
// moments a person chose to keep, not detections. Renders nothing until the first recording exists.
//
// Unlike alert clips, recordings have NO automatic retention, so deleting is the only way to reclaim
// the space — hence the delete action here. It is an ADMIN's action (#552; the server refuses a
// caregiver, owner decision 2026-10-10), the same as TimelapseCard: a caregiver can watch and download
// every recording, and a failed entry tells them an admin can clear it.

const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

// Rendered in HOME time (settings.timezone), with a zone label when the viewer's device is elsewhere
// (#561): a recording's "3:12 AM" must be the same moment for everyone looking at this child.
const WHEN = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
function when(startedAt, home) {
  const d = parseUtc(startedAt);
  if (Number.isNaN(d.getTime())) return startedAt;
  return home.time(d, WHEN);
}

// A recording this many home-time days old (or more) shows its DATE on the short label instead of a weekday: "Wed" alone
// cannot tell last Wednesday from one three weeks ago, and recordings have no retention, so old ones are normal. Under it,
// the weekday reads fine (a week is unambiguous). Counted in HOME calendar days, not 24-hour spans, so it does not move
// with the viewer's device zone.
const DATE_AFTER_DAYS = 7;
const dayNumber = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };

// The short form for the thumbnail chip and the row: it must fit at phone width (320px). The full home-time date stays
// on the button as its accessible name and tooltip. Both forms use the same home-zone formatters, including the zone suffix.
function shortWhen(startedAt, home) {
  const d = parseUtc(startedAt);
  if (Number.isNaN(d.getTime())) return startedAt;
  const time = home.time(d, { hour: 'numeric', minute: '2-digit' });
  const age = dayNumber(home.todayKey()) - dayNumber(home.dayKey(d));
  if (age >= DATE_AFTER_DAYS) return `${home.day(d, { day: 'numeric', month: 'short' })}, ${time}`;
  return `${home.day(d, { weekday: 'short' })} ${time}`;
}

// The short form split into the part that may shrink and the zone suffix that may not: [time, zone]. At 320px an away-from-home
// viewer's "Fri 4:12 am GMT+11" did not fit beside the title, and the row's ellipsis cut it from the END, which removed exactly
// the cue that says the time is not in the viewer's own zone (found in the Codex review of #1064). The zone is taken from Intl's
// own `timeZoneName` part (the same one `home.time` appended) and only split off when the text ENDS with it; a locale that puts
// the zone first keeps the whole text in one piece, as before. No zone (the viewer is at home) -> [whole, ''].
function shortWhenParts(startedAt, home) {
  const text = shortWhen(startedAt, home);
  const d = parseUtc(startedAt);
  if (!home.differs || Number.isNaN(d.getTime())) return [text, ''];
  const zone = new Intl.DateTimeFormat([], { timeZone: home.zone, timeZoneName: 'short' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value;
  if (!zone || !text.endsWith(zone) || text.length === zone.length) return [text, ''];
  return [text.slice(0, -zone.length).trimEnd(), zone];
}

export default function RecordingsCard({ childId, refreshNonce = 0 }) {
  const [list, setList] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [del, setDel] = useState(''); // '' | 'confirm' | 'deleting' | 'error'
  const [delError, setDelError] = useState('');
  // Closed by default: the row alone is the card (see the markup). Recordings are rare, kept moments, so the thumbnails
  // wait one tap rather than taking a screen of the child's page.
  const [expanded, setExpanded] = useState(false);
  const stripId = useId();
  const { user } = useAuth() || {};
  const isAdmin = user?.role === 'admin';
  const home = useHomeTime();

  const load = useCallback(() => {
    let alive = true;
    api
      .get(`/recordings/child/${childId}`)
      .then((rows) => { if (alive) setList(Array.isArray(rows) ? rows : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [childId]);

  useEffect(() => load(), [load, refreshNonce]);

  if (!list.length) return null;
  const open = list.find((r) => r.id === openId) || null;

  function close() {
    setDel('');
    setOpenId(null);
  }

  async function deleteNow() {
    setDel('deleting');
    try {
      await api.del(`/recordings/${open.id}`);
      close();
      load();
    } catch (err) {
      // The failed entry's modal and the player word a retry differently, so each passes its own fallback.
      setDelError(deleteFailureText(err, open.status === 'failed' ? 'Couldn’t remove it — try again.' : 'Couldn’t delete — try again.'));
      setDel('error');
    }
  }

  const confirming = del === 'confirm' || del === 'deleting' || del === 'error';

  return (
    <div className="card recordings-card">
      {/* ONE row (UI refresh PR D, the approved design): "Recordings", the newest one's time, a chevron. The row is a
          disclosure that opens the strip of every recording below it. It is not a link to the newest: recordings have no
          page of their own and no retention, so the older ones must stay reachable, and a row that played only the newest
          would strand them. The list is newest first (the server orders it), so list[0] is the latest. */}
      <button
        type="button"
        className="recordings-row"
        aria-expanded={expanded}
        aria-controls={expanded ? stripId : undefined}
        {...(list[0].status === 'failed' ? null : { title: `Latest: ${when(list[0].started_at, home)}`, 'aria-label': `Recordings ${shortWhen(list[0].started_at, home)}, latest ${when(list[0].started_at, home)}` })}
        onClick={() => setExpanded((v) => !v)}
      >
        <Video size={16} aria-hidden="true" className="recordings-row__icon" />
        <span className="recordings-row__title">Recordings</span>
        {/* The SHORT form: the long one ("Fri, 13 Nov, 4:12 am GMT+11") lost its AM/PM to an ellipsis at 320px. */}
        {/* The time shrinks first (it ends in an ellipsis); the zone suffix of an away-from-home viewer never does. */}
        <span className="recordings-row__latest">
          {list[0].status === 'failed' ? <span className="recordings-row__when">Couldn’t be saved</span> : (() => {
            const [time, zone] = shortWhenParts(list[0].started_at, home);
            return <><span className="recordings-row__when">{time}</span>{zone && <span className="recordings-row__zone">{' '}{zone}</span>}</>;
          })()}
        </span>
        <ChevronRight size={18} aria-hidden="true" className="recordings-row__chev" />
      </button>

      {expanded && <div className="rec-strip" id={stripId}>
        {list.map((r) => {
          // A failed recording is shown, not hidden (issue #276) — the user pressed Record and is owed
          // an explanation rather than an empty card. It has no video and no thumbnail, so it must not
          // request either: the server refuses to serve a non-ready row, and an <img> pointed at it
          // would just render a broken-image glyph.
          const failed = r.status === 'failed';
          // The name STARTS with the chip's own text (WCAG 2.5.3, label in name): a voice-control user says what they see
          // ("Sun 7:00 pm") and a name that opens with the camera does not match it. The camera and the full date follow,
          // so a screen-reader user still gets which camera and which day (the chip alone is a weekday for a week).
          const chip = failed ? 'Couldn’t be saved' : shortWhen(r.started_at, home);
          const fullLabel = `${chip}, ${r.camera_name || 'Camera'}, ${when(r.started_at, home)}`;
          return (
            <button
              key={r.id}
              type="button"
              className={`rec-strip__item${failed ? ' rec-strip__item--failed' : ''}`}
              onClick={() => setOpenId(r.id)}
              title={fullLabel}
              aria-label={fullLabel}
            >
              {failed ? (
                <span className="rec-strip__failed" aria-hidden="true"><AlertTriangle size={18} /></span>
              ) : (
                <>
                  <img src={api.url(`/recordings/${r.id}/thumb`)} alt="" loading="lazy" />
                  <span className="rec-strip__play"><Play size={16} aria-hidden="true" /></span>
                </>
              )}
              <span className="rec-strip__label" aria-hidden="true">{chip}</span>
            </button>
          );
        })}
      </div>}

      {/* A failed recording gets an explanation and a way to clear it — NOT the player, which would
          load a video that does not exist. Keeping it deletable is what stops failures accumulating
          on the card forever, since recordings have no automatic retention. */}
      {open && open.status === 'failed' && (
        <Modal title="Recording couldn’t be saved" onClose={close}>
          <p className="muted" style={{ marginTop: 0 }}>
            {open.camera_name || 'This camera'} · {when(open.started_at, home)}
          </p>
          <p>
            Nightlight started this recording but couldn’t finish saving it. That usually means the
            container restarted while the clip was still being assembled, or the camera stopped sending
            video partway through. There’s nothing to play.
            {!isAdmin && ' An admin can remove it from this list.'}
          </p>
          <ModalActions>
            <button type="button" className="btn btn-secondary" onClick={close} disabled={del === 'deleting'}>Close</button>
            {isAdmin && (
              <button type="button" className="btn btn-danger" onClick={deleteNow} disabled={del === 'deleting'}>
                {del === 'deleting' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </ModalActions>
          {del === 'error' && <p className="muted">{delError}</p>}
        </Modal>
      )}

      {open && open.status !== 'failed' && (
        <MediaPlayerModal
          title={`${open.camera_name || 'Recording'} · ${when(open.started_at, home)}`}
          videoPath={`/recordings/${open.id}/video`}
          posterPath={`/recordings/${open.id}/thumb`}
          filename={`${open.camera_name || 'recording'}-${open.id}.mp4`}
          meta={`${when(open.started_at, home)}${open.duration_s ? ` · ${open.duration_s}s` : ''}`}
          onClose={close}
          headerAction={
            isAdmin ? (
              <button type="button" className="icon-btn icon-btn--danger" aria-label="Delete recording"
                onClick={() => setDel('confirm')} disabled={del === 'deleting'}>
                <Trash2 size={17} />
              </button>
            ) : null
          }
          footer={
            confirming ? (
              <div className="clip-confirm">
                <span>{del === 'error' ? delError : 'Delete this recording? This can’t be undone.'}</span>
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
