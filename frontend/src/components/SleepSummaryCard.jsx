import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Moon, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { showsInBed } from '../lib/inBed.js';
import { scoreOf, scoreLabel, bandOf } from '../lib/sleepScoreText.js';
import { nightSummaryText } from '../lib/nightSummaryPhrases.js';
import ScoreRing from './ScoreRing.jsx';

// Sleep summary in the Child detail hero. Reads the LIVE endpoint: while a night is in progress it shows
// "Tonight · so far" (recomputed on demand, capped at now — so a morning wake shows within a minute or
// two of it happening), otherwise the last completed "Last night". A sleep-PATTERN estimate from
// movement + sound, never a medical claim. The whole card is a button into the Sleep detail page.

function fmtDur(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// `onBand` (optional): told the band colour key of the night shown (bandOf), or null when no score is shown, so the
// child page can tint its hero card (index.css, `.night--<band>`). Without it the card behaves exactly as before.
export default function SleepSummaryCard({ childId, onBand }) {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const tz = settings.timezone || 'UTC';
  const [data, setData] = useState(undefined); // undefined = loading; { scope, night } | null

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.get(`/children/${childId}/sleep/live`)
        .then((r) => { if (alive) setData(r || null); })
        .catch(() => { if (alive) setData(null); });
    load();
    // Refresh every few minutes so an in-progress night stays current (e.g. the morning wake appears).
    const t = setInterval(load, 3 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [childId]);

  const fmtTime = (utc) => {
    if (!utc) return '';
    const d = new Date(String(utc).replace(' ', 'T') + 'Z');
    return new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  };
  const fmtDate = (nightDate) => {
    if (!nightDate) return '';
    const d = new Date(String(nightDate) + 'T00:00:00');
    return new Intl.DateTimeFormat([], { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  };

  const scope = data?.scope;
  const night = data?.night;
  const tonight = scope === 'tonight';

  // The sleep score (sleep score plan, phase 2), only on a scored (`ok`) night that carries a NUMBER. Every other
  // case leaves the card exactly as it was before the score existed: a night in progress (`score.score` is null),
  // a night with no score, a failed score (null), and the child's "Show sleep score" switch off (no `score` key).
  const score = night?.status === 'ok' ? scoreOf(night) : null;
  const band = bandOf(score);

  // Report the band up for the hero card's tint, and clear it when the score goes away or the card unmounts, so a tint
  // never outlives the ring it belongs to (a child switch, a night that loses its score, a failed refresh).
  useEffect(() => {
    if (!onBand) return undefined;
    onBand(band);
    return () => onBand(null);
  }, [band, onBand]);

  // The night summary's headline (phase 3), ONE line on a scored (`ok`) night, under the duration. Null when the server
  // sent no summary (an older server, a failure), and the card is exactly as it was. It shows with the child's "Show
  // sleep score" switch off too: the switch hides the number, not the description of the night.
  const headline = night?.status === 'ok'
    ? nightSummaryText(night.summary, { zone: tz, tempUnit: settings.temp_unit })?.headline ?? null
    : null;

  let body;
  if (data === undefined) {
    body = <div className="night__soon">Loading sleep…</div>;
  } else if (scope === 'off') {
    body = (
      <>
        <div className="night__sleep-head">Sleep tracking is off</div>
        <div className="night__soon">Turn it on in this child’s settings to see their nightly sleep.</div>
      </>
    );
  } else if (!night || night.status === 'no_data') {
    body = tonight ? (
      <>
        <div className="night__sleep-head">Tonight</div>
        <div className="night__soon">Tracking tonight — sleep will show here once there’s enough overnight data.</div>
      </>
    ) : (
      <div className="night__soon">
        Once a camera with motion or sound detection runs overnight, last night’s sleep shows here.
      </div>
    );
  } else if (night.status === 'no_sleep') {
    body = (
      <>
        <div className="night__sleep-head">{tonight ? 'Tonight' : `Last night · ${fmtDate(night.night_date)}`}</div>
        <div className="night__soon">{tonight ? 'Not asleep yet.' : 'No clear sleep detected overnight.'}</div>
      </>
    );
  } else if (night.status === 'empty') {
    // Deliberately different from no_data: the cameras watched all night and saw the bed stay empty.
    // Saying "no one in the bed" is the honest answer — the old behaviour invented a full night's sleep.
    // `nobody_in_bed` splits it again, deliberately NOT `corrected` (code-review finding, 2026-09-29):
    // that wording claims the CAMERAS watched and saw an empty bed, which is only true for a night the
    // detector itself scored empty. A night a PARENT flagged instead is a statement about the child,
    // not the coverage — the cameras may have seen the whole night fine. `corrected` is too broad a
    // test for that: a plain TIME correction on a night already `status: 'empty'` also sets
    // `corrected: true` (sleepReviews.js's other `applyCorrection` branch), so it would tell a parent
    // who had only fixed a time that they had said no one was there — false. `nobody_in_bed` is true
    // ONLY on the flag path.
    body = (
      <>
        <div className="night__sleep-head">{tonight ? 'Tonight' : `Last night · ${fmtDate(night.night_date)}`}</div>
        <div className="night__soon">
          {night.nobody_in_bed
            ? 'You said no one was in the bed.'
            : tonight ? 'No one in the bed.' : 'No one in the bed — nothing to report for this night.'}
        </div>
      </>
    );
  } else {
    // status ok
    const head = tonight ? 'Tonight · so far' : `Last night · ${fmtDate(night.night_date)}`;
    let range;
    if (tonight) {
      range = night.wake_at
        ? `awake since ${fmtTime(night.wake_at)}`
        : `asleep since ${fmtTime(night.onset_at)}`;
    } else {
      range = night.wake_at
        ? `${fmtTime(night.onset_at)} – ${fmtTime(night.wake_at)}`
        : `from ${fmtTime(night.onset_at)} · still asleep at ${fmtTime(night.window_end)}`;
    }
    const bits = [range];
    if (night.wake_count != null) bits.push(`${night.wake_count} wake-up${night.wake_count === 1 ? '' : 's'}`);
    if (night.longest_stretch_minutes) bits.push(`longest ${fmtDur(night.longest_stretch_minutes)}`);
    // A second line, only on a night with a real gap between put-down and sleep (see showsInBed) — a
    // bedtime story, typically. Still asleep mid-night says "since", matching the line above it.
    let inBed = null;
    if (showsInBed(night)) {
      inBed = tonight && !night.wake_at
        ? `in bed since ${fmtTime(night.in_bed_at)}`
        : `In bed ${fmtTime(night.in_bed_at)} · Asleep ${fmtTime(night.onset_at)}`;
    }
    body = (
      <>
        <div className="night__sleep-head">{head}</div>
        <div className="night__sleep-big">{fmtDur(night.asleep_minutes)} asleep{tonight ? ' so far' : ''}</div>
        {/* One line that ends in an ellipsis rather than wrapping: the ring narrows this column on a 375px screen. */}
        {headline && <div className="night__headline">{headline}</div>}
        <div className="night__soon">{bits.join(' · ')}</div>
        {inBed && <div className="night__inbed">{inBed}</div>}
        {/* Say plainly when these are the times a PERSON gave us rather than the ones we worked out.
            Without it, a corrected card is indistinguishable from a detector that suddenly got it
            right — and the estimate disclaimer below would be a lie about where the number came from. */}
        {night.corrected ? (
          <div className="night__est"><span className="sleep-corrected">You corrected this</span></div>
        ) : (
          <div className="night__est">Estimated from movement &amp; sound{score ? ', the score included' : ''} — not a medical measurement.</div>
        )}
      </>
    );
  }

  // The whole card is a button into the Sleep detail page (timeline + wake breakdown + date picker).
  // Clickable even with no data, so you can still browse other nights via the date picker there.
  //
  // ⚠️ The `aria-label` REPLACES everything inside the button for a screen reader, and the ring is decorative, so
  // the score has to be said here or it is not said at all: "…history. Sleep score 82, Good" (the number alone
  // under the lowest band; "early estimate" in place of a band word). With no score the label is what it always was.
  // The headline is said too (phase 3), after the destination and before the score: "…history. A fairly steady night
  // overall. Sleep score 82, Good". Its own full stop is dropped so the label does not carry two.
  const label = scope === 'off'
    ? 'Turn on sleep tracking in settings'
    : `View sleep detail and history${headline ? `. ${headline.replace(/\.$/, '')}` : ''}${score ? `. Sleep score ${scoreLabel(score)}` : ''}`;
  return (
    <button type="button" className="night__sleep night__sleep--btn"
      onClick={() => navigate(scope === 'off' ? `/children/${childId}/edit` : `/children/${childId}/sleep`)}
      aria-label={label}>
      <Moon size={18} aria-hidden="true" />
      <div className="night__sleep-body">{body}</div>
      {/* Beside the duration line. The card is a fixed dark gradient in both themes, hence `surface="dark"`. */}
      {score && <span className="night__score"><ScoreRing value={score.score} size="sm" surface="dark" band={band} /></span>}
      <ChevronRight size={18} aria-hidden="true" className="night__sleep-chev" />
    </button>
  );
}
