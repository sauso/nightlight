import { useEffect, useState } from 'react';
import { useAuth } from '../lib/AuthContext.jsx';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { useHomeTime } from '../lib/useHomeTime.js';
import Modal from './Modal.jsx';
import ModalActions from './ModalActions.jsx';

const reasons = {
  tracking_off: 'Sleep tracking is off',
  no_saved_settings: 'Saved settings are unavailable',
  has_review: 'Someone reviewed this night',
  owned_by_nightly_job: 'The nightly job is still updating it',
  partial_data: 'Some minute data or alert history this night needs is missing',
  reviewed: 'Someone corrected this night',
  stored_camera_missing: 'The saved camera is missing',
  would_downgrade: 'Not enough data remains to score it',
  would_blank_notified_wake: 'Its reported wake time would disappear',
  would_become_empty: 'The night would become empty',
  error: 'Could not work out this night',
};

function fmtDur(min) {
  if (min == null) return '—';
  const hours = Math.floor(min / 60);
  const minutes = min % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
function summary(row, fmtTime) {
  return `asleep ${fmtDur(row.asleep_minutes)}, wakes ${row.wake_count ?? '—'}, onset ${fmtTime(row.onset_at)}, wake ${fmtTime(row.wake_at)}`;
}
const nightCount = (count) => `${count} ${count === 1 ? 'night' : 'nights'}`;
const leftAsIs = (count) => `${nightCount(count)} ${count === 1 ? 'was left as it is' : 'were left as they are'}`;

export default function UpdatePastNights() {
  const { user } = useAuth();
  const homeTime = useHomeTime();
  const fmtTime = (utc) => utc ? homeTime.time(new Date(`${utc.replace(' ', 'T')}Z`)) : '—';
  const [latest, setLatest] = useState(null);
  const [report, setReport] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [done, setDone] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);

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
      const left = Object.values(result.skipped).reduce((sum, count) => sum + count, 0);
      setNotice(`Restored ${nightCount(result.restored)}.${left ? ` ${leftAsIs(left)}.` : ''}`);
    } catch (e) { setOpen(true); setError(e.message); }
    finally { setConfirmUndo(false); setBusy(false); }
  }

  return <>
    <section className="card">
      <h2 className="card-heading">Update past nights</h2>
      {/* The same description style and stacked full-width buttons as the cards beside it (Automatic clips, Wake clips):
          a bare <p> read as body text at twice the size, and the buttons had no gap between them (2026-11-24). */}
      <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
        After sleep scoring changes, check saved nights and choose whether to update them. Nothing runs by itself.
      </div>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button type="button" className="btn btn-secondary" onClick={check} disabled={busy}>Check what would change</button>
        {latest?.undoable && <button type="button" className="btn btn-secondary" onClick={() => setConfirmUndo(true)} disabled={busy}>Undo these changes</button>}
      </div>
      {latest && !latest.undoable && (
        <div className="camera-tile__sub" role="status" style={{ marginTop: 12 }}>
          The last update can no longer be undone.{latest.left ? ` ${leftAsIs(latest.left)}.` : ''}
        </div>
      )}
    </section>
    {open && <Modal title="Update past nights" onClose={() => setOpen(false)} error={error}>
      {notice && <p role="status">{notice}</p>}
      <p>Corrected or reviewed nights are never touched. Nights without the minute data or alert history they need are left as they are.</p>
      {busy && <p>Checking nights…</p>}
      {report && <>
        <p>{done ? `Updated ${nightCount(report.changed)}` : `${nightCount(report.changed)} would change`}</p>
        {report.children.map((child) => <div key={child.child_id}>
          <h3>{child.name}</h3>
          {child.changed.map((night) => <p key={night.night_date}>
            {homeTime.dayLabel(night.night_date)}: {night.figures_changed ? 'Figures changed' : 'Facts only'} — {summary(night.before, fmtTime)} → {summary(night.after, fmtTime)}
          </p>)}
          <p>{child.unchanged} unchanged</p>
          {Object.entries(child.skipped).map(([reason, count]) => <p key={reason}>{reasons[reason] || reason}: {count}</p>)}
        </div>)}
        {!done && <ModalActions><button type="button" className="btn btn-primary" onClick={update} disabled={busy || !report.changed}>
          Update {nightCount(report.changed)}
        </button></ModalActions>}
      </>}
    </Modal>}
    {confirmUndo && <Modal title="Undo the last update?" onClose={() => setConfirmUndo(false)}>
      <p>Nights saved again or corrected since the update will be left as they are.</p>
      <ModalActions>
        <button type="button" className="btn btn-secondary" onClick={() => setConfirmUndo(false)} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-danger" onClick={undo} disabled={busy}>Undo</button>
      </ModalActions>
    </Modal>}
  </>;
}
