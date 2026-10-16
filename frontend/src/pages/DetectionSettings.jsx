import { useEffect, useId, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';
import CribZonePicker from '../components/CribZonePicker.jsx';
import { queuePatch, flush, retry, useDetectionSave, pendingPatch, minToHHMM } from '../lib/detectionSaves.js';

export const TITLES = { motion: 'Motion detection', sound: 'Sound detection', schedule: 'Alert schedule' };

// Build the full detection state (all three slices) from a camera row.
//
// This component still holds all three slices in one state object `d` — motion, sound and schedule
// — because each screen only shows one of them and needs the others to still be here when it isn't
// looking at them (e.g. so ScheduleForm can tell a real window from an unset one). But since #444,
// `apply` below only ever QUEUES the fields a screen actually changed, via detectionSaves.js's
// `queuePatch` — it does not resend `d` wholesale the way this screen used to. `PUT /:id/detection`
// keeps any field it isn't sent (backend/test/detection-route.test.js, issue #443), which is what
// makes that safe: an edit on the sound screen no longer has any way to rewrite the motion zone or
// the alert window, because it never sends them.
//
// ⚠️ `start`/`end` MUST still be the true stored value here, even when they're equal ("all-day" —
// see inActiveWindow in backend/src/lib/detectSchedule.js). Substituting a friendly display default
// (e.g. 20:00–07:00) at this layer would corrupt the FORM's own idea of the schedule even though it
// is no longer resent on unrelated saves — ScheduleForm relies on `d.start === d.end` to know
// whether a real window exists at all (issue #443). Any "here's a suggested window" UI belongs at
// render time in ScheduleForm, which can show a suggestion without adopting it.
function fromCam(cam) {
  return {
    motion_enabled: !!cam.detect_motion_enabled,
    sensitivity: cam.detect_sensitivity ?? 50,
    cooldown_s: cam.detect_cooldown_s ?? 60,
    confirm_s: cam.detect_confirm_s ?? 3,
    schedule_enabled: !!cam.detect_schedule_enabled,
    start: minToHHMM(cam.detect_start),
    end: minToHHMM(cam.detect_end),
    source: cam.detect_source === 'mqtt' ? 'mqtt' : cam.detect_source === 'onvif' ? 'onvif' : 'framediff',
    zone: cam.detect_zone || null,
    motion_mqtt_topic: cam.motion_mqtt_topic || '',
    motion_mqtt_value: cam.motion_mqtt_value || '',
    snapshot_url: cam.snapshot_url || '',
    // The server never sends the snapshot password (issue #271) — only whether one is set. The input
    // starts blank, and blank means "keep whatever is stored".
    //
    // ⚠️ `snapshot_has_password` is deliberately NOT held here. This object is built exactly once per
    // mount (the initedRef guard below), which is correct for every editable field — the client's own
    // value already matches what will come back. That flag is the one thing on this screen that is a
    // server-computed FACT the client cannot know, so freezing it left an admin who had just saved a
    // password still reading "(optional)" until they navigated away and back. It is read straight off
    // `cam` at render instead. Found by adversarial review of #271.
    snapshot_password: '',
    sound_enabled: !!cam.detect_sound_enabled,
    sound_sensitivity: cam.sound_sensitivity ?? 50,
    sound_confirm_s: cam.sound_confirm_s ?? 4,
    sound_cooldown_s: cam.sound_cooldown_s ?? 120,
    record_clips: !!cam.detect_record_clips,
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
// button. Saving is a per-camera queue (detectionSaves.js) that outlives this component, not a
// timer owned by it (issue #444) — see `apply` below.
export default function DetectionSettings() {
  const { id, kind } = useParams();
  const { cameras, refresh } = useCameras();
  const cam = cameras.find((c) => c.id === id);

  const [d, setD] = useState(null);
  const initedRef = useRef(false);
  const save = useDetectionSave(id); // { state: 'idle'|'saving'|'saved'|'failed', kind, error }

  useEffect(() => {
    if (initedRef.current || !cam) return;
    initedRef.current = true;
    // Layer the camera's own unsaved changes over the server's values — from ANY of the three
    // screens, since the queue is per-camera, not per-screen — so revisiting mid-edit or after a
    // failure shows what the user actually has, not what the server last confirmed (issue #444).
    setD({ ...fromCam(cam), ...pendingPatch(id) });
  }, [cam, id]);

  // Flushes rather than cancels on unmount (defect 1 of #444): the queue lives outside this
  // component, so a write already committed to completes after navigation, exactly once. Re-runs
  // (flushing the OLD id first) whenever `id` itself changes, not only on a true unmount, so
  // switching cameras without unmounting can't strand a pending write under the wrong id.
  useEffect(() => () => flush(id), [id]);

  // A pure updater (React StrictMode invokes it twice — it must not have side effects, defect 4).
  // The actual send is queued separately, once, below.
  function apply(patch) {
    setD((prev) => ({ ...prev, ...patch }));
    // The promise queuePatch() returns (issue #444 fix 1/3) is for a caller that needs to know THIS
    // specific write landed — CameraTile's quick toggle does, to know when it's safe to clear its own
    // "busy" guard. This screen doesn't need that: it already reads its outcome from
    // useDetectionSave(id) below (the Saving…/Saved ✓/Not saved flag), so it's ignored here. That's
    // safe — queuePatch() always attaches its own no-op catch internally, so a failed save here can
    // never surface as an unhandled promise rejection; the failure still reaches the UI via `save`.
    queuePatch(id, patch, { kind, send: (payload) => api.put(`/cameras/${id}/detection`, payload), onSaved: refresh });
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
        {save.state === 'failed' ? (
          // A persistent failure banner (defect 2): unlike the old blank-on-failure status, this
          // never clears itself — only a successful Retry (or a fresh edit that goes on to save)
          // does. The controls below keep showing the user's own values; that's their intent, and
          // Retry sends exactly that.
          <div className="error-banner" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span>Not saved.</span>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => retry(id)}>Retry</button>
          </div>
        ) : (
          <div className="save-flag">{save.state === 'saving' ? 'Saving…' : save.state === 'saved' ? 'Saved ✓' : ''}</div>
        )}
        {kind === 'motion' && <MotionForm d={d} apply={apply} cameraId={id} cam={cam} />}
        {kind === 'sound' && <SoundForm d={d} apply={apply} cameraId={id} />}
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
  // The label is tied to the input with a generated id. Without the association the range control has
  // NO accessible name — a screen reader announces "slider, 50" with no indication of what it adjusts,
  // and the two sliders on this screen's sibling routes are indistinguishable. useId rather than a
  // hand-written id because this component is rendered on more than one screen.
  const id = useId();
  return (
    <div className="field" style={{ marginTop: 12 }}>
      <label htmlFor={id}>{label}: {value}</label>
      <input id={id} type="range" min="1" max="100" value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="slider-legend"><span>{lowLabel}</span><span>{highLabel}</span></div>
    </div>
  );
}

function MotionForm({ d, apply, cameraId, cam }) {
  // The "Camera via ONVIF" source is offered only when the camera advertised a motion event topic
  // at ONVIF add/re-probe time — otherwise a subscription would just sit idle. (A camera stuck on
  // the onvif source after losing capability still shows the button so it can be switched away.)
  const showOnvif = !!cam?.onvif_motion_capable || d.source === 'onvif';
  // ⚠️ READ FROM `cam` ON EVERY RENDER, not held in `d`. Whether a snapshot password is stored is a
  // server fact the client cannot compute, so it has to follow the refreshed camera row — otherwise
  // it stays frozen at whatever it was when the screen mounted, and an admin who has just saved a
  // password is still told there isn't one. Deriving it also means a refresh landing mid-edit updates
  // this label WITHOUT touching anything the user is currently typing, which re-running `fromCam`
  // would have done. Issue #271, found by adversarial review.
  const hasSnapshotPassword = !!cam?.snapshot_has_password;
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
              a stream frame. Applies to both motion and sound alerts.
            </div>
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="snapshot-password">
              Alert image password {hasSnapshotPassword ? '(saved)' : '(optional)'}
            </label>
            <input id="snapshot-password" type="password" autoComplete="new-password"
              value={d.snapshot_password}
              placeholder={hasSnapshotPassword ? 'Leave blank to keep the saved password' : 'Only if the endpoint needs one'}
              onChange={(e) => apply({ snapshot_password: e.target.value })} />
            <div className="camera-tile__sub">
              {hasSnapshotPassword
                ? 'A password is saved for this endpoint. It is never sent back to this page — leave this blank to keep it, or type a new one to replace it.'
                : 'If the snapshot endpoint needs a username and password, put the username in the URL above and the password here.'}
              {' '}Changing the address above to a different host drops the saved password, so it is never sent somewhere new.
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

function SoundForm({ d, apply, cameraId }) {
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
          <SoundCalibration cameraId={cameraId} sensitivity={d.sound_sensitivity} />
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
          <SoundLimits cooldownS={d.sound_cooldown_s} />
        </>
      )}
    </>
  );
}

// #371: how many dB over the room's ambient level the sound must average to alert, for a sensitivity.
// A copy of backend/src/lib/soundBaseline.js marginDb (4 dB at 100 .. 18 dB at 1, ~11 at the 50 default),
// pinned against the documented figures in detectionSettings.test.jsx. It is only used to tell the person
// where the alert line sits next to the level they are reading; if the backend curve ever changes, this
// number goes stale while the alerting itself does not, which is why it is shown as "about".
export function alertMarginDb(sensitivity) {
  const s = Math.min(100, Math.max(1, Number(sensitivity) || 50));
  return 4 + 14 * ((100 - s) / 99);
}

// #371: the camera's recent sound level, relative to its own ambient level, and whether the detector has
// started producing readings at all. No new setting and no new endpoint: `GET /cameras/:id/activity-history`
// (any signed-in user) already returns, per minute, `sound_level` (the average dB ABOVE the learned ambient
// level, never the absolute loudness) and `sound_windows` (how many readings that minute held).
//
// ⚠️ WHAT "CALIBRATED" CAN AND CANNOT MEAN HERE. The live ambient level is held in the detector's memory and
// is not served by any route, so this does not show it. What it can show is whether readings are being
// STORED: the analyser stores nothing for an audible window until it has seeded its ambient (25 windows,
// about 5 seconds), so a minute with readings means the detector is listening and has a baseline. Two
// honest exceptions, both worded in the text rather than hidden: digital silence is stored as 0 over
// ambient even before a baseline exists (#453, so a muted microphone reads as "listening, quiet"), and the
// minute in progress is not in the history yet (it appears about 7 s after it ends). "No readings" is
// therefore one of: still learning after a start or save (seconds), no microphone, or the detector not
// running; the history cannot tell them apart, so the text names all three instead of guessing one.
// For the same reason the "Listening" box says only that readings are coming in and NEVER that the room's
// level "has been learned": a muted microphone stores zero-level readings without ever seeding a baseline
// (review of #711), so stored readings do not prove calibration.
//
// BOUNDARIES (pinned in test/soundCalibration.test.jsx): a reading exactly READINGS_FRESH_MIN old is still
// fresh (the cut-off is `>`), a reading exactly LEVEL_WINDOW_MIN old is still averaged (`<=`), and a reading
// dated after `nowMs` (clock skew between the server's minute and this browser) is ignored, not counted.
const LEVEL_WINDOW_MIN = 5; // the span the level is averaged over
const READINGS_FRESH_MIN = 10; // no stored minute this recent = "no readings"
const POLL_MS = 30000; // history gains a minute each minute; half a minute keeps the figure within one of it

// `t` is 'YYYY-MM-DD HH:MM:SS' in UTC (activity_samples.bucket_start); null when it does not parse.
function bucketMs(t) {
  const ms = Date.parse(`${String(t).replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Pure so the maths is testable without a clock or a fetch. `samples` is the activity-history array.
export function summariseSoundLevel(samples, nowMs) {
  const rows = (Array.isArray(samples) ? samples : [])
    .map((r) => ({ ms: bucketMs(r.t), windows: Number(r.sound_windows) || 0, level: Number(r.sound_level), peak: Number(r.sound_peak) }))
    .filter((r) => r.ms !== null && r.windows > 0 && r.ms <= nowMs);
  const newest = rows.reduce((m, r) => Math.max(m, r.ms), -Infinity);
  if (!rows.length || nowMs - newest > READINGS_FRESH_MIN * 60000) return { ready: false };
  const recent = rows.filter((r) => nowMs - r.ms <= LEVEL_WINDOW_MIN * 60000);
  // Weighted by readings per minute, so a minute that held 3 readings does not count as much as one with 300.
  const total = recent.reduce((n, r) => n + r.windows, 0);
  if (!total) return { ready: true, avg: null, peak: null };
  return {
    ready: true,
    avg: recent.reduce((n, r) => n + (Number.isFinite(r.level) ? r.level : 0) * r.windows, 0) / total,
    peak: recent.reduce((m, r) => Math.max(m, Number.isFinite(r.peak) ? r.peak : 0), 0),
  };
}

function SoundCalibration({ cameraId, sensitivity }) {
  const [state, setState] = useState({ phase: 'loading' }); // loading | ok | error
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .get(`/cameras/${cameraId}/activity-history?hours=1`)
        .then((r) => live && setState({ phase: 'ok', ...summariseSoundLevel(r?.samples, Date.now()) }))
        .catch(() => live && setState({ phase: 'error' }));
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [cameraId]);

  const margin = Math.round(alertMarginDb(sensitivity));
  return (
    <>
      <div className="section-title">Calibration</div>
      {/* role="status": it changes on its own every half minute, and a screen reader should get the new
          state without the person having to go looking for it. */}
      <div className="card" role="status" style={{ marginBottom: 0 }}>
        {state.phase === 'loading' && <div className="camera-tile__sub">Checking…</div>}
        {state.phase === 'error' && (
          <div className="camera-tile__sub">Couldn’t read the recent sound levels. The detector itself is not affected.</div>
        )}
        {state.phase === 'ok' && !state.ready && (
          <div className="camera-tile__sub">
            <strong>No sound readings yet.</strong> After the detector starts, or after you change a setting here,
            it listens for about 5 seconds to learn the room’s level before it reports anything. If this stays
            blank, the camera may have no microphone or the detector may not be running.
          </div>
        )}
        {state.phase === 'ok' && state.ready && (
          <div className="camera-tile__sub">
            <strong>Listening.</strong> Sound readings are coming in.
            {state.avg !== null && (
              <>
                {' '}Over the last {LEVEL_WINDOW_MIN} minutes the sound averaged{' '}
                <strong>{state.avg.toFixed(1)} dB above</strong> the room’s level, and peaked{' '}
                <strong>{state.peak.toFixed(1)} dB above</strong> it. An alert needs about{' '}
                <strong>{margin} dB</strong> at this sensitivity, held for the confirm time.
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// #371: the detector's deliberate limits, in plain words and always visible. Every one of them is an
// existing, documented trade-off (docs/notifications.md, "Sound sensitivity also changes sleep tracking"),
// not a defect found here; the 45 s / 5 min / 25 readings figures are REBASELINE_MS, DEAD_BAND_MAX_MS and
// SEED_WINDOWS in backend/src/lib/soundBaseline.js. They were measured on two cameras in one house: they are
// stated as what the detector does, not as what suits every room.
function SoundLimits({ cooldownS }) {
  return (
    <>
      <div className="section-title">What this detector can and can’t do</div>
      <ul className="camera-tile__sub" style={{ paddingLeft: 18, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <li><strong>It measures loudness, not crying.</strong> It can’t tell a cry from speech, a television, or a
          sound from another room; anything that stays louder than the room’s level counts.</li>
        <li><strong>It learns the room’s level at the start.</strong> That takes about 5 seconds of listening. If the
          room is already loud then, the starting level is set high, and quieter sounds won’t alert until it adjusts.</li>
        <li><strong>A steady noise stops alerting.</strong> A sound that stays well above the alert level is treated as
          part of the room after about 45 seconds; a moderate one (above half the alert level, below it) after about
          5 minutes. That is how a fan or white-noise machine is learned, and it also means a long, steady cry fades
          into the background.</li>
        <li><strong>Sustained noise may not alert again.</strong> After an alert there is a {cooldownS}-second wait
          before the next one. Noise that carries on through it can be absorbed before another alert is possible, and
          there is no separate “still noisy” follow-up alert.</li>
        <li><strong>The level can be relearned.</strong> If the detector restarts, for example when the camera
          reconnects, it keeps what it learned, but a restart at the wrong moment can start the learning over.</li>
      </ul>
    </>
  );
}

// A stored all-day schedule (start === end, see fromCam) has no real window to show in a time
// picker, so the inputs display a suggested overnight range without writing it into `d` — `d.start`/
// `d.end` stay at their true equal value until the user actually edits a schedule field, so a save
// triggered from anywhere else (including just toggling `schedule_enabled`) keeps sending the real
// all-day value instead of silently adopting the suggestion (issue #443). The first edit made while
// the suggestion is showing commits BOTH fields as displayed, not just the one touched — otherwise
// the untouched field would silently fall back to the real (pre-suggestion) stored time instead of
// the 20:00/07:00 the user was looking at when they typed.
//
// ⚠️ Whether to SHOW the suggestion is latched in a ref, not re-derived from `d.start === d.end` on
// every render. Re-deriving it would misfire the moment a genuine edit happens to land on equal
// values — e.g. typing 07:00 into "From" while "To" still reads the suggested 07:00 commits
// start=07:00/end=07:00, which is equal again, so a render-time `d.start === d.end` check would
// silently swap the display straight back to the 20:00 suggestion, discarding what was just typed
// and reverting it on the very next unrelated save. Found by adversarial review of this fix. Once
// the user has made one real edit this visit to the screen, both fields go back to editing
// independently, equal or not.
function ScheduleForm({ d, apply }) {
  const showingSuggestion = useRef(d.start === d.end);
  const allDay = showingSuggestion.current;
  const showStart = allDay ? '20:00' : d.start;
  const showEnd = allDay ? '07:00' : d.end;
  function editStart(value) {
    const patch = allDay ? { start: value, end: showEnd } : { start: value };
    showingSuggestion.current = false;
    apply(patch);
  }
  function editEnd(value) {
    const patch = allDay ? { start: showStart, end: value } : { end: value };
    showingSuggestion.current = false;
    apply(patch);
  }
  // Turning scheduling ON while there is no real window yet (`allDay`) is itself the user's
  // deliberate schedule edit, not an unrelated one — so unlike toggling it off, or toggling it on
  // when a real window already exists, THIS commits the suggested window for real, the same as the
  // camera tile's quick toggle (CameraTile.jsx's togglePatch). Leaving start/end at the true equal
  // value here would make "Only alert during set hours" an inert control: inActiveWindow() treats
  // start===end as always active regardless of schedule_enabled, so the screen would show a
  // specific 20:00–07:00 window under "no push and no in-app alert outside these hours" while
  // alerts kept firing around the clock. Found by adversarial review of this fix.
  function toggleEnabled(v) {
    if (v && allDay) {
      showingSuggestion.current = false;
      apply({ schedule_enabled: true, start: showStart, end: showEnd });
    } else {
      apply({ schedule_enabled: v });
    }
  }
  return (
    <>
      <EnableToggle checked={d.schedule_enabled} onChange={toggleEnabled}
        label="Only alert during set hours" sub="Outside the window, motion and sound are ignored entirely." />
      {d.schedule_enabled ? (
        <>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="sched-start">From</label>
              <input id="sched-start" type="time" value={showStart} onChange={(e) => editStart(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="sched-end">To</label>
              <input id="sched-end" type="time" value={showEnd} onChange={(e) => editEnd(e.target.value)} />
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
