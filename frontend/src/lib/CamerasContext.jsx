import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const CamerasContext = createContext(null);

// How many consecutive failed polls (15s apart) before we consider this a genuine
// outage rather than a one-off network blip - roughly 45s of being unreachable.
const OUTAGE_THRESHOLD = 3;

export function CamerasProvider({ children }) {
  const [kids, setKids] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [error, setError] = useState('');
  const failureCountRef = useRef(0);
  const wasDownRef = useRef(false);

  async function load() {
    try {
      const [k, cams] = await Promise.all([api.get('/children'), api.get('/cameras')]);
      setKids(k);
      setCameras(cams);
      setError('');
      if (wasDownRef.current) {
        // The backend was unreachable for an extended stretch (e.g. a power outage)
        // and has just come back. A full reload re-establishes every camera
        // connection cleanly from scratch, rather than leaving things sitting on
        // whatever stale "connection lost" state they were in when it went down -
        // important for something like this that might be unattended overnight.
        window.location.reload();
        return;
      }
      failureCountRef.current = 0;
    } catch (err) {
      setError(err.message);
      failureCountRef.current += 1;
      if (failureCountRef.current >= OUTAGE_THRESHOLD) {
        wasDownRef.current = true;
      }
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000); // refresh live/offline status periodically
    return () => clearInterval(interval);
  }, []);

  return (
    <CamerasContext.Provider value={{ kids, cameras, error, refresh: load }}>
      {children}
    </CamerasContext.Provider>
  );
}

export function useCameras() {
  return useContext(CamerasContext);
}
