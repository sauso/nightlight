// The pin of every API route's gate (issue #563), in its own file since #1237 so two tests can share ONE copy:
//   - route-permissions.test.js holds the code to it (the enumeration must match it in both directions, and the gates
//     must refuse and admit who it says);
//   - tv-session.test.js walks every pinned route as a TV session (#1237), which must be refused everywhere but
//     the TV allowlist.
// Moved here unchanged from route-permissions.test.js, where it was module-private. A second, typed copy of the
// table in the TV test would drift from this one; reading it from here means a route pinned for the first time is
// walked as a TV the same day.

// ---- the pin ----------------------------------------------------------------------------------------------
//
// HOW TO UPDATE IT, when route-permissions.test.js (or tv-session.test.js) fails because you changed something on purpose:
//   - NEW ROUTE: add it with the gate you intend. If it is PUBLIC or SIGNED_IN, write one line on why a
//     caregiver (or nobody at all) should reach it, and give the route its own behaviour tests.
//   - GATE CHANGED: change the entry, and say in the PR who gains or loses access. Loosening a gate is a
//     security-relevant change and is reviewed as one.
//   - GONE: delete the entry.
// Do not regenerate the pin from the code to make it green: that turns it back into the thing it replaced.
export const PUBLIC = 'public'; //            no authentication at all
export const OPTIONAL = 'optional'; //        optionalAuth: answers everyone, says more to a signed-in caller
export const MEDIA = 'media'; //              requireAuthQueryOrHeader: a session header, OR a media token in ?token=
export const SIGNED_IN = 'signed-in'; //      requireAuth: a session token in the header, ANY role (caregiver included)
export const ADMIN = 'signed-in+admin'; //    requireAuth, then requireAdmin

// HISTORY. When this file landed (#563), sixteen routes were pinned at their behaviour of the day and marked
// "pending owner decision" (#538, #542, #552). The owner decided on 2026-10-10: a caregiver can watch and act
// in the moment, but cannot destroy or reconfigure. The entries below are that decision; each one that a
// caregiver can still reach says why on its own line.

export const ROUTE_GATES = {
  // #941: setup state and browser playback attestations are only for a signed-in admin.
  'GET /api/setup': ADMIN,
  'PATCH /api/setup/progress': ADMIN,
  'POST /api/setup/monitor-tests': ADMIN,
  'POST /api/setup/monitor-tests/:id/confirm': ADMIN,
  'POST /api/setup/complete': ADMIN,
  // /api/auth — the login screen has to work before anyone can sign in, so its first five are public (the invite and
  // TV pairing routes below have public ones of their own, each with its reason). Each
  // carries its own rate limiter (not pinned here; login-rate-limit.test.js).
  'GET /api/auth/status': PUBLIC, //            needsSetup + demo flags, read by the login screen
  'POST /api/auth/guest': PUBLIC, //            demo mode only; a plain 404 otherwise (demo-guest.test.js)
  'POST /api/auth/setup': PUBLIC, //            first-run admin creation; refuses once any user exists
  'POST /api/auth/login': PUBLIC,
  'POST /api/auth/login/mfa': PUBLIC,
  'POST /api/auth/logout': SIGNED_IN,
  'GET /api/auth/me': SIGNED_IN,
  'POST /api/auth/media-token': SIGNED_IN,
  'GET /api/auth/sessions': SIGNED_IN, //       your own sessions
  'GET /api/auth/sessions/all': ADMIN,
  'DELETE /api/auth/sessions/:id': SIGNED_IN, // own-or-admin is decided in the handler (see header)
  'GET /api/auth/users': ADMIN,
  'POST /api/auth/users': ADMIN,
  'PUT /api/auth/users/:id': ADMIN,
  'PUT /api/auth/me': SIGNED_IN,
  'PUT /api/auth/me/password': SIGNED_IN,
  'GET /api/auth/me/mfa': SIGNED_IN,
  'POST /api/auth/me/mfa/setup': SIGNED_IN,
  'POST /api/auth/me/mfa/enable': SIGNED_IN,
  'POST /api/auth/me/mfa/disable': SIGNED_IN,
  'DELETE /api/auth/users/:id/mfa': ADMIN,
  'DELETE /api/auth/users/:id': ADMIN,
  'PUT /api/auth/users/:id/disabled': ADMIN, // #1233: disabling or re-enabling an account is account management
  // #1094 caregiver invites. Making, re-issuing and revoking an invite is account management (admin). Checking and
  // redeeming one are PUBLIC: the person opening the link has no account they can sign in to yet, and the invite token
  // in the body is the credential (one-time, 7 days, caregiver accounts only; failures-only limiter on both;
  // auth-invite.test.js).
  'POST /api/auth/users/:id/invite': ADMIN,
  'DELETE /api/auth/users/:id/invite': ADMIN,
  'POST /api/auth/invite/check': PUBLIC,
  'POST /api/auth/invite/redeem': PUBLIC,
  // #1237 signing in a TV by code (planning/tv-pairing-design.md §5). START and POLL are PUBLIC: the TV has no session yet
  // (that is the point), and what it holds is the device_code (256 random bits, one pairing, ten minutes, useless until a
  // signed-in person approves it; own limiters; tv-pairing.test.js). PENDING, APPROVE and DENY are SIGNED_IN, a caregiver
  // included (the owner's decision, design §12.1: any signed-in user may connect the household's TV, and the TV is a
  // view-only caregiver whoever approved it). A TV session is refused all three by the TV allowlist (tv-session.test.js).
  'POST /api/auth/device/start': PUBLIC,
  'POST /api/auth/device/poll': PUBLIC,
  'POST /api/auth/device/pending': SIGNED_IN,
  'POST /api/auth/device/approve': SIGNED_IN,
  'POST /api/auth/device/deny': SIGNED_IN,

  // /api/children — `router.use(requireAuth)` gates the whole router; add and delete add requireAdmin.
  'GET /api/children': SIGNED_IN,
  'POST /api/children': ADMIN, //                        #542: a new child starts with sleep tracking on
  'PUT /api/children/:id': SIGNED_IN, //                 name/colour/photo; tracking, window, primary camera + sleep report switches refused in the handler (#542, #655, #397/#398)
  'GET /api/children/:id/sleep/live': SIGNED_IN,
  'GET /api/children/:id/sleep/insights': SIGNED_IN,
  'GET /api/children/:id/sleep/report': SIGNED_IN, //     #1236: the weekly and monthly report, read-only, like the other sleep reads
  'GET /api/children/:id/sleep': SIGNED_IN,
  'GET /api/children/:id/sleep/:date': SIGNED_IN,
  'GET /api/children/:id/review/pending': SIGNED_IN,
  'GET /api/children/:id/review/:date': SIGNED_IN,
  'PUT /api/children/:id/review/:date': SIGNED_IN, //    saving the morning review is acting in the moment (owner)
  'DELETE /api/children/:id': ADMIN, //                  deletes the child's media too

  // /api/cameras — four media routes come BEFORE `router.use(requireAuth)` so an <img>/<video> can load
  // them with ?token=; everything after that line needs a session.
  'GET /api/cameras/alerts/:id/snapshot': MEDIA,
  'GET /api/cameras/bed-transitions/:id/snapshot': MEDIA,
  'GET /api/cameras/alerts/:id/clip': MEDIA,
  'GET /api/cameras/:id/snapshot': MEDIA, //                   the bed-zone picker's still; watching (owner). Single-flight per camera (#552): snapshot-single-flight.test.js
  'POST /api/cameras/onvif-probe': ADMIN,
  'POST /api/cameras/discover': ADMIN, // #945: multicast scan is an admin-only network action
  'GET /api/cameras/discover/:scanId': ADMIN, // #945: results expose private LAN addresses
  'POST /api/esphome/discover': ADMIN, // #1071: multicast scan is an admin-only network action
  'GET /api/esphome/discover/:scanId': ADMIN, // #1071: results expose private LAN addresses
  'POST /api/cameras/probe-report': ADMIN,
  'POST /api/cameras/:id/record/start': SIGNED_IN, //           capturing a moment is acting in it (owner)
  'POST /api/cameras/:id/record/stop': SIGNED_IN,
  'POST /api/cameras/:id/ptz/nudge': SIGNED_IN, //              moving the camera to see the child (owner)
  'POST /api/cameras/:id/restart': SIGNED_IN, //                a recovery action for every viewer (owner)
  'POST /api/cameras/:id/reboot': SIGNED_IN, //                 ditto, heavier; ONVIF cameras only (owner)
  'POST /api/cameras/:id/snooze': SIGNED_IN, //                 mutes a camera's alerts, capped at 12 h (owner)
  'GET /api/cameras': SIGNED_IN, //                             admin sees more fields (see header)
  'GET /api/cameras/alerts': SIGNED_IN,
  'DELETE /api/cameras/alerts': ADMIN, //                       the whole alert history
  'DELETE /api/cameras/alerts/:id/clip': ADMIN, //              #538: one alert's clip, irreversibly
  'PUT /api/cameras/alerts/:id/protected': ADMIN,
  'GET /api/cameras/clips': SIGNED_IN,
  'GET /api/cameras/clips/protected': ADMIN,
  'GET /api/cameras/:id/sensor-history': SIGNED_IN,
  'GET /api/cameras/:id/activity-history': SIGNED_IN,
  'GET /api/cameras/:id/nightlight': ADMIN, //                  Nightlight Camera sensors: asks the camera now (a server-side request to its address)
  'PUT /api/cameras/:id/nightlight': ADMIN, //                  switches its sensors on or off, per group; on re-asks the camera
  'GET /api/cameras/:id/recording-readiness': ADMIN, //        #394: read-only status for the camera settings page, which is admin-only
  'POST /api/cameras/clips/delete': ADMIN,
  'PUT /api/cameras/reorder': SIGNED_IN, //                     #675 (was ADMIN, #552): arranging the tiles is day-to-day; a non-admin's reorder that would change a tracked child's sleep camera is refused IN THE HANDLER (409, see header)
  'POST /api/cameras/verify-talk': ADMIN,
  'POST /api/cameras': ADMIN,
  'PUT /api/cameras/:id': ADMIN,
  'PUT /api/cameras/:id/enabled': ADMIN,
  'PUT /api/cameras/:id/detection': ADMIN,
  'PUT /api/cameras/:id/assign': ADMIN, //                      #552: unassigning stops tracking, like track_sleep off
  'DELETE /api/cameras/:id': ADMIN,

  'GET /api/settings': OPTIONAL, //          the public half feeds the login screen; admins get the rest
  'GET /api/settings/mqtt': ADMIN,
  'GET /api/settings/mqtt/status': ADMIN,
  'GET /api/settings/clip-storage': ADMIN,
  'GET /api/settings/clip-retention-preview': ADMIN,
  'GET /api/settings/sleep-rewrite': ADMIN,
  'POST /api/settings/sleep-rewrite': ADMIN,
  'POST /api/settings/sleep-rewrite/undo': ADMIN,
  'PUT /api/settings': ADMIN,

  'GET /api/logs': ADMIN,
  'DELETE /api/logs': ADMIN,
  'GET /api/diagnostics': ADMIN,
  'GET /api/remote-access': ADMIN,
  'GET /api/remote-access/tailscale': ADMIN,
  'PUT /api/remote-access/tailscale': ADMIN,
  'POST /api/remote-access/tailscale/actions': ADMIN,
  // 2026-11-06: the one non-admin route here. Any signed-in user (a caregiver included) may read the single https address the phone
  // app falls back to; it carries no other Tailscale detail and the address only opens from inside the tailnet. Who gains access:
  // caregivers, to that one address.
  'GET /api/remote-access/tailscale/address': SIGNED_IN,
  'GET /api/remote-access/address': SIGNED_IN,
  'GET /api/esphome/devices': ADMIN,
  'POST /api/esphome/devices': ADMIN,
  'PUT /api/esphome/devices/:id': ADMIN,
  'DELETE /api/esphome/devices/:id': ADMIN,
  'GET /api/esphome/devices/:id/entities': ADMIN,
  'POST /api/esphome/test': ADMIN,
  'GET /api/esphome/settings': ADMIN,
  'PUT /api/esphome/settings': ADMIN,
  'GET /api/esphome/export': ADMIN,
  'GET /api/events': ADMIN,
  'DELETE /api/events': ADMIN,
  'GET /api/about': SIGNED_IN,

  // The FCM image alert is fetched by Android's system layer, which cannot send the app's token. Safe
  // because the id is 256 random bits and the frame expires in minutes (see routes/push.js).
  'GET /api/push/snapshot/:id': PUBLIC,
  'POST /api/push/register': SIGNED_IN,
  'POST /api/push/unregister': SIGNED_IN,
  'GET /api/push/config': SIGNED_IN, //      the Firebase CLIENT config, which a client needs by design
  'GET /api/push/status': SIGNED_IN,
  'PUT /api/push/enable': ADMIN,
  'GET /api/pushover/config': ADMIN,
  'PUT /api/pushover/config': ADMIN,
  'POST /api/pushover/test': ADMIN,
  'GET /api/ntfy/config': ADMIN,
  'PUT /api/ntfy/config': ADMIN,
  'POST /api/ntfy/test': ADMIN,
  'GET /api/gotify/config': ADMIN,
  'PUT /api/gotify/config': ADMIN,
  'POST /api/gotify/test': ADMIN,
  'GET /api/notifications/status': ADMIN,

  'GET /api/timelapses/child/:childId': SIGNED_IN,
  'GET /api/timelapses/:id/video': MEDIA,
  'GET /api/timelapses/:id/thumb': MEDIA,
  'DELETE /api/timelapses/:id': ADMIN, //               a keepsake that cannot be rebuilt
  'GET /api/recordings/child/:childId': SIGNED_IN,
  'GET /api/recordings/:id/video': MEDIA,
  'GET /api/recordings/:id/thumb': MEDIA,
  'PUT /api/recordings/:id/protected': ADMIN,
  'DELETE /api/recordings/:id': ADMIN, //               #552: a manual recording or a wake clip; no retention for the former

  'GET /manifest.webmanifest': PUBLIC, //    the PWA manifest; a browser fetches it without credentials
};
