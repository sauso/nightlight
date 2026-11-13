// The sleep score as a ring (sleep score plan, phase 2): an inline SVG arc filled to `value` out of 100, with the
// number in the middle. Presentational only: it knows nothing about nights, bands or wording.
//
// DECORATIVE, ON PURPOSE (`aria-hidden`). A ring drawn in SVG reads to a screen reader as nothing, or as a bare
// number with no meaning. The accessible text is always on the control AROUND the ring: the child card's button
// (SleepSummaryCard.jsx) and the "How this is scored" button (SleepScoreCard.jsx) both put the score in their name.
//
// BAND-COLOURED ARC (owner approved the colour-scaled design, 2026-11-12; until then the ring was one colour, because
// a red or green ring can read as a verdict on a screen a parent sees first thing in the morning). It is acceptable now
// for three reasons that must keep holding: (1) COLOUR IS NEVER THE ONLY SIGNAL, the band word and the number are
// always shown beside it (an early estimate says "Early estimate"); (2) TEXT IS NEVER SET IN A BAND COLOUR, only the
// arc is, so the number stays `--text-primary` / white; (3) the low band is a soft rose, not an alarm red.
// `band` ('great' | 'good' | 'fair' | 'low' | 'early', from bandOf in lib/sleepScoreText.js) only picks a class. Absent or
// unknown means the old periwinkle arc, so a caller that does not pass one is unchanged.
// An early estimate (`band="early"`) is a NEUTRAL arc on a DASHED track: it reads as provisional by shape, with no
// colour needed, because the score is measured against an age figure rather than the child's own usual.
//
// NO MOUNT ANIMATION. Motion here reports nothing (docs/design-language.md, section 7: motion is status, not
// decoration), so the arc is simply drawn where it ends.
//
// `surface` says what it sits on, because the two surfaces need different colours (index.css, `.score-ring`):
//   'card' : an ordinary `.card`. `--band-*` (which switch with the theme) on a `--border` track, the number in `--text-primary`.
//   'dark' : the child's hero card, a fixed dark gradient in BOTH themes. `--band-*-ring` there (they do not switch), see
//            the stylesheet for the measured contrast and why a theme token cannot be used.
//
// Sizes come from the type scale (design-language.md, section 3): 'sm' has a 15px number, 'lg' the 20px "large
// numeric readout". The viewBox is in real pixels, so the number is exactly that size.
//
// STROKE WIDTH (design v3.1, 2026-11-13): the groove is thick enough (6px on 44, 9px on 64; it was 4 and 6) that the track
// and the arc read as a shape rather than a hairline, which is what lets the ring be told apart without relying on the arc's
// colour. Track and arc share one stroke so the arc is never thinner than the track. The canvas drew 7 to 11 and 8 to 12 on a
// 112px ring; this app's rings are 44 and 64px, so those widths are scaled to the same proportion of the ring, not copied.
// The number still fits: the inner diameter is 32px (sm) and 46px (lg) against a 15px and 20px two-digit number.
const SIZES = {
  sm: { box: 44, stroke: 6, font: 15 },
  lg: { box: 64, stroke: 9, font: 20 },
};

const BANDS = ['great', 'good', 'fair', 'low', 'early'];

export default function ScoreRing({ value, size = 'sm', surface = 'card', band }) {
  // No number, no ring: never an empty circle or a "0" standing in for "unknown".
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const s = SIZES[size] || SIZES.sm;
  const shown = Math.max(0, Math.min(100, Math.round(value)));
  const mid = s.box / 2;
  const r = (s.box - s.stroke) / 2;
  const around = 2 * Math.PI * r;
  const known = BANDS.includes(band) ? band : null;
  return (
    <svg className={`score-ring score-ring--${surface === 'dark' ? 'dark' : 'card'}${known ? ` score-ring--${known}` : ''}`}
      width={s.box} height={s.box} viewBox={`0 0 ${s.box} ${s.box}`} aria-hidden="true" focusable="false">
      {/* A dashed track marks an early estimate by shape, so it does not rely on the neutral colour alone. The dashes scale with
          the stroke (a fixed 2px dash on a 9px groove would be a row of slivers). */}
      <circle className="score-ring__track" cx={mid} cy={mid} r={r} fill="none" strokeWidth={s.stroke}
        strokeDasharray={known === 'early' ? `${s.stroke / 2} ${s.stroke / 2 + 1}` : undefined} />
      {/* Not drawn at 0: a round line cap would leave a dot that reads as "a little". Starts at 12 o'clock. */}
      {shown > 0 && (
        <circle className="score-ring__arc" cx={mid} cy={mid} r={r} fill="none" strokeWidth={s.stroke}
          strokeLinecap="round" strokeDasharray={`${(around * shown) / 100} ${around}`}
          transform={`rotate(-90 ${mid} ${mid})`} />
      )}
      <text className="score-ring__num" x={mid} y={mid} textAnchor="middle" dominantBaseline="central" fontSize={s.font}>
        {shown}
      </text>
    </svg>
  );
}
