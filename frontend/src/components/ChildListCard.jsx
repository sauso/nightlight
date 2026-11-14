import { ChevronRight, Cctv, Moon } from 'lucide-react';
import Avatar from './Avatar.jsx';
import ScoreRing from './ScoreRing.jsx';
import { ageLabel } from '../lib/age.js';
import { fmtDur } from '../lib/duration.js';
import { useLiveSleep } from '../lib/useLiveSleep.js';
import { scoreOf, scoreLabel, bandOf, bandWord } from '../lib/sleepScoreText.js';
import { childColorVars } from '../lib/childColors.js';

export default function ChildListCard({ child, cameraCount, onOpen }) {
  const data = useLiveSleep(child.id, { refreshMs: null });
  const age = ageLabel(child.birthday);
  const meta = `${cameraCount} camera${cameraCount === 1 ? '' : 's'}${age ? ` · ${age}` : ''}`;
  const night = data?.scope === 'off' ? null : data?.night;
  // Children list sleep: a missing duration cannot truthfully become a nightly total.
  const hasSleep = night?.status === 'ok' && night.asleep_minutes != null;
  const tonight = data?.scope === 'tonight' || night?.in_progress;
  const caption = tonight ? 'Tonight so far' : 'Last night';
  const duration = hasSleep ? `${fmtDur(night.asleep_minutes)} asleep` : '';
  const score = hasSleep && !tonight ? scoreOf(night) : null;
  const word = score ? (score.early_estimate ? 'Early' : bandWord(score)) : null;
  const label = hasSleep
    ? `${child.name}, ${meta}, ${caption} ${duration}${score ? `, Sleep score ${scoreLabel(score)}` : ''}`
    : undefined;

  // A 2px ring in the child's colour (owner, 2026-11-15), drawn by `.child-card--ringed` from `--child-ring`. The themed shade, so
  // it clears 3:1 on the card in both themes. A child with no usable colour keeps the plain card. Decorative: the ring adds no text
  // and the button's name is unchanged.
  const vars = childColorVars(child.color);
  return (
    <button
      type="button"
      className={vars ? 'child-card child-card--ringed' : 'child-card'}
      style={vars ? { '--child-ring': vars.ring } : undefined}
      onClick={onOpen}
      aria-label={label}
    >
      <span className="child-card__top">
        <Avatar name={child.name} src={child.photo} color={child.color} size={64} />
        <span className="child-card__id">
          <span className="child-card__name">{child.name}</span>
          <span className="child-card__meta"><Cctv size={13} aria-hidden="true" />{meta}</span>
        </span>
        <ChevronRight size={20} className="child-card__chev" aria-hidden="true" />
      </span>
      {hasSleep && (
        <span className="child-card__sleep">
          <span className="child-card__sleep-copy">
            <span className="child-card__sleep-caption"><Moon size={14} aria-hidden="true" />{caption}</span>
            <span className="child-card__sleep-duration">{duration}</span>
          </span>
          {score && (
            <span className="child-card__score">
              <ScoreRing value={score.score} size="sm" surface="card" band={bandOf(score)} />
              {word && <span className="child-card__score-word">{word}</span>}
            </span>
          )}
        </span>
      )}
    </button>
  );
}
