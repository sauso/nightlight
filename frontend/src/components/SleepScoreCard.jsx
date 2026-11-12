import { useContext, useState } from 'react';
import { Moon, ChevronRight } from 'lucide-react';
import Modal from './Modal.jsx';
import ScoreRing from './ScoreRing.jsx';
import { SettingsContext } from '../lib/SettingsContext.jsx';
import { nightSummaryText } from '../lib/nightSummaryPhrases.js';
import {
  scoreOf, scoreQualifier, scoreLabel, componentName, componentDetail, droppedTerms, unavailableText, noScoreText,
  lowConfidenceText, cappedText, bandOf,
} from '../lib/sleepScoreText.js';

// The night summary and the sleep score on the sleep detail page (sleep score plan, phases 2 and 3): a card under the
// date navigator. With a `summary` from the server it is the "Night summary" card: a headline, a few observations,
// and (when the child's switch shows the score) the ring inside a real button below them. Without a summary it is the
// phase 2 "Sleep score" card, unchanged. The button opens a sheet that shows how the number was made.
//
// IT FOLLOWS THE NIGHT OBJECT IT IS GIVEN, and keeps no copy. The detail page can swap the night under it (another
// date, the two-minute refresh, "Show with today's settings", a Recompute), and the score is part of that object
// (the server works it out from the exact night it returns), so the ring can never show one night's score beside
// another night's figures.
//
// WHAT IT SHOWS, by what `night.score` is:
//   absent  : the child's "Show sleep score" switch is off (the server leaves the key out). No score part; the
//             summary, if there is one, still shows.
//   null    : scoring failed on the server. No score part: there is nothing true to say about it.
//   { score: null, reason } : "No score yet" and the reason in plain words.
//   a score : the ring, the band word (or "Early estimate"), and the button to the breakdown.
// Tracking off (`status: 'off'`) shows nothing either: that page already says tracking is off.
//
// All wording comes from lib/sleepScoreText.js, which also holds the rule that an unknown key from a newer server
// never throws: an unknown component is skipped here, an unknown reason gets a neutral line.
export default function SleepScoreCard({ night }) {
  const [open, setOpen] = useState(false);
  // The home zone and temperature unit for the summary's times and room temperatures. Read from the context
  // directly, as useHomeTime does: a screen rendered outside a provider gets the defaults instead of a crash.
  const settings = useContext(SettingsContext)?.settings;
  if (!night || night.status === 'off') return null;
  const raw = night.score;
  const hasScore = Boolean(raw) && typeof raw === 'object';

  // THE NIGHT SUMMARY (phase 3): the same card, now led by a headline and a few observations from the server's
  // `summary`. Null (an older server, a failure, a night with nothing to say) leaves the card EXACTLY as it was
  // before the summary existed. A summary can be present with no score at all: the child's "Show sleep score"
  // switch hides the score, not the description of the night.
  const text = nightSummaryText(night.summary, { zone: settings?.timezone, tempUnit: settings?.temp_unit });
  if (!text && !hasScore) return null;

  const score = scoreOf(night);
  let scorePart = null;
  if (hasScore) {
    if (!score) {
      const why = noScoreText(raw.reason);
      scorePart = <div className="sleep-insight__body">No score yet.{why ? ` ${why}` : ''}</div>;
    } else {
      const qualifier = scoreQualifier(score);
      // The saved night's score lent to a night that can no longer be drawn (attachScore, `score_source`).
      const fromSaved = night.score_source === 'stored';
      scorePart = (
        <>
          {/* The ring is decorative, so the button's name carries the number. It ends with the visible text, so what a
              voice user says ("How this is scored") matches. The class sets a 44px minimum height (it is taller). */}
          <button type="button" className="sleep-score__open" onClick={() => setOpen(true)}
            aria-label={`Sleep score ${scoreLabel(score)}. How this is scored`}>
            <ScoreRing value={score.score} size="lg" surface="card" band={bandOf(score)} />
            <span className="sleep-score__text">
              {qualifier && <span className="sleep-score__band">{qualifier}</span>}
              <span className="sleep-score__how">How this is scored</span>
            </span>
            <ChevronRight size={18} aria-hidden="true" className="sleep-score__chev" />
          </button>
          {score.provisional && <div className="sleep-score__note">This score may still change.</div>}
          {fromSaved && (
            <div className="sleep-score__note">
              The timeline for this night is no longer available. The score comes from the saved night.
            </div>
          )}
          {open && <ScoreBreakdown score={score} fromSaved={fromSaved} onClose={() => setOpen(false)} />}
        </>
      );
    }
  }

  if (!text) {
    return (
      <div className="card sleep-score">
        <div className="sleep-insight__title"><Moon size={15} aria-hidden="true" /> Sleep score</div>
        {scorePart}
      </div>
    );
  }
  return (
    <div className="card sleep-score sleep-summary">
      <div className="sleep-insight__title"><Moon size={15} aria-hidden="true" /> Night summary</div>
      <p className="sleep-summary__headline">{text.headline}</p>
      {text.observations.length > 0 && (
        <ul className="sleep-summary__list">
          {text.observations.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
      {scorePart && <div className="sleep-summary__score">{scorePart}</div>}
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
      {score.provisional && <p className="sleep-score__note">This score may still change.</p>}
      {lowConfidence && <p className="sleep-score__note">{lowConfidence}</p>}
      {fromSaved && (
        <p className="sleep-score__note">The timeline for this night is no longer available. The score comes from the saved night.</p>
      )}
      <h3 className="sleep-score__about-title">About the sleep score</h3>
      <p className="sleep-score__about">
        {score.early_estimate
          ? 'Until there are enough recent nights to know what is usual for this child, the score is an early estimate that uses general figures instead.'
          : 'The score compares this night with this child’s own recent nights.'}
        {' '}It is an estimate from what the camera and
        microphone observed, not a medical measurement, and it is not comparable between children or rooms.
      </p>
    </Modal>
  );
}
