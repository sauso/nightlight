import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { addDays } from '../lib/nightView.js';
import { scoreOf, bandOf } from '../lib/sleepScoreText.js';

// How many nights the strip shows. The design draws seven (a week); it is a layout width, not a score rule.
export const STRIP_NIGHTS = 7;

// How many nights are READ, once per child. The page's history window is 30 nights (SleepDetail's HISTORY_DAYS: what the
// activity data is kept for, and the calendar's range); the route allows up to 60. The strip shows seven at a time and slides
// over these, so walking back through older nights is a tap each (the previous / next arrows it replaced were one tap each).
export const STRIP_READ_NIGHTS = 30;

// The nights the strip shows, oldest first, as up to STRIP_NIGHTS calendar dates.
//   - `maxDate` is the newest night the page can show, `minDate` the oldest (the calendar's floor), `rows` the
//     /sleep?nights= answer, `selected` the night on screen.
//   - The strip never reaches back past the child's first stored night, so a new child sees the nights that exist and not a
//     row of empty ones (unless the selected night itself is older: it is always inside the strip, with a dash, and the
//     strip then reaches down to the calendar's floor so it can still be walked back).
//   - While the selected night is among the newest seven the window is the newest seven (the common case, and where the page
//     opens). A night older than that, picked from the calendar or by walking back, slides the window so the selected night is
//     in the CENTRE, clamped so the window stays inside the first and last available night: its neighbours are then one tap
//     away on both sides. A selected night outside the page's range (or none) leaves the newest-seven window.
//   - No rows at all (a new child, a bad answer) or no `maxDate` gives no strip.
export function stripDates(maxDate, minDate, rows, selected) {
  if (!maxDate || !Array.isArray(rows)) return [];
  const stored = rows.map((r) => r?.night_date).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!stored.length) return [];
  const first = stored.reduce((a, b) => (b < a ? b : a));
  const inRange = typeof selected === 'string' && selected <= maxDate && (!minDate || selected >= minDate);
  let lo = minDate && minDate > first ? minDate : first;
  // Older than the child's first stored night (a calendar pick before tracking began): the floor is the calendar's, so its
  // neighbours on both sides are in the strip (as dashes) and walking back stays one tap each.
  if (inRange && selected < lo) lo = minDate || selected;
  let end = maxDate;
  if (inRange && selected < addDays(maxDate, -(STRIP_NIGHTS - 1))) {
    end = addDays(selected, Math.floor(STRIP_NIGHTS / 2));
    if (addDays(end, -(STRIP_NIGHTS - 1)) < lo) end = addDays(lo, STRIP_NIGHTS - 1);
    if (end > maxDate) end = maxDate;
  }
  const out = [];
  for (let i = STRIP_NIGHTS - 1; i >= 0; i -= 1) {
    const d = addDays(end, -i);
    if (d >= lo) out.push(d);
  }
  return out;
}

// Weekday and day number in the viewer's own language, from the date string alone. Built at noon UTC and formatted in
// UTC so the day can never slip to a neighbour in any zone (the dates are already the app timezone's calendar dates).
const weekdayOf = (d) => new Intl.DateTimeFormat([], { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${d}T12:00:00Z`));
const dayOf = (d) => Number(d.slice(8, 10));
const monthDayOf = (d) => new Intl.DateTimeFormat([], { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`));

// The last seven nights as seven buttons: weekday, date, score and a 4px band bar (UI refresh PR E). Tapping one opens
// that night (`onSelect(date)`), the selected one carries aria-current="date". It replaces the previous / next arrows.
//
// ⚠️ IT IS A HEAT MAP BY DESIGN (the owner accepted this in the design review): seven coloured bars side by side invite comparing
// one night with another. No comparison wording is added, and the bar is never the only signal: the number (or a dash)
// is printed in the button and in its accessible name. The bar uses the same band keys as the ring (bandOf), so an early
// estimate shows its number with the neutral bar, and a night with no score a dash with the neutral bar.
//
// ⚠️ IT IS OPTIONAL. The page works without it, so while the request is in flight and when it fails the strip renders
// nothing at all (no spinner, no error line): a failed decoration must not read as a failed page. `version` is bumped by the
// page after a Recompute save so a re-scored night's bar does not go stale. The selected night is always in the strip and
// always marked; a night with no stored row shows a dash. One read per child (30 nights), sliced here: a tap makes no request.
export default function SleepNightStrip({ childId, maxDate, minDate, selected, onSelect, version = 0 }) {
  // The answer is kept WITH the child it was for, so a different child never wears the previous child's bars while its
  // own request is in flight; a `version` bump (same child) keeps the old bars on screen until the new answer lands.
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!childId) return undefined;
    let alive = true;
    // Additive use of the existing list route (stored nights, newest first, each with `score`): no server change.
    api.get(`/children/${childId}/sleep?nights=${STRIP_READ_NIGHTS}`)
      .then((r) => { if (alive) setData(Array.isArray(r?.nights) ? { childId, nights: r.nights } : null); })
      .catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [childId, version]);

  const rows = data?.childId === childId ? data.nights : null;
  const dates = stripDates(maxDate, minDate, rows, selected);
  if (!dates.length) return null;
  const byDate = new Map(rows.map((r) => [r?.night_date, r]));

  return (
    <div className="sleep-strip" role="group" aria-label="Recent nights">
      {dates.map((d) => {
        const score = scoreOf(byDate.get(d));
        const band = bandOf(score) || 'none';
        const shown = score ? String(Math.round(score.score)) : '–';
        // The name STARTS with what the button prints (WCAG 2.5.3, label in name): weekday, day number and the score, so a
        // voice-control user saying "Sat 14" or "Sat 14 82" matches. It was "Sat, Nov 14, score 82", which has the pieces but
        // never the printed text in order. A dash is a symbol, not a word anyone says, so a night with no score leads with
        // the weekday and day only. The month and the words follow for a screen-reader user.
        const lead = `${weekdayOf(d)} ${dayOf(d)}${score ? ` ${shown}` : ''}`;
        const name = `${lead}, ${monthDayOf(d)}, ${score ? `score ${shown}${score.early_estimate ? ' (early estimate)' : ''}` : 'no score'}`;
        return (
          <button key={d} type="button" className="sleep-strip__item" aria-label={name}
            aria-current={d === selected ? 'date' : undefined} onClick={() => onSelect(d)}>
            <span className="sleep-strip__day" aria-hidden="true">{weekdayOf(d)}</span>
            <span className="sleep-strip__date" aria-hidden="true">{dayOf(d)}</span>
            <span className="sleep-strip__score" aria-hidden="true">{shown}</span>
            <span className={`sleep-strip__bar sleep-strip__bar--${band}`} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
