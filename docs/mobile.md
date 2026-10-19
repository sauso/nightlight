# Your home screen and the mobile apps

> This page was moved, word for word, from the old README. The wording has not been edited yet, and the cross-references to the reverse-proxy and remote-access sections now link to them.

## Installing to your home screen

The app has a web app manifest and icons for a full-screen, native-app-like home-screen
experience — no browser address bar. **It has no service worker**, so this is an install
shortcut, not an offline mode: the app still needs to reach your server over the network every
time, same as opening it in a tab.

What you actually get depends on the platform and whether the site is served over **HTTPS**
(via the [reverse-proxy setup](remote-access.md#running-behind-a-reverse-proxy-eg-swag-on-unraid)) or plain `http://` on your LAN:

| Platform | Over HTTPS | Over plain `http://` |
|---|---|---|
| Android — Chrome / Samsung Internet | Installable PWA (full-screen, own icon, install prompt) | Usually a browser-badged **shortcut** that still opens inside the browser, not a true standalone install — Chromium's installability criteria require HTTPS (or `localhost`) |
| iOS — Safari | Add to Home Screen (full-screen, own icon) | Add to Home Screen works the same over plain HTTP — iOS doesn't gate it on HTTPS the way Chromium does |
| Desktop browser | Installable as a windowed app (Chrome/Edge) | Same shortcut limitation as Android Chrome |

- **Android, HTTPS**: browser menu → "Add to Home screen" / "Install app" (or the automatic
  install banner).
- **Android, plain HTTP**: same menu item still adds something to your home screen, but expect
  a shortcut that opens in the browser rather than a standalone window.
- **iOS**: Share button → "Add to Home Screen" — works the same either way.

If you want the full installed experience on Android specifically, the reverse-proxy/HTTPS
setup ([Running behind a reverse proxy](remote-access.md#running-behind-a-reverse-proxy-eg-swag-on-unraid)) is worth doing; otherwise the **native Android app** (below) gives you a true
standalone app without needing HTTPS at all.

**Zooming the page.** In a browser, including a home-screen install, you can pinch-zoom the page as on
any other site. In the native apps (below) page zoom stays **locked**, because in the Android app
double-tapping the picture-in-picture window used to zoom the whole app and leave it stuck until a
restart. Double-tap zoom on a camera's video is the app's own and works everywhere.

- **Android and desktop browsers:** pinch-zoom works again (it used to be blocked).
- **iPhone and iPad (Safari, or any other iOS browser):** unchanged. Pinch-zoom already worked there,
  because Safari ignores the zoom lock for pinching, and the page still does not jump in when you tap
  into a text field, because Nightlight keeps the one setting that stops Safari doing that. Expected
  from Safari's behaviour; not checked on a device.

While the page is zoomed in, dragging down on the live screen pans the page; the live screen's
pull-to-refresh works again once you zoom back out.

## Mobile apps (Android & iOS)

Beyond the PWA, there are companion **native apps** in a separate repo,
[nightlight-mobile](https://github.com/sauso/nightlight-mobile). They're thin native
shells around this same web UI — the app loads the interface **live from your own server**
rather than bundling it, so any server update applies to the apps automatically with no
reinstall. On first launch you just enter your server's address (like the Home Assistant
app); a "Change server" menu item switches later.

What the native apps add over the browser/PWA:

- **Reliable background listening** — keep hearing a camera with the screen off or the app
  minimised. Android uses a foreground service (with a wake/wifi lock and a battery-
  optimisation exemption); iOS uses a background audio session. Plain in-browser background
  audio is unreliable by comparison. **On iOS this requires a camera in Low latency mode** —
  Compatibility (HLS) can't do reliable background audio on iOS (iOS runs its own native
  lock-screen session for it), so Background is only offered for Low-latency cameras there; see the
  Low latency / Compatibility notes in [Remote / internet access](remote-access.md#remote--internet-access-watching-from-outside-your-home-network) and [KNOWN-ISSUES.md](../KNOWN-ISSUES.md).
- **Pause/Resume from the system controls** — Android's notification and iOS's Now Playing
  (Control Center / lock screen), plus a Stop on Android.
- **Picture-in-Picture** — float a camera in a small always-on-top window while you use
  other apps (Android; the browser has its own PiP too).
- **Battery-friendly** — minimising the app disconnects streams unless a camera is in
  Background mode, so nothing keeps pulling video in the background.
- **Push notifications** — a phone alert when a camera sees motion, even with the app closed
  (Android only for now). See below.

### Push notifications (motion alerts)

Get a **phone notification** when a camera with motion detection sees movement — even when the app is
closed. It's off by default, and the in-app **Recent alerts** list — on each child's page, or the
combined view under **Settings → Logs** (admin only) — works with or without it. There are two
ways to set it up (pick one), both configured under **Settings → Push notifications**:

**Pushover (recommended — simplest, and works on iOS).** A small notification service (the same one
Sonarr/Radarr use). No Firebase project, no Apple Developer account.

1. Install the **Pushover** app on your phone and note your **User Key** (or make a Delivery Group to
   alert several caregivers).
2. Create a Pushover application at [pushover.net/apps/build](https://pushover.net/apps/build) and copy
   its **API Token**.
3. In **Settings → Push notifications → Pushover**, paste the token + your user/group key, **Enable**,
   **Save** (it verifies with Pushover), and **Send test**. Then enable **Motion detection** on a
   camera. Alerts arrive with a **snapshot** of what triggered them.

**Firebase / FCM (Android app only).** Delivers straight to the Nightlight Android app via your own
Firebase project: drop `google-services.json` + a `firebase-service-account.json` service-account key
into your data dir (e.g. `/mnt/user/appdata/nightlight`, keep the key `chmod 600`), then enable it
under **Settings → Push notifications**. Each phone opts in under **Account → Notifications**.

Full walkthrough for both, with troubleshooting: **[docs/notifications.md](notifications.md)**.

**Getting them:**
- **Android** — download the signed APK from the
  [nightlight-mobile Releases](https://github.com/sauso/nightlight-mobile/releases) page and
  sideload it (built and signed automatically in CI on each release).
- **iOS** — no App Store build yet; it's installed by sideloading (e.g. AltStore/Sideloadly
  with a free Apple ID). See the nightlight-mobile repo for the current status and steps.

Both apps are built entirely in GitHub Actions — see the nightlight-mobile repo for how,
and its own `CHANGELOG.md` for per-release notes.
