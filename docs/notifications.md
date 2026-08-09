# Push notifications (motion alerts)

Nightlight can send a **push notification to your phone** when a camera with motion detection sees
movement — so you're alerted even when the app is closed. This is **optional** and **off by
default**. Everything else (including the in-app **Settings → Recent alerts** list) works without it.

There are **two ways** to do this — pick one:

- **Pushover (recommended, simplest, works on iOS)** — a small third-party notification service that
  Sonarr/Radarr-style self-hosted apps use. No Firebase project, no Apple Developer account. See
  **[Option A: Pushover](#option-a-pushover)** below.
- **Firebase / FCM (Android app only)** — delivers straight to the Nightlight Android app using your
  own Firebase project. See **[Option B: Firebase](#option-b-firebase)**.

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

## Troubleshooting

- **Server log says Firebase initialized, but no notification arrives.** Make sure the phone opted in
  (Account → Notifications) and granted the OS notification permission, that the camera has motion
  detection on, and that the app has been opened at least once since enabling (so it registered its
  device token).
- **"Notifications aren't set up on this server."** The app can reach the server but
  `google-services.json` isn't present/valid in the data dir. It must be the file from *your* Firebase
  Android app (package `com.sauso.nightlight`).
- **Dead devices.** If you uninstall the app or clear its data, its token goes stale; the server
  prunes tokens that Firebase reports as unregistered automatically.
