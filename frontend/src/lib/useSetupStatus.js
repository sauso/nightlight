import { useEffect, useState } from 'react';
import { setupApi } from './setupApi.js';

export default function useSetupStatus(enabled) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let revision = 0;
    const read = () => {
      // WHY: a slow initial read must not restore a stale row after a setup change.
      const request = ++revision;
      setupApi.read().then((state) => {
        if (alive && request === revision) setStatus(state.status);
      }).catch(() => { if (alive && request === revision) setStatus(null); });
    };
    const changed = () => read();
    read();
    window.addEventListener('setup-state-changed', changed);
    return () => { alive = false; window.removeEventListener('setup-state-changed', changed); };
  }, [enabled]);
  return status;
}
