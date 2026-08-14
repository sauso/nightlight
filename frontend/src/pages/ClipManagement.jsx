import { useEffect, useMemo, useState } from 'react';
import { Zap, AudioLines, Play, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Modal from '../components/Modal.jsx';

// Admin Clip Management: browse every recorded clip, filter by day, and bulk-select + delete. Deleting
// removes the video only — the alert and its snapshot stay. Reachable from Settings (admin).
const TYPE = {
  motion: { label: 'Motion', Icon: Zap },
  sound: { label: 'Sound', Icon: AudioLines },
};
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

export default function ClipManagement() {
  const [clips, setClips] = useState(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState('all');
  const [selected, setSelected] = useState(() => new Set());
  const [playing, setPlaying] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const rows = await api.get('/cameras/clips');
      setClips(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(e.message || 'Failed to load clips');
      setClips([]);
    }
  }
  useEffect(() => { load(); }, []);

  // Group by local calendar day (clips come newest-first, so groups stay in order).
  const groups = useMemo(() => {
    const map = new Map();
    for (const c of clips || []) {
      const key = parseUtc(c.created_at).toLocaleDateString();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    return map;
  }, [clips]);

  const days = useMemo(() => [...groups.keys()], [groups]);
  const visible = useMemo(
    () => (clips || []).filter((c) => day === 'all' || parseUtc(c.created_at).toLocaleDateString() === day),
    [clips, day]
  );
  const totalBytes = (clips || []).reduce((n, c) => n + (c.clip_bytes || 0), 0);

  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.id));
  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach((c) => next.delete(c.id));
      else visible.forEach((c) => next.add(c.id));
      return next;
    });
  }

  async function deleteSelected() {
    setBusy(true);
    try {
      const ids = [...selected];
      await api.post('/cameras/clips/delete', { ids });
      setSelected(new Set());
      setConfirming(false);
      await load();
    } catch (e) {
      setError(e.message || 'Failed to delete clips');
    } finally {
      setBusy(false);
    }
  }

  const selCount = selected.size;

  return (
    <>
      <AppHeader title="Clip Management" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main" style={{ paddingBottom: selCount ? 84 : undefined }}>
        {error && <div className="error-banner">{error}</div>}

        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div className="camera-tile__sub">
            {clips == null ? 'Loading…' : `${clips.length} clip${clips.length === 1 ? '' : 's'}${totalBytes ? ` · ${fmtBytes(totalBytes)}` : ''}`}
          </div>
          {days.length > 0 && (
            <select className="clip-day-select" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Filter by date">
              <option value="all">All dates</option>
              {days.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </div>

        {clips != null && clips.length === 0 && (
          <div className="empty-state" style={{ padding: 24 }}>
            No clips yet. Turn on “Save a clip when triggered” for a camera (under its Motion/Sound settings).
          </div>
        )}

        {visible.length > 0 && (
          <button type="button" className="clip-selectall" onClick={toggleAllVisible}>
            {allVisibleSelected ? 'Clear selection' : `Select all${day === 'all' ? '' : ' on this day'}`}
          </button>
        )}

        {[...groups.entries()]
          .filter(([d]) => day === 'all' || d === day)
          .map(([d, rows]) => (
            <div key={d}>
              <div className="section-title">{d}</div>
              <div className="card tight">
                {rows.map((c) => {
                  const t = TYPE[c.type] || { label: c.type, Icon: Zap };
                  const Icon = t.Icon;
                  const when = parseUtc(c.created_at);
                  const checked = selected.has(c.id);
                  return (
                    <div key={c.id} className={`clip-row${checked ? ' clip-row--sel' : ''}`}>
                      <label className="clip-row__check">
                        <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} aria-label="Select clip" />
                      </label>
                      <button type="button" className="clip-row__thumbwrap" onClick={() => setPlaying(c)}
                        aria-label={`Play clip from ${c.camera_name}`}>
                        {c.snapshot
                          ? <img className="clip-row__thumb" src={api.url(`/cameras/alerts/${c.id}/snapshot`)} alt="" loading="lazy" />
                          : <span className="clip-row__thumb clip-row__thumb--empty"><Icon size={15} /></span>}
                        <span className="alert-item__play" aria-hidden="true"><Play size={14} fill="currentColor" /></span>
                      </button>
                      <div className="clip-row__body" onClick={() => setPlaying(c)}>
                        <div className="clip-row__name">{c.camera_name}</div>
                        <div className="clip-row__meta">
                          <Icon size={13} className="alert-item__ico" aria-hidden="true" />
                          {t.label} · {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          {c.clip_duration_s ? ` · ${c.clip_duration_s}s` : ''}{c.clip_bytes ? ` · ${fmtBytes(c.clip_bytes)}` : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
      </main>

      {selCount > 0 && (
        <div className="clip-actionbar">
          <span>{selCount} selected</span>
          <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
            <Trash2 size={16} aria-hidden="true" /> Delete
          </button>
        </div>
      )}

      {playing && (
        <Modal title={`${playing.camera_name} · ${(TYPE[playing.type] || {}).label || playing.type}`} onClose={() => setPlaying(null)}>
          <video className="clip-player" src={api.url(`/cameras/alerts/${playing.id}/clip`)}
            poster={playing.snapshot ? api.url(`/cameras/alerts/${playing.id}/snapshot`) : undefined}
            controls autoPlay playsInline />
          <div className="clip-player__meta">
            {parseUtc(playing.created_at).toLocaleString()}{playing.clip_duration_s ? ` · ${playing.clip_duration_s}s` : ''}
          </div>
        </Modal>
      )}

      {confirming && (
        <Modal title="Delete clips" placement="top" onClose={() => (busy ? null : setConfirming(false))}>
          <p style={{ marginTop: 0 }}>
            Delete <strong>{selCount} clip{selCount === 1 ? '' : 's'}</strong>? This removes the video files; the
            alerts and their snapshots stay. It can’t be undone.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-danger" type="button" onClick={deleteSelected} disabled={busy}>
              {busy ? 'Deleting…' : `Delete ${selCount}`}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
