import { useEffect, useMemo, useState } from 'react';
import { Zap, AudioLines, Play, Trash2, Lock } from 'lucide-react';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Modal from '../components/Modal.jsx';
import ClipDatePicker from '../components/ClipDatePicker.jsx';
import LoadFailed from '../components/LoadFailed.jsx';
import { loadState } from '../lib/loadState.js';
import { useHomeTime } from '../lib/useHomeTime.js';
import ClipPlayerModal from '../components/ClipPlayerModal.jsx';
import WakeClipPlayerModal from '../components/WakeClipPlayerModal.jsx';
import { ProtectedBadge } from '../components/ClipProtection.jsx';

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
  const [error, setError] = useState(''); // the LIST request's failure
  const [actionError, setActionError] = useState(''); // a delete's failure
  const [protectedError, setProtectedError] = useState('');
  const [actionNote, setActionNote] = useState('');
  const [protectedItems, setProtectedItems] = useState([]);
  const [protectedLoaded, setProtectedLoaded] = useState(false);
  const [selectedDays, setSelectedDays] = useState(() => new Set()); // empty = all days
  const [selected, setSelected] = useState(() => new Set());
  const [playing, setPlaying] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const home = useHomeTime();

  async function load() {
    try {
      // Slow-allowed (#556): returns up to 2000 rows (getClips caps there), which is a large body on a slow link.
      const rows = await api.get('/cameras/clips', { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      const fresh = Array.isArray(rows) ? rows : [];
      setClips(fresh);
      // A clip can be protected elsewhere while this page stays open. A refresh must drop its
      // selected id before a bulk-delete confirmation can include it (#932).
      setSelected((prev) => {
        const next = new Set([...prev].filter((id) => fresh.some((clip) => clip.id === id && !clip.protected)));
        return next.size === prev.size ? prev : next;
      });
      setError('');
    } catch (e) {
      // `clips` stays null on a first failure: it used to become [], which rendered "0 clips" and "No clips
      // yet. Turn on 'Save a clip...'" under the error banner - an outage worded as an unconfigured install
      // (#375). A reload that fails after a good load keeps the list it had.
      setError(e.message || 'Failed to load clips');
    }
  }
  async function loadProtected() {
    try {
      // The ordinary clip list is capped, and Sleep Detail reaches back only 30 days. Keep every
      // protected clip findable even after it drops out of both recent lists (#932).
      const rows = await api.get('/cameras/clips/protected', { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      setProtectedItems([
        ...(rows.alerts || []).map((clip) => ({ kind: 'alert', clip })),
        ...(rows.wake || []).map((clip) => ({ kind: 'wake', clip })),
      ].sort((a, b) => parseUtc(b.clip.created_at).getTime() - parseUtc(a.clip.created_at).getTime()));
      setProtectedError('');
    } catch (e) {
      setProtectedError(e.message || 'Couldn’t load protected clips.');
    } finally {
      setProtectedLoaded(true);
    }
  }
  useEffect(() => { load(); loadProtected(); }, []);

  // A change of HOME ZONE after mount (the real setting arriving and replacing the placeholder 'UTC', or an
  // admin changing it) re-buckets every clip into different days. `selectedDays` holds day KEYS of the old
  // zone and `selected` holds ids picked from a list grouped under them, so both would now describe a
  // screen that no longer exists: a day filter naming the wrong days, and — worse — a clip hidden by the
  // new grouping that is still in `selected` and would be sent by Delete without being visible (Codex
  // review of #561). Clear both rather than translate them. An empty set is returned as the SAME object so
  // the mount-time run (and any run with nothing chosen) causes no extra render.
  useEffect(() => {
    setSelectedDays((prev) => (prev.size ? new Set() : prev));
    setSelected((prev) => (prev.size ? new Set() : prev));
  }, [home.zone]);

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

  // Protected clips must never enter a bulk-delete request, including via Select all shown (#932).
  const selectableVisible = visible.filter((c) => !c.protected);
  const eligibleSelected = [...selected].filter((id) => clips?.some((clip) => clip.id === id && !clip.protected));
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((c) => selected.has(c.id));
  function toggle(id) {
    if (clips?.find((c) => c.id === id)?.protected) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) selectableVisible.forEach((c) => next.delete(c.id));
      else selectableVisible.forEach((c) => next.add(c.id));
      return next;
    });
  }

  async function deleteSelected() {
    setBusy(true);
    setActionError('');
    setActionNote('');
    try {
      const ids = eligibleSelected;
      // Slow-allowed (#556): the route deletes each clip file one by one, synchronously, so thousands take a while.
      const result = await api.post('/cameras/clips/delete', { ids }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      if (result?.skipped_protected > 0) setActionNote(`${result.skipped_protected} protected clip${result.skipped_protected === 1 ? ' was' : 's were'} kept`);
      setSelected(new Set());
      setConfirming(false);
      await load();
    } catch (e) {
      setActionError(e.message || 'Failed to delete clips');
    } finally {
      setBusy(false);
    }
  }

  function protectedChanged(kind, id, value) {
    setProtectedItems((prev) => prev.filter((item) => item.kind !== kind || item.clip.id !== id || value));
    if (kind === 'alert') {
      setClips((prev) => prev?.map((clip) => clip.id === id ? { ...clip, protected: value } : clip));
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      if (!value) load();
    }
    if (value) loadProtected();
  }

  const selCount = eligibleSelected.length;
  const listState = loadState({ loaded: clips != null, error, count: clips ? clips.length : 0 });

  return (
    <>
      <AppHeader title="Clip Management" back={{ to: '/settings/camera-recording', label: 'Camera and Recording' }} />
      <main className="app-main" style={{ paddingBottom: selCount ? 84 : undefined }}>
        {listState === 'error' && <LoadFailed what="clips" error={error} onRetry={load} />}
        {listState === 'stale' && <LoadFailed what="clips" error={error} onRetry={load} stale />}
        {/* A failed delete/clear is not a failed LIST: it has no Retry, and the list stays as it was. */}
        {actionError && <div className="error-banner">{actionError}</div>}
        {protectedError && !error && <div className="error-banner">Couldn’t load protected clips: {protectedError}</div>}
        {actionNote && <div className="camera-tile__sub" role="status">{actionNote}</div>}

        {protectedItems.length > 0 && <div className="card tight">
          <div className="card-title">Protected</div>
          {protectedItems.map(({ kind, clip }) => {
            const isWake = kind === 'wake';
            const when = parseUtc(clip.created_at);
            const label = isWake ? 'Wake-up clip' : (TYPE[clip.type]?.label || clip.type);
            const thumbPath = isWake ? `/recordings/${clip.id}/thumb` : `/cameras/alerts/${clip.id}/snapshot`;
            const size = isWake ? clip.bytes : clip.clip_bytes;
            return <div key={`${kind}-${clip.id}`} className="clip-row">
              <button type="button" className="clip-row__thumbwrap" onClick={() => setPlaying({ kind, clip })}
                aria-label={`Play protected ${isWake ? 'wake-up' : 'alert'} clip from ${clip.camera_name}`}>
                {(isWake || clip.snapshot)
                  ? <img className="clip-row__thumb" src={api.url(thumbPath)} alt="" loading="lazy" />
                  : <span className="clip-row__thumb clip-row__thumb--empty"><Lock size={15} aria-hidden="true" /></span>}
                <span className="alert-item__play" aria-hidden="true"><Play size={14} fill="currentColor" /></span>
              </button>
              <div className="clip-row__body" onClick={() => setPlaying({ kind, clip })}>
                <div className="clip-row__name">{clip.camera_name}</div>
                <div className="clip-row__meta"><ProtectedBadge /> {label}{isWake && clip.child_name ? ` · ${clip.child_name}` : ''}
                  {' · '}{home.dateTime(when)}{size ? ` · ${fmtBytes(size)}` : ''}</div>
              </div>
            </div>;
          })}
        </div>}

        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div className="camera-tile__sub">
            {/* Protected alerts also appear below; this header counts the plain day list once. */}
            {clips == null ? (listState === 'error' ? '' : 'Loading…') : `${clips.length} clip${clips.length === 1 ? '' : 's'}${totalBytes ? ` · ${fmtBytes(totalBytes)}` : ''}`}
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

        {listState === 'empty' && protectedLoaded && !protectedError && protectedItems.length === 0 && (
          <div className="empty-state" style={{ padding: 24 }}>
            No clips yet. Turn on “Save a clip when triggered” for a camera (under its Motion/Sound settings).
          </div>
        )}

        {selectableVisible.length > 0 && (
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
                  const checked = !c.protected && selected.has(c.id);
                  return (
                    <div key={c.id} className={`clip-row${checked ? ' clip-row--sel' : ''}`}>
                      <label className="clip-row__check">
                        <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} aria-label="Select clip"
                          disabled={!!c.protected} title={c.protected ? 'Unprotect to select' : undefined} />
                      </label>
                      <button type="button" className="clip-row__thumbwrap" onClick={() => setPlaying({ kind: 'alert', clip: c })}
                        aria-label={`Play clip from ${c.camera_name}`}>
                        {c.snapshot
                          ? <img className="clip-row__thumb" src={api.url(`/cameras/alerts/${c.id}/snapshot`)} alt="" loading="lazy" />
                          : <span className="clip-row__thumb clip-row__thumb--empty"><Icon size={15} /></span>}
                        <span className="alert-item__play" aria-hidden="true"><Play size={14} fill="currentColor" /></span>
                      </button>
                      <div className="clip-row__body" onClick={() => setPlaying({ kind: 'alert', clip: c })}>
                        <div className="clip-row__name">{c.camera_name}</div>
                        <div className="clip-row__meta">
                          <Icon size={13} className="alert-item__ico" aria-hidden="true" />
                          {t.label} · {home.time(when, { hour: '2-digit', minute: '2-digit' })}
                          {c.clip_duration_s ? ` · ${c.clip_duration_s}s` : ''}{c.clip_bytes ? ` · ${fmtBytes(c.clip_bytes)}` : ''}
                           {!!c.protected && <ProtectedBadge />}
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

      {playing?.kind === 'alert' && <ClipPlayerModal key={`alert-${playing.clip.id}`} ev={playing.clip}
        onClose={() => setPlaying(null)} onProtectedChange={(id, value) => protectedChanged('alert', id, value)} />}
      {playing?.kind === 'wake' && <WakeClipPlayerModal key={`wake-${playing.clip.id}`} clip={playing.clip}
        onClose={() => setPlaying(null)} onProtectedChange={(id, value) => protectedChanged('wake', id, value)} />}

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
