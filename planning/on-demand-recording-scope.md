# On-Demand Recording (manual capture + pre-record buffer) — Scope

Add a **manual "Record" button** so a caregiver can capture a clip on demand — crucially, with a
**pre-record buffer** so you can hit Record *after* the cute/important moment already happened and
still get the seconds leading up to it (retroactive / "instant replay" capture). The buffer length is
an admin setting; an optional auto-stop timer caps runaway recordings.

> Status: PLAN ONLY. Reconciles against the shipped recording pipeline (0.17.0). Nothing built yet.

---

## The key realization: the pre-roll buffer already exists

Event-recording (see `recording-and-sleep-tracking-scope.md`, shipped) chose **Option A**: one
continuous **segmenter FFmpeg per detection-enabled camera**, pulling from the *local MediaMTX path*
(`rtsp://127.0.0.1:8554/<path>`, no second RTSP session on the camera), mapping **video + the AAC
track only** (`-map 0:v -map 0:a:1`), writing short (~2s) segments into a **rolling ring** sized to
`pre + post + margin`. A detection trigger just concatenates the segments spanning `[t−pre, t+post]`.

**On-demand recording is the same extraction with a different trigger and a running end:** the button
press is `t`; pre-roll comes from the ring exactly as it does for motion clips; the end is when the
user hits Stop (or an auto-stop timer fires) rather than a fixed post-roll. So the heavy machinery —
the segmenter, the clean video+AAC segments, the concat/remux/thumbnail job, the clip store, the
player, the retention sweeper — **already exists and is reused**.

The one genuinely new capability: today the segmenter only runs when a camera has `detect_record_clips`
on. On-demand needs the ring running on cameras the user wants to capture from **even if motion
detection is off**. That's the "pre-record buffer" toggle below.

---

## Design

### 1. One segmenter per camera, driven by *either* need

Unify segmenter lifecycle: a camera runs its segmenter ring if **`detect_record_clips` OR
`ondemand_buffer` is enabled** (today it's the former only). No second process — if a detection camera
already buffers, on-demand reuses that exact ring for free. The ring depth becomes
`max(clip_pre_roll_s, ondemand_pre_roll_s) + clip_post_roll_s + margin`, so whichever pre-roll is
deepest is always available.

- **`ondemand_buffer` (per-camera, default off)** — "Keep a live buffer so on-demand recording can
  capture the moment *before* you press record." Turning it on starts the segmenter for that camera.
- **Cost note (must surface in UI):** buffering is a continuous `-c copy` FFmpeg + rolling disk writes
  for that camera even when nothing is being recorded. Cheap, but not free — especially on the
  RAM/CPU-starved Thingino cams. Opt-in per camera keeps the cost predictable. If `ondemand_buffer` is
  off, the Record button still works but with **no pre-roll** (capture starts at the press).

### 2. Manual record flow

- **Start:** `POST /api/cameras/:id/record/start` → server records `startAt = now − ondemand_pre_roll_s`
  (clamped to what the ring actually holds — if the segmenter only just started, capture what's
  available, no error), marks an in-progress manual recording keyed by the camera, and lets the
  segmenter keep accumulating forward segments.
- **Stop:** `POST /api/cameras/:id/record/stop` → concat segments spanning `[startAt, now]` → remux to
  a clean browser-safe MP4 (video + AAC, drop any G711) + thumbnail → write the clip, flip status to
  `ready`. Same job path as detection clips (reuse the in-process queue).
- **Auto-stop timer:** `ondemand_max_duration_s` (default 120s, bounds e.g. 5–600s) fires an automatic
  stop so a forgotten recording can't grow unbounded or fill the disk. The tile shows the elapsed time
  and counts toward the cap.
- **Idempotence / edges:** a second Start on an already-recording camera is a no-op (returns the
  in-progress state); Stop with nothing running is a no-op; camera offline → the segmenter isn't
  publishing, so Start is rejected with a 4xx (button disabled in UI); disk-full → reuse the existing
  min-free-space guard and refuse to start.

### 3. Where manual clips live (schema)

Reuse the existing **`detection_events` + `clip_*` columns** rather than a parallel table — one clip
history, one player, one retention sweeper. A manual recording writes a `detection_events` row with:

```
type          'manual'          -- new event type alongside motion/sound
detail        'On-demand recording'  (or user note, later)
triggered_by  <userId>          -- NEW column: who pressed record (NULL for detections)
clip_status   pending → ready
clip_pinned   0/1               -- NEW column: exclude from retention pruning (see §4)
```

The thumbnail = a mid-clip frame grab (or first frame). It surfaces in the child's alert/activity feed
and plays through the existing **`ClipPlayerModal`** with download — no new player.

### 4. Retention + "keep this one" (memories)

Manual clips are often the *keepers* (first laugh, standing up) — losing them to the 14-day / 5 GB
sweeper would be bad. Add a **pin/keep** flag (`clip_pinned`): pinned clips are **skipped by the
retention sweeper** and counted separately in the storage display. The clip player gets a **★ Keep**
toggle. Optionally auto-pin every manual clip by default (setting: `ondemand_autopin`, default on) so
a deliberate capture is never silently swept; unpinning is one tap. Detection clips stay unpinned and
swept as today.

### 5. Settings surface (extends the existing "Recording" section)

- `ondemand_pre_roll_s` — **the pre-record buffer** (default 10s; bounds 0–30s). This is the headline
  knob the feature is about: how far back Record reaches. Drives ring depth on buffered cameras.
- `ondemand_max_duration_s` — auto-stop timer (default 120s; bounds 5–600s).
- `ondemand_autopin` — keep manual clips out of auto-pruning (default on).
- **Per camera** (Cameras / detection screen): `ondemand_buffer` toggle — "Keep a live buffer for
  on-demand recording (captures before you press)", with the cost note. Off = record-from-press-only.
- Storage display (used GB / count) already exists; add pinned GB as a separate line.

### 6. UI

- **Record button on the camera tile** (and the expanded/fullscreen view). Idle = ● Record; recording
  = a pulsing red dot + running `MM:SS` elapsed + ⏹ Stop. On stop → toast "Saved" with a tap-through to
  the clip in the player.
- If `ondemand_buffer` is on, a small "buffering" hint so the user knows pre-roll is available; if off,
  the button still records but from the press (tooltip explains).
- All in-app (no browser dialogs), matching the app's Modal/tile conventions.

---

## Phasing

1. **Segmenter lifecycle** — start the ring on `detect_record_clips OR ondemand_buffer`; ring depth
   uses the deeper pre-roll. (Backend only; verify a buffered, non-detection camera keeps segments.)
2. **Start/stop endpoints + job** — manual recording state, concat `[startAt, now]`, reuse remux/
   thumbnail/queue; write a `type='manual'` event row. Auto-stop timer. Verified via API/logs.
3. **Schema** — `triggered_by`, `clip_pinned` columns (idempotent migrations); retention sweeper skips
   pinned.
4. **Settings** — `ondemand_pre_roll_s`, `ondemand_max_duration_s`, `ondemand_autopin`, per-camera
   `ondemand_buffer`, with server-side bounds.
5. **UI** — tile Record/Stop button + elapsed timer + toast; ★ Keep toggle in the player; storage
   display update.
6. **Polish** — offline/disk-full guards, ring-not-yet-full pre-roll, concurrent Start/Stop, failed-job
   handling.

## Open questions / decisions to lock

- **Default for `ondemand_buffer`:** per-camera opt-in (recommended, predictable cost) vs a global
  default-on. Given the starved Thingino cams, lean opt-in.
- **Auto-pin default** on vs off (recommend on — a manual capture is deliberate).
- **Note/label on a manual clip** (let the user name it — "Raffa rolled over") — nice, small; v1 or v2?
- **Post-roll padding:** add a small fixed tail (e.g. 2s) after Stop so the ending isn't clipped abruptly?
- Whether to allow on-demand on a camera with *no* audio track (video-only clip — reuse detection-clip
  graceful degradation).

## Reused as-is (no new work)

Segmenter ring + concat/remux/thumbnail, `CLIPS_DIR` storage + free-space guard, the in-process clip
job queue, `GET /api/cameras/alerts/:id/clip` (range-enabled, `requireAuthQueryOrHeader`),
`ClipPlayerModal`, the retention sweeper (extended to honor `clip_pinned`), the child activity/alert
feed that lists `detection_events`.
