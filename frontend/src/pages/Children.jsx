import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import AppHeader from '../components/AppHeader.jsx';

const COLORS = ['#F5D9A8', '#7FBFA3', '#8A9FE0', '#E0A5C9', '#E0B27F'];

export default function Children() {
  const [children, setChildren] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | {} | child
  const [form, setForm] = useState({ name: '', birthday: '', color: COLORS[0] });
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setChildren(await api.get('/children'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  function openNew() {
    setForm({ name: '', birthday: '', color: COLORS[0] });
    setEditing({});
  }

  function openEdit(child) {
    setForm({ name: child.name, birthday: child.birthday || '', color: child.color });
    setEditing(child);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (editing?.id) {
        await api.put(`/children/${editing.id}`, form);
      } else {
        await api.post('/children', form);
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(child) {
    if (!confirm(`Remove ${child.name}? Cameras assigned to them will become unassigned.`)) return;
    try {
      await api.del(`/children/${child.id}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <AppHeader title="Children" />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}

        {children.length === 0 && <div className="empty-state">No children added yet.</div>}

        {children.map((child) => (
          <div className="card" key={child.id}>
            <div className="list-row" style={{ border: 'none', padding: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    width: 14, height: 14, borderRadius: '50%', background: child.color, flexShrink: 0,
                  }}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>{child.name}</div>
                  <div className="camera-tile__sub">
                    {child.cameras.length} camera{child.cameras.length === 1 ? '' : 's'}
                    {child.birthday ? ` · born ${child.birthday}` : ''}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="icon-btn" onClick={() => openEdit(child)}>Edit</button>
                <button className="icon-btn" onClick={() => remove(child)}>Remove</button>
              </div>
            </div>
          </div>
        ))}

        <button className="btn btn-primary" onClick={openNew}>+ Add child</button>
      </main>

      {editing !== null && (
        <Modal title={editing.id ? 'Edit child' : 'Add child'} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            <div className="field">
              <label htmlFor="child-name">Name</label>
              <input
                id="child-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="child-birthday">Birthday (optional)</label>
              <input
                id="child-birthday"
                type="date"
                value={form.birthday}
                onChange={(e) => setForm({ ...form, birthday: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Color tag</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {COLORS.map((c) => (
                  <button
                    type="button"
                    key={c}
                    onClick={() => setForm({ ...form, color: c })}
                    style={{
                      width: 32, height: 32, borderRadius: '50%', background: c,
                      border: form.color === c ? '2px solid var(--text-primary)' : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                    aria-label={`Choose color ${c}`}
                  />
                ))}
              </div>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
