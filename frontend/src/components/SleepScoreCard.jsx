import { useState } from 'react';
import { Moon, ChevronRight } from 'lucide-react';
import Modal from './Modal.jsx';
import ScoreRing from './ScoreRing.jsx';
import {
  scoreOf, scoreQualifier, scoreLabel, componentName, componentDetail, droppedTerms, unavailableText, noScoreText,
  lowConfidenceText, cappedText,
} from '../lib/sleepScoreText.js';

// The sleep score on the sleep detail page (sleep score plan, phase 2): a card under the date navigator with the
// ring inside a real button, and the sheet that button opens, which shows how the number was made.
//
// IT FOLLOWS THE NIGHT OBJECT IT IS GIVEN, and keeps no copy. The detail page can swap the night under it (another
// date, the two-minute refresh, "Show with today's settings", a Recompute), and the score is part of that object
// (the server works it out from the exact night it returns), so the ring can never show one night's score beside
// another night's figures.
//
// WHAT IT SHOWS, by what `night.score` is:
//   absent  : the child's "Show sleep score" switch is off (the server leaves the key out). Nothing at all.
//   null    : scoring failed on the server. Nothing at all: there is nothing true to say.
//   { score: null, reason } : "No score yet" and the reason in plain words.
//   a score : the ring, the band word (or "Early estimate"), and the button to the breakdown.
// Tracking off (`status: 'off'`) shows nothing either: that page already says tracking is off.
//
// All wording comes from lib/sleepScoreText.js, which also holds the rule that an unknown key from a newer server
// never throws: an unknown component is skipped here, an unknown reason gets a neutral line.
export default function SleepScoreCard({ night }) {
  const [open, setOpen] = useState(false);
  if (!night || night.status === 'off') return null;
  const raw = night.score;
  if (!raw || typeof raw !== 'object') return null;

  const score = scoreOf(night);
  if (!score) {
    const why = noScoreText(raw.reason);
    return (
      <div className="card sleep-score">
        <div className="sleep-insight__title"><Moon size={15} aria-hidden="true" /> Sleep score</div>
        <div className="sleep-insight__body">No score yet.{why ? ` ${why}` : ''}</div>
      </div>
    );
  }

  const qualifier = scoreQualifier(score);
  // The saved night's score lent to a night that can no longer be drawn (attachScore, `score_source`).
  const fromSaved = night.score_source === 'stored';
  return (
    <div className="card sleep-score">
      <div className="sleep-insight__title"><Moon size={15} aria-hidden="true" /> Sleep score</div>
      {/* The ring is decorative, so the button's name carries the number. It ends with the visible text, so what a
          voice user says ("How this is scored") matches. The class sets a 44px minimum height (it is taller). */}
      <button type="button" className="sleep-score__open" onClick={() => setOpen(true)}
        aria-label={`Sleep score ${scoreLabel(score)}. How this is scored`}>
        <ScoreRing value={score.score} size="lg" surface="card" />
        <span className="sleep-score__text">
          {qualifier && <span className="sleep-score__band">{qualifier}</span>}
          <span className="sleep-score__how">How this is scored</span>
        </span>
        <ChevronRight size={18} aria-hidden="true" className="sleep-score__chev" />
      </button>
      {score.provisional && <div className="sleep-score__note">This score may still change this morning.</div>}
      {fromSaved && (
        <div className="sleep-score__note">
          The timeline for this night is no longer available. The score comes from the saved night.
        </div>
      )}
      {open && <ScoreBreakdown score={score} fromSaved={fromSaved} onClose={() => setOpen(false)} />}
    </div>
  );
}

// The sheet: one bar per part, then whatever qualifies the number, then what the score is.
function ScoreBreakdown({ score, fromSaved, onClose }) {
  // Unknown parts (a newer server) are skipped, not shown as a blank row.
  const parts = (Array.isArray(score.components) ? score.components : []).filter((c) => c && componentName(c.key));
  const capped = cappedText(score);
  const lowConfidence = lowConfidenceText(score);
  return (
    <Modal title={`Sleep score ${scoreLabel(score)}`} onClose={onClose}>
      <p className="sleep-score__lead">Each part is scored 0 to 100, then they are combined. A part that could not be measured is left out.</p>
      <ul className="score-parts">
        {parts.map((c) => {
          const counted = c.available && typeof c.score === 'number';
          const detail = counted ? componentDetail(c) : '';
          return (
            <li key={c.key} className="score-part">
              <div className="score-part__head">
                <span className="score-part__name">{componentName(c.key)}</span>
                <span className="score-part__score">{counted ? Math.round(c.score) : 'Not counted'}</span>
              </div>
              {counted && (
                <div className="score-part__bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} />
                </div>
              )}
              {counted
                ? detail && <div className="score-part__detail">{detail}</div>
                : <div className="score-part__detail">{unavailableText(c.reason)}</div>}
              {droppedTerms(c).map((line) => <div key={line} className="score-part__detail">{line}</div>)}
            </li>
          );
        })}
      </ul>
      {capped && <p className="sleep-score__note">{capped}</p>}
      {score.provisional && <p className="sleep-score__note">This score may still change this morning.</p>}
      {lowConfidence && <p className="sleep-score__note">{lowConfidence}</p>}
      {fromSaved && (
        <p className="sleep-score__note">The timeline for this night is no longer available. The score comes from the saved night.</p>
      )}
      <h3 className="sleep-score__about-title">About the sleep score</h3>
      <p className="sleep-score__about">
        The score compares this night with this child’s own recent nights. It is an estimate from what the camera and
        microphone observed, not a medical measurement, and it is not comparable between children or rooms.
      </p>
    </Modal>
  );
}
