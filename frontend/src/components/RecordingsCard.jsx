import { useCallback, useEffect, useState } from 'react';
import { Play, Video, Trash2, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api.js';
import MediaPlayerModal from './MediaPlayerModal.jsx';
import Modal from './Modal.jsx';

// "Recordings" card on a child's detail page: the clips someone captured with the tile's Record button
// (see lib/recordings.js). Deliberately its own card rather than entries in the alert feed — these are
// moments a person chose to keep, not detections. Renders nothing until the first recording exists.
//
// Unlike alert clips, recordings have NO automatic retention, so deleting is the only way to reclaim
// the space — hence the delete action here.

const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

function when(startedAt) {
  const d = parseUtc(startedAt);
  if (Number.isNaN(d.getTime())) return startedAt;
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function RecordingsCard({ childId, refreshNonce = 0 }) {
  const [list, setList] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [del, setDel] = useState(''); // '' | 'confirm' | 'deleting' | 'error'

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
    } catch {
      setDel('error');
    }
  }

  const confirming = del === 'confirm' || del === 'deleting' || del === 'error';

  return (
    <div className="card">
      <div className="card-title">
        <Video size={16} aria-hidden="true" /> Recordings
      </div>

      <div className="rec-strip">
        {list.map((r) => {
          // A failed recording is shown, not hidden (issue #276) — the user pressed Record and is owed
          // an explanation rather than an empty card. It has no video and no thumbnail, so it must not
          // request either: the server refuses to serve a non-ready row, and an <img> pointed at it
          // would just render a broken-image glyph.
          const failed = r.status === 'failed';
          return (
            <button
              key={r.id}
              type="button"
              className={`rec-strip__item${failed ? ' rec-strip__item--failed' : ''}`}
              onClick={() => setOpenId(r.id)}
              title={
                failed
                  ? `${r.camera_name || 'Camera'} · ${when(r.started_at)} · couldn’t be saved`
                  : `${r.camera_name || 'Camera'} · ${when(r.started_at)}`
              }
            >
              {failed ? (
                <span className="rec-strip__failed" aria-hidden="true"><AlertTriangle size={18} /></span>
              ) : (
                <>
                  <img src={api.url(`/recordings/${r.id}/thumb`)} alt="" loading="lazy" />
                  <span className="rec-strip__play"><Play size={16} aria-hidden="true" /></span>
                </>
              )}
              <span>{failed ? 'Couldn’t be saved' : when(r.started_at)}</span>
            </button>
          );
        })}
      </div>

      {/* A failed recording gets an explanation and a way to clear it — NOT the player, which would
          load a video that does not exist. Keeping it deletable is what stops failures accumulating
          on the card forever, since recordings have no automatic retention. */}
      {open && open.status === 'failed' && (
        <Modal title="Recording couldn’t be saved" onClose={close}>
          <p className="muted" style={{ marginTop: 0 }}>
            {open.camera_name || 'This camera'} · {when(open.started_at)}
          </p>
          <p>
            Nightlight started this recording but couldn’t finish saving it. That usually means the
            container restarted while the clip was still being assembled, or the camera stopped sending
            video partway through. There’s nothing to play.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={close} disabled={del === 'deleting'}>Close</button>
            <button type="button" className="btn btn-danger" onClick={deleteNow} disabled={del === 'deleting'}>
              {del === 'deleting' ? 'Removing…' : 'Remove'}
            </button>
          </div>
          {del === 'error' && <p className="muted">Couldn’t remove it — try again.</p>}
        </Modal>
      )}

      {open && open.status !== 'failed' && (
        <MediaPlayerModal
          title={`${open.camera_name || 'Recording'} · ${when(open.started_at)}`}
          videoPath={`/recordings/${open.id}/video`}
          posterPath={`/recordings/${open.id}/thumb`}
          filename={`${open.camera_name || 'recording'}-${open.id}.mp4`}
          meta={`${when(open.started_at)}${open.duration_s ? ` · ${open.duration_s}s` : ''}`}
          onClose={close}
          headerAction={
            <button type="button" className="icon-btn icon-btn--danger" aria-label="Delete recording"
              onClick={() => setDel('confirm')} disabled={del === 'deleting'}>
              <Trash2 size={17} />
            </button>
          }
          footer={
            confirming ? (
              <div className="clip-confirm">
                <span>{del === 'error' ? 'Couldn’t delete — try again.' : 'Delete this recording? This can’t be undone.'}</span>
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
