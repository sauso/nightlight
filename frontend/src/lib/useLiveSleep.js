import { useEffect, useState } from 'react';
import { api } from './api.js';

// Children list sleep: the detail card refreshes a running night, while the list reads once per visit.
export function useLiveSleep(childId, { refreshMs = 3 * 60 * 1000 } = {}) {
  const [data, setData] = useState(undefined); // undefined = loading; null = failed

  useEffect(() => {
    let alive = true;
    const load = () => api.get(`/children/${childId}/sleep/live`)
      .then((r) => { if (alive) setData(r || null); })
      .catch(() => { if (alive) setData(null); });
    load();
    const timer = refreshMs == null ? null : setInterval(load, refreshMs);
    return () => { alive = false; if (timer != null) clearInterval(timer); };
  }, [childId, refreshMs]);

  return data;
}
