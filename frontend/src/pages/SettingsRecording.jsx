import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useSettingsDraft } from '../lib/useSettingsDraft.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
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

export default function SettingsRecording() {
  const { settings, refresh, commit, loaded } = useSettings();
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

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    // The values as SHOWN, defaults included (valuesOf), so what is saved is what the person was looking at.
    // This now includes ondemand_enabled (#391): it used to commit on its own, by a separate PUT, the moment
    // the switch moved. One request, one outcome, one error message for the whole page.
    const payload = shown;
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
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message || 'Could not save');
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
                <input id="clip-days" type="number" min="0" max="365"
                  value={form.clip_retention_days ?? 14}
                  onChange={(e) => setField('clip_retention_days', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="clip-gb">Storage cap (GB)</label>
                <input id="clip-gb" type="number" min="0" max="2000"
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
      </main>
    </>
  );
}
