import { useContext, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import Modal from './Modal.jsx';
import ScoreRing from './ScoreRing.jsx';
import { SettingsContext } from '../lib/SettingsContext.jsx';
import { nightBlurbText } from '../lib/nightSummaryPhrases.js';
import { formatInZone, TIME } from '../lib/homeTime.js';
import { showsInBed } from '../lib/inBed.js';
import {
  scoreOf, scoreQualifier, scoreLabel, componentName, componentDetail, droppedTerms, unavailableText, noScoreText,
  lowConfidenceText, cappedText, bandOf, bandOfValue, minutesText, clockText,
} from '../lib/sleepScoreText.js';

const ORDER = ['duration', 'continuity', 'settling', 'restlessness', 'consistency'];
// The nightly job rechecks the end of a window for three hours (sleepAnalysis.runNightlySleepJob).
// The server's provisional flag, rather than this offset, decides whether the note appears.
const PROVISIONAL_CHECK_HOURS = 3;
const measured = (n) => typeof n === 'number' && Number.isFinite(n);
const utcDate = (s) => {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const time = (s, zone) => {
  const d = utcDate(s);
  return d ? formatInZone(d, zone, TIME) : null;
};
const temp = (v, unit) => measured(v) ? `${Math.round(unit === 'F' ? v * 9 / 5 + 32 : v)}°${unit === 'F' ? 'F' : 'C'}` : null;

// Continuity's component.value is efficiency. The night also carries the measured wake count and
// longest stretch, which the approved row shows together without changing the score calculation.
function factorValue(c, night) {
  switch (c.key) {
    case 'duration': return minutesText(c.value);
    case 'continuity': {
      const wakes = measured(night.wake_count) ? `${night.wake_count} wake-up${night.wake_count === 1 ? '' : 's'}` : null;
      const stretch = minutesText(night.longest_stretch_minutes);
      return [wakes, stretch && `longest ${stretch}`].filter(Boolean).join(' · ');
    }
    case 'settling': return minutesText(c.value);
    case 'restlessness': return measured(c.value) ? `${c.value.toFixed(1)} min/h` : null;
    case 'consistency': {
      const onset = Array.isArray(c.terms) ? c.terms.find((t) => t?.key === 'onset' && t.available) : null;
      const at = onset ? clockText(onset.value) : null;
      return at ? `Asleep ${at}` : null;
    }
    default: return null;
  }
}

// A plain phrase accompanies every scored bar; the colour is never the only comparison.
function factorWord(c) {
  if (c.key === 'duration' && c.basis === 'span_vs_age') return 'Compared with age figure';
  if (c.key === 'duration' && measured(c.usual) && measured(c.value))
    return c.value < c.usual ? 'Less than usual' : c.value > c.usual ? 'More than usual' : 'About usual';
  if (c.key === 'continuity') {
    const wakes = Array.isArray(c.terms) ? c.terms.find((t) => t?.key === 'wake_count' && t.available) : null;
    if (wakes && measured(wakes.value) && measured(wakes.usual))
      return wakes.value > wakes.usual ? 'More wake-ups' : wakes.value < wakes.usual ? 'Fewer wake-ups' : 'About usual';
    return 'Wake-ups and longest stretch';
  }
  if (c.key === 'settling') {
    if (measured(c.usual) && measured(c.value))
      return c.value > c.usual ? 'Longer than usual' : c.value < c.usual ? 'Shorter than usual' : 'About usual';
    return 'Time to fall asleep';
  }
  if (c.key === 'restlessness' && measured(c.usual) && measured(c.value))
    return c.value > c.usual ? 'More stirring' : c.value < c.usual ? 'Less stirring' : 'About usual';
  if (c.key === 'consistency') {
    const onset = Array.isArray(c.terms) ? c.terms.find((t) => t?.key === 'onset' && t.available) : null;
    if (onset && measured(onset.value) && measured(onset.usual)) {
      // The server stores clock times since noon. Compare by the shorter way around midnight so
      // a time just past noon does not read as a day later than a time just before it.
      const delta = ((onset.value - onset.usual + 2160) % 1440) - 720;
      return delta > 0 ? 'Later' : delta < 0 ? 'Earlier' : 'About usual';
    }
    return 'Timing of sleep';
  }
  return 'Measured this night';
}

function nightNumbers(night, score, zone, unit) {
  const lines = [];
  const inBed = showsInBed(night) ? time(night.in_bed_at, zone) : null;
  const up = time(night.wake_at, zone);
  const outEvent = Array.isArray(night.transitions)
    ? night.transitions.find((t) => t?.type === 'out_of_bed') : null;
  const outBed = time(outEvent?.at, zone);
  if (inBed) lines.push(`In bed ${inBed}${outBed ? `, out of bed ${outBed}` : ''}`);
  else if (outBed) lines.push(`Out of bed ${outBed}`);
  const onset = time(night.onset_at, zone);
  if (onset && up) lines.push(`Asleep ${onset} to ${up}`);
  else if (onset) lines.push(`Asleep from ${onset}`);
  if (measured(night.wake_count)) lines.push(`${night.wake_count} wake-up${night.wake_count === 1 ? '' : 's'}${minutesText(night.awake_minutes) ? `, ${minutesText(night.awake_minutes)} awake in all` : ''}`);
  if (minutesText(night.longest_stretch_minutes)) lines.push(`Longest stretch ${minutesText(night.longest_stretch_minutes)}`);
  if (minutesText(night.asleep_minutes)) {
    const duration = Array.isArray(score.components) ? score.components.find((c) => c?.key === 'duration' && c.basis === 'asleep_vs_usual') : null;
    const usual = minutesText(duration?.usual);
    lines.push(`${minutesText(night.asleep_minutes)} asleep${usual ? `; usually ${usual}` : ''}`);
  }
  let facts = night.summary_facts;
  if (typeof facts === 'string') { try { facts = JSON.parse(facts); } catch { facts = null; } }
  const climate = facts?.climate ?? night.climate;
  const range = Array.isArray(night.summary?.observations)
    ? night.summary.observations.find((o) => o?.key === 'temperature_range')?.params : null;
  const min = temp(climate?.temp_min ?? range?.min_c, unit);
  const max = temp(climate?.temp_max ?? range?.max_c, unit);
  if (min && max) lines.push(`Room ${min} to ${max}`);
  if (night.analysis_camera_name) lines.push(`Measured from ${night.analysis_camera_name}`);
  const start = utcDate(night.window_start);
  const end = utcDate(night.window_end);
  if (measured(night.coverage_minutes) && start && end && end > start)
    lines.push(`Coverage ${Math.round(night.coverage_minutes / Math.max(1, Math.round((end - start) / 60000)) * 100)}%`);
  return lines;
}

// The ring, summary and sheet follow the same response object through date and settings changes.
export default function SleepScoreCard({ night, reviewAction = null }) {
  const [open, setOpen] = useState(false);
  const settings = useContext(SettingsContext)?.settings;
  if (!night || night.status === 'off') return null;
  const raw = night.score;
  const hasScore = Boolean(raw) && typeof raw === 'object';
  const score = night.in_progress ? null : scoreOf(night);
  const blurb = nightBlurbText(night.summary, { zone: settings?.timezone, tempUnit: settings?.temp_unit });
  if (!hasScore && !blurb && night.status !== 'ok') return null;
  const fromSaved = night.score_source === 'stored';
  const why = hasScore && !score ? noScoreText(night.in_progress ? 'in_progress' : raw.reason) : '';
  return (
    <div className="card night sleep-score sleep-night-card">
      <div className="sleep-night-card__main">
        {score && <ScoreRing value={score.score} size="xl" surface="dark" band={bandOf(score)} word={score.early_estimate ? 'Early' : scoreQualifier(score)} />}
        <div className="sleep-night-card__story">
          {measured(night.asleep_minutes) && <div className="sleep-night-card__duration">{minutesText(night.asleep_minutes)} asleep{night.in_progress ? ' so far' : ''}</div>}
          {score?.early_estimate && <div className="sleep-night-card__qualifier">Early estimate</div>}
          {blurb?.length > 0 && <p className="sleep-night-card__blurb">{blurb.join(' ')}</p>}
          {hasScore && !score && <p className="sleep-night-card__blurb">No score yet.{why ? ` ${why}` : ''}</p>}
          {score?.provisional && <p className="sleep-score__note">This score may still change.</p>}
          {fromSaved && <p className="sleep-score__note">The timeline for this night is no longer available. The score comes from the saved night.</p>}
        </div>
      </div>
      {score && <button type="button" className="sleep-score__open" aria-haspopup="dialog" onClick={() => setOpen(true)}
        aria-label={`Sleep score ${scoreLabel(score)}. Why this score?`}>Why this score? <ChevronRight size={18} aria-hidden="true" /></button>}
      {reviewAction && <div className="sleep-night-card__review">{reviewAction}</div>}
      {open && score && <ScoreBreakdown night={night} score={score} fromSaved={fromSaved} zone={settings?.timezone}
        unit={settings?.temp_unit} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ScoreBreakdown({ night, score, fromSaved, zone, unit, onClose }) {
  // Unknown keys from a newer server are skipped; known factors retain the approved order.
  const components = Array.isArray(score.components) ? score.components : [];
  const parts = ORDER.map((key) => components.find((c) => c?.key === key)).filter((c) => c && componentName(c.key));
  const capped = cappedText(score);
  const lowConfidence = lowConfidenceText(score);
  const end = utcDate(night.window_end);
  const finalAt = end ? formatInZone(new Date(end.getTime() + PROVISIONAL_CHECK_HOURS * 60 * 60 * 1000), zone, TIME) : null;
  const numbers = nightNumbers(night, score, zone, unit);
  return (
    <Modal title="Why this score?" onClose={onClose} wide>
      <ul className="score-parts">
        {parts.map((c) => {
          const counted = c.available && measured(c.score);
          const band = counted ? bandOfValue(c.score) : null;
          return <li key={c.key} className="score-part">
            <div className="score-part__head"><span className="score-part__name">{componentName(c.key)}</span>
              <span className="score-part__score">{counted ? factorValue(c, night) || `${Math.round(c.score)} / 100` : 'Not counted'}</span></div>
            <div className={`score-part__bar${band ? ` score-part__bar--${band}` : ' score-part__bar--empty'}`} aria-hidden="true">
              {counted && <span style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} />}
            </div>
            <div className="score-part__detail">{counted ? `${factorWord(c)} · ${Math.round(c.score)}/100` : unavailableText(c.reason)}</div>
            {counted && componentDetail(c) && <div className="score-part__detail score-part__detail--extra">{componentDetail(c)}</div>}
            {droppedTerms(c).map((line) => <div key={line} className="score-part__detail score-part__detail--extra">{line}</div>)}
          </li>;
        })}
      </ul>
      {numbers.length > 0 && <section className="sleep-score__numbers">
        <h3>The night in numbers</h3><ul>{numbers.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>}
      {score.provisional && <p className="sleep-score__note-box">This score may still change{finalAt ? ` until about ${finalAt}, while the end of the night is checked` : ''}.</p>}
      {score.early_estimate && <p className="sleep-score__note-box">Early estimate: until there are enough recent nights, duration uses a general figure for this age.</p>}
      {capped && <p className="sleep-score__note-box">{capped}</p>}
      {lowConfidence && <p className="sleep-score__note-box">{lowConfidence}</p>}
      {fromSaved && <p className="sleep-score__note-box">The timeline for this night is no longer available. The score comes from the saved night.</p>}
    </Modal>
  );
}
