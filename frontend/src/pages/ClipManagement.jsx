import { useEffect, useMemo, useState } from 'react';
import { Zap, AudioLines, Play, Trash2 } from 'lucide-react';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Modal from '../components/Modal.jsx';
import ClipDatePicker from '../components/ClipDatePicker.jsx';
import { useHomeTime } from '../lib/useHomeTime.js';

// Admin Clip Management: browse every recorded clip, filter by day, and bulk-select + delete. Deleting
// removes the video only — the alert and its snapshot stay. Reachable from Settings (admin).
const TYPE = {
  motion: { label: 'Motion', Icon: Zap },
  sound: { label: 'Sound', Icon: AudioLines },
};
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
// The day key 'YYYY-MM-DD' is the HOME-zone calendar day (home.dayKey, #561) — shared by grouping, the
// filter, and the calendar picker. It used to be the browser's own local day, so one clip filed under a
// different day heading for two viewers (a phone twelve hours ahead of home saw a 23:30 clip as
// tomorrow's). In home time every viewer sees the same days, matching the sleep report's nights.

function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

export default function ClipManagement() {
  const [clips, setClips] = useState(null);
  const [error, setError] = useState('');
  const [selectedDays, setSelectedDays] = useState(() => new Set()); // empty = all days
  const [selected, setSelected] = useState(() => new Set());
  const [playing, setPlaying] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const home = useHomeTime();

  async function load() {
    try {
      // Slow-allowed (#556): returns up to 5000 rows (getClips caps there), which is a large body on a slow link.
      const rows = await api.get('/cameras/clips', { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      setClips(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(e.message || 'Failed to load clips');
      setClips([]);
    }
  }
  useEffect(() => { load(); }, []);

  // Group by HOME-zone calendar day (clips come newest-first, so groups stay in order). Keyed by the
  // stable 'YYYY-MM-DD' day key, carrying a display label for the section heading. The heading is a
  // plain date (no zone label): the label rides on each row's clock time below. `home` changes identity
  // only when the zone does (e.g. the real setting arriving after boot), so the groups rebuild then.
  const groups = useMemo(() => {
    const map = new Map();
    for (const c of clips || []) {
      const dt = parseUtc(c.created_at);
      const k = home.dayKey(dt);
      if (!map.has(k)) map.set(k, { label: home.dayLabel(k), rows: [] });
      map.get(k).rows.push(c);
    }
    return map;
  }, [clips, home]);

  const availableDays = useMemo(() => new Set(groups.keys()), [groups]);
  const filterActive = selectedDays.size > 0;
  const visible = useMemo(
    () => (clips || []).filter((c) => !filterActive || selectedDays.has(home.dayKey(parseUtc(c.created_at)))),
    [clips, selectedDays, filterActive, home]
  );
  function toggleDay(k) {
    setSelectedDays((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; });
  }
  const clearDays = () => setSelectedDays(new Set());
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
      // Slow-allowed (#556): the route deletes each clip file one by one, synchronously, so thousands take a while.
      await api.post('/cameras/clips/delete', { ids }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
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
          {availableDays.size > 0 && (
            <ClipDatePicker
              selected={selectedDays}
              onToggle={toggleDay}
              onClear={clearDays}
              availableDays={availableDays}
              labelFor={(k) => groups.get(k)?.label || k}
            />
          )}
        </div>

        {clips != null && clips.length === 0 && (
          <div className="empty-state" style={{ padding: 24 }}>
            No clips yet. Turn on “Save a clip when triggered” for a camera (under its Motion/Sound settings).
          </div>
        )}

        {visible.length > 0 && (
          <button type="button" className="clip-selectall" onClick={toggleAllVisible}>
            {allVisibleSelected ? 'Clear selection' : `Select all${filterActive ? ' shown' : ''}`}
          </button>
        )}

        {[...groups.entries()]
          .filter(([k]) => !filterActive || selectedDays.has(k))
          .map(([k, g]) => (
            <div key={k}>
              <div className="card tight">
                <div className="card-title">{g.label}</div>
                {g.rows.map((c) => {
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
                          {t.label} · {home.time(when, { hour: '2-digit', minute: '2-digit' })}
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
            {home.dateTime(parseUtc(playing.created_at))}{playing.clip_duration_s ? ` · ${playing.clip_duration_s}s` : ''}
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
