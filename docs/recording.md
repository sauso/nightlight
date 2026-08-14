# Event recording (clips)

Nightlight can save a short video **clip** around each motion/sound detection, attached to the alert
it belongs to. It's off by default and opt-in per camera.

## How it works

For every camera that has recording on, Nightlight keeps a small rolling buffer of that camera's
stream (pulled from the stream it already transcodes — no extra load on the camera, no second RTSP
session). When a detection fires, it cuts a clip spanning a few seconds **before** the trigger through
the moments **after**, remuxes it to a browser-playable MP4, and links it to the alert. Video is
copied (no re-encode); only the clip's short audio track is re-encoded, once.

## Turning it on

1. **Per camera:** open the camera's **Motion** or **Sound** settings and turn on **“Save a clip when
   triggered.”**
2. **Clip length (global):** **Settings → General → Recording** — *pre-roll* (seconds before the
   trigger) and *post-roll* (seconds after).

Alerts that have a clip show a **play button** on their thumbnail; tapping opens the clip in a player
with a **Download** button. In the mobile app, Download saves the video into your phone's Downloads
folder.

## Where clips are stored

Clips are written to **`CLIPS_DIR`**, which defaults to **`<data dir>/clips`** — i.e. under the
`/app/data` volume you already mapped, so they persist across container recreates and never land on
the container's ephemeral layer.

Clips are larger and burstier than the database, so on Unraid you may prefer to keep them on your
**array** (big, cheap spinning disks) rather than the SSD cache your appdata usually lives on. To do
that:

1. Map a second volume to the container path **`/recordings`**, pointing at a folder on your array
   (e.g. `/mnt/user/nightlight-clips`).
2. Set the environment variable **`CLIPS_DIR=/recordings`**.

Both are exposed as optional fields in the Unraid template (**Recordings Directory** and **CLIPS_DIR**,
under *Advanced view*).

**Safety guard:** at startup Nightlight checks `CLIPS_DIR` is writable and backed by a real mounted
volume. If it resolves to an unmapped path (the container's ephemeral layer), clip recording is
**disabled** and a clear error is logged — clips are never written somewhere they'd vanish on recreate
or bloat the image. Settings → Recording shows where clips are being written.

## Retention

Clips are deleted automatically once **either** limit is passed (**Settings → General → Recording**):

- **Keep clips for (days)** — default 14.
- **Storage cap (GB)** — default 5. Oldest clips are deleted first until back under the cap.

Set either to **0** to turn that limit off. A retention pass runs every 15 minutes (and immediately
when you tighten a limit). Deleting a clip removes only the video — the **alert and its snapshot
stay**. There is also a minimum-free-space guard: if the volume is nearly full, new clips are skipped
so recording can never be what fills the disk.
