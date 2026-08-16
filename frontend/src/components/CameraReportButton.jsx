import { useRef, useState } from 'react';
import { FileText, ExternalLink } from 'lucide-react';
import { api } from '../lib/api.js';
import { isNativeApp, saveToDownloads, saveTextFile } from '../lib/nativeBridge.js';

// Where to send an unsupported-camera report. Title/body prefilled so the attachment + the one thing
// we always need (make/model) aren't forgotten.
const ISSUE_URL =
  'https://github.com/sauso/nightlight/issues/new?title=' +
  encodeURIComponent('Add support for camera: <make / model>') +
  '&body=' +
  encodeURIComponent(
    '**Camera make / model:**\n\n\n**What happens when you try to add it?**\n\n\n' +
    '---\n_Please attach the camera report downloaded from the Add camera screen (drag the .json ' +
    'onto this box). It has the stream codecs + ONVIF details and no password._\n'
  );

// Shown on the add/edit-camera screen when a probe or stream check fails. Builds a redacted
// diagnostic report for the entered camera (POST /cameras/probe-report) and saves it as a file the
// user can attach to a GitHub issue so support can be added. Nothing is uploaded from here — the file
// stays on their device (same review-before-sharing model as the diagnostics bundle).
export default function CameraReportButton({ payload }) {
  const [state, setState] = useState('idle'); // 'idle' | 'busy' | 'done'
  const [error, setError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const busyRef = useRef(false);

  async function build() {
    if (busyRef.current) return;
    busyRef.current = true;
    setState('busy');
    setError('');
    try {
      const report = await api.post('/cameras/probe-report', payload);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `nightlight-camera-report-${stamp}.json`;
      const text = JSON.stringify(report, null, 2);
      let msg = '';
      if (isNativeApp()) {
        if (await saveToDownloads(filename, text, 'application/json')) {
          msg = 'Saved to your Downloads folder.';
        } else if (await saveTextFile(filename, text)) {
          msg = 'Shared — pick "Save to Files" to keep a copy.';
        } else {
          throw new Error("Couldn't save the file on this device.");
        }
      } else {
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
      setSavedMsg(msg);
      setState('done');
      setTimeout(() => { setState('idle'); setSavedMsg(''); busyRef.current = false; }, 4000);
    } catch (err) {
      setError(err.message || 'Failed to build the report');
      setState('idle');
      busyRef.current = false;
    }
  }

  const label = state === 'busy' ? 'Building report…' : state === 'done' ? 'Downloaded ✓' : 'Generate camera report';

  return (
    <div className="onvif-box" style={{ marginTop: 12 }}>
      <div className="onvif-box__title">Camera not connecting?</div>
      <p className="onvif-box__hint">
        Generate a diagnostic report and attach it to a GitHub issue so support can be added for this
        camera. It captures the stream's codecs and any ONVIF details —{' '}
        <strong>no password is included</strong>, so you can open and review it first.
      </p>
      {error && <div className="onvif-box__err">{error}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        <button type="button" className="btn btn-peri" onClick={build} disabled={state !== 'idle'}>
          <FileText size={16} aria-hidden="true" />
          {label}
        </button>
        <a className="btn btn-secondary" href={ISSUE_URL} target="_blank" rel="noreferrer">
          <ExternalLink size={16} aria-hidden="true" />
          Report an issue
        </a>
      </div>
      {savedMsg && <div className="onvif-box__ok" style={{ marginTop: 8 }}>{savedMsg}</div>}
    </div>
  );
}
