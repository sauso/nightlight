# Changelog

All notable changes to Nightlight (server + web app) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/). While on 0.x: minor bumps for new
features, patch bumps for fixes. History before 0.1.0 exists only as git history —
0.1.0 is the first tracked release, not the first release.

## [Unreleased]

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

### Fixed

- **A background check that failed could shut Nightlight down.** The 15-second camera watchdog, the
  30-second audio check, the 5-minute reconcile and the timelapse sampler each ran unprotected: if one
  of them hit an error — most likely the streaming server being briefly unavailable — the whole app
  exited. That is an outage on an unattended monitor, and it was self-inflicted at the worst moment,
  because a briefly-unavailable streaming server is also exactly what makes a camera look unready and
  sends the watchdog in to fix it.
  - A failure in one of those jobs is now written to the log as `[guard:…] background task failed
    (continuing)` and skipped; the job runs again on its next tick.
  - A failure while checking one camera no longer skips the cameras after it in the same pass.
  - Nightlight now also survives unexpected errors elsewhere rather than exiting — see
    [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what these log lines mean and when to worry about them.

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
