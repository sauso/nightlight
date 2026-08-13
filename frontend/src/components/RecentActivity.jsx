import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AlertList from './AlertList.jsx';

// A compact "latest alerts" list for the Live screen — the quick cross-child glance that used to be
// the Alerts tab. Only polls while Live is on screen (LiveMonitor stays mounted all session). Full
// per-child history lives on each child's detail screen.
export default function RecentActivity({ active }) {
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    async function load() {
      try {
        const a = await api.get('/cameras/alerts');
        if (live) setAlerts((Array.isArray(a) ? a : []).slice(0, 4));
      } catch { /* ignore — leave as-is */ }
    }
    load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
  }, [active]);

  if (alerts.length === 0) return null;
  return (
    <>
      <div className="section-title">Recent activity</div>
      <AlertList alerts={alerts} />
    </>
  );
}
