import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Moon, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { scoreOf, scoreLabel, bandOf, bandWord } from '../lib/sleepScoreText.js';
import { nightSummaryText } from '../lib/nightSummaryPhrases.js';
import ScoreRing from './ScoreRing.jsx';

// Sleep summary in the Child detail hero. Reads the LIVE endpoint: while a night is in progress it shows
// "Tonight · so far" (recomputed on demand, capped at now — so a morning wake shows within a minute or
// two of it happening), otherwise the last completed "Last night". A sleep-PATTERN estimate from
// movement + sound, never a medical claim. The whole card is a button into the Sleep detail page.
//
// ★ WHAT THIS CARD HOLDS (UI refresh PR C, 2026-11-13, the approved design): on a scored night only the label, the
// duration, ONE ring with its band word, and ONE headline. It used to carry the time range, wake-up count, longest
// stretch, an "In bed ... Asleep ..." line and the estimate disclaimer as well; all of those are on the sleep page
// (SleepDetail.jsx), which is one tap away, and a hero that says the same thing twice is the "wall of numbers" the redesign
// removed. The estimate/"not a medical measurement" line is the sleep page's one-line footer now, and "You corrected this"
// is the receipt under the card (MorningReviewCard.jsx). The wording of every state that is NOT a scored night is unchanged.

function fmtDur(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// `onBand` (optional): told the band colour key of the night shown (bandOf), or null when no score is shown, so the
// child page can tint its hero card (index.css, `.night--<band>`). Without it the card behaves exactly as before.
//
// `birthdaySet` (default true, so no other caller changes): false when the child has no birthday. It matters only for the
// quiet line under the card: a night with no score BECAUSE there is no birthday and no week of history yet is the one case
// where "add a birthday" is real information (the age figure is what scores such a night), and the child page no longer
// carries the old "Tap to add birthday & photo" invitation on the age line.
export default function SleepSummaryCard({ childId, onBand, birthdaySet = true }) {
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
  // The word inside the ring: the band word, "Early" for an early estimate (the full "early estimate" is in the button's
  // name; see ScoreRing), nothing under the lowest band. Colour is never the only signal, so a ring with a number always
  // says what the number means where it can.
  const ringWord = score ? (score.early_estimate ? 'Early' : bandWord(score)) : null;

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

  // The label above the duration: a small moon and the words. The moon marks "overnight sleep" the way it did when it sat
  // at the left of the card; one place for it so every state that has a label gets the same one.
  const head = (text) => (
    <div className="night__sleep-head"><Moon size={14} aria-hidden="true" />{text}</div>
  );

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
        {head('Tonight')}
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
        {head(tonight ? 'Tonight' : `Last night · ${fmtDate(night.night_date)}`)}
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
        {head(tonight ? 'Tonight' : `Last night · ${fmtDate(night.night_date)}`)}
        <div className="night__soon">
          {night.nobody_in_bed
            ? 'You said no one was in the bed.'
            : tonight ? 'No one in the bed.' : 'No one in the bed — nothing to report for this night.'}
        </div>
      </>
    );
  } else {
    // status ok. The date is not in the label any more ("Last night", as drawn): the card is always the latest night, and
    // the sleep page has the date navigator.
    body = (
      <>
        {head(tonight ? 'Tonight · so far' : 'Last night')}
        <div className="night__sleep-big">
          {fmtDur(night.asleep_minutes)} <span className="night__sleep-unit">asleep{tonight ? ' so far' : ''}</span>
        </div>
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

  // "Add a birthday" is shown ONLY for a night that has no score for want of one (the server's own reason key, the same one
  // the sleep page words as "...or a birthday in this child's settings") AND the child really has none. Anything else, a
  // score, no night, tracking off, a different reason, a birthday already set, is silent: the invitation used to sit on the
  // age line of every child without a birthday, scored or not, which is a nag where it carries no information.
  const needsBirthday = !birthdaySet && night?.status === 'ok' && night.score?.score == null && night.score?.reason === 'no_duration_reference';

  return (
    <>
      <button type="button" className="night__sleep night__sleep--btn"
        onClick={() => navigate(scope === 'off' ? `/children/${childId}/edit` : `/children/${childId}/sleep`)}
        aria-label={label}>
        <div className="night__sleep-row">
          <div className="night__sleep-body">{body}</div>
          {score && (
            <span className="night__score">
              <ScoreRing value={score.score} size="xl" surface="dark" band={band} word={ringWord} />
            </span>
          )}
          <ChevronRight size={18} aria-hidden="true" className="night__sleep-chev" />
        </div>
        {/* One line that ends in an ellipsis rather than wrapping. The full text is in the button's name above. */}
        {headline && <div className="night__headline">{headline}</div>}
      </button>
      {needsBirthday && (
        <button type="button" className="night__nudge" onClick={() => navigate(`/children/${childId}/edit`)}>
          Add a birthday in settings to see a score sooner
        </button>
      )}
    </>
  );
}
