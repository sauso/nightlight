import { useEffect, useState } from 'react';
import { useAuth } from '../lib/AuthContext.jsx';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import Modal from './Modal.jsx';

const reasons = {
  tracking_off: 'Sleep tracking is off',
  no_saved_settings: 'Saved settings are unavailable',
  has_review: 'Someone reviewed this night',
  owned_by_nightly_job: 'The nightly job is still updating it',
  partial_data: 'Some minute data is missing',
  reviewed: 'Someone corrected this night',
  stored_camera_missing: 'The saved camera is missing',
  would_downgrade: 'Not enough data remains to score it',
  would_blank_notified_wake: 'Its reported wake time would disappear',
  would_become_empty: 'The night would become empty',
  error: 'Could not work out this night',
};

function summary(row) {
  return `asleep ${row.asleep_minutes ?? '—'} min, wakes ${row.wake_count ?? '—'}, onset ${row.onset_at ?? '—'}, wake ${row.wake_at ?? '—'}`;
}
const nightCount = (count) => `${count} ${count === 1 ? 'night' : 'nights'}`;

export default function UpdatePastNights() {
  const { user } = useAuth();
  const [latest, setLatest] = useState(null);
  const [report, setReport] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    let alive = true;
    api.get('/settings/sleep-rewrite').then((data) => { if (alive) setLatest(data); }).catch(() => {});
    return () => { alive = false; };
  }, [user?.role]);

  if (user?.role !== 'admin') return null;

  async function check() {
    setBusy(true);
    setError('');
    setNotice('');
    setReport(null);
    setDone(false);
    setOpen(true);
    try {
      setReport(await api.post('/settings/sleep-rewrite', { apply: false }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function update() {
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/settings/sleep-rewrite', { apply: true, expect: report.preview },
        { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      setReport(result);
      setLatest(await api.get('/settings/sleep-rewrite'));
      setDone(true);
    } catch (e) {
      setError(e.message.includes('changed since') ? 'Past nights changed since the check. Check what would change again.' : e.message);
      setReport(null);
    } finally { setBusy(false); }
  }

  async function undo() {
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/settings/sleep-rewrite/undo', { batch_id: latest.batch_id },
        { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      setLatest(await api.get('/settings/sleep-rewrite'));
      setReport(null);
      setDone(false);
      setOpen(true);
      setNotice(`Restored ${nightCount(result.restored)}.${Object.keys(result.skipped).length ? ' Some nights were saved or reviewed since and were left alone.' : ''}`);
    } catch (e) { setOpen(true); setError(e.message); }
    finally { setBusy(false); }
  }

  return <>
    <section className="card">
      <h2 className="card-heading">Update past nights</h2>
      <p>After sleep scoring changes, check saved nights and choose whether to update them. Nothing runs by itself.</p>
      <button type="button" className="btn btn-secondary" onClick={check} disabled={busy}>Check what would change</button>
      {latest?.undoable && <button type="button" className="btn btn-secondary" onClick={undo} disabled={busy}>Undo these changes</button>}
    </section>
    {open && <Modal title="Update past nights" onClose={() => setOpen(false)} error={error}>
      {notice && <p role="status">{notice}</p>}
      <p>Corrected or reviewed nights are never touched. Nights without all their minute data are left as they are.</p>
      {busy && <p>Checking nights…</p>}
      {report && <>
        <p>{done ? `Updated ${nightCount(report.changed)}` : `${nightCount(report.changed)} would change`}</p>
        {report.children.map((child) => <div key={child.child_id}>
          <h3>{child.name}</h3>
          {child.changed.map((night) => <p key={night.night_date}>
            {night.night_date}: {night.figures_changed ? 'Figures changed' : 'Facts only'} — {summary(night.before)} → {summary(night.after)}
          </p>)}
          <p>{child.unchanged} unchanged</p>
          {Object.entries(child.skipped).map(([reason, count]) => <p key={reason}>{reasons[reason] || reason}: {count}</p>)}
        </div>)}
        {!done && <button type="button" className="btn btn-primary" onClick={update} disabled={busy || !report.changed}>
          Update {nightCount(report.changed)}
        </button>}
      </>}
    </Modal>}
  </>;
}
