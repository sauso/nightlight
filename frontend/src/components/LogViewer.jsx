import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';
import Switch from './Switch.jsx';

// Quick-filter chips: each just sets the existing text filter to a substring that matches the log tag
// for that subsystem, so they need no new API surface and compose with the free-text box. Kept to the
// tags people actually reach for when something's off (a camera stream, an alert channel, MQTT).
const LOG_FILTERS = [
  { label: 'Errors', q: 'error' },
  { label: 'Warnings', q: 'warn' },
  { label: 'Motion', q: 'motion' },
  { label: 'ONVIF motion', q: 'onvif-motion' },
  { label: 'Sound', q: 'sound' },
  { label: 'MQTT', q: 'mqtt' },
  { label: 'WebRTC', q: 'webrtc' },
  { label: 'HLS', q: 'hls' },
  { label: 'Recording', q: 'clip' },
];

export default function LogViewer() {
  const [lines, setLines] = useState([]);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const boxRef = useRef(null);

  async function load() {
    try {
      const { lines: fresh } = await api.get('/logs');
      setLines(fresh);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  async function doClear() {
    setClearBusy(true);
    try {
      await api.del('/logs');
      setConfirming(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setClearBusy(false);
    }
  }

  // Case-insensitive substring match, applied client-side so it works on the
  // already-loaded buffer without any new API surface.
  const query = filter.trim().toLowerCase();
  const visibleLines = query ? lines.filter((l) => l.toLowerCase().includes(query)) : lines;

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [visibleLines.length]);

  return (
    <div className="log-viewer">
      <div className="log-viewer__toolbar">
        <label className="log-viewer__toggle">
          <Switch
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="icon-btn" onClick={load}>Refresh now</button>
          <button type="button" className="icon-btn" onClick={() => setConfirming(true)}>Clear log</button>
        </div>
      </div>

      {confirming && (
        <Modal title="Clear recent logs" placement="top" onClose={() => (clearBusy ? null : setConfirming(false))}>
          <p style={{ marginTop: 0 }}>
            Clear the recent logs shown here? This empties the in-app buffer (it doesn't affect{' '}
            <code>docker logs</code>) and can't be undone.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setConfirming(false)} disabled={clearBusy}>
              Cancel
            </button>
            <button className="btn btn-danger" type="button" onClick={doClear} disabled={clearBusy}>
              {clearBusy ? 'Clearing…' : 'Clear log'}
            </button>
          </div>
        </Modal>
      )}
      <div className="log-viewer__chips">
        {LOG_FILTERS.map((f) => (
          <button
            key={f.q}
            type="button"
            className={`log-chip${query === f.q ? ' log-chip--active' : ''}`}
            onClick={() => setFilter(query === f.q ? '' : f.q)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="log-viewer__filter-row">
        <input
          type="search"
          className="log-viewer__filter"
          placeholder="Filter logs, e.g. a camera name or ERROR"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {query && (
          <span className="camera-tile__sub log-viewer__filter-count">
            {visibleLines.length} of {lines.length}
          </span>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}
      <pre className="log-viewer__box" ref={boxRef}>
        {lines.length === 0
          ? 'No log activity yet since the app last started.'
          : visibleLines.length === 0
            ? 'Nothing matches that filter.'
            : visibleLines.join('\n')}
      </pre>
      <div className="camera-tile__sub" style={{ marginTop: 6 }}>
        Shows recent activity in memory since the app last started - for anything
        older, use <code>docker logs nightlight</code>.
      </div>
    </div>
  );
}
