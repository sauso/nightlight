import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const ISOLATION_DOCS_URL = 'https://github.com/sauso/nightlight/blob/main/docs/operations.md#media-isolation';

// Settings -> Logs, admins only (the page is behind AdminProtected). Owner 2026-11-06: "Media isolation: on/off" sat in the About
// header, where it meant nothing to a caregiver and crowded the card; it lives here beside the other server diagnostics instead.
//
// #553: whether ffmpeg and MediaMTX run as a separate user. Shown only when the server says (an older server sends no field, and
// then there is no card). 'off' is not an error: it is the documented fallback on a host that cannot do it, or the operator's own
// kill switch (docs/operations.md, "Media isolation"). The loud warning for an off that was NOT asked for (`fallback`, `id-clash`)
// stays at the top of About, where an admin sees it first. A failed load shows nothing: this is an extra, never an error.
export default function ServerCard() {
  const [isolation, setIsolation] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/about')
      .then((info) => {
        if (live) setIsolation(info?.mediaIsolation === 'on' || info?.mediaIsolation === 'off' ? info.mediaIsolation : null);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  if (!isolation) return null;
  return (
    <div className="card">
      <div className="card-title">Server</div>
      <div className="list-row">
        <span>Media isolation</span>
        <span className="camera-tile__sub">{isolation === 'on' ? 'On' : 'Off'}</span>
      </div>
      <div className="camera-tile__sub" style={{ marginTop: 8 }}>
        Runs the camera programs (FFmpeg and MediaMTX) as a separate user, so a fault in one cannot read the database. Off is
        normal on a host that cannot support it.{' '}
        <a href={ISOLATION_DOCS_URL} target="_blank" rel="noreferrer">What this means</a>
      </div>
    </div>
  );
}
