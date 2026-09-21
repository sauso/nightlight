import { useEffect, useState } from 'react';
import { useDemoStatus } from '../lib/demoStatus.js';

const NIGHTLIGHT_URL = 'https://github.com/sauso/nightlight';

function minutesUntil(endsAt, now) {
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(endMs)) return null;
  return Math.max(0, Math.ceil((endMs - now) / 60000));
}

export default function DemoBanner() {
  const demo = useDemoStatus();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!demo) return undefined;
    // The label is minute-granular, so a 30-second tick keeps it accurate without waking a bedside
    // display every second. The extra half-minute also guarantees the ended state appears promptly.
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [demo]);

  if (!demo) return null;
  const minutes = minutesUntil(demo.endsAt, now);
  const ended = minutes === 0;

  return (
    <aside className="demo-banner" aria-label="Demo status">
      {ended ? (
        <>
          <span>{demo.lobbyUrl ? 'Demo ended —' : 'Demo ended'}</span>
          {demo.lobbyUrl && <a href={demo.lobbyUrl}>start again</a>}
        </>
      ) : (
        <>
          <span>Read-only demo — sample data, changes are disabled</span>
          {minutes !== null && <span>· ends in {minutes} min</span>}
        </>
      )}
      <span>·</span>
      <a href={NIGHTLIGHT_URL} target="_blank" rel="noreferrer">Get Nightlight</a>
    </aside>
  );
}

