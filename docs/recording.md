# Recording

Nightlight records video in three different ways. They share one capture mechanism but exist for
different reasons, and — importantly — they have **different retention rules**, so it's worth knowing
which is which.

| | What triggers it | Notifies you | Kept for | Where it appears |
|---|---|---|---|---|
| **Automatic clips** | A motion/sound **alert** | Yes — it's an alert | 14 days / 5 GB (both configurable) | On the alert, in the Alerts feed |
| **Wake clips** | Your child **waking up** | **No — silent by design** | 14 days (configurable) | On the wake-up, in the night's sleep detail |
| **On-demand recordings** | You pressing **Record** | No | **Forever, until you delete them** | The **Recordings** card on the child's page |
| **Bed-transition frames** | Your child getting **into or out of bed** | No | 45 days — **or forever once you judge one** | The morning review on the child's page |

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

## Bed-transition frames (diagnostic, not shown anywhere)

Whenever sleep tracking decides your child has got **into** or **out of** bed, a single still frame is
saved alongside that decision. These are not clips, are never shown in the app, and never notify you.
They exist so that a sleep timeline which looks wrong can be *looked at* rather than guessed about.

- **One JPEG per transition**, roughly 20–40 a night across two cameras — in the region of 5 MB a
  night, and about **220 MB** once the 45-day retention is full.
- **Kept for 45 days**, matching the transitions themselves, and deleted with them — *unless you have
  marked that event right or wrong in the morning review, in which case the event and its frame are
  kept indefinitely.* A frame somebody has looked at and labelled is the scarce thing here; deleting
  one on a timer would throw away the only record of what the camera actually saw. Unjudged frames
  still age out, so the folder stays bounded in normal use.
- **Stored in `transition-snapshots/` in your data directory**, named by the transition's id. Deleting
  the folder is safe — the app recreates it and simply has no pictures for older transitions.

**Why they are worth the disk.** The detector infers a transition from motion in two zones, and it gets
it wrong often enough to matter: measured across 238 stored transitions, **147 of them (62%) were
physically impossible on sequence alone** — two “got into bed” in a row, or two “got out of bed”, with
nothing in between. At least one of every such pair must be wrong. Knowing *that* needed only the
timestamps; understanding *why* needs the picture.

This is also the only honest way to judge whether an automatic bed-occupancy check would be worth
adding later. The question that decides it is not “how accurate is it on ordinary frames” but “is it
right on the frames the detector got wrong” — and those frames now collect themselves.

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

**When the buffering starts.** As soon as a camera is added, and again whenever Nightlight restarts —
you don't have to turn anything else on. Note what this costs, since it applies to *every* camera while
this setting is on: one extra FFmpeg process per camera, reading the stream Nightlight already pulls
(no second connection to the camera itself), writing a rolling few-minutes buffer under
`clips/.ring/`. Old segments are continuously discarded, so it doesn't grow. Turning **Show a Record
button on each camera** off stops the buffering on every camera that isn't also saving detection clips.

**No Record button on a camera?** The button hides itself when that camera isn't buffering, because
reaching backward is the whole point and there'd be nothing to reach into. Check that on-demand
recording is on above, that the camera isn't disabled, and that clip storage came up — a start-up
problem with the clips folder is reported in the container log as `[clips] storage`. *(Older versions
only started buffering a camera that also had **detection** clips switched on — which is off by
default — so on a fresh install the button never appeared at all. If you are on one of those, turning
detection clips on for that camera, or re-saving the camera, brings it back.)*

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
