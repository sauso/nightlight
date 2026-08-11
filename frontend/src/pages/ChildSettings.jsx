import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import Modal from '../components/Modal.jsx';

const COLORS = ['#f4c56a', '#7FBFA3', '#8A9FE0', '#E0A5C9', '#E0B27F', '#7c83db'];

// Add / edit a child on its own routed screen (replaces the old modal), reached from the Family
// hub. Open to any signed-in user, matching how children have always been managed.
export default function ChildSettings() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const { kids, refresh } = useCameras();
  const kid = isNew ? null : kids.find((k) => k.id === id);

  const [form, setForm] = useState({ name: '', birthday: '', color: COLORS[0] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const initedRef = useRef(false);

  const back = { to: '/family', label: 'Family' };

  useEffect(() => {
    if (isNew || initedRef.current || !kid) return;
    initedRef.current = true;
    setForm({ name: kid.name, birthday: kid.birthday || '', color: kid.color || COLORS[0] });
  }, [kid, isNew]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (isNew) await api.post('/children', form);
      else await api.put(`/children/${id}`, form);
      await refresh();
      navigate(back.to);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    setRemoveBusy(true);
    setError('');
    try {
      await api.del(`/children/${id}`);
      await refresh();
      navigate(back.to);
    } catch (err) {
      setError(err.message);
      setRemoveBusy(false);
    }
  }

  return (
    <>
      <AppHeader title={isNew ? 'Add child' : (kid?.name || 'Child')} back={back} />
      <main className="app-main">
        {!isNew && !kid ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <form onSubmit={save}>
            {error && <div className="error-banner">{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <Avatar name={form.name || 'Child'} color={form.color} size={72} />
            </div>

            <div className="field">
              <label htmlFor="child-name">Name</label>
              <input id="child-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                required placeholder="e.g. Renz" />
            </div>

            <div className="field">
              <label htmlFor="child-bday">Birthday (optional)</label>
              <input id="child-bday" type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
            </div>

            <div className="field">
              <label>Colour</label>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {COLORS.map((c) => (
                  <button key={c} type="button" aria-label={`Colour ${c}`}
                    onClick={() => setForm({ ...form, color: c })}
                    style={{
                      width: 34, height: 34, borderRadius: '50%', background: c, cursor: 'pointer',
                      border: form.color === c ? '3px solid var(--text-primary)' : '3px solid transparent',
                    }} />
                ))}
              </div>
              <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                Avatar photo upload is coming — for now this colour is used for the child's initials.
              </div>
            </div>

            <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 8 }}>
              {busy ? 'Saving…' : isNew ? 'Add child' : 'Save changes'}
            </button>
            {!isNew && (
              <button className="btn btn-danger" type="button" style={{ marginTop: 10 }} onClick={() => setRemoving(true)}>
                Remove child
              </button>
            )}
          </form>
        )}
      </main>

      {removing && (
        <Modal title="Remove child" placement="top" onClose={() => (removeBusy ? null : setRemoving(false))}>
          <p style={{ marginTop: 0 }}>
            Remove <strong>{kid?.name}</strong>? Cameras assigned to them become unassigned. This can't be undone.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setRemoving(false)} disabled={removeBusy}>Cancel</button>
            <button className="btn btn-danger" type="button" onClick={confirmRemove} disabled={removeBusy}>
              {removeBusy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
