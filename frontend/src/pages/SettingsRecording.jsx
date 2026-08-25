import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
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
  const { settings, refresh } = useSettings();
  const [form, setForm] = useState({});
  const [storage, setStorage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const loadStorage = () => api.get('/settings/clip-storage').then(setStorage).catch(() => {});
  useEffect(() => { loadStorage(); }, []);
  useEffect(() => { if (settings) setForm(settings); }, [settings]);

  // The on/off switch applies the moment it's flipped — that's what the pill shape promises in this
  // codebase (see Switch.jsx), and turning the feature off should stop the per-camera buffering right
  // away rather than waiting for a Save. The numeric fields below keep Save, so their shape says so.
  async function toggleOndemand(enabled) {
    setForm((f) => ({ ...f, ondemand_enabled: enabled })); // optimistic
    setError('');
    try {
      await api.put('/settings', { ondemand_enabled: enabled });
      await refresh();
    } catch (err) {
      setForm((f) => ({ ...f, ondemand_enabled: !enabled })); // put it back
      setError(err.message || 'Could not change that setting');
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.put('/settings', {
        clip_pre_roll_s: form.clip_pre_roll_s,
        clip_post_roll_s: form.clip_post_roll_s,
        clip_retention_days: form.clip_retention_days,
        clip_retention_max_gb: form.clip_retention_max_gb,
        ondemand_pre_roll_s: form.ondemand_pre_roll_s,
        ondemand_max_duration_s: form.ondemand_max_duration_s,
      });
      await refresh();
      loadStorage();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const ondemandOn = form.ondemand_enabled ?? true;

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
                  onChange={(e) => setForm({ ...form, clip_pre_roll_s: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="clip-post">Post-roll (seconds)</label>
                <input id="clip-post" type="number" min="5" max="120"
                  value={form.clip_post_roll_s ?? 15}
                  onChange={(e) => setForm({ ...form, clip_post_roll_s: e.target.value })} />
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
                  onChange={(e) => setForm({ ...form, clip_retention_days: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="clip-gb">Storage cap (GB)</label>
                <input id="clip-gb" type="number" min="0" max="2000"
                  value={form.clip_retention_max_gb ?? 5}
                  onChange={(e) => setForm({ ...form, clip_retention_max_gb: e.target.value })} />
              </div>
            </div>
            <div className="camera-tile__sub" style={{ marginTop: 10 }}>
              Oldest clips are deleted once either limit is passed (0 turns that limit off). The alert
              and its snapshot stay — only the video is removed. <strong>This does not apply to your own
              recordings below</strong>, which are kept until you delete them.
            </div>
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
                      onChange={(e) => setForm({ ...form, ondemand_pre_roll_s: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="ond-max">Auto-stop after (seconds)</label>
                    <input id="ond-max" type="number" min="5" max="600"
                      value={form.ondemand_max_duration_s ?? 120}
                      onChange={(e) => setForm({ ...form, ondemand_max_duration_s: e.target.value })} />
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
