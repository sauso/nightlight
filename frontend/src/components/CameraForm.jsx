import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Zap, AudioLines, Clock, RotateCcw, Trash2, ChevronDown } from 'lucide-react';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import MoreMenu from '../components/MoreMenu.jsx';
import RemoveCameraDialog from '../components/RemoveCameraDialog.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
import { loadDraft, clearDraft } from '../lib/formDraft.js';
import { useDraftKey, useFormDraft } from '../lib/useFormDraft.js';
import NavRow from '../components/NavRow.jsx';
import CameraReportButton from '../components/CameraReportButton.jsx';
import RecordingScopePanel from '../components/RecordingScopePanel.jsx';
import { useDetectionSave, retry } from '../lib/detectionSaves.js';
import { loadState } from '../lib/loadState.js';
import LoadFailed from '../components/LoadFailed.jsx';
import NotFound from '../pages/NotFound.jsx';
import { probeCamera, buildCameraPayload } from '../lib/cameraConnect.js';
import { TITLES as DETECTION_TITLES } from '../pages/DetectionSettings.jsx';

const minToHHMM = (m) => `${String(Math.floor((m || 0) / 60)).padStart(2, '0')}:${String((m || 0) % 60).padStart(2, '0')}`;

const EMPTY_FORM = {
  name: '', rtsp_host: '', rtsp_port: '554', rtsp_path: '', rtsp_username: '', rtsp_password: '',
  child_id: '', mqtt_topic: '', talk_username: '', talk_password: '', sub_rtsp_path: '',
};

// What survives a reload as a draft (#377). The two PASSWORDS (rtsp_password, talk_password) are deliberately
// absent and must stay so: a draft is plain text in browser storage, and the owner's rule is that no secret
// is ever persisted. After a reload the person types the password again; the notice says so. The username
// fields are kept (a login name is not a secret, and losing it is what makes the form tedious to redo).
const DRAFT_FIELDS = [
  'name', 'rtsp_host', 'rtsp_port', 'rtsp_path', 'rtsp_username', 'child_id', 'mqtt_topic', 'talk_username', 'sub_rtsp_path',
];

// The draft fields that live inside the closed "Advanced" disclosure (#1076). A restored draft holding a value in one
// of them must open it: otherwise the person's own half-typed stream path would be restored invisibly (the "unsaved
// changes restored" notice would say so, but nothing on screen would show what).
const ADVANCED_DRAFT_FIELDS = ['rtsp_path', 'sub_rtsp_path', 'mqtt_topic', 'talk_username'];
// "Holds a value" is not the test: a draft that CLEARS a saved path (key present, value '') is just as hidden, and a
// later Save would send that blank path with nothing on screen to show it (Codex review of #1080). So the test is
// "differs from what is stored", compared to `base` (the loaded camera, or the empty form on a new camera).
const draftTouchesAdvanced = (draft, base) => !!draft
  && ADVANCED_DRAFT_FIELDS.some((key) => key in draft && (draft[key] ?? '') !== (base[key] ?? ''));

// The two messages the form raises ITSELF about a field that is NOT inside Advanced (the IP is in Camera, the child in
// Assigned to). They arrive through `pageError` like a server message, but opening Advanced for them would jump the
// layout under the person for no reason (Codex review of #1080), so the open-on-error rule below skips them.
const IP_FIRST_ERROR = 'Enter the camera IP first';
const CHILD_FIRST_ERROR = 'Assign this camera to a child before continuing setup.';

// Per-camera settings as a routed screen (replaces the old edit modal). /cameras/new adds a
// camera; /cameras/:id edits one. Only connection/identity fields live here — motion, sound and
// schedule are their own screens (see DetectionSettings.jsx), reachable from the Detection rows
// below on an existing camera. Admin-only (gated by the route in App.jsx).
// requireChild: the wizard needs the camera assigned to the child it is setting up, so an embedded form insists on
// one by default. The Add camera screen embeds this form too (as its manual card) and a camera may be left
// unassigned there, as it always could; AddCameraFlow turns the requirement off when it has no child to offer (#950).
export default function CameraForm({ onCreated, initialChildId = '', embedded = false, prefill, requireChild = embedded }) {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { kids: children, cameras, loaded: camerasLoaded, error: camerasError, refresh } = useCameras();
  const cam = isNew ? null : cameras.find((c) => c.id === id);

  const draftKey = useDraftKey(isNew ? 'camera:new' : `camera:${id}`);
  // A prefill (a camera picked from the search, then Advanced settings) supersedes any stored draft: the
  // shared 'camera:new' draft belongs to whatever was typed last, which may be ANOTHER camera's address and
  // username (found in the #951 review).
  const [restoredDraft] = useState(() => (isNew && !prefill ? loadDraft(draftKey, DRAFT_FIELDS) : null));
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, ...restoredDraft, ...(initialChildId ? { child_id: initialChildId } : {}) }));
  const appliedPrefill = useRef(null);
  const picked = prefill;
  useEffect(() => {
    if (!isNew || !picked || appliedPrefill.current === picked) return;
    appliedPrefill.current = picked;
    // `username` is the login already typed on the connect card when the person chose Advanced settings (#950).
    // The password is never part of a prefill: it is not kept anywhere between the two cards.
    setForm((current) => ({ ...current, name: picked.name, rtsp_host: picked.host,
      rtsp_port: String(picked.port || 554), ...(picked.username ? { rtsp_username: picked.username } : {}) }));
  }, [picked, isNew]);
  // The form as last loaded or saved: what "unsaved" is measured against. Typing never touches it.
  // WHY: the wizard's assigned child is already saved as the initial form value,
  // so opening it must not create an unsaved draft or let Discard unassign it.
  const [baseline, setBaseline] = useState(() => ({ ...EMPTY_FORM, child_id: initialChildId }));
  const [restored, setRestored] = useState(!!restoredDraft);
  const [formReady, setFormReady] = useState(isNew);
  const [caps, setCaps] = useState({ backchannel_supported: undefined, talk_has_password: false, rtsp_has_password: false });
  const initedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [onvifBusy, setOnvifBusy] = useState(false);
  const [onvifMsg, setOnvifMsg] = useState('');
  // Whether the "Advanced" disclosure (stream paths, two-way audio, MQTT topic) is open (#1076). It is controlled
  // state, not <details>, so the rules below can open it and the person can still close it again. It starts OPEN when
  // the form cannot work without it: a NEW or EMBEDDED form (the Add screen's manual card, the setup guide) whose
  // stream path is still empty, because the person who typed an address by hand has to give a path too, unless the
  // ONVIF fetch fills it. (Embedded forms are always new: they have no :id.) It also starts open for a restored
  // draft that holds a value inside it. An existing camera starts CLOSED: its path is already saved.
  const [advancedOpen, setAdvancedOpen] = useState(() => draftTouchesAdvanced(restoredDraft, EMPTY_FORM) || (isNew && !restoredDraft?.rtsp_path));
  const [talkVerifyBusy, setTalkVerifyBusy] = useState(false);
  const [talkVerifyMsg, setTalkVerifyMsg] = useState(null);
  const [pageError, setPageError] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  // Set once this camera has been deleted, so the render that follows the list refresh (just before we
  // navigate away) does not flash "Page not found" for a camera the person just removed on purpose.
  const removedRef = useRef(false);
  // The Remove dialog's own failure, rendered inside it (#378): pageError is a banner in <main>, which sits
  // under the modal overlay, so a refused remove used to look like the button did nothing.
  const [removeError, setRemoveError] = useState('');
  // Carried into the ONVIF fetch/talk-verify calls so extra capabilities detected here persist.
  const extraRef = useRef({});

  // Where "Back" goes, AND where a successful save or remove lands (#383). It used to be a hard-coded
  // '/family' (a retired route that redirects to Children), so a camera opened from the Cameras tab
  // landed on Children after saving, while the header link (which honours location.state.from) said
  // otherwise. Same shape as ChildSettings; the fallback is the Cameras tab, this page's real parent.
  const back = location.state?.from || { to: '/cameras', label: 'Cameras' };

  // Initialise the form once the camera has loaded (edit), or immediately (add).
  useEffect(() => {
    if (isNew || initedRef.current) return;
    if (!cam) return; // still loading
    initedRef.current = true;
    const loaded = {
      name: cam.name,
      rtsp_host: cam.rtsp_host || '',
      rtsp_port: cam.rtsp_port || '554',
      rtsp_path: cam.rtsp_path || '',
      rtsp_username: cam.rtsp_username || '',
      rtsp_password: '',
      child_id: cam.child_id || '',
      mqtt_topic: cam.mqtt_topic || '',
      talk_username: cam.talk_username || '',
      talk_password: '',
      sub_rtsp_path: cam.sub_rtsp_path || '',
    };
    const draft = loadDraft(draftKey, DRAFT_FIELDS);
    setBaseline(loaded);
    setForm({ ...loaded, ...draft });
    setRestored(!!draft);
    // An edit's draft is read here, after the camera loads, so the same rule as the initial state is applied now.
    if (draftTouchesAdvanced(draft, loaded)) setAdvancedOpen(true);
    setFormReady(true);
    setCaps({
      backchannel_supported: cam.backchannel_supported,
      talk_has_password: !!cam.talk_has_password,
      rtsp_has_password: !!cam.rtsp_has_password,
    });
  }, [cam, isNew, draftKey]);

  // `unsaved` also counts a typed password, which is never stored: it is an edit the person would lose.
  const unsaved = useFormDraft({
    key: draftKey, allow: DRAFT_FIELDS, form, baseline, ready: formReady,
    secrets: [form.rtsp_password, form.talk_password],
  });

  // A failed save, the stream-test question ("Save anyway") or a failed ONVIF fetch has no field name: the server says
  // "couldn't reach the stream", not "the path is wrong". The path, the low-quality path and the talk login are what
  // such a message is almost always about, and they sit behind the closed Advanced row, so a new message of that kind
  // opens it (#1076, amendment 2). The effect runs only when a message APPEARS or CHANGES, never on a later render, so
  // a person who closes Advanced again while the same message is still on screen is not fought. No field is
  // focused: which one is at fault is not known, so nothing is promised. (The stream path has no `required`, so there
  // is no native validation message hiding in a closed section either.)
  useEffect(() => {
    if (confirmMsg || (pageError && pageError !== IP_FIRST_ERROR && pageError !== CHILD_FIRST_ERROR)) setAdvancedOpen(true);
  }, [pageError, confirmMsg]);

  // Back to what is stored. useFormDraft sees form == baseline and removes the stored draft.
  function discardDraft() {
    setForm(baseline);
    setRestored(false);
  }

  async function fetchFromOnvif() {
    const host = form.rtsp_host.trim();
    if (!host) { setPageError(IP_FIRST_ERROR); return; }
    setOnvifBusy(true); setOnvifMsg(''); setPageError('');
    try {
      const r = await probeCamera({
        host, username: form.rtsp_username, password: form.rtsp_password, id: isNew ? undefined : id,
      });
      setForm((f) => ({
        ...f,
        rtsp_host: r.fields.rtsp_host,
        rtsp_port: r.fields.rtsp_port || f.rtsp_port || '554',
        rtsp_path: r.fields.rtsp_path || f.rtsp_path,
        sub_rtsp_path: r.fields.sub_rtsp_path || f.sub_rtsp_path,
      }));
      extraRef.current = r.extra;
      setCaps((c) => ({ ...c, ...r.caps }));
      setOnvifMsg(r.summary);
      // A successful fetch that finds two-way audio which is NOT carried by the stream (`backchannel_verified === false`
      // is the Hikvision-style camera) makes the talk LOGIN necessary, and that block is behind Advanced: open it, or the
      // summary says "two-way audio" while the field it needs is unreachable and a Save would send an empty talk
      // username, which the server reads as "turn talk-back off" (Codex review of #1080).
      if (r.caps.backchannel_supported === 'yes' && r.caps.backchannel_verified === false) setAdvancedOpen(true);
    } catch (err) {
      setPageError(err.message);
    } finally {
      setOnvifBusy(false);
    }
  }

  async function verifyTalk() {
    const host = form.rtsp_host.trim();
    if (!host) { setTalkVerifyMsg({ ok: false, text: 'Enter the camera IP first' }); return; }
    if (!form.talk_username.trim()) { setTalkVerifyMsg({ ok: false, text: 'Enter the talk username first' }); return; }
    setTalkVerifyBusy(true); setTalkVerifyMsg(null);
    try {
      const r = await api.post('/cameras/verify-talk', {
        host, username: form.talk_username.trim(), password: form.talk_password || undefined, id: isNew ? undefined : id,
      }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      setTalkVerifyMsg({ ok: true, text: `Talk login works${r.codec ? ` — ${r.codec}` : ''}` });
    } catch (err) {
      setTalkVerifyMsg({ ok: false, text: err.message });
    } finally {
      setTalkVerifyBusy(false);
    }
  }

  // How talk-back is delivered, which decides what the talk panel shows:
  //  - 'onvif-backchannel' (Thingino/Sonoff/most ONVIF): rides the stream audio using the STREAM
  //    creds — no separate login. Prompting for one is misleading, and the save path discards it.
  //  - 'hikvision-isapi': needs the camera's web login (separate from the ONVIF user).
  // Prefer a fresh probe's live verification; otherwise trust the backend already stored on the camera.
  const talkBackend =
    caps.backchannel_verified === true ? 'onvif-backchannel'
    : caps.backchannel_verified === false ? 'hikvision-isapi'
    : cam?.talk_backend || null;
  // Talk-back over the stream backchannel is the default for any backchannel-capable camera; only a
  // camera positively known to use the Hikvision ISAPI login shows the credential form. This keeps a
  // legacy cam whose backend was never resolved out of the "empty username = disable talk" footgun.
  const isIsapi = talkBackend === 'hikvision-isapi';
  const showTalk = caps.backchannel_supported === 'yes' || isIsapi;
  const talkOverStream = showTalk && !isIsapi;

  async function doSave(force) {
    setBusy(true); setPageError('');
    if (requireChild && !form.child_id) {
      setPageError(CHILD_FIRST_ERROR);
      setBusy(false);
      return;
    }
    const payload = buildCameraPayload(form, extraRef.current, { force });
    // Backchannel cams carry no separate talk login (talk-back uses the stream creds). Never send the
    // empty talk fields for them — the API reads an empty talk_username as "disable talk-back", which
    // would silently turn two-way audio off on any unrelated edit.
    if (talkOverStream) { delete payload.talk_username; delete payload.talk_password; }
    try {
      // A camera save probes each of its streams (and the talk backchannel) server-side before it
      // answers, so it is one of the calls allowed to run long.
      const slow = { timeoutMs: SLOW_REQUEST_TIMEOUT_MS };
      const saved = isNew ? await api.post('/cameras', payload, slow) : await api.put(`/cameras/${id}`, payload, slow);
      // Saved: the form now equals what is stored, so the draft is stale. Moving the baseline is what clears it
      // (useFormDraft derives the draft from form-versus-baseline). It matters beyond tidiness: after ADDING a
      // camera this same component stays mounted under /cameras/:newId, and without it the old form would be
      // re-stored there as an edit of the new camera.
      setBaseline({ ...form, rtsp_password: '', talk_password: '' });
      // The save worked, so the "Couldn't reach the camera stream" question that Save anyway answered is over (#496).
      // This is where that state lives, and it has to be cleared here because adding a camera does not remount the
      // page: /cameras/new and /cameras/:id render this same component in the same place, so React keeps the instance
      // (and its state) across the navigation below, and the new camera's page opened with the old warning on it and
      // "Retry save" in place of "Save changes".
      setConfirmMsg(''); setPageError('');
      await refresh();
      // New camera: drop into its own settings so motion/sound can be configured next.
      if (isNew && onCreated) onCreated(saved);
      else navigate(isNew ? `/cameras/${saved.id}` : back.to, { state: { from: back } });
    } catch (err) {
      if (err.data?.needsConfirm) setConfirmMsg(err.message);
      else setPageError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function save(e) {
    e.preventDefault();
    setConfirmMsg(''); setPageError('');
    doSave(false);
  }

  async function confirmRemove() {
    setRemoveBusy(true); setPageError(''); setRemoveError('');
    try {
      await api.del(`/cameras/${id}`);
      removedRef.current = true;
      clearDraft(draftKey);
      await refresh();
      navigate(back.to);
    } catch (err) {
      // Dialog stays open, button re-enabled: the person can read why and retry or cancel.
      setRemoveError(err.message);
      setRemoveBusy(false);
    }
  }

  const detFrom = { state: { from: { to: `/cameras/${id}`, label: 'Camera' } } };

  // The queue that backs the three detection screens (and the camera tile's quick toggles) lives
  // outside any one screen (issue #444), so a write that fails after the user has already navigated
  // BACK to this page must still surface here — this is where "Back" from a detection screen lands.
  // Deliberately outside the <form> below (Codex F6 of the #444 plan): this page is one big form
  // whose own submit does something completely different (saves the camera's connection settings),
  // and Retry must never be able to trigger that by being a descendant of it.
  const detSave = useDetectionSave(id);

  // An address for a camera that does not exist (#379): the list has loaded and this id is not in it. Before
  // that, or after a failed load, the camera may well exist, so those keep their own states rather than
  // claiming it is missing. count is 0 for the reason ChildDetail gives: the requested camera is absent, so a
  // cached list cannot vouch for it and any provider error is a blocking one.
  const missing = !isNew && !cam && !removedRef.current ? loadState({ loaded: camerasLoaded, error: camerasError, count: 0 }) : null;
  if (missing === 'empty') return <NotFound />;
  if (missing === 'error') {
    return (
      <>
        <AppHeader title="Camera" back={back} />
        <main className="app-main"><LoadFailed what="this camera" error={camerasError} onRetry={refresh} /></main>
      </>
    );
  }

  const ContentTag = embedded ? 'div' : 'main';
  return (
    <>
      {/* "Remove camera" moved out of a red button under Save (a mis-tap away from the primary action) into the header's
          ⋯ menu, as on the sleep page (#1076). Only for a saved camera that has loaded (there is nothing to remove on
          Add camera or while loading) and only for an admin: the route is admin-only already, and the role is checked
          here the way the Cameras list does, so the item never depends on the route guard alone. The dialog it opens
          is the same one the Cameras list uses, so both screens warn about the same deletion. */}
      {!embedded && <AppHeader title={isNew ? 'Add camera' : (cam?.name || 'Camera')} back={back}
        actions={!isNew && cam && user?.role === 'admin' ? (
          <MoreMenu label="More options for this camera" menuLabel="Camera">
            <button type="button" role="menuitem" className="more-menu__item dev-card__delete"
              onClick={() => { setRemoveError(''); setRemoving(true); }}>
              <Trash2 size={16} aria-hidden="true" />Remove camera
            </button>
          </MoreMenu>
        ) : null} />}
      <ContentTag className="app-main">
        {!isNew && detSave.state === 'failed' && (
          // A sibling of <form> below, never a descendant of it — see the comment on `detSave` above.
          <div className="error-banner" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span>
              Your last detection change for this camera wasn't saved.
              {detSave.kind && DETECTION_TITLES[detSave.kind] && (
                <> <Link to={`/cameras/${id}/${detSave.kind}`}>Open {DETECTION_TITLES[detSave.kind]}</Link></>
              )}
            </span>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => retry(id)}>Retry</button>
          </div>
        )}
        {!isNew && !cam ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <form onSubmit={save}>
            {unsaved && (
              <UnsavedNotice restored={restored} onDiscard={discardDraft}
                note={restored ? 'Passwords are never kept on the device, so type them again.' : ''} />
            )}
            {/* Four groups instead of one 15-field scroll (#1076). Every field, id, label (bar the two shortened ones),
                validation and request is what it was; only the grouping and the order changed. */}
            <div className="section-title">Camera</div>
            <div className="card camera-form__card">
              <div className="field">
                <label htmlFor="cam-name">Name</label>
                <input id="cam-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required placeholder="e.g. Nursery cam" />
              </div>

              <div className="camera-form__pair camera-form__pair--host">
                <div className="field">
                  <label htmlFor="cam-host">Camera IP address</label>
                  <input id="cam-host" value={form.rtsp_host} onChange={(e) => setForm({ ...form, rtsp_host: e.target.value })}
                    required placeholder="192.168.1.50" />
                </div>
                <div className="field">
                  <label htmlFor="cam-port">RTSP port</label>
                  <input id="cam-port" value={form.rtsp_port} onChange={(e) => setForm({ ...form, rtsp_port: e.target.value })} placeholder="554" />
                </div>
              </div>

              <div className="camera-form__pair camera-form__pair--login">
                <div className="field">
                  <label htmlFor="cam-user">Username</label>
                  <input id="cam-user" value={form.rtsp_username} onChange={(e) => setForm({ ...form, rtsp_username: e.target.value })}
                    autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                </div>
                <div className="field">
                  <label htmlFor="cam-pass">Password</label>
                  <input id="cam-pass" type="password" value={form.rtsp_password}
                    onChange={(e) => setForm({ ...form, rtsp_password: e.target.value })}
                    autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                    placeholder={!isNew && caps.rtsp_has_password ? '•••••• (unchanged)' : ''} />
                </div>
              </div>

              <div className="camera-form__onvif">
                <button type="button" className="btn btn-peri camera-form__fetch" onClick={fetchFromOnvif} disabled={onvifBusy}>
                  {onvifBusy ? 'Fetching…' : <><RotateCcw size={16} aria-hidden="true" />Fetch from ONVIF</>}
                </button>
                <p className="camera-form__hint">
                  Optional: fetch the stream port, path and capabilities (two-way audio, PTZ) over ONVIF using
                  the IP and login above. Most cameras don't need a login for this; if yours does, fill it in first.
                </p>
                {onvifMsg && <div className="onvif-box__ok">{onvifMsg}</div>}
              </div>
            </div>

            <div className="section-title">Assigned to</div>
            <div className="card camera-form__card">
              <div className="field camera-form__last-field">
                <label htmlFor="cam-child">Child (optional)</label>
                <select id="cam-child" value={form.child_id} onChange={(e) => setForm({ ...form, child_id: e.target.value })}>
                  <option value="">Unassigned</option>
                  {children.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
                </select>
              </div>
            </div>

            {/* Detection lives on its own screens, so it only exists once the camera does. Each row shows the
                CURRENT setting and carries the same back-link state (`detFrom`) the old rows did. */}
            {!isNew && cam && (
              <>
                <div className="section-title">Detection</div>
                <div className="card camera-form__nav-card">
                  <NavRow Icon={Zap} label="Motion detection" value={cam.detect_motion_enabled ? 'On' : 'Off'}
                    onClick={() => navigate(`/cameras/${id}/motion`, detFrom)} />
                  <NavRow Icon={AudioLines} label="Sound detection" value={cam.detect_sound_enabled ? 'On' : 'Off'}
                    onClick={() => navigate(`/cameras/${id}/sound`, detFrom)} />
                  <NavRow Icon={Clock} label="Alert schedule"
                    value={cam.detect_schedule_enabled ? `${minToHHMM(cam.detect_start)}–${minToHHMM(cam.detect_end)}` : 'Always'}
                    onClick={() => navigate(`/cameras/${id}/schedule`, detFrom)} />
                </div>
                {/* Read-only summary of what this camera alerts on and records, and whether it is ready (#394). */}
                <RecordingScopePanel cam={cam} />
              </>
            )}

            {/* The rarely used fields. Unmounted while closed (not just hidden), so a closed row holds nothing a
                keyboard or screen reader could land on. The row is a real button with aria-expanded; the
                `advancedOpen` rules above open it for the cases where something inside is needed. */}
            <div className="card camera-form__advanced">
              <button type="button" className="camera-form__disclosure" aria-expanded={advancedOpen}
                aria-controls="camera-advanced-fields" onClick={() => setAdvancedOpen((open) => !open)}>
                <span className="camera-form__disclosure-text">
                  <strong>Advanced</strong>
                  <span>Stream paths, two-way audio, MQTT topic</span>
                </span>
                <ChevronDown size={18} aria-hidden="true" />
              </button>
              {advancedOpen && (
                <div id="camera-advanced-fields" className="camera-form__advanced-fields">
                  <div className="field">
                    <label htmlFor="cam-path">Stream path</label>
                    <input id="cam-path" value={form.rtsp_path} onChange={(e) => setForm({ ...form, rtsp_path: e.target.value })}
                      placeholder="/Streaming/Channels/101" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                    <p className="onvif-box__hint">The main (high-quality) stream path. Filled in by the ONVIF fetch, or enter it manually.</p>
                  </div>

                  <div className="field">
                    <label htmlFor="cam-sub-path">Low-quality stream path (optional)</label>
                    <input id="cam-sub-path" value={form.sub_rtsp_path} onChange={(e) => setForm({ ...form, sub_rtsp_path: e.target.value })}
                      autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="/Streaming/Channels/102" />
                    <p className="onvif-box__hint">A second, lower-resolution stream that adds a "Low" quality option on the tile — it reuses the address and login above.</p>
                  </div>

                  {showTalk && (
                    <div className="onvif-box">
                      <div className="onvif-box__title">Two-way audio (talk-back)</div>
                      {talkOverStream ? (
                        <p className="onvif-box__hint">
                          This camera plays talk-back over its own stream audio, so it needs <strong>no separate
                          login</strong> — the hold-to-talk button is enabled automatically using the stream
                          credentials above.
                        </p>
                      ) : (
                        <>
                          <p className="onvif-box__hint">
                            This camera needs its <strong>web login</strong> to enable the hold-to-talk button — for
                            Hikvision that's the User Management account (separate from the ONVIF user). Leave the
                            username blank to turn it off.
                          </p>
                          <div className="onvif-box__row">
                            <div className="field">
                              <label htmlFor="cam-talk-user">Talk username</label>
                              <input id="cam-talk-user" value={form.talk_username} onChange={(e) => setForm({ ...form, talk_username: e.target.value })}
                                autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                            </div>
                            <div className="field">
                              <label htmlFor="cam-talk-pass">Talk password</label>
                              <input id="cam-talk-pass" type="password" value={form.talk_password}
                                onChange={(e) => setForm({ ...form, talk_password: e.target.value })}
                                autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                                placeholder={caps.talk_has_password ? '•••••• (unchanged)' : ''} />
                            </div>
                          </div>
                          <button type="button" className="btn btn-peri" onClick={verifyTalk} disabled={talkVerifyBusy} style={{ marginTop: 4 }}>
                            {talkVerifyBusy ? 'Verifying…' : 'Verify login'}
                          </button>
                          {talkVerifyMsg && <div className={talkVerifyMsg.ok ? 'onvif-box__ok' : 'onvif-box__err'}>{talkVerifyMsg.text}</div>}
                        </>
                      )}
                    </div>
                  )}

                  <div className="field">
                    <label htmlFor="cam-mqtt-topic">MQTT topic for temp/humidity (optional)</label>
                    <input id="cam-mqtt-topic" value={form.mqtt_topic} onChange={(e) => setForm({ ...form, mqtt_topic: e.target.value })}
                      placeholder="e.g. zigbee2mqtt/Child B Room Temp" />
                  </div>
                </div>
              )}
            </div>

            {pageError && <div className="error-banner" style={{ marginBottom: 12 }}>{pageError}</div>}
            {confirmMsg && (
              <div className="form-warning">
                <div>Couldn't reach the camera stream: {confirmMsg}</div>
                <div className="camera-tile__sub" style={{ marginTop: 4 }}>
                  Check the IP, path, and login — or if the camera's just offline right now, save it anyway.
                </div>
              </div>
            )}

            {/* When a probe or the stream check fails, offer a diagnostic report to add support for
                the camera (your idea: probe fails → send a bug report with the details attached). */}
            {(pageError || confirmMsg) && form.rtsp_host.trim() && (
              <CameraReportButton
                payload={{
                  host: form.rtsp_host.trim(),
                  port: form.rtsp_port,
                  path: form.rtsp_path,
                  sub_path: form.sub_rtsp_path,
                  username: form.rtsp_username,
                  password: form.rtsp_password || undefined,
                  mqtt_topic: form.mqtt_topic,
                  id: isNew ? undefined : id,
                }}
              />
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : confirmMsg ? 'Retry save' : isNew ? 'Add camera' : 'Save changes'}
              </button>
              {confirmMsg && (
                <button className="btn" type="button" onClick={() => doSave(true)} disabled={busy}>Save anyway</button>
              )}
            </div>

          </form>
        )}
      </ContentTag>

      {removing && cam && <RemoveCameraDialog camera={cam} error={removeError} busy={removeBusy}
        onClose={() => setRemoving(false)} onConfirm={confirmRemove} />}
    </>
  );
}
