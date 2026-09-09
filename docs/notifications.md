# Push notifications (motion alerts)

Nightlight can send a **push notification to your phone** when a camera with motion detection sees
movement — so you're alerted even when the app is closed. This is **optional** and **off by
default**. Everything else (including the in-app **Settings → Recent alerts** list) works without it.

There are **several providers** — set up one or more; an alert is sent to **every** provider you
enable, all managed under **Settings → Push notifications** (a row per provider):

- **Pushover (simplest, works on iOS)** — a small paid third-party app. No Firebase project, no Apple
  Developer account. See **[Option A: Pushover](#option-a-pushover)**.
- **Firebase / FCM (Android app only)** — delivers straight to the Nightlight Android app using your
  own Firebase project. See **[Option B: Firebase](#option-b-firebase)**.
- **ntfy (self-hostable, free, works on iOS/Android)** — a simple pub/sub notification server
  ([ntfy.sh](https://ntfy.sh) or your own). Snapshots included. See **[Option C: ntfy](#option-c-ntfy)**.
- **Gotify (self-hosted)** — a lightweight self-hosted push server. Text alerts. See
  **[Option D: Gotify](#option-d-gotify)**.

---

## Option A: Pushover

[Pushover](https://pushover.net) delivers notifications to its own app on **iOS, Android, and
desktop** (a one-time ~US$5 per platform, with a 30-day free trial). Your server just makes one HTTPS
call to Pushover — nothing to bake into an app.

1. On your phone, install the **Pushover** app and sign in. Note your **User Key** (on the main
   screen). For alerting several caregivers, create a **Delivery Group** instead and use its group key.
2. At [pushover.net/apps/build](https://pushover.net/apps/build), create an application (name it
   "Nightlight"). Copy its **API Token/Key**.
3. In Nightlight, go to **Settings → Push notifications → Pushover**: paste the **application API
   token** and your **user/group key**, tick **Enable Pushover notifications**, and **Save** (it
   verifies the tokens with Pushover). Use **Send test** to confirm it reaches your phone.
   **Device** (optional, default blank) narrows alerts to one Pushover device — its name as shown in
   the Pushover app, or several separated by commas. ⚠️ Unlike the token and key beside it, **leaving
   Device blank does not keep the saved value — it clears it**, which is how you go back to alerting
   all of your devices. (Blank means "keep" only for the secrets, because the server never sends those
   back for you to see.)
4. Enable **Motion detection** on a camera (**Cameras → edit**, or on Add). Motion alerts arrive in
   the Pushover app with a **snapshot** of what triggered them, and tapping one deep-links back into
   the Nightlight app.

> **Privacy note.** Only a short *"motion on \<camera\>"* message plus a small snapshot image pass
> through Pushover — **never your live video or audio**, which stay on your own server.

---

## Option B: Firebase

Because Nightlight is **self-hosted**, this route goes through **your own Firebase project**, not a
shared Nightlight cloud. The app you install is generic — it reads its Firebase config from *your*
server at runtime. Setting it up is a one-time job.

> **Privacy note.** Push delivery requires a cloud relay (Google's Firebase Cloud Messaging on
> Android — there's no way for an app to be woken while closed without the OS's push service). Only a
> small *"motion detected on \<camera\>"* message passes through it — **never your video or audio**,
> which stay entirely on your own server.
>
> **Android only** for now (iOS needs Apple's APNs, which is on the roadmap).

## What you'll set up

Two files from a Firebase project you create, dropped into Nightlight's data directory:

| File | What it's for | Where it comes from |
|---|---|---|
| `firebase-service-account.json` | Lets the **server send** notifications | Firebase → Project settings → Service accounts |
| `google-services.json` | Lets the **app connect** to your project | Firebase → the Android app you add |

Both are read from the data directory (the same volume as your database, e.g.
`/mnt/user/appdata/nightlight` — mounted at `/app/data` in the container). Paths can be overridden
with the `FIREBASE_CREDENTIALS` and `FIREBASE_CLIENT_CONFIG` environment variables.

## Step by step

### 1. Create a Firebase project
- Go to **console.firebase.google.com** → **Add project**. Name it anything (e.g. "Nightlight").
- Google Analytics is not needed — you can turn it off.

### 2. Add an Android app to the project
- In the project, **Add app** → **Android**.
- **Android package name** must be exactly **`com.sauso.nightlight`**.
- SHA-1 is **not** required for notifications — skip it.
- **Register app**, then **download `google-services.json`**.

### 3. Get the server credential
- Firebase → **Project settings** (gear icon) → **Service accounts** tab → **Generate new private
  key**. This downloads a JSON file — this one is a **secret**, keep it safe.

### 4. Put both files on your server
Copy them into your Nightlight data directory, named exactly:

```
<data dir>/firebase-service-account.json   # the service-account key from step 3
<data dir>/google-services.json            # the file from step 2
```

Then **restart the container** so the server picks up the credential:

```bash
docker restart nightlight
```

On restart the logs should show `[push] Firebase initialized (project <your-project-id>)`. If you
see `no Firebase credentials … push notifications disabled`, the service-account file isn't where the
server expects it.

### 5. Enable push on the server (admin, one-time)
- In the web app, go to **Settings → Notifications (push)** and turn on **"Enable push
  notifications."**
- Saving **validates both files above are present and valid** — if one is missing it tells you
  exactly which, and nothing is enabled. This is a deliberate server-level switch: motion detection
  and the in-app **Recent alerts** list work regardless; only phone notifications wait on this.

### 6. Turn it on for your device (each phone)
- Install/update the **Nightlight Android app** (the standard release APK — no per-user build needed).
- Open it, sign in, then go to **Account → Notifications** and enable **"Send motion alerts to this
  device."** Allow the notification permission when asked. (Each device opts in separately.)
- If that section says *"Notifications aren't set up on this server,"* your `google-services.json`
  isn't being read — re-check step 4. If it says *"set up but not enabled,"* do step 5.

### 7. Enable motion detection on a camera
- **Cameras → edit** a camera → **Motion detection** → **Enable**. Tune sensitivity/cooldown to taste.
- Move in front of that camera — you should get a notification, and it also appears under
  **Settings → Recent alerts**.

## Option C: ntfy

[ntfy](https://ntfy.sh) is a simple pub/sub notification service. You publish to a **topic** and
subscribe to it in the ntfy app (iOS/Android) or a browser. Use the free hosted **ntfy.sh** or run
your own server (e.g. on the same NAS).

1. Pick a **topic** name. On the public ntfy.sh, **anyone who knows the topic can read your alerts**,
   so choose a long, hard-to-guess name (e.g. `nightlight-alerts-3f9a2c`). On your own server you can
   also require auth.
2. Subscribe to that topic in the **ntfy** app (or `https://ntfy.sh/<topic>` in a browser).
3. In Nightlight: **Settings → Push notifications → ntfy**. Set the **Server URL** (`https://ntfy.sh`
   or your own), the **Topic**, and — if your server requires it — an **access token** *or*
   **username/password**. Tick **Enable**, **Save**, and **Send test**.

Motion/sound alerts arrive with the **snapshot attached inline**, and tapping one deep-links into the
Nightlight app. Only the short message + snapshot pass through ntfy — never your live video/audio.

## Option D: Gotify

[Gotify](https://gotify.net) is a lightweight **self-hosted** push server with its own Android app.

1. Run a Gotify server and open its web UI. Under **Apps**, create an **application** (name it
   "Nightlight") and copy its **application token**.
2. Install the **Gotify** Android app and point it at your server (or use the web UI).
3. In Nightlight: **Settings → Push notifications → Gotify**. Set the **Server URL**, paste the
   **application token**, optionally adjust **Priority** (0–10, default **5**), tick **Enable**,
   **Save**, and **Send test**. Higher priorities show more prominently in the Gotify app and can
   bypass its quiet settings; **0 still delivers**, just quietly — it is a valid choice here, not
   "unset". Out-of-range values are clamped to 0–10 by the server.

Gotify alerts are **text only** (no image — Gotify has no native attachments); tapping one opens the
camera. Only the short message passes through your Gotify server.

## Detection settings on a camera

**Cameras → edit** a camera. Motion and sound are independent detectors — either can be enabled
without the other, and each has its own sensitivity, confirmation delay and cooldown.

| Setting | Default | Range | What it does |
|---|---|---|---|
| **Motion sensitivity** | 50 | 1–100 | How much of the detection zone must change between frames. Higher = more sensitive. |
| **Motion confirm** | 3 s | 0–30 s | Motion must persist this long before alerting. 0 alerts on the first frame. |
| **Motion cooldown** | 60 s | 1–3600 s | Minimum gap between motion alerts from this camera. |
| **Sound sensitivity** | 50 | 1–100 | How far above the room's own ambient level a noise must rise. Higher = smaller margin = easier to trigger: roughly **+18 dB at 1, +11 dB at 50, +4 dB at 100**. |
| **Sound confirm** | 4 s | 0–30 s | Loudness must stay above that margin, *on average*, for this long — so a pulsing cry still counts while a single bang does not. |
| **Sound cooldown** | 120 s | 1–3600 s | Minimum gap between sound alerts from this camera. |

### Alert image URL (optional)

If your camera exposes an HTTP snapshot endpoint, put it here and alert images are grabbed from it
instead of from a stream frame — faster and clearer. It applies to **both motion and sound** alerts.
Leave it blank to use a stream frame.

| Setting | Default | What it does |
|---|---|---|
| **Alert image URL** | blank | e.g. `http://192.168.1.50/snapshot.jpg`. If the endpoint needs a username, include it: `http://admin@192.168.1.50/snapshot.jpg`. |
| **Alert image password** | blank | Only if the endpoint needs one. Blank means *keep whatever is already saved*. |

**The password is stored but never shown again.** Like the camera's RTSP and two-way-audio passwords,
it is never sent back to the browser — the field stays blank and the label says *(saved)* when one is
stored. Type a new one to replace it; leave it blank to keep it.

⚠️ **Changing the address to a different host drops the saved password.** If you edit the URL so it
points at a different scheme, host, port, username or path, the stored password is *not* carried over
and you will need to enter it again. That is deliberate: it stops one camera's credential being sent
to a machine you just typed the name of.

### Alert schedule (quiet hours)

**Cameras → edit a camera → Alert schedule.** Off by default, which means the camera alerts 24/7.
Turn on **Only alert during set hours** and set a **From** and **To** time.

| Setting | Default | What it does |
|---|---|---|
| **Only alert during set hours** | Off (alerting 24/7) | Restricts alerts to the window below. |
| **From / To** | 20:00 – 07:00 offered on a camera that has never had a schedule | The window during which alerts are allowed. |

- **Overnight windows work.** From 20:00 to 07:00 is one window that crosses midnight, not an empty one.
- **The window is shared by motion and sound** — there is not one schedule each.
- **Times are in the app timezone** (**Settings → General**), not the browser's or the camera's. On a
  fresh install that timezone is **UTC** until you set it, so set it before relying on a schedule.
- ⚠️ **It suppresses alerts, not detection.** Outside the window there is no push *and* no in-app
  alert, but the camera is still watched: **sleep tracking keeps recording normally**, so a night is
  unaffected by the schedule. This is the opposite of turning motion or sound detection off, which
  does stop the signal sleep tracking uses.
- A window whose From and To are the same time is treated as **always on**, not "never".

Sound is measured **relative to each room's own ambient level**, which the app learns continuously —
not as an absolute loudness. A room next to a busy road and a silent room both settle at "0 over
ambient", so the same sensitivity means the same thing in both.

### ⚠️ Sound sensitivity also changes sleep tracking

This is the one that surprises people, because motion sensitivity does **not** work this way — it only
affects alerts. Sound sensitivity affects **both**. The same margin that decides when to notify you
also decides when a *steady* background noise gets absorbed into the room's ambient level, and sleep
tracking counts a minute as "awake" partly from sound.

**How long a steady noise takes to be learned.** A source that starts up mid-night — a white-noise
machine switched on at bedtime, a fan, an air purifier, a heater — is folded into the room's ambient
level, after which it stops both alerting and counting toward "awake". How long that takes depends on
how loud it is relative to the margin:

| The source sits… | Absorbed after | Why |
| --- | --- | --- |
| **above** the full margin | 45 seconds | It is alerting, so it is dealt with quickly. |
| **between half and all** of the margin | 5 minutes | Deliberately slower: this band is also where a moderate cry sits, and a cry must not be able to quietly raise its own baseline and silence itself. |
| **below** half the margin | continuously | Ordinary tracking, roughly a 20-second time constant. |

**The trade this makes.** A moderate cry — loud enough to sit in that middle band, not loud enough to
alert — that runs for more than five minutes is treated as ambient too, so its recorded loudness fades
toward zero. That is a real loss of signal and it is a deliberate choice: the alternative, which
shipped until the fix noted below, was a room whose ambient level could get stuck permanently.

> **The middle row of that table used to be a one-way trap** (fixed 2026-09-02 — see the CHANGELOG
> entry *"A white-noise machine could make a whole night read as awake"*). A noise landing in that band
> was neither absorbed nor tracked, and the ambient level froze *for as long as the source ran*.
> Measured on a real install (2026-08-31), a white-noise machine roughly 9 dB over ambient at sound
> sensitivity 49 held one camera's ambient at exactly `-63.5 dB` for **7.9 unbroken hours**, marked
> **66% of the night's minutes as active with no motion at all**, and produced a seven-hour "awake"
> span that never happened. It re-armed every night. Sleep and wake *times* were unaffected — only the
> awake/asleep totals. The old workaround (raising sound sensitivity to 90+) is no longer needed; if
> you applied it, you can put that camera back to whatever suits its alerting.

**How to tell what your ambient level is doing.** The container log prints a level line every 15
seconds per camera:

```
[sound] "Nursery" ambient=-63.5dB peak=-55.2dB maxAvgOver=+7.8 (fires at +11)
```

A healthy `ambient=` drifts by a few tenths of a dB continuously, and settles onto a steady source
within the times in the table above. If it sits at *exactly* the same value for hours while
`maxAvgOver` stays between half and all of the "fires at" figure, you are running a version from
before that fix.

**Still true regardless of version:** sleep tracking scores each minute on that minute's *loudest*
window, so a room with a lot of variation — a white-noise machine close to the microphone is the usual
cause — reads as noisier than its average suggests, and can still overstate awake time even with a
perfectly tracking ambient level. Moving the camera further from the noise source is the reliable
remedy.

## Troubleshooting

- **"Send test" says it timed out after 10s.** Nightlight gives any notification provider **10
  seconds** to accept a message before giving up, and reports it rather than waiting. The usual cause
  is a self-hosted **ntfy** or **Gotify** server that is half up — accepting the connection but never
  answering — so check the server is actually serving, and that the Server URL includes the right
  scheme and port. This applies to real alerts too: an alert that can't be delivered in ten seconds is
  dropped with a line in the log, not queued. Nightlight is a doorbell, not a mail server — a motion
  alert that arrives minutes late is worse than none. *(Before this limit existed, a half-up server
  left the Test button spinning for five minutes with no feedback.)*
- **Server log says Firebase initialized, but no notification arrives.** Make sure the phone opted in
  (Account → Notifications) and granted the OS notification permission, that the camera has motion
  detection on, and that the app has been opened at least once since enabling (so it registered its
  device token).
- **"Notifications aren't set up on this server."** The app can reach the server but
  `google-services.json` isn't present/valid in the data dir. It must be the file from *your* Firebase
  Android app (package `com.sauso.nightlight`).
- **Dead devices.** If you uninstall the app or clear its data, its token goes stale; the server
  prunes tokens that Firebase reports as unregistered automatically.
