import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { api } from '../lib/api.js';
import { saveTextFile } from '../lib/nativeBridge.js';

// Where self-hosters file bugs. Prefilled with the bundle reminder so the attachment isn't forgotten.
const ISSUE_URL =
  'https://github.com/sauso/nightlight/issues/new?body=' +
  encodeURIComponent(
    '**What happened?**\n\n\n**What did you expect?**\n\n\n**Steps to reproduce**\n\n\n' +
    '---\n_Please attach the diagnostics bundle downloaded from Settings → Logs (drag the .json onto this box)._\n'
  );

// One-click "support bundle" for logging a defect. Pulls the redacted diagnostics JSON from the
// server and saves it as a file the user can attach to a GitHub issue. Nothing is uploaded from
// here — the download stays on their device so they can review it before sharing.
export default function DiagnosticsCard() {
  // idle → building the bundle → 'done' (held briefly so it can't be re-tapped while the phone is
  // still saving/opening the file — the flash-and-retry that produced several downloads before).
  const [state, setState] = useState('idle'); // 'idle' | 'busy' | 'done'
  const [error, setError] = useState('');
  const busyRef = useRef(false); // hard guard against double-submits regardless of render timing
  const doneTimer = useRef(null);

  useEffect(() => () => clearTimeout(doneTimer.current), []);

  async function download() {
    if (busyRef.current) return; // already preparing — ignore extra taps
    busyRef.current = true;
    setState('busy');
    setError('');
    try {
      const bundle = await api.get('/diagnostics');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `nightlight-diagnostics-${stamp}.json`;
      const text = JSON.stringify(bundle, null, 2);
      // Native app: write the file + open the OS share sheet (the WebView can't do a blob download).
      // Browser: fall back to a normal blob download.
      const handledNatively = await saveTextFile(filename, text);
      if (!handledNatively) {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      // Stay disabled and show a confirmation for a few seconds, so a slow save on mobile doesn't
      // look like nothing happened and invite repeat taps.
      setState('done');
      doneTimer.current = setTimeout(() => { setState('idle'); busyRef.current = false; }, 4000);
    } catch (err) {
      setError(err.message || 'Failed to build diagnostics');
      setState('idle');
      busyRef.current = false;
    }
  }

  const label = state === 'busy' ? 'Preparing…' : state === 'done' ? 'Downloaded ✓' : 'Download diagnostics';

  return (
    <div className="card">
      <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
        Hit a bug? Download a diagnostics bundle and attach it to a GitHub issue — it packages your
        version and build, host/runtime info, camera &amp; detection settings, live stream status,
        and recent logs into one file to help pin down the problem.{' '}
        <strong>No passwords or tokens are included</strong>, so you can open the file and review it
        before sharing.
      </div>
      {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn btn-primary" onClick={download} disabled={state !== 'idle'}>
          <Download size={16} aria-hidden="true" />
          {label}
        </button>
        <a className="btn btn-secondary" href={ISSUE_URL} target="_blank" rel="noreferrer">
          <ExternalLink size={16} aria-hidden="true" />
          Report an issue
        </a>
      </div>
    </div>
  );
}
