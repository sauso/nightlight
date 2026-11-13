import { BedSingle, Settings, Video } from 'lucide-react';

// A child's camera on their page (UI refresh PR D, the approved design): one large dark tile with a status chip, a quiet bed
// placeholder and a "Watch live" button. It is NOT a live picture. The page opens often and a stream per child per visit is
// the wrong cost; the live picture is one tap away on the Live tab, which is what the button does.
//
// It replaces the small CameraRow list (and its "Cameras · n" heading, the Online/Offline pill and the MOTION/SOUND/PTZ/TALK
// badges). Those badges are on the Cameras tab, which is where a camera is looked after; this page is for the child.
//
// ★ STATUS IS NEVER JUST A COLOUR. The dot is green when the camera is online, and the chip also says "Offline" or "Disabled"
// in words when it is not (a colour-blind parent, or a screen reader, must not have to guess). Online adds no word: the chip
// would otherwise read "Online" next to every camera forever, which is noise on the normal case. A screen reader still hears it
// (visually hidden text).
//
// `onSettings` is passed only for an admin: camera settings are admin-only (the route is behind AdminProtected), and the old
// row was a button for an admin and a plain div for a caregiver for exactly that reason. The gear keeps that, so the design's
// tile does not take the admin's way into a camera's settings away; a caregiver sees no control that can only end in a redirect.
export default function ChildCameraTile({ cam, onWatch, onSettings }) {
  const status = cam.disabled ? 'disabled' : cam.statusLevel === 'live' ? 'online' : 'offline';
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
