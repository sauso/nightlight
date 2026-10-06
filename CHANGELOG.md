# Changelog

All notable changes to Nightlight (server + web app) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/). While on 0.x: minor bumps for new
features, patch bumps for fixes. History before 0.1.0 exists only as git history —
0.1.0 is the first tracked release, not the first release.

## [Unreleased]

## [0.35.0] - 2026-10-06

### Added
- **The log now says when a hole in a camera's readings sends the wake watcher's settling back to zero.**
  Wake clips are only recorded once the watcher has seen 15 consecutive quiet minutes, and one missing minute
  restarts that count, so a camera that drops a minute more often than about every 15 minutes never starts
  watching and records no wake clips; until now that was silent, and looked the same in the log as a child who
  never settled. A restart that cost real progress now logs `[wake] "<camera>" settling restarted: readings N
  min apart after M quiet minute(s)`, **at most once per camera per 15 minutes of the camera's own minute
  labels**: restarts held back by that limit are counted onto the next line (`; K more since the last such
  line, the longest after M quiet minute(s)`), and one still pending when the camera starts watching or its
  window closes is not printed.
  Nothing else changes: **when the watcher starts watching is exactly what it was**, no setting was added, and
  a forward jump of the server's clock writes the same line as a dropout. Read it in KNOWN-ISSUES.md ("A wake
  recording does not bridge a gap in the readings"); restart lines repeating with no `settled` line after them
  are the evidence for whether the 15-consecutive-minutes rule is too strict (#590).
- **A "WebRTC UDP Port" setting, so a second instance no longer needs a hand-typed MediaMTX override.**
  Running staging beside production on one server needs each instance on its own WebRTC UDP port, which
  meant adding `MTX_WEBRTCLOCALUDPADDRESS=:8190` yourself: a leading colon nothing explained, and in
  Unraid's "Add Variable" dialog the name went in the wrong box, so MediaMTX silently stayed on `8189` and
  remote Low latency never connected. Set `WEBRTC_UDP_PORT` (the **WebRTC UDP Port** field in the Unraid
  template, `.env.example` and `docker-compose.yml`) to a bare number: **1-65535, no colon, blank =
  `8189`**; the colon is added for you and a pasted `:8190` is accepted. An invalid value is ignored with
  a warning in the log and `8189` is used, rather than being handed to MediaMTX, which would exit and
  restart forever. The raw `MTX_WEBRTCLOCALUDPADDRESS` override still works (for a bind address a bare port
  cannot express) and **wins** if both are set, and `docker-compose.yml` now forwards it. The README and
  the Unraid **Public Host** description now also say that `PUBLIC_HOST` must be a DNS-only name or an IP,
  never a Cloudflare-proxied one: the proxy carries neither UDP nor port `8189`. Existing installs are
  unchanged. The Unraid template only updates for new installs; on an existing container, add the
  variable by hand (Key `WEBRTC_UDP_PORT`).
- **The morning review now records "In bed" separately from "Fell asleep".** On a bedtime-story night a
  child can be put down half an hour before they fall asleep, and the review had no way to say both: its
  only frame button, **Put down here**, set the *asleep* time, so marking the put-down overwrote an asleep
  time the detector had right (found correcting a real night: put down 18:49, asleep 19:13, and the card
  ended up saying asleep 18:49). A recorded *got into bed* event now has two buttons: **Put down here**
  fills a new **In bed** time and never touches the asleep time, and **Asleep here** fills "Fell asleep". A
  short line above the event list says which is which. A corrected in-bed time moves only the "in bed"
  time. The asleep and wake-up times the form saves alongside it (as your confirmation) no longer
  recalculate the total asleep on a screen that was already showing those times; a screen recalculates
  only where a saved time differs from its own, which is normally a time you changed (the README explains
  when the review page and the child's card start from different versions of the night, and what that
  does). Tapping a picked frame's button a second time now undoes the pick and puts the field back as it
  was, for all three buttons (it
  used to leave the frame's time in the field and save it). The card, detail page and receipt ("You said in bed 6:49, asleep 7:13 to 6:37") show your in-bed
  time next to your asleep time. "In bed" can't be saved later than "Fell asleep" (a picked frame may be
  up to a minute after a typed asleep time), or, when the review is left with no asleep time (none given,
  or "Fell asleep" emptied), later than the asleep time the night already has; "Fell asleep" can't be
  later than "Got up for the day" either, or, when you give no wake-up time, later than the wake-up time
  the night already has. Each is checked against what was saved before as well as what is being saved, a
  refused save stores nothing, event answers included, and a later note, event answer or dismissal is
  never refused because the night changed after you answered. Reviews saved before this are kept as they
  were: none is reinterpreted as an in-bed time. Nothing here assumes a particular house, child or
  timezone. Details in the README's morning-review section.
- **The morning review can now say "No one was in the bed" for the whole night**, not just correct a
  time. Previously the only option was to type times, so a night the detector scored as hours of sleep
  in an empty bed could only be saved with nothing in it. The new option sits next to the usual times on
  the review screen ("Was this right?") and, once saved, changes the child's card and the sleep detail
  page to say "You said no one was in the bed" instead of the detector's night — the same way a corrected
  night already shows your own times instead of the detector's. It is reversible ("Someone was in the
  bed" undoes it), and per-night: it never assumes a particular child, camera or timezone.
  - The detector's own answer for that night is kept, never overwritten — a future improvement still has
    it to compare against, and un-flagging restores it exactly. What is **not** restored is any time you
    had typed before flagging the night: the flag clears them, so after an undo you may need to re-enter
    them, and until you do, the morning card shows neither "ask" nor "done" for that night (a stated
    limit, not a bug).
  - The night's timelapse and any recorded transition frames are **kept**, unlike a night the detector
    itself scores empty (which discards its frames) — the flag is reversible and a tap here should never
    destroy video that undoing it could not bring back.
  - Excluded from the sleep ↔ temperature insight averages, and its automatic "up at such-and-such" push
    is skipped — a push already sent cannot be recalled, but no further one goes out for a flagged night.

### Changed
- **Neutral example text in two form fields.** The child form's name field now suggests "Alex", and the camera
  form's MQTT topic example reads "zigbee2mqtt/Child B Room Temp"; both used to show a real person's first name
  as the example. Placeholder text only: nothing is saved or behaves differently. The add-camera screenshots
  under `docs/screenshots/` were repainted to match.

### Fixed
- **Wake clips no longer count minutes whose video nobody saw** (issue #588). When a camera's video stalls
  while its microphone keeps working, the live wake watcher read each minute of sound as a watched minute: a
  quiet one counted toward the 15 quiet minutes it needs before it starts watching, and a loud one counted as
  activity, so a noise during a stall could complete a wake that the sleep timeline (which has called those
  minutes unknown since #508) does not show. Now such a minute, on a camera that has delivered video since the
  server started, is a minute the watcher did not see, exactly as on the timeline: no progress toward starting
  to watch, not activity even when loud, and a pause inside a wake like any other. A wake in progress still
  ends at the 4th minute without activity, the same minute 4 quiet minutes would end it, and the log then says
  `run ended (video not observed; readings N min apart)`; if the server's clock steps back during a stall, the
  first stalled minute that shows the step ends the run (`run ended (the clock went back)`), as a minute that
  was read always did. A camera with no video at all keeps using its sound, as before. In about 30 days of
  stored minutes from two cameras in one house (measured 2026-10-05) there were 263 such minutes in one
  database (97 of them loud enough to count as activity) and 807 in the other (251 loud). Known limits, in
  KNOWN-ISSUES: a camera already stalled when the
  server starts counts as having no video until its first frame; a minute made only of repeated frames still
  counts as watched live (no such minute in the stored data); a child crying through a stall is not recorded
  as a wake; the bed in/out rules are unchanged. Details in `docs/recording.md`. Nothing here assumes a
  particular house, child or timezone.
- **A parent at the bed after a child got up no longer moves the morning wake hours later** (issue #598). A
  *got out of bed* logged within a minute of a *got into bed* is set aside as the same climb-back-in read
  twice, but only if the bed then shows the child is really back. That proof was any 3 minutes of movement
  in the 2½ hours after the return, and a parent stripping or tidying the empty bed provides plenty: on a
  real night a stray *got into bed* 51 seconds before a child's real 07:12 exit, plus a parent at the bed an
  hour later, set the real exit aside, and the stored wake moved to the next exit, 09:27, once that one was
  confirmed. The proof is now **6 minutes of slight movement** (the level a still sleeper produces, below
  what counts as the child moving) in those 2½ hours; bigger movement no longer counts. Measured on every
  stored night of two cameras in one house: the exits wrongly set aside had 0-3 such minutes, the ones a
  review confirmed were rightly set aside 10 or more, and any threshold from 4 to 10 gives the same results
  there. On the measured nights, every night that changed moved earlier (in principle a night can also move
  later: a real exit that used to be set aside is now found), and its wake count and sleep totals change
  with it. Known limits, in the README and KNOWN-ISSUES: a child who climbs back in and lies stiller than
  that, or really gets up again within about two hours, or a camera that only registers bigger movement,
  gets a wake that is too early (never a missing one); a camera whose EMPTY bed reads faint noise at that
  level is not helped by this (and is no worse than before); one production night moved 46 minutes earlier
  with no way yet to tell which time is right; and a too-early wake with no stray *got into bed* is not
  fixed by this. The same check before a mid-night trip, and the check on a return straight after a *got
  out of bed*, are deliberately unchanged. Saved nights keep their old answer until an admin uses
  **Recompute this night**.
- **A wake clip now starts at the wake's first moving or noisy frame, not up to a minute after it** (issue
  #412). Since #447 the clip began 3 seconds before the END of the wake's first active minute, so it started
  up to 57 seconds (about 27 on average) after the first frame and could miss the opening it exists to show
  (#447's entry said "starting them at the first moving frame is #412": that is now done). The clip now opens about 2 to 3
  seconds before the first frame that was over the same motion or sound threshold that makes a minute active,
  or at the oldest footage the recording buffer still holds, if that is later: a continuous buffer of about 70
  seconds or more reaches the first frame, a shallower one starts the clip up to about a minute minus its depth
  after the first frame (roughly 22 seconds with a 38 second buffer, 37 with a 23 second one; derived, about 4
  seconds either way). A clip is not anchored earlier than the footage the buffer really holds (that would leave
  nothing to cut and fail it); where the buffer has a gap so that no footage at all falls in the clip's window, the old start
  (the end of the first active minute) is used, as before. The log says when the buffer cost the opening: `[wake]
  "<camera>" the buffer reaches back only to N s after the first movement: the clip starts there`. The clip's
  recorded start is the clip's planned first frame (3 seconds before the first moving or noisy one; with an almost empty buffer, up to 3 seconds before the first footage it holds), so it can be a few seconds before the wake's minute on the
  timeline; the review page still pairs them. Which minutes count as a wake, what is recorded and what the
  sleep numbers read are unchanged. Details in `docs/recording.md` and KNOWN-ISSUES ("Where a wake clip
  starts"). Nothing here assumes a particular house, child or timezone.
- **A camera with motion alerts off (or MQTT/ONVIF motion) now keeps sampling until 3 hours after the
  sleep window closes, so the morning wake can be found** (issue #353). Its motion leg runs only to feed
  sleep tracking, and it used to stop 5 minutes after the window ends, although the sleep numbers look for
  the morning departure up to 3 hours after it: that departure was never observed, so such a night had no
  wake time. A bedtime shortly after midnight (a window opening 00:00 to 02:59) is now also sampled from 3
  hours before it, which is the previous evening; before, that lookbehind was missed. The 3 + 3 hours are
  the sleep detector's own, and are real hours across a daylight-saving change. The cost is about 3 more
  hours a day of one low-resolution video decode for such a camera (15 hours a day becomes 18 for a
  19:00-07:00 window; CPU not measured). A frame-diff camera with motion alerts on already samples around
  the clock and is unchanged, and so are the timelapse, wake clips and the wake watcher. The morning
  review for such a camera still has no events past about 3 hours after the window's end. Details in the
  README ("When the motion camera samples") and KNOWN-ISSUES. Nothing assumes a particular house or
  timezone.
- **A garbled ffmpeg log line no longer leaves the sound `[obs]` measurement blind for hours** (issue #573).
  The `[obs]` line's sound side could suddenly read `observed=0 unknown=4500 side=unavailable` and stay that
  way until the camera reconnected or rebooted, while the sound detector itself kept working (`[sound]`
  level lines printed, alerts fired, stored `sound_windows` stayed at about 300 a minute). The cause was one
  timestamp line in ffmpeg's output with another message glued onto its end (the muxer's `Application
  provided invalid, non monotonically increasing dts`): the parser threw the whole line away although the
  part it needs was intact, and one lost line blinds the rest of that ffmpeg run. It happened about once per
  camera per day on a two-camera install and was seen on a production install. Such a line is now
  recovered (sound only), and the glued message is still logged exactly as before. Nothing the detector
  decides or stores changes: nothing reads the sound side of `[obs]` yet, so this only fixes what the
  line says. A timestamp line that is truly lost still blinds the rest of its ffmpeg run, as designed, but
  now logs one warning when the run goes blind, at most once per camera per 15 minutes (`[obs] "<camera>"
  sound gen=N timestamp sequence broke (<why>) …`), so a blind measurement can be told from a dead microphone. Motion timestamp
  lines are not changed. See KNOWN-ISSUES, "The `[obs]` line".
- **Motion sensitivity no longer changes which bed exits and entries are recorded** (issue #368). The
  sensitivity slider set one threshold that the motion alert and the out-of-bed / into-bed detection
  both used, so tuning how many notifications you wanted also changed the stored `out_of_bed` and
  `into_bed` rows that sleep analysis reads as bedtime and wake evidence, and a camera that only feeds
  sleep tracking (MQTT or ONVIF motion, or motion detection off) used a sensitivity whose slider the screen
  does not show. The alert keeps the slider exactly as before; exits and entries now use a **fixed 1.19% of
  the zone**, which is the value the slider gives at 90. **Differs from the neighbours:** the detector's
  return to the Low stream (#500) waits until the room has been quiet by both definitions on a camera that
  alerts (the alert's and the exit rules'), and by the fixed one alone on a camera that does not; a camera
  with no bed zone that alerts keeps only the alert's definition. At the default sensitivity (50) "quiet"
  now means under 1.19% in both channels instead of under 5.15%, so a picture with 1.19-5.15% noise (a fan,
  a curtain, infrared noise) keeps the detector on the main stream for as long as that noise lasts (the
  return has no forced timeout). **What you may notice:** if your
  sensitivity was not 90, the exits and entries recorded from now on can change, in either
  direction: below 90 (the default is 50, 5.15%) the threshold goes down, so movements the old threshold
  ignored now count, which can add exits and entries and can also cancel a pending exit (a movement of 1-5%
  of the zone, such as a child settling, now cancels it), so the totals can move in either direction; above
  90 it goes up. Whether that is better for your reported sleep is not known. 1.19% was calibrated in one house, is not derived from your room, and
  there is no setting for it; a noisy room can no longer be quieted for sleep tracking by lowering the
  sensitivity, so redraw the detection zone. Stored rows and sleep nights already computed are not
  rewritten. See KNOWN-ISSUES.md and the motion sensitivity row of docs/notifications.md.
- **A motion alert can no longer fire sooner than the Motion cooldown after the last one just because the
  detector restarted** (issue #454). The time of the last frame-diff motion alert lived inside one run of the
  detector's ffmpeg, so every relaunch (a camera reconnect or "stream ended", a transport restart, the detector
  watchdog's kill, the return to the Low stream) started a cooldown from zero, and sustained motion could alert
  again straight away. It is now kept per camera for as long as the server runs, so those relaunches, and the
  detector being started again by a detection-settings save, any camera edit (a rename too), assigning the
  camera or switching it off and on, all keep it. **Differs from the neighbours:** it is **lost when the server
  itself restarts** (nothing is stored; a container that restarts nightly can alert once more per camera per
  restart, only if motion is sustained within the cooldown of the last alert); the **sound** cooldown was
  already kept across an ffmpeg relaunch and is not changed here; MQTT and ONVIF motion keep their own
  cooldowns; and the bed-exit/entry rules (their 2-minute pause and a pending exit) still start afresh on a
  relaunch. **What you may notice:** after changing a motion setting, the next alert is no longer immediate,
  so to retest wait out the cooldown (60 s by default; 1 s minimum, the form allows up to 3600 s) or set a
  short one. A one-way backward step of the server's clock now silences the frame-diff alert for at most one
  cooldown (it used to be the step plus a cooldown); a step back followed by a correction forward can let one
  alert through inside the cooldown, and a clock that jumps by hours between frames can alert repeatedly (a known
  limit, not what time sync does); the other cooldowns are unchanged. A deleted camera's time is
  forgotten with it. No number or threshold was added or changed. In 30 days of one house's saved data no
  two motion alerts were closer than the cooldown and no relaunch followed an alert within 60 s, so no stored
  alert or sleep number changes. An ffmpeg exit and any restart of the detector by a settings save or camera
  edit re-armed the cooldown at any setting; the watchdog kill and the return to the Low stream only mattered
  with a cooldown above about 70 s and 95 s.
  Details and limits: [KNOWN-ISSUES.md](KNOWN-ISSUES.md), "What a restart keeps", and
  [docs/notifications.md](docs/notifications.md).
- **Wake clips no longer treat a gap in the camera's readings as part of one wake** (issue #448). The live
  wake watcher counted readings instead of minutes, so five active minutes spread over about forty minutes of
  mostly missing readings were recorded as one wake, while the sleep timeline (which counts minutes) showed none.
  A wake now bridges at most 3 minutes with no active reading, whether the camera reported them quiet or
  reported nothing, the same rule and the same constant as the nightly job, so two qualifying bursts of
  activity either side of an outage are two wakes and two clips. The watcher also starts watching only after
  15 *consecutive* quiet minutes that were actually reported (a missing minute restarts the count), where
  before 14 quiet minutes, a long outage and one more counted as 15. This is deliberately stricter than the
  sleep timeline's own "settled" rule: the cost is that a camera that drops a minute more often than about every
  15 minutes never starts watching and records no wake clips. On the saved 30 days of two cameras in one house,
  replaying the old and the new rule, the start of watching differed on exactly one night in four camera-months
  (8 minutes later), so a night is rarely delayed; unknown on other installs. An already-watching watcher is
  not stopped by a gap. A server clock that steps backwards by more than about 2 minutes (smaller steps were
  already absorbed) now ends the run in progress, and restarts the count toward watching if the watcher was
  still settling, instead of silently mixing the repeated minutes in; a repeated minute is counted once. The
  wake clip's ring hold is still released when a run ends, and a late clip-cut can no longer release the hold
  of a newer wake. A wake that starts after a gap has its clip anchored at its own first minute. The 3, 5 and
  15 are the same numbers as before: the nightly job's own constants, shared with the live watcher (a retune
  moves both), tuned on nights from two cameras in one house and not validated elsewhere. No stored sleep
  number changes: only the wake clips can differ (fewer for sparse activity, more where one run used to span
  an outage). Known limits are in
  [KNOWN-ISSUES.md](KNOWN-ISSUES.md), "A wake recording does not bridge a gap in the readings".
- **Camera history no longer shows a detector restart that did not happen** (issue #578). When a detector
  stopped receiving video or audio, the detector watchdog wrote "detector restarted by the detector watchdog"
  (and a `[WARN]` log line) *before* asking for the stop, and never checked whether the stop was refused (for
  example because the motion detector was already on its way back from the main stream to the Low one). Now the
  row and the `[WARN]` line follow the answer and name only what happened. A refused stop writes no row and one
  `[INFO]` line containing `lever refused` (and the likely reasons); if a stream restart was requested in the same step, the row says only
  that. A refused stop still counts as an attempt, so it still advances the backoff (1, 2, 4 ... 30 minutes)
  and, for motion, the second attempt still asks for the stream restart (stated in KNOWN-ISSUES.md as a limit).
  The row wording `no data through N restart(s)` is now `N attempt(s)` for the same reason. The sound detector
  is covered the same way. Nothing here assumes a particular camera, child or timezone.
- **A motion alert or a bed exit/entry is no longer confirmed across a gap in the camera's video** (issue #452).
  Both used to count *time elapsed* rather than video received: motion that was active, then silent for 20 seconds,
  then active again was alerted on at once as "sustained", and a single quiet frame arriving after a long hole
  confirmed a bed exit or entry as if its 6 quiet seconds had been watched. Now a frame that reaches Nightlight
  after a gap (longer than 1.5 s, or 5 times the camera's own frame interval if that is larger, learnt only
  once 9 intervals are held so a lone stall right after a start cannot widen it) restarts the count: a motion
  alert needs its *Motion confirm* time of frames received after
  the gap, and a pending exit or entry needs its full 6 seconds of received quiet. A pending exit or entry is
  restarted, not cancelled, so a real exit during an outage is still recorded, just later; activity on the
  first frame after the gap still cancels it, as before. A restart is logged (`motion run restarted` /
  `confirmation restarted`, with the length of the gap), only when something was actually waiting.
  *Motion confirm* 0 still alerts on the first frame. **Differs from the neighbours:** candidate opening, the
  bed/outside links, the alert cooldown, sound alerts, stored counts and peaks are unchanged, and a stored
  `out_of_bed`/`into_bed` after a gap is stamped later, with a `peak` and `out_frames` that can differ. The
  numbers (1.5 s, factor 5, 16 intervals, 9 held) are chosen, not measured. A camera that keeps stalling confirms
  more slowly (expected wait, in seconds of received video, about 7 s for the 6 s exit with 3.3 gaps a minute,
  38 s at 30 a minute, 400 s at 60 a minute, assuming random gaps of 2-3 s; in wall time roughly 8 s, 75-90 s and
  1100-1400 s), and gaps more frequent than once per 6 s of received video starve a pending exit: there is no
  cap on restarts (a follow-up decision). A healthy camera at its normal rate never prints the restart lines. A
  cold camera that delivers every 2 s restarts a pending exit or a motion run about 9 times before its bound has
  learnt: a candidate pending in the first ~18 s after a detector (re)launch confirms at about launch + 24 s, and
  sustained motion alerts at about 24 s instead of 6 s (up to ~18 s later than before; a warm camera is
  unchanged, intermittent motion is unaffected). After a slow phase the bound also stays wide until 8 fast
  frames have arrived, so a stall shorter than 5 times the old interval in that window is not seen. Per
  candidate a confirmation is never earlier than before (per stored row it can differ). A stall ffmpeg fills with
  repeats as it happens is not caught. Details and limits: [KNOWN-ISSUES.md](KNOWN-ISSUES.md), "A motion alert or a bed
  exit/entry is not confirmed across a gap in the video".
- **Motion detection now goes back to the Low stream after an outage, instead of staying on the main stream
  until it next restarted** (issue #500). A motion detector waits up to 45 seconds for the camera's Low
  (sub) stream, then settles for the main stream. After any outage longer than that (a scheduled camera
  reboot, a Wi-Fi drop, a server restart) both streams return within about a second of each other and the
  main one is usually first, so the detector stayed on it, which could be a day or more, and nothing said so.
  Every motion threshold was measured on the Low stream, and the main one costs more CPU. A detector that
  fell back now says so in the log (`reading the MAIN stream`) and, once the Low stream has been ready on 3
  checks 20 seconds apart **and** neither the bed nor the area outside it has moved for 90 seconds, relaunches
  itself onto the Low stream (`returning the motion detector from main to sub`), at most once per 10 minutes.
  The switch is an ordinary detector relaunch: about 5 seconds with no motion samples, the bed-transition
  rules (a half-seen exit or entry, and the 2-minute pause after a logged one) start afresh, while the motion
  alert cooldown (issue #454) and the belief about whether the child is in bed are kept.
  The 90-second quiet period is derived from the bed-exit rules so a switch cannot lose an exit. The numbers
  are fixed, not settings, and were chosen rather than measured. A camera with no Low stream, and the sound
  detector, are unchanged. See KNOWN-ISSUES for the limits.
- **A muted or silent microphone is now recorded as a quiet room instead of as missing sound, and silence
  between separate noises no longer adds them up into a sound alert** (issue #453). When a microphone
  delivers digital silence (every audio sample exactly zero: a muted or gated microphone, or a codec that
  encodes silence that way), each 200 ms window of it was thrown away as if nothing had been heard. So the
  sleep timeline stored no sound for those minutes; a sound detector reconnecting during the silence could be
  stopped as "does this camera have a microphone?"; and the silence between separate noises was skipped, so a
  few short noises seconds apart could average out as one long loud sound and send an alert that the same
  noises in an ordinary quiet room would not. A silent window now counts as heard and quiet, exactly like a
  reading at the room's own learned ambient level: it is stored as 0 over ambient and included in the
  minute's sound average and spread, it dilutes the alert's average over the **Sound confirm** time (4 s by
  default, 0–30 s) like any quiet moment, and it never counts toward "no microphone". A minute of nothing but silence now writes a per-minute row (sound 0)
  even with no movement, where before it wrote none; a stream that delivers no audio at all still stores
  nothing, so the two stay distinguishable. The `[sound]` level line keeps printing for a silent microphone
  (`peak=?`). Sleep numbers are unchanged (a minute only counts as noisy above 6 dB over ambient, and a minute
  without video is not used); the live wake check now hears a silent minute as a quiet one, as it already did
  a quiet room. No setting or threshold changed. Known limits (silence cannot teach the app a room's ambient
  level, and short bursts of sound between silences may never teach it one; silence never lowers the level,
  though a long loud sound can still be absorbed into it just after the sound stops; and stored per-minute
  sound averages from before and after this change are not comparable): [KNOWN-ISSUES.md](KNOWN-ISSUES.md),
  "A muted or digitally silent microphone is recorded as a quiet room".
- **A detected wake-up after midday, or asleep time before midnight, is saved on the right day in the
  morning review.** A time in the review is dated by the clock: before 12:00 is the morning after the
  night's date, 12:00 or later the night's own evening. But the app's own times can fall on the other side
  of that line: a wake-up after midday when the sleep window ends after 09:00 (a wake-up is looked for up
  to 3 hours past the window's end), or an asleep time before midnight when the window opens just after
  it (an asleep time is looked for from 3 hours before the window opens). **That's right**, or saving the
  form with that time left as it was, then put it a day off, so the corrected night ended before it began.
  Now a time saved exactly as the app showed it is saved as that exact time, as long as it is one the app
  could have worked out for that night (inside the child's sleep window widened by those 3 hours each
  side); anything else is dated by the clock as before, so a time sent from outside the app can at most be
  moved to another day inside that same span, never to an arbitrary one. The same goes for the hour that happens twice on the night the clocks go back:
  the app's own time in it keeps the occurrence the page showed, instead of whichever one the timezone
  arithmetic picked (the second at or east of UTC, the first west of it), which could be an hour off. A
  time you type yourself is still dated by the clock (a known limit in the README). Any timezone, any
  install.
- **A night you have corrected is no longer recalculated afterwards.** After a parent corrected a wake
  time, the nightly update kept re-saving the night for up to about 3 hours after its window closed and
  never looked at the correction, so the corrected night's total asleep and wake-ups could change hours
  later (seen when a bed was changed after the corrected wake-up). Now any correction in the morning review
  (an in-bed, asleep or wake time, "No one was in the bed", or a plain **That's right**) **locks** the
  night's saved summary: the nightly update leaves it alone and **Recompute this night** refuses it
  (`409`, `reason: "reviewed"`; the dialog says the night is locked). So an early rough pass is not what
  gets locked, saving a correction on last night while it is still being refined first saves it freshly
  worked out at that moment; any older or already-settled night is locked as it is and never re-scored by
  a correction. Editing or removing the correction always works, and removing the last one unlocks the
  night. Answering only per-event questions or dismissing the card locks nothing. A note saved from the
  review form does lock the night, because the form always saves the asleep and wake-up times it shows
  with it, as a confirmation; only a note sent on its own through the API doesn't. The automatic "Sleep
  report updated" push is now skipped after any correction, not only after "No one was in the bed", and it
  no longer goes out late: nothing is pushed more than about 3 hours (at most one 30-minute check past
  them) after the window closed. Before, removing a correction hours later, or a server that had been off
  across the morning, could send "Sleep report updated" for a night the parent had been looking at all
  morning; now that pass only updates the saved summary. Known limits (the locked night is the one worked
  out when you press save, an uncorrected time freezes at its value then, a night corrected before its
  first summary keeps that summary's missing wake-up until you add one, the sleep detail page still works
  the night out fresh, the review page and the card can start from different versions of the night,
  nights corrected before this update are locked as last saved, an old open page can be refused a save
  until reloaded, the repeated hour on the night the clocks go back) are in the README; the notification
  change is in [docs/notifications.md](docs/notifications.md).
- **The morning review no longer saves times in the wrong timezone when used the moment it opens.** Until
  the app has loaded the timezone set in Settings (usually a moment after the page opens, or never that
  visit if loading it fails) it shows times in UTC. Tapping a frame button or typing in that moment kept
  "Fell asleep" and "Got up for the day" in UTC even after the real timezone arrived, and saving then
  stored them: on a Sydney night of 7:13 pm to 6:37 am, 09:13 and 20:37, a wake-up before the asleep time.
  **That's right** sent the UTC times straight away. Now the time controls stay greyed out, with a line
  saying why, until the timezone has loaded; event answers and "No one was in the bed" carry no time and
  work at once. Any timezone, any install.
- **The audio-liveness check no longer reads a failed run as "no audio"** (issue #515). The check that
  decides whether a camera's audio is really flowing counted its probe's output before the output had
  finished arriving, and read a probe that failed to run as "confirmed no audio"; two of those in a row
  restart the camera's transcoder. It now waits for the probe to finish before counting, and a failed run is
  "could not tell", which resets the count. This is a correctness fix for a rare case: the probe reads the
  local MediaMTX and only runs on a stream that was just reported ready, so a failure needs the stream to drop
  in between. A real audio stall, where the stream stays up but carries no audio packets for 6 seconds, is
  caught exactly as before. One visible side effect: when a camera's sound detector has gone quiet and that
  same check keeps failing, the detector watchdog can now restart the sound detector on its usual backoff
  (it appears in the camera's history), where before it left the case to the audio watchdog.
- **A motion or sound detector that stops receiving anything is now restarted, instead of staying silent
  for hours.** A detector's ffmpeg could stay alive and connected while getting no frames at all, and
  nothing noticed: on one install a motion detector got nothing for 4h45 and 8h43 in the same month, both
  times ended only by the camera's daily reboot, and the night's sleep timeline had a hole in it (issue
  #369). A new detector watchdog checks every 15 seconds whether each running detector has written
  anything in the last minute (a still, silent room still counts as writing, so a quiet night never
  triggers it). A dark detector is restarted. If a MOTION detector goes dark again, the Low sub-stream it
  reads is restarted too, or the main stream when it reads that, which briefly interrupts live view (a
  sound detector is only ever restarted itself: its stream is the audio watchdog's job). Attempts back
  off from 1 to 30 minutes. A new detector gets 90 seconds to start delivering. Each restart is one row
  in **Camera history** saying "detector", plus one log line that records where the stream stopped. None
  of it is configurable. The minutes before a restart are still lost from that night's sleep data (issue
  #508). A restart no longer resets the motion alert cooldown either (issue #454, above).
  Details, defaults and limits: [KNOWN-ISSUES.md](KNOWN-ISSUES.md), "A detector was restarted".
- **The sleep timeline no longer counts the pictures ffmpeg repeats during a camera stall as watched
  time.** When a camera stalls, or runs slower than 5 frames a second, the motion detector's ffmpeg
  repeats the last picture to keep five a second going, and each repeat read as a perfectly still room. A
  3-second stall made about 15 of them. The `[obs]` measurement added in 0.34.0 can prove which frames were
  repeats, and those frames are now left out of each minute's stored frame count and average movement
  (`motion_frames`, `motion_level`, `motion_out_level`), so a minute's average can only go up. The peaks,
  which every sleep threshold reads, and motion alerts, in/out-of-bed detection and the sleep numbers are
  all unchanged (issue #493, narrowed: bed transitions and alerts are left to #452). No screen shows these
  three numbers yet; this is groundwork for later sleep-analysis work. Only proven repeats are left out,
  never frames `[obs]` reports as `unknown`, so when its timestamps are unavailable nothing changes. Repeats
  judged after their minute was stored stay counted; since #447 (next entry) that happens only on a camera
  that keeps stalling. Details and limits: [KNOWN-ISSUES.md](KNOWN-ISSUES.md), "A stalled camera's repeated
  pictures are left out of the per-minute motion count".
- **Each minute of the sleep timeline now holds the samples that arrived in that minute.** The per-minute
  motion and sound rows (`activity_samples`) were labelled with the minute a once-a-minute timer fired in,
  and that timer's second depended on when Nightlight started, so a row labelled 19:01 held 19:00:35 to
  19:01:35 on one boot and 19:00:10 to 19:01:10 on the next (issue #447). A row now holds exactly what
  arrived in its UTC minute, and is stored 7 seconds after that minute ends. That wait also lets the stall
  repeats of a minute's last seconds be left out in time: none of a steady camera's stay counted now, where
  about 1 in 12 did. The live wake check hears each minute within a second of its end instead of up to a
  minute later. Each row moves by less than a minute, but on a borderline night a computed bedtime or wake
  time can move by more; nights already stored are not recomputed. Wake clips still start just before the
  end of the wake's first active minute, which keeps them inside the recording ring on every clip setting
  (starting them at the first moving frame is #412). A restart still loses only the minute being received,
  as before: a minute still waiting its 7 seconds is stored on the way out. A new `[activity]` log line
  reports repeats judged too late and clock steps.
  Details and limits (clock steps, stalling cameras, what a restart loses): [KNOWN-ISSUES.md](KNOWN-ISSUES.md),
  "The sleep timeline's minutes are the minutes the samples arrived in".
- **Minutes where the camera's video stalled but its sound kept running are now "no data" in the sleep
  numbers, instead of counted as quiet sleep.** When the motion detector stopped receiving video, the sound
  detector kept writing a row every minute, and every one of those minutes counted as watched and still:
  on one install two stalls (522 and 284 minutes) reported full coverage and hours of sleep nobody saw
  (issue #508; on that install's real nights the change touches only the part of a stall inside the 19:00
  to 07:00 window). A minute now counts as watched only
  if the motion detector analysed at least one real frame in it, whatever the camera's frame rate; a
  minute with no video is treated exactly like a minute with no data at all, and its sound is not used
  (a bedroom mic hears the whole house). What changes on a night with a stall: lower coverage, more
  unknown minutes and less sleep counted; the timeline shows the stall as "No data"; a cry during the
  stall is no longer shown as a wake-up from the noise alone; if the stall covers bedtime, the reported
  bedtime moves to the first quiet minute after the video came back; a night more than half unwatched is
  "no data". **"No one was in the bed" now needs at least 90% of the window watched** (below that the
  night is "no data"), because that answer also discards the night's timelapse frames; this also applies
  to nights with ordinary gaps in the data. The 90% is a first estimate, not a measured value. Nights
  already stored change only when recomputed, and **Recompute** still never turns a scored night into
  "no data": a night stored before this update whose video stalled for most of it keeps its old numbers.
  That refusal is only reachable through the API (the page offers Recompute only on a night that still
  scores); its 409 now says which reason applied instead of always claiming the data aged out, and adds
  `reason`, `status` and `coverage_minutes`. Known limits (a
  frozen picture still reads as a still room; the live wake watcher and bed-transition rules do not use
  this yet): [KNOWN-ISSUES.md](KNOWN-ISSUES.md), "Minutes with no video are unknown in the sleep numbers".

## [0.34.0] - 2026-09-28

### Added
- **A night's sleep now shows when your child went into bed as well as when they fell asleep, and the
  "Was this right?" screen can record who it really was when you answer "No".** On a night with a
  bedtime story or a slow settle, the sleep card and the night's sleep page now show two times, such
  as "In bed 19:47 · Asleep 20:04". "In bed" is the moment they were put down, and "Asleep" is the
  same time the app has always shown, when the room went quiet. The extra time appears only when
  "In bed" is at least a minute before "Asleep". On other nights, and on any night where you corrected
  the bedtime, the card shows just the one time as before, because the recorded put-down may no longer
  match the time you gave.
  - On the review screen, answering "No" to an event in the full list now offers an optional
    follow-up: **Me or another adult**, **They moved in bed**, or **Someone walking by / nothing**.
    This lets later detection work tell a parent leaving the room apart from a child moving, which a
    plain "No" can't. Changing the answer away from "No" clears the follow-up. The "Quick check-in?"
    and "Still moving?" cards don't ask it, because their own buttons already say what happened, and
    neither does the full list for those same events. "That was me" is saved as "Me or another adult"
    automatically.
  - Events recorded before **16:00** (in the app's timezone) on the night's date are now grouped at
    the top of the full list as **Before bedtime (N)**, collapsed. A button there,
    **None of these were a bedtime event**, marks all of them "No" in one tap. The button works only
    after you have opened the group once, so a real nap in there can't be marked "No" unseen. It skips
    any event you have already answered, and any event with its own "Quick check-in?" or "Still
    moving?" card. You can still change any single answer in the group before saving, for example to
    mark a real nap as "Yes". The 16:00 cutoff is a first guess, not a measured value. A night with no bedtime
    information at all shows the list ungrouped, as before.
- **The server log now says, every 15 minutes, what the motion and sound detectors actually observed.**
  Each camera gets an `[obs]` line per detector: how many samples were genuine new pictures or sound, how
  many were repeats ffmpeg made up while a camera stalled, gaps and restarts in what arrived, and how much
  of the time was covered. Where the evidence cannot tell, for example a timestamp line lost beside a
  run of identical pictures, the sample is counted as `unknown` rather than guessed, and every list the
  measurement keeps has a size limit, so a broken stream cannot grow memory. This is a measurement only
  (issue #373): motion and sound alerts, the sleep timeline and every stored number are unchanged, and
  nothing reads the new information yet. The
  detectors' ffmpeg now prints its own per-frame timestamps, which costs about 30-40 parsed and discarded
  log lines a second per camera and 1-2% more ffmpeg CPU. ffmpeg errors are logged exactly as before,
  except that a burst of identical errors is collapsed into one line with a repeat count, and a flood of
  unrecognised output is capped with a one-line summary. Every field is explained in
  [KNOWN-ISSUES.md](KNOWN-ISSUES.md) under "The `[obs]` line".

## [0.33.2] - 2026-09-25

### Changed
- **Library updates.** The Compatibility video player's streaming library (hls.js) is now 1.7.3, the
  ONVIF camera library (used for camera-reported motion and pan/tilt) is now 0.8.3, and the icon set
  (lucide-react) is now 1.47.0. The only visible difference is a slightly redrawn door icon next to
  "Room activity" and "Movement-only estimate" on a night's sleep page.

### Security
- **The MQTT library is updated to fix six advisories in which a malicious or misbehaving MQTT broker
  could crash the app using it or break its connection.** Nightlight uses MQTT for room temperature
  and humidity sensors and for motion reported by the camera itself. The library (mqtt.js) is now
  5.16.0, up from 5.15.2. In the older versions, the broker, or anyone able to tamper with the
  unencrypted `mqtt://` connection to it, could send replies that crash the process, disable the MQTT
  connection for good, confuse it about which topics it is subscribed to, or make it use ever more
  memory. This only matters if you have MQTT turned on.
  No exploit path against Nightlight itself was demonstrated. Upstream details are in the
  [mqtt.js 5.16.0 release notes](https://github.com/mqttjs/MQTT.js/releases/tag/v5.16.0).

## [0.33.1] - 2026-09-24

### Fixed
- **A streaming server that stopped answering could freeze the camera list for five minutes and pile up
  camera restarts.** Nightlight asks its built-in streaming server (MediaMTX) whether each camera is
  delivering video, and those requests had no time limit of their own. If the server accepted a
  request and never replied, the camera list waited up to five minutes, and the camera watchdog
  started a fresh check every 15 seconds on top of the stuck ones. When the server woke up, the
  pending checks all resumed at once and could restart the same camera several times over. Every
  request now gives up after 5 seconds and counts as "unknown". The camera list answers within those
  5 seconds (a camera whose status didn't come back just shows as not ready), and each camera has at
  most one check pending at a time. A camera whose previous check is still running is skipped, not
  queued. An unknown answer never triggers a restart, a Camera history entry or a rewrite of the
  streaming server's configuration, since those could drop a stream that was fine. The camera-offline
  notification still counts that time, so a stuck streaming server still reaches you if you turned the
  alert on. Up to four cameras are now checked at once instead of one after another, and a camera's
  main stream and its Low-quality sub-stream are checked separately, so a slow restart of one never
  holds up the other. See
  [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what the new `[guard:mediamtx-api]` log line means.
- **Flipping the on-demand recording switch on the Recording settings page could silently discard any
  other unsaved edit on that page.** That switch applies immediately (by design — it's the one control
  on the page that doesn't wait for Save), and refreshing the page's settings afterward was replacing
  the *entire* form with the server's values, wiping out an in-progress edit to the pre-roll,
  retention, or wake-clip fields even though none of them were touched by the toggle. Unsaved edits on
  that page now survive a toggle (and any other settings refresh) until you actually save them
  yourself — including a field that was temporarily hidden by the toggle itself. The switch is also now
  briefly disabled while its own request is in flight, so a second click can't race the first — and
  **Save changes** and the switch now briefly disable *each other* while either request is in flight,
  closing a narrower version of the same race between an overlapping Save and toggle.
- **A camera outage during the night could be silently counted and displayed as sleep.** Sleep
  analysis already tracked, per minute, whether a camera actually recorded anything — but immediately
  discarded that distinction, so a stretch with no data at all (a detector restart, a dead camera) was
  treated exactly like a stretch confirmed quiet. A long enough outage could seed the night's onset
  from inside itself, inflate the reported asleep duration, extend the longest unbroken stretch shown,
  and display as an "asleep" segment on the sleep bar — while the detailed per-minute timeline for the
  same minutes correctly called it a gap, so the two views of one night could visibly disagree. Missing
  minutes are now their own state throughout: they can't start or extend a confirmed-quiet run, don't
  count toward the reported asleep time, and show as a distinct "no data" segment (striped, so it can't
  be mistaken for the existing before/after-sleep shading) matching the detailed timeline, with a
  legend entry on any night that has one. A scattered handful of missed minutes — a merely flaky
  connection rather than an outage — no longer blocks bedtime detection either: only a long, confirmed
  gap can, never a single missed sample. Internally, a new `unknown_minutes` figure (alongside the
  existing asleep/awake counts) records how many minutes of the night simply weren't observed and is
  stored with the rest of a night's numbers — not yet shown as its own figure anywhere, but needed so
  that manually correcting a night's onset or wake time can't silently re-count an outage as sleep by
  recomputing the duration from scratch.
- **An unrelated detection edit could silently narrow an all-day alert schedule to 20:00–07:00.**
  The detection-settings screen showed a suggested overnight window for a camera whose schedule was
  stored as all-day (equal start/end), but that suggestion was being treated as the real value on
  every subsequent save — so changing sound sensitivity or a motion setting, with the schedule
  screen never opened, would quietly stop daytime alerts. The suggestion is now display-only until
  the user actually acts on it — editing a time field, or turning "Only alert during set hours" on
  for a camera that never had a real window — rather than being adopted silently by an unrelated
  save. Also fixed: `PUT /api/cameras/:id/detection` no longer forces motion detection off when a
  request omits `motion_enabled` — every other field on this route already preserved an omitted
  value, and this was the one exception.
- **Starting an on-demand recording on a camera while a previous one was still being saved could lose
  the beginning of either recording.** This happens whenever two overlapping recordings occur on the
  same camera — another device starting one, or pressing Record again right after Stop, while the
  first is still being written to a video. Each on-demand recording now protects its own footage until
  its video is saved, instead of sharing one protection slot that the newer recording could silently
  shorten or the older one could clear out from under it.
- **Editing recording settings could destroy footage that was actively being captured.** Changing the
  clip pre/post-roll, or switching on-demand recording or wake clips on or off, stopped and restarted
  buffering on every recording-enabled camera — which deleted the camera's whole rolling buffer and
  dropped every in-progress protection on it. That could wipe out a recording in progress, a wake-clip
  capture, or a detection clip mid-extraction, usually without anyone being told: the recording was
  later saved as far too short, or as failed. A settings change now resizes each camera's buffer in
  place instead of restarting it, and if a camera no longer needs to buffer at all, stopping it is
  delayed until nothing is still capturing from it. Also fixed: an on-demand recording could report the
  wrong length if its pre-roll setting was changed while it was still running — a recording now always
  reports the length it actually captured, not whatever the setting happens to be when it's stopped.
- **The sole administrator could change their own account to caregiver, leaving an install with no one
  who could manage accounts or settings and no way back in** — first-run setup only runs once, before
  any account exists. Changing the last admin to caregiver, or removing the last admin, is now refused
  with a clear message; the Caregivers screen also explains this up front on the only admin's account,
  before a request is even sent. Installs that already lost their last admin this way have a new
  console recovery command — see [docs/mfa.md](docs/mfa.md)'s Recovery section.
- **A detection setting (motion, sound or the alert schedule) could be silently lost, shown as saved
  when it wasn't, or overwritten by a slower earlier save landing after a faster later one.** The
  screen's autosave had no lifecycle of its own: tapping Back right after a change cancelled the save
  outright, a save that failed reset to the same "nothing to see" status as one that hadn't started,
  and nothing stopped two writes for the same camera being in flight at once. Saving is now a queue
  that outlives the screen — a change you make and immediately navigate away from still saves, a
  failure shows a persistent **Not saved** with a **Retry** (also surfaced on the camera's own
  settings page if you've already gone Back), and at most one save per camera is ever in flight, so
  the most recent change always wins regardless of network timing. The camera tile's quick motion/
  sound/schedule toggles go through the same queue, so a toggle there and an edit on the settings
  screen for the same camera can no longer race each other. Each save now sends only the field(s)
  that changed, rather than the whole detection form, which is also what makes a toggle and an edit
  safe to interleave.

### Security
- Updated backend dependencies for #455: Express 4.22.3 resolves to `qs` 6.16.0; Firebase Admin
  14.5.0 and a scoped gaxios 6 override remove every `uuid` below 11.1.1 from the lockfile.
  No exploit path was demonstrated. The E2E stack now uses Playwright 1.63.0, and Dependabot
  watches its manifest; a test requires the browser image tag to match its package pin.

## [0.33.0] - 2026-09-22

### Added
- The public demo now signs visitors into one fixed read-only admin guest automatically (with password
  login structurally disabled), applies its active-guest cap when admitting new guest sessions, limits
  per-IP traffic, and reports its deadline, readiness, capacity and optional lobby URL through
  `/api/auth/status`. Idle sessions stop counting after two minutes but remain valid and count again
  when used, so the admission cap can be briefly exceeded. It keeps looped camera motion out of seeded
  sleep history, including sessions that cross a sleep-window boundary, and shows a persistent
  countdown with clear read-only feedback, a configurable **start again** link, and a retry after a
  failed automatic sign-in. This is only for hosting a public demo and does nothing on a normal
  install; the settings, seed script and readiness contract are documented in
  [docs/demo-mode.md](docs/demo-mode.md).

## [0.32.0] - 2026-09-21

### Added
- A `DEMO_MODE` environment flag for the backend: when set, every write action except logging
  in and out is blocked (including one GET-triggered write and the talk-back WebSocket), and
  the raw log viewer, diagnostics bundle, and session lists are hidden — the backend half of
  the public read-only demo instance.

### Changed
- Nightlight is now on the Unraid Community Applications store — the README's "Running on Unraid"
  section leads with searching the Apps tab instead of the manual template-install steps, which are
  now offered as an alternative rather than the only path.

### Security
- **A caregiver's phone can no longer change the address that Pushover, ntfy and Gotify alert links
  open.** That address is one shared setting for the whole household, so it is now learned only from
  an administrator's Android phone, and only if it is a plain `http://` or `https://` address (an
  optional port is fine; a path, a query, a login or another kind of link is ignored).
  Caregivers' phones still receive alerts exactly as before, and each phone's own Firebase alert still
  opens the address that phone uses. If those links ever opened the wrong address and you use the
  Android app's notifications, open the app on an administrator's phone with notifications on and it
  is replaced automatically; installs without the Android app's notifications never learn an address,
  as before. See "Where tapping an alert opens" in `docs/notifications.md`.
- **An extra field in the request could reset the guess limit protecting a single account's two-factor
  code, and a signed-in user's own password and MFA-disable changes.** Adding or changing that field
  can no longer open a fresh limit. The broader per-source limit was never affected.
- **Camera viewing access can no longer be used to take over another camera's live feed.** The
  endpoint a signed-in caregiver's browser uses to watch a camera accepted a wider range of
  requests than viewing actually needs — including ones that could interrupt or replace the video
  another caregiver was already watching. It's now restricted to exactly the requests real
  viewing requires; nothing else gets through.
- **Signing a device out, an admin ending a specific device's session remotely, or resetting a
  password now also stops that device from receiving further push notifications and snapshot
  links** — previously a revoked device could keep receiving them until its session naturally
  expired. (Removing a caregiver's account entirely already stopped this, since 0.31.0.) Devices
  already registered before this update will receive push notifications again automatically the
  next time their app is opened while signed in.
- **Revoking a session — signing a device out remotely, or removing a caregiver's account — now
  also closes any camera view that device already had open**, within a few seconds. Previously an
  already-open view kept playing until the tab or app was closed by hand.
- **A child's nightly timelapse could still include images from a camera you'd disabled.** Camera
  selection for the nightly timelapse now only considers cameras that are actually enabled, and
  re-checks that right before saving each image — disabling a camera, reassigning it to a
  different child, or deleting it mid-capture can no longer produce a stray frame.
- **Camera credentials are now scrubbed from raw FFmpeg and MediaMTX output before it reaches
  container logs, the in-app log viewer, or a diagnostics bundle.** URL passwords and query values
  are redacted, and exported camera paths omit query strings and fragments. If you shared logs from
  an older version and they included a credential-bearing camera URL, rotate that camera credential.

## [0.31.0] - 2026-09-19

### Added
- The morning review now also asks about an out-of-bed event where the bed also showed movement in
  several separate minutes with no return logged ("Still moving?"), separately from the collapsed full
  list — never duplicating the existing quick check-in prompt when both apply to the same event.
- A `SECURITY.md` security policy (supported versions, private reporting via GitHub Security
  Advisories, safe diagnostic-bundle handling, and credential-rotation steps), a bug-report issue
  template, and a link to report privately from the diagnostics bundle and camera report screens
  when a redacted file still contains something sensitive.
- The morning review now asks about a bed entry immediately followed by an exit ("Got into bed at
  7:51pm, then got out of bed again 14s later — what actually happened?"), separately from the
  collapsed full event list — measurement points to this being mostly a parent's presence read as a
  child's exit, and the question was previously easy to miss inside a long list of events.
- A bed-transition snapshot in the morning review ("Quick check-in?" and "Check the recorded events")
  can now be tapped to open it full-size in a pop-up, the same way a recorded clip opens — some frames
  are too small or too dim to judge at thumbnail size, and the verdicts recorded there are only as
  good as whether the photo could actually be read.
- A diagnostic `[coactive]` log line, purely observational: fires when a camera's bed-zone and
  outside-zone motion channels are both active in the same frame, a shape today's exit/entry detector
  can't classify at all (see `planning/reviews/simultaneous-activity-gap-plan-2026-09-18.md`). Never
  writes to `bed_transitions` and never changes any reported sleep number — exists only to gather real
  data for a future fix.
- A sleep report notification is now followed up once, and only once, if the wake time was unknown
  when the report first went out and a later recompute (within about 3 hours of the window closing)
  works it out — the correction replaces the original in the notification tray rather than arriving as
  a second, contradictory message. Does not re-notify for a wake time that shifts after already being
  reported, and does not follow up at all if the wake time never resolves in that window.

### Changed
- Three diagnostic sound statistics (p75, p90 and standard deviation) are now recorded per minute — instrumentation only, with no change to any reported sleep number.
- The still frame shown for each recorded bed-transition event (in "Quick check-in?" and "Check the
  recorded events") is bigger — 160×120 (120×90 on narrow phones), up from 96×72 — easier to actually
  make out what's in it.
- Bed transitions now record additional outside-motion evidence (peak and how long it lasted) alongside
  each recorded exit or entry, for future tuning of the detector — nothing reads these values yet, and
  no detection behavior changes.
- The detector now logs when a recorded bed exit or entry contradicts what it already believed about
  occupancy (e.g. a second "out of bed" with no "into bed" in between) — diagnostic only, for future
  tuning; every transition is still recorded exactly as before.
- The detector now logs when the bed becomes active with no bed-entry link found (the same case the
  exit side has always logged for a bed becoming active with no exit link) — diagnostic only, no
  detection behavior changes.
- Added a query to find a bed entry immediately followed by an exit on the same camera (a shape that
  measurement points to being mostly a parent's presence, not a child getting straight back up) — not
  called from anywhere yet; groundwork for reviewing or scoring against it later.
- Added a query to find sustained (4+ distinct minutes) bed-zone motion after an out_of_bed while the
  classifier still believes the bed is empty (no bed entry recorded on the same camera before the
  motion starts) — generalizes the bed-entry-immediately-followed-by-an-exit check above from that
  one narrow shape to every recorded bed exit still within activity_samples' retention window. Not
  called from anywhere yet; same groundwork purpose as the query above, now applied to the full
  population instead of just quick reversals.

### Fixed
- **The admin "Recompute this night" control could report success while saving nothing.** If a night
  already had a wake time a parent was notified about, and the recompute would have cleared it back to
  unknown, the write was correctly refused — but the API still returned success, so the dialog closed
  and the sleep detail page repainted with numbers that were never actually stored. Now returns the same
  kind of readable error the existing "data has aged out" refusal already uses, and nothing changes on
  screen until something actually changed in the database.
- **A real out-of-bed episode could report zero wake-ups.** Wake-count only ever read per-minute
  activity, so a child who climbed out, was put back, and lay still afterward was structurally
  incapable of reaching the five-active-minute threshold — a real, alerted departure and return
  reported "0 wakes, 0 awake minutes." A short exit-and-return (1-20 minutes) now counts as an
  awakening when the recorded transitions corroborate it and the bed is confirmed quiet in between,
  independent of the activity threshold. This can extend or merge existing wake runs (awake time can
  increase while the wake count doesn't, or two runs can merge into one). Known limits: it cannot
  tell an adult's visit to the bed from the child's own trip out of it, and a spurious reading can
  still suppress or shorten a real episode — both are the same kind of limit this classifier already
  has elsewhere. `USE_TRANSITION_WAKE_EPISODES` in `sleepAnalysis.js` reverts it independently of
  `USE_TRANSITION_TIMES`.
- **Wake clips can be turned on without ever producing one.** "Record wake-ups without alerting" only
  ever started buffering if detection clips or on-demand recording were also on for that camera — so a
  household that wanted silent wake clips *and nothing else* got a setting that looked accepted and
  produced nothing, every night, with no error anywhere. The recording page's three sections are
  presented as independent choices; now they are. Turning wake clips on or off — per child's sleep
  tracking, the global switch in Settings → Recording, or assigning/unassigning a camera to a child —
  arms or disarms the buffer immediately.
- **A camera unassigned from a child, or a child deleted, could leave its recording buffer running
  forever.** The periodic reconciliation that keeps every camera's buffer in sync only ever started one
  that should be running; nothing had ever told it to stop one that shouldn't be. Wake clips made this
  reachable for the first time — a camera's buffer can now stop being wanted at a moment nothing else
  catches — so unassigning a camera, or deleting the child it was assigned to, could leave an ffmpeg
  process quietly running (and its clip buffer quietly using disk) with no way back short of an unrelated
  settings change or a restart. Both the immediate case (unassigning/deleting) and the general safety net
  (the periodic check now stops a buffer that's no longer wanted, not just starts one that is) are fixed.
- **Bedtime reported a minute late on roughly half of all nights.** A bed transition recorded at, say,
  19:38:31 was rounded up to 19:39 instead of being read as the 19:38 event it actually was — every
  *other* minute-index calculation in the app already floors a real-second timestamp; this one place
  rounded instead. The error only ever pushed the time later, never earlier, so onset was late (and the
  night's total sleep a minute short) on nights where the transition happened to land in the second half
  of a minute — roughly half of them.
- **A morning sleep report could stay wrong forever if it was generated too soon.** The report is
  written as soon as a child's tracking window closes, but confirming exactly when they got up can take
  a couple of hours of real, quiet time to be sure of — and the very first report used to freeze
  permanently at whatever partial answer was available in that first minute, even once the true
  wake-up time became obvious from later, quieter data. Wake time and total sleep now keep updating for
  a few hours after the window closes and settle for good only once there has been enough real time to
  be certain; whether the bed was slept in at all is decided immediately and never changes retroactively
  — only the wake time and duration can still refine.
- **A motion or sound alert at the exact moment your child woke up for the day had nowhere to appear.**
  The Wake-ups list only ever held the awakenings that happened *during* the night — the final wake, the
  one that ends it, was reported only as a time in the summary line above, with no row of its own for an
  alert to attach to. For a child whose waking is itself a morning event rather than a mid-night stir,
  this could mean the busiest, most alert-worthy moment of the night was the one thing missing from the
  list. The morning wake now gets its own row alongside the others.

### Security
- **A talk-back call now ends promptly if your access is removed while it's open.** Two-way audio only
  ever checked who you were at the moment the call connected — after that, an already-open call kept
  forwarding your voice to the camera's room regardless of what happened to your account afterward. A
  call now re-checks that access every 15 seconds for as long as it stays open, so signing someone out,
  removing them as a caregiver, or a call simply running past its normal time limit now ends the call
  itself, not just what a *new* call would be allowed to do.
- **Removing a caregiver now also removes their push notifications.** Deleting an account only ever
  removed the account itself — the device's notification subscription kept receiving alerts
  indefinitely, including the camera-snapshot images sent with image notifications. Deleting a
  caregiver now removes their subscription too, notifications are filtered against active accounts as
  a second layer of protection, and any subscription orphaned by this before today is cleaned up
  automatically on the next update.

## [0.30.1] - 2026-09-10

### Fixed
- **A stir in the night is no longer mistaken for the morning.** If a child shifted enough to register
  as getting out of bed and was back down a minute later, and then slept very still, the bed looked
  empty and the night was reported as ending there — sometimes two and a half hours early. Getting back
  into bed now cancels the exit, which is what it always meant. Measured over ten nights of recorded
  ground truth: the wake time is right within five minutes on 15 nights out of 20, up from 12, and the
  average error is less than half what it was.
- **...and neither is the second half of that same stir.** The fix above cancelled the exit, but a
  *got out of bed* logged again within a minute of the child climbing back in was still treated as a
  fresh departure — so a night could still end at the stir, three minutes later than before. The night
  of 2026-09-09 was reported as a child up for the day at **8:41pm** with 1h15m of sleep (**8:44pm**
  and 1h18m once the fix above landed), when he had simply got out and climbed straight back into bed.
  A *got out of bed* within a minute of getting in is now read as the tail of that one movement, and
  that night reads **9h51m**. Scored across 44 child-nights of recorded ground truth (every reviewed
  night, on both installations): 311 minutes of wake error removed, 82 added.
  **Known limit:** a real departure less than a minute after getting into bed is read the same way,
  because the two look identical in what the cameras record. Where it is the only *got out of bed* of
  the night it is still used — a night is never left with no wake time at all — but where a later one
  exists, the later one is reported instead.
- **Saving a night's correction now returns you to that night, and confirms it there.** Correcting a
  run of older nights meant going back into Sleep and re-picking the date after every save. You now
  land on the night you just corrected, with the same *"Thanks — that's recorded"* receipt reading your
  times back, so the next night is one tap away.
- **Hardened wake-clip capture against a full or busy disk.** The capture is meant to swallow its own
  failures — it runs on a timer behind the wake detector — but a failure in the few steps before the
  recording started could escape that. **Nothing was affected in practice**, because the one thing
  that calls it already guarded against this; the risk was to whatever called it next. A wake clip
  that fails partway through is now also marked failed rather than left showing as in progress.

### Security
- **The camera report no longer contains your camera's password.** When a camera failed to connect,
  the diagnostic report offered on the **Add camera** screen embedded the RTSP password inside
  FFmpeg's error text — while the app told you the file contained no password and pre-filled a
  GitHub issue saying so on your behalf. Passwords are now replaced with `***` everywhere in the
  report, and the wording no longer promises more than it delivers. If you have already attached a
  camera report to a public issue, treat that camera's password as disclosed and change it.
  (GHSA-wcgj-6p3c-vr9h)
- **Passwords are now stripped from the server log too, and so from the support bundle.** If you
  pasted a full `rtsp://user:password@camera/path` address into the camera form — which is a natural
  thing to do when a camera won't connect — that password was written to the log, and the support
  bundle republishes recent log lines while telling you it contains no passwords. Log lines are now
  redacted as they are written, whatever produced them. If you have already shared a support bundle
  taken after entering a camera address that way, change that camera's password.

## [0.30.0] - 2026-09-09

### Added
- **Tell Nightlight when it got a night wrong.** The morning after, a child's page asks **Was last night
  right?** — confirm the sleep and wake times with one tap, or correct them; and mark each recorded *got
  into / out of bed* event right, wrong or "can't tell" against the still frame it was decided from.
  - **Point at the picture instead of typing a time.** Each recorded event offers **Put down here**
    / **Up for the day here** — tap the frame showing the real moment and the time comes from it,
    exact to the second. Which frame you picked is remembered, not just the time it produced.
    This is deliberately separate from marking an event *correct*: an exit can be real and still
    not be the end of the night.
  - **Your times become the ones shown.** Once you correct a night, the child's card, the sleep history
    and the detail page all show *your* times, marked **You corrected this**, with total sleep
    recalculated to match. This is different from **Recompute this night**, which re-runs the detector:
    correcting records what *you* know, recomputing re-asks the *app*.
  - **The detector's own answer is kept underneath, not overwritten** — it is what a future improvement
    gets scored against. Nothing you enter changes how sleep is detected.
  - **Confirming that a night was right matters as much as correcting one**, and the two are separate
    buttons on purpose: times Nightlight guessed are never one stray tap from being recorded as fact.
  - The prompt shows once per night and becomes a short receipt once answered, which you can tap to
    change your mind. Dismissing it stops it coming back for that night.
  - **The card is always about last night** — it asks if you haven't answered, shows what you said if
    you have, and stays quiet if you dismissed it. **Any other night is reviewed from the sleep
    detail page**, which has **Was this night right?** for whichever night you are looking at — that
    is also how you change a night you already answered.
  - **Recompute says when it won't help.** On a night you have corrected, the times shown are yours,
    so recomputing re-runs the detector underneath without changing what you see — the sleep detail
    page now says so rather than leaving the button looking broken.
  - **The event list stays out of the way** until you ask for it — a night carries twenty to thirty-five
    recorded in-and-out-of-bed events, and the two times are the point.
  - Reviews are kept forever, and an event you have judged keeps its frame past the usual 45 days.
  - See **README → Sleep tracking**.

- **The alert schedule is documented** — its default, that the window is shared by motion and sound,
  that overnight windows work, and that it uses the app timezone (which is **UTC** until you set it).
  With the contrast that catches people out: it silences *alerts* only — **sleep tracking keeps
  recording through the quiet hours**, unlike turning a detector off. Also documents Pushover's
  **Device** field (where a blank value *clears* rather than keeps) and Gotify's **Priority** default.

- **Camera detection settings are documented** — motion and sound sensitivity, confirm and
  cooldown, each with its default and its range, plus what sound sensitivity means in dB over a
  room’s own ambient level. Includes a **known limitation**: a constant noise source such as a
  white-noise machine or fan can, at certain sensitivity settings, be counted as continuous noise
  and inflate the reported awake time — with how to recognise it in the log and what to do about
  it. Sleep and wake *times* are unaffected; only the awake/asleep totals are.

### Changed

- Dependency maintenance: **express-rate-limit 8.6.2 → 8.7.0**, **lucide-react 1.33.0 → 1.37.0**,
  **react-router-dom 7.18.2 → 7.18.3**, and the build/test tooling **@vitejs/plugin-react 6.0.5 → 6.1.1**
  and **@testing-library/react 16.3.2 → 16.3.3**. No behaviour change: none of the icons Nightlight uses
  were among those redrawn in lucide 1.37, and nothing here alters a setting, a screen or an API.

### Fixed

- **A camera whose video process failed to start could take the whole app down with it.** If starting
  FFmpeg or MediaMTX failed — a broken install, a missing codec binary, a bad moment during a restart —
  and Nightlight then stopped that camera within the next few milliseconds, it would signal *every*
  process it owns instead of the one that failed, shutting itself and all streaming down. Recovery was
  a container restart, and the trigger was timing, so it looked like the app crashing at random. Most
  likely during shutdown, during a camera edit, or on an install where recording was never going to
  work in the first place. Fixes #297.

- **Shutdown also stops the wake watcher now.** Like the sampler below, it had a stop that nothing
  called. No day-to-day change.

- **One more background job now stops on shutdown: the timelapse frame sampler.** It was missed by the
  sweep below because that sweep looked for the standard timer call and this job uses Nightlight's own
  wrapper around it, so the check skipped the file entirely. The check now knows about the wrapper.
  Nothing changes in day-to-day use — the sampler could not hold the app open, but shutdown is now
  explicit about it rather than relying on the process being killed.

- **The test suite could not tell working recording code from broken recording code.** Deliberately
  breaking the clip-retention sweep — the job that stops recordings filling the disk — left every test
  passing, as did removing the guard that stops a stored path reaching outside the recordings folder,
  and several of the rules that decide when a wake is a wake. None of that was a bug in Nightlight; it
  was a gap in what the tests could detect, so a real fault in any of it would have shipped unnoticed.
  Recording, clip storage, the ring buffer and the recordings API are now covered, four tests that
  could never have failed were rewritten, and the checks are re-run automatically against deliberately
  broken copies of the code to prove they still catch it. No behaviour change.

- **Shutdown now stops every background job, not just some of them.** The nightly sleep computation,
  the temperature/humidity sampler and the recording-retention sweep each started a repeating timer
  that nothing could switch off, so shutdown relied on the process being killed to take them down.
  They now stop explicitly, alongside the detectors. Nothing changes in day-to-day use — this closes
  the gap that caused the test-suite problem below, so it cannot come back through another job.

- **The activity tracker started two timers that nothing could stop.** `node --test` could therefore
  never exit on its own, and the whole suite ran under `--test-force-exit` to compensate. Shutdown had
  the same gap — it stops every detector and transcoder but never these timers, and only the hard
  `process.exit(0)` on the next line hid it. The tracker now has a matching stop, which shutdown calls,
  and the flag is gone. No change to how Nightlight itself behaves.
  - ⚠️ An earlier version of this entry also credited that change with fixing the intermittently red
    CI runs. **That was wrong**, and is corrected here rather than quietly dropped: those runs were
    the GitHub-hosted runner being killed mid-job, which still happens and is tracked in issue #278.
    CI now tells the two apart — a run whose log carries the runner's shutdown marker *and* reports no
    failing test anywhere is retried automatically once and labelled as an infrastructure failure. A run
    reporting **any** failing test is left alone, as is one whose logs cannot be read or whose summary
    is missing: it only retries what it can positively show was not a test failure.

- **Deleting a child left its recordings and timelapses on disk forever.** Their database rows kept
  pointing at a child that no longer existed, so nothing listed them and nothing ever cleaned them up —
  up to 30 timelapse videos per child, plus every manual recording. Manual recordings are the worse
  half: they have **no automatic retention by design**, so deleting the child removed the only way left
  to reclaim that space. ⚠️ **Deleting a child now deletes its recordings and timelapses too**, files
  included — **and their wake clips too**, which live alongside recordings. That is a deliberate choice
  — the alternative was keeping them in a "no child" bucket — so if you want to keep a child's videos,
  save them before removing the child. Frames already collected for tonight's not-yet-finished
  timelapse go as well. Alert clips are unaffected: those hang off the camera, not the child, and are
  swept by the normal retention rules. See [docs/recording.md](docs/recording.md).
  ⚠️ **Deleting a child is now admin-only**, like deleting a camera or a user. It was previously
  available to any signed-in account, which mattered much less when it only unassigned a camera.

- **A notification server that stopped answering could hang the Test button for five minutes.**
  Nightlight now gives any provider — Pushover, ntfy or Gotify — **10 seconds** to accept a message,
  then gives up and says so. The case that bites is a self-hosted ntfy or Gotify that accepts the
  connection and never replies, which is exactly how a half-up server fails; previously there was no
  limit at all beyond a five-minute network default, so **Send test** simply spun with no feedback.
  Real alerts were never blocked by this — they're sent in the background — but each stuck one held
  its snapshot image in memory for those five minutes, so a camera flapping during a network problem
  could pile them up. An alert that can't be delivered in ten seconds is now dropped with a line in
  the log: this is a doorbell, not a mail server, and a motion alert that arrives minutes late is
  worse than none. See [docs/notifications.md](docs/notifications.md).

- **Pressing Record during a wake could destroy the wake clip.** Automatic wake clips and manual
  recordings both protect the recent buffer from being cleaned up, but they shared a single slot with
  no notion of who had claimed it. So a parent watching a wake on their phone and pressing Record
  replaced the wake clip's protection, and when that manual recording finished it released protection
  the wake clip still needed — losing its opening, or the clip entirely. Exactly the moment the
  feature exists to capture. Each now holds its own claim, and the buffer is kept back as far as the
  earliest of them needs.

- **A recording in progress when Nightlight restarted was lost, and never appeared or explained
  itself.** A clip is assembled from the buffer after you press stop, and shutdown did not wait for
  that step — so a restart during it lost the recording, and left it stuck half-finished forever.
  Because the list showed finished recordings only, it simply never appeared.
  - Shutdown now waits up to **6 seconds** for an in-flight recording to finish. A long recording can
    still be cut short — that is a fixed, bounded wait, not a promise, and **allowing your container
    longer to stop does not extend it**.
  - **Nightlight now tells Docker it needs those seconds**, in every supplied way of creating the
    container: the Compose file, the Unraid template, and the `docker run` examples. Without that,
    Docker decides how long to wait and recent versions no longer promise the familiar 10 seconds —
    measured as low as 4, which is short enough to lose the recording anyway. ⚠️ **An existing
    install does not pick this up on its own**: add `--stop-timeout 30` to your `docker run`,
    `stop_grace_period: 30s` under the service in Compose, or `--stop-timeout 30` to the Unraid
    template's **Extra Parameters** field. Nothing else misbehaves without it. See
    [README → Quick start](README.md#quick-start).
  - Any recording left unfinished by a restart, a crash or a power cut is now marked failed on the
    next start rather than sitting in limbo — whether it was still capturing or already being
    assembled.
  - **And a recording that couldn't be saved now says so, instead of never appearing.** However a
    recording fails — an offline camera with nothing in its buffer, a clip that couldn't be assembled,
    or a restart part-way — it shows in the **Recordings** card as *Couldn't be saved*. Tap it for what
    happened and to remove it. Previously the list showed finished recordings only, so a failure was
    silent and indistinguishable from the Record button having been ignored. There is nothing to play,
    so these have no thumbnail and no play button, and unlike alert or wake clips they are not tidied
    up for you — recordings have no automatic retention, so a failed one stays until you remove it.
    See [docs/recording.md](docs/recording.md).

- **A background check that failed could shut Nightlight down.** The 15-second camera watchdog, the
  30-second audio check, the 5-minute reconcile and the timelapse sampler each ran unprotected, so an
  error inside one of them exited the whole app — an outage on a monitor that is normally left
  unattended overnight. The two ways it could happen: the low-resolution stream failing to register
  with the streaming server while that server is restarting, and the database being momentarily locked
  when a check reads its camera list.
  - A failure in one of those jobs is now written to the log as `[guard:…] background task failed
    (continuing)` and skipped; the job runs again on its next tick.
  - A failure while checking one camera no longer skips the cameras after it in the same pass.
  - A repeating failure is now reported once a minute rather than every tick, so it cannot scroll the
    rest of the log out of view.
  - Once running, Nightlight survives unexpected errors elsewhere rather than exiting — but a failure
    while it is still *starting* now exits properly, so your container restarts instead of sitting
    there looking healthy with nothing serving. See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what these
    log lines mean and when to worry about them.

- **A missing video component could crash Nightlight instead of disabling one camera.** Nightlight runs
  a helper program (FFmpeg) per camera, and the streaming server (MediaMTX) alongside it. If one of
  those could not be started at all — missing from the image after a bad update, wrong permissions, or
  the system briefly out of file handles — the failure was unhandled and took the whole app down rather
  than affecting one camera. It then happened again on every restart, so the app looked broken with
  nothing explaining why.
  - Each of those launches now reports the real reason in the log ("could not start ffmpeg: ENOENT")
    and carries on. A camera whose helper could not start is shown as not running and is retried by the
    regular five-minute check; the rest of the app, including your other cameras, keeps working.
  - Event recording recovers too. A camera whose recording buffer could not start is now correctly
    reported as not recording, so the five-minute check restarts it — previously it would have been
    treated as healthy forever, and pressing **Record** would have appeared to work and then produced
    no clip.
  - Shutting down while a helper was in the act of failing to start could itself crash the app. Fixed.
  - If MediaMTX itself cannot start, Nightlight keeps retrying (nothing else would bring it back) but
    now says so once and then roughly once a minute, instead of once every three seconds — at that rate
    it filled the whole in-app log within the hour and pushed out the very messages explaining the
    fault.

- **An interrupted update could leave Nightlight unable to start again.** When a new version adds
  fields to the database it applies them in groups, and each change used to be saved on its own. If the
  container was stopped, ran out of memory, or lost power *during* that step — a window of
  milliseconds, on the first start after an update — a group could be left half applied. There was no
  way back from it: depending on which group, Nightlight would either fail to start on every attempt
  afterwards, or start normally and then report a missing field the first time you used that feature.
  Recovering meant editing the database by hand.
  - The whole step is now applied as one unit. A start either brings the database fully up to date or
    leaves it exactly as it was and tries again next time, so an interruption costs you a restart
    rather than the install.
  - **No action needed, and nothing changes on a normal update.** This only affects what happens if a
    start is interrupted at that exact moment.

- **Deleting or turning off a camera could leave it running in the background.** If you removed a
  camera, or switched it off, during the few seconds after its video connection had dropped and before
  Nightlight retried it, the retry went ahead anyway — and then kept retrying every five seconds for as
  long as the container ran. The camera showed as stopped the whole time, so nothing reported it and
  nothing cleaned it up; it simply used CPU in the background, and for a camera assigned to a child it
  also kept writing movement data outside the sleep window.
  - Most likely to bite on a camera that was **already dropping in and out**, which is exactly the one
    you would be turning off. Restarting the container cleared it.
  - Stopping a camera now cancels a pending retry as well as the running connection, in all three
    places that retry: the video stream, motion detection and sound detection.

- **The MQTT settings page could go blank instead of loading.** If the server answered with an empty
  or unreadable body — a proxy that strips it, a truncated response — the page crashed to the
  "Something went wrong" screen rather than simply showing empty fields. It now opens normally and
  you can fill it in.
- **A white-noise machine could make a whole night read as "awake".** Each room's ambient sound level
  is learned continuously, but a noise that started up mid-night and settled between *half* and *all*
  of the alert margin above that level was neither absorbed into it nor tracked by it — so the ambient
  level froze for as long as the source ran, and every minute afterwards was measured against a floor
  from before the noise existed. On one install it held at exactly the same value for **7.9 unbroken
  hours**, marked 66% of the night's minutes as active with no motion at all, and reported a
  seven-hour awake span that never happened — every night, because a machine switched on at bedtime is
  exactly the kind of sudden change that triggered it. A steady noise in that range is now learned
  after five minutes. Sleep and wake *times* were not affected by this; only awake/asleep totals were.
  See **docs/notifications.md → Sound sensitivity also changes sleep tracking** for what this trades
  away and how to read the level line. The old workaround — raising that camera's sound sensitivity to
  90 or above — is no longer needed.
- **A camera's learned ambient level is no longer thrown away when its audio reader restarts.** It was
  re-learned from a single 0.2-second sample, so a restart that happened during a cry set the room's
  "normal" to the cry, and the reader restarts a few seconds after any stream hiccup. It now keeps
  what it has learned across restarts, and a first-time reading is taken from five seconds of audio.
  Time spent off the stream no longer counts as time spent listening either: a restart takes a few
  seconds and can wait up to 45 more for the camera's stream to come back, and that silence used to
  be treated as though the room had been making the same noise throughout — enough, on its own, to
  push a cry that stopped during the outage into the room's "normal" level for about a minute.
- **Two-factor could tell you it was off when it simply couldn't check.** If the account screen failed
  to reach the server, the two-factor card read a confident **Off** — to an account that may well have
  had it on. It now says **Unknown** and explains why, rather than claiming an account is unprotected
  on no evidence.

- **The detection sensitivity sliders had no name a screen reader could read.** The label beside them
  was not attached to the control, so both announced only "slider, 50" with nothing to say what they
  adjusted.
- **Pop-up dialogs were not announced as dialogs.** Every modal in the app — including the ones that
  confirm a deletion or ask for your password — was read by assistive technology as just another part
  of the page behind it. They are now proper dialogs, labelled by their own heading.

- **Gotify settings could silently discard what you typed.** The **Server URL** and **Priority** boxes
  accepted input before the saved config had finished loading, and the arriving config then replaced
  it — your text vanished with nothing on screen to explain why. Both now wait for the load, like the
  other fields on that page always did.
- **The Firebase page went blank-and-dead with no explanation** when it couldn't reach the server to
  ask whether push was set up: every control stayed greyed out and nothing said why. It now shows the
  reason. The controls deliberately stay disabled — with the status unknown, the page will not guess
  and tell you your Firebase files are missing when they may be perfectly fine.

- **The Record button never appeared on a fresh install.** Recording on demand reaches *backward* in
  time, so it needs the camera to already be buffering — and the button hides itself when it isn't.
  Buffering was being started only for cameras that had **detection clips** switched on, which is off
  by default and lives on a different screen, so a newly added camera never buffered and the button
  never showed. Adding a camera didn't start it at all, and a restart took it away again. Every camera
  now buffers whenever **Show a Record button on each camera** is on, as the setting has always
  claimed. (Invisible to anyone who had also turned on detection clips, which armed the buffer for the
  other reason.)
- **Turning a camera back on only restarted its video.** Re-enabling a camera brought the stream back
  but left motion detection, camera-reported (ONVIF) motion, sound detection and clip buffering
  stopped, because each of them checks whether the camera is disabled and was being asked before the
  camera had been marked enabled. They came back on their own within five minutes, when the periodic
  reconcile noticed — but nothing appeared to be wrong in the meantime, so a camera that had just been
  switched on silently missed anything that happened in those minutes.
- **Saving General settings could undo a Recording setting you had just changed.** The General screen
  was still writing back the three on-demand recording settings — the Record button switch, its
  capture-before and its auto-stop — even though those moved to their own **Recording** screen and are
  no longer shown on General. If one of them changed after General was opened (from another device, or
  another tab), saving General silently put the old value back, with nothing shown to either person.
  General now saves only the settings it actually shows.
- **A camera tile could show “NaN°C” instead of a temperature.** A malformed MQTT sensor
  payload parses to `NaN`, which counts as a number, so it was rendered rather than skipped. A
  reading that cannot be read now shows nothing at all, which is what a missing reading looked
  like everywhere else.
- **The “impossible transitions” diagnostic could hide one child entirely.** The report of
  contradictory bed events (the same type twice in a row) was ordered by camera before being
  trimmed to its row limit, so once one camera had filled that limit the other camera’s events
  were dropped wholesale instead of the oldest events being dropped. It is now newest-first
  across all cameras. Detection itself is unchanged — this affected only the diagnostic report.

### Security
- **One person mistyping their password could lock everyone out of signing in.** Behind a reverse
  proxy — the setup the README documents — every remote visitor looked like the *same* client, so all
  of them shared a single allowance of 20 login attempts per 15 minutes. Twenty failures from anywhere
  locked out the whole household for a quarter of an hour, and it made the protection weaker than it
  looked, because an attacker and your family were spending the same budget. Attempts are now counted
  **per account as well as per source**, so a failing login can only ever affect that one account.
  Nothing to configure. If you do run a reverse proxy you can now also set **`TRUST_PROXY`** to its
  address so per-source limits see real visitors — ⚠️ only ever set it to an address you control, as a
  wrong value lets anyone bypass the limit entirely. A value Nightlight can’t make sense of is ignored
  with a warning rather than stopping the app. See the README’s reverse-proxy section.
  **First-run setup no longer spends the login allowance** either, and **the second step of two-factor
  sign-in is limited per account as well** — previously twenty bad attempts from one place could block
  everyone else's 2FA for fifteen minutes.

- **Demoting an admin now takes effect immediately.** Changing someone from admin to caregiver only
  applied the next time they signed in — until then their existing session kept every admin power,
  for up to 30 days, including the ability to make themselves an admin again. Nothing on screen said
  so. Roles are now read fresh on every request, so a change applies to that person’s very next
  action, on every device they are signed in on. They stay signed in as a caregiver rather than being
  logged out. Deleting an account likewise ends its sessions at once.

- **The alert-image password is no longer sent back to the browser.** If your camera's snapshot URL
  carried a username and password, the whole URL — password included — was returned to any signed-in
  admin and sat in the settings page. Every other camera password is already handled the other way:
  stored, never returned, with the field left blank. This one now matches. **You will see the password
  box empty with *(saved)* beside it** — leave it blank to keep what is stored, or type a new one to
  replace it. ⚠️ **Point the URL at a different host and the saved password is dropped**, so one
  camera's credential can never be sent somewhere you have just retyped; you will be asked for it
  again. Nothing to do unless you change a snapshot URL. See
  [docs/notifications.md](docs/notifications.md).

- **Notification credentials were readable without signing in.** The settings endpoint is deliberately
  reachable before you log in, because the login screen needs the app name, colours and font. It
  filtered its response by *excluding* the MQTT broker fields — correct when it was written, but the
  ntfy, Gotify and Pushover integrations later added their own token columns alongside them, and those
  were served to anyone who could reach the app. Affected: the Pushover application token and user key,
  the ntfy access token and password, and the Gotify application token.
  - It now returns an explicit **list of what is allowed out**, rather than a list of what is held
    back, so a credential added in future is private by default instead of public by default.
  - Signing in as an admin returns the extra settings the admin pages need, exactly as before —
    **no setting has moved or disappeared from any screen.** Provider tokens are still shown only on
    their own settings pages, still masked.
  - **If your Nightlight has ever been reachable from outside your home network, rotate those tokens.**
    Instances only reachable on your own LAN were exposed only to devices already on that network.

- **Camera passwords could reach a caregiver account.** Assigning a camera to a child is meant to be
  everyday caregiving, so that action is open to caregivers as well as admins — but it was the one
  camera action that replied with the camera's full database record instead of the filtered version
  every other camera screen uses. That record includes the stream address with the password embedded
  in it, and the ONVIF and two-way-audio logins. On most cameras the ONVIF login is the camera's own
  administrator account, so this reached past Nightlight to the camera itself.
  - It now replies through the same filter as everywhere else. Admins still get what the camera edit
    form needs — the address in separate fields, and whether a stream password is set rather than the
    password itself. **Nothing changes on screen for anyone.** (One exception, unchanged by this and
    the same on every other camera screen: if you put a username and password into the **Snapshot
    URL** field, admins do get that field back verbatim, because the edit box has to show what you
    typed. Caregivers never see it.)
  - **Only relevant if you have caregiver accounts.** If you do, and you would rather not rely on
    those people having ignored it, change the camera's password in the camera's own settings and
    then update it in Nightlight.

## [0.29.0] - 2026-08-30

### Added
- **A still frame is now saved whenever your child gets into or out of bed.** Sleep tracking works this
  out from movement, and it gets it wrong often enough to matter — across 238 recorded transitions, 147
  of them were physically impossible on sequence alone (two “got into bed” in a row, or two “got out of
  bed”, with nothing in between). Until now there was no way to see what the camera was actually
  looking at when it decided. These frames are never shown in the app and never notify you; they are
  kept for 45 days alongside the transitions themselves and deleted with them, and cost roughly 5 MB a
  night. See **docs/recording.md** for where they live and how to remove them.

### Fixed
- **A morning wake could be reported up to an hour late when a parent handled the bed afterwards.**
  Getting up for the day is detected as the bed emptying and staying empty, but a single stray minute of
  movement — an adult reaching in — split that stretch into pieces too short to count, so the real
  departure was never considered and the wake landed on whatever happened next. Observed on 2026-08-29:
  a child up at 06:00 reported as waking at 06:47. Isolated minutes no longer break the stretch, and the
  whole of it is now examined rather than only where it starts.
  A follow-up review found the same rule could also be satisfied by the very last minute of the
  night's data, one minute short of the evidence it needed; that is now closed too.

## [0.28.1] - 2026-08-29

### Fixed
- **"Recompute this night" always said there was nothing to change.** It compared the sleep detail page
  against itself. That page already works the night out fresh every time you open it, so both halves of
  the comparison were the same calculation and could never differ — while the summary on the child's
  page, which is the saved copy and the only thing a recompute can actually change, stayed wrong. It now
  compares against what is saved, which is what it should have done from the start. A night that has
  never been saved offers to record it.

## [0.28.0] - 2026-08-29

### Added
- **"Recompute this night" on the sleep detail page (admins).** A night's summary is worked out once and
  then kept, so when sleep detection improves, an already-recorded night keeps showing the old answer
  while the detail view — which works the night out fresh every time you open it — shows the new one.
  The card and the page then disagree and never catch up. This reconciles them, one night at a time. It
  shows exactly what would change before anything is saved, so you can see the improvement rather than
  take it on trust, and you can cancel. **It can never make a night worse:** the minute-by-minute data is
  kept for 30 days, which is also how far the date picker goes back, so the oldest night you can browse
  is sitting on that edge — if its data has aged out the recompute is refused and the saved summary is
  left exactly as it was.

### Changed
- **Ages now include the months past two years.** A child shown as "3 years" could be anywhere across a
  twelve-month span over which their sleep changes completely; they now read as "3 years 2 months". A
  whole number of years still reads plainly as "3 years", and under two years is unchanged ("18 months").
- **Sleep is now measured from one camera per child, not all of them.** If a child has more than one
  camera, their **main camera** — the first in the order you've arranged them, skipping any turned off —
  is the one the night is worked out from, and the night's detail view names it. Previously every camera
  was combined, and a minute counted as activity if *any* of them saw something, which meant the noisiest
  camera decided the night: one facing a doorway, or with a wider bed zone, would push bedtime later and
  add wake-ups nobody had, with nothing saying which camera was responsible. Secondary cameras are
  unaffected in every other way — they keep streaming, alerting and recording. Room temperature and
  humidity still read every sensor in the room, since those are averaged rather than combined. This also
  fixes a camera you'd **turned off** still contributing its old readings to the analysis.

## [0.27.1] - 2026-08-29

### Fixed
- **The empty-bed bedtime fix from 0.27.0 didn't work on production.** The check asked whether the bed's
  *strongest* movement after a put-down cleared a threshold — and a single flicker, a shadow or the
  camera's night vision adjusting, was enough to clear it on its own. On the night it was written for it
  still reported a bedtime of 16:56 instead of 19:51. It now asks how *often* the bed moved rather than
  how hard: an empty room produces the odd blip, a child in a bed keeps moving. Rechecked against every
  night on both the production and staging databases, this corrects that one night and changes nothing
  else.

## [0.27.0] - 2026-08-29

### Added
- **A wake-up is now recorded, without sending an alert.** More than half of the wake-ups on the sleep
  timeline never raised an alert — over the last 18 nights, 54 of 101 — so there was nothing to look at
  in the morning to explain them. That isn't an alerting fault: an alert deliberately waits for a couple
  of seconds of sustained noise or movement before disturbing anyone, while sleep tracking counts a
  minute the moment it sees a flicker. When a wake-up starts, the app now saves a short clip of it and
  stays quiet — no push, nothing on your phone. Open the night's detail and a wake-up with a clip can be
  expanded to play it. A brief stir is still ignored, and nothing is recorded until your child is
  actually asleep, so settling at bedtime is never captured. Under **Settings → Recording** you can
  turn it off, change the clip length, and set how long the clips are kept (30 seconds and 14 days by
  default); the Storage readout there now shows what they're using.

### Fixed
- **The live "tonight so far" view would have disappeared for an hour after the clocks change.** On the
  night the clocks go forward, the app worked out "yesterday" by subtracting 24 hours — but that night
  is only 23 hours long, so between midnight and 1am it skipped a day entirely and could no longer find
  the night in progress. For that hour the sleep card would have shown nothing at all. It now counts
  days on the calendar instead of by the clock, and the same fix covers the night the clocks go back,
  where a day was counted twice. In Australia this would first have shown up on 5 October 2026.
- **An empty bed could be reported as a very early bedtime.** If the camera briefly mistook something
  for your child being put into bed — on one measured night a stray reading in the late afternoon, undone
  again 23 seconds later — and the room then sat empty until the real bedtime, that empty stretch was
  reported as sleep. One child's bedtime came out as 16:56 when he actually went down at 19:51, nearly
  three hours early, and the evening was credited with wake-ups nobody had. An empty room defeated every
  check at once, because an empty room is quiet, never wakes, and is still being watched. Sleep tracking
  now asks for positive evidence instead: after a put-down the bed has to go on showing signs of being
  occupied, because a sleeping child is never perfectly still for hours while an empty bed is. Replayed
  over every night on record, this changed that one night and nothing else.
- **Bedtime was reported late on a noisy evening.** Sleep tracking already knew to ignore household
  noise when nothing was moving in your child's room — a sibling being settled next door, a TV — but
  only for a child who was asleep *before* their bedtime setting. For every ordinary bedtime, where
  they go down after the window opens, the rule never ran and the reported bedtime waited for the house
  to fall quiet. On one measured night that put one child's bedtime 39 minutes late and the other's 15
  minutes late; both now land within a few minutes of when they actually went down. The bedtime you see
  is the put-down the camera saw and the settle that followed it, wherever it falls relative to the
  setting.
- **Noise in the house just after bedtime was counted as your child's first wake-up.** With bedtimes
  now landing correctly, the same noise that used to delay bedtime instead reappeared moments later as
  an awakening — one child was shown waking for 10 minutes having not stirred once. For the first half
  hour after your child falls asleep, a noisy minute only counts if their room also moved. After that,
  and for the rest of the night, a cry with no movement counts as a wake-up as before.
- **A child who climbed out of bed by themselves wasn't detected.** "Got out of bed" was only
  recognised when the movement in the bed and the movement beside it were near-simultaneous — which is
  what an adult lifting a child out looks like. A child getting out unaided shakes the bed, stands
  still for a few seconds, and only then moves across the room, and nothing in between joined the two
  up. The result was worse than a missing marker: with no departure to confirm it, the morning wake-up
  was reported hours late (one measured night, up at 5:52am, reported as 7:14am). A slower, larger
  movement away from the bed now counts, while faint ones still don't.
- **Faint changes outside the bed were reported as movement in the room.** A shadow or the camera's
  night-vision adjusting could read as someone beside the bed, so nights where nobody entered the room
  still listed several visits. The threshold for the area outside the bed is now set well clear of
  those readings and comfortably below a real one.
- **The "got into bed" marker could point at the wrong moment, or be missing entirely.** On a night
  with several attempts at settling, it landed on the last re-settle rather than when bedtime began;
  it now marks the start of that settling. Separately, on a night where the bedtime put-down wasn't
  recognised at all, a re-settle in the small hours could be adopted as the night's bedtime and shorten
  the reported sleep by hours — a put-down long after the room went quiet is no longer treated as the
  one that started the night.

## [0.26.1] - 2026-08-27

### Fixed
- **A night could be reported as "slept 0 minutes" when a parent left the room at bedtime.** With your
  child's real bedtime now detected (0.26.0), the search for the morning "got out of bed" could latch
  onto the parent walking away from the bed moments *before* the child fell asleep, and report that as
  the morning wake-up — so one night came back as waking at 7:20pm having slept nothing at all. A
  departure that happens before your child fell asleep is no longer treated as one. Only nights on a
  camera that sees very little movement in the bed were affected, and only from 0.26.0.

## [0.26.0] - 2026-08-27

### Added
- **Nights when nobody slept in the bed are now reported as exactly that.** Previously an empty bed
  produced a flawless night's sleep — one night with a child away was reported as 11 hours 6 minutes
  asleep with no wake-ups, because an empty room is quiet and quiet is what the app reads as sleep.
  Such a night now says **"No one in the bed"**, which is deliberately a different message from "no
  data": the cameras were watching all night, there simply wasn't anyone there. The nightly report says
  it too, instead of inventing a night's sleep.
- **Admins can delete a timelapse.** Open it and use the bin icon in the corner of the player, the same
  way an alert clip is removed. It asks first — unlike a clip, a timelapse can't be rebuilt, because the
  frames it was made from are deleted once it's assembled.

### Changed
- **Videos play in a proper window on a desktop browser.** The player was sized for a phone, so on a
  large screen a clip or timelapse played in a small panel at the bottom with most of the screen unused.
  On a desktop-sized window it is now a centred dialog that uses the space. On a phone it is unchanged.
- **Wake-up and bedtime now come from watching your child leave and enter the bed**, rather than from
  movement and sound alone. The app could already detect the moment a child got out of bed, but only
  showed it as a secondary note while the headline time came from the older method — so a night could
  say "woke 6:38am" with "got out of bed 5:09am" written underneath it. The bed-based time is now the
  one you see, and the night's length is measured to it: a morning that was recorded as 10h46m of sleep
  is correctly 9h17m once it stops counting the 89 minutes after your child had already got up.
  Where nothing confirms a bed exit, the old method is still used exactly as before, so no night gets a
  worse answer than it used to. The detail page keeps showing what movement and sound alone would have
  said, for comparison.
- **One word for where your child sleeps: "bed".** The app had been using *crib*, *cot* and *bed*
  interchangeably, and worst of all the sleep timeline labelled the same moment two different ways —
  a marker saying "Out of bed" sat next to one saying "Child out of crib". Everything now says **bed**,
  which is also what the app has always called it internally. The sleep timeline also now distinguishes
  a **moment** from a **stretch of time**: "Got out of bed" is when it happened, "Out of bed" is how long
  it lasted.
- **The night timeline only claims what it can actually tell.** It used to mark every crossing of the
  bed's edge the cameras thought they saw, and to label movement away from the bed as "Someone in the
  room". Neither survived contact with a real night: a child rolling over reads as an arrival, so one
  night showed four "got into bed" markers with no "got out of bed" between any of them — impossible —
  plus three visits from someone who was never there, and four and a half hours of a child asleep in
  bed labelled as out of it. One camera can see that something crossed the edge of the bed, but not
  *who*. The bar now shows just two markers — the put-down that started the night and the morning
  departure, which are the two the reported times are actually derived from — and anything else is
  reported as **movement outside the bed**, which is what was measured.
- **Your child's real bedtime is used, even when it isn't the bedtime you configured.** Bedtimes move
  night to night and nobody wants to edit a setting each evening, so the configured bedtime is now
  treated as a guide. A child put down before the window opened has that sleep counted, and the night's
  timeline is drawn over the sleep that actually happened rather than over the setting — previously
  everything before the window edge was silently cut off, so a child who went to bed at 7:11pm against a
  7:30pm setting showed neither his bedtime nor the parent leaving the room, though both had been
  detected correctly. Sleep before the window still only counts when the camera saw the child put into
  bed and they stayed asleep into the window.
- **Noise from elsewhere in the house no longer delays your child's bedtime.** A bedroom microphone
  hears the whole house, and bedtime is its loudest hour. One child, asleep and motionless from 6:50pm,
  was recorded as awake until 7:50pm — of the minutes holding it back, most were simultaneously loud in
  his brother's room next door while his own bed never moved. Once the camera has seen a child put into
  bed, a noisy minute counts as awake only if that room also *moved* around the same time; on the night
  above the two children's bedtimes now land within a minute of what their parents recorded. This
  applies only to working out when sleep began — a cry with no movement still counts as a wake-up.

### Fixed
- **No timelapse is made for a night nobody slept there.** A night with an empty bed was still producing
  a "memory" of an empty room, and leaving it on the child's page. Those nights are now skipped and their
  frames discarded.
- **Bedtime no longer has to match the schedule.** Children don't go to bed at a fixed time — a tired
  one can be asleep well before their sleep window opens. Sleep that started early was previously
  clipped to the start of the window, so an early night was recorded as shorter than it really was.
  Sleep is now measured from when your child actually went down. It only counts when the cameras saw
  them being *put* into bed and they stayed asleep into the window, so a quiet empty room can't be
  mistaken for an early bedtime, and an afternoon nap they woke up from can't be mistaken for the
  start of the night.
- **The morning wake-up time is more reliable.** The check that decides which quiet stretch is the
  real "up for the day" was sitting right on the boundary of normal behaviour: on one night a true
  05:09 wake-up was identified with **zero** margin, where a single extra minute of a parent tidying
  the bed afterwards would have reported the wake-up roughly two hours late. The margin is now
  comfortable. Verified against every night on record — no night's reported wake-up changed.

## [0.25.2] - 2026-08-25

### Changed
- **Two-factor keys are now twice as strong.** The library behind the 6-digit codes was updated, and
  new two-factor setups get a 160-bit key instead of 80-bit — matching the current standard
  recommendation. **If you already use two-factor, nothing changes and nothing breaks**: your existing
  setup keeps working and your authenticator app needs no attention. To move to the stronger key, turn
  two-factor off and back on whenever it suits you. See `docs/mfa.md`.

## [0.25.1] - 2026-08-25

### Changed
- **The crib area is now painted, not boxed.** Setting the crib area used to mean dragging rectangles over
  the camera view, which never fit a cot the camera looks down on at an angle — you either clipped the end
  of the cot or swept in a slab of floor. The picker now lays a grid over the still and you just **drag
  across the squares that cover the cot**, the way you'd colour them in; drag back over them to rub out.
  It shows how much of the view you've covered as you go, and existing crib areas carry over automatically.

## [0.25.0] - 2026-08-25

### Added
- **Recording now has its own Settings screen.** Settings → **Recording** replaces the recording block that
  was buried in General, and separates the two things that were previously tangled together: **Automatic
  clips** (captured when a detection fires, and aged out by retention) and **On-demand recording** (captured
  because you pressed Record, and kept until you delete it). The storage readout now also shows how much
  space your own recordings are using, which it previously left out entirely.
- **Record a moment yourself.** Each camera now has a **Record** button that captures a clip on the spot —
  and because the server is always keeping a short rolling buffer, it also saves the **30 seconds before
  you pressed**, so you can catch something just *after* it happens. Press again to stop (or let it stop
  itself at the time limit), and the clip appears under **Recordings** on that child's page, where it can
  be played, downloaded or deleted. Unlike alert clips, recordings are **never** removed automatically —
  they stay until you delete them. Settings → General lets you change how far back Record reaches, the
  automatic stop time, or turn the whole feature (and its buffering) off.
- **Download a night’s timelapse.** Opening a timelapse now uses the same player as an alert clip,
  including a **Download** button — so a night you want to keep can be saved to your phone'''s Downloads
  (or shared) just like a recorded clip. The timelapse player also now shows the night and its length
  underneath, matching the clip player.

### Fixed
- **More accurate refined wake-up times.** The refined ("out of bed") wake-up time shown on a night's
  sleep detail now has to be backed by an actual out-of-bed event, instead of being inferred from a quiet
  crib alone. A quiet stretch on its own could be a child who is simply still, so the old rule could pick
  a wake-up up to 40 minutes early — or, when a crib kept registering movement after the child had been
  carried out, up to an hour late. When no departure is detected, the night keeps its standard wake-up
  time rather than showing a refined one that might be wrong. Checked against a real night: both children
  now match what actually happened, or fall back cleanly.
- **Re-probing a camera over ONVIF no longer hangs on some Hikvision cameras.** After probing, the app
  live-tests whether the camera can play talk-back over its stream. On certain Hikvision cameras that
  advertise an audio output but don't actually support the ONVIF/RTSP backchannel, that test could get
  stuck waiting on a reply the camera never sends, leaving the probe spinning forever. RTSP handshake
  requests now time out cleanly, so the probe always finishes and reports its result — and because the
  app no longer waits for a disconnect acknowledgement the camera was never going to send, re-probing
  one of these cameras is about five seconds faster.

### Security
- **A Content-Security-Policy is now enforced.** The app serves a strict CSP that only allows scripts,
  styles, images, media and connections from itself (plus the video stream's STUN server and, by choice,
  Cloudflare's analytics beacon). This is defense-in-depth: if a bug or a future dependency ever tried to
  inject a rogue script, the browser blocks it. Rolled out in report-only mode first and validated against
  every feature (both stream modes, snapshots, clips, timelapses, two-way audio, theming) before enforcing.
- **Video/image URLs no longer carry your full login token.** The stream (HLS), snapshot, clip,
  timelapse, and talk-back URLs the browser loads directly used to include your 30-day session token
  as a `?token=` query parameter — and query strings can end up in reverse-proxy/CDN access logs,
  browser history, and referrer headers, so a leaked URL meant full account access. These URLs now
  use a separate **short-lived, video-only token** (12-hour lifetime, tied to your session so signing
  out revokes it) that can only fetch media — it can't touch the rest of the app. Live/background audio
  (WebRTC) authenticates once at connect and isn't affected; only Compatibility (HLS) streams carry the
  token, and they reconnect automatically if it ever expires mid-view. No visible change in use; the app
  fetches and refreshes the media token automatically.

## [0.24.1] - 2026-08-24

### Fixed
- **Two-way audio no longer looks like it "won't save" on cameras that don't need a talk login.** Cameras
  that play talk-back over their own stream (Thingino/Sonoff and most ONVIF cameras) use the stream
  credentials — they need no separate login. The camera settings form was still showing a Talk
  username/password box for them and then discarding whatever was entered, so the fields came back blank
  every time. Those cameras now show *"no separate login needed — talk-back is enabled automatically"*
  instead; only cameras that genuinely need a web login (Hikvision ISAPI) show the credential form, and
  the ONVIF probe now live-verifies which kind a camera is. As part of this, editing an unrelated setting
  on a stream-backchannel camera no longer silently turns its two-way audio off.

## [0.24.0] - 2026-08-24

### Added
- **Nightly sleep timelapse ("memories").** While a child's sleep window is open, Nightlight now samples a
  still from their camera every couple of minutes and, once the window closes, assembles the night into a
  short (~30-second) timelapse. A **Timelapse** card on the child's detail page plays the most recent night,
  with a strip of earlier nights to look back through. Frames come from the same local snapshot the alert
  image uses (no extra load on the camera), the keepsakes live alongside recordings on disk, and each child
  keeps their most recent 30 nights.
- **Sleep timeline now tells "child out of the crib" apart from "someone in the room."** Room-activity
  events on the Sleep detail view are labelled and coloured by which they are — movement while the child is
  out of the crib (between a detected exit and the next return) vs. movement while the child is still in the
  crib (a parent in the room) — instead of lumping both as generic outside-crib activity.
- **Out-of-bed / into-bed detection now feeds sleep times (experimental).** The frame-diff detector's
  crib entry/exit events are now persisted, and the nightly sleep computation uses them to derive a
  *refined* sleep onset and morning wake-up: onset waits until the child is actually placed in the crib
  (an empty, quiet crib no longer reads as sleep), and the morning wake is taken from the child actually
  getting out of bed — even when that happens a little after the sleep window closes. These refined times
  are computed alongside the existing movement-based estimate and shown on the Sleep detail view (with
  ▼ into-bed / ▲ out-of-bed markers on the night timeline) for validation; the headline figures still use
  the movement &amp; sound estimate for now.

### Changed
- **Simpler camera menu.** The detection quick-toggles for **Motion**, **Sound** and **Alerts** are now three
  compact icon buttons on a single row (tap each to turn it on/off), replacing the stacked switch rows.
  **Silence alerts** is now one button that reveals **15 min / 30 min / 1 hour** options when tapped (was a
  row of 30 min / 1 hour / 2 hours); while muted it becomes a one-tap un-mute.

### Fixed
- **Camera readings stay visible on a phone in landscape.** In landscape the top bar, bottom nav, and a full
  16:9 camera tile used to overflow the short screen, hiding each camera's temperature/humidity readings below
  the video. The header and nav are now slimmer and the video is capped in landscape so the whole tile — video
  plus readings — fits on screen.
- **Two-way audio no longer silently downgrades on ONVIF cameras.** For a camera that supports the ONVIF/RTSP
  audio backchannel (Thingino/Sonoff and most ONVIF cams), talk-back always uses the backchannel with the
  camera's stream credentials — a value left in the two-way-audio username field can no longer force the
  Hikvision ISAPI backend and quietly break talk on a plain edit. Applies on both add and edit.

## [0.23.0] - 2026-08-22

### Added
- **Quickly silence a camera's alerts.** The camera menu now has a **Silence alerts** section with
  30-minute / 1-hour / 2-hour buttons that temporarily mute *all* of that camera's alerts (motion, sound,
  ONVIF, MQTT) — handy when you're still up as the overnight alert schedule kicks in. While muted, the tile
  shows a small bell-off marker with the un-mute time, and the menu offers a one-tap **Un-mute**.
- **Get notified when the nightly sleep report is ready.** When a child's sleep window closes and their
  night is computed, Nightlight now sends a push (across whichever notification channels you have set up)
  with a one-line summary — time asleep, wake-ups, and wake-up time. On by default; only fires for a
  just-closed night, so restarts don't re-notify.

### Changed
- **Smaller, leaner Docker image.** The build now compiles/install backend dependencies in a separate
  stage, so the C/C++ compiler toolchain (gcc/g++/make) and python3 that only node-gyp needs at build
  time — plus the npm/node-gyp caches — no longer ship in the runtime image. This trims roughly a third
  off the image size and removes those build-only packages (and their scanner findings) from what runs
  in production. No runtime behaviour change.

## [0.22.0] - 2026-08-19

### Added
- **Restart the camera itself, not just the stream.** For cameras that support it over ONVIF, the camera
  menu now shows a **Restart camera** button beside **Restart stream** — it power-cycles the camera (useful
  when the picture is stuck in a way a stream restart can't fix), and appears only on cameras that can be
  rebooted this way.

### Changed
- **Restart stream now asks first.** Both **Restart stream** and **Restart camera** confirm before running,
  since each briefly takes the feed down for everyone.

### Security
- **Removed the unused `npm` from the runtime image.** The published Docker image no longer ships the
  base image's bundled npm (used only at build time), which clears the HIGH/CRITICAL scanner findings that
  came from npm's own bundled dependencies (they were never reachable at runtime — the app runs `node`,
  not npm).

## [0.21.0] - 2026-08-19

### Added
- **Watch a wake-up's clip right from the sleep breakdown.** In a child's sleep detail, each wake-up is now
  collapsed by default with a chip showing how many alerts fired; tap to expand it and see those alerts — and
  where a clip was recorded, play it inline (and download it) without leaving the page.
- **Pushover: choose a target device.** Pushover settings now have an optional **Device** field, so you can
  send alerts to just one device (or a comma-separated list). Leave it blank to alert all your devices as
  before; a bad device name is caught when you enable it.
- **Hover the sleep timeline for details.** On a child's night timeline, moving over the bar now shows a
  little bubble with the exact time, the sleep status at that moment (asleep / stirring / awake), and the
  room temperature then if a sensor was present. Works on touch too (drag along the bar).

### Changed
- **Tidier Account and Caregivers screens.** On your Account, **Change my password** now sits with your name
  and photo, **Notifications** moved up above **Signed in on**, and **Appearance**, **Two-factor
  authentication**, **Signed in on**, and **Notifications** each have their heading inside their own tile.
  On a caregiver's screen the identity fields are grouped under a **Caregiver details** tile, **Save changes**
  moved below the two-factor tile, and the photo and reset/remove actions are colour-coded (periwinkle for
  "Change photo", red for the destructive ones). Session rows no longer wrap the **Sign out** button onto a
  second line.

### Fixed
- **Quieter logs.** Benign, high-frequency FFmpeg timestamp warnings (and a burst of repeated "path not ready"
  messages while a camera briefly reconnects) no longer flood the logs, making the entries that actually matter
  much easier to read.

## [0.20.0] - 2026-08-18

### Added
- **"Restart stream" button on each camera.** In a camera's menu you can now force a fresh restart of its
  stream — handy if a feed has frozen or drifted behind live. It reloads the feed for everyone and the view
  reconnects at the live edge within a few seconds.
- **Wake-ups now show what the cameras flagged.** In a child's sleep detail, each wake-up in the breakdown
  now lists the motion/sound alerts that fired during that time (with the time, camera, and detail), so you
  can see what was happening when they woke.

### Changed
- **Consistent section headings across the app.** Card and section titles now share one style — matching
  the "Room climate" card — so headings read the same on every screen. On a child's page, **Cameras** and
  **Recent alerts** are now titles inside their cards; the sleep detail sections and all Settings headings
  match too. Settings sections are now grouped in tiles with the heading inside — **General** (theme
  presets, font, colours, temperature unit), **Camera controls**, **User management**, **Clip management**,
  **Logs**, and **About**. The **General** page's first tile is now headed **General Settings**.
- **"Change my password" stands out.** On the Account screen it's now a filled periwinkle button instead of
  a plain outline, so it's easier to spot.
- **The connection-mode toggle now reads "Low latency"** (was just "Low"), so it pairs clearly with
  "Compatibility".

### Fixed
- **A wedged "Low" (sub) stream now self-heals.** The low-resolution stream has its own background feed,
  and it could get stuck (running but no longer delivering video — e.g. after a camera drop/reconnect or a
  codec change) with nothing to recover it, so switching to **Low** quality showed no video until the whole
  app restarted. The watchdog now watches the low stream too and restarts it automatically, the same way it
  already does for the main stream.
- **Cameras that send Opus audio now work in Compatibility mode too.** Opus gives noticeably clearer audio
  on Low latency (WebRTC), but Compatibility (HLS) can't carry it, which was breaking that mode. Nightlight
  now serves Compatibility from a separate AAC audio feed while Low latency keeps the crisp Opus — so both
  modes work, whatever audio codec the camera uses (Opus, G711, or AAC).
- **A disabled camera no longer spams the logs.** Disabled cameras have no stream path, so the app no longer
  asks MediaMTX about them on every camera-list refresh — which had been logging a steady stream of
  "path not found" errors.

## [0.19.0] - 2026-08-18

### Added
- **Per-child sleep tracking with its own bedtime & wake time.** Each child now has a **Track sleep**
  toggle in their settings; turn it on and set that child's **bedtime** and **wake time**, and their sleep
  is estimated over exactly that overnight window. Turning it off stops the tracking (and the background
  work) for that child and hides their sleep card. This replaces the single app-wide window — each child
  can now have their own schedule. Existing children keep tracking on with the previous 19:00–07:00
  window. A child can still have more than one camera; their movement/sound is combined across all of them.
- **Sleep detail view with a night timeline.** Tapping a child's "last night" sleep summary now opens a
  full breakdown: a to-scale timeline of the night showing asleep vs awake stretches, each wake-up marked
  against a real time axis, plus a list of every awakening with its time and length. A date picker lets
  you step back through previous nights (about 30 days of history — the period the per-minute activity
  data is kept, which is lightweight to store). The timeline also distinguishes light **stirring** from a
  full **awake** stretch.
- **Room activity (movement outside the crib).** For a camera with a crib zone set, Nightlight now also
  tracks movement *outside* the crib — a parent coming in, or the child climbing out of bed — as a
  separate signal from stirring in the crib. These show on the sleep timeline as distinct "in the room"
  markers with a list of when they happened, and they help catch a morning wake where the child got out
  of bed (previously invisible, since in-crib motion sees nothing once they leave the cot). Wake detection
  also now bridges short quiet gaps, so intermittent fussing reads as one awakening rather than several
  missed stirs. (Outside-crib tracking starts collecting from this release; it doesn't backfill past
  nights. Motion *alerts* are unchanged — still scoped to the crib zone.)
- **Live "tonight so far" sleep.** The summary and detail no longer wait for the window to close in the
  morning: while a night is in progress the child's tile shows **"Tonight · so far"** and updates as the
  night goes, so an early-morning wake shows within a minute or two instead of only after the 7am window
  close. The detail timeline marks "as of now" and refreshes live; the final stored summary is still
  written when the window closes.
- **Room temperature on the sleep timeline, and a temperature-vs-sleep insight.** For a child whose
  camera has an MQTT temperature/humidity sensor, the sleep detail view now draws the night's room
  temperature as a line beneath the sleep timeline (on the same time axis, so you can see how warm the
  room was around a wake-up), with the night's average and range. Once there are a handful of tracked
  nights, a **"Sleep & room temperature"** card compares wake-ups on the child's warmer vs cooler nights
  and calls out whether warmer nights tend to mean more waking — a pattern guide, not a cause. Builds on
  the temperature/humidity history that was already being recorded; correlation strengthens as more nights
  are tracked.

### Changed
- **Sleep tracking now only runs during each child's window.** The background movement sampler for sleep
  tracking used to run around the clock; it now starts at each child's bedtime and stops after their wake
  time, so it isn't using camera-decode CPU all day for no benefit. No change to what's recorded overnight,
  and motion/sound *alerts* are unaffected — they still run whenever they're configured to.

## [0.18.0] - 2026-08-18

### Added
- **Camera-native motion over ONVIF.** Motion detection has a third source (Camera → Motion detection),
  alongside Nightlight's own frame-diff and "Camera via MQTT": **Camera via ONVIF**, where the camera
  reports motion over its ONVIF Event service and Nightlight subscribes directly — no MQTT broker
  required, and almost no server CPU. The option appears only for cameras that actually advertise a
  motion event topic (detected during the ONVIF probe); existing ONVIF cameras can enable it by
  re-running the ONVIF probe from the edit screen. Sleep tracking is unaffected — a child's camera still
  keeps its own in-app movement timeline regardless of which source fires alerts. The log viewer
  (Settings → Logs) gains an **ONVIF motion** filter chip for watching this source.

### Changed
- **Lower Compatibility-mode latency.** HLS segments are now 1s (was 2s), so Compatibility (HLS) mode
  runs closer to live on cameras with a short keyframe interval. For the lowest lag, set the camera's
  keyframe interval / GOP to about 1 second (≈ its frame rate) — Nightlight can't make a segment shorter
  than the camera's keyframe spacing.
- **The crib area can be more than one box.** The crib-zone picker (Camera → Motion detection) now
  supports **multiple rectangles**, so a crib on a diagonal (or an awkward corner) can be covered by a
  few boxes instead of one loose one — motion detection and sleep tracking count movement inside any of
  them. Tap a box to move or resize it, "Remove box" deletes the selected one, "Whole frame" clears all.
  Existing single-box zones keep working. (Also: the picker's buttons no longer wrap onto two lines.)

### Fixed
- **Talk-back now picks — and self-corrects — the right protocol.** Two-way audio has two backends
  (Hikvision ISAPI over HTTP, and the ONVIF/RTSP audio backchannel used by Thingino/Sonoff and most
  ONVIF cams). Previously the backend was chosen once and never revisited, so a camera that was
  re-pointed at a different device, or added before the ONVIF backchannel existed, could keep talking
  the wrong protocol — you'd press talk and nothing came out of the speaker. Now, whenever a camera is
  added or its ONVIF details are re-fetched, Nightlight actively verifies which protocol the camera
  really answers and stores that one, correcting a stale/mismatched backend. Re-fetch ONVIF on an
  affected camera's edit screen to fix it. (A genuine Hikvision won't answer the backchannel and stays
  on ISAPI.)

### Security
- **Hardened alert snapshot/clip serving against path traversal.** The routes that serve an alert's
  snapshot and recorded clip now hand `res.sendFile` a jailed `root` so Express itself rejects any
  attempt to escape the snapshot/clip directory, in addition to the existing integer-id and
  under-directory validation. No exploitable path existed (the flag from a security scan was a false
  positive), but the extra layer makes containment enforced by Express and clears the finding.
- **Removed string interpolation from SQL statements.** The retention-prune queries (activity samples,
  sensor readings) and the MFA-reset console script no longer build their SQL by interpolating values
  into the query text — the queries are now fully static with values bound as parameters. The
  interpolated pieces were all hardcoded constants (retention days) or fixed literals (never user
  input), so no SQL injection was possible; this removes the pattern a security scan flagged.
- **Guarded clip-recording file paths against traversal.** The clip recorder now validates the camera
  id and clip basename are safe single path segments before they're used to build ring/clip directory
  and file names. Both are always server-generated (a camera UUID and an integer event id), so no
  traversal was reachable; the guard fails closed against any future caller passing an unchecked value.

## [0.17.0] - 2026-08-17

### Added
- **Two-way audio now works on ONVIF cameras (not just Hikvision).** Talk-back previously only supported
  Hikvision's ISAPI protocol; cameras that do two-way audio over the ONVIF/RTSP audio backchannel (e.g.
  Thingino/Sonoff) silently did nothing. Nightlight now speaks the RTSP backchannel too — added ONVIF
  cameras that report an audio backchannel get talk-back automatically, reusing the stream credentials
  (no separate login). Existing ONVIF cameras can enable it by re-running the ONVIF probe from the edit
  screen.
- **Sleep tracking (estimated).** Each child's page now shows a **"last night" sleep summary** — time
  asleep, when they fell asleep and woke, number of wake-ups, and longest unbroken stretch — inferred
  from overnight movement and sound (no wearable, nothing to start; it's a sleep-*pattern* estimate,
  not a medical measurement). Works from any camera assigned to the child that runs motion or sound
  detection; the nightly window is set under Settings. Paired with a new **crib-area picker** on a
  camera's Motion detection screen: draw a box over the live view to focus motion detection and sleep
  tracking on the crib, so a fan or someone walking past isn't counted.
- **Room climate history.** For a camera with an MQTT temperature/humidity topic, Nightlight now keeps
  a rolling history of its readings (sampled every few minutes) and shows a **last-24h temperature &
  humidity chart** on that child's page. Previously these readings were live-only. This is the first
  piece of the upcoming sleep-tracking feature — the same overnight history it will build on — and is
  useful on its own for spotting a room getting too warm or dry.

## [0.16.0] - 2026-08-17

### Added
- **Offline-camera alerts.** Settings → Camera controls can now send a push notification when a camera
  stops delivering video for longer than a threshold you set (in minutes), and another when it comes
  back online. Off by default. Uses whatever push channels you already have set up (Firebase, Pushover,
  ntfy, Gotify) — handy for catching a camera that's quietly dropped off, like an MQTT camera that
  stops reporting.
- **"Camera not connecting?" diagnostic report.** When adding a camera fails (the ONVIF fetch or the
  stream check can't connect), the Add camera screen now offers to generate a redacted report — the
  stream's codecs (via ffprobe), any ONVIF details, and the address (no password) — to download and
  attach to a GitHub issue, so support can be added for that camera. Nothing is uploaded; the file
  stays on your device to review first.
- **Quick filters in the log viewer.** Settings → Logs now has one-tap chips (Errors, Warnings, Motion,
  Sound, MQTT, WebRTC, HLS, Recording) to narrow the log to one subsystem, on top of the existing
  free-text filter.
- **MQTT motion is now logged.** The server logs each inbound message on a camera's motion topic and how
  it was read (motion / no motion / skipped for cooldown or quiet hours), plus a one-off note the first
  time a topic delivers — so a camera that silently stops reporting motion (or a mistyped topic) shows
  up in the logs instead of just going quiet.
- **Clip management date filter is now a popup calendar.** Settings → Clip management — the day filter is
  a calendar; days that have clips are marked with a dot, and you can tap one or several days to filter
  to just those (Clear resets to all).

### Changed
- **Camera controls now have their own Settings page.** PTZ step size (previously under General) moved
  to **Settings → Camera controls**, alongside the new offline alerts.
- **Sign out removed from the Settings list** — it already lives on the Account page (tap your name at
  the top of Settings), so it was showing in two places.
- **Push notification secrets are now masked.** Settings → Push notifications (Pushover, Gotify, ntfy)
  no longer show your saved API tokens/keys in full — just a short masked preview (e.g. `a1b2••••••`)
  so you can tell which one is set. Leave a field blank to keep the current secret; type a new value
  only to replace it. The full tokens are no longer sent back to the browser at all.
- **Bigger camera tiles on tablet and desktop.** The camera grid now uses the full width of larger
  screens instead of a narrow centred column with wide empty margins, and tiles stretch to fill their
  row — so there's far less wasted space and each camera is shown larger. Phone layout is unchanged.
- **Desktop gets a left sidebar.** On wide screens the bottom tab bar becomes a vertical navigation
  rail down the left (with the app name at the top) — a more natural desktop layout than a stretched
  mobile bar. Phone and tablet keep the familiar bottom tabs.

### Fixed
- **Cameras that send AAC audio now work in Compatibility mode (and have Low-latency audio).** A camera
  whose stream carries AAC audio (e.g. some Thingino builds) previously broke Compatibility (HLS) mode
  entirely — MediaMTX's HLS muxer rejects two AAC audio tracks — and had no sound in Low-latency
  (WebRTC can't carry AAC). Nightlight now detects an AAC source and builds the WebRTC audio track as
  G711, so HLS gets a single valid audio track (video + sound in Compatibility) and Low-latency has
  sound too. G711-audio cameras are unchanged.
- **Clearer camera-report error when a camera can't be reached.** An unreachable camera in the "Camera
  not connecting?" report now reads "Timed out — no response from the camera (wrong IP/port, offline,
  or blocked by a firewall)" instead of the meaningless "ffprobe exited null".
- **Helpful message when an out-of-date mobile app can't export a file.** Downloading the diagnostics
  bundle or a camera report from an old installed app (one built before the file-export support was
  added) now says "Update to the latest app version and try again" instead of "Couldn't save the file
  on this device".

## [0.15.1] - 2026-08-16

### Changed
- Dependency and toolchain maintenance: **better-sqlite3 11 → 13** (a ground-up N-API rewrite), plus
  lucide-react, vite, hls.js, express-rate-limit, @vitejs/plugin-react, ws, and CI action updates.
- The container's Node runtime is no longer pinned to 24.18.1. better-sqlite3 13's rewrite resolves the
  shutdown crash that forced the pin, so the image now tracks the Node 24 line (`node:24-alpine`).

### Security
- Patched dependency security advisories surfaced by `npm audit`. **react-router → 7.18.2** clears a
  client-side CSRF advisory (specific to server/RSC routing, which Nightlight's client-only routing
  doesn't use — patched regardless). **ip-address → 10.5.0** clears SSRF/address-parsing advisories;
  it's pulled in transitively by the login rate-limiter and the MQTT client.

## [0.15.0] - 2026-08-14

### Added
- **Event recording — short video clips of detections.** Turn on “Save a clip when triggered” under a
  camera’s Motion or Sound settings and Nightlight keeps a rolling buffer of that camera, so each
  alert gets a short video (the pre-roll before the trigger through the post-roll after) attached to
  it. Alerts with a clip show a play button on their thumbnail; tapping opens the clip in a player
  (with a download button). Clip length is set globally under Settings → General → Recording
  (pre-roll and post-roll) and clips come out exactly that length. Off by default and opt-in per
  camera, so a camera only uses disk when you ask it to. Clips are captured with no extra load on the
  camera (they come off the stream Nightlight already pulls) and are stored on the server alongside
  the alert history. In the mobile app, **Download clip** saves the video into your phone's Downloads
  folder (the same native path the diagnostics bundle uses), since the in-app WebView can't do a
  browser download.
- **Recording retention & storage controls.** Under Settings → General → Recording you can set how
  long to keep clips (days) and a total storage cap (GB) — oldest clips are deleted first once either
  limit is passed (0 turns a limit off), while the alert and its snapshot are kept. The section also
  shows how much space clips are using and where they're saved. By default clips live under your data
  directory; set a `/recordings` mount + `CLIPS_DIR` to store them on a separate disk (e.g. an Unraid
  array) — see [docs/recording.md](docs/recording.md). Nightlight refuses to write clips to an unmapped
  container path (they'd be lost on recreate), and skips recording if the disk is nearly full.
- **Manage recorded clips.** The clip player has a delete button (with an “are you sure?” confirm) to
  remove a single clip — the alert and its snapshot stay. And **Settings → Clip management** (admin)
  lists every clip, lets you filter by date, and bulk-select clips to delete in one go.

### Changed
- **The Children tab looks nicer.** Each child now has their own card instead of a plain list row
  (a clean white card in light mode, the darker hero style in dark mode), and the avatar on a child's
  page is larger and easier to see. Tapping that photo opens it full-size.

### Fixed
- **Compatibility-mode (HLS) audio is no longer choppy.** For cameras that send jittery audio
  timestamps (e.g. the Sonoff), the fix that kept HLS from dropping to "No signal" was itself
  dropping/inserting audio samples, so the sound stuttered constantly. The audio timeline is now
  rebuilt from the sample count instead, which stays perfectly in order for the player **without**
  discarding samples — so Compatibility mode sounds clean. Low-latency (WebRTC) audio was never
  affected. (On a badly glitching camera, audio may now drift slightly out of lip-sync rather than
  stutter — a deliberate trade.)

## [0.14.0] - 2026-08-14

### Added
- **Two-factor authentication (TOTP).** Optional, per-account: Settings → Account → Two-factor sets it
  up from an authenticator app (QR or manual key) and issues 10 one-time backup codes. Login then asks
  for the 6-digit code after the password. Recovery is covered by backup codes, an admin "Reset
  two-factor" action on a caregiver, and a console failsafe (`src/scripts/reset-mfa.js`) for a locked-out
  admin — see `docs/mfa.md`. Works over LAN http, remote HTTPS, and in the app (no secure-context needed).
- **ntfy and Gotify notifications.** Push notifications is now a hub (a row per provider, like the
  Settings screen) covering **Pushover, Firebase, Gotify, and ntfy** — enable any combination and an
  alert goes to all of them. ntfy (ntfy.sh or self-hosted) carries the snapshot inline and works on
  iOS; Gotify is self-hosted, text-only. Each provider has its own config page with a Send-test button.
  See `docs/notifications.md`.
- **Avatar photos for children, caregivers and your own account.** Add a photo (child → avatar →
  Add photo; a caregiver's settings; Settings → Account). It's resized in your browser and saves
  immediately; the coloured initials remain the fallback everywhere an avatar shows.
- **Download a diagnostics bundle for bug reports** (Settings → Logs → "Report a problem", admin
  only). One click saves a redacted JSON snapshot — version/build, host + runtime info, camera &
  detection settings, live stream/MQTT/push status, and recent detection + camera-history events +
  server logs — to attach to a GitHub issue. Secrets (all passwords/tokens, credential-bearing URLs)
  are reduced to "is it set?" booleans, never their values, so it's safe to share. In the Android app
  it saves straight to the phone's Downloads folder (falling back to the share sheet on older devices),
  since the WebView can't do a browser-style download.
- **Per-camera settings, and Motion / Sound / Schedule, are now their own screens.** Editing or adding
  a camera opens a full page (reached from the tile's gear → "Camera settings"), and detection is split
  into separate Motion, Sound and Schedule screens instead of one long form. Changes apply immediately
  (no Save button) — toggles are switches, and the alert snapshot URL lives with the motion settings.
- **Edit your own name.** Settings → Account now lets any user set their First / Last name (the login
  username stays admin-managed).

### Changed
- **Child-centred navigation — four bottom tabs: Live · Children · Cameras · Settings.** Children is
  its own tab that opens each child's page (their cameras, their alerts, and — soon — their sleep
  summary); tap a child's avatar to edit them. Cameras is its own tab with richer rows (live thumbnail
  + Online/Offline pill and capability badges). Caregiver management moved into Settings (admin).
  Sub-pages have a labelled back button that returns you to where you came from.
- **New light visual theme, now the default.** A lighter, calmer look: periwinkle for interactive
  elements (tabs, switches, sliders), your accent colour (gold by default) for primary buttons and the
  camera glow, and a navy top bar. Dark and System remain under Settings → Account → Appearance (the
  choice is per-device).
- **Detection alerts now show snapshots and are visible to any signed-in user.** Each detection's image
  is captured on every alert (not just when push is enabled), saved one file per alert, shown as a
  thumbnail, and pruned with the alert history (kept up to 30 days).
- **Room temperature & humidity show with thermometer / droplet icons, larger and bolder** (~20%), so
  the two readings read at a glance instead of running together in one line.
- **The camera tile's gear opens a bottom sheet** (grabber, grouped rows, Done) with quick controls:
  Connection mode (Low / Compatibility) and Quality (High / Low) as segmented buttons, admin quick
  Motion / Sound / Alert-schedule toggles (each with its icon), a Stop / Start camera button, and a
  Camera settings shortcut. Swipe the sheet down to dismiss it on touch devices.
- **Settings that apply the moment you flip them now use a pill toggle switch** instead of a checkbox,
  so the control's shape tells you whether a change is instant or only takes effect when you press Save.
- **Account, About, Change server and Sign out moved into the Settings tab** (the header hamburger menu
  is gone); the app version shows on the About row, and the MQTT row shows its live connection status
  as a coloured badge for admins — green Connected, red Disconnected, grey Off.
- **Back navigation:** a swipe from the left half of the screen, and the Android hardware Back / edge
  back-gesture (via the app's new `@capacitor/app` plugin), both step back one screen instead of
  exiting. Not active on the Live dashboard, where the tiles own their own gestures.

### Fixed
- **PTZ no longer dims the video or eats arrow taps.** The pan/tilt pad now has its own transparent
  layer instead of reusing the gear sheet's dimmed backdrop, which sat over the arrows — so the D-pad
  works again.
- **Settings sub-pages put their back button in the nav bar** like every other page, instead of a stray
  link below it.
- **Opening a camera, child or caregiver form no longer pops up the keyboard** automatically.
- **Light-mode polish:** form fields are now white (not pale lavender); the MQTT icon is cropped and
  aligned to match the other icons, and its description covers both room sensor readings and
  camera-side motion detection; list / menu labels (Pushover, Firebase, children, cameras…) are larger
  and easier to read; and the ONVIF "Fetch" / "Verify login" buttons are a filled periwinkle (matching
  an active toggle) so they read clearly.

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

### Changed
- Softened the camera tile corners a little less aggressively (16px → 10px radius).

### Fixed
- Camera tiles are now 16:9 (were 16:10), matching the native aspect ratio of virtually all
  IP cameras. The taller tile made `object-fit: cover` crop the left/right edges, which was
  hiding the camera's own on-screen timestamp; at 16:9 the full frame shows.

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
