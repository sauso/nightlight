import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Bell, Camera, Settings } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import Modal from '../components/Modal.jsx';
import ChildCameraTile from '../components/ChildCameraTile.jsx';
import AlertList from '../components/AlertList.jsx';
import LoadFailed from '../components/LoadFailed.jsx';
import { loadState } from '../lib/loadState.js';
import SensorHistoryCard from '../components/SensorHistoryCard.jsx';
import SleepSummaryCard from '../components/SleepSummaryCard.jsx';
import TimelapseCard from '../components/TimelapseCard.jsx';
import RecordingsCard from '../components/RecordingsCard.jsx';
import MorningReviewCard from '../components/MorningReviewCard.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import { ageLabel } from '../lib/age.js';

// A child's hub: ONE night card (identity, last night's sleep, the morning question), then their camera, timelapse, alerts and recordings.
// The avatar opens the photo (or Child settings when there is none) and the gear opens Child settings (name / birthday /
// colour / photo). Alerts are filtered to this child's cameras client-side via each event's camera_id.

export default function ChildDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { kids, cameras, loaded: camerasLoaded, error: camerasError, refresh: refreshCameras } = useCameras();
  const { settings } = useSettings();
  // Same formatter the sleep card uses, so the card and the review agree to the minute.
  const fmtTime = (utc) => {
    if (!utc) return '';
    const d = new Date(String(utc).replace(' ', 'T') + 'Z');
    return new Intl.DateTimeFormat([], { timeZone: settings?.timezone || undefined, hour: 'numeric', minute: '2-digit' }).format(d);
  };
  const kid = kids.find((k) => k.id === id);
  const childCams = cameras.filter((c) => c.child_id === id);
  const [alerts, setAlerts] = useState([]);
  // Alerts get the same three-way split as every fetched list (#375). A failed fetch used to be swallowed and
  // leave [], which the render below turned into "No alerts for <child> yet" - the same words as a quiet week.
  const [alertsLoaded, setAlertsLoaded] = useState(false);
  const [alertsError, setAlertsError] = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);
  // The band of the night the sleep card is showing (bandOf: null when it shows no score). The card owns the fetch, so
  // it reports the band UP and this page puts it on the hero card as a class: a 12% tint of the band colour (index.css,
  // `.night--<band>`). That is a tiny state lift, not a second fetch, and a card that reports nothing leaves the plain gradient.
  //
  // ⚠️ KEYED BY CHILD, because this component is NOT remounted when only the :id changes (same route, new param): a band
  // reported for child A must never colour child B's card while B's sleep request is still pending (Codex review of #1055).
  // Two guards: the state remembers WHICH child reported it and is ignored for any other (so there is no frame of the old
  // tint), and the sleep card is `key`ed by child below (so it also forgets child A's night instead of showing it until B's
  // request lands).
  const [reported, setReported] = useState({ id: null, band: null });
  const onBand = useCallback((band) => setReported({ id, band }), [id]);
  const nightBand = reported.id === id ? reported.band : null;

  // ★ WHICH NIGHT THE CARD IS SHOWING (owner, staging phone 2026-11-13). The morning question and its receipt are fetched by child
  // alone, and the server answers about the LAST COMPLETED night. While tonight is in progress the card above says "Tonight · so
  // far", so last night's "Thanks, that's recorded. You said up at 5:56 am." sat under a night it was not about. The sleep card
  // reports the date of the FINISHED night it shows (null while loading, for tonight in progress and for tracking off), and the
  // question is drawn only for that night. Keyed by child for the same reason as the band above.
  const [shownNight, setShownNight] = useState({ id: null, date: null });
  const onNightShown = useCallback((date) => setShownNight({ id, date }), [id]);
  const reviewNight = shownNight.id === id ? shownNight.date : null;

  async function loadAlerts() {
    const camIds = new Set(cameras.filter((c) => c.child_id === id).map((c) => c.id));
    try {
      const all = await api.get('/cameras/alerts');
      setAlerts((Array.isArray(all) ? all : []).filter((ev) => camIds.has(ev.camera_id)).slice(0, 20));
      setAlertsLoaded(true);
      setAlertsError('');
    } catch (err) {
      // The last feed stays on screen (stale); the message says so and offers Retry.
      setAlertsError(err?.message || 'Request failed');
    }
  }

  useEffect(() => {
    // The feed is filtered to THIS child's cameras, so asking before the camera list has loaded would filter
    // against an empty set and report a successful "no alerts" that was never true.
    if (!camerasLoaded) return undefined;
    loadAlerts();
    const t = setInterval(loadAlerts, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cameras.length, camerasLoaded]);

  if (!kid) {
    // Not found only after the list has actually loaded: before that, or after a failed load, the child may
    // well exist and "Loading…" forever (the old behaviour) hid the failure (#375).
    //
    // ⚠️ The requested child is ABSENT here, so whatever the provider cached cannot vouch for it: a failed
    // refresh after a good load leaves a NON-empty `kids` that simply lacks this id, and loadState would call
    // that 'stale' (it assumes the cached list is on screen). Nothing on this screen is the cached list, so
    // count is passed as 0 and any provider error is a blocking `error` with Retry, however many children
    // are cached. (Review finding on PR #716.)
    const missing = loadState({ loaded: camerasLoaded, error: camerasError, count: 0 });
    return (
      <>
        <AppHeader title="Child" back={{ to: '/children', label: 'Children' }} />
        <main className="app-main">
          {missing === 'error' && <LoadFailed what="this child" error={camerasError} onRetry={refreshCameras} />}
          {missing === 'loading' && <div className="empty-state">Loading…</div>}
          {missing === 'empty' && (
            <div className="empty-state">We couldn’t find this child. Go back to Children and pick one from the list.</div>
          )}
        </main>
      </>
    );
  }
  const alertsState = loadState({ loaded: alertsLoaded, error: alertsError, count: alerts.length });
  const age = ageLabel(kid.birthday);

  return (
    <>
      <AppHeader title={kid.name} back={{ to: '/children', label: 'Children' }} />
      {/* ★ LAYOUT (UI refresh PR D). The DOM is the PHONE order, which is also the reading and tab order: night card, camera,
          timelapse, recent alerts, recordings, sensor history. From 1024px the same elements are placed in two columns by
          CSS grid (index.css, `.child-page`), alerts under the night card and everything else in the other column, as drawn.
          Nothing is reordered with `order`, so a keyboard or screen-reader user never gets an order that disagrees with the
          screen. Each section sits in its own wrapper because TimelapseCard and RecordingsCard render NOTHING until there
          is something to show; the wrapper is then an empty box that takes no space. */}
      {/* The timelapse, alerts and recordings cards are keyed by child (below): this component is reused when only :id changes, and
          each card keeps local state (the picked night, "See all alerts" expanded, the Recordings row open) that must not carry from one
          child to the next. */}
      <main className="app-main child-page">
        <div className="child-page__night">
        <div className={nightBand ? `night night--${nightBand}` : 'night'}>
          <div className="night__head">
            {/* The avatar is the way to set the photo (it opens the photo, or settings when there is none), and the small
                camera badge says so: the "Tap to add birthday & photo" line that used to say it is gone (design, 2026-11-12). */}
            <button
              type="button"
              className="night__avatar-btn"
              onClick={() => (kid.photo ? setPhotoOpen(true) : navigate(`/children/${id}/edit`))}
              aria-label={kid.photo ? `View ${kid.name}'s photo` : `Add a photo for ${kid.name}`}
            >
              <Avatar name={kid.name} src={kid.photo} color={kid.color} size={64} />
              <span className="night__avatar-badge" aria-hidden="true"><Camera size={12} /></span>
            </button>
            {/* Name and age are plain text now. The two buttons that wrapped them and the "Edit ›" link all went to child
                settings, which is what the one gear does; settings is also where the birthday is set. No age (no birthday)
                leaves the line out rather than inviting one: the invitation is on the card only when a score needs it. */}
            <div className="night__id">
              <span className="night__name">{kid.name}</span>
              {age && <span className="night__age">{age}</span>}
            </div>
            <button type="button" className="night__settings" onClick={() => navigate(`/children/${id}/edit`)} aria-label={`Settings for ${kid.name}`}>
              <Settings size={20} aria-hidden="true" />
            </button>
          </div>
          <SleepSummaryCard key={id} childId={id} onBand={onBand} onNightShown={onNightShown} birthdaySet={Boolean(kid.birthday)} />
          {/* The morning question lives IN the card (one place, asked once); it is keyed by child like the sleep card so a
              question loaded for one child never shows under another's name while that child's request is pending. It is
              about the night the card above shows and no other (`forNight`: nothing while tonight is in progress). */}
          <MorningReviewCard key={`review-${id}`} childId={id} fmtTime={fmtTime} forNight={reviewNight} />
        </div>
        </div>

        {/* The camera(s): one large tile each, no "Cameras · n" heading (a child's page is about the child; the count and the
            capability badges are on the Cameras tab). "Watch live" goes to the Live tab, where every camera is. */}
        <div className="child-page__cameras">
          {childCams.map((c) => (
            <ChildCameraTile
              key={c.id}
              cam={c}
              onWatch={() => navigate('/')}
              onSettings={isAdmin ? () => navigate(`/cameras/${c.id}`, { state: { from: { to: `/children/${id}`, label: kid.name } } }) : undefined}
            />
          ))}
          {/* Assigning a camera is admin-only (#552), so a caregiver is told who can, not sent to a
              screen where the control is not there for them. */}
          {childCams.length === 0 && (
            <div className="card child-page__nocam">
              {isAdmin
                ? 'No cameras assigned yet — assign one from the Cameras tab.'
                : 'No cameras assigned yet — an admin can assign one from the Cameras tab.'}
            </div>
          )}
        </div>

        <div className="child-page__timelapse"><TimelapseCard key={id} childId={id} /></div>

        <div className="child-page__alerts">
          {alertsState === 'ready' || alertsState === 'stale' ? (
            <>
              {alertsState === 'stale' && <LoadFailed what="alerts" error={alertsError} onRetry={loadAlerts} stale />}
              <AlertList key={id} alerts={alerts} onChanged={loadAlerts} title="Recent alerts" previewCount={3} />
            </>
          ) : (
            <div className="card alert-list">
              <div className="card-title alert-list__title"><Bell size={16} aria-hidden="true" /><span>Recent alerts</span></div>
              <div className="alert-list__body">
                {alertsState === 'loading' && <div className="camera-tile__sub">Loading…</div>}
                {alertsState === 'error' && <LoadFailed what="alerts" error={alertsError} onRetry={loadAlerts} />}
                {alertsState === 'empty' && <div className="camera-tile__sub">No alerts for {kid.name} yet.</div>}
              </div>
            </div>
          )}
        </div>

        <div className="child-page__recordings"><RecordingsCard key={id} childId={id} /></div>

        <div className="child-page__sensors">
          {childCams.filter((c) => c.mqtt_topic).map((c) => (
            <SensorHistoryCard key={c.id} camera={c} />
          ))}
        </div>
      </main>

      {photoOpen && kid.photo && (
        <Modal title={kid.name} onClose={() => setPhotoOpen(false)}>
          <img className="photo-full" src={kid.photo} alt={kid.name} />
        </Modal>
      )}
    </>
  );
}
