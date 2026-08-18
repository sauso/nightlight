import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import Modal from '../components/Modal.jsx';
import Switch from '../components/Switch.jsx';
import { fileToAvatarDataUrl } from '../lib/imageResize.js';

const COLORS = ['#f4c56a', '#7FBFA3', '#8A9FE0', '#E0A5C9', '#E0B27F', '#7c83db'];

// Add / edit a child on its own routed screen, reached from the Children tab (or a child's detail
// via its avatar). Open to any signed-in user, matching how children have always been managed.
export default function ChildSettings() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const location = useLocation();
  const { kids, refresh } = useCameras();
  const kid = isNew ? null : kids.find((k) => k.id === id);

  const [form, setForm] = useState({
    name: '', birthday: '', color: COLORS[0], photo: null,
    track_sleep: true, sleep_window_start: '19:00', sleep_window_end: '07:00',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [photoStatus, setPhotoStatus] = useState(''); // '' | 'saving' | 'saved'
  const initedRef = useRef(false);

  const back = location.state?.from || { to: '/children', label: 'Children' };

  useEffect(() => {
    if (isNew || initedRef.current || !kid) return;
    initedRef.current = true;
    setForm({
      name: kid.name, birthday: kid.birthday || '', color: kid.color || COLORS[0], photo: kid.photo || null,
      track_sleep: kid.track_sleep == null ? true : !!kid.track_sleep,
      sleep_window_start: kid.sleep_window_start || '19:00',
      sleep_window_end: kid.sleep_window_end || '07:00',
    });
  }, [kid, isNew]);

  // Persist just the photo immediately for an existing child (no Save press needed). On a new child
  // there's no record yet, so it rides along when the form is first saved.
  async function persistPhoto(photo) {
    if (isNew) return;
    setPhotoStatus('saving');
    try {
      await api.put(`/children/${id}`, { name: form.name, birthday: form.birthday, color: form.color, photo });
      await refresh();
      setPhotoStatus('saved');
      setTimeout(() => setPhotoStatus(''), 2000);
    } catch (err) {
      setError(err.message);
      setPhotoStatus('');
    }
  }

  async function onPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      setForm((f) => ({ ...f, photo: dataUrl }));
      await persistPhoto(dataUrl);
    } catch (err) {
      setError(err.message);
    }
  }

  function removePhoto() {
    setForm((f) => ({ ...f, photo: null }));
    persistPhoto(null);
  }

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

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 18 }}>
              <Avatar name={form.name || 'Child'} src={form.photo} color={form.color} size={88} />
              <div style={{ display: 'flex', gap: 8 }}>
                <label className="btn btn-secondary" style={{ width: 'auto', cursor: 'pointer' }}>
                  {form.photo ? 'Change photo' : 'Add photo'}
                  <input type="file" accept="image/*" onChange={onPhoto} style={{ display: 'none' }} />
                </label>
                {form.photo && (
                  <button type="button" className="btn btn-secondary" style={{ width: 'auto' }} onClick={removePhoto}>
                    Remove
                  </button>
                )}
              </div>
              {photoStatus && (
                <div className="camera-tile__sub" style={{ color: 'var(--peri)' }}>
                  {photoStatus === 'saving' ? 'Saving photo…' : 'Photo saved ✓'}
                </div>
              )}
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
                Used for the child's initials when no photo is set.
              </div>
            </div>

            <div className="field">
              <label className="child-sleep-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Track sleep</span>
                <Switch checked={form.track_sleep} onChange={(e) => setForm({ ...form, track_sleep: e.target.checked })} />
              </label>
              <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                Estimate this child's nightly sleep from their cameras' movement &amp; sound.
              </div>
              {form.track_sleep && (
                <>
                  <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label htmlFor="child-bed">Bedtime</label>
                      <input id="child-bed" type="time" value={form.sleep_window_start}
                        onChange={(e) => setForm({ ...form, sleep_window_start: e.target.value })} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label htmlFor="child-wake">Wake time</label>
                      <input id="child-wake" type="time" value={form.sleep_window_end}
                        onChange={(e) => setForm({ ...form, sleep_window_end: e.target.value })} />
                    </div>
                  </div>
                  <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                    The overnight window looked at for this child (it can run past midnight).
                  </div>
                </>
              )}
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
