# Recording

Nightlight records video in three different ways. They share one capture mechanism but exist for
different reasons, and — importantly — they have **different retention rules**, so it's worth knowing
which is which.

| | What triggers it | Notifies you | Kept for | Where it appears |
|---|---|---|---|---|
| **Automatic clips** | A motion/sound **alert** | Yes — it's an alert | 14 days / 5 GB (both configurable) | On the alert, in the Alerts feed |
| **Wake clips** | Your child **waking up** | **No — silent by design** | 14 days (configurable) | On the wake-up, in the night's sleep detail |
| **On-demand recordings** | You pressing **Record** | No | **Forever, until you delete them** | The **Recordings** card on the child's page |
| **Bed-transition frames** | Your child getting **into or out of bed** | No | 45 days — **or forever once you judge one** (either way, gone when the camera or child is removed) | The morning review on the child's page |

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

**Changing a limit can ask first.** Saving a different **Keep clips for** or **Storage cap** runs the
cleanup straight away, and the cleanup applies *both* limits, so the clips outside them are deleted as soon
as you press **Save changes**. That includes raising one limit: if the stored clips already exceed the other
limit (for example the storage cap), the cleanup deletes them at that moment. So Nightlight does not judge
by whether the number went up or down. When a limit differs from what is stored, it asks the server what the
save would delete, and when that is more than zero clips it shows a **Delete saved clips?** box with how many
alert clips will go, about how much space they use, and the date of the oldest. It saves only when you press
**Save and delete clips**; if nothing would be deleted it just saves. The values it checked are exactly the
values it saves, and the two limit fields are locked while the check or the box is open. The alerts and their
pictures stay; only the video goes. The count is as of the moment you pressed Save and the size is "about": a
new clip can arrive before you confirm. If the check itself fails you are still asked, without a number. If
clip storage is not available at that moment (the unmapped-volume warning below) nothing can be deleted yet:
the box says so, shows no count, and the limits take effect on the first cleanup after storage returns.
Each field accepts whole numbers only (digits, no `1e2`, no decimals) within the range above; anything else
is refused on the page and not sent. Only a limit you actually changed is sent, so a settings page left open
in an old tab cannot overwrite a limit changed elsewhere, or trigger a cleanup, by saving something unrelated.
The numbers come from the same queries the real cleanup uses (an
admin-only read, `GET /api/settings/clip-retention-preview`, which changes no clips or settings and returns
no file names).

| | Asks before saving? | When it is applied |
|---|---|---|
| **Keep clips for** and **Storage cap** (alert clips) | Yes, when the check says the save would delete clips | Straight away on Save, then every 15 minutes |
| **Keep wake clips for** | **No** | On the wake-clip cleanup's own schedule, not on Save |

Alerts that have a clip show a **play button** on their thumbnail; tapping opens the clip in a player
with a **Download** button. In the mobile app, Download saves the video into your phone's Downloads
folder.

**A silenced camera, or one outside its alert hours, saves no clip.** A clip belongs to an alert, and
is cut only when an alert actually fires. While a camera is **silenced** (**Silence alerts** on its
tile) or outside its **Alert schedule**, motion and sound raise no alert at all (no push and no entry
in the Alerts feed), so there is nothing to attach a clip to, even with **Save a clip when triggered**
on. The detector itself keeps watching, so sleep tracking is unaffected, but no alert clip of that
moment is kept. This is different from having no notification provider set up, or switching one off: an
alert that fires is still recorded in the feed and still gets its clip, whether or not anything is
pushed. So "stop the notifications" and "stop the alert" are different things here, and there is no
per-camera setting that mutes only the push while keeping the alert and its clip: the schedule and
the silence both stop the alert itself. See [Alert schedule](notifications.md#alert-schedule-quiet-hours)
and [Silencing a camera's alerts](camera-controls.md#silencing-a-cameras-alerts-and-who-did-what).

---

## The "Recording and alerts" panel (per camera, read-only)

**Cameras → edit** a camera → **Recording and alerts**, under Detection. It shows, in one place, what
this camera is set up to alert on and record, and whether it is **ready right now**. It is a summary
only: it has no switch, changes nothing, and adds no setting (so there is no default or range). Admin
only, like the page it sits on; a caregiver cannot open that page.

The two groups answer different questions, and the difference is the point:

| | **Set up** | **Ready right now** |
|---|---|---|
| What it is | What is switched on, read from the camera's own settings | Whether the thing behind each switch is actually running |
| Where it comes from | The camera's fields, the child assigned to it, and **Settings → Recording** | The server, asked each time (and again with **Check again**) |
| Fresh? | As of the page load | As of the last check; it is a snapshot, so press **Check again** after changing something |

| Row | Set up says | Ready right now says |
|---|---|---|
| Motion alerts | The source: Nightlight compares frames, the camera's own events (ONVIF) or (MQTT), or off | Whether that detector is running. For MQTT it says *Reported by the camera*: the camera decides and Nightlight only listens, so there is no process to check |
| Sound alerts | On or off | Whether the sound detector is running |
| Schedule and timezone | The alert hours and the **app's** timezone (Settings → General), or *Always* | *Alerts firing now*: yes, or why not (*Silenced*, *Outside the schedule*) |
| Silence | Until when, and who set it | (the same *Alerts firing now* row) |
| Alerts save a clip | The per-camera **Save a clip when triggered** | Whether the buffer is ready to cut one |
| Wake clips | Eligible only with the global option on, a child assigned, **and** sleep tracking on for that child, with every missing piece named | Whether the buffer is ready for one |
| Manual recording | The global **Show a Record button on each camera** | Whether Record would work right now |
| Recording buffer | | *Ready*, *Not running*, *Not needed*, *Storage unavailable* or *Camera disabled* |

**Why the buffer row exists.** Alert clips, the Record button and wake clips all cut their footage from
the same rolling buffer (see *A note on buffering* under Wake clips). A camera can have all three switched
on and still have no buffer, because the clips folder is not usable or the buffer has not started. The
three rows are then shown as **Waiting on the buffer**, not as off. *Not needed* is the opposite and is
not a problem: nothing is set up to record from that camera.

**What it deliberately does not do.** It does not change how alerts, clips or notifications behave. In
particular, **a silence or the schedule still stops the alert itself, and with it the alert clip**; the
panel states this beside the rows. Keeping every alert clip while muting only the notification would need
separate controls for notifying and for recording events, which was considered and **not adopted**. The panel
exists so that "stop the notifications" is not mistaken for "keep every alert clip".

It reads `GET /api/cameras/:id/recording-readiness` (admin only), which returns booleans and fixed words
only: no name, address, path or credential.

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
- Only **once your child is actually asleep** — settling at bedtime is never recorded. "Asleep" here
  means **15 quiet minutes in a row that the camera actually reported**; a minute the camera reported
  nothing for starts the count again, and so does a minute with sound but no video when the camera's video
  has stalled (such a minute is not counted as seen, as on the sleep timeline). That is stricter than the
  sleep timeline's own rule, so after an outage in the evening recording can start later than the
  timeline's bedtime (a camera that drops a minute more often than about every 15 minutes never starts).
  Once started, a gap does not stop it.
- Only for a real wake-up: a brief **stir is ignored**, using the same threshold the sleep timeline
  uses to decide what counts as a wake-up. Activity that pauses for up to **3 minutes** is still one
  wake-up, and a minute the camera reported nothing for counts as a pause, exactly as on the timeline; a
  longer gap ends the wake-up, so two qualifying stretches of activity either side of an outage are two
  wake-ups and two clips. A **video stall** whose sound keeps arriving counts as a pause too: noise heard
  while the picture is missing does not make a minute active (a bedroom microphone hears the whole house),
  exactly as on the timeline. This applies to a camera that has delivered video since the server started; a
  camera with no video at all keeps using its sound. The numbers (3 minutes, 5 active minutes, 15 quiet
  minutes) are fixed, not settings, are the sleep timeline's own, and were tuned on nights from two cameras in
  one house (not validated elsewhere). See "A wake recording does not bridge a gap in the readings" in
  [KNOWN-ISSUES.md](../KNOWN-ISSUES.md).
- The clip starts at the **beginning** of the wake-up, not when it was confirmed — the opening is the
  part that explains why. Precisely: it starts about 2 to 3 seconds before the first frame that showed movement or
  noise (the same threshold that makes a minute count as active in the live wake check, in-bed movement or
  sound; unlike the sleep timeline, out-of-bed movement does not count), or at the oldest footage the buffer
  still holds, if that is later. A continuous buffer of about 70 seconds or more reaches the first frame; with
  a shallower one the clip starts up to roughly a minute minus the buffer depth after it (about 22 seconds
  after the first frame with a 38 second buffer, about 37 with a 23 second one). If the buffer has a gap so that
  no footage at all falls in the clip's window, the clip starts where it did before, at the end of that first
  minute. The buffer's depth comes from the clip pre-roll and post-roll and the on-demand pre-roll
  settings: 23 seconds at the smallest clip settings, 38 on the defaults with on-demand recording off, 63
  with it on, and more with larger settings. The figures are derived, approximate to about 4 seconds, not measured. The clip's recorded start is its planned
  first frame (3 seconds before the first moving or noisy one; with an almost empty buffer, up to 3 seconds
  before the first footage it holds), so it can be a few seconds before the wake's minute on the timeline; the review page still
  matches it to that wake. See "Where a wake clip starts" in [KNOWN-ISSUES.md](../KNOWN-ISSUES.md).

**Clips are capture candidates, not a one-to-one copy of the timeline.** The live watcher records a clip
as it happens and cannot look back the way the nightly analysis does, so a wake on the sleep timeline can
have no clip and a clip can sit where the timeline shows no wake. The two apply the same thresholds but
not the same rules: the nightly analysis also counts movement **outside the bed** as activity (the live
watcher sees only bed motion and sound), scores **one camera** (the child's primary), and applies the
put-down and onset rules (including how it treats sound around bedtime and just after falling asleep)
that the live watcher does not have. The live watcher tracks **every camera assigned to the child**.

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

**A note on buffering.** Capturing a wake-up's *opening* means Nightlight has to already be holding a
few seconds of recent video before the wake-up is even confirmed — the same rolling buffer that powers
on-demand recording and detection clips. Turning "Record wake-ups without alerting" on (and saving) keeps that
buffer running on each of the child's assigned cameras, the same as switching on-demand recording on
would, even if both of the other two recording features are off. Turning it off immediately stops any
*new* wake-up from holding that buffer open, but the buffering itself only drops once nothing else on
the camera still needs it — including a wake-up that was already being watched at the moment you turned
it off, which is allowed to run to completion first (see *When the buffering starts* under On-demand
recordings, above, for how long that can take and when buffering actually stops). A clip that is already
being cut keeps the footage it needs until it is saved or fails, even if meanwhile the wake-up ends, the sleep
window closes, sleep tracking is switched off, the camera is unassigned from the child or the server's
clock jumps (before #471 any of these could let the buffer discard that footage mid-cut and fail the
clip).

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
- **Marking a night "No one was in the bed"** in the morning review changes nothing here. That night's
  frames age out, or are kept once judged, exactly like any other night's. The mark hides the
  detector's version of the night; it does not delete anything, so taking it back loses nothing.
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
| Show a Record button on each camera | On | — | Switching this off and saving also stops the per-camera buffering (see *When the buffering starts*, below, for exactly when). Applies on **Save changes**, like every other control on the page |
| Capture before (seconds) | 30 | 0–60 | How far back pressing Record reaches |
| Auto-stop after (seconds) | 120 | 5–600 | Stops a recording someone forgot to end |

**Every control on this page waits for Save changes — the switches included (#391).** *Show a Record
button on each camera* and *Record wake-ups without alerting* are drafts like the number fields:
flipping one changes nothing on the server, and nothing is switched off, until you press
**Save changes** and it succeeds. (Before this change the Record-button switch wrote the moment you flipped
it while the wake-up switch beside it waited, so two identical-looking switches behaved differently.)
While anything on screen differs from what is stored, a line at the top says **Unsaved changes**; put
a value back and the line goes away. If a save fails, the error is shown, the line stays, and the
stored settings — and so what is actually recording — are unchanged. **Save changes** sends the whole
page in one request, so either every change on it applies or none does.

Don't confuse this with the camera's **Motion, Sound and Alert schedule** screens, which are the
opposite on purpose: no Save button, every change applies about a second after you make it (see
[Changes save automatically](notifications.md#changes-save-automatically)).

**If you leave without saving.** The page, like the child and camera forms, keeps what you typed in
that browser tab for **6 hours** (not configurable) so a phone that returns from the background — the
app reloads itself after 15 seconds away — or a trip to another screen doesn't lose it. Coming back
shows **Unsaved changes restored** with a **Discard changes** button. Closing the tab, signing out,
pressing Save successfully or pressing **Discard changes** removes it. The draft lives on that
device only and is never sent anywhere.

Recordings appear in the **Recordings** card on the child's page. **They are never deleted
automatically** — unlike the other two kinds, these are keepsakes someone chose to keep, so deleting
one is the only way to reclaim its space. **Only an admin can delete one**; anyone signed in, caregivers
included, can record, watch and download (see [Who can delete](#who-can-delete)).

**When the buffering starts.** As soon as a camera is added, and again whenever Nightlight restarts —
you don't have to turn anything else on. Note what this costs, since it applies to *every* camera while
this setting is on: one extra FFmpeg process per camera, reading the stream Nightlight already pulls
(no second connection to the camera itself), writing a rolling buffer under `clips/.ring/`. The buffer
is sized to the deeper of the two pre-rolls plus a small margin — about **a minute** at the default
settings — and old segments are continuously discarded, so it doesn't grow.

**Changing these settings does not restart buffering or disturb a capture in progress.** A pre/post-roll
edit, or switching on-demand or wake clips on or off, resizes each camera's buffer in place rather than
stopping and restarting it — so a recording, a wake-clip capture or a detection clip that's already
under way keeps everything it needs, and a finished recording always reports the pre-roll length it
actually started with, not whatever the setting has since been changed to.
**Saving a camera** (renaming it, changing its address or the child it is assigned to) doesn't restart
its buffer either (#490; until then every camera save emptied it, and lost any recording or clip in
progress). An address change restarts the camera's stream, which can leave a short gap in the buffer
while it reconnects; what the buffer already holds is kept. Unassigning the camera from its child can make the
buffer unwanted; it then stops the same way as below, once nothing on that camera is still using it.
Turning **Show a Record button on each camera** off (and pressing **Save changes**) stops the buffering on every camera that isn't also
saving detection clips or wake clips — but *not instantly* if that camera has a capture already in
progress: the buffer keeps running until every such capture finishes, then stops at Nightlight's next
periodic check, which runs about **every 5 minutes**. What "finishes" can take varies with what's in
flight: an on-demand recording runs until it hits its auto-stop cap above, at most 600 seconds; a
detection clip runs until it's saved, typically a few seconds; a wake-up already being watched (see
*Wake clips*, above) runs until it ends, normally a few minutes but up to 20 minutes if the camera stops
reporting partway through it, and a wake clip already being cut runs until it is saved or fails, even after its
wake-up has ended. So the *total* delay from flipping the switch to the buffering actually
stopping is that in-progress time plus up to 5 more minutes for the next periodic check — it is not
simply "5 minutes." The same applies to turning **Record wake-ups without alerting** off, with one
difference: that switch also stops any *new* wake-up from starting a fresh capture, so only a wake-up
already under way at the moment you flip it can still hold that camera's buffering open. This is
deliberate: stopping immediately would have deleted the very footage that capture was still reading.
**A clip whose cutting gets stuck is given up on.** Every clip (on-demand, detection or wake) is cut by
an FFmpeg process, and while one runs, that camera's buffer keeps everything recorded since that clip's
start (#773; until then a process that never finished held it for good). Nightlight watches the cut's own
progress (frames, time and bytes written so far) and gives up once **none of them has moved for 2 minutes,
plus 1 second for every 2 MB the cut has already written**. It is measured from the last time anything
moved, not from the start, so a long recording on a slow server is never cut off while it is still
making progress; the extra time per 2 MB is for the very end of the cut, which reports no progress at all
and takes longer the bigger the file (the video is rewritten so it can start playing in a browser before
it has fully downloaded). In practice, for a camera streaming at 1.4 Mbit/s: a little over 2 minutes
for the longest detection or wake clip (150 s and 123 s, about 26 MB), and just under 3 minutes for the
longest recording (662 s with its pre-roll, about 115 MB); the same recording from a 4K camera (about
0.8 GB) gets about 8 minutes 40 seconds. The two quick steps after it (reading the finished clip's
length and size, and taking its thumbnail) get **2 minutes** each. A cut that is given up on is stopped,
marked **failed** like any other failed clip, and its half-written video and thumbnail are deleted (they
used to stay on disk); the buffer then goes back to discarding old footage, and a buffer that is no
longer wanted stops at the next periodic check. Pressing **Stop** waits for the cut, so a stuck cut now
holds it up for at most that window plus the two 2-minute steps. None of these are settings.
**Known limits.** The numbers are generous guesses, not measurements: they were not timed on any server.
The log shows one line per cut, beginning `[clip] cut`, with how long it took and the longest it went
without progress; if a clip that should have worked is ever given up on, that line is what to report. A
cut that keeps making progress but never finishes is never stopped (with a clip of fixed length this is
not expected to happen). The progress FFmpeg reports has changed between FFmpeg versions, and the image
installs whichever version its base image ships, so a future FFmpeg could report it differently.

**No Record button on a camera?** The button hides itself when that camera isn't buffering, because
reaching backward is the whole point and there'd be nothing to reach into. Check that on-demand
recording is on above, and that the camera isn't disabled. If the clips folder itself failed its
start-up check, the container log says so with a line beginning `[clips] CLIPS_DIR` — either *not
writable* or *NOT a mapped volume*; see [Where recordings are stored](#where-recordings-are-stored).
*(Older versions only started buffering a camera that also had **detection** clips switched on — which
is off by default — so on a fresh install the button never appeared at all. If you are on one of those,
turning detection clips on for that camera, or re-saving the camera, brings it back.)*

**A recording that's in progress when Nightlight restarts.** The clip is assembled from the buffer at
the moment you press stop, so a restart during that step has to be waited for. Nightlight now finishes
it on the way down — but only if your container is given time to shut down, which is what
`--stop-timeout 30` (or Compose's `stop_grace_period: 30s`, or the Unraid template's *Extra
Parameters*) is for. Stopping takes a few seconds and the container exits as soon as it's done. Without
that setting Docker may kill it part-way, and the recording is marked **failed** instead — see
[Quick start](../README.md#quick-start) and [KNOWN-ISSUES.md](../KNOWN-ISSUES.md).

Nightlight waits **up to 6 seconds** for that final step, which is enough for the recordings this is
for. It's a fixed limit: **raising the stop timeout past 30 seconds won't buy a long recording more
time**, because the wait isn't derived from it. A recording still being assembled after 6 seconds is
given up on, and marked **failed** the next time Nightlight starts — a bounded wait, not a promise.

**When a recording can't be saved, it says so.** A recording that fails — the camera was offline and
the buffer had no frames in it, the clip couldn't be assembled, or a restart interrupted it — appears
in the **Recordings** card as a greyed entry reading *Couldn't be saved*, rather than never appearing.
Tapping it explains what happened and, for an admin, offers to remove it (a caregiver is told that an
admin can). There's nothing to play, so it has no thumbnail and no play button.

⚠️ **Removing a child deletes everything for them, and removing a camera deletes everything for it** — files
and all. What exactly goes is listed in [Removing a child or a camera](#removing-a-child-or-a-camera). **Save
anything you want to keep first**, and note that only an **admin** can remove either.

**Removing a failed one doesn't ask twice** (admin only, like any delete). Deleting a recording that *worked* takes two taps — a
confirmation, because the video is gone for good and there's no retention sweep that would have removed
it anyway. A failed entry has no video to lose, so **Remove** clears it immediately.

This is deliberately different from the other two kinds of video: alert clips and wake clips are
tidied up automatically, so a failed one just disappears. Recordings have **no automatic retention**
(see above), so a failed one stays until you remove it — which is why it's shown at all. A recording
that silently never appeared was indistinguishable from the app having ignored the button.

**Record on a camera that's offline** will start and then save nothing — the buffer exists but has no
frames in it. The button doesn't currently distinguish "buffering" from "buffering something", so this
is the case you're most likely to meet the *Couldn't be saved* entry in.

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

`CLIPS_DIR` accepts an absolute container path with or without a trailing slash (`/recordings` and
`/recordings/` are the same folder). A relative path is resolved against the server's working directory,
which is rarely what you want, so use an absolute one. Leaving it blank (or whitespace only) means "unset": clips
go under `<data dir>/clips`. Any other value is used exactly as typed, so a space at the start or end is part
of the folder name (a legal Linux name), not ignored: do not add one by accident. Before this was fixed (#545), a trailing slash made clips unplayable and
undeletable, so if you ever entered one, update and restart: nothing else is needed.

Both are exposed as optional fields in the Unraid template (**Recordings Directory** and **CLIPS_DIR**,
under *Advanced view*). With Docker Compose, uncomment the commented `recordings` volume line in
`docker-compose.yml` and set `CLIPS_DIR` in your `.env` — see the comments in `.env.example`. With a
plain `docker run`, add `-v /path/to/recordings:/recordings -e CLIPS_DIR=/recordings`.

**The folder must be writable by the user Nightlight runs as (`PUID:PGID`, 99:100 unless you changed
them).** At start-up the container fixes the ownership of the **data directory** only; an external
`CLIPS_DIR` keeps whatever owner and mode the host gave it. On Unraid a share is usually owned by
`nobody:users`, which is 99:100, so it works as it is. On another host a folder you created is often
owned by root: `chown` it to `PUID:PGID` (or otherwise make it writable for that user) before
starting. A read-only mount counts as not writable. If it is not writable, Nightlight does not stop.
It logs this once, at start-up:

```
[clips] CLIPS_DIR "<path>" is not writable (<reason>). Clip recording disabled.
```

and **Settings → Recording → Storage** shows the path with a warning that reads "not a mapped volume"
(the same wording for either cause). Until the folder is fixed and the container restarted, no
automatic clip, wake clip, on-demand recording or timelapse is saved; alerts still go out, without a
clip.

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
- **Nightly timelapses** (the sped-up "memories" video of each night): each child keeps their **30 most
  recent**, and older ones are deleted automatically (not configurable). ⚠️ Two kinds of "nobody was in
  the bed" night are treated **differently**:
  - A night the **detector** scores as *no one in the bed* gets no timelapse. The frames sampled
    overnight show an empty room, so they are thrown away when the night is first scored.
  - A night **you** mark *No one was in the bed* in the morning review keeps its timelapse. It is made
    and kept like any other night's, and marking the night deletes nothing. This is deliberate: the mark
    can be taken back, and a tap in a review should never destroy video that taking it back could not
    restore. If you don't want that night's timelapse, an admin can delete it from the child's page.
  - Correcting a night's times, or the **lock** that a correction puts on the night's summary (README,
    "A night you have corrected is locked"), changes nothing here either. A timelapse is made once, the
    first time the nightly update scores the night, and a correction never takes that pass away: a night
    corrected before it was first scored still gets its timelapse when it is.

**A stuck timelapse is given up on.** If the assembly's frames, time and bytes written stop moving for
**2 minutes plus 1 second per 2 MB already written**, Nightlight stops it and marks that night failed.
The sampled frames are kept, while the temporary numbered sequence is removed. A slow server can keep
assembling for longer while progress continues. The thumbnail step has its own **2-minute** limit;
if it fails, the video is still ready without a thumbnail. These numbers are unmeasured guesses shared
with clip cutting (#773), and the `[timelapse] assemble` log line records the longest wait to help
calibrate them. There is no automatic retry or retry button after a failed assembly: the nightly job
starts one when the night is first scored. The kept frames allow a future retry to be added.
A child that keeps reporting progress forever is not stopped by this stall rule.

There is also a **minimum-free-space guard** across all three: if the volume is nearly full, new video
is skipped, so recording can never be the thing that fills your disk.

### Removing a child or a camera

⚠️ **This is not retention, and nothing here is kept.** Removing a child, or a camera, deletes everything
that belongs to it, rows and files, and **cannot be undone**. The Remove dialog lists these before you
confirm and asks "Are you sure?". The two are **different**, and so is what each leaves behind:

| | Removing a **child** | Removing a **camera** |
|---|---|---|
| Sleep nights and morning reviews (with their notes) | Deleted | Each night's saved summary, and the review's answers and notes, are kept (they belong to the child). **The night's detail and the review's photos are lost** for every night the camera recorded: both are built from its activity history and bed transitions, which go |
| Bed transitions and their snapshot photos | Deleted, for the cameras assigned to the child | Deleted |
| Activity history (the per-minute motion and sound the sleep summary is built from) | Deleted, for the cameras assigned to the child | Deleted |
| Recordings and wake clips (video files included) | Deleted | Deleted |
| Timelapses, and frames collected for a night not yet assembled | Deleted | **Kept** (they belong to the child), including the ones made from this camera's frames |
| Alerts, with their clips and snapshots | **Kept** (they belong to the camera) | Deleted |
| Camera event log and temperature and humidity history | **Kept** (they belong to the camera) | Deleted |
| The child's profile, photo and sleep-tracking settings | Deleted | Not applicable |
| The camera itself | **Kept**, and becomes unassigned | Deleted, with its stream and its clip ring |

Things that behave in ways you might not expect:

- **Judged bed-transition frames go too.** They are kept forever by the 45-day sweep, but that is a
  retention rule, and removing the child or camera is not retention.
- **A camera that was moved from one child to another keeps one history for both.** Bed transitions and
  activity samples record the camera, not the child, so removing the *current* child clears all of the
  camera's history, **including another child's**: the nights it recorded for whoever had it before keep
  their saved summary and review notes, but lose their detail and review photos, exactly as if the camera
  had been removed. Known limit, not fixable without recording the child on every sample.
- **Alerts are the camera's, not the child's.** Removing a child keeps the alert clips and alert photos
  its cameras recorded; they go when their retention removes them, or when the camera is removed. The
  child's Remove dialog says so.
- **Removing is refused while a camera is recording.** If the camera, or any camera assigned to the child,
  has an on-demand recording running, the dialog says "Stop the recording first" and nothing is deleted.
  A clip or photo that is *still being saved* when its child or camera is removed (a recording already
  stopped, a wake clip, an alert clip or photo, a bed-transition frame) deletes its own file when it
  finishes, because nothing is left to file it under.
- **If something cannot be deleted, nothing further is.** A file that is already gone is fine. Any other
  failure (a permissions problem on the data folder, say) stops the removal, the dialog shows the reason,
  the child or camera is still there, and you can retry. Files are removed before the entries that name
  them, so a failed removal never leaves an entry pointing at a deleted file. It can leave a partly emptied
  child or camera: some of its history already deleted.
- **Only files inside Nightlight's own data and clips folders are ever deleted**, whatever a stored path
  says. If `timelapse`, `.ring` or `.timelapse-frames` inside the clips folder is a link to a folder
  somewhere else, removing a child or camera is **refused** before anything is deleted or stopped (the
  dialog says why). Make it a real folder, or point the whole clips folder (`CLIPS_DIR`) at the other place,
  and retry. A camera whose removal fails part-way (a file it could not delete) is restarted straight away.
- **Folders are swept only for ids Nightlight made.** Every child and camera gets a random id (a UUID), and
  its folders in the clips folder are named after it. A child or camera with any other id (from an edited
  or imported database) still has its entries, and every file they name, deleted; files nothing names in
  its folders are left. Known limit: this is what stops an id like `timelapse` emptying a shared folder.

### Who can delete

**Only an admin can delete video by hand**: an alert clip, a wake clip, an on-demand recording (a failed
one included) or a timelapse. Anyone signed in, caregivers included, can watch and download all of them,
and can press **Record**. (Owner decision, 2026-10-10: a caregiver can watch and act in the moment, but
cannot destroy or reconfigure.) On a caregiver's screen the delete buttons are simply not there.

This is **different from retention**. The sweeps above are automatic, run on a timer, and apply on every
install whoever is signed in; signing in as a caregiver changes nothing about what they remove. Only
*configuring* them (Settings → Recording) is admin-only.
