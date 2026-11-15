// The one-tap "That's right" on the child page's night card (MorningReviewCard.jsx), and the time helper it shares with
// the review screen (pages/NightReview.jsx).

// UTC 'YYYY-MM-DD HH:MM:SS' -> the 'HH:MM' shown in the app's configured timezone: the same zone the cards render in, so
// the review and the thing it is correcting always agree. 24-hour form, because that is what a `<input type="time">`
// takes whatever the device's own clock format.
//
// The reverse direction is deliberately NOT done in the browser. The server resolves what was sent against the app
// timezone and the night's date, because that is where the timezone setting lives and where the DST-safe conversion is
// tested. Doing it here would use the phone's zone, so a review made while travelling would disagree with the card it was
// correcting. (Moved here unchanged from NightReview.jsx so the card and the screen cannot disagree on it.)
export function toLocalHhmm(utc, tz) {
  if (!utc) return '';
  const d = new Date(`${utc.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(d);
}

// A UTC 'YYYY-MM-DD HH:MM:SS' as whole minutes since the epoch, or null when missing or unreadable.
function utcMinute(utc) {
  if (typeof utc !== 'string') return null;
  const ms = Date.parse(`${utc.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 60000) : null;
}

// The request body for confirming the app's wake time WITHOUT opening the review screen, or null when the answer must
// come from that screen instead. `data` is GET /children/:id/review/:date; `shownWakeAt` is the UTC wake the card
// showed the person; `tz` is the app's REAL timezone (callers wait for the settings to load).
//
// ⚠️ THE BODY IS EXACTLY WHAT NightReview.jsx's "That's right" SENDS: the wake as wall-clock text plus what the person was
// shown (`computed_*`) plus the settings key, and NOTHING else. Every other key is omitted, not null: the server reads
// `undefined` as "keep what is stored" and null as "clear it", and the old confirm stored the detector's fell-asleep time
// as the parent's own answer (plan amendment 3, 2026-10-27). test/MorningReview.test.jsx pins the key set for both senders.
//
// WHEN IT RETURNS NULL (the person is sent to the review screen, which asks the right question):
//   - the screen has no wake to confirm (the night recomputed to nothing);
//   - the night already carries an answer (another phone got there first): a confirm must not overwrite it unseen. That is
//     BOTH a stored wake (`review.true_wake_at`) and "no one was in the bed" (`review.nobody_in_bed`, a raw 0/1 column here):
//     the screen shows the flag's own question INSTEAD of "That's right" (NightReview.jsx `nobody`), and saving a wake over it
//     clears the flag (sleepReviews.js), so a stale card must never do that. These are all of the screen's own conditions for
//     offering "That's right" (`!nobody && hasComputedWake && !true_wake_at && !range`); keep them in step with it;
//   - the screen would ask "Up between A and B" (`wake_range`: two estimates 10+ minutes apart). A pair cannot be
//     confirmed, "That's right" on it would record a time nobody checked, and the server deliberately keeps the range off
//     the child card (routes/children.js, GET /:id/review/:date). Any range at all sends them to the screen: that is
//     stricter than the screen's own same-side-of-noon test, which only costs one more tap on a rare night;
//   - the wake the screen would RECORD is not the one the card showed. The card reads the STORED night and the screen
//     recomputes (a wake can drift by 10 minutes or more while a night settles), and "That's right" must confirm the time
//     the person actually saw, to the minute. ⚠️ Compared as INSTANTS, never as wall-clock text: when clocks go back, two
//     instants an hour apart read the same (Australia/Melbourne 2026-04-05: 15:30Z and 16:30Z both show 02:30), and a card
//     showing the first could confirm the second. An instant that is missing or unreadable on either side is "not the same",
//     so the person is sent to the screen.
export function confirmWakeBody(data, tz, shownWakeAt) {
  const computed = data?.computed;
  if (!computed?.wake_at) return null;
  if (data.review?.true_wake_at || data.review?.nobody_in_bed) return null;
  if (data.wake_range?.from && data.wake_range?.to) return null;
  const same = utcMinute(computed.wake_at);
  if (same == null || same !== utcMinute(shownWakeAt)) return null;
  const wake = toLocalHhmm(computed.wake_at, tz);
  if (!wake) return null;
  return {
    true_wake_local: wake,
    computed_onset_at: computed.onset_at ?? null,
    computed_wake_at: computed.wake_at,
    settings_key: data.settings?.key,
  };
}
