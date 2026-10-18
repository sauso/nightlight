import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useSettingsDraft } from '../lib/useSettingsDraft.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
import Modal from '../components/Modal.jsx';
import { useHomeTime } from '../lib/useHomeTime.js';
import { loadDraft } from '../lib/formDraft.js';
import { useDraftKey, useFormDraft } from '../lib/useFormDraft.js';

// Recording settings — split into the app's two genuinely different kinds of recording:
//   * Automatic clips: captured for you when a detection fires, and aged out by retention.
//   * On-demand recordings: captured because you pressed Record, and kept until you delete them.
// They share the same underlying buffer but answer to different settings and different rules, so
// mixing them into one block (as they were when this lived under General) read as one confusing
// feature with two pre-rolls.

function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '—';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

// ONE save model for the whole page (#391): every control here, switches included, is a draft until
// "Save changes" is pressed, and an "Unsaved changes" notice says so while any of them differs from what is
// stored. The "Show a Record button" switch used to write the moment it was flipped while the wake-clip
// switch beside it waited for Save, so two identical-looking pills committed differently and someone who
// turned wake-ups off and left the page could believe recording had stopped. Nothing here claims a feature
// is off until the save that turned it off has succeeded.
//
// Every field this page edits, with the default the screen SHOWS when nothing is stored. Booleans are
// normalised (the database hands back 1/0, the switch hands back true/false) so toggling a switch twice
// reads as "no change" rather than as 1 -> true. The same list is what a reload-surviving draft may store
// (#377): all numbers and booleans, no secrets on this page.
const DRAFT_FIELDS = [
  'clip_pre_roll_s', 'clip_post_roll_s', 'clip_retention_days', 'clip_retention_max_gb',
  'wake_clips_enabled', 'wake_clip_seconds', 'wake_clip_retention_days',
  'ondemand_enabled', 'ondemand_pre_roll_s', 'ondemand_max_duration_s',
];

function valuesOf(src) {
  return {
    clip_pre_roll_s: src.clip_pre_roll_s ?? 5,
    clip_post_roll_s: src.clip_post_roll_s ?? 15,
    clip_retention_days: src.clip_retention_days ?? 14,
    clip_retention_max_gb: src.clip_retention_max_gb ?? 5,
    wake_clips_enabled: !!(src.wake_clips_enabled ?? true),
    wake_clip_seconds: src.wake_clip_seconds ?? 30,
    wake_clip_retention_days: src.wake_clip_retention_days ?? 14,
    ondemand_enabled: !!(src.ondemand_enabled ?? true),
    ondemand_pre_roll_s: src.ondemand_pre_roll_s ?? 30,
    ondemand_max_duration_s: src.ondemand_max_duration_s ?? 120,
  };
}

// A retention field as a whole number in 0..max, or null. Plain digits only, and the SAME ranges routes/settings.js
// enforces (days 0-365, cap 0-2000 GB). WHY a strict test rather than Number(): the server stores these with
// parseInt, which reads "1e2" as 1 where Number() reads it as 100. A screen that judged "1e2" as 100 days would
// have skipped the question while the server kept 1 day and the sweep deleted nearly everything (#395 review).
// Anything this refuses is not sent at all, so the client and the server can never read one field two ways.
function wholeLimit(v, max) {
  const s = String(v ?? '').trim();
  return /^\d{1,6}$/.test(s) && Number(s) <= max ? Number(s) : null;
}

export default function SettingsRecording() {
  const { settings, refresh, commit, loaded } = useSettings();
  const home = useHomeTime();
  // Server settings vs. this screen's own unsaved edits, kept separate (#449) — see
  // useSettingsDraft.js for why a derived `form` replaced the old setForm(settings) sync effect.
  const draftKey = useDraftKey('settings:recording');
  // Read once on mount: edits typed before a background reload, or before a visit to another screen.
  const [restoredDraft] = useState(() => loadDraft(draftKey, DRAFT_FIELDS));
  const { form, setField, markSaved, discard } = useSettingsDraft(settings, restoredDraft || {});
  const [restored, setRestored] = useState(!!restoredDraft);
  const [storage, setStorage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  // The "this will delete clips" confirmation (#395): null when closed, else { preview, payload } where preview is
  // the server's dry run (or null when it could not be fetched) and payload is the EXACT set of values that was
  // previewed. Confirm saves that snapshot, never the live form, so the clips the person was told about are the
  // clips the save acts on even if the form changed while the check or the dialog was open. Its own error, not
  // the page's: a failure of what the dialog's button did belongs inside the dialog (design-language.md, Modal).
  const [deletePrompt, setDeletePrompt] = useState(null);
  const [confirmError, setConfirmError] = useState('');

  const loadStorage = () => api.get('/settings/clip-storage').then(setStorage).catch(() => {});
  useEffect(() => { loadStorage(); }, []);

  const shown = valuesOf(form);
  const stored = valuesOf(settings);
  // True while anything on screen differs from what is stored. Derived, so putting a value back clears it.
  //
  // `ready` waits for the server's settings. Until then `settings` is the provider's placeholder, and a
  // draft value that happens to equal a placeholder default would read as "no change" and be cleared from
  // storage, one reload from lost. After a background reload that window is real: the settings request is
  // still in flight when this screen first renders.
  const unsaved = useFormDraft({ key: draftKey, allow: DRAFT_FIELDS, form: shown, baseline: stored, ready: loaded !== false });

  // Back to what is stored: with no drafts, form == stored and useFormDraft removes the stored draft.
  function discardChanges() {
    discard();
    setRestored(false);
  }

  // Save is a two-step when it would delete video. Changing "Keep clips for" or "Storage cap" runs the retention
  // sweep the moment the save lands (routes/settings.js, only when a limit changed), and the sweep enforces BOTH
  // limits: even RAISING one limit deletes clips if storage is already over the other (#395 review). So the
  // decision is not the direction of the change but the answer to "what would this save delete?": whenever a
  // limit differs from what is stored we ask the server's dry run (GET /settings/clip-retention-preview, the same
  // queries the sweep uses) and show the dialog if it reports anything. If the dry run cannot be fetched we ask
  // anyway rather than delete without a word.
  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    // Snapshot once, now: the preview, the dialog and the PUT all use these values and no others.
    const payload = shown;
    const days = wholeLimit(payload.clip_retention_days, 365);
    const maxGb = wholeLimit(payload.clip_retention_max_gb, 2000);
    // Same wording as the server's own 400s. Refused here so a value the server would read differently from this
    // screen (see wholeLimit) is never sent.
    if (days === null) {
      setError('Keep clips for must be a whole number between 0 and 365 days (0 = no day limit)');
      return undefined;
    }
    if (maxGb === null) {
      setError('Storage cap must be a whole number between 0 and 2000 GB (0 = no size limit)');
      return undefined;
    }
    if (days !== stored.clip_retention_days || maxGb !== stored.clip_retention_max_gb) {
      setBusy(true);
      let preview = null;
      try {
        const r = await api.get(`/settings/clip-retention-preview?days=${days}&max_gb=${maxGb}`);
        preview = r && Number.isInteger(r.count) ? r : null;
      } catch {
        preview = null;
      }
      setBusy(false);
      // Nothing to delete AND storage is up: a plain save. With storage down the sweep does nothing now but runs
      // when it returns, and the preview cannot say what it will find, so that case is always explained.
      if (preview && preview.count === 0 && preview.storageReady !== false) return doSave(payload);
      setConfirmError('');
      setDeletePrompt({ preview, payload });
      return undefined;
    }
    return doSave(payload);
  }

  // `payload` is passed in rather than read from the form: from the dialog it is the snapshot that was previewed.
  // The values as SHOWN, defaults included (valuesOf), so what is saved is what the person was looking at.
  // This includes ondemand_enabled (#391): it used to commit on its own, by a separate PUT, the moment
  // the switch moved. One request, one outcome, one error message for the whole page.
  async function doSave(payload) {
    setBusy(true);
    setError('');
    try {
      const response = await api.put('/settings', payload);
      if (response && typeof response === 'object') {
        // Commit this write's own response instead of a second refresh() that
        // could fail silently and leave a stale value ready to be re-saved over the real one (#449
        // Codex F1). markSaved runs only once the committed base actually reflects what was sent, so
        // a saved draft can drop cleanly rather than possibly re-appearing dirty against a base that
        // hasn't caught up yet.
        commit(response);
        markSaved(payload);
      } else {
        // Defensive fallback: the route always answers with the settings object. Drafts stay dirty: nothing has confirmed the save
        // actually landed, so this must not look like a successful save cleared them.
        await refresh();
      }
      loadStorage();
      setDeletePrompt(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      // From the confirmation dialog the failure is shown inside it; otherwise on the page.
      if (deletePrompt) setConfirmError(err.message || 'Could not save');
      else setError(err.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  // What the screen shows, drafts included. Deliberately `??` inside valuesOf, not `||`: zero is meaningful here.
  const ondemandOn = shown.ondemand_enabled;
  const wakeClipsOn = shown.wake_clips_enabled;

  return (
    <>
      <AppHeader title="Recording" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}
        {unsaved && <UnsavedNotice restored={restored} onDiscard={discardChanges} />}

        <form onSubmit={save}>
          {/* --- Automatic clips (detection-triggered) --- */}
          <div className="card">
            <div className="card-title">Automatic clips</div>
            <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
              Recorded for you when motion or sound is detected, for cameras with “Save a clip when
              triggered” on (set per camera under its Motion/Sound settings). Each clip is shown on the
              alert it belongs to.
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="clip-pre">Pre-roll (seconds)</label>
                <input id="clip-pre" type="number" min="0" max="30"
                  value={form.clip_pre_roll_s ?? 5}
                  onChange={(e) => setField('clip_pre_roll_s', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="clip-post">Post-roll (seconds)</label>
                <input id="clip-post" type="number" min="5" max="120"
                  value={form.clip_post_roll_s ?? 15}
                  onChange={(e) => setField('clip_post_roll_s', e.target.value)} />
              </div>
            </div>
            <div className="camera-tile__sub" style={{ marginTop: 10 }}>
              How much video to keep before and after the moment that triggered the alert.
            </div>

            <div className="field-row" style={{ marginTop: 16 }}>
              <div className="field">
                <label htmlFor="clip-days">Keep clips for (days)</label>
                {/* Locked while the dry run is out or the confirmation is open: the values previewed are the values
                    saved (#395 review), so they must not move underneath the dialog. */}
                <input id="clip-days" type="number" min="0" max="365" disabled={busy || !!deletePrompt}
                  value={form.clip_retention_days ?? 14}
                  onChange={(e) => setField('clip_retention_days', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="clip-gb">Storage cap (GB)</label>
                <input id="clip-gb" type="number" min="0" max="2000" disabled={busy || !!deletePrompt}
                  value={form.clip_retention_max_gb ?? 5}
                  onChange={(e) => setField('clip_retention_max_gb', e.target.value)} />
              </div>
            </div>
            <div className="camera-tile__sub" style={{ marginTop: 10 }}>
              Oldest clips are deleted once either limit is passed (0 turns that limit off). The alert
              and its snapshot stay — only the video is removed. <strong>This does not apply to your own
              recordings below</strong>, which are kept until you delete them.
            </div>
          </div>

          {/* --- Wake clips (sleep-tracker triggered, deliberately silent) --- */}
          <div className="card">
            <div className="card-title">Wake clips</div>
            <div className="list-row" style={{ padding: 0 }}>
              <div>
                <div>Record wake-ups without alerting</div>
                <div className="camera-tile__sub">
                  Save a short clip when your child wakes, and send nothing.
                </div>
              </div>
              <Switch
                checked={wakeClipsOn}
                disabled={busy}
                onChange={(e) => setField('wake_clips_enabled', e.target.checked)}
                aria-label="Record wake-ups without alerting"
              />
            </div>

            {wakeClipsOn && (
              <>
                <div className="field-row" style={{ marginTop: 16 }}>
                  <div className="field">
                    <label htmlFor="wake-secs">Clip length (seconds)</label>
                    <input id="wake-secs" type="number" min="5" max="120"
                      value={form.wake_clip_seconds ?? 30}
                      onChange={(e) => setField('wake_clip_seconds', e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="wake-days">Keep wake clips for (days)</label>
                    <input id="wake-days" type="number" min="0" max="365"
                      value={form.wake_clip_retention_days ?? 14}
                      onChange={(e) => setField('wake_clip_retention_days', e.target.value)} />
                  </div>
                </div>
                <div className="camera-tile__sub" style={{ marginTop: 10 }}>
                  Most wake-ups never raise an alert — an alert waits for a couple of seconds of
                  sustained noise or movement before disturbing you, while sleep tracking reacts to the
                  first flicker. This records those wake-ups instead of announcing them, so there is
                  something to look at in the morning. Open a night on the child’s page and a wake-up
                  with a clip can be expanded to play it.
                </div>
                <div className="camera-tile__sub" style={{ marginTop: 8 }}>
                  Only for children with <strong>Track sleep</strong> on, and only once your child is
                  asleep — settling at bedtime is never recorded, and a brief stir is ignored. Longer
                  clips use proportionally more disk (0 days keeps them forever).
                </div>
              </>
            )}
          </div>

          {/* --- On-demand (the Record button) --- */}
          <div className="card">
            <div className="card-title">On-demand recording</div>
            <div className="list-row" style={{ padding: 0 }}>
              <div>
                <div>Show a Record button on each camera</div>
                <div className="camera-tile__sub">
                  Capture a moment yourself, whenever you want.
                </div>
              </div>
              <Switch
                checked={ondemandOn}
                disabled={busy}
                onChange={(e) => setField('ondemand_enabled', e.target.checked)}
                aria-label="Show a Record button on each camera"
              />
            </div>

            {ondemandOn && (
              <>
                <div className="field-row" style={{ marginTop: 16 }}>
                  <div className="field">
                    <label htmlFor="ond-pre">Capture before (seconds)</label>
                    <input id="ond-pre" type="number" min="0" max="60"
                      value={form.ondemand_pre_roll_s ?? 30}
                      onChange={(e) => setField('ondemand_pre_roll_s', e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="ond-max">Auto-stop after (seconds)</label>
                    <input id="ond-max" type="number" min="5" max="600"
                      value={form.ondemand_max_duration_s ?? 120}
                      onChange={(e) => setField('ondemand_max_duration_s', e.target.value)} />
                  </div>
                </div>
                <div className="camera-tile__sub" style={{ marginTop: 10 }}>
                  Pressing Record also saves the seconds <em>before</em> you pressed, so you can catch a
                  moment just after it happens. To manage that, the server keeps a short rolling buffer
                  for every camera — switching this off stops that buffering. Your recordings appear on
                  the child’s page and are kept until you delete them.
                </div>
              </>
            )}
          </div>

          {storage && (
            <div className="card">
              <div className="card-title">Storage</div>
              <div className="storage-readout">
                <div>
                  <strong>{fmtBytes(storage.usedBytes)}</strong> used
                  {typeof storage.clipCount === 'number' ? ` · ${storage.clipCount} clip${storage.clipCount === 1 ? '' : 's'}` : ''}
                  {typeof storage.recordingCount === 'number' ? ` · ${storage.recordingCount} recording${storage.recordingCount === 1 ? '' : 's'} (${fmtBytes(storage.recordingBytes)})` : ''}
                  {storage.wakeClips?.count ? ` · ${storage.wakeClips.count} wake clip${storage.wakeClips.count === 1 ? '' : 's'} (${fmtBytes(storage.wakeClips.bytes)})` : ''}
                  {typeof storage.freeBytes === 'number' && isFinite(storage.freeBytes) ? ` · ${fmtBytes(storage.freeBytes)} free` : ''}
                </div>
                <div className="camera-tile__sub" style={{ wordBreak: 'break-all' }}>
                  Saving to <code>{storage.path}</code>
                  {storage.ok ? '' : ' — ⚠ not a mapped volume; recording is disabled until this path is mounted'}
                </div>
              </div>
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 20 }}>
            {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'}
          </button>
        </form>
        {deletePrompt && (
          <Modal title="Delete saved clips?" onClose={() => setDeletePrompt(null)} error={confirmError}>
            <DeleteSummary preview={deletePrompt.preview} home={home} />
            <div className="camera-tile__sub" style={{ margin: '8px 0 12px' }}>
              The alerts and their pictures stay; only the video goes. Deleted clips can't be got back.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setDeletePrompt(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" style={{ flex: 1 }} onClick={() => doSave(deletePrompt.payload)} disabled={busy}>
                {busy ? 'Saving…' : 'Save and delete clips'}
              </button>
            </div>
          </Modal>
        )}
      </main>
    </>
  );
}

// What the dry run says will go. The clip count is as of now; the size is "about" because new clips can arrive
// before Save and each size is the one recorded when the clip was cut. With no preview (the request failed) it says
// so instead of guessing a number.
function DeleteSummary({ preview, home }) {
  if (!preview) {
    return (
      <p style={{ marginTop: 0 }}>
        We couldn't check how many clips these limits would delete. Saving a changed limit deletes the clips outside
        it straight away.
      </p>
    );
  }
  // Storage down: the real sweep returns before selecting anything, so there is no count to give, and giving one
  // would contradict "nothing is deleted". The clips outside the limits go on the first sweep after it returns.
  if (preview.storageReady === false) {
    return (
      <p style={{ marginTop: 0 }}>
        Clip storage isn't available right now, so nothing is deleted until it is. Once it is back, clips outside
        these limits are deleted.
      </p>
    );
  }
  const oldest = preview.oldestAt ? home.day(new Date(`${preview.oldestAt.replace(' ', 'T')}Z`)) : null;
  return (
    <>
      <p style={{ marginTop: 0 }}>
        Saving these limits deletes <strong>{preview.count} alert clip{preview.count === 1 ? '' : 's'}</strong>
        {' '}(about <strong>{fmtBytes(preview.bytes)}</strong>) right away{oldest ? <>; the oldest is from {oldest}</> : ''}.
      </p>
    </>
  );
}
