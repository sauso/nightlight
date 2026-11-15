import { Moon } from 'lucide-react';

// The ring's stand-in for a night that has no score YET (UI refresh PR H, the approved "tonight in progress" and "no data"
// states): a dashed circle with a moon in it, the same size and groove as the xl ScoreRing so a card does not change shape
// when the score arrives in the morning.
//
// It carries NO number and NO band, on purpose. A ring with an empty arc or a "0" would read as "a score of nothing"; a dashed
// outline reads as "not there yet" by SHAPE, so it does not rely on colour. It is decorative (`aria-hidden`), like ScoreRing:
// the words beside it ("Score and night summary after 7:00 AM", "No sleep data for this night") say what it means.
//
// `surface` picks the same two colour sets as ScoreRing: 'dark' for the child page's navy hero card and the sleep page's night
// card (a fixed navy in both themes), 'card' for an ordinary `.card` (index.css, `.score-ring--pending`).
const BOX = 72;
const STROKE = 3;
// A thin dashed line rather than ScoreRing's 9px groove: the groove is the "filled to N" gauge, and this has nothing to fill.
const R = (BOX - STROKE) / 2;

export default function NightPendingRing({ surface = 'dark' }) {
  return (
    <svg className={`score-ring score-ring--pending score-ring--${surface === 'card' ? 'card' : 'dark'}`}
      width={BOX} height={BOX} viewBox={`0 0 ${BOX} ${BOX}`} aria-hidden="true" focusable="false">
      <circle className="score-ring__pending-track" cx={BOX / 2} cy={BOX / 2} r={R} fill="none" strokeWidth={STROKE} strokeDasharray="5 5" />
      <Moon className="score-ring__pending-icon" x={BOX / 2 - 12} y={BOX / 2 - 12} size={24} />
    </svg>
  );
}
