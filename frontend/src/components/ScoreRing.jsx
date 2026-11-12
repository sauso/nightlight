// The sleep score as a ring (sleep score plan, phase 2): an inline SVG arc filled to `value` out of 100, with the
// number in the middle. Presentational only: it knows nothing about nights, bands or wording.
//
// DECORATIVE, ON PURPOSE (`aria-hidden`). A ring drawn in SVG reads to a screen reader as nothing, or as a bare
// number with no meaning. The accessible text is always on the control AROUND the ring: the child card's button
// (SleepSummaryCard.jsx) and the "How this is scored" button (SleepScoreCard.jsx) both put the score in their name.
//
// ONE COLOUR, NO BAND COLOURS, NO MOUNT ANIMATION. The band is said in words beside the ring; colouring the ring
// red or green would turn a description into a verdict, on a screen a parent reads first thing in the morning. And
// motion here reports nothing (docs/design-language.md, section 7: motion is status, not decoration), so the arc is
// simply drawn where it ends.
//
// `surface` says what it sits on, because the two surfaces need different colours (index.css, `.score-ring`):
//   'card' : an ordinary `.card`. `--accent-line` on a `--border` track, the number in `--text-primary`.
//   'dark' : the child's hero card, a fixed dark gradient in BOTH themes. Literal colours there, see the stylesheet
//            for the measured contrast and why a theme token cannot be used.
//
// Sizes come from the type scale (design-language.md, section 3): 'sm' has a 15px number, 'lg' the 20px "large
// numeric readout". The viewBox is in real pixels, so the number is exactly that size.
const SIZES = {
  sm: { box: 44, stroke: 4, font: 15 },
  lg: { box: 64, stroke: 6, font: 20 },
};

export default function ScoreRing({ value, size = 'sm', surface = 'card' }) {
  // No number, no ring: never an empty circle or a "0" standing in for "unknown".
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const s = SIZES[size] || SIZES.sm;
  const shown = Math.max(0, Math.min(100, Math.round(value)));
  const mid = s.box / 2;
  const r = (s.box - s.stroke) / 2;
  const around = 2 * Math.PI * r;
  return (
    <svg className={`score-ring score-ring--${surface === 'dark' ? 'dark' : 'card'}`} width={s.box} height={s.box}
      viewBox={`0 0 ${s.box} ${s.box}`} aria-hidden="true" focusable="false">
      <circle className="score-ring__track" cx={mid} cy={mid} r={r} fill="none" strokeWidth={s.stroke} />
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
