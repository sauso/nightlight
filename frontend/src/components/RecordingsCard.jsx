import { useEffect, useRef, useState } from 'react';
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
// moments a person chose to keep, not detections. Renders nothing until the first recording exists,
// unless more older recordings are available after local deletes (#1112, Codex plan review 2026-11-16).
//
// It is drawn like the "Recent alerts" card next to it (owner, 2026-11-15: "make recordings look like recent alerts"): a titled
// card, one row per recording with a thumbnail, the camera and the time, the newest THREE shown and a "See all recordings"
// row for the rest. It reuses AlertList's classes on purpose, so the two cards cannot drift apart. Every row is a button,
// because every recording opens something (the player, or for a failed one the explanation), which is the opposite of an
// alert row, where only one with a clip is. There is no recordings page to go to. Expanding shows the loaded
// rows; Show older recordings requests the next page (#1112, Codex plan review 2026-11-16).
//
// Unlike alert clips, recordings have NO automatic retention, so deleting is the only way to reclaim
// the space — hence the delete action here. It is an ADMIN's action (#552; the server refuses a
// caregiver, owner decision 2026-10-10), the same as TimelapseCard: a caregiver can watch and download
// every recording, and a failed entry tells them an admin can clear it.

const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const PREVIEW_COUNT = 3;
const PAGE_SIZE = 50;
const EARLIER_DAY = { weekday: 'short', day: 'numeric', month: 'short' };

// Rendered in HOME time (settings.timezone), with a zone label when the viewer's device is elsewhere
// (#561): a recording's "3:12 AM" must be the same moment for everyone looking at this child.
const WHEN = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
function when(startedAt, home) {
  const d = parseUtc(startedAt);
  if (Number.isNaN(d.getTime())) return startedAt;
  return home.time(d, WHEN);
}

export default function RecordingsCard({ childId, refreshNonce = 0 }) {
  const [list, setList] = useState([]);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const generation = useRef(0);
  const pageInFlight = useRef(false);
  const cursor = useRef(null);
  const [openId, setOpenId] = useState(null);
  const [del, setDel] = useState(''); // '' | 'confirm' | 'deleting' | 'error'
  const [delError, setDelError] = useState('');
  // Reset by the child page keying this card by child, so "See all" never carries from one child to the next.
  const [showAll, setShowAll] = useState(false);
  const { user } = useAuth() || {};
  const isAdmin = user?.role === 'admin';
  const home = useHomeTime();

  useEffect(() => {
    // #1112, Codex plan review 2026-11-16: refreshNonce resets to page one and
    // discards older pages; ChildDetail does not pass this prop yet.
    const current = ++generation.current;
    pageInFlight.current = false;
    cursor.current = null;
    setList([]);
    setMore(false);
    setLoadingMore(false);
    setMoreError('');
    setShowAll(false);
    api
      .get(`/recordings/child/${childId}`)
      .then((rows) => {
        if (generation.current !== current) return;
        const page = Array.isArray(rows) ? rows : [];
        setList(page);
        setMore(page.length >= PAGE_SIZE);
        cursor.current = page.at(-1) || null;
      })
      .catch(() => {});
    return () => { generation.current++; pageInFlight.current = false; };
  }, [childId, refreshNonce]);

  async function loadMore() {
    if (pageInFlight.current || !more || !cursor.current) return;
    // #1112, Codex plan review 2026-11-16: a ref locks double clicks synchronously;
    // the generation drops pages returned after refresh, child change or unmount.
    pageInFlight.current = true;
    const current = generation.current;
    const last = cursor.current;
    setLoadingMore(true);
    setMoreError('');
    try {
      const page = await api.get(`/recordings/child/${childId}?before_created_at=${encodeURIComponent(last.created_at)}&before_id=${encodeURIComponent(last.id)}`);
      if (generation.current !== current) return;
      const rows = Array.isArray(page) ? page : [];
      setList((loaded) => {
        const ids = new Set(loaded.map((row) => row.id));
        // #1112, Codex plan review 2026-11-16: dedupe both against loaded rows
        // and within a page, while retaining the server's order.
        return [...loaded, ...rows.filter((row) => {
          if (ids.has(row.id)) return false;
          ids.add(row.id);
          return true;
        })];
      });
      setMore(rows.length >= PAGE_SIZE);
      if (rows.length) cursor.current = rows.at(-1);
    } catch {
      if (generation.current === current) setMoreError('Couldn’t load older recordings — try again.');
    } finally {
      if (generation.current === current) {
        pageInFlight.current = false;
        setLoadingMore(false);
      }
    }
  }

  if (!list.length && !more) return null;
  const open = list.find((r) => r.id === openId) || null;
  const hasMore = list.length > PREVIEW_COUNT;
  // The list is newest first (the server orders it), so the first three are the newest.
  const shown = hasMore && !showAll ? list.slice(0, PREVIEW_COUNT) : list;
  // The same rule as AlertList: today is the time alone, an earlier day carries its day ("Wed, 11 Nov, 3:12 AM"), because three
  // newest recordings can span several quiet days and recordings have no retention, so old ones are normal.
  const clock = (d) => (home.dayKey(d) === home.todayKey() ? home.time(d) : `${home.day(d, EARLIER_DAY)}, ${home.time(d)}`);

  function close() {
    setDel('');
    setOpenId(null);
  }

  async function deleteNow() {
    setDel('deleting');
    try {
      await api.del(`/recordings/${open.id}`);
      close();
      // #1112, Codex plan review 2026-11-16: keep paged-in rows and the last
      // server cursor, even if the deleted row was that cursor.
      setList((loaded) => loaded.filter((row) => row.id !== open.id));
    } catch (err) {
      // The failed entry's modal and the player word a retry differently, so each passes its own fallback.
      setDelError(deleteFailureText(err, open.status === 'failed' ? 'Couldn’t remove it — try again.' : 'Couldn’t delete — try again.'));
      setDel('error');
    }
  }

  const confirming = del === 'confirm' || del === 'deleting' || del === 'error';

  return (
    <>
      <div className="card tight alert-list">
        {/* The text is its own <span> so it stays a leaf element, as in AlertList (the docs-screenshot run finds headings by their text). */}
        <div className="card-title alert-list__title"><Video size={16} aria-hidden="true" /><span>Recordings</span></div>
        {shown.map((r) => {
          // A failed recording is shown, not hidden (issue #276) — the user pressed Record and is owed
          // an explanation rather than an empty card. It has no video and no thumbnail, so it must not
          // request either: the server refuses to serve a non-ready row, and an <img> pointed at it
          // would just render a broken-image glyph.
          const failed = r.status === 'failed';
          const started = parseUtc(r.started_at);
          // A null or unparsable timestamp must not throw (toISOString on an Invalid Date is a RangeError, which would blank the
          // whole page): the row is drawn without a time instead, as AlertList does.
          const hasTime = !Number.isNaN(started.getTime());
          const timeText = hasTime ? clock(started) : '';
          const camera = r.camera_name || 'Camera';
          const duration = !failed && r.duration_s ? `${hasTime ? ' · ' : ''}${r.duration_s}s` : '';
          // A failed row names the problem on its first line and moves the camera down to the second, next to the time, so the
          // user still learns which camera it was.
          const nameText = failed ? 'Couldn’t be saved' : camera;
          const metaText = failed ? `${camera}${hasTime ? ' · ' : ''}${timeText}` : `${timeText}${duration}`;
          return (
            // The name STARTS with the text printed on the row (WCAG 2.5.3, label in name): a voice-control user says what they
            // see ("Child B Room") and a name that opens with a verb does not match it. The tooltip is the full home-time date.
            <button
              key={r.id}
              type="button"
              className="alert-item alert-item--btn"
              onClick={() => setOpenId(r.id)}
              title={when(r.started_at, home)}
              aria-label={`${nameText}, ${metaText}`}
            >
              <span className="alert-item__thumbwrap">
                {failed ? (
                  <span className="alert-item__thumb alert-item__thumb--empty alert-item__thumb--failed" aria-hidden="true"><AlertTriangle size={18} /></span>
                ) : (
                  <>
                    <img className="alert-item__thumb" src={api.url(`/recordings/${r.id}/thumb`)} alt="" loading="lazy" />
                    <span className="alert-item__play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
                  </>
                )}
              </span>
              <span className="alert-item__body">
                <span className="alert-item__name">
                  <Video size={16} className="alert-item__ico" aria-hidden="true" />
                  <span className="alert-item__nametext">{nameText}</span>
                </span>
                <span className="alert-item__meta">
                  {failed && `${camera}${hasTime ? ' · ' : ''}`}
                  {hasTime && (
                    <time className="alert-item__time" dateTime={started.toISOString()}>{timeText}</time>
                  )}
                  {duration}
                </span>
              </span>
              <ChevronRight size={18} className="alert-item__chev" aria-hidden="true" />
            </button>
          );
        })}
        {hasMore && (
          <button type="button" className="alert-list__more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : 'See all recordings'}
          </button>
        )}
        {more && (showAll || !hasMore) && (
          <button type="button" className="alert-list__more" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? 'Loading older recordings…' : 'Show older recordings'}
          </button>
        )}
        {moreError && <p className="muted">{moreError}</p>}
      </div>

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
    </>
  );
}
