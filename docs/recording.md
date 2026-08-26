# Recording

Nightlight records video in three different ways. They share one capture mechanism but exist for
different reasons, and — importantly — they have **different retention rules**, so it's worth knowing
which is which.

| | What triggers it | Notifies you | Kept for | Where it appears |
|---|---|---|---|---|
| **Automatic clips** | A motion/sound **alert** | Yes — it's an alert | 14 days / 5 GB (both configurable) | On the alert, in the Alerts feed |
| **Wake clips** | Your child **waking up** | **No — silent by design** | 14 days (configurable) | On the wake-up, in the night's sleep detail |
| **On-demand recordings** | You pressing **Record** | No | **Forever, until you delete them** | The **Recordings** card on the child's page |

All three are configured under **Settings → Recording** (admin only), and all three write to the same
place on disk — see [Where recordings are stored](#where-recordings-are-stored).

---

## Automatic clips (detection-triggered)

A short clip saved around each motion/sound detection and attached to the alert it belongs to. **Off by
default, opt-in per camera.**

For every camera with recording on, Nightlight keeps a small rolling buffer of that camera's stream
(pulled from the stream it already transcodes — no extra load on the camera, no second RTSP session).
When a detection fires it cuts a clip spanning a few seconds **before** the trigger through the moments
**after**, remuxes it to a browser-playable MP4, and links it to the alert. Video is copied (no
re-encode); only the clip's short audio track is re-encoded, once.

**Turning it on**

1. **Per camera:** open the camera's **Motion** or **Sound** settings and turn on **"Save a clip when
   triggered."**
2. **Clip length (global):** **Settings → Recording → Automatic clips**.

| Setting | Default | Range | What it does |
|---|---|---|---|
| Pre-roll (seconds) | 5 | 0–30 | How much *before* the trigger is included |
| Post-roll (seconds) | 15 | 5–120 | How much *after* the trigger is included |
| Keep clips for (days) | 14 | 0–365 | 0 = no day limit |
| Storage cap (GB) | 5 | 0–2000 | 0 = no size limit; oldest deleted first |

Alerts that have a clip show a **play button** on their thumbnail; tapping opens the clip in a player
with a **Download** button. In the mobile app, Download saves the video into your phone's Downloads
folder.

---

## Wake clips (recorded, never announced)

When sleep tracking sees your child **wake up**, Nightlight saves a short clip of the moment it
started — and sends **nothing**. No push, no entry in the Alerts feed.

**Why this exists.** Most wake-ups never raise an alert. Over 18 nights of real data, 54 of 101
wake-ups produced no alert at all. That isn't a fault: an alert deliberately waits for **2–3 seconds of
sustained** noise or movement before disturbing anyone, while sleep tracking counts a minute as active
on the **first flicker**. The two are measuring different things on purpose. The result was a sleep
timeline full of wake-ups with nothing behind them to explain what happened. Wake clips fill exactly
that gap without making alerts noisier.

**What is and isn't recorded**

- Only for children with **Track sleep** on (per child, under the child's settings).
- Only **once your child is actually asleep** — settling at bedtime is never recorded.
- Only for a real wake-up: a brief **stir is ignored**, using the same threshold the sleep timeline
  uses to decide what counts as a wake-up.
- The clip starts at the **beginning** of the wake-up, not when it was confirmed — the opening is the
  part that explains why.

**Settings → Recording → Wake clips**

| Setting | Default | Range | What it does |
|---|---|---|---|
| Record wake-ups without alerting | On | — | Master switch |
| Clip length (seconds) | 30 | 5–120 | Also your main storage dial — see below |
| Keep wake clips for (days) | 14 | 0–365 | 0 = keep forever |

To watch one: open a child → tap the night's sleep summary → a wake-up with a clip shows a **clip**
chip; expand it and press play.

**A note on length.** Capture runs at roughly 172 KiB/s, so 30 seconds is about 29 MiB per child per
night. The average wake-up runs ~19 minutes, so recording wake-ups *end to end* would be ~1.1 GiB a
night — which is why the clip is deliberately bounded to its opening rather than the whole wake-up.

---

## On-demand recordings (the Record button)

Capture a moment yourself. Because every camera keeps a rolling buffer, pressing **Record** reaches
**backward** in time as well as forward — so you can catch something just *after* it happens.

**Settings → Recording → On-demand recording**

| Setting | Default | Range | What it does |
|---|---|---|---|
| Show a Record button on each camera | On | — | Switching this off also stops the per-camera buffering |
| Capture before (seconds) | 30 | 0–60 | How far back pressing Record reaches |
| Auto-stop after (seconds) | 120 | 5–600 | Stops a recording someone forgot to end |

Recordings appear in the **Recordings** card on the child's page. **They are never deleted
automatically** — unlike the other two kinds, these are keepsakes someone chose to keep, so deleting
one is the only way to reclaim its space.

---

## Where recordings are stored

Everything above is written to **`CLIPS_DIR`**, which defaults to **`<data dir>/clips`** — i.e. under
the `/app/data` volume you already mapped, so it persists across container recreates and never lands on
the container's ephemeral layer.

Video is larger and burstier than the database, so on Unraid you may prefer to keep it on your **array**
(big, cheap spinning disks) rather than the SSD cache your appdata usually lives on. To do that:

1. Map a second volume to the container path **`/recordings`**, pointing at a folder on your array
   (e.g. `/mnt/user/nightlight-clips`).
2. Set the environment variable **`CLIPS_DIR=/recordings`**.

Both are exposed as optional fields in the Unraid template (**Recordings Directory** and **CLIPS_DIR**,
under *Advanced view*).

**Safety guard:** at startup Nightlight checks `CLIPS_DIR` is writable and backed by a real mounted
volume. If it resolves to an unmapped path (the container's ephemeral layer), recording is **disabled**
and a clear error is logged — video is never written somewhere it would vanish on recreate or bloat the
image.

**Settings → Recording → Storage** shows where video is being written, how much space it's using, and
the split between alert clips, wake clips and recordings.

---

## Retention, and what deleting removes

Each kind ages out differently — this is the part most worth reading twice:

- **Automatic clips** are deleted once **either** limit is passed: older than *Keep clips for (days)*,
  or total clip size over *Storage cap (GB)* (oldest first). Set either to **0** to turn that limit off.
  A retention pass runs every 15 minutes, and immediately when you tighten a limit. Deleting a clip
  removes **only the video** — the alert and its snapshot stay.
- **Wake clips** are deleted once older than *Keep wake clips for (days)*, swept a few times a day. Set
  it to **0** to keep them forever. Deleting one removes only the video; the wake-up itself stays on the
  sleep timeline.
- **On-demand recordings are never swept.** They persist until you delete them from the child's page.

There is also a **minimum-free-space guard** across all three: if the volume is nearly full, new video
is skipped, so recording can never be the thing that fills your disk.
