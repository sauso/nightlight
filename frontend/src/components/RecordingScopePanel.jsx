import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import { describeSetup, describeReady } from '../lib/recordingScope.js';

// "Recording and alerts" on a camera's settings page (#394): what this camera is set up to alert on and
// record, and, separately, whether it is ready to right now. READ-ONLY by the owner's decision: it
// changes no behaviour and has no control, and the idea of splitting notification from event-recording
// controls was explicitly not adopted. Admin-only because the page it sits on is (App.jsx).
//
// The two groups come from different places on purpose. "Set up" is derived here from fields the page
// already holds; "Ready right now" is one GET to the server, because a camera whose switches all read "on"
// can still have no buffer and only the server knows. A failed fetch leaves the first group untouched and
// says so in the second, inline: it is not a reason to blank the setup rows.
export default function RecordingScopePanel({ cam }) {
  const { kids } = useCameras();
  const { settings } = useSettings();
  const [readiness, setReadiness] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.get(`/cameras/${cam.id}/recording-readiness`);
      if (!alive.current) return;
      setReadiness(r);
      setFailed(false);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [cam.id]);

  useEffect(() => {
    alive.current = true;
    check();
    return () => { alive.current = false; };
  }, [check]);

  const setup = describeSetup({ cam, kids, settings });
  // A failed check wins over an older success: otherwise "Check again" failing would leave the previous
  // answer on screen, looking like a fresh one, and the failure message would be unreachable.
  const ready = failed ? null : describeReady({ cam, setup, readiness });

  return (
    <section aria-labelledby="scope-title">
      <div className="section-title" id="scope-title">Recording and alerts</div>
      <div className="card" style={{ padding: 0 }}>
        <div className="scope-group" id="scope-setup">Set up</div>
        <ul className="scope-list" aria-labelledby="scope-setup">
          {setup.map((r) => (
            <li className="det-row" key={r.key}>
              <span>
                <span className="det-row__label">{r.label}</span>
                {r.note && <span className="camera-tile__sub" style={{ display: 'block' }}>{r.note}</span>}
              </span>
              <span className="scope-row__value">{r.value}</span>
            </li>
          ))}
        </ul>

        <div className="scope-group" id="scope-ready">Ready right now</div>
        {ready ? (
          <ul className="scope-list" aria-labelledby="scope-ready">
            {ready.map((r) => (
              <li className="det-row" key={r.key}>
                <span>
                  <span className="det-row__label">{r.label}</span>
                  {r.note && <span className="camera-tile__sub" style={{ display: 'block' }}>{r.note}</span>}
                </span>
                <span className={`status-badge status-badge--sm status-badge--${r.state}`}>{r.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="det-row" role={failed ? 'alert' : 'status'}>
            <span className="camera-tile__sub">
              {failed ? 'Couldn’t check whether this camera is ready right now.' : 'Checking…'}
            </span>
          </div>
        )}
        <div className="det-row">
          <button type="button" className="btn btn-sm btn-secondary" style={{ width: 'auto' }} onClick={check} disabled={busy}>
            {busy ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
    </section>
  );
}
