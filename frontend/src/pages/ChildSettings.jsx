import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, Link } from 'react-router-dom';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import Modal from '../components/Modal.jsx';
import Switch from '../components/Switch.jsx';
import { fileToAvatarDataUrl } from '../lib/imageResize.js';

const COLORS = ['#f4c56a', '#7FBFA3', '#8A9FE0', '#E0A5C9', '#E0B27F', '#7c83db'];

// Add / edit a child on its own routed screen, reached from the Children tab (or a child's detail
// via its avatar). Both roles can open it, but what a caregiver may do here is narrower (owner decision
// 2026-10-10, #542: a caregiver can watch and act in the moment, but not destroy or reconfigure):
//   - name, birthday, colour and photo: both roles;
//   - Track sleep, the bedtime window and the sleep camera (#655): shown to a caregiver but disabled, and
//     left OUT of a caregiver's save, because the server refuses the whole request if a caregiver's save
//     would change them (routes/children.js); sending the unchanged values would pass, but leaving them out
//     means a stale form can never be the reason a caregiver's rename is refused;
//   - adding and removing a child: admin only (the server refuses both).
const CAREGIVER_FIELDS = ['name', 'birthday', 'color', 'photo'];

export default function ChildSettings() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const location = useLocation();
  const { kids, cameras, refresh } = useCameras();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const kid = isNew ? null : kids.find((k) => k.id === id);

  // `primary_camera_id` '' = automatic, and '' is what the server stores as NULL (#655).
  const [form, setForm] = useState({
    name: '', birthday: '', color: COLORS[0], photo: null,
    track_sleep: true, sleep_window_start: '19:00', sleep_window_end: '07:00', primary_camera_id: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  // The Remove dialog's own failure, rendered inside it (#378): `error` is a banner in <main>, which sits
  // under the modal overlay, so a refused remove used to look like the button did nothing.
  const [removeError, setRemoveError] = useState('');
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
      primary_camera_id: kid.primary_camera_id || '',
    });
  }, [kid, isNew]);

  // The sleep camera picker (#655). Its options are EVERY camera assigned to this child, in tile order
  // (GET /cameras order), turned-off ones included and marked, because an admin may choose a camera that is
  // off for now: the choice takes effect once it is back on. Shown only when there is a choice to make (two
  // or more cameras) or a choice was made, so a one-camera child gets no control that does nothing.
  const assignedCams = isNew ? [] : (cameras || []).filter((c) => c.child_id === id);
  const storedPrimary = kid?.primary_camera_id || '';
  // A stored primary that is no longer among the options (deleted, or moved to another child by something
  // other than this app's own routes, which clear it) is still offered, as "(unavailable)", so the select
  // shows what is stored and an admin's save sends it back unchanged. Without it the select would show
  // "Automatic" and a plain rename would silently clear the stored choice.
  const missingPrimary = form.primary_camera_id && !assignedCams.some((c) => c.id === form.primary_camera_id)
    ? form.primary_camera_id : '';
  const showCameraPicker = !isNew && (assignedCams.length >= 2 || !!storedPrimary);

  // Persist just the photo immediately for an existing child (no Save press needed). On a new child
  // there's no record yet, so it rides along when the form is first saved.
  async function persistPhoto(photo) {
    if (isNew) return;
    setPhotoStatus('saving');
    try {
      await api.put(`/children/${id}`, { name: form.name, birthday: form.birthday, color: form.color, photo }, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
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
      else await api.put(`/children/${id}`, isAdmin ? form : Object.fromEntries(CAREGIVER_FIELDS.map((k) => [k, form[k]])));
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
    setRemoveError('');
    try {
      await api.del(`/children/${id}`);
      await refresh();
      navigate(back.to);
    } catch (err) {
      // Dialog stays open, button re-enabled: the person can read why and retry or cancel.
      setRemoveError(err.message);
      setRemoveBusy(false);
    }
  }

  return (
    <>
      <AppHeader title={isNew ? 'Add child' : (kid?.name || 'Child')} back={back} />
      <main className="app-main">
        {isNew && !isAdmin ? (
          // No form at all: the server refuses a caregiver's add, so a form here would only let someone
          // type a child in and then be told no.
          <div className="empty-state">Only an admin can add a child. Ask an admin to add them.</div>
        ) : !isNew && !kid ? (
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
                required placeholder="e.g. Alex" />
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
                <Switch checked={form.track_sleep} disabled={!isAdmin}
                  onChange={(e) => setForm({ ...form, track_sleep: e.target.checked })} />
              </label>
              {!isAdmin && (
                <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                  Only an admin can change sleep tracking, the bedtime window and the sleep camera.
                </div>
              )}
              <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                Estimate this child's nightly sleep from their cameras' movement &amp; sound. Wake-ups are
                also recorded (without alerting you)
                {isAdmin ? (
                  <> — length and retention are under <Link to="/settings/recording">Settings › Recording</Link>.</>
                ) : (
                  <> — an admin can change their length and retention.</>
                )}
              </div>
              {form.track_sleep && (
                <>
                  <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label htmlFor="child-bed">Bedtime</label>
                      <input id="child-bed" type="time" value={form.sleep_window_start} disabled={!isAdmin}
                        onChange={(e) => setForm({ ...form, sleep_window_start: e.target.value })} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label htmlFor="child-wake">Wake time</label>
                      <input id="child-wake" type="time" value={form.sleep_window_end} disabled={!isAdmin}
                        onChange={(e) => setForm({ ...form, sleep_window_end: e.target.value })} />
                    </div>
                  </div>
                  <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                    The overnight window looked at for this child (it can run past midnight).
                  </div>
                  {showCameraPicker && (
                    <div style={{ marginTop: 12 }}>
                      <label htmlFor="child-sleep-camera">Camera used for this child's sleep</label>
                      <select id="child-sleep-camera" value={form.primary_camera_id} disabled={!isAdmin}
                        onChange={(e) => setForm({ ...form, primary_camera_id: e.target.value })}>
                        <option value="">Automatic (first enabled camera in tile order)</option>
                        {assignedCams.map((c) => (
                          <option key={c.id} value={c.id}>{c.disabled ? `${c.name} (turned off)` : c.name}</option>
                        ))}
                        {missingPrimary && (
                          <option value={missingPrimary}>
                            {(cameras || []).find((c) => c.id === missingPrimary)?.name || 'A removed camera'} (unavailable)
                          </option>
                        )}
                      </select>
                      {/* What the SERVER says the night is measured from now (child.primary_camera, resolved by
                          the same function scoring uses), never re-derived here: the stored choice can be turned
                          off or gone, and then the automatic rule applies. */}
                      <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                        {kid?.primary_camera ? (
                          <>Currently measured from <strong>{kid.primary_camera.name}</strong>.</>
                        ) : (
                          <>No camera of this child is turned on, so nothing is measured right now.</>
                        )}
                        {storedPrimary && kid?.primary_camera?.id !== storedPrimary && (
                          <> The chosen camera is turned off or no longer assigned, so the automatic choice is used until it is back.</>
                        )}
                        {/* Same facts as README "What a change affects". NOT "saved summaries keep their numbers":
                            last night's summary is re-scored for ~3h after the wake time, and a review correction
                            or an admin's Recompute re-scores a night (#655 review). */}
                        {' '}A change applies whenever a night is next worked out. A night's detail page always
                        uses the new camera. A saved summary stays as saved, except that last night's can still
                        be updated for a few hours after the wake time, and a review correction or a Recompute
                        works a night out again.
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 8 }}>
              {busy ? 'Saving…' : isNew ? 'Add child' : 'Save changes'}
            </button>
            {/* Admin-only: DELETE /api/children/:id has always been requireAdmin, so offering it to a
                caregiver only ever led to a refusal. */}
            {!isNew && isAdmin && (
              <button className="btn btn-danger" type="button" style={{ marginTop: 10 }} onClick={() => { setRemoveError(''); setRemoving(true); }}>
                Remove child
              </button>
            )}
          </form>
        )}
      </main>

      {removing && (
        <Modal title="Remove child" placement="top" error={removeError} onClose={() => (removeBusy ? null : setRemoving(false))}>
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
