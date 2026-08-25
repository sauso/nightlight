import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';
import CribZonePicker from '../components/CribZonePicker.jsx';

const minToHHMM = (m) => `${String(Math.floor((m || 0) / 60)).padStart(2, '0')}:${String((m || 0) % 60).padStart(2, '0')}`;
const hhmmToMin = (s) => {
  const [h, mm] = String(s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (mm || 0);
};

const TITLES = { motion: 'Motion detection', sound: 'Sound detection', schedule: 'Alert schedule' };

// Build the full detection state (all three slices) from a camera row — the /detection endpoint
// replaces every field at once, so each screen must send the whole payload with only its slice
// changed, preserving the others.
function fromCam(cam) {
  const hasWindow = cam.detect_start !== cam.detect_end;
  return {
    motion_enabled: !!cam.detect_motion_enabled,
    sensitivity: cam.detect_sensitivity ?? 50,
    cooldown_s: cam.detect_cooldown_s ?? 60,
    confirm_s: cam.detect_confirm_s ?? 3,
    schedule_enabled: !!cam.detect_schedule_enabled,
    start: minToHHMM(hasWindow ? cam.detect_start : 20 * 60),
    end: minToHHMM(hasWindow ? cam.detect_end : 7 * 60),
    source: cam.detect_source === 'mqtt' ? 'mqtt' : cam.detect_source === 'onvif' ? 'onvif' : 'framediff',
    zone: cam.detect_zone || null,
    motion_mqtt_topic: cam.motion_mqtt_topic || '',
    motion_mqtt_value: cam.motion_mqtt_value || '',
    snapshot_url: cam.snapshot_url || '',
    sound_enabled: !!cam.detect_sound_enabled,
    sound_sensitivity: cam.sound_sensitivity ?? 50,
    sound_confirm_s: cam.sound_confirm_s ?? 4,
    sound_cooldown_s: cam.sound_cooldown_s ?? 120,
    record_clips: !!cam.detect_record_clips,
  };
}

function toPayload(d) {
  return {
    motion_enabled: !!d.motion_enabled,
    sensitivity: Number(d.sensitivity),
    cooldown_s: Number(d.cooldown_s),
    confirm_s: Number(d.confirm_s),
    schedule_enabled: !!d.schedule_enabled,
    start: hhmmToMin(d.start),
    end: hhmmToMin(d.end),
    source: d.source,
    zone: d.zone ?? null,
    motion_mqtt_topic: d.motion_mqtt_topic,
    motion_mqtt_value: d.motion_mqtt_value,
    snapshot_url: d.snapshot_url,
    sound_enabled: !!d.sound_enabled,
    sound_sensitivity: Number(d.sound_sensitivity),
    sound_confirm_s: Number(d.sound_confirm_s),
    sound_cooldown_s: Number(d.sound_cooldown_s),
    record_clips: !!d.record_clips,
  };
}

// Shared "record a clip" opt-in, shown on both the motion and sound screens (a clip is captured on
// any detection). Writes the per-camera detect_record_clips flag via the same /detection payload.
function RecordClipsToggle({ d, apply }) {
  return (
    <>
      <div className="section-title">Recording</div>
      <EnableToggle checked={d.record_clips} onChange={(v) => apply({ record_clips: v })}
        label="Save a clip when triggered"
        sub="Records a short video around each alert (uses the pre/post-roll in Settings → Recording). Off by default." />
    </>
  );
}

// Motion / Sound / Schedule as their own routed screens (/cameras/:id/:kind). Changes apply
// immediately (debounced) via the /detection endpoint, which restarts the detector — no Save
// button. The other two slices are preserved on every write (see fromCam).
export default function DetectionSettings() {
  const { id, kind } = useParams();
  const { cameras, refresh } = useCameras();
  const cam = cameras.find((c) => c.id === id);

  const [d, setD] = useState(null);
  const [status, setStatus] = useState(''); // '' | 'saving' | 'saved'
  const initedRef = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (initedRef.current || !cam) return;
    initedRef.current = true;
    setD(fromCam(cam));
  }, [cam]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function apply(patch) {
    setD((prev) => {
      const next = { ...prev, ...patch };
      setStatus('saving');
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        try {
          await api.put(`/cameras/${id}/detection`, toPayload(next));
          await refresh();
          setStatus('saved');
          setTimeout(() => setStatus(''), 1500);
        } catch {
          setStatus('');
        }
      }, 700);
      return next;
    });
  }

  const back = { to: `/cameras/${id}`, label: 'Camera' };

  if (!cam || !d) {
    return (
      <>
        <AppHeader title={TITLES[kind] || 'Detection'} back={back} />
        <main className="app-main"><div className="empty-state">Loading…</div></main>
      </>
    );
  }

  return (
    <>
      <AppHeader title={TITLES[kind] || 'Detection'} back={back} />
      <main className="app-main">
        <div className="save-flag">{status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : ''}</div>
        {kind === 'motion' && <MotionForm d={d} apply={apply} cameraId={id} cam={cam} />}
        {kind === 'sound' && <SoundForm d={d} apply={apply} />}
        {kind === 'schedule' && <ScheduleForm d={d} apply={apply} />}
      </main>
    </>
  );
}

function EnableToggle({ checked, onChange, label, sub }) {
  return (
    <label className="tgl-row">
      <div>
        <div>{label}</div>
        {sub && <div className="camera-tile__sub">{sub}</div>}
      </div>
      <Switch checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Slider({ label, value, onChange, lowLabel, highLabel }) {
  return (
    <div className="field" style={{ marginTop: 12 }}>
      <label>{label}: {value}</label>
      <input type="range" min="1" max="100" value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="slider-legend"><span>{lowLabel}</span><span>{highLabel}</span></div>
    </div>
  );
}

function MotionForm({ d, apply, cameraId, cam }) {
  // The "Camera via ONVIF" source is offered only when the camera advertised a motion event topic
  // at ONVIF add/re-probe time — otherwise a subscription would just sit idle. (A camera stuck on
  // the onvif source after losing capability still shows the button so it can be switched away.)
  const showOnvif = !!cam?.onvif_motion_capable || d.source === 'onvif';
  return (
    <>
      <EnableToggle checked={d.motion_enabled} onChange={(v) => apply({ motion_enabled: v })}
        label="Motion detection" sub="Off by default — watches this camera's video for movement." />
      {!d.motion_enabled ? (
        <div className="empty-state">Turn on to configure how motion is detected and when it alerts.</div>
      ) : (
        <>
          <div className="section-title">Detection source</div>
          <div className="segmented" role="group" aria-label="Detection source">
            <button type="button" className={`segmented__btn${d.source === 'framediff' ? ' segmented__btn--active' : ''}`}
              onClick={() => apply({ source: 'framediff' })}>Nightlight</button>
            <button type="button" className={`segmented__btn${d.source === 'mqtt' ? ' segmented__btn--active' : ''}`}
              onClick={() => apply({ source: 'mqtt' })}>Camera via MQTT</button>
            {showOnvif && (
              <button type="button" className={`segmented__btn${d.source === 'onvif' ? ' segmented__btn--active' : ''}`}
                onClick={() => apply({ source: 'onvif' })}>Camera via ONVIF</button>
            )}
          </div>
          <div className="camera-tile__sub" style={{ marginTop: 6 }}>
            {d.source === 'mqtt'
              ? 'The camera detects motion itself and publishes it over MQTT (needs Settings → MQTT connected). Uses almost no server CPU.'
              : d.source === 'onvif'
              ? 'The camera detects motion itself and reports it over ONVIF — no MQTT broker needed. Uses almost no server CPU.'
              : 'Nightlight watches the stream and diffs frames. Works on any camera; uses some server CPU.'}
          </div>

          {d.source === 'framediff' && (
            <Slider label="Sensitivity" value={d.sensitivity} onChange={(v) => apply({ sensitivity: v })}
              lowLabel="Less sensitive" highLabel="More sensitive" />
          )}
          {d.source === 'mqtt' && (
            <>
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="motion-topic">Motion MQTT topic</label>
                <input id="motion-topic" value={d.motion_mqtt_topic} placeholder="e.g. thingino/livingroom/motion"
                  onChange={(e) => apply({ motion_mqtt_topic: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="motion-value">Motion value (optional)</label>
                <input id="motion-value" value={d.motion_mqtt_value} placeholder={'auto: ON / true / {"motion":true}'}
                  onChange={(e) => apply({ motion_mqtt_value: e.target.value })} />
                <div className="camera-tile__sub">Leave blank to auto-recognise ON / true / 1 / "motion" / {'{"motion":true}'}.</div>
              </div>
            </>
          )}

          <div className="section-title">Timing</div>
          <div style={{ display: 'flex', gap: 10 }}>
            {d.source === 'framediff' && (
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="m-confirm">Confirm (seconds)</label>
                <input id="m-confirm" type="number" min="0" max="30" value={d.confirm_s}
                  onChange={(e) => apply({ confirm_s: e.target.value })} />
              </div>
            )}
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="m-cooldown">Cooldown (seconds)</label>
              <input id="m-cooldown" type="number" min="1" max="3600" value={d.cooldown_s}
                onChange={(e) => apply({ cooldown_s: e.target.value })} />
            </div>
          </div>
          <div className="camera-tile__sub">
            {d.source === 'framediff'
              ? 'Movement must persist for the confirm delay before it alerts, then won\'t alert again until the cooldown passes.'
              : 'Cooldown is the minimum gap between alerts (the camera has already confirmed the motion).'}
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="snapshot-url">Alert image URL (optional)</label>
            <input id="snapshot-url" value={d.snapshot_url} placeholder="http://camera/snapshot.jpg"
              onChange={(e) => apply({ snapshot_url: e.target.value })} />
            <div className="camera-tile__sub">
              If your camera has an HTTP snapshot endpoint, alert images are grabbed from it — instant and clearer than
              a stream frame. Basic-auth in the URL works. Applies to both motion and sound alerts.
            </div>
          </div>

          <div className="section-title">Bed area</div>
          <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
            {d.source === 'framediff'
              ? 'Limit motion detection — and sleep tracking — to the bed, so movement elsewhere in the room isn’t counted. Leave as the whole frame to watch everything.'
              : 'For sleep tracking: limit the movement signal to the bed so a fan or someone walking past isn’t counted as the baby stirring. (Motion alerts still come from the camera.)'}
          </div>
          <CribZonePicker cameraId={cameraId} zone={d.zone} onChange={(zoneVal) => apply({ zone: zoneVal })} />

          <RecordClipsToggle d={d} apply={apply} />
        </>
      )}
    </>
  );
}

function SoundForm({ d, apply }) {
  return (
    <>
      <EnableToggle checked={d.sound_enabled} onChange={(v) => apply({ sound_enabled: v })}
        label="Sound detection" sub="Needs a camera with a microphone." />
      {!d.sound_enabled ? (
        <div className="empty-state">Turn on to alert when sound stays above the room's ambient level.</div>
      ) : (
        <>
          <div className="camera-tile__sub" style={{ marginTop: 12 }}>
            Alerts when sound stays <strong>above the room's ambient level</strong>. The ambient is learned continuously,
            so a white-noise machine or fan gets absorbed into the baseline — only a sustained rise above it triggers.
          </div>
          <Slider label="Sensitivity" value={d.sound_sensitivity} onChange={(v) => apply({ sound_sensitivity: v })}
            lowLabel="Needs loud noise" highLabel="Triggers easily" />
          <div className="section-title">Timing</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="s-confirm">Confirm (seconds)</label>
              <input id="s-confirm" type="number" min="0" max="30" value={d.sound_confirm_s}
                onChange={(e) => apply({ sound_confirm_s: e.target.value })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="s-cooldown">Cooldown (seconds)</label>
              <input id="s-cooldown" type="number" min="1" max="3600" value={d.sound_cooldown_s}
                onChange={(e) => apply({ sound_cooldown_s: e.target.value })} />
            </div>
          </div>
          <div className="camera-tile__sub">
            Sound must persist for the confirm delay before it counts (filters a door slam or cough); cooldown is the
            minimum gap between alerts. Longer than motion by default.
          </div>
          <RecordClipsToggle d={d} apply={apply} />
        </>
      )}
    </>
  );
}

function ScheduleForm({ d, apply }) {
  return (
    <>
      <EnableToggle checked={d.schedule_enabled} onChange={(v) => apply({ schedule_enabled: v })}
        label="Only alert during set hours" sub="Outside the window, motion and sound are ignored entirely." />
      {d.schedule_enabled ? (
        <>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="sched-start">From</label>
              <input id="sched-start" type="time" value={d.start} onChange={(e) => apply({ start: e.target.value })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="sched-end">To</label>
              <input id="sched-end" type="time" value={d.end} onChange={(e) => apply({ end: e.target.value })} />
            </div>
          </div>
          <div className="camera-tile__sub" style={{ marginTop: 6 }}>
            Overnight windows work. No push and no in-app alert outside these hours. Shared by motion and sound.
            Uses the app timezone from Settings → General.
          </div>
        </>
      ) : (
        <div className="empty-state">Alerting 24/7.</div>
      )}
    </>
  );
}
