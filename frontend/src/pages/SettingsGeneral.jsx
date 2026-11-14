import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLater } from '../lib/useLater.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { getCommonTimezones } from '../lib/greeting.js';
import AppHeader from '../components/AppHeader.jsx';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
import { loadDraft } from '../lib/formDraft.js';
import { useDraftKey, useFormDraft } from '../lib/useFormDraft.js';
import { useSettingsDraft } from '../lib/useSettingsDraft.js';

// The fields this screen edits: what Save sends, and what a reload-surviving draft may store (#377). All plain
// strings, no secrets on this page.
const DRAFT_FIELDS = ['app_name', 'timezone', 'temp_unit'];

const valuesOf = (src) => Object.fromEntries(DRAFT_FIELDS.map((k) => [k, src[k]]));

export default function SettingsGeneral() {
  const { settings, refresh, commit, loaded } = useSettings();
  // Server settings vs. this screen's own unsaved edits, kept separate (#377, the #449 pattern from the Recording
  // screen). This page used to copy `settings` into its form in an effect on every change, so ANY refresh of the
  // context (a background poll, a save on another screen) silently overwrote what was being typed.
  const draftKey = useDraftKey('settings:general');
  // Read once on mount: edits typed before a background reload, or before a visit to another screen.
  const [restoredDraft] = useState(() => loadDraft(draftKey, DRAFT_FIELDS));
  const { form, setField, markSaved, discard } = useSettingsDraft(settings, restoredDraft || {});
  const [restored, setRestored] = useState(!!restoredDraft);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const later = useLater(); // blanks the "Saved" tick; cancelled when the page goes away (#855)
  const [busy, setBusy] = useState(false);
  const [timezones] = useState(getCommonTimezones);

  // `ready` waits for the server's settings: until then `settings` is the provider's placeholder (a placeholder
  // timezone), and a restored draft that happens to equal one would read as "no change" and be
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

  return (
    <>
      <AppHeader title="General" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}
        {unsaved && <UnsavedNotice restored={restored} onDiscard={discardChanges} />}

        <form onSubmit={save}>
          <div className="card">
            <h2 className="card-heading">General settings</h2>
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
            <h2 className="card-heading">Temperature unit</h2>
            <div className="seg-track" role="group" aria-label="Temperature unit">
              <button
                type="button"
                className={`seg-track__btn${form.temp_unit === 'C' ? ' seg-track__btn--active' : ''}`}
                aria-pressed={form.temp_unit === 'C'}
                onClick={() => setField('temp_unit', 'C')}
              >
                <span>°C</span>
              </button>
              <button
                type="button"
                className={`seg-track__btn${form.temp_unit === 'F' ? ' seg-track__btn--active' : ''}`}
                aria-pressed={form.temp_unit === 'F'}
                onClick={() => setField('temp_unit', 'F')}
              >
                <span>°F</span>
              </button>
            </div>
          </div>

          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </main>
    </>
  );
}
