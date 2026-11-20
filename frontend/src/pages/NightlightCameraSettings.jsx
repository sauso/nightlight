import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import SwitchRow from '../components/SwitchRow.jsx';
import SimulatedBadge from '../components/SimulatedBadge.jsx';
import NotFound from './NotFound.jsx';
import LoadFailed from '../components/LoadFailed.jsx';
import { loadState } from '../lib/loadState.js';
import { STATUS_TEXT } from '../lib/nightlightSensors.js';

// A Nightlight Camera's own sensors: whether Nightlight reads them, per group, and what they say right now. The switches
// decide only what NIGHTLIGHT polls, stores and shows: nothing is sent to the camera. Instant-save like the detection
// screens (no Save button): each switch is one request, sent in order, with the same "Saving… / Saved ✓" flag.
//
// The page asks the server every 5 s; the server asks the camera (its /health and, at most once a minute, its
// /capabilities) and joins what its poller already holds, so this does not multiply requests to the camera.
const POLL_MS = 5000;

const GROUP_ROWS = [
  { key: 'climate', fitted: 'environment', label: 'Room temperature and humidity', sub: 'Joins the room climate on the charts and in each night.' },
  { key: 'radar', fitted: 'radar', label: 'Radar', sub: 'Presence, heart rate, breathing rate and distance. Shown live only for now.' },
  { key: 'light', fitted: null, label: 'Ambient light', sub: 'How bright the room is.' },
  { key: 'pad', fitted: 'pressure', label: 'Bed pad', sub: 'Whether the bed pad feels someone on it.' },
];

function readingLines(readings, tempUnit) {
  const r = readings || {};
  const num = (v) => Number.isFinite(v);
  const lines = [];
  if (num(r.temperature)) lines.push(['Temperature', `${(tempUnit === 'F' ? (r.temperature * 9) / 5 + 32 : r.temperature).toFixed(1)}°${tempUnit}`]);
  if (num(r.humidity)) lines.push(['Humidity', `${Math.round(r.humidity)}%`]);
  if (num(r.presence)) lines.push(['Presence', r.presence === 1 ? 'Someone is there' : 'Nobody there']);
  if (num(r.heart_rate)) lines.push(['Heart rate', `${Math.round(r.heart_rate)} bpm`]);
  if (num(r.breathing_rate)) lines.push(['Breathing rate', `${Math.round(r.breathing_rate)} per minute`]);
  if (num(r.distance_cm)) lines.push(['Distance', `${Math.round(r.distance_cm)} cm`]);
  if (num(r.light_lux)) lines.push(['Light', `${Math.round(r.light_lux)} lux`]);
  if (num(r.pad_occupied)) lines.push(['Bed pad', r.pad_occupied === 1 ? 'Occupied' : 'Empty']);
  return lines;
}

export default function NightlightCameraSettings() {
  const { id } = useParams();
  const { cameras, loaded: camerasLoaded, error: camerasError, refresh } = useCameras();
  const { settings } = useSettings();
  const cam = cameras.find((c) => c.id === id);
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [save, setSave] = useState({ state: 'idle' });
  const chain = useRef(Promise.resolve());
  const alive = useRef(true);
  const pending = useRef(0);

  const load = useCallback(async () => {
    try {
      const next = await api.get(`/cameras/${id}/nightlight`);
      // A poll that lands while a switch is still being saved would put the old value back for a moment.
      if (alive.current && pending.current === 0) { setInfo(next); setLoadError(null); }
    } catch (err) {
      if (alive.current) setLoadError(err);
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load]);

  // One request per change, in the order they were made (a later change must never be overtaken by an earlier one).
  function send(body, optimistic) {
    if (optimistic) setInfo((prev) => (prev ? optimistic(prev) : prev));
    pending.current++;
    setSave({ state: 'saving' });
    chain.current = chain.current.then(async () => {
      try {
        const r = await api.put(`/cameras/${id}/nightlight`, body);
        if (alive.current) setInfo((prev) => (prev ? { ...prev, enabled: r.enabled, groups: r.groups, status: r.status } : prev));
        if (alive.current) setSave({ state: 'saved' });
        refresh();
      } catch (err) {
        if (alive.current) setSave({ state: 'failed', message: err.message });
      } finally {
        pending.current--;
        if (pending.current === 0) load();
      }
    });
  }

  const back = { to: `/cameras/${id}`, label: 'Camera' };
  const missing = !cam ? loadState({ loaded: camerasLoaded, error: camerasError, count: 0 }) : null;
  if (missing === 'empty') return <NotFound />;
  if (missing === 'error') {
    return (<><AppHeader title="Nightlight Camera" back={back} /><main className="app-main"><LoadFailed what="this camera" error={camerasError} onRetry={refresh} /></main></>);
  }
  if (!cam || (!info && !loadError)) {
    return (<><AppHeader title="Nightlight Camera" back={back} /><main className="app-main"><div className="empty-state">Loading…</div></main></>);
  }
  if (!info) {
    return (<><AppHeader title="Nightlight Camera" back={back} /><main className="app-main"><LoadFailed what="this camera's sensors" error={loadError} onRetry={load} /></main></>);
  }

  const caps = info.capabilities || null;
  const tempUnit = settings?.temp_unit || 'C';
  const lines = readingLines(info.readings, tempUnit);
  const status = info.status || (info.enabled ? 'connecting' : 'off');

  return (
    <>
      <AppHeader title="Nightlight Camera" back={back} />
      <main className="app-main">
        {save.state === 'failed' ? (
          <div className="error-banner" role="alert">Not saved. {save.message}</div>
        ) : (
          <div className="save-flag">{save.state === 'saving' ? 'Saving…' : save.state === 'saved' ? 'Saved ✓' : ''}</div>
        )}

        {!info.detected ? (
          <section className="card nlcam-card">
            <h2 className="card-heading">Not answering as a Nightlight Camera</h2>
            <p className="camera-tile__sub">
              {info.reason === 'address'
                ? 'This camera was added by a name, not an IP address. Nightlight only reads sensors from a camera added by its IP address on your network.'
                : 'Nightlight could not reach this camera’s sensors. Check that it is on and on the same network as Nightlight, then try again.'}
            </p>
            <button type="button" className="btn btn-sm" onClick={load}>Try again</button>
          </section>
        ) : (
          <>
            <section className="card nlcam-card">
              <h2 className="card-heading">
                Sensors {info.simulated && <SimulatedBadge className="nlcam-card__badge" />}
              </h2>
              <p className="camera-tile__sub">
                {info.firmware ? `Firmware ${info.firmware}` : 'Nightlight Camera'}
                {info.device_id ? ` · ${info.device_id}` : ''}
              </p>
              {info.enabled && (
                <p className={`nlcam-status nlcam-status--${status}`} role="status">
                  {STATUS_TEXT[status] || status}
                  {status === 'login_failed' && <>
                    {' '}<button type="button" className="linkbtn" onClick={() => send({ retry: true })}>Retry</button>
                  </>}
                </p>
              )}
              {info.enabled && status === 'login_failed' && (
                <p className="camera-tile__sub">The camera did not accept its stored login. Fix the password in the camera&rsquo;s settings and Nightlight picks it up by itself, or press Retry.</p>
              )}
              <SwitchRow label="Use this camera's sensors" sub="Nightlight reads them every few seconds. Nothing is changed on the camera."
                checked={!!info.enabled} onChange={(e) => send({ enabled: e.target.checked }, (p) => ({ ...p, enabled: e.target.checked }))} />
            </section>

            <section className="card nlcam-card" aria-label="What to use">
              <h2 className="card-heading">What to use</h2>
              {GROUP_ROWS.filter((g) => !g.fitted || !caps || caps[g.fitted] !== false).map((g) => (
                <SwitchRow key={g.key} label={g.label} sub={g.sub} disabled={!info.enabled}
                  checked={!!info.groups?.[g.key]}
                  onChange={(e) => send({ groups: { [g.key]: e.target.checked } },
                    (p) => ({ ...p, groups: { ...p.groups, [g.key]: e.target.checked } }))} />
              ))}
              {info.groups?.climate && info.enabled && (
                <p className="camera-tile__sub">While room temperature and humidity are on, this camera&rsquo;s MQTT readings are ignored.</p>
              )}
            </section>

            {info.enabled && (
              <section className="card nlcam-card" aria-label="Right now">
                <h2 className="card-heading">Right now</h2>
                {lines.length === 0 ? (
                  <p className="camera-tile__sub">No readings yet.</p>
                ) : (
                  <dl className="nlcam-readings">
                    {lines.map(([name, value]) => (
                      <div key={name} className="nlcam-readings__row"><dt>{name}</dt><dd>{value}</dd></div>
                    ))}
                  </dl>
                )}
                <p className="camera-tile__sub">Sensor estimates, not for medical use. Nightlight is not a safety device.</p>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
