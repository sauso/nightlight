import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLater } from '../lib/useLater.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { getCommonTimezones } from '../lib/greeting.js';
import { FONT_PRESETS } from '../lib/fonts.js';
import AppHeader from '../components/AppHeader.jsx';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
import { loadDraft } from '../lib/formDraft.js';
import { useDraftKey, useFormDraft } from '../lib/useFormDraft.js';
import { useSettingsDraft } from '../lib/useSettingsDraft.js';

const PRESETS = [
  { label: 'Nursery (default)', accent: '#f4c56a', live: '#7FBFA3', offline: '#E08585' },
  { label: 'Dusk lavender', accent: '#C9B6F5', live: '#7FBFA3', offline: '#E08585' },
  { label: 'Ocean calm', accent: '#8FD1E0', live: '#7FBFA3', offline: '#E0A57F' },
  { label: 'Rose quartz', accent: '#F5B8C6', live: '#8FBF9F', offline: '#E08585' },
];

// The fields this screen edits: what Save sends, and what a reload-surviving draft may store (#377). All plain
// strings, no secrets on this page.
const DRAFT_FIELDS = ['app_name', 'timezone', 'font_choice', 'accent_color', 'live_color', 'offline_color', 'temp_unit'];

const valuesOf = (src) => Object.fromEntries(DRAFT_FIELDS.map((k) => [k, src[k]]));

export default function SettingsGeneral() {
  const { settings, refresh, commit, loaded } = useSettings();
  // Server settings vs. this screen's own unsaved edits, kept separate (#377, the #449 pattern from the Recording
  // screen). This page used to copy `settings` into its form in an effect on every change, so ANY refresh of the
  // context (a background poll, a save on another screen) silently overwrote what was being typed.
  const draftKey = useDraftKey('settings:general');
  // Read once on mount: edits typed before a background reload, or before a visit to another screen.
  const [restoredDraft] = useState(() => loadDraft(draftKey, DRAFT_FIELDS));
  const { form, setField, setFields, markSaved, discard } = useSettingsDraft(settings, restoredDraft || {});
  const [restored, setRestored] = useState(!!restoredDraft);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const later = useLater(); // blanks the "Saved" tick; cancelled when the page goes away (#855)
  const [busy, setBusy] = useState(false);
  const [timezones] = useState(getCommonTimezones);

  // `ready` waits for the server's settings: until then `settings` is the provider's placeholder (a placeholder
  // timezone and colours), and a restored draft that happens to equal one would read as "no change" and be
  // cleared from storage, one reload from lost.
  const unsaved = useFormDraft({ key: draftKey, allow: DRAFT_FIELDS, form: valuesOf(form), baseline: valuesOf(settings), ready: loaded !== false });

  function discardChanges() {
    discard();
    setRestored(false);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      // Only the general fields — the settings PUT keeps any field left out unchanged (each one falls
      // back to its stored value when the key is absent, see routes/settings.js), so MQTT and
      // Recording, which have their own sub-pages, aren't touched from here.
      //
      // ⚠️ Send ONLY what this screen actually shows. It used to also post ondemand_enabled,
      // ondemand_pre_roll_s and ondemand_max_duration_s — left behind when on-demand recording moved
      // out to its own page. Writing back a setting nobody can see here is never useful and is
      // occasionally harmful: the Recording page's switch applies the instant it is flipped, so a
      // General page still holding the old value would silently revert it on its next Save, with
      // nothing shown to either person.
      const payload = valuesOf(form);
      const response = await api.put('/settings', payload);
      if (response && typeof response === 'object') {
        // Commit this write's own response, as the Recording screen does, instead of a second refresh() that could
        // fail silently and leave the old value in the context: with drafts, the edit would then be dropped as
        // "saved" while the field reverted on screen. markSaved only drops a draft that still equals what was sent.
        commit(response);
        markSaved(payload);
      } else {
        // Defensive fallback (the route always answers with the settings object): drafts stay, nothing has
        // confirmed the save landed.
        await refresh();
      }
      setSaved(true);
      later(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function useBrowserTimezone() {
    setField('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  function applyPreset(preset) {
    setFields({ accent_color: preset.accent, live_color: preset.live, offline_color: preset.offline });
  }

  return (
    <>
      <AppHeader title="General" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}
        {unsaved && <UnsavedNotice restored={restored} onDiscard={discardChanges} />}

        <form onSubmit={save}>
          <div className="card">
            <div className="card-title">General Settings</div>
            <div className="field">
              <label htmlFor="app-name">App name</label>
              <input
                id="app-name"
                value={form.app_name || ''}
                onChange={(e) => setField('app_name', e.target.value)}
                required
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="timezone">Timezone</label>
              <select
                id="timezone"
                value={form.timezone || ''}
                onChange={(e) => setField('timezone', e.target.value)}
              >
                {!timezones.includes(form.timezone) && (
                  <option value={form.timezone}>{form.timezone}</option>
                )}
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
              <button
                type="button"
                className="icon-btn"
                style={{ padding: '8px 0 0' }}
                onClick={useBrowserTimezone}
              >
                Use this device's timezone
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Theme presets</div>
            <div className="preset-row" style={{ marginBottom: 0 }}>
              {PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.label}
                  className="preset-btn"
                  onClick={() => applyPreset(preset)}
                  title={preset.label}
                >
                  <span style={{ background: preset.accent }} />
                  <span style={{ background: preset.live }} />
                  <span style={{ background: preset.offline }} />
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-title">Font</div>
            <div className="font-row" style={{ marginBottom: 0 }}>
              {Object.entries(FONT_PRESETS).map(([key, preset]) => (
                <button
                  type="button"
                  key={key}
                  className={`font-btn${form.font_choice === key ? ' font-btn--active' : ''}`}
                  onClick={() => setField('font_choice', key)}
                >
                  <span className="font-btn__sample" style={{ fontFamily: preset.display }}>
                    {preset.sample}
                  </span>
                  <span className="font-btn__label">{preset.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-title">Colors</div>
            <div className="color-field">
              <label htmlFor="accent-color">Accent (buttons, highlights)</label>
              <div className="color-field__row">
                <input
                  id="accent-color"
                  type="color"
                  value={form.accent_color || '#000000'}
                  onChange={(e) => setField('accent_color', e.target.value)}
                />
                <span className="camera-tile__sub">{form.accent_color}</span>
              </div>
            </div>
            <div className="color-field">
              <label htmlFor="live-color">Live indicator</label>
              <div className="color-field__row">
                <input
                  id="live-color"
                  type="color"
                  value={form.live_color || '#000000'}
                  onChange={(e) => setField('live_color', e.target.value)}
                />
                <span className="camera-tile__sub">{form.live_color}</span>
              </div>
            </div>
            <div className="color-field">
              <label htmlFor="offline-color">Offline / alert</label>
              <div className="color-field__row">
                <input
                  id="offline-color"
                  type="color"
                  value={form.offline_color || '#000000'}
                  onChange={(e) => setField('offline_color', e.target.value)}
                />
                <span className="camera-tile__sub">{form.offline_color}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Temperature unit</div>
            <div className="preset-row" style={{ marginBottom: 0 }}>
              <button
                type="button"
                className={`font-btn${form.temp_unit === 'C' ? ' font-btn--active' : ''}`}
                onClick={() => setField('temp_unit', 'C')}
              >
                <span className="font-btn__label">°C</span>
              </button>
              <button
                type="button"
                className={`font-btn${form.temp_unit === 'F' ? ' font-btn--active' : ''}`}
                onClick={() => setField('temp_unit', 'F')}
              >
                <span className="font-btn__label">°F</span>
              </button>
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 20 }}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </main>
    </>
  );
}
