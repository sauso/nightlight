# Changelog

All notable changes to Nightlight (server + web app) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/). While on 0.x: minor bumps for new
features, patch bumps for fixes. History before 0.1.0 exists only as git history —
0.1.0 is the first tracked release, not the first release.

## [Unreleased]

### Fixed
- **Compatibility-mode (HLS) audio is no longer choppy.** For cameras that send jittery audio
  timestamps (e.g. the Sonoff), the fix that kept HLS from dropping to "No signal" was itself
  dropping/inserting audio samples, so the sound stuttered constantly. The audio timeline is now
  rebuilt from the sample count instead, which stays perfectly in order for the player **without**
  discarding samples — so Compatibility mode sounds clean. Low-latency (WebRTC) audio was never
  affected. (On a badly glitching camera, audio may now drift slightly out of lip-sync rather than
  stutter — a deliberate trade.)

## [0.14.0] - 2026-08-14

### Changed
- **Temperature & humidity on camera tiles are larger and bolder** (~20%) so the readings are easier
  to see at a glance.

### Changed
- **Child-centred navigation.** Four bottom tabs — **Live · Children · Cameras · Settings** (the
  Alerts and Family tabs are gone). **Children** is now its own tab that opens each child's page
  (their cameras, their alerts, and — soon — their sleep summary); tap a child's **avatar** to edit
  them. **Cameras** is its own tab with richer rows (live thumbnail + Online/Offline pill). Caregiver
  management moved into **Settings** (admin). Alerts now live on each child's page (filtered to their
  cameras).

### Added
- **Avatar photos for children, caregivers and your own account.** Add a photo (child → avatar →
  Add photo; a caregiver's settings; Settings → Account). It's resized in your browser and saves
  immediately; the coloured initials remain the fallback everywhere an avatar shows.
- **ntfy and Gotify notifications.** Push notifications is now a hub (a row per provider, like the
  Settings screen) covering **Pushover, Firebase, Gotify, and ntfy** — enable any combination and an
  alert goes to all of them. ntfy (ntfy.sh or self-hosted) carries the snapshot inline and works on
  iOS; Gotify is self-hosted, text-only. Each provider has its own config page with a Send-test button.
  See `docs/notifications.md`.
- **Two-factor authentication (TOTP).** Optional, per-account: Settings → Account → Two-factor sets it
  up from an authenticator app (QR or manual key) and issues 10 one-time backup codes. Login then asks
  for the 6-digit code after the password. Recovery is covered by backup codes, an admin "Reset
  two-factor" action on a caregiver, and a console failsafe (`src/scripts/reset-mfa.js`) for a locked-out
  admin — see `docs/mfa.md`. Works over LAN http, remote HTTPS, and in the app (no secure-context needed).
- **Download a diagnostics bundle for bug reports** (Settings → Logs → "Report a problem", admin
  only). One click saves a redacted JSON snapshot — version/build, host + runtime info, camera &
  detection settings, live stream/MQTT/push status, and recent detection + camera-history events +
  server logs — to attach to a GitHub issue. Secrets (all passwords/tokens, credential-bearing
  URLs) are reduced to "is it set?" booleans, never their values, so it's safe to share. In the
  Android app it saves straight to the phone's Downloads folder (falling back to the share sheet on
  older devices), since the WebView can't do a browser-style download.
- **Swipe right to go back a screen.** A horizontal swipe from the left half of the screen pops one
  step back (Settings → MQTT, Family → Camera, etc.), like the nav-bar back button. Not active on
  the Live dashboard, where the tiles own their own gestures.
- **Android hardware Back / edge back-gesture steps back through screens** (via the native app's new
  `@capacitor/app` plugin) instead of exiting on the first press.
- **The camera cog sheet now has quick controls.** *Connection mode* (Low / Compatibility) and
  *Quality* (High / Low) are segmented buttons, and admins get **quick Motion / Sound / Alert
  schedule toggles** — each with its icon, matching the camera-settings styling — right there,
  no need to open full camera settings just to arm or silence detection. Stop/Start camera is now
  its own button. (Enabling the schedule for the first time seeds a 20:00–07:00 window you can
  refine in full settings.)
- **Children and caregivers now open their own screens** (like cameras) instead of pop-up modals —
  reached from the Family hub. Each shows an avatar (initials for now) with room for a photo later.
- **Edit your own name.** Settings → Account now lets any user set their First/Last name (the login
  username stays admin-managed).
- **Settings hub tidied:** your Account sits at the top in its own card; About and Change server
  share a card; and the **MQTT row shows its live connection status as a coloured badge** for
  admins — green Connected, red Disconnected, grey Off.
- **Swipe the camera cog sheet down to dismiss it** on touch devices (in addition to the backdrop
  tap / Done button). Stop camera now has a stop icon and a red outline; Camera settings has a cog.
  Stop and Camera settings share a row to save space, and swiping the sheet down no longer also
  triggers the dashboard's pull-to-refresh.

### Fixed
- **PTZ no longer dims the video or eats arrow taps.** The pan/tilt pad reused the new gear-sheet's
  dimmed backdrop, which sat over the arrows — it now has its own transparent layer, so the D-pad
  works again.
- **Settings sub-pages (General / MQTT / Push / Logs / Users) put their back button in the nav bar**
  like every other page, instead of a stray link below it.
- **Opening a camera, child or caregiver form no longer pops up the keyboard** automatically.
- **MQTT** has its own logo icon in Settings, and its description now reflects that it's used for
  both room sensor readings and camera-side motion detection (not just temperature/humidity).
- **Light-mode polish:** form fields are now white (not pale lavender) in light mode; the MQTT icon
  is cropped to fill its space like the other icons; and list/menu labels (Pushover, Firebase,
  children, cameras…) are larger and easier to read.
- **More light-mode polish:** the MQTT settings icon is aligned and sized to match the others; the
  ONVIF "Fetch" and "Verify login" buttons are now a filled periwinkle (matching an active toggle)
  so they read clearly in light mode.

### Added
- **Per-camera settings are now their own screen.** Editing or adding a camera opens a full page
  (instead of a modal), reached from a camera's tile gear ("Camera settings") or the Family hub.
- **Motion, Sound and Schedule are now separate screens** under each camera, replacing the single
  long detection form. Changes apply immediately (no Save button) — toggles are switches, and the
  alert snapshot URL lives with the motion settings.
- **Family screen redesigned** to list your children (with camera counts), cameras (each showing
  MOTION / SOUND / PTZ / TALK capability badges), and — for admins — caregivers, all inline.

### Changed
- **New visual theme.** A lighter, calmer look: periwinkle for interactive elements (tabs, switches,
  sliders), your accent colour (gold by default) for primary buttons and the camera glow, and a navy
  top bar. Light is now the default; Dark and System are still under Settings → Account → Appearance.
- **New bottom navigation: Live · Alerts · Family · Settings.** The old Nursery/Children/Cameras
  tabs are reorganised into two hubs — **Family** (Children, Cameras, and — for admins — Caregivers)
  and **Settings** — plus a dedicated **Alerts** tab (feed built out separately). Sub-pages now have
  a labelled back button ("‹ Family", "‹ Settings") that returns you to where you came from.
- **Room temperature and humidity now show with thermometer / droplet icons** on each camera tile,
  so the two readings read at a glance instead of running together in one line.
- **The camera tile's gear opens a bottom sheet** (grabber, grouped Stream / camera rows, Done)
  instead of a small pop-up menu. It keeps Low latency / Compatibility, quality and Stop camera, and
  — for admins — adds a **Camera settings** shortcut that opens that camera's full settings directly.
- **Light theme.** Settings → Account → Appearance now offers Light / Dark / System (follows your
  phone). The choice is per-device, like mute and stream quality.
- **Alerts tab feed, with snapshots.** The Alerts tab now shows the motion/sound detection feed to
  any signed-in user (previously it was buried in the admin-only Logs screen) — auto-refreshing, with
  clear-history kept admin-only. Each detection's snapshot is now **saved and shown as a thumbnail**,
  so the feed is a useful record even with no push notifications set up. The image is captured on
  every detection (not just when push is enabled), stored one file per alert, and pruned along with
  the alert history (kept up to 30 days).

### Changed
- **Settings that apply the moment you flip them now use a pill toggle switch** instead of a
  checkbox — "Send motion alerts to this device", Enable MQTT, Enable Pushover / Firebase
  notifications, and the Logs auto-refresh. Checkboxes are kept for settings that only take effect
  when you press Save, so the control's shape tells you whether a change is instant or pending.
- **Account, About, Change server and Sign out moved out of the header menu into the Settings tab.**
  The header's hamburger menu is gone — everything it held now lives under Settings, with the app
  version shown inline on the About row. Caregivers see a slimmed Settings (Account + About);
  admins additionally see General, MQTT, Push and Logs.

## [0.13.0] - 2026-08-10

### Added
- **Adjustable PTZ step size** (Settings → General → Camera controls). Sets how far a camera moves
  per tap of the pan/tilt D-pad, for cameras using precise RelativeMove positioning. Defaults to 12
  (suits the common Sonoff pan/tilt cams); tune to taste.

### Fixed
- **PTZ steps are consistent on cameras with erratic ONVIF timing.** Cheap pan/tilt cams (Sonoff/
  thingino) answer the ONVIF *ContinuousMove* call with wildly variable latency (0.3–2.2 s) and move
  the whole time, so a fixed "start → hold 200 ms → stop" nudge travelled a different distance every
  press — the camera felt like it ran on unpredictably. Nightlight now uses ONVIF **RelativeMove**
  (the camera moves a fixed distance and stops itself — no timing race) on cameras that support it,
  falling back to the old continuous-move nudge on those that don't. Support is detected once per
  camera and cached.

## [0.12.0] - 2026-08-10

### Added
- **Sound detection (crying / loud noise).** A new per-camera **Sound detection** toggle listens to
  the camera's audio and alerts when sound stays **above the room's ambient level** for a set time.
  It **learns the ambient continuously** — a white-noise machine or fan (even switched on hours after
  boot) is absorbed into the baseline, so only a sustained rise above it (like crying) triggers.
  Per-camera **sensitivity / confirm / cooldown**, shares the same quiet-hours schedule as motion,
  same Recent-alerts + Firebase/Pushover push (with snapshot). Needs a camera with a microphone;
  off by default. (Cry-*classification* is a possible later add-on if loudness proves too noisy.)
- **MQTT motion source — let the camera detect motion.** Each camera now has a **Detection source**:
  *Nightlight (frame difference)* — the existing, works-on-any-camera default — or **Camera via
  MQTT**, where the camera detects motion on its own hardware (thingino, sonoff-hack, etc.) and
  publishes it; Nightlight just consumes the event. That uses **~no server CPU** for that camera and
  is usually more accurate. Set the camera's **motion topic** (and, only if needed, a payload value —
  it auto-recognises `ON`/`true`/`1`/`motion`/`{"motion":true}` and similar). Same downstream as
  frame-diff: Recent-alerts entry + Firebase/Pushover push, same per-camera cooldown and quiet-hours.
- **Optional camera snapshot URL.** If a camera exposes an HTTP snapshot endpoint, set it and alert
  images are grabbed from it — instant and clearer than pulling a frame from the stream (no keyframe
  wait). Basic-auth in the URL is supported; blank falls back to the stream grab. Works for both
  detection sources.
- **Alerts open the server that sent them (multi-server deep links).** If you use the app against
  more than one Nightlight server (e.g. production and a staging box), tapping an alert now opens the
  **server the alert came from** instead of whichever server the app happened to be showing. Each
  server learns its own public address automatically (zero-config, from the app on registration) and
  stamps it onto its alerts — Pushover via the deep link, Firebase via the notification payload. If a
  server hasn't learned its address yet, alerts open in place as before. (Needs app **v0.7.0+** for
  the switch to take effect.)

### Fixed
- **Motion-alert snapshots grab more reliably.** The one-shot frame grab has to wait for the
  camera's next keyframe, so on cameras with a long keyframe interval it occasionally hit the 5s
  timeout and the alert (both channels) went out text-only. Startup buffering is trimmed and the
  timeout raised to 8s so almost all grabs land; a rare miss still falls back to text cleanly.

## [0.11.0] - 2026-08-09

### Added
- **In-app banner for push alerts while the app is open.** Android doesn't show a system-tray
  notification for a Firebase push that arrives while the app is in the foreground, so those alerts
  were previously invisible until you backgrounded the app. A motion alert now shows a tappable
  in-app banner (tap → nursery) when it arrives with the app open. (Pushover already shows its own,
  as a separate app.)
- **Firebase motion alerts now include the snapshot too** (previously Pushover-only). FCM can't
  carry image bytes, so the triggering frame is served from a short-lived, unguessable URL that the
  phone fetches — built on the address each device reaches the server through (works on the LAN or
  remotely). The URL holds a single frame for a few minutes, then expires. The frame is captured
  once and shared by both channels.

## [0.10.0] - 2026-08-09

### Fixed
- **PTZ now works on cameras whose ONVIF user is password-protected.** PTZ commands skip the ONVIF
  connect handshake (to tolerate minimal cameras), which also skipped the WS-Security clock sync — so
  authenticated moves carried a stale ~1970 timestamp that cameras enforcing auth rejected. PTZ now
  seeds the clock (from the camera's own time, falling back to the server's) before each move.
- **PTZ nudges are steadier and no longer "run away" past a tap.** Each nudge's Stop was best-effort
  with no retry, so a single dropped/rejected Stop let the move coast to its ~3s failsafe; the Stop is
  now retried and logged and the failsafe shortened. Nudge speed was also lowered so cameras with slow,
  variable ONVIF response (e.g. Sonoff-hack) travel a smaller, more consistent amount per tap. PTZ now
  logs a per-nudge line (velocity, timing, Stop result) for troubleshooting.

### Added
- **Per-camera alert schedule ("only alert during set hours").** In a camera's Motion detection
  settings you can now restrict alerts to a time window — e.g. 20:00 to 07:00 (overnight windows
  work). Outside the window, motion is ignored completely: **no push and no in-app Recent-alerts
  entry**. Uses the app timezone from Settings; off by default (alert 24/7).
- **Pushover notifications** as an alternative to Firebase — much simpler to set up and it **works on
  iOS** (the recipient installs the Pushover app; no Firebase project, no Apple Developer account).
  Configure an application token + user/group key in **Settings → Push notifications**; it validates
  with Pushover on save and has a **Send test** button. Motion alerts include a **snapshot** of the
  frame that triggered them and a deep link to open the Nightlight app. Firebase remains available.

## [0.9.0] - 2026-08-04

### Added
- **A dedicated "Enable push notifications" switch in Settings → Notifications**, separate from motion
  detection. Turning it on **validates your Firebase files are present and valid** and refuses (with a
  message naming what's missing) otherwise, so push can't be left half-configured. Motion detection
  and the in-app **Recent alerts** list are unaffected — they work with or without push.
- **A "Clear log" button on each list under Settings → Logs** (Recent alerts, Camera history, and
  Recent logs), each behind an in-app "are you sure?" confirmation. Clearing the logs buffer doesn't
  affect `docker logs`.

### Changed
- **Settings is now split into focused sub-pages** instead of one long scroll: a hub lists **General**
  (app name, timezone, theme, font, colours, temperature unit), **MQTT**, **Push notifications**,
  **User management**, and **Logs** (recent alerts, camera history, server logs). **Caregiver accounts
  and "all active sessions" moved out of Account into Settings → User management**; Account keeps your
  own profile, password, this-device sessions, and per-device notification toggle.
- **Push is now off until an admin enables it** (above), rather than sending as soon as the Firebase
  files exist. Enabling also initializes Firebase on the spot, so dropping the files in no longer
  needs a container restart.

### Fixed
- **Motion detection can now be set when *adding* a camera**, not only when editing — the Add camera
  form gained the same Motion detection section, applied as soon as the camera is created.

## [0.8.0] - 2026-08-04

### Added
- **Motion detection (per camera).** Turn it on for a camera in Cameras → edit and Nightlight
  watches its video server-side for movement, logging an alert (Settings → **Recent alerts**) when
  motion is sustained past a confirmation delay — at most once per cooldown. Tunable **sensitivity**,
  **confirm** delay, and **cooldown** per camera. It samples the low-quality sub-stream when there is
  one (so it's cheap), and is off by default. Currently watches the whole frame — a crib-zone picker
  is a planned follow-up.
- **Push notifications for detection alerts (Android).** When a camera with motion detection sees
  movement, the server sends a push notification to the app, so you're alerted even when it's closed.
  Self-hosted-friendly: each install uses its **own Firebase project** — drop your Firebase
  **service-account** key and **google-services.json** into `DATA_DIR` (absent = push simply disabled;
  the in-app **Recent alerts** list works regardless), and the app initializes Firebase at runtime
  from your server (the released APK is generic — nothing baked in). Opt in per device under
  **Account → Notifications**. Full setup in `docs/notifications.md`. iOS waits on APNs (deferred).

## [0.7.1] - 2026-08-03

### Changed
- **The audio-liveness watchdog now recovers stalled audio in ~30–60s instead of 2–4 minutes.**
  It checks every 30 seconds (was every 2 minutes); it still requires two consecutive stalled
  checks before restarting a camera, so brief blips are ignored. The check is cheap on a healthy
  camera (it returns in well under a second), so the faster cadence adds negligible load — a
  genuinely stalled camera is just healed much sooner. A chronically flaky camera will restart
  more often as a result; the real fix for that is the camera itself.

## [0.7.0] - 2026-08-03

### Added
- **Choose stream quality per camera (High/Low).** If a camera exposes a lower-resolution
  sub-stream, add its path in Cameras → edit ("Low-quality stream path", e.g. `/Streaming/Channels/102`
  on Hikvision) and each tile gains a High/Low choice in its settings menu. Low is a fallback for
  slow or congested connections; the tier comes straight from the camera's second stream, so there's
  no extra video transcoding on the server. The choice is per-device (like mute). *(The sub-stream
  currently runs continuously alongside the main one; an on-demand version is a planned follow-up.)*
- **Two-way audio (talk-back).** Cameras that support it now show a **talk** button — tap to start
  talking through the camera's speaker (the button turns red and pulses while live), tap again to
  stop (and it auto-stops after a couple of minutes as a safety net). Your voice is captured, encoded
  to G.711, and streamed to the camera, and the camera's own audio is ducked while you talk (it's
  half-duplex). Set it up per camera in Cameras → edit by entering the camera's
  **web login** (for Hikvision, the User Management account — separate from the ONVIF user). Only the
  Hikvision ISAPI backend is implemented so far.

## [0.6.3] - 2026-08-02

### Removed
- **iOS Compatibility-mode background audio is no longer supported** (it was added in 0.6.2). On iOS
  a Compatibility (HLS) stream is a native media item that iOS controls itself — it inconsistently
  showed the camera name/artwork, wouldn't reliably route the lock-screen Pause, and got confused
  with several cameras or when switching modes. It caused more problems than it solved, so it's been
  removed along with its server-side audio-only sidecar stream. **Background listening on iOS now
  requires Low latency**, which works reliably (its WebRTC audio isn't a native media item, so
  Nightlight fully owns the lock-screen name, artwork, and controls). The Background option is
  hidden for a camera set to Compatibility on iOS. Android is unaffected — both modes still do
  background audio there via the foreground service. See KNOWN-ISSUES.md.

### Fixed
- **Pull-to-refresh no longer restarts the cameras server-side.** The server-side reconnect added in
  0.6.2 restarted the transcoders for *every* device, so a refresh on one phone interrupted the
  stream on every other viewer. Pull-to-refresh is back to a local, client-only reconnect; a genuine
  upstream wedge is handled by the server's own audio-liveness watchdog.
- **Stopping the cameras now clears the Now Playing tile immediately.** Previously it could leave a
  stale, paused lock-screen tile behind whose Play button did nothing.

## [0.6.2] - 2026-08-01

### Added
- **Self-healing for stalled camera audio.** A new watchdog periodically checks that each camera's
  audio is actually *flowing* (not just that the track is declared) and force-restarts a camera
  whose audio has stalled while video kept going — a state the existing frame/ready watchdog can't
  see (the stream still reads "ready"), and the reason sound would work in VLC but not the app until
  a manual restart. Confirmed over two consecutive checks so a blip never triggers a needless restart.
- **Pull-to-refresh now reconnects the cameras server-side**, not just the client. Previously a
  refresh only rebuilt the phone's connection, which couldn't fix a stream wedged upstream; now it
  also restarts the transcoders, so pulling to refresh clears that class of problem.
- **Compatibility (HLS) mode can now sustain background audio on iOS too** — previously only Low
  latency (WebRTC) could, because iOS suspends the video element HLS plays through. The transcoder
  now also publishes an audio-only stream that iOS keeps alive in the background. (Audio smoothness
  in Compatibility mode depends on the camera's keyframe cadence; Low latency stays the smoothest.)

### Changed
- The lock-screen / Now Playing artwork is now a clean full-frame image, with no white or coloured
  border at any size.

### Fixed
- Low-latency (WebRTC) audio/video could silently stop reaching clients after a container
  restart or deploy: MediaMTX's WebRTC address auto-detection sometimes ran before host
  networking was ready and advertised only `127.0.0.1` (unreachable by any client) for the whole
  session — while every camera still showed healthy, because nothing in the stream health touches
  the WebRTC ICE candidate. The app now detects the host's own routable IP and passes it to
  MediaMTX explicitly (alongside any `PUBLIC_HOST`), and waits briefly for the network at startup,
  so a reachable WebRTC address is always advertised.

## [0.6.1] - 2026-07-31

### Fixed
- Switching servers ("Change server" in the native app) now immediately stops all camera
  audio/video and the background-audio service before restarting, instead of leaving the old
  server's sound playing after the switch and stacking a second audio session when you returned.
- The app is no longer pinch/double-tap **page-zoomable** (it's a fixed-layout app, not a
  scrollable document). This fixes an Android bug where double-tapping the Picture-in-Picture
  window zoomed the entire UI and left it stuck zoomed until an app restart. (A camera tile's
  own double-tap-to-zoom is a separate JS/CSS transform and still works.)
- The lock-screen / Now Playing title (and the Android background-listening notification) shows
  the **camera's name** when you're listening to one camera, or **"Multiple Cameras"** when
  several are in Background mode — updating live as cameras join or leave. Pausing/resuming from
  the lock screen now pauses/resumes **all** the background cameras together, not just one.
- On the mobile lock screen / Now Playing, a Background-audio camera now shows its **name and
  app artwork** (instead of just "Nightlight" with a blank tile), and its **Pause/Play controls
  work** — Pause genuinely pauses and Play resumes, instead of dropping the session (which showed
  another app's "now playing" and couldn't be resumed from the lock screen). Background audio on
  iOS runs through **Low latency** mode, which keeps playing with the screen off; Compatibility
  (HLS) is a foreground option there, since iOS suspends its video element in the background.
- Fixed Background-mode audio staying silent after a lock-screen/notification Pause until a full
  app restart: tapping a tile's audio button now clears a lingering background-pause.
- On iOS, a camera in **Compatibility** mode no longer offers the Background-audio state (its
  speaker toggle is just mute/unmute) — since iOS can't sustain HLS audio in the background,
  offering it there was misleading. Switching a camera to Compatibility while it's listening in
  Background drops it back to plain On.
- A failed ONVIF fetch caused by a wrong/missing ONVIF username or password now says so
  explicitly ("The ONVIF username or password appears to be incorrect… repeated wrong attempts
  can temporarily lock the camera"), instead of a vague "no media profiles found" — and a
  camera that has already locked itself out reports that clearly too. This stops the blind
  retrying that triggers the lockout in the first place.
- Errors while adding/editing a camera (a failed ONVIF fetch, or a save that couldn't reach
  the camera) now appear **inside the add-camera dialog** instead of in the page banner hidden
  behind it, so you can actually see what went wrong.
- A failed ONVIF fetch now returns a normal 4xx (not a 5xx), so a reverse proxy (e.g.
  Cloudflare) passes the real error message through instead of swallowing it and showing a
  bare "Request failed (502)". Also capped the probe at 18s so a truly unresponsive camera
  still fails with a clear message rather than hanging.

## [0.6.0] - 2026-07-28

### Added
- **Stop/Start a camera's playback per device**, from the tile's ⚙ menu. Stopping tears that
  camera's stream down on this device only (showing a "Camera stopped" message) so you can kill
  the ones you don't need and save bandwidth — handy on cellular — without affecting the
  server-side stream or other viewers. The choice is remembered per camera on that device.
- **Enable/Disable a camera** from the Cameras screen, alongside Edit and Remove. Disabling
  turns the whole stream off server-side (stops its transcoder and drops its MediaMTX path, so
  it consumes no camera/network/server resources) and hides it from the live grid, without
  deleting the camera or its history. Re-enable to bring it back.
- The Cameras screen now shows three capability flags — **ONVIF**, **PTZ**, and **Two-way
  Audio** — on every camera (green = yes, red = no), for consistency, rather than only on
  ONVIF-added ones.

### Changed
- The Cameras screen cards were reorganised so the Edit/Remove/Enable actions line up with the
  camera name at the top of the card instead of floating against the middle of the details.

### Fixed
- Disabling or removing a camera in the native app no longer crashes the whole UI. Tearing down
  a tile's native background-audio listener assumed Capacitor's `addListener` returned a promise;
  on versions where it returns the handle directly this threw `.then is not a function` during
  the tile's unmount. Listener teardown now handles both shapes.
- An unexpected UI error no longer blanks the whole app to a white screen that needs a restart
  to recover — a top-level error boundary now catches it and offers a Reload button (showing the
  underlying error for diagnosis) while keeping the app running.
- The lock-screen / Now Playing controls (mobile) now show the camera that's actually in
  Background mode, instead of whichever camera connected most recently. Ownership of the
  system media session is now held only by the Background-audio camera rather than clobbered
  by every camera on connect.

## [0.5.2] - 2026-07-27

### Added
- The About page now shows **build provenance** for the running instance — branch, short
  commit, and build date. Lets you confirm exactly which code a server is running (e.g. that
  a dev push actually reached staging, or which commit is in production) without relying on
  the version number, which only changes at release.

### Fixed
- The add/edit/remove dialog title no longer detaches and floats at the top of the screen
  when the dialog's content is scrolled (a regression from the 0.5.1 keyboard fix); the
  header now scrolls with the content as normal.

## [0.5.1] - 2026-07-27

### Fixed
- Add/edit dialogs no longer get pushed up under the status bar/notch when the on-screen
  keyboard opens on mobile, hiding the field you're typing in. The dialog now sizes itself to
  the space above the keyboard and scrolls internally (so the focused field stays visible),
  its top stays clear of the safe area, and the title/close row stays pinned at the top.

## [0.5.0] - 2026-07-27

### Added
- **ONVIF auto-fill when adding a camera.** Enter the camera's IP and ONVIF username/password
  in the Add-camera form and Nightlight connects over ONVIF to fetch the RTSP URL and detected
  codec/resolution automatically, instead of hand-typing the RTSP path. Resilient to minimal
  ONVIF servers (falls back to the media service directly when a camera faults on the usual
  capability calls) and reconstructs the RTSP URL from the camera's IP + your credentials
  rather than trusting the (often wrong) host/creds the camera returns. Manual RTSP entry
  stays available. This is Phase 1 of planned ONVIF support (discovery-by-IP; multicast scan
  intentionally skipped as it can't cross VLANs). See `planning/onvif-and-two-way-audio-scope.md`.
- **Two-way-audio capability detection.** Adding a camera via ONVIF now also checks whether it
  exposes an audio output (the two-way-audio backchannel) and shows a badge in the Cameras
  list ("Two-way audio" / "No two-way audio"). Informational for now — groundwork for actual
  push-to-talk later, which will only ever be offered on cameras that report support. (Phase 2
  of the ONVIF plan.)
- **Pan/tilt control (PTZ).** Cameras that report PTZ over ONVIF get a move button on their
  camera tile; tapping it opens a D-pad. Each press moves a fixed, consistent amount — the
  server starts, briefly holds, then stops the move ("nudge"), so distance doesn't depend on
  how long you tapped or on network timing. Holding an arrow repeats the nudge for continued
  movement, and every move self-stops (with a server-side timeout backstop), so it can't run
  away past the limit. Only shown on PTZ-capable cameras. See `planning/ptz-control-scope.md`.
- **PTZ and Two-way Audio badges** in the Cameras list for ONVIF-added cameras — green when
  supported, red when not. (Manual cameras show neither, since their capabilities aren't
  probed.)
- **Stream validation on save.** Adding or changing a camera's address now tests the RTSP
  stream first (over TCP, briefly) and reports failures like wrong credentials or an
  unreachable path up front, instead of silently saving a dead camera. If it can't reach the
  camera (e.g. it's momentarily offline) it offers "save anyway."

### Changed
- **Camera credentials are entered as separate fields, not inside the RTSP URL.** The
  add/edit camera form takes IP address, port, stream path, username, and password as
  distinct fields, and the app assembles the `rtsp://` URL server-side. The password is never
  sent back to the browser or shown in a URL: the Cameras list shows a credential-free
  address, and when editing, the password field is blank and left blank means "keep the
  existing password." Fixes credentials being visible in plain text on the camera screen.
- **ONVIF auto-fill simplified** to a single "Fetch" button that uses the IP you've already
  entered — no separate ONVIF login fields. Credentials are optional for the fetch (most
  cameras answer unauthenticated); you enter the camera login once, in the shared username/
  password fields.

## [0.4.9] - 2026-07-27

### Changed
- A brand-new visitor on a device now starts **muted** rather than unmuted. Muted audio
  autoplays cleanly (no browser gesture needed), and it's the politer default. Returning
  visitors are unaffected — each camera still remembers whatever you last set it to.

### Removed
- The "🔈 Tap for sound" prompt. When a browser blocks unmuted autoplay (no interaction yet
  on the page), the stream now just resumes silently on your first click/tap anywhere
  instead of showing a prompt to dismiss. Combined with the muted default above, most opens
  never hit the block at all.

## [0.4.8] - 2026-07-27

### Fixed
- Camera tiles are now 16:9 (were 16:10), matching the native aspect ratio of virtually all
  IP cameras. The taller tile made `object-fit: cover` crop the left/right edges, which was
  hiding the camera's own on-screen timestamp; at 16:9 the full frame shows.

### Changed
- Softened the camera tile corners a little less aggressively (16px → 10px radius).

## [0.4.7] - 2026-07-27

### Changed
- Leaving Picture-in-Picture now returns you to where you were, not always to fullscreen.
  If you opened PiP from the dashboard, expanding it back drops out of the fullscreen it
  used internally and returns to the dashboard; if you were already fullscreen on a camera,
  it stays fullscreen. (Uses the native PiP-mode signal from nightlight-mobile 0.4.1.)
- Restyled the on-video overlay controls (mute / settings / PiP / fullscreen): dropped the
  grey box, and the icons are now larger and white with a soft black glow, so they read
  cleanly over any footage without a heavy chrome background. Background-listening keeps an
  accent tint to stay distinguishable.

## [0.4.6] - 2026-07-27

### Added
- Background audio can now be **paused and resumed** from the system media controls -
  Android's notification (a Pause/Resume button next to Stop) and iOS's Now Playing
  controls (Control Center / lock screen). Pausing mutes the stream rather than
  disconnecting it, so resuming is instant and stays at the live edge. Both routes share
  one app-wide pause, so it stays consistent. (Android notification button needs
  nightlight-mobile 0.4.1; iOS is frontend-only via the Web Media Session API.)

### Fixed
- In the Android app, the on-video overlay buttons (mute / settings / fullscreen) are now
  hidden while a camera is floating in Picture-in-Picture, where they only obscured the
  small window. Driven by the native PiP-mode signal (nightlight-mobile 0.4.1).

## [0.4.5] - 2026-07-27

### Changed
- Minimizing the app now fully disconnects each camera stream unless it's in Background
  mode, instead of just muting it. Previously a backgrounded app in On/Off audio mode kept
  the WebRTC/HLS connection open — still pulling video and audio over the network and
  decoding it — until the OS eventually froze the WebView, a needless battery and data
  drain. The stream now tears down immediately on minimize (and reconnects on return).
  Background mode is deliberately exempt: keeping the connection alive with the screen off
  is its whole point. Affects both mobile apps.

## [0.4.4] - 2026-07-27

### Fixed
- Picture-in-Picture in the Android app now floats just the camera video instead of the
  whole app UI. Because Android's Activity PiP can only float the entire window, the PiP
  button now fullscreens the tile first (so the window *is* just the video) and then enters
  PiP. Auto-PiP-on-leave is likewise now gated on a camera being fullscreen — pressing Home
  from the grid just backgrounds normally (audio continues via the foreground service),
  while pressing Home from a fullscreen camera floats that camera. Frontend-only; works with
  the existing 0.4.0 APK. (Browser and iOS behavior unchanged — they use the web `<video>`
  PiP API, which already floats a single video.)

## [0.4.3] - 2026-07-27

### Fixed
- Camera timestamp glitches are now corrected at the source: FFmpeg replaces each incoming
  packet's timestamp with the server's arrival time (`-use_wallclock_as_timestamps 1`)
  rather than trusting the camera's own clock. Some cameras (e.g. the Sonoff GK-200MP2-B)
  send jittery/backward audio timestamps and occasional corrupt video timestamps; fixing
  them at the input covers *every* downstream track at once, including the WebRTC copy
  tracks that the HLS-only audio resampler (0.4.1) couldn't reach — so Low latency mode's
  audio flapping is addressed too, not just Compatibility mode. Trade-off: timing is now
  arrival-based, so A/V lip-sync may drift slightly; acceptable for a live monitor.

## [0.4.2] - 2026-07-27

### Fixed
- The camera tile's Picture-in-Picture button now works in the Android app. Android's
  WebView doesn't support the web `<video>` PiP API (which is why the button did nothing
  there, while working in a browser), so it now routes through the native shell's Activity
  PiP instead. Also auto-enters PiP when you leave the app while watching. Pairs with
  nightlight-mobile 0.4.0 — needs that APK; on older APKs it harmlessly falls back to the
  old behavior. (Android floats the whole app window, not a single tile — an OS
  limitation.)

## [0.4.1] - 2026-07-27

### Fixed
- Compatibility (HLS) mode no longer shows "No signal" when a camera sends jittery or
  briefly-backward audio timestamps. The AAC audio track now runs through an async
  resampler (`aresample=async=1`) that rebuilds a continuous, monotonic timeline, so the
  camera's audio-clock glitches (logged as "Queue input is backward in time") can't stall
  the HLS muxer. Root cause is camera-side (see `KNOWN-ISSUES.md`); this keeps
  Compatibility mode playable through it. Low latency (WebRTC) was unaffected either way.

## [0.4.0] - 2026-07-24

### Added
- **Pull-to-refresh** on the camera dashboard: pull down to rebuild every camera's stream
  connection without restarting the app. This is the fix for a camera that shows
  disconnected on one device and won't come back on its own - a WebRTC connection that's
  wedged "connected" but no longer delivering frames. Crucially it works inside the native
  mobile apps too, where the browser's own pull-to-refresh gesture doesn't exist (so the
  previous "just pull to refresh" advice couldn't actually be followed there). The
  browser's native page-reload pull is suppressed so it can't fire underneath it.

### Changed
- Troubleshooting docs, the Camera history panel, and `KNOWN-ISSUES.md` now point to
  pull-to-refresh (which works everywhere) rather than "close and reopen the app".

## [0.3.0] - 2026-07-24

### Added
- **Camera history** panel in Settings (admin): a persistent, at-a-glance log of camera
  drop-outs, recoveries, and transcoder restarts, so "was that the camera, the server, or
  just my phone?" can be answered from the app instead of by reading `docker logs`. A real
  outage shows up here (every device saw it); a camera stuck on only one phone with nothing
  in the history is that phone's WebRTC connection - reopen the app. Kept for up to 30 days
  and hard-capped so it can't grow the data volume unbounded.
- `KNOWN-ISSUES.md`, a catalogue of understood quirks (camera-firmware glitches, the
  wedged-WebRTC-on-one-device case, the 30s watchdog recovery window, DTS log noise) with
  what each means and whether it needs any action. Linked from the README's Troubleshooting
  section, which also gained a note about the reopen-the-app fix for a stuck camera tile.

## [0.2.5] - 2026-07-24

### Fixed
- The "Add to Home Screen" install banner no longer appears inside the native
  mobile app (it's only meaningful in a browser; the native WebView doesn't
  report standalone display mode, so it was slipping through).

## [0.2.4] - 2026-07-24

### Changed
- The About page's mobile-app GitHub link now points to `sauso/nightlight-mobile`
  (the companion repo was renamed from `nightlight-android` ahead of iOS support).

## [0.2.3] - 2026-07-24

### Security
- Upgraded react-router 6 → 7, clearing a moderate advisory (GHSA-337j-9hxr-rhxg,
  an SSR-only issue that this client-only SPA was never exposed to). No API
  changes were needed - the app uses only React Router's library-mode surface,
  which is unchanged in v7.

## [0.2.2] - 2026-07-24

### Fixed
- A camera glitch could leave two FFmpeg processes fighting over the same
  MediaMTX path indefinitely - MediaMTX lets a new publisher override the
  current one, so each process kicked the other off and restarted, flapping the
  stream every ~10 seconds (observed: 901 restarts over 2.5 hours overnight).
  A crashed process now only restarts itself if it still owns the camera, and
  re-checks ownership when its 5-second restart timer fires.

## [0.2.1] - 2026-07-23

### Added
- "Not a safety device" notice in the README and on the About page: Nightlight is
  not a medical device and never a substitute for adult supervision.

## [0.2.0] - 2026-07-23

### Added
- MQTT can now be switched off in Settings without losing the saved broker
  config - previously the only "off" was clearing the host, and a temporarily
  stopped broker meant endless reconnect attempts in the logs.
- Text filter on the log viewer (case-insensitive, with a match count) - much
  easier to find specific events on a phone.
- About page in the menu: app version, GitHub / changelog / issue links, and a
  way to support the project.

## [0.1.0] - 2026-07-23

### Added
- "Change server" menu item in the hamburger menu, shown only inside the Android app —
  clears the saved server address and returns the native shell to its setup screen
  (pairs with nightlight-android 0.1.0).

### Fixed
- White bar below the bottom navigation on iOS, revealed by Safari's elastic
  overscroll (the page background now extends behind the document).
- Gray placeholder play icon showing on camera tiles before a stream connects in the
  Android app (the WebView's default poster-less video affordance; suppressed with a
  blank poster).
- Returning to the Android app after long background listening no longer forces a full
  reload — the reload-on-return recovery is skipped when the native foreground service
  was holding the connection alive the whole time, so the stream continues unbroken.

### Security
- Camera edit/delete now require the admin role (previously any caregiver could
  repoint a camera's RTSP URL or delete cameras); the RTSP URL, which usually embeds
  the camera's own credentials, is no longer returned to non-admin accounts.
- Changing a password (self-service or admin reset) now signs out the user's other
  devices instead of leaving those sessions valid for up to 30 days.
- Failed logins take constant time whether or not the username exists, so response
  timing no longer confirms valid usernames.
- Express now runs in production mode in the image — error responses no longer include
  stack traces revealing server file paths.
- Correct client IPs behind the reverse proxy (`trust proxy` set to loopback), making
  the login rate limiter count attempts per real client instead of per proxy.
- Sessions idle past the token's own 30-day lifetime are purged daily.
- Docker builds install from committed lockfiles (`npm ci`) for a reproducible,
  auditable dependency tree; vite upgraded 5 → 8 (clears dev-server advisories); both
  packages audit clean.

[Unreleased]: https://github.com/sauso/nightlight/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/sauso/nightlight/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/sauso/nightlight/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/sauso/nightlight/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/sauso/nightlight/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/sauso/nightlight/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/sauso/nightlight/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/sauso/nightlight/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/sauso/nightlight/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/sauso/nightlight/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/sauso/nightlight/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/sauso/nightlight/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/sauso/nightlight/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/sauso/nightlight/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/sauso/nightlight/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/sauso/nightlight/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/sauso/nightlight/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/sauso/nightlight/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/sauso/nightlight/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/sauso/nightlight/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/sauso/nightlight/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/sauso/nightlight/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/sauso/nightlight/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/sauso/nightlight/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sauso/nightlight/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/sauso/nightlight/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/sauso/nightlight/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/sauso/nightlight/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/sauso/nightlight/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sauso/nightlight/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sauso/nightlight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sauso/nightlight/releases/tag/v0.1.0
