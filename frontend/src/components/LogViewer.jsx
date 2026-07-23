import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

export default function LogViewer() {
  const [lines, setLines] = useState([]);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState('');
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
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh
        </label>
        <button type="button" className="icon-btn" onClick={load}>Refresh now</button>
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
