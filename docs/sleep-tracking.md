# Sleep tracking

Nightlight can estimate each child's overnight sleep from what their cameras already see and
hear — no wearables, no extra hardware. It's a **sleep-pattern guide, not a medical
measurement**, and (like everything here) never a safety device — see the [safety note in the README](../README.md).

This guide covers setup, the child card and the sleep detail page, how a night is estimated, how to correct it, and the known limits.

## Turn it on per child

Each child has a **Track sleep** toggle in their settings, with
their own **bedtime** and **wake time**. Turning tracking off stops it entirely. Only an
**admin** can turn tracking on or off, change those times or choose the camera the night is measured
from (a caregiver sees them, greyed out).
A child can have more than one camera; the night is measured from one of them (see
[One camera does the measuring](#one-camera-does-the-measuring)).

## What you see

### At a glance, and live

Each child's page summarises last night — total sleep, wake-ups,
longest stretch — and while a night is in progress it updates as **"Tonight · so far"**, so an
early-morning wake appears within a minute or two rather than only after the window closes.
Treat those live figures as provisional: a night in progress is judged only on what has
happened so far, so a bedtime can be revised later in the evening and the morning wake isn't
looked for at all until the night is complete. The settled numbers are the ones on the card the
following day.
- **"Last night" is always the last night that has finished.** The saved summary for a night is
  written by the nightly update, which runs every 30 minutes, so for up to half an hour after the
  window closes (and for as long as that update is refused or skipped, for example for a night you
  corrected in the morning review) there is no saved summary for it yet. The card, and the detail
  page it opens, then show last night **worked out fresh** instead of the night before; once the
  saved summary exists they show that, so the card keeps agreeing with the morning notification.
  Reading the card never saves anything. If the night was not watched enough to score it reads "no
  data" rather than falling back to an older night.

### In bed, then asleep

On a night where your child was put down a while before they fell asleep
(a bedtime story, a slow settle), the card and the detail page show both: **In bed** is the
put-down the camera recorded, and **Asleep** is when the room went quiet. That's the same time the
app has always reported as bedtime. The extra time appears only when "in bed" is at least a minute
before "asleep", so most nights still show one time. If you corrected a night's asleep time, the
camera's "In bed" is hidden and only your time is shown: the recorded put-down belongs to the bedtime
you corrected, so it may not match yours. Correcting only the wake-up time keeps it. If you gave the
**In bed** time yourself in the morning review, yours is shown, beside your asleep time too. A night
saved before 0.35.0 has no "in bed" time on the child's card until it's recomputed, and a night
you corrected in the morning review is locked against that until the correction is removed (or give
its **In bed** time yourself in the review). The detail page works the night out fresh each time, so
it shows the time straight away.

### The detail view

Tap the sleep summary for the full **night timeline**: a to-scale bar of
asleep / stirring / awake stretches on a real time axis, every wake-up listed with its time
and length, a **movement outside the bed** list, and a date picker to step back through
roughly the last month of nights. Two moment markers sit on the bar — **got into bed** and
**got out of bed** — and they are deliberately the only two shown: they're the put-down and
the morning departure the night's times were actually derived from. A single camera can see
that something crossed the edge of the bed, but not *who*, so movement in between is reported
as exactly that and never attributed to a person. A stretch the camera has no data for at
all — a detector restart, a dead connection — shows as its own striped **"No data"** segment
rather than being folded into asleep or awake; it isn't counted toward the reported sleep
duration either, and a night with a long enough gap can come back with less sleep counted, or
occasionally no clear sleep detected, than the raw hours between bedtime and waking would
suggest. **A stretch with sound but no video counts as "No data" too:** a minute is only
counted as watched if the camera's video actually delivered a picture in it (at least one real
frame — any frame rate), and the sound of an unwatched minute is not used, because a bedroom
microphone hears the whole house. So if the video stalls over bedtime, the reported bedtime is
the first quiet minute after the video came back, and a cry during a stall is not shown as a
wake-up from the noise alone. A night more than half unwatched is "no data", and a night is only
ever reported as **"no one was in the bed"** when at least **90%** of it was watched (a fixed
first estimate, not a setting; on a night still in progress, 90% of the part so far), because
that answer also discards the night's timelapse. A
frozen picture still counts as watched — see
[KNOWN-ISSUES.md](../KNOWN-ISSUES.md), "Minutes with no video are unknown in the sleep numbers".

### Finished nights use the settings they were saved with

Each saved night records what it was worked out from: the camera, the timezone and the sleep window. If one of
those has changed since (the camera was turned off, moved to another child or is no longer the main camera, the
tiles were rearranged, or the window or timezone was changed), the detail page works a **finished** night out with
the settings it was saved with, so it uses the same settings as the child's card. A line above the night says so,
for example "Worked out with the settings this night was saved with (Bed cam, 19:30–07:00, Europe/London), using
today's detection rules". **Show with today's settings** switches the page to today's, and a second button switches
back. The choice is for that night only and is not remembered: another night, a reload, or a Recompute save goes
back to the saved settings. Before, the page always used today's settings, so after such a change a finished night
could show different numbers from its card, or "no data". The morning review uses the same settings as this page
(see [A night whose settings have changed](#a-night-whose-settings-have-changed)).
If switching views fails, the page keeps showing the previous night and shows an error. Press the same settings
button again to retry.

| The night | Settings the detail page uses |
|---|---|
| Finished (its saved window and today's window have both ended), saved settings differ from today's | the saved ones, with the line and the switch |
| Finished, saved settings the same as today's | today's (the same; no line) |
| Still in progress under today's sleep window, even if the saved night's window has ended (for example the wake time was moved later after it was saved) | today's, live, as on the child's card |
| The saved night's window has not ended yet | today's |
| Nothing saved yet, saved before nights recorded their settings, or a record that can't be read | today's |
| Sleep tracking is off | none: "Sleep tracking is off" (no line, no switch) |

The card and the page then share the **settings**, not necessarily every number. The page still works the night
out again from the recorded movement, with today's detection rules and whatever data is still kept, so:
- The **detection rules** are always today's. A night first worked out under earlier rules says so ("…so the
  numbers can differ from the child's card").
- Room temperature, the alert list and wake clips come from the child's cameras today. Movement outside the bed
  comes from the saved camera, like the sleep numbers.
- Times are shown in today's timezone (the one in Settings), even when the line names the timezone the night was
  saved in.

Known limits. For the first three, use **Show with today's settings**, or have an admin
[Recompute](#re-working-out-a-night-admins) the night with today's settings (which saves today's settings with it):
- A new install's timezone is **UTC** until you set yours. Nights saved before you set it keep the UTC window.
- Deleting a camera deletes its recorded movement too, so a night saved from it shows "The camera this night was
  measured from no longer exists…" where today's settings would show another camera's night.
- A night saved while **no camera was on** stays "no data" after a camera is assigned, even if today's settings
  could work it out.
- A night whose minute-by-minute data has **aged out** (kept 30 days) shows "no data" with either settings, while
  the card keeps its numbers. Nothing brings that data back.
- "Finished" means both the saved night's own window and today's window have ended: last night uses its saved
  settings from then on, including the ~3 hours the nightly update may still re-save it. When that update re-saves
  it with today's settings, the page follows.

### Room temperature (optional)

If a camera reports temperature/humidity over **MQTT** (set
up under **Settings → MQTT**, e.g. via Zigbee2MQTT — the readings also show on the camera
tile), the sleep detail overlays the night's room temperature beneath the timeline, aligned to
the same time axis. A **"Sleep & room temperature"** card compares wake-ups on the child's warmer
vs cooler nights, so you can spot whether a warm room tends to mean more waking — a pattern, not
a cause. It reads the child's 30 most recent tracked nights with a temperature (fixed, not a
setting). From the first such night until there are 5 it reads "Collecting nights" with the count
so far. From 5, a room whose temperature varied by less than 1°C across those nights is reported
as "barely changed": that says nothing about sleep, only that the room did not change enough to
compare. Otherwise the nights are split at the median temperature, and the card needs **at least
10 nights in each of the cooler group and the warmer group before it says anything about sleep**
(fixed, not a setting; the figure is a judgement, not a measurement, and counts nights only, so it
is the same in any home or climate). Nights at exactly the median temperature belong to neither
group, so the first comparison needs at least 21 nights (10 cooler, 10 warmer and one at the
median). Until both groups reach 10 the card reads "Not enough nights yet" with how many it has
of each, and shows no verdict and no averages. Once both groups have 10, the wording and numbers
are exactly what they were before. Known limit: each night's average temperature is rounded to
0.1°C, so in a very steady room where many nights share the median value (all of which join
neither group) one group can stay under 10, and the card keeps saying "Not enough nights yet",
for as long as the room stays that steady.

## How a night is estimated

### One camera does the measuring

If a child has several cameras, sleep is worked out from their
**main camera**, and an admin can choose which one it is: **Camera used for this child's sleep** in
the child's settings (shown once a child has two or more cameras).
- **Default: Automatic** — the first camera in the order the tiles are arranged on the live grid,
  skipping any that are turned off. This is how every child behaved before the setting existed, so
  nothing changes until an admin picks a camera. With Automatic, dragging the tiles can still change
  the main camera, so anyone may rearrange them but a **caregiver's** move that would change the
  camera a child's sleep or nightly timelapse comes from (for any child whose sleep tracking is on) is
  refused: the tiles go back, a message says why, and nothing is saved. On a child set to Automatic
  with two or more turned-on cameras, a caregiver therefore cannot put another of that child's turned-on
  cameras ahead of the one measuring now, and in a home with one child and two cameras, both theirs and
  both on, no tile can be moved at all, until an admin chooses a camera here (one that is turned on);
  after that the tiles can be rearranged freely. An admin's moves are never refused.
  - **Known limit: the check protects the cameras that are measuring a tracked child now.** A caregiver
    can freely place a camera that belongs to no child, one that is turned off, one of a child whose
    sleep tracking is off, or one that is not first. A later admin action (assigning a camera, turning
    one on or off, deleting one, setting a child back to Automatic, turning sleep tracking on) then
    picks the main camera from that order, exactly as it would from an order an admin had set.
- **Range: any camera assigned to that child**, including one that is turned off. A chosen camera
  that is turned off (or has been deleted) is skipped and Automatic is used until it is back on;
  turning it back on makes it the main camera again. Moving the chosen camera to another child, or
  unassigning it, resets the choice to Automatic.
- Only an **admin** can change it (a caregiver sees it, greyed out). The settings screen says which
  camera the night is being measured from right now.
- **What a change affects.** The camera is looked up each time a night is worked out, so a change
  applies to every night computed afterwards, not only future ones: tonight's figures, the **morning
  review** (always worked out fresh), last night's saved summary while it can still be updated (up to
  about three hours after the wake time), a review correction that saves the night first, and an
  admin's **Recompute**. Older saved summaries (the child's card) are not recomputed and keep the
  numbers of the camera they were measured from. A finished night's **detail page** uses the camera it
  was saved with too, with a switch to today's (see [Finished nights use the settings they were saved
  with](#finished-nights-use-the-settings-they-were-saved-with)); a night saved before nights recorded
  their camera uses today's. An admin's Recompute can instead use the camera a night was saved with:
  see [Using the settings a night was saved with](#using-the-settings-a-night-was-saved-with).

The others carry on streaming, alerting and recording as normal; they just don't affect the numbers.
The nightly timelapse is taken from the same main camera.
This is deliberate: if every camera were combined, the *noisiest* one would decide the night — a
camera facing the doorway would push bedtime later and add wake-ups that never happened, with nothing
saying which camera was responsible. The night's detail view names the camera it measured from. Room
temperature and humidity are the exception and still come from every sensor in the room, because
those are averaged rather than combined.

### How it estimates

Across the night it builds a per-minute movement + sound timeline from
the child's main camera: falling still for a sustained stretch reads as falling asleep,
sustained movement or noise reads as an awakening (brief stirs don't count). On a completed
night, a short recorded exit-and-return can also count as an awakening even when it's too brief
to show up as sustained movement on its own — as long as the bed is confirmed quiet in between
and later bed movement supports the return. This only applies to trips of one to twenty minutes,
with at least a minute of quiet bed time in between; it updates wake-ups, awake time, and the
longest sleep stretch, but live figures and wake-clip recording still use the plain movement rule
described earlier in this section. If you've painted
a **bed zone** on the camera — the same area that scopes motion alerts — it also tracks
movement **outside** the bed and lists it separately, which catches a morning wake where the
child has already left the bed. Draw the zone so it comfortably contains the child **including
where their head ends up** — a zone that cuts through a sleeping child makes their own rolling
over register as movement outside the bed, and can stop a real climb-out being recognised.
Only clearly-outside-the-bed movement is listed; faint changes (a shadow, the camera's
night-vision adjusting) are ignored rather than reported as someone in the room.

### Bedtime is a guide, not a boundary

Real bedtimes move night to night, and you shouldn't
have to edit the setting each evening. The bedtime that gets reported is the one the camera
actually saw — the **put-down**, and the child settling after it — whether that happens before
the window opens or an hour into it. If your child was already asleep **before** the window,
that sleep is counted and the night's timeline starts at the real bedtime rather than at the
setting. Either way it only happens when the camera saw the child actually **put into bed** —
a quiet room on its own is never read as a sleeping child, and neither is a *put-down* on its
own: the bed also has to go on showing signs of being occupied afterwards. A sleeping child is
never perfectly still for hours — they move a little, repeatedly — so a bed that stirs once and
then nothing is an empty one, and the bedtime it seemed to start is discarded. The same applies at the other end: a morning wake
is still found if it comes after the configured wake time.

Only movement **before the next put-down** counts towards that occupied-bed check: a later bedtime
never vouches for an earlier one. So a *put-down* the camera got wrong an hour or two before the
real one, with the bed empty in between, is discarded rather than reported as the bedtime (it used
to be accepted on the real bedtime's movement, and could even end the night in the evening when a
parent then left the room). A *got into bed* with recorded quiet in the minute either side of it (at
most a lone minute of movement, such as a parent reaching in) is not treated as a new put-down for
this. "Quiet" there means the same as everywhere else in the timeline: no movement in the bed, no
movement elsewhere in the picture, and no noise. There is no setting for any of it, and the numbers are
unchanged: at least 3 minutes with movement in the bed, however slight, in the 2½ hours after the
child settles.
**Known limits** (details, and the nights they come from, in [KNOWN-ISSUES.md](../KNOWN-ISSUES.md)):
- A very still child whose bedtime is followed by a second *got into bed* that is not quiet either
  side (a parent at the bed for a couple of minutes, the same put-down logged twice, or a one-minute
  check with a noise from elsewhere in the house beside it) before the bed has shown 3 such minutes
  loses that bedtime: the in-bed and asleep times move later, to that second event or after it.
  There is no grace period: this holds a few minutes after the child settles as much as an hour.
- The other way round: the **real** put-down, if it happens to be logged with quiet either side (a
  quiet house, a put-down that pauses), is not treated as a new put-down either, so a false earlier
  one is still believed, exactly as before this change.
- Where the false put-down is discarded but the real one settled after the window had already
  opened on a quiet evening, the **In bed** time can now show nothing on a night where it used to
  show the false put-down.
- The parent's approach in the minute or two before the real put-down still counts for a false
  earlier one, so a false put-down with exactly that much movement before the real one is still
  believed.
- The check needs the 2½ hours after a put-down to have been recorded. A put-down closer than that to
  the end of what has been recorded is believed without it: while a night is still in progress, a false
  put-down can show as tonight's bedtime for up to about 2½ hours after it, and the figures worked out
  after that use the full rule. The same is true of a night that has ended, for a put-down within 2½
  hours of the end of its window: a false one over an empty bed there is kept as the bedtime, and a real
  one after it is not looked at.
- Not fixed by this: a nap the child was lifted out of without waking can still be taken as the
  start of the night, and on a quiet evening (no household noise to break the stillness) an empty
  bed can still be read as a child asleep from the moment the window opens, for example when a
  discarded false put-down came first. That is still later, and closer to the truth, than the false
  put-down it replaces.

### Noise on its own doesn't delay bedtime

A bedroom microphone hears the whole house, and
bedtime is usually its loudest hour — a sibling being settled, a TV, adults talking. So when
working out **when your child fell asleep**, a noisy minute counts as awake only if that room
also *moved* at around the same time. The same holds for the **first half hour** after they
fall asleep, so the tail of the household's evening isn't reported as their first wake-up.
After that the rule stops: mid-night the house is quiet, so a cry with no movement counts as a
wake-up as you'd expect.

### Getting up for the day

The morning wake is the point the bed empties and stays empty, rather
than the last movement seen in it — otherwise a parent stripping the bed an hour later would be
reported as the child waking. A single stray minute of movement in an otherwise still bed (an adult
reaching in for a toy or a blanket) does not restart that count; several minutes together do, because
that is a person at the bed rather than a passing arm. The wake is only accepted where a recorded
**got out of bed** backs it up, so a quiet spell alone can never end the night early.

### A child who gets out and climbs straight back in has not got up

If a *got into bed* follows a
*got out of bed* shortly after, the night carries on rather than ending there — and so does a second
*got out of bed* logged within a minute of that return, because climbing back into a bed and leaving
it again inside a minute is one movement being read twice, not two trips. This matters most for a
very still sleeper: once they settle, their bed can look identical to an empty one for hours, so a
false exit shortly after bedtime would otherwise be reported as the end of the night.
That second *got out of bed* is only set aside when the bed then shows a **still sleeper**: at least 6
minutes of the slight movement a sleeping child makes (too small to count as the child moving) in the
2½ hours after the return. Bigger movement at the bed does not count, because after a child has
really got up that is a parent stripping the bed, tidying or reaching in: counting it once turned a
real early-morning wake into one more than two hours later.
A qualifying short trip can still be counted as a wake-up within that same continuing night — see
[How it estimates](#how-it-estimates). It can miss a trip that's interrupted by a data gap or a stray reading,
and it cannot tell an adult's visit to the bed from the child's own trip out of it.
**Known limit:** a genuine departure less than a minute after a *got into bed* is read the same way
when the bed then shows a still sleeper (6 or more of those minutes), because the two are not
distinguishable from what the cameras record. Where that is the only *got out of bed* of the night it
is still used, so the night is not left with no wake time (unless it is far earlier than your child
usually gets up: see [the next section](#an-exit-far-earlier-than-usual-does-not-end-the-night)); where
a later one exists, the later one is reported instead. A genuine departure followed only by a parent
at the bed (bigger movement) is no longer set aside: it is found.
**Known limit:** a child who climbs back in and then lies stiller than that (fewer than 6 minutes of
slight movement in those 2½ hours), or a camera whose detection zone only ever registers bigger
movement, is treated as having left at that second *got out of bed*: the wake is reported too
**early**, not left blank (again unless it is far earlier than usual, next section). The 6 was
measured on two cameras in one house, where the second exits that were the real wake showed 0-3 such
minutes and the ones a review confirmed were not showed 10 or more; see KNOWN-ISSUES.

### An exit far earlier than usual does not end the night

A sleeping child and an empty bed can look the same to the camera. So one false *got out of bed* in
the evening, followed by a child lying still, used to end the whole night there, and the card and the
morning notification could say "asleep 58 min" for a ten-hour night.

Now each possible wake is compared with **when this child usually gets up**: how long before the end
of the sleep window the wake times of their earlier saved nights were. A *got out of bed* much earlier
than that is not taken as the morning wake on its own.

- **Which nights:** the child's newest **14** saved nights that **have a wake time or a set-aside
  *got out of bed***, and **the same wake-time setting** (their window ended at the same time of day as
  tonight's). It needs at least **10**. A child with fewer is worked out exactly as before. That includes
  a new install, every child's first ten nights, and the nights after you change the child's wake time
  until ten nights at the new time have built up (going back to a wake time you used before counts the
  older nights again straight away). Nights saved as "no one in the bed" or "no data" are not counted at all.
- **How much earlier:** it takes the child's usual gap before the window ends (most of their nights,
  three in four, woke this close to the end or closer) and doubles it, but never uses less than
  **60 minutes**. A *got out of bed* further from the window's end than that is set aside. For a child
  who is usually up within 40 minutes of the window's end, the limit is 80 minutes.
- **It learns a new routine.** A night whose *got out of bed* was set aside still counts, with the
  time of that *got out of bed*, even if the night saved no wake time or a later one. So a child who
  has really started getting up earlier is set aside on about **4 nights** (up to 4 nights can show no
  wake time, or a late one), and from then on the limit has moved and the new time is taken. In a test
  of a child up about 75 minutes earlier than usual every day (105 minutes before the window ends
  instead of about 30), nights 1 to 4 were set aside and every night from the 5th was taken, also with
  the away nights in between saved as "no one in the bed".
- **These are fixed, not settings.** They were measured on two cameras in one house: the false exits
  were 3.2 to 17.5 times the child's usual gap, and every night a review confirmed was right was at most
  1.35 times it. A reasonable starting point for other homes, not a measurement of them.
- **What the night shows instead:** a later *got out of bed* can still be the wake, found the usual
  way. If there is none, the night keeps the wake worked out from movement alone, which is often none:
  the card and the detail page then say "still asleep at" the window's end, and the morning
  notification has no "up" time. Not right either, but closer than a night that ended in the evening:
  on the four measured nights, wake errors of 3 to 10 hours became a blank on one night and under
  2 hours on the other three. An improvement, not a fix, fitted to those four nights in one house.
- **For developers:** a night worked out fresh (`GET /api/children/:id/sleep/:date`, the Recompute
  preview and its save, and `/sleep/live` when it works last night out fresh) carries `wake_unconfirmed`:
  `null`, or `{ at, lead_min, threshold_min }` for the earliest *got out of bed* that was set aside where
  that changed the night (its time as recorded, how many minutes before the window's end it was, and the
  limit it went over). The saved night keeps only that time, in the column `sleep_nights.wake_unconfirmed_at`
  (`null` when nothing was set aside, and on nights saved before this). Because some readers return the
  whole saved row (`GET /api/children/:id/sleep`, `?stored=1`, and `/sleep/live` when it serves the saved
  last night), `wake_unconfirmed_at` appears in those answers as an **added** key: a fresh night carries
  `wake_unconfirmed`, a saved row carries `wake_unconfirmed_at`. Neither is in the notification or shown
  on the page.

**Known limits:**
- A child who **really is up for the day** that early, or who was **carried to a parent's bed**, in a
  room that goes quiet again afterwards, is treated the same way: the night reads as asleep until the
  window's end (or until a later *got out of bed*). Noise or movement in the room after the exit doesn't
  change that, because it is just as much a sign that the house is waking up. If it keeps happening, the
  rule learns it after about 4 nights (above); if it happens on **fewer than about 1 night in 4** (3 of
  any 14 or fewer), it stays the odd one out and is set aside **every time**. No such night is in the
  measured data. Correcting the night in the morning review fixes **that night only**: a correction is
  never read as history, so it does not teach the rule, and it locks the night.
- The other way round: when a real early *got out of bed* is set aside, a **later** one can become the
  wake (a parent handling the empty bed, or a false one), so the night is reported up hours late
  rather than blank.
- It relies on the saved nights **as they were saved**: whichever camera or rules produced them, and
  without your morning-review corrections. Nights saved with another wake time are left out. After you
  change the **timezone**, earlier nights are read in the new one: if their window end still shows the
  same time of day there (Melbourne to Sydney, both 07:00) they keep counting; if it shifts (Melbourne
  to Perth, where a Melbourne 07:00 reads 05:00) they are left out, and the rule is off until ten nights
  with the new time are saved. A clock change (daylight saving) does
  not: the comparison is on the local time. One exception: on the night a clock change makes the
  configured wake time not exist (a window ending 02:30 on the night the clocks go forward at 02:00
  ends at 03:30), that night has no matching history, so the rule is off for it, and that night is
  left out of later nights' history. A wake time in the repeated hour when the clocks go back matches as
  usual.
- False *got out of bed* events count too, whether they were saved as the wake (before this change) or
  set aside: **4 or more inside 14 nights** (3 when there are only 10 to 12 saved nights) make an early
  wake look usual and switch the rule off until they drop out of the last 14. Three inside 14 leave it
  on: in the house it was measured in, one child had three false exits in eight days (the fourth one
  measured was the other child's).
- Because a night's answer now depends on the nights before it, working out an earlier night again
  (or deleting one) can change a later night's answer, even though nothing about that later night
  changed.
- Nights already saved keep their figures until they are worked out again, and a night whose wake time
  was already sent in a notification is never cleared back to "still asleep" (a Recompute of it is
  refused, as before).

### When the motion camera samples

The movement timeline comes from a frame-by-frame motion leg that
reads the camera's low-resolution stream. When it runs depends on how the camera's motion is set up:

| Camera | When the leg runs |
|---|---|
| Frame-diff source with motion alerts on | around the clock (it is alerting anyway) |
| Motion alerts off, or motion from MQTT or ONVIF, on a camera assigned to a child who tracks sleep | only from **3 hours before the sleep window opens to 3 hours after it closes** |
| Not assigned to a child, or the child's sleep tracking is off | not at all (unless it alerts) |

The 3 + 3 hours are the same distance either side that the detector widens the window by (asleep times
are looked for from 3 hours before the window opens, wake-ups up to 3 hours after it closes). A camera
that stopped sampling sooner would never see a morning departure that comes after the window, and a
window that opens shortly after midnight (00:00 to 02:59) is sampled from the previous evening. The leg
starts and stops on the server's 5-minute check, so it begins up to 5 minutes after the 3-hour mark and
lingers 5 to 10 minutes after the closing one.
- **The cost:** about 3 hours more a day of one low-resolution video decode per such camera (15 hours a
  day becomes 18 for a 19:00-07:00 window). That is a relative figure; the extra CPU was not measured.
  A frame-diff camera with motion alerts on already runs all day and costs nothing extra.
- **What is not widened:** none of these is widened to 3 hours. The timelapse records only inside the
  sleep window itself. The live wake watcher (which also decides wake clips) uses the window plus 5
  minutes either side.
- **Known limits:** a departure later than 3 hours after the window closes is not seen by any camera, and
  for a camera of this kind the morning review has no recorded *got out / into bed* events after about
  3 hours past the window's end, because nothing past that point feeds the night's numbers.

## Correcting a night

### Tell it when it got a night wrong

The morning after, the child's page offers **Was last night right?** — one question: when they got
up. Tap it and the screen reads **Up at 6:37. Is that right?**
- **That's right** records that time as your answer. Two taps from the child's page.
- **Not quite** shows one time field, **Got up for the day**, to type the real time into, and
  **Save**.
- **No one was in the bed** (a small link under the buttons) says the whole night was wrong. See
  ["No one was in the bed" says the whole night was wrong](#no-one-was-in-the-bed-says-the-whole-night-was-wrong-not-just-a-time).
- **Change bedtime or fell-asleep time** (a collapsed section) holds **In bed**, **Fell asleep** and a
  note, for the rare night one of those is wrong. They start closed and are only recorded if you
  type in them; opening the section and leaving them alone records nothing. If the app found no
  wake-up time for the night at all, there is nothing to confirm, so the screen opens straight onto
  the time field with this section already open.

The prompt appears once per night and goes for good once answered **or dismissed** (the **x** on the
card); nothing is asked about nights with no times to confirm. Either an admin or a caregiver can
answer, deliberately — the person who was in the room at 5am is the one who knows. Type times on your
own clock; they are recorded against the timezone in Settings, the same one the sleep card displays.
- **Confirming that a night was right is worth as much as correcting one** — it is what makes a
  future change to sleep detection provable rather than arguable. Confirming and correcting are
  separate buttons on purpose: the time we guessed is never one stray tap from being recorded as
  fact.
- **A save records only what you answered.** A wake-only answer stores your wake-up time and nothing
  else: not the app's asleep time, as if you had said it. The receipt reads back the same way
  (**You said up at 6:37.**).

#### What is no longer asked

Until this version the review also asked you to mark each recorded *got into / out of bed* event
right, wrong or "can't tell" against its still frame, to say what a wrong one really was, and to
pick a frame to take a time from. Nobody was answering that many questions each morning, so it is
gone from the screen: there is no event list, no photos, no **Quick check-in?** or **Still moving?**
card and no **Before bedtime** group. Answers already saved are kept, and so is everything behind
the screen (the events are still recorded, and the old way of saving still works for a page that
was open when the app updated). The screen also no longer shows **Answered by**; the app still
records who last answered a night.

#### In bed and asleep are two different answers

Under **Change bedtime or fell-asleep time** you can give **In bed** (when they were put down) and
**Fell asleep**. On a night with a bedtime story they can be half an hour apart, and you can give
both. Both are optional, and each is recorded only if you type in it: the times the app guessed are
shown for you to edit, but they are never saved as yours unless you change them. "In bed" can't be
later than "Fell asleep"; the save is refused with a message if it is. If your review is left with
an in-bed time but no asleep time (you gave "In bed" on its own, or emptied "Fell asleep"), the
in-bed time is checked against the asleep time the app already has for the night instead, since
that is the one it will be shown next to. In the same way "Fell asleep" can't be later than "Got up
for the day", and an asleep time saved with no wake-up time is checked against the wake-up time the
app already has.

The check works the other way round too: **a wake-up time saved while your review has no asleep
time of its own is checked against the asleep time the app already has for the night.** This is the
check nearly every save meets now, because the screen asks only for the wake. Typing 18:37 for
06:37 is refused with a message instead of saving a night that ends before it began. A time typed
before 12:00 is read as the morning after, so a mistyped evening time is what it catches.

All of these allow one minute of slack (a time picked from a frame keeps its seconds, and a typed
time doesn't). They are checked against what you saved before as well as what you are saving now,
and a refused save stores nothing. They are checked only when a save gives or empties one of those
times: a note or a dismissal is never refused because the app's own night changed after you
answered.

#### The times wait for your timezone setting

Right after the page opens, the app may not have loaded the timezone set in Settings yet, and until
it has, the times on the page can be shown in the wrong zone (and saved that way). So the question,
**That's right**, **Not quite**, **Save** and the time fields stay greyed out (the question itself is
replaced by a line saying why) until it has loaded, usually a moment. **No one was in the bed**
doesn't involve a time and works straight away. If the setting can't be loaded at all, the line
becomes an error saying so and the times stay greyed out for that visit: reload the page. Every
time on this page, shown or typed, is in your **home** time (the timezone set in Settings), never
the time zone of the phone or browser you are using.

#### A night whose settings have changed

The review uses the same settings as the sleep detail page. For a finished night whose camera, timezone or
sleep window has changed since it was saved, the wake-up time it asks about (and the times under **Change
bedtime or fell-asleep time**) use the settings the night was saved with (see [Finished nights use the
settings they were saved with](#finished-nights-use-the-settings-they-were-saved-with)). So the time you
confirm is the one the child's card shows. Times are still shown, and typed, in today's timezone.
- If the settings for the night change while the review is open (someone edits the sleep window or the
  timezone, changes the camera, or the night is saved again), saving is refused: "The settings for this night
  changed while you were reviewing. Reload the page and check your times." Nothing is saved. **No one was in
  the bed** carries no time, so it is never refused for this. A review page that was open before this update
  isn't checked until it is reloaded.
- A night with no saved settings (not saved yet, or saved before nights recorded them) isn't checked this way
  either. If you change the sleep window or timezone, reload any review page that is already open.
- Times you type are read in the timezone set in Settings when you press save. A timezone change on a night
  already shown with its saved settings doesn't change those settings, so that save isn't refused, and times
  typed on a page opened before the change can land at the wrong hour. Reload the page after changing the
  timezone.

#### Your times become the ones shown

Once you correct a night, the child's card and the sleep
detail page both show *your* times, marked **You corrected this**, with the total
sleep recalculated to match wherever an asleep or wake-up time you saved differs from the one that
screen had (a time that is the same keeps that screen's own total). This is different from
**Recompute this night**, which re-runs the detector: correcting records what *you* know,
recomputing re-asks the *app*.
- A corrected **In bed** only moves the "in bed" time. Saving the review records only the times you
  answered: a wake-only answer stores your wake-up time, and the asleep time stays the app's. Where a
  time you saved is the one a screen was already showing, nothing about the sleep changes there: the
  total asleep, the wake-ups and the longest stretch stay what that screen had. The total is
  recalculated only where a time you saved differs from that screen's own, which is normally only
  when you changed it (but not always: see the
  [Known limits, all documented rather than fixed](#known-limits-all-documented-rather-than-fixed) about the review page and the card starting from different versions of the night).
  When you give an in-bed
  time, the card and the detail page show it next to the asleep time even if you corrected that too
  (they hide the *detector's* put-down beside a corrected asleep time, because it may belong to the
  bedtime you overruled). Either way it only shows when it is at least a minute before "asleep".

### A night you have corrected is locked

Once any correction is saved (an in-bed, asleep or wake
time, "No one was in the bed", or a plain **That's right**), the night's saved summary is complete:
the nightly update stops refining it and **Recompute this night** refuses it (the dialog says the
night is locked). Dismissing the card is not a correction and locks nothing. A note isn't a correction
either, but the review always saves a wake-up time with it (see [Your times become the ones
shown](#your-times-become-the-ones-shown)), so **a note saved from the review does lock the night**.
Only a note sent on its own through the API, or an event answer sent that way, locks nothing. This is
the same for every child and every install.

| | Before you correct a night | After |
|---|---|---|
| Nightly update (the ~3 hours after the window closes) | keeps refining the saved summary | leaves it alone |
| **Recompute this night** (admins) | can re-save it | refused: "locked because you corrected it" |
| Follow-up "Sleep report updated" push | can be sent once, within about 3 hours of the window closing | not sent |
| Sleep detail page | worked out fresh each time (once finished, with the settings it was saved with) | still worked out fresh each time, with the settings it was saved with and your times laid over it |
| Editing or removing your correction | — | always allowed |

**Recompute this night** (admins only) is on every night that was scored, including one that shows
**No one in the bed**, whether the detector scored it empty or you flagged it. It works the same way
there: the first press compares the saved summary with the current one and saves nothing, the second
saves. A flagged night is a corrected night, so it normally opens on "locked" until you remove the correction (once its saved summary is final, as described in [A night you have corrected is locked](#a-night-you-have-corrected-is-locked)). It is
not offered on nights with sleep tracking off. On a night that now shows no data or no clear sleep it is
offered only to re-score the night with the settings it was saved with, and only when those differ from
today's (see [Using the settings a night was saved with](#using-the-settings-a-night-was-saved-with)).

#### What gets locked is the night as it is when you save

If last night's saved summary was still
being refined (the first ~3 hours after the window closes), saving your correction first stores the
night freshly worked out at that moment, then locks it, so an early rough pass isn't what gets kept.
Any other night — an older one, or one whose summary had already settled — is locked as it is:
correcting it never re-scores it (only an admin's Recompute does that, and only on an unlocked
night). Later saves on a night that is already locked (changing your times, a note, an event
answer) never re-work it either.

#### Removing your last correction unlocks the night

While it is still "last night", the nightly
update then refines it once more if it had not finished doing so before you corrected it. Past the
~3 hours that pass only updates the saved summary: no "Sleep report updated" push goes out that late.

#### How to remove a correction (unlock a night)

Either:
  - an admin opens **Recompute this night** on the sleep detail page, which says the night is locked,
    and presses **Remove my correction** (it asks you to confirm first); or
  - for a night you marked "No one was in the bed", anyone opens the review (**Change what you told us
    about this night**) and presses **Someone was in the bed**.

  The review can still empty a time, for an admin or a caregiver: clear **Got up for the day** (and
  **Fell asleep** and **In bed** under **Change bedtime or fell-asleep time**), then **Save**. A
  cleared time is removed; one you leave alone is kept. Emptying all three removes the correction.
  **Remove my correction** is the admin's other route, and a save sent straight to the API that
  empties all three times does the same.

  The button **removes** the times you entered (or your "No one was in the bed" answer); it does not
  hide them, and nothing brings them back. Your answers to the individual events (and their reasons)
  and your note are kept, and so is the night's saved summary: the button only unlocks the night, it
  does not recompute it. Press **Recompute this night** afterwards to see the app's own figures beside
  the saved ones, which may be wrong (that is why you corrected the night). To keep a correction after
  that, enter your times again, and the night locks again when you save them. The one side effect:
  removing a "No one was in the bed" answer counts as answering the review, so a dismissed prompt
  returns and the review no longer names who removed it (the app still records it).

#### Known limits, all documented rather than fixed

  - A night corrected early (say 07:15, when the window closed at 07:00) keeps any time you did
    *not* correct at the value it had then. A detected wake-up that would have settled from 06:50
    to 07:15 an hour later stays at 06:50. Correct that time too if it matters (a wake-only answer
    leaves the app's asleep time as it had it).
  - "Freshly worked out at that moment" is the moment you press save, not the moment you opened the
    page. A detected wake-up keeps moving until about 10:00 as the morning's activity is taken into
    account, so on a page left open for a while the saved night can differ a little from what the
    page showed you. That saved version is the one that locks. (What the page showed is still
    recorded with your answer.)
  - A night corrected before its first summary was saved (possible from the sleep detail page in
    the first half hour after the window closes), or while that summary was still "no data", locks
    at the first real summary the nightly update saves after your correction. That update still
    sends the usual first sleep report and makes the night's timelapse. (Saving the correction does
    not save that summary itself, on purpose: the nightly update's first pass is the one that sends
    the report and makes the timelapse.) If that first summary says "no one in the bed" where a later
    one would have found your child, the night is still not looked at again (it is locked). If your
    correction has both an asleep and a wake-up time, the card and the detail page show it as a slept
    night anyway (see the #355 point on correcting such a night in [Known limits, all documented rather than fixed](#known-limits-all-documented-rather-than-fixed)); with only one of
    them it stays "no one in the bed". Remove your correction (while it is still last night) to let the
    nightly update look again. The night's timelapse frames are kept until then (until the next
    night's window closes), so if that look finds your child, the night still gets its timelapse
    ([recording.md](recording.md#retention-and-what-deleting-removes)). In the same way, if that
    first summary has no wake-up time yet (the morning's departure was still being confirmed when it
    was saved), the night keeps showing no wake-up time until you add one to your review.
  - The sleep detail page always works the night out fresh and lays your times over it, so its
    total asleep and wake-ups can differ a little from the locked summary on the child's card. That
    holds even though a locked night is shown with the settings it was saved with (see [Finished nights
    use the settings they were saved with](#finished-nights-use-the-settings-they-were-saved-with)):
    the page sees the whole morning's data, which a night locked early did not.
  - The review page starts from the night worked out fresh when you open it (with the same settings as
    the detail page), while the child's card shows the night as it was saved. When those differ (a page
    left open while the detected wake-up moved on, or an older night saved by an earlier version of the
    detector), the
    wake-up time you save unchanged is the review page's, so the card shows that and
    recalculates its total to fit it, even if you only marked **In bed**. The sleep detail page,
    which works the night out fresh, may keep its own total instead. Each screen's total always fits
    the times it shows; they just aren't always the same total.
  - **Correcting a night the app called "no one in the bed" makes it a slept night (#355).** Open the
    night on the sleep detail page and press **Was this night right?** (the morning card on the child's
    page never asks about such a night). Give both an asleep and a wake-up time and the night is shown
    as a normal night on the child's card, marked **You corrected this**, and on the sleep detail page,
    where the button then reads **Change what you told us about this night**. Your two times are taken
    as given: asleep = your wake-up minus your asleep time; wake-ups 0; awake 0; longest stretch =
    asleep. The app had measured no movement in the bed, which is what "no one in the bed" means, so 0
    wake-ups is what it saw, not a count of what happened. **Known limit:** minutes with no video are
    not subtracted on such a night, unlike on a night the app scored itself (next point), because the
    app found no sleep of its own to count them against, so it cannot tell whether a gap fell inside
    your times. If the cameras missed minutes inside the span you entered, they are counted as slept.
    The detail page has no minute-by-minute timeline or wake list for such a night (none was recorded).
    The saved summary is not rewritten: removing your correction brings back "no one in the bed"
    exactly. Compared with the other corrections:

    | | Night the app scored (slept) | Night the app called "no one in the bed" |
    |---|---|---|
    | Both times given | your times, total recalculated | becomes a slept night, with the figures described in the bullet above this table |
    | Only an asleep **or** only a wake-up time, or only **In bed** | your time laid over | stays "no one in the bed" (and locked); the night itself shows no times on the card or the detail page, and your time appears only in the "that's recorded" receipt and in the review |
    | Wake-up not after asleep | total floored at 0 | stays "no one in the bed" |
    | Night still in progress | your times laid over | stays as the cameras see it now |
    | **No one was in the bed** (your answer) | "no one in the bed" | "no one in the bed" (your answer always wins) |

    Only the child's card and the sleep detail page show such a night as slept: they lay your review over
    the night. Everything that reads the saved summary instead still sees "no one in the bed", because a
    correction never rewrites that summary (that is what lets removing it bring the night back, and why
    the lock works as before). So the morning report and push, which are built from the app's own
    summary, say "no one in the bed" for that night, even when you corrected it before they were sent;
    and the sleep ↔ temperature averages, which read only nights the app saved as slept, leave it out.
    That is deliberate (decided for #755), not an oversight. The averages compare room temperature with
    wake-ups, and a corrected "no one in the bed" night shows 0 wake-ups only because nothing was measured,
    not because none happened, so counting it would add an invented calm night. A report built over your own
    correction would also only repeat what you just typed.
    Only a "no one in the bed" night is promoted; "no data" and "no sleep" nights are not.
  - A corrected total still subtracts every unwatched minute the detector counted for the night,
    even ones outside your corrected times (the camera-outage limit under "Minutes with no video are
    unknown" in [KNOWN-ISSUES.md](../KNOWN-ISSUES.md)). Locking makes that figure stop changing; it
    does not make it exact.
  - Nights corrected **before 0.35.0** were locked, as they were last saved, from the moment that
    version was installed.
  - The sleep ↔ temperature averages read the detector's saved figures and never apply time
    corrections, locked or not (a night marked "No one was in the bed" is left out of them).
  - The app's own wake-up time, saved unchanged (**That's right**, or **Not quite** with the field
    left as the app had it), is saved as exactly the time the page showed, as long as it is
    a time the app could have worked out for that night. That means inside the child's sleep window
    widened the way the detector widens it: asleep times are looked for from 3 hours before the
    window opens, wake-ups up to 3 hours after it closes. The app's own times always are, unless the
    window was changed in Settings, or the app's timezone was, while the page was open. Any other time, including every **In
    bed** time, is dated by the clock alone: before 12:00 is the morning after the night's date, 12:00
    or later is the night's own evening. That is right for most nights, but not for a time that really
    belongs on the other side of that line: a wake-up you correct to after midday (a detected one can
    be, when the sleep window ends after 09:00), an asleep time you correct to before midnight on a
    window that opens just after midnight, or any time on a sleep window that crosses local midday
    (for example a night-shift family's 10:00 to 18:00). Typed, such a time lands on the wrong day,
    which shows up as "In bed can't be after Fell asleep" or "Fell asleep can't be after Got up for
    the day". That includes a time from an earlier save that the form shows again, because only the
    app's own times are matched. So once the app no longer has a night's after-midday wake-up itself,
    re-saving the review for that night saves it a day early, and is refused if the app has an asleep time
    for the night that the early wake-up now precedes (see [the wake-up time check](#time-validation-limits)). That is always
    the case on a night older than 30 days, whose minute-by-minute data is gone so the app has no times
    of its own for it, and on a newer night if the app's own wake-up has moved since you saved yours.
  - On the night the clocks go back, the hour that happens twice can't be told apart as an HH:MM. The
    app's own time in it, saved unchanged, keeps the occurrence the page showed. A time you type in
    that hour is read as whichever occurrence the timezone arithmetic lands on, which depends on the
    timezone: the second one at or east of UTC (Europe, Australia, New Zealand), the first one west of
    it (the Americas). Only a time inside that one hour, one night a year.
  - The checks against the times the app already has for the night (see [In bed and asleep are two
    different answers](#in-bed-and-asleep-are-two-different-answers)) use the night as it was saved when you press save. If last night's summary
    was still being refined, saving then stores it freshly worked out (see [What gets locked is the night as it is when you save](#what-gets-locked-is-the-night-as-it-is-when-you-save)), and in the rare
    case that moves the app's asleep time earlier than an in-bed time you gave without an asleep
    time (or its wake-up time earlier than an asleep time you gave without a wake-up time), the save
    still goes through, and the card then hides your in-bed time (or shows asleep after up). Giving
    both times avoids it.

##### Time validation limits

  - A wake-up time saved while your review has no asleep time is checked against the asleep time the
    app has stored for the night (see [In bed and asleep are two different answers](#in-bed-and-asleep-are-two-different-answers)).
    It is not checked when the app has no stored night yet, or a stored night with no asleep time:
    there is nothing to compare with, and a mistyped wake-up is saved. If last night's summary is
    still being refined when you save, the comparison uses the version stored before your save.
  - A save that empties just the wake-up time, beside an asleep time already in your review, is not
    checked against the app's wake-up time, so an asleep time after it can be left standing. The
    review screen can send that save (clear **Got up for the day** and **Save**).
  - Only just after updating to 0.35.0: a review page that was already open before the update has no **In
    bed** field. If it saves an asleep time earlier than an in-bed time someone else has since saved
    from an updated page, the save is refused ("In bed can't be after Fell asleep") and that old page
    has no way to show or change the in-bed time. Reload the page.

### The detector's own answer is kept underneath, not overwritten

That is deliberate — it is what a future improvement gets scored against. Nothing you enter here changes how sleep is detected.

### "No one was in the bed" says the whole night was wrong, not just a time

Under the usual buttons
is a small link for the case those don't fit at all — a night the detector scored as sleep, or as a wake
or two, when nobody was actually there. It changes the child's card and the sleep detail page to say
"You said no one was in the bed", the same way a time correction already shows your own times
instead of the detector's, and it is per night and per child — there's no house- or timezone-specific
assumption in it. **Someone was in the bed** undoes it and brings the detector's own night back.
- **What does and doesn't come back.** Undoing restores the detector's answer, but **not** any time
  you had typed before you flagged the night — flagging clears those, and they are gone for good.
  If you undo without typing anything new, the morning card then shows neither "ask" nor "done" for
  that night: this is a known limit of the undo, not a bug, and the way past it is to type the real
  times in again.
- **Unlike a night the detector itself scores empty, nothing is deleted.** That night's timelapse and
  any recorded transition frames are kept exactly as they would be for any other night. The flag is
  reversible, and a tap on this screen should never destroy video that undoing the tap could not
  bring back.
- **Excluded from the sleep ↔ temperature averages** on the sleep detail page, so a night that never
  happened can't drag those numbers around. A push notification already sent before you flag the
  night cannot be recalled, but the automatic follow-up telling you when they got up is skipped once
  you have.

### The card confirms it

After you answer, the prompt becomes a short receipt showing what you
said, and only that: a wake-only answer reads **You said up at 6:37.**, not a bedtime you never
gave. An answer that includes more reads them in the order they happen (**You said in bed 6:49,
asleep 7:13, up at 6:37.**). Tapping the receipt lets you change your mind.

### Any night can be reviewed, not just last night

The sleep detail page has **Was this night
right?** for whichever night you are looking at — that is how you correct a night you already
answered, since the card only ever offers nights you haven't. It is on every finished night shown as
slept or as "no one in the bed" (the card never asks about a "no one in the bed" night, so this is the
way to correct one, #355); a night still in progress, and a "no data" or "no sleep" night, have no
such button. Saving from there keeps you on that
night and shows the receipt in place, so working back through a run of nights doesn't send you to
re-pick the date each time. It asks the same single question as the morning card. A night the app
called "no one in the bed" has no wake-up time to confirm, so its review opens on the time field
with **Change bedtime or fell-asleep time** already open: give both times to make it a slept night
(a wake-up on its own leaves it "no one in the bed", see the table under the #355 point in
[Known limits, all documented rather than fixed](#known-limits-all-documented-rather-than-fixed)).

### Reviews are kept forever

Unlike the sleep minute-data behind them (30 days) or the recorded
events (45 days), reviews are kept forever. They are a few hundred bytes a night, and their whole value is being comparable
years later. A recorded event you have **judged** is also kept past the usual 45 days, along with
its frame, so a labelled picture is never deleted on a timer.

## Re-working out a night (admins)

A night's summary is worked out once, the morning after, and
then kept as it is — so if sleep detection is improved later, an already-recorded night keeps showing
the old answer while the detail view, which works the night out fresh each time you open it (always with
today's detection rules), shows the new one. **Recompute this night** on the sleep detail page reconciles
them. It compares what is *saved* — the summary on the child's page — against what the recorded movement
now says with today's settings (even when the page is showing the night with the settings it was saved
with; tick the option below to use those instead), and shows
you exactly what would change (bedtime, wake time, how long they slept, how many wake-ups) *before*
anything is saved. You can cancel. Admins only. **A night someone has corrected in the morning review
is locked and is not recomputed** — the dialog says so, and the API answers `409` with
`reason: "reviewed"`. Remove the correction first if the night really should be re-scored: the dialog
has a **Remove my correction** button for it (see [How to remove a correction](#how-to-remove-a-correction-unlock-a-night)).
**It can never make a night worse:** the minute-by-minute data behind a night is only kept for 30
days — the same span the date picker offers — so the oldest night you can browse sits right on that
edge. If its data has aged out, the recompute is refused and the saved summary is left alone, rather
than being replaced with "no data". The same refusal protects a night saved before a detection change
that would now come out "no data" for another reason — for example most of it had sound but no video.
(With today's settings the page only offers Recompute on a night that still scores, so that refusal is only
seen through the API, or after choosing the saved settings below; its 409 says which reason applied —
`reason`, `status`, `coverage_minutes` — see [KNOWN-ISSUES.md](../KNOWN-ISSUES.md), "Minutes with no video
are unknown in the sleep numbers".)

### Using the settings a night was saved with

Each saved night records what it was worked out from: which camera (by its id), the timezone, the sleep
window actually used, and the version of the detection rules. If the camera, timezone or window has changed
since (the camera was turned off, moved to another child or is no longer the main camera, the tiles were
rearranged, or the window or timezone was changed), the Recompute dialog offers **Use the settings this night
was saved with**, and says what changed ("Saved with: … Now: …").

**Default: off, every time the dialog opens.** Left off, Recompute works the night out with today's settings,
exactly as before. Ticked, the dialog shows the night worked out with the camera, timezone and window it was
saved with, beside the saved summary, and **Save the new numbers** saves that. This is what makes a night
whose camera has since been turned off re-scorable at all: with today's settings it reads "no data", so on
such a night (and on one that now reads "no clear sleep") the dialog offers only this choice.

| | Today's settings (the default) | The settings the night was saved with |
|---|---|---|
| Camera, timezone and sleep window | today's | the ones saved with the night |
| Detection rules | today's | today's too: rules can't be replayed |
| Room temperature and the alert list | today's cameras | today's cameras |
| A night that now reads "no data" or "no clear sleep" | not offered | offered, when its saved settings differ from today's |
| A night saved before nights recorded their settings | — | shown greyed out: "This night was saved before the app recorded its settings." |
| A record that can't be read | — | greyed out: "The settings saved with this night can't be read." |
| The saved camera has since been deleted | — | nothing is saved; the dialog says the camera no longer exists |
| A night you have corrected (locked) | refused | refused |
| Turning a scored night into "no data" | refused | refused |

The option does not appear when the saved settings are the same as today's (there is nothing to choose), or
when nothing is saved for the night yet. Nights saved before this was recorded have no record and are not
filled in after the fact; an older night gets one the next time it is saved (for example by the morning
update while it is still last night, or by a Recompute).

Known limits:
- **Last night can be re-saved with today's settings.** For about 3 hours after its window closes, the nightly
  update keeps refining last night's saved summary, and it always uses today's settings. A save with the saved
  settings in that time can be replaced on its next pass (every 30 minutes). To keep it, save once the night has
  settled, about 3 hours after the window closes.
- After any save the detail page goes back to its default view, which shows the night with the settings it was
  just saved with (see [Finished nights use the settings they were saved
  with](#finished-nights-use-the-settings-they-were-saved-with)).
- A camera that moved to another child during the night or the 3 hours either side of it is replayed with what
  it saw in its new room. One that moved later is replayed correctly.
- Whether sleep tracking is on follows today's setting.

For developers (the API behind the dialog, the detail page and the morning review):
- `GET /api/children/:id/sleep/:date?context=auto|stored|current`: `current`, or no `context`, is today's
  settings, as before. `auto` (reads only; the detail page sends it) uses the night's saved settings when the night
  is finished (the saved row's `window_end` has passed, and the night is not in progress under today's window),
  its `scoring_context` can be read, sleep tracking is on
  and the saved camera, timezone or window differ from today's, and today's otherwise. `stored` always uses the
  night's saved `scoring_context`; anything else is a `400`. A night with no usable record (no saved row, `null`,
  or a record that can't be read) answers `400` with `reason: "no_stored_context"` for `stored`. Like any read,
  the answer has a parent's correction laid over it; add `raw=1` (only with `context`) for the detector's own
  answer, which is what a save stores. When saved settings are used (`stored`, or `auto` when it applies) the
  answer carries `scoring: { source, algo, current_algo, algo_differs, problem }`.
- With `auto`, `current` or no `context`, a night for which `auto` would use the saved settings also gets
  `scoring_view: { applied, stored, current, camera_names, algo_differs }`: `applied` is `stored` or `current`
  (which settings this answer used), `stored` and `current` are the two settings, `camera_names` their cameras'
  names now (`null` for a deleted one). Any other night has no `scoring_view` and is unchanged.
- Add `store=1` (admins only; for anyone else it stays a read) to save it. `auto` cannot be saved (`400`): a
  save names its settings, `stored` or `current` (or no `context`, today's). The saved record is the night's
  camera, timezone and window with today's rules version. Refusals, in this order: `reviewed` (a corrected,
  locked night), `stored_camera_missing` (`409`: the saved camera has been deleted; nothing is saved), then the
  usual `would_downgrade` and wake-time refusals. `expect_context=<the scoring_context string you read>` makes
  the save answer `409` with `reason: "context_changed"`, saving nothing, if the night was saved again in the
  meantime; the dialog always sends it.
- The morning review, `GET /api/children/:id/review/:date`, makes the same choice as `auto` and adds
  `settings: { key, tz }`: `key` is the night's `scoring_context` string when its saved settings are used, else
  `""`, and `tz` is the timezone its event list was built in. A `PUT` that sends `settings_key` answers `409` with
  `reason: "settings_changed"`, saving nothing, when the key no longer matches; without `settings_key` nothing is
  checked.
- `?stored=1` also returns `contexts: { stored_state, stored, current, differs, camera_names }`, where
  `stored_state` is `none` (no record), `unreadable` or `ok`, and `differs` counts the camera, timezone and
  window but not the rules version. Camera names are looked up when asked (`null` for one that no longer
  exists). More in [architecture.md](architecture.md), "Data layer".

## Known limits

The limits are described beside the behaviour they affect:

- [Bedtime and put-downs](#bedtime-is-a-guide-not-a-boundary)
- [Getting up and returning to bed](#a-child-who-gets-out-and-climbs-straight-back-in-has-not-got-up)
- [An exit far earlier than usual](#an-exit-far-earlier-than-usual-does-not-end-the-night)
- [Motion camera sampling](#when-the-motion-camera-samples)
- [Review corrections and locks](#known-limits-all-documented-rather-than-fixed)
- [The detail page and a night's saved settings](#finished-nights-use-the-settings-they-were-saved-with)
- [Recompute with a night's saved settings](#using-the-settings-a-night-was-saved-with)
- [Video gaps on the detail page](#the-detail-view)
- [Room temperature comparisons](#room-temperature-optional)
