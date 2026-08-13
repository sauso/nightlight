# Event Recording + Sleep Tracking — Implementation Plan

Two meaty features, built in two stages: **Stage 1 — event-triggered recording & playback**, then
**Stage 2 — sleep tracking / "night before" summary**. This plan reconciles the two handover/scoping
docs with how the app *actually* works today, recommends an architecture, and phases the work.

> Status: PLAN ONLY. Nothing built yet. Reconciles `nightlight-event-recording-handover.md` and
> `nightlight-sleep-tracking-scoping.md` against the current codebase.

---

## Current-state reconciliation (important — the handovers predate the current code)

The handover docs assume a blank slate. Several things already exist and should be reused, and a
couple of their assumptions are wrong for this codebase:

| Handover assumption | Reality in the codebase |
|---|---|
| New `events` table with `INTEGER camera_id` | Cameras use **TEXT/uuid** ids. There is already a **`detection_events`** table + `lib/detectionEvents.js` powering the Alerts tab, with per-event JPEG snapshots stored on disk (`DATA_DIR/detection-snapshots/<id>.jpg`). |
| "Detection needs to emit a server-side event" | **Already done.** `motionDetector.js` (frame-diff), `soundDetector.js` (audio RMS), and MQTT-source motion all funnel into **`fireDetectionAlert(camera, type, detail)`** in `lib/detectionAlert.js`, which writes a `detection_events` row + snapshot + fans out to push providers. This is the single hook a clip job hangs off. |
| "Analyze the stream directly / roll your own buffer" | Each camera already has **one FFmpeg → MediaMTX** (`lib/transcoder.js`), and **MediaMTX 1.x** is bundled — which has **native recording + a playback server**. We should lean on these rather than add a second encode pipeline. |
| Clips at `/clips/{camera_id}/...` | Storage should live under the configured **`DATA_DIR`** (Unraid appdata volume), path derived, not hardcoded at `/clips`. |
| Sleep tracking reads a `sensor_readings` table | **That table does not exist.** MQTT temp/humidity is **live-only** (`getReading(topic)` in `mqttClient.js`) — nothing is persisted over time. Historical sensor storage is a **prerequisite** for Stage 2 and must be built (it's the "sensor analytics" the doc assumes is already in flight but isn't). |

**Design consequence:** extend the existing `detection_events` row with clip fields instead of
creating a parallel `events` table. The Alerts tab already renders `detection_events` with snapshot
thumbnails — attaching a clip to the same row is the natural fit and avoids two overlapping histories.

---

## Navigation restructure (child-centred) — DECIDED, building first

Sleep analytics are per-child, so the nav is reorganised around children (mocked + approved). This
lands **before** recording because it reshapes where alerts/analytics live and improves the app now.

- **Four bottom tabs: Live · Children · Cameras · Settings.** The old **Alerts** and **Family** tabs
  are removed.
- **Children — own tab.** A list of children → a **Child detail** page that is the hub: the child's
  cameras, their alerts (detection_events filtered by the camera's `child_id`), and (later) their
  sleep summary. Tapping the child's **avatar** opens **Child settings** (name, birthday, colour,
  **photo upload**); tapping the row opens the detail.
- **Cameras — own tab** (was "Family"), pure camera management with richer rows: a small live
  thumbnail (green pulse when online / greyed when off), name + **Online/Offline** pill, an assigned
  **child chip**, and capability badges.
- **Caregivers → Settings** (admin-gated), retiring the Family hub.
- **Live** gains a compact **Recent activity** list so nothing's lost with the Alerts tab gone.
- **Child photo:** `children.photo` TEXT column holding a browser-resized (canvas → ~256px square)
  base64 data-URL; `Avatar` already renders `src`. Same seam later reusable for caregivers.
- The **sleep summary card** slot ships now as a styled "coming soon" placeholder on Child detail;
  real data arrives with Stage 2. Design approved via the interactive mockup.

---

## Stage 1 — Event-triggered recording & playback

### 1.1 Architecture decision: how to capture the clip

The clip is **5s pre-roll + 15s post-roll** (fixed v1 spec per the handover — don't change without
checking in). Pre-roll means we must *always* be buffering a detection-enabled camera, then reach
backward in time when a trigger fires. Three ways to do that:

- **Option A — dedicated FFmpeg segment ring per camera.** A second FFmpeg per detection-enabled
  camera pulls from the *local MediaMTX path* (not the camera again — avoids a second RTSP session on
  cheap cams), maps video + the AAC audio track, and writes short segments (e.g. 2s) into a scratch
  ring. On trigger: concat the pre-roll segments + keep recording 15s forward into one MP4. *Pros:*
  clips are born clean (video + AAC only, no G711). *Cons:* a whole second fleet of FFmpeg processes
  to supervise/restart, continuous second write, and we own the stitching logic.

- **Option B — MediaMTX native recording + playback extraction (RECOMMENDED).** Turn on MediaMTX
  `record` for detection-enabled paths (fMP4 segments, copy — **no re-encode**, cheap), with a short
  `recordDeleteAfter` (e.g. 2–5 min) so raw segments are a small rolling buffer. On trigger, ask
  MediaMTX's **playback server** for the `[t − 5s, t + 15s]` window as MP4, then run **one** short
  FFmpeg to remux to a clean, browser-safe MP4 (map video + AAC, drop the G711 copy track) and grab a
  thumbnail. *Pros:* reuses bundled MediaMTX; buffering is a cheap segment copy MediaMTX already knows
  how to do; FFmpeg only runs *per event*, not continuously. *Cons:* need to enable MediaMTX's
  playback server; extracted window may include the G711 track, hence the remux step.

- **Option C — tee a second output onto the existing transcoder FFmpeg.** Add a segmented file sink
  to the one FFmpeg already running. Saves a process but couples recording to the live pipeline (a
  recording hiccup could disturb the live stream) — riskier for little gain. Not recommended.

**DECISION: Option A (chosen by owner).** One continuous **segmenter FFmpeg per detection-enabled
camera**, pulling from the *local MediaMTX path* (`rtsp://127.0.0.1:8554/<path>` — no second RTSP
session on the camera), mapping **video + the AAC track only** (`-map 0:v -map 0:a:1`, so clips are
born clean — no G711), writing short segments (e.g. 2s) into a rolling ring big enough to cover
`pre-roll + post-roll + margin`. The **forward** post-roll is captured by that same ongoing segmenter
— no per-event forward recorder. On trigger, a per-event job **concatenates the segments spanning
`[t − pre, t + post]`** into one MP4 (over-capture whole segments, optionally trim to exact bounds) and
grabs a thumbnail. So: one long-lived cheap `-c copy` segmenter per recording camera + one short
concat/trim FFmpeg per event.

**Clip lengths are admin-configurable** (see §1.6): `clip_pre_roll_s` (default 5) and
`clip_post_roll_s` (default 15). Pre-roll drives the ring depth — the segmenter keeps
`ceil((pre + post + margin) / segment_len)` segments so the deepest configured pre-roll is always
available.

> Verify during a Phase-1 spike: the segmenter ring + concat yields a clip that plays in a plain
> `<video>` on iOS Safari + the Android WebView, and that segment-boundary rounding at the pre-roll
> edge looks acceptable (decide then whether exact-trim is worth the extra re-mux).

### 1.2 Schema — extend `detection_events`

Add clip columns (idempotent `ALTER TABLE` migrations, per db.js convention) to the existing table:

```
clip_status     TEXT      -- NULL (no clip) | 'pending' | 'ready' | 'failed'
clip_path       TEXT      -- relative path under DATA_DIR/clips, e.g. clips/<cameraId>/<eventId>.mp4
clip_duration_s INTEGER   -- actual clip length (nominally 20)
clip_bytes      INTEGER   -- for storage-cap retention accounting
```

(`thumbnail`: reuse the existing per-event JPEG snapshot as the list thumbnail — no new column
needed. If we want a mid-clip frame instead, add `clip_thumb` later.)

### 1.3 Detection → clip pipeline

- **Opt-in per camera, separate from alerts.** Add a `detect_record_clips` flag to the camera's
  detection config (the Motion/Sound settings screens). Every detection still writes an event + snapshot
  (as today); a clip is only produced when this camera has clip-recording on. Keeps storage
  predictable and lets push-only users skip disk cost.
- **Enable/disable MediaMTX record** on a path when the flag or detection toggles (hook into the
  existing `lib/mediamtx.js upsertPath` / reconciliation, so it survives restarts like everything else).
- **On trigger** (`fireDetectionAlert`, after the event row exists): enqueue a clip job keyed by
  `eventId`. A **single in-process job queue** (small concurrency cap, e.g. 2) serializes clip
  extraction so a burst of triggers can't spawn unbounded FFmpeg. Job = wait out the 15s post-roll →
  extract `[t−5s, t+15s]` → remux + thumbnail → write `clip_path`, flip `clip_status` to `ready`
  (or `failed`). Update the row; the Alerts feed shows a spinner→play affordance.
- **Concurrent triggers on one camera** (open question in the handover): v1 = **debounce/extend**.
  If a trigger lands while a clip window for that camera is still open, extend the current clip's post-roll
  rather than starting a second overlapping event+clip. Simpler and avoids near-duplicate clips. (The
  detector cooldown already suppresses most of this.)

### 1.4 Storage location & retention

**The storage location matters and is a volume-mount concern, not an in-app path field.** Today the
only persistent path is **`DATA_DIR`** (`/app/data`), which most users map to their **SSD cache**.
Video clips are large and bursty — we don't want them silently filling the SSD (or, worse, landing on
the container's ephemeral layer and vanishing on recreate while bloating the image). So:

- **Dedicated recordings directory via env var: `CLIPS_DIR`, default `${DATA_DIR}/clips`.**
  - If the user does nothing, clips go under the already-mapped `/app/data` → still **persistent**
    (never the container layer), just sharing the SSD. The retention caps below protect the SSD.
  - The Unraid template exposes a **separate volume mapping** (container `/recordings`) with
    `CLIPS_DIR=/recordings`, so a user can point clips at their **array (spinning disks, big/cheap)**
    and keep the SSD cache for the DB/app. **Documented both ways.**
  - Startup **guards** that `CLIPS_DIR` is a real, writable, mounted path and **refuses to write into
    an unmapped container path** (detectable: if it resolves under the image's own writable layer /
    isn't a mount, log a clear error and disable clip recording rather than fill the container).
- Clips at **`CLIPS_DIR/<cameraId>/<eventId>.mp4`**; reuse the existing per-event snapshot JPEG (which
  stays under `DATA_DIR`) as the list thumbnail.
- **Retention is admin-configurable in Settings** (not hardcoded). Support **both** a day cutoff and a
  storage cap, evaluated together (delete oldest clips when either bound is exceeded):
  - `clip_retention_days` (default 14)
  - `clip_retention_max_gb` (default 5) — the cap is what makes sharing the SSD safe by default.
- A periodic sweeper prunes clips past either bound, deletes the file, and clears `clip_*` on the row
  (keeps the alert row + snapshot). Show **used GB / clip count** in Settings so it's visible.
- Guardrail: a **minimum free-space check** before writing a clip, so a full disk can't wedge the app.

### 1.5 Playback — backend + Alerts UI

- **Serving endpoint**: `GET /api/cameras/alerts/:id/clip`, mirroring the existing
  `/alerts/:id/snapshot` route — mounted with **`requireAuthQueryOrHeader`** so `?token=` works (a
  `<video>` element can't attach an Authorization header, same reason HLS/snapshots use it).
  `res.sendFile` already honours **Range** requests, so seeking works out of the box.
- **Alerts tab** (already a chronological `detection_events` feed with snapshots): when `clip_status`
  is `ready`, show a **play badge** on the thumbnail; tapping opens the clip in a **Modal `<video>`
  player** (with fullscreen + download). `pending` shows a subtle "recording…" state; `failed`/none
  just shows the snapshot as today. No MediaMTX/WebRTC here — plain HTTP file playback.
- Works through the reverse proxy exactly like other HTTP endpoints (the Low-latency/Compatibility
  toggle doesn't apply to file playback).

### 1.6 Settings surface

- **Global — a new "Recording" section** (Settings), all admin-configurable:
  - `clip_pre_roll_s` (default 5) and `clip_post_roll_s` (default 15) — clip length before/after the trigger.
  - `clip_retention_days` (default 14) and `clip_retention_max_gb` (default 5).
  - Read-only: current **used GB / clip count**, and where clips are being written (`CLIPS_DIR`), so
    the admin can see whether they're on the SSD or a mapped array.
- **Storage location** is NOT an in-app text field (a typed host path can't work inside the container).
  It's the `CLIPS_DIR` env / volume mapping from §1.4, documented in `docs/`.
- **Per camera** (Motion/Sound detection screens): "Save a clip when triggered" toggle
  (`detect_record_clips`), alongside the existing sensitivity/cooldown controls. Turning it on is what
  starts that camera's segmenter; off (default) means no recording cost for that camera.
- Sane bounds enforced server-side (e.g. pre-roll 0–30s, post-roll 5–120s, cap ≥ 1 GB) so a setting
  can't produce absurd ring sizes or fill the disk instantly.

### 1.7 Phasing (Stage 1)

1. **Spike** — enable MediaMTX record + playback on one staging path; confirm arbitrary-window MP4
   extraction incl. pre-roll and clean `<video>` playback after remux. (De-risks the whole approach.)
2. **Backend capture** — path record config, job queue, extract+remux+thumbnail, schema, `clip_*` on
   the event row. Verified via the API/logs.
3. **Retention** — settings fields + sweeper + free-space guard.
4. **Playback endpoint** — authed, range-enabled clip serving.
5. **Alerts UI** — play badge + player; per-camera record toggle; global retention settings.
6. **Polish** — failed-clip handling, storage display in Settings (used GB), edge cases.

### 1.8 Risks / open questions

- MediaMTX playback-window precision at the pre-roll boundary (spike answers this).
- G711-only cameras (no AAC produced?) — confirm the remux track selection degrades gracefully
  (video-only clip if there's genuinely no usable audio).
- Storage growth on multi-camera setups — the cap + per-camera opt-in are the mitigations.
- Clip of a wedged/obstructed camera is useless but harmless; not a blocker.

---

## Stage 2 — Sleep tracking / "night before" summary (later)

Recommended path from the scoping doc: **Option A (video/audio-derived, no new hardware)**. mmWave
respiration (Option B) stays a distinct, opt-in *future* hardware tier and is explicitly out of scope
here. Vitals-style framing is deliberately avoided — this is *sleep-pattern inference*, clearly labelled
estimated/informational, never a safety/medical claim.

### 2.1 Prerequisites (must exist before Stage 2 is worth starting)

- **Historical sensor storage — NEW.** Temp/humidity is currently live-only. Need a `sensor_readings`
  table + a periodic sampler (e.g. store each camera's latest MQTT reading every N minutes, pruned like
  other history) before any temp/humidity correlation is possible. This is really its own small feature
  ("sensor analytics") the sleep doc assumed was already in flight.
- **A continuous activity signal — DESIGN CHOICE.** The `detection_events` we already store are
  **cooldown-throttled alert events** (great for notifications, coarse for sleep inference). Two options:
  - *v1-cheap:* infer sleep from the existing throttled events (gaps between events = "asleep"). Fast,
    reuses everything, lower fidelity.
  - *better:* add a lightweight **per-minute activity sampler** (motion/sound activity level bucketed
    per minute into an `activity_samples` table), independent of the alert cooldown, giving a real
    overnight timeline. More work, much better inference. **Recommend building the sampler** — it's the
    difference between a toy and a useful summary, and it also feeds nicer charts.

### 2.2 Inputs & derived metrics

- Inputs: activity timeline (motion + sound) + `sensor_readings` over the night window.
- Metrics: **sleep onset** (first sustained quiet period after bedtime), **wake time**, **wake events**
  (count + timestamps), **total awake time**, **longest uninterrupted stretch**, optional
  **temp/humidity correlation** (e.g. flag unusually warm nights against more wake-ups).

### 2.3 Inference approach

- A nightly job (or on-demand computation) over a configurable **night window** (e.g. 19:00–07:00,
  tied to the app timezone already in Settings).
- "Asleep" = ≥ *X* minutes continuous below an activity threshold; "awake" = a sustained rise. Both *X*
  and the threshold are **tunable** (see open questions) and should start conservative.
- **Sound vs motion weighting** (open question): a cry (sound) likely signals a "real" wake more than a
  shift (motion). v1 could treat a sustained sound spike as a stronger wake signal than motion alone.

### 2.4 Delivery / placement (open question)

Candidates: the **Alerts tab** (a "Last night" summary card on top), a new **Analytics** tab, or a
dedicated **Sleep** view. Leaning toward a summary **card** first (cheap, discoverable) with a drill-in
timeline later. Decide when we get there.

### 2.5 Phasing (Stage 2)

1. `sensor_readings` table + periodic sampler + a basic temp/humidity history view (the "sensor
   analytics" prerequisite — useful on its own).
2. `activity_samples` per-minute sampler.
3. Nightly sleep computation + storage of a per-night summary.
4. Sleep Summary card UI + tuning of thresholds against real nights.
5. (Later, optional) temp/humidity correlation, richer timeline chart.

---

## Cross-cutting

- **Sequencing:** Stage 1 fully first (it's self-contained and immediately useful). Stage 2 depends on
  new sensor + activity history that doesn't exist yet, so it can't meaningfully start until that
  groundwork is laid — which is partly why it's stage 2.
- **Both stages** follow the existing conventions: hand-written idempotent SQLite migrations, server-side
  work gated so only detection-enabled cameras pay the cost, Switch toggles for on/off settings, in-app
  Modal dialogs (never browser popups), 4xx (not 5xx) for user-facing errors behind the proxy, dev →
  staging → prod-on-go-ahead.
- **Decided:** capture = **Option A** (segmenter ring); **pre/post-roll + retention are
  admin-configurable** (defaults 5s/15s, 14 days/5 GB); clip recording is **opt-in per camera**;
  clips write to **`CLIPS_DIR`** (default under the mapped `/app/data`, or a separate `/recordings`
  array mount) — never the container layer.
- **Decided:** clip **player = Modal `<video>`** (matches the app's modal pattern; room for
  fullscreen / download / scrub; better on mobile than an inline row expand).

**All Stage-1 decisions are now locked — ready to start with the Phase-1 spike.**
