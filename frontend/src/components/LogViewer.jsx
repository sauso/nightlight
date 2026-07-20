import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

export default function LogViewer() {
  const [lines, setLines] = useState([]);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
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

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

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
      {error && <div className="error-banner">{error}</div>}
      <pre className="log-viewer__box" ref={boxRef}>
        {lines.length === 0 ? 'No log activity yet since the app last started.' : lines.join('\n')}
      </pre>
      <div className="camera-tile__sub" style={{ marginTop: 6 }}>
        Shows recent activity in memory since the app last started - for anything
        older, use <code>docker logs nightlight</code>.
      </div>
    </div>
  );
}
