import { BedSingle, Settings, Video } from 'lucide-react';

// A child's camera on their page (UI refresh PR D, the approved design): one large dark tile with a status chip, a quiet bed
// placeholder and a "Watch live" button. It is NOT a live picture. The page opens often and a stream per child per visit is
// the wrong cost; the live picture is one tap away on the Live tab, which is what the button does.
//
// It replaces the small CameraRow list (and its "Cameras · n" heading, the Online/Offline pill and the MOTION/SOUND/PTZ/TALK
// badges). The PTZ and TALK badges are on the Cameras tab, which is where a camera is looked after. Whether motion and sound
// detection are ON is kept here as one quiet line of words (below), for every role: a caregiver has no other place that says
// whether the camera is listening (the owner asked for it back, 2026-11-13).
//
// ★ STATUS IS NEVER JUST A COLOUR. The dot is green when the camera is online, and the chip also says "Offline" or "Disabled"
// in words when it is not (a colour-blind parent, or a screen reader, must not have to guess). Online adds no word: the chip
// would otherwise read "Online" next to every camera forever, which is noise on the normal case. A screen reader still hears it
// (visually hidden text).
//
// (The detection line and the settings gear are explained where they are defined, below.)

// "Motion on · Sound on", or "Motion off" / "Sound off" for what is off. Words, never colour alone. It reads the same two camera
// fields the old MOTION/SOUND badges read (detect_motion_enabled, detect_sound_enabled; INTEGER NOT NULL DEFAULT 0, so every
// stored camera has both). The old badges appeared only when a feature was ON; an OFF feature is now said in words, as the owner
// asked. Two cases say nothing: a camera object carrying neither field (an unknown state is not "off"), and a DISABLED camera
// (nothing runs on it, so "Motion on" would be false; the chip already says "Disabled").
function detectionLine(cam) {
  if (cam.disabled) return null;
  if (cam.detect_motion_enabled === undefined && cam.detect_sound_enabled === undefined) return null;
  return `Motion ${cam.detect_motion_enabled ? 'on' : 'off'} · Sound ${cam.detect_sound_enabled ? 'on' : 'off'}`;
}

// `onSettings` is passed only for an admin: camera settings are admin-only (the route is behind AdminProtected), and the old
// row was a button for an admin and a plain div for a caregiver for exactly that reason. The gear keeps that, so the design's
// tile does not take the admin's way into a camera's settings away; a caregiver sees no control that can only end in a redirect.
export default function ChildCameraTile({ cam, onWatch, onSettings }) {
  const status = cam.disabled ? 'disabled' : cam.statusLevel === 'live' ? 'online' : 'offline';
  const detection = detectionLine(cam);
  return (
    <div className={`child-cam child-cam--${status}`}>
      <span className="child-cam__chip">
        <span className="child-cam__dot" aria-hidden="true" />
        <span className="child-cam__name">{cam.name}</span>
        {status === 'online' && <span className="child-cam__sr"> (online)</span>}
        {status === 'offline' && <span className="child-cam__state">· Offline</span>}
        {status === 'disabled' && <span className="child-cam__state">· Disabled</span>}
      </span>
      {onSettings && (
        <button type="button" className="child-cam__settings" onClick={onSettings} aria-label={`Camera settings for ${cam.name}`}>
          <Settings size={18} aria-hidden="true" />
        </button>
      )}
      <BedSingle className="child-cam__bed" size={64} strokeWidth={1.25} aria-hidden="true" />
      {detection && <span className="child-cam__detect">{detection}</span>}
      {/* Not on a disabled camera: the Live tab hides disabled cameras (LiveMonitor filters them out), so the button would
          open a page that does not show this camera. The chip already says "Disabled". */}
      {status !== 'disabled' && (
        <button type="button" className="child-cam__watch" onClick={onWatch}>
          <Video size={16} aria-hidden="true" /> Watch live
        </button>
      )}
    </div>
  );
}
