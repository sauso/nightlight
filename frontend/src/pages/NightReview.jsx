import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, X, HelpCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from '../components/AppHeader.jsx';

// Recording what actually happened last night, from the person who was there.
//
// Every sleep change so far has been judged against a recollection the next morning — "around 6am".
// That was fine while the errors were hours. It stopped being fine when they reached ~10 minutes,
// because the error became smaller than the measurement; and the same handful of nights was used to
// design a change AND to validate it, so nothing was ever held out. This screen is the fix: precise,
// dated, captured while it is fresh, and never rewritten afterwards.
//
// Two things are collected, and they answer different questions. The TIMES give a scored ground-truth
// set — "was the app right about this night" — which is what makes a future change provable instead of
// arguable. The per-event VERDICTS give labelled frames: 62% of recorded bed transitions are
// physically impossible on sequence alone, and knowing WHICH of a contradictory pair is the wrong one
// needs a person to look at the picture.
//
// ⚠️ Times are typed as local wall-clock and sent as UTC, the way everything else in this database is
// stored. Converting here rather than on the server is deliberate: only the browser knows what clock
// the person was reading when they typed it.

const VERDICTS = [
  { key: 'correct', label: 'Yes', Icon: Check },
  { key: 'wrong', label: 'No', Icon: X },
  { key: 'unclear', label: "Can't tell", Icon: HelpCircle },
];

// UTC 'YYYY-MM-DD HH:MM:SS' -> the 'HH:MM' shown in the app's configured timezone — the same zone
// the sleep card renders in, so the review and the thing it is correcting always agree.
//
// The reverse direction is deliberately NOT done here. The server resolves what was typed against the
// app timezone and the night's date, because that is where the timezone setting lives and where the
// DST-safe conversion already exists and is tested. Doing it in the browser would use the phone's zone
// instead, so a review typed while travelling would disagree with the card it was correcting.
function toLocalHhmm(utc, tz) {
  if (!utc) return '';
  const d = new Date(`${utc.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(d);
}

export default function NightReview() {
  const { id, date } = useParams();
  const navigate = useNavigate();
  const { kids } = useCameras();
  const { settings } = useSettings();
  const tz = settings?.timezone;
  const kid = kids.find((k) => k.id === id);

  const [data, setData] = useState(null);
  const [onset, setOnset] = useState('');
  const [wake, setWake] = useState('');
  const [note, setNote] = useState('');
  const [verdicts, setVerdicts] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.get(`/children/${id}/review/${date}`)
      .then((r) => {
        if (!live) return;
        setData(r);
        // Pre-fill with the app's own answer. Confirming it unchanged is a real and common outcome —
        // and the most valuable one to record, because "we were right" is exactly what a scored set
        // needs and exactly what nobody bothers to write down.
        setOnset(toLocalHhmm(r.review?.true_onset_at || r.computed?.onset_at, tz));
        setWake(toLocalHhmm(r.review?.true_wake_at || r.computed?.wake_at, tz));
        setNote(r.review?.note || '');
        setVerdicts(Object.fromEntries((r.transitions || []).filter((t) => t.verdict).map((t) => [t.id, t.verdict])));
      })
      .catch((e) => live && setError(e.message || 'Could not load that night'));
    return () => { live = false; };
  }, [id, date, tz]);

  const fmtEvent = useMemo(() => (t) => toLocalHhmm(t.created_at, tz), [tz]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/children/${id}/review/${date}`, {
        true_onset_local: onset || null,
        true_wake_local: wake || null,
        note: note.trim() || null,
        verdicts,
      });
      navigate(`/children/${id}`);
    } catch (e) {
      setError(e.message || 'Could not save');
      setBusy(false);
    }
  };

  const back = { to: `/children/${id}`, label: kid?.name || 'Child' };
  if (error && !data) {
    return (
      <>
        <AppHeader title="Was this right?" back={back} />
        <main className="app-main"><div className="empty-state">{error}</div></main>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <AppHeader title="Was this right?" back={back} />
        <main className="app-main"><div className="empty-state">Loading…</div></main>
      </>
    );
  }

  const transitions = data.transitions || [];
  return (
    <>
      <AppHeader title="Was this right?" back={back} />
      <main className="app-main">
        <div className="card">
          <div className="card-title">What we recorded</div>
          <div className="camera-tile__sub">
            Correct anything that is wrong. If it is already right, just save — knowing we got a night
            right is worth as much as knowing we got it wrong.
          </div>
          <label className="field">
            <span className="field__label">Fell asleep</span>
            <input type="time" value={onset} onChange={(e) => setOnset(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Got up for the day</span>
            <input type="time" value={wake} onChange={(e) => setWake(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Anything else worth noting</span>
            <input
              type="text"
              value={note}
              placeholder="e.g. put back on the bed to get dressed at 5:45"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>

        <div className="card tight">
          <div className="card-title">
            Events we recorded {transitions.length > 0 && `· ${transitions.length}`}
          </div>
          {transitions.length === 0 && (
            <div className="camera-tile__sub">
              Nothing was recorded for this night — so there is nothing here to check.
            </div>
          )}
          {transitions.map((t) => (
            <div key={t.id} className="review-event">
              {t.snapshot ? (
                <img
                  className="review-event__frame"
                  src={api.url(`/cameras/bed-transitions/${t.id}/snapshot`)}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <div className="review-event__frame review-event__frame--none">No frame</div>
              )}
              <div className="review-event__body">
                <div className="review-event__when">
                  {fmtEvent(t)} — we said they{' '}
                  <strong>{t.type === 'into_bed' ? 'got into bed' : 'got out of bed'}</strong>
                </div>
                {t.camera_name && <div className="camera-tile__sub">{t.camera_name}</div>}
                <div className="review-event__verdicts">
                  {VERDICTS.map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      type="button"
                      className={`review-chip${verdicts[t.id] === key ? ' review-chip--on' : ''}`}
                      aria-pressed={verdicts[t.id] === key}
                      // Tapping the chosen verdict again clears it: a mis-tap must be undoable, because
                      // a wrong label is worse than a missing one — everything else gets scored on it.
                      onClick={() => setVerdicts((v) => ({ ...v, [t.id]: v[t.id] === key ? null : key }))}
                    >
                      <Icon size={16} /> {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}
        <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save review'}
        </button>
      </main>
    </>
  );
}
