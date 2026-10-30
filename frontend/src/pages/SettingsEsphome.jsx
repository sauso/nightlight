import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useLater } from '../lib/useLater.js';
import AppHeader from '../components/AppHeader.jsx';
import Modal from '../components/Modal.jsx';
import Switch from '../components/Switch.jsx';
import { saveTextDownload } from '../lib/saveTextDownload.js';
import {
  MAX_DEVICES, RETENTION_DEFAULT_DAYS, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS, validRetention,
  stateBadge, encryptionNote, relativeAge, exportRange, dayString, EXPORT_MAX_DAYS,
} from '../lib/esphomeUi.js';

// How often the device list (and an open entity list) is re-read. Status changes on the order of seconds to minutes,
// and every read costs the server a few small queries per device, so this is a judgment, not a measurement.
const POLL_MS = 10000;

// A read that repeats itself while the page is open (the device list, an open entity list).
//
// Single-flight, and stale replies are dropped: the default request timeout is 30 s and the interval is 10 s, so
// without this two reads can overlap, and an older answer arriving after a newer one would put old status back on
// screen, or bring back a device that had just been deleted (Codex plan review of this page). Each read takes a
// number; only the newest read's answer is used. A tick while a read is in flight does nothing, but a forced
// `reload` (after a save or a delete) starts at once and takes a new number, which is also what makes the read it
// overtook stale. A failed read keeps the last good data: `error` is set beside it, so the page never turns a hiccup
// into "no devices".
function usePolled(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const inFlight = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async (force = false) => {
    if (inFlight.current && !force) return;
    const mine = ++seq.current;
    inFlight.current = true;
    try {
      const result = await api.get(path);
      if (!alive.current || mine !== seq.current) return;
      setData(result);
      setError('');
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(err.message || 'Could not load.');
    } finally {
      if (mine === seq.current) inFlight.current = false;
    }
  }, [path]);

  useEffect(() => {
    // Set again, not just initialised: StrictMode runs the cleanup and then the mount once in dev.
    alive.current = true;
    load();
    // A hidden tab is not looking at it; read again the moment it is shown.
    const tick = () => { if (document.visibilityState !== 'hidden') load(); };
    const id = setInterval(tick, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  return { data, error, setData, reload };
}

// An IPv6 address is shown and edited in brackets, the form the server's host check expects (routes/esphome.js).
const hostLabel = (host) => (String(host).includes(':') ? `[${host}]` : host);

export default function SettingsEsphome() {
  const devices = usePolled('/esphome/devices');
  const [children, setChildren] = useState([]);
  const [childrenFailed, setChildrenFailed] = useState(false);
  const [dialog, setDialog] = useState(null); // { kind: 'form', device? } | { kind: 'delete', device } | { kind: 'export', device }
  const [saved, setSaved] = useState('');
  const later = useLater();

  useEffect(() => {
    api.get('/children').then((r) => setChildren(Array.isArray(r) ? r : [])).catch(() => setChildrenFailed(true));
  }, []);

  const list = Array.isArray(devices.data) ? devices.data : null;
  const full = !!list && list.length >= MAX_DEVICES;
  const childName = (id) => (id ? (children.find((c) => c.id === id)?.name || 'A child') : 'No child');

  function flash(message) {
    setSaved(message);
    later(() => setSaved(''), 2500);
  }
  function afterSave() {
    setDialog(null);
    devices.reload();
    flash('Saved ✓');
  }
  function afterDelete(id) {
    setDialog(null);
    // Gone from the screen at once. A read that was already in flight started before the delete and would put the
    // device back; the reload below takes a newer number, so that answer is dropped (tested).
    devices.setData((d) => (Array.isArray(d) ? d.filter((x) => x.id !== id) : d));
    devices.reload();
    flash('Device deleted');
  }

  return (
    <>
      <AppHeader title="ESPHome" back={{ to: '/settings/integrations', label: 'Integrations' }} />
      <main className="app-main">
        {saved && <div className="saved-banner">{saved}</div>}

        <div className="card">
          <div className="camera-tile__sub">
            Connects straight to an ESPHome device (its Native API, port 6053 unless you change it) and records what
            its sensors report, so you can see whether the readings are useful. Nightlight only reads: it never sends
            anything to the device, and the readings are not used in any sleep number or alert. They are what the
            sensor reports, not a medical measurement, and Nightlight is not a medical or safety device. Give the
            device a fixed IP address; names ending in <code>.local</code> do not work from inside the container.
          </div>
        </div>

        {list === null && !devices.error && <div className="camera-tile__sub" role="status">Loading…</div>}
        {list === null && devices.error && (
          <div className="error-banner" role="alert">
            {devices.error}{' '}
            <button type="button" className="btn btn-secondary btn-sm" style={{ width: 'auto' }} onClick={devices.reload}>Try again</button>
          </div>
        )}
        {list && devices.error && (
          <div className="camera-tile__sub" role="status" style={{ marginBottom: 8 }}>
            Could not refresh just now. Showing the last status received.
          </div>
        )}
        {list && list.length === 0 && (
          <div className="card camera-tile__sub">No devices yet. Add one to start collecting readings.</div>
        )}
        {list && list.map((device) => (
          <DeviceCard key={device.id} device={device} childName={childName(device.child_id)}
            onEdit={() => setDialog({ kind: 'form', device })}
            onDelete={() => setDialog({ kind: 'delete', device })}
            onExport={() => setDialog({ kind: 'export', device })} />
        ))}

        {list && (
          <div style={{ marginBottom: 14 }}>
            <button type="button" className="btn btn-primary" disabled={full} onClick={() => setDialog({ kind: 'form' })}>
              Add a device
            </button>
            {full && <div className="camera-tile__sub" style={{ marginTop: 6 }}>You have reached the limit of {MAX_DEVICES} devices.</div>}
          </div>
        )}

        <RetentionCard flash={flash} />

        {dialog?.kind === 'form' && (
          <DeviceFormModal device={dialog.device} childOptions={children} childrenFailed={childrenFailed}
            onClose={() => setDialog(null)} onSaved={afterSave} />
        )}
        {dialog?.kind === 'delete' && (
          <DeleteModal device={dialog.device} onClose={() => setDialog(null)} onDeleted={() => afterDelete(dialog.device.id)} />
        )}
        {dialog?.kind === 'export' && <ExportModal device={dialog.device} onClose={() => setDialog(null)} />}
      </main>
    </>
  );
}

function DeviceCard({ device, childName, onEdit, onDelete, onExport }) {
  const [entitiesOpen, setEntitiesOpen] = useState(false);
  const [test, setTest] = useState(null);
  const badge = stateBadge(device);
  const enc = encryptionNote(device);
  const status = device.status || {};
  const age = relativeAge(status.last_row_at);
  const showError = status.error && (status.state === 'failed' || status.state === 'disconnected');

  async function runTest() {
    setTest('running');
    try {
      setTest(await api.post('/esphome/test', { device_id: device.id }));
    } catch (err) {
      // The server's refusals (a test already running, a failed connection) carry their own fixed sentences.
      setTest({ ok: false, error: err.message });
    }
  }

  return (
    <div className="card esphome-device">
      <div className="esphome-device__head">
        <div className="esphome-device__title">{device.name}</div>
        <span className={`status-badge ${badge.cls}`}>{badge.text}</span>
      </div>
      <div className="camera-tile__sub">{hostLabel(device.host)}:{device.port} · {childName}</div>
      <div className={`camera-tile__sub${enc.warn ? ' esphome-warn' : ''}`}>{enc.text}</div>
      {showError && <div className="error-banner" role="status" style={{ marginTop: 8 }}>{status.error}</div>}
      <div className="camera-tile__sub">
        Last reading: {age || 'none yet'} · {status.rows_last_hour ?? 0} in the last hour · {status.entity_count ?? 0} sensors
      </div>
      <div className="esphome-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit}>Edit</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={runTest} disabled={test === 'running'}>Test</button>
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={entitiesOpen}
          onClick={() => setEntitiesOpen((o) => !o)}>{entitiesOpen ? 'Hide sensors' : 'Sensors'}</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onExport}>Download CSV</button>
        <button type="button" className="btn btn-danger btn-sm" onClick={onDelete}>Delete</button>
      </div>
      {test && <TestResult result={test} />}
      {entitiesOpen && <Entities device={device} />}
    </div>
  );
}

function TestResult({ result }) {
  if (result === 'running') return <div className="camera-tile__sub" role="status" style={{ marginTop: 8 }}>Testing the connection…</div>;
  if (!result.ok) return <div className="error-banner" role="status" style={{ marginTop: 8 }}>{result.error || 'The test failed.'}</div>;
  const n = Array.isArray(result.entities) ? result.entities.length : null;
  return (
    <div className={`camera-tile__sub${result.encrypted ? '' : ' esphome-warn'}`} role="status" style={{ marginTop: 8 }}>
      Connected{result.encrypted ? ' and encrypted' : ', but the connection is not encrypted: anyone on your network can read it'}
      {n !== null ? ` · ${n} sensors found` : ''}.
    </div>
  );
}

// What the server's category guess is called on screen. Anything else falls back to the entity's own name alone.
const CATEGORY_LABELS = {
  heart_rate: 'Heart rate', respiratory_rate: 'Breathing rate', target_number: 'Targets', occupancy: 'Presence',
  distance: 'Distance', illuminance: 'Light', temperature: 'Temperature', humidity: 'Humidity',
};
function ageText(seconds) {
  if (seconds == null) return 'no update yet';
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}
function valueText(entity) {
  const v = entity.value;
  if (v === null || v === undefined) return 'no reading yet';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return `${Number.isInteger(v) ? v : v.toFixed(1)}${entity.unit ? ` ${entity.unit}` : ''}`;
  return String(v);
}

function Entities({ device }) {
  const entities = usePolled(`/esphome/devices/${device.id}/entities`);
  if (entities.data === null) {
    return <div className="camera-tile__sub" role="status" style={{ marginTop: 8 }}>{entities.error || 'Loading…'}</div>;
  }
  if (entities.data.length === 0) {
    return <div className="camera-tile__sub" style={{ marginTop: 8 }}>No sensors found yet. They appear once the device connects.</div>;
  }
  return (
    <ul className="esphome-entities">
      {entities.data.map((e) => (
        <li key={e.id}>
          <span className="esphome-entities__name">
            {e.name || e.object_id}
            {CATEGORY_LABELS[e.category] ? <span className="camera-tile__sub"> · {CATEGORY_LABELS[e.category]}</span> : null}
          </span>
          <span className="camera-tile__sub">{valueText(e)} · {ageText(e.age_s)}</span>
        </li>
      ))}
    </ul>
  );
}

// Add or edit one device. The encryption key is the one secret here, so it lives ONLY in this component's state while
// the dialog is open: never in a stored draft (the MQTT page keeps its password out of browser storage the same way),
// never in a URL, never read back (the server returns `key_set`, not the key), and gone when the dialog closes.
function DeviceFormModal({ device, childOptions, childrenFailed, onClose, onSaved }) {
  const editing = !!device;
  const [name, setName] = useState(device?.name || '');
  const [host, setHost] = useState(device ? hostLabel(device.host) : '');
  const [port, setPort] = useState(device ? String(device.port) : '');
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [childId, setChildId] = useState(device?.child_id || '');
  const [enabled, setEnabled] = useState(device ? device.enabled : true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);

  // The port is left out when blank, so the server uses 6053 (or keeps the saved one when editing).
  function portProblem() {
    if (port.trim() === '') return '';
    const n = Number(port);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? '' : 'The port must be a whole number from 1 to 65535.';
  }
  function body() {
    const out = { host: host.trim() };
    if (port.trim() !== '') out.port = Number(port);
    if (key.trim()) out.key = key.trim();
    else if (editing && clearKey) out.clear_key = true;
    return out;
  }

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setError('Give the device a name.');
    if (!host.trim()) return setError("Enter the device's IP address.");
    const problem = portProblem();
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      const payload = { name: name.trim(), enabled, child_id: childId || null, ...body() };
      if (editing) await api.put(`/esphome/devices/${device.id}`, payload);
      else await api.post('/esphome/devices', payload);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    const problem = host.trim() ? portProblem() : "Enter the device's IP address.";
    if (problem) return setTest({ ok: false, error: problem });
    setTest('running');
    try {
      setTest(await api.post('/esphome/test', body()));
    } catch (err) {
      setTest({ ok: false, error: err.message });
    }
  }

  return (
    <Modal title={editing ? 'Edit device' : 'Add a device'} onClose={onClose} error={error}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="esphome-name">Name</label>
          <input id="esphome-name" maxLength={100} placeholder="Your own label for it" data-autofocus
            value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="esphome-host">IP address</label>
          <input id="esphome-host" placeholder="e.g. 192.168.1.60" autoComplete="off" spellCheck={false}
            value={host} onChange={(e) => setHost(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="esphome-port">Port</label>
          <input id="esphome-port" type="number" min="1" max="65535" placeholder="6053"
            value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="esphome-key">Encryption key (optional)</label>
          <input id="esphome-key" type="password" autoComplete="off" spellCheck={false}
            placeholder={editing && device.key_set ? 'Leave blank to keep the stored key' : 'Paste the key from the device’s configuration'}
            value={key} onChange={(e) => setKey(e.target.value)} />
          <div className="camera-tile__sub" style={{ marginTop: 6 }}>
            Found in the device’s YAML under <code>api: encryption: key:</code>. With a key, Nightlight refuses a
            connection that is not encrypted. Without one, anyone on your network can read the readings.
          </div>
        </div>
        {editing && device.key_set && (
          <label className="log-viewer__toggle" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={clearKey && !key.trim()} disabled={!!key.trim()}
              onChange={(e) => setClearKey(e.target.checked)} />
            Remove the stored key
          </label>
        )}
        <div className="field">
          <label htmlFor="esphome-child">Child</label>
          <select id="esphome-child" value={childId} onChange={(e) => setChildId(e.target.value)}>
            <option value="">No child</option>
            {childOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="camera-tile__sub" style={{ marginTop: 6 }}>
            {childrenFailed ? 'Children could not be loaded, so none can be chosen right now. ' : ''}
            Readings are kept under this child. Moving the device to another child later leaves its earlier readings with the first.
          </div>
        </div>
        <label className="log-viewer__toggle" style={{ marginBottom: 12 }}>
          <Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Collect readings from this device
        </label>
        {!editing && (
          <div style={{ marginBottom: 12 }}>
            <button type="button" className="btn btn-secondary btn-sm" style={{ width: 'auto' }}
              onClick={runTest} disabled={test === 'running'}>Test connection</button>
            {test && <TestResult result={test} />}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" style={{ width: 'auto' }} type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ width: 'auto' }} type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteModal({ device, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await api.del(`/esphome/devices/${device.id}`);
      onDeleted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Delete this device?" placement="top" onClose={onClose} error={error}>
      <p style={{ marginTop: 0 }}>
        This stops collecting from “{device.name}” and <strong>deletes all the readings stored for it</strong>. This
        cannot be undone. Download a CSV first if you want to keep them.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" style={{ width: 'auto' }} type="button" data-autofocus onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" style={{ width: 'auto' }} type="button" disabled={busy} onClick={confirm}>
          {busy ? 'Deleting…' : 'Delete device and readings'}
        </button>
      </div>
    </Modal>
  );
}

const mb = (bytes) => (bytes < 1048576 ? 'under 1 MB' : `${(bytes / 1048576).toFixed(1)} MB`);

// A CSV of one device's readings for up to 31 UTC days. The dates are UTC days on purpose (the file's own times are
// UTC, and nothing here may assume the timezone of whoever installed this); the last day is included. What the size
// guard does and why is in lib/esphomeUi.js.
function ExportModal({ device, onClose }) {
  const [from, setFrom] = useState(dayString(Date.now() - 6 * 86400000)); // the last 7 days by default
  const [to, setTo] = useState(dayString(Date.now()));
  const [state, setState] = useState('idle'); // idle | busy | done
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const busyRef = useRef(false);
  const later = useLater();
  const range = exportRange(from, to, device.status?.entity_count);

  async function download() {
    if (busyRef.current) return; // a second tap while the file is being prepared
    if (!range.ok) { setError(range.error); return; }
    busyRef.current = true;
    setState('busy');
    setError('');
    try {
      const text = await api.getText(`/esphome/export?device=${device.id}&from=${range.from}&to=${range.to}`);
      setMessage(await saveTextDownload(`esphome-${device.id}-${from}-to-${to}.csv`, text, 'text/csv'));
      setState('done');
      // Stay disabled for a moment, so a slow save on a phone does not look like nothing happened.
      later(() => { setState('idle'); setMessage(''); busyRef.current = false; }, 4000);
    } catch (err) {
      setError(err.message || 'Could not download the file.');
      setState('idle');
      busyRef.current = false;
    }
  }

  return (
    <Modal title="Download readings" onClose={onClose} error={error}>
      <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
        A CSV file of this device’s readings, one row per sensor per minute, up to {EXPORT_MAX_DAYS} days at a time. Days
        are UTC, and so are the times in the file. The <code>device</code> column is the device’s number, not its name.
      </div>
      <div className="esphome-dates">
        <div className="field">
          <label htmlFor="esphome-from">From (UTC day)</label>
          <input id="esphome-from" type="date" value={from} onChange={(e) => { setError(''); setFrom(e.target.value); }} />
        </div>
        <div className="field">
          <label htmlFor="esphome-to">To (UTC day, included)</label>
          <input id="esphome-to" type="date" value={to} onChange={(e) => { setError(''); setTo(e.target.value); }} />
        </div>
      </div>
      {range.ok && (
        <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
          {range.days} day{range.days === 1 ? '' : 's'}, at most about {mb(range.bytes)}.
        </div>
      )}
      {!range.ok && <div className="camera-tile__sub" role="status" style={{ marginBottom: 10 }}>{range.error}</div>}
      {message && <div className="camera-tile__sub" role="status" style={{ marginBottom: 10 }}>{message}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" style={{ width: 'auto' }} type="button" onClick={onClose}>Close</button>
        <button className="btn btn-primary" style={{ width: 'auto' }} type="button" data-autofocus
          disabled={state !== 'idle' || !range.ok} onClick={download}>
          {state === 'busy' ? 'Preparing…' : state === 'done' ? 'Downloaded ✓' : 'Download'}
        </button>
      </div>
    </Modal>
  );
}

function RetentionCard({ flash }) {
  const [value, setValue] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/esphome/settings').then((r) => {
      setValue(String(r?.retention_days ?? RETENTION_DEFAULT_DAYS));
      setLoaded(true);
    }).catch(() => setLoadFailed(true));
  }, []);

  async function save(e) {
    e.preventDefault();
    if (!validRetention(value)) return setError(`Enter a whole number of days from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}.`);
    setBusy(true);
    setError('');
    try {
      await api.put('/esphome/settings', { retention_days: Number(value) });
      flash('Saved ✓');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="sleep-detail__section-title">Keeping readings</div>
      <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
        Older readings are deleted automatically. A device with 5 numeric sensors and 1 on/off sensor adds roughly 0.4 MB
        a day (an estimate, not a measurement of your sensors).
      </div>
      {loadFailed && <div className="error-banner" role="alert">Could not load this setting.</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor="esphome-retention">Days to keep ({RETENTION_MIN_DAYS}–{RETENTION_MAX_DAYS}, default {RETENTION_DEFAULT_DAYS})</label>
        <input id="esphome-retention" type="number" min={RETENTION_MIN_DAYS} max={RETENTION_MAX_DAYS} step="1"
          value={value} disabled={!loaded} onChange={(e) => setValue(e.target.value)} />
      </div>
      <button className="btn btn-primary" type="submit" disabled={!loaded || busy}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}
