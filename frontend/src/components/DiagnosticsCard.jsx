import { useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { api } from '../lib/api.js';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function download() {
    setBusy(true);
    setError('');
    try {
      const bundle = await api.get('/diagnostics');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nightlight-diagnostics-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err.message || 'Failed to build diagnostics');
    } finally {
      setBusy(false);
    }
  }

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
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" style={{ width: 'auto' }} onClick={download} disabled={busy}>
          <Download size={16} aria-hidden="true" />
          {busy ? 'Preparing…' : 'Download diagnostics'}
        </button>
        <a className="btn btn-secondary" style={{ width: 'auto' }} href={ISSUE_URL} target="_blank" rel="noreferrer">
          <ExternalLink size={16} aria-hidden="true" />
          Report an issue
        </a>
      </div>
    </div>
  );
}
