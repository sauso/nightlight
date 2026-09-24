import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useSettingsDraft } from '../lib/useSettingsDraft.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';

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

export default function SettingsRecording() {
  const { settings, refresh, commit } = useSettings();
  // Server settings vs. this screen's own unsaved edits, kept separate (#449) — see
  // useSettingsDraft.js for why a derived `form` replaced the old setForm(settings) sync effect.
  const { form, setField, markSaved } = useSettingsDraft(settings);
  const [storage, setStorage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  // ondemand_enabled commits on its own (see toggleOndemand) so it is deliberately NOT one of the
  // drafts above — it's this screen's own optimistic value while that write is in flight, separate
  // from every other field's "typed but not yet saved" state.
  const [pendingOndemand, setPendingOndemand] = useState(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  const loadStorage = () => api.get('/settings/clip-storage').then(setStorage).catch(() => {});
  useEffect(() => { loadStorage(); }, []);

  // The on/off switch applies the moment it's flipped — that's what the pill shape promises in this
  // codebase (see Switch.jsx), and turning the feature off should stop the per-camera buffering right
  // away rather than waiting for a Save. The numeric fields below keep Save, so their shape says so.
  async function toggleOndemand(enabled) {
    // Disabled while in flight (below) makes this unreachable from a second click, but guard it here
    // too: nothing else prevents two requests from overlapping and having their responses land out of
    // order, each one's optimistic/committed value stomping the other's (Codex F2).
    //
    // Also refuse while a Save is in flight (`busy`), not just another toggle: both handlers commit a
    // FULL settings snapshot from their own PUT response (see commit() in SettingsContext.jsx). If the
    // toggle's PUT is sent, then Save's PUT is sent and its response lands and commits first (clearing
    // the numeric drafts via markSaved), the toggle's response — a snapshot taken BEFORE the save — can
    // still land after and commit, reverting the just-saved numeric values on screen and setting up the
    // next Save to write the stale numbers back over the server. The Switch is also `disabled` while
    // `busy` below, but the guard belongs here too for the same reason toggleBusy is checked above: a
    // disabled prop only stops a click, not a request already on its way.
    if (toggleBusy || busy) return;
    setToggleBusy(true);
    setPendingOndemand(enabled); // optimistic
    setError('');
    try {
      const response = await api.put('/settings', { ondemand_enabled: enabled });
      if (response && typeof response === 'object') {
        // The PUT response is this write's own confirmation — see SettingsContext's commit() for why
        // that's used instead of a second, separate refresh() that could fail on its own.
        commit(response);
        setPendingOndemand(null);
      } else {
        // Defensive: the route always answers with the settings object (see commit's comment). If it
        // ever didn't, fall back to a re-read rather than trust an empty/malformed body — and leave
        // pendingOndemand as-is so the switch doesn't flicker back to the old value before that
        // re-read lands.
        await refresh();
      }
    } catch (err) {
      setPendingOndemand(null); // put it back — the switch reads settings.ondemand_enabled again
      setError(err.message || 'Could not change that setting');
    } finally {
      setToggleBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    // Mirrors the guard in toggleOndemand (#449): both handlers commit a full settings snapshot from
    // their own PUT response, so an overlapping Save + toggle race can have the toggle's stale,
    // pre-save snapshot land and commit AFTER Save's, reverting the numbers this Save just wrote. The
    // Save button is also `disabled` while `toggleBusy` below, but a disabled prop only blocks a click
    // that hasn't fired yet — this refuses a submit already in progress (e.g. Enter in a field) too.
    if (toggleBusy) return;
    setBusy(true);
    setError('');
    const payload = {
      clip_pre_roll_s: form.clip_pre_roll_s,
      clip_post_roll_s: form.clip_post_roll_s,
      clip_retention_days: form.clip_retention_days,
      clip_retention_max_gb: form.clip_retention_max_gb,
      wake_clips_enabled: wakeClipsOn,
      wake_clip_seconds: form.wake_clip_seconds,
      wake_clip_retention_days: form.wake_clip_retention_days,
      ondemand_pre_roll_s: form.ondemand_pre_roll_s,
      ondemand_max_duration_s: form.ondemand_max_duration_s,
    };
    try {
      const response = await api.put('/settings', payload);
      if (response && typeof response === 'object') {
        // As in toggleOndemand: commit this write's own response instead of a second refresh() that
        // could fail silently and leave a stale value ready to be re-saved over the real one (#449
        // Codex F1). markSaved runs only once the committed base actually reflects what was sent, so
        // a saved draft can drop cleanly rather than possibly re-appearing dirty against a base that
        // hasn't caught up yet.
        commit(response);
        markSaved(payload);
      } else {
        // Defensive fallback — see toggleOndemand. Drafts stay dirty: nothing has confirmed the save
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

  // pendingOndemand is this screen's own optimistic value; null means "no request in flight, use
  // what's committed." Deliberately `??`, not `||` — see the module comment on wakeClipsOn below.
  const ondemandOn = pendingOndemand ?? (form.ondemand_enabled ?? true);
  const wakeClipsOn = form.wake_clips_enabled ?? true;

  return (
    <>
      <AppHeader title="Recording" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}

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
                disabled={toggleBusy || busy}
                onChange={(e) => toggleOndemand(e.target.checked)}
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

          <button className="btn btn-primary" type="submit" disabled={busy || toggleBusy} style={{ marginTop: 20 }}>
            {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'}
          </button>
        </form>
      </main>
    </>
  );
}
