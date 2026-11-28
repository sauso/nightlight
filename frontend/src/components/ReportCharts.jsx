import { Link } from 'react-router-dom';
import { formatDayKey } from '../lib/homeTime.js';
import { clockText } from '../lib/sleepScoreText.js';
import { driftDomain, slotLabel, slotName, spreadText } from '../lib/reportFormat.js';

// The two pictures on the weekly and monthly report page (issue #1236). Both are hand-rolled, no chart library, and both
// take a model that lib/reportFormat.js has already worked out: nothing here decides what counts, how a figure is worded or
// where a band falls.
//
// THE BAR CHART IS HTML, NOT SVG, ON PURPOSE. It is the same construction as the seven-night strip (SleepNightStrip.jsx): a
// bar is a `background` on an element, which is the one way the band tokens may paint (test/paletteTokens.test.jsx forbids a
// `--band-*` token for `color` and for SVG `fill`, because text must never take a band colour), and a real link per night is a
// real <a> rather than a hit area drawn over shapes. The drift chart has no band colour, so it is an SVG.

// ---- night by night -------------------------------------------------------------------------------------------------

// One slot per calendar date of the period, oldest first, from chartModel(report).slots.
//   bar   a counted night: a link to that night's page, its height the score (or the time asleep when there are no scores);
//   stub  a counted night without the figure the chart measures: still a link, drawn as a hollow stub, never as a height;
//   gap   a night that did not count: NOT a link, an empty slot with a dashed mark, never a zero-height bar. It is a labelled
//         image so the reason ("No one was in the bed") is spoken; the line under the chart (gapSummary) says it in print.
// The text alternative is each slot's own accessible name (figures or reason, starting with what the slot prints), so the
// chart is never the only way to read the numbers. Everything drawn inside a slot is aria-hidden: the name says it all.
//
// ⚠️ KNOWN LIMIT: a month has up to 31 slots, so on a 360px phone a bar is about 10px wide, under the 44px target the rest of
// the app keeps (docs/design-language.md). The slot runs the full height of the chart (about 150px tall) and the best and
// lowest nights are one wide tap each; a week's seven slots are about 44px wide.
export function NightBars({ childId, kind, slots }) {
  return (
    <ol className={`report-bars report-bars--${kind}`} aria-label={`Each night this ${kind}`}>
      {slots.map((slot, i) => {
        const label = slotLabel(kind, slot.date, i);
        const name = slotName(slot);
        const inner = (
          <>
            <span className="report-slot__track" aria-hidden="true">
              {slot.kind === 'bar' && (
                <span className={`report-bar ${slot.band ? `report-bar--${slot.band}` : 'report-bar--time'}`} style={{ height: `${slot.pct}%` }} />
              )}
              {slot.kind === 'stub' && <span className="report-bar report-bar--stub" />}
              {slot.kind === 'gap' && <span className="report-gap" />}
            </span>
            <span className="report-slot__label" aria-hidden="true">
              {label && <span>{label.top}</span>}
              {label?.bottom && <span>{label.bottom}</span>}
            </span>
          </>
        );
        return (
          <li key={slot.date} className="report-slot">
            {slot.kind === 'gap'
              ? <span className="report-slot__plain" role="img" aria-label={name}>{inner}</span>
              : <Link className="report-slot__link" to={`/children/${childId}/sleep?date=${slot.date}`} aria-label={name}>{inner}</Link>}
          </li>
        );
      })}
    </ol>
  );
}

// ---- bedtime and wake-up drift --------------------------------------------------------------------------------------

const W = 320;
const H = 112;
const PAD = { left: 52, right: 8, top: 8, bottom: 8 };

// One drift chart: a dot per counted night at its clock time, and the typical time as a dashed line inside a lightly shaded band.
// `field` is the night's own key ('onset_clock' | 'wake_clock'), `figure` the matching `summary` entry, `title` the words.
// The vertical axis is clock time with LATER AT THE TOP (so "15 minutes later" is an up arrow, as on the tiles), labelled in
// the viewer's own 12 or 24 hour form; the horizontal axis is the period's dates, the same slots as the bars above.
//
// NOT COLOUR ALONE: the dots have a ring, the typical value is a dashed LINE, the band is a shaded area with a legend in words,
// the axis is labelled, and the figures are in the tile above and in the hidden table below.
//
// ⚠️ THE BAND IS AN APPROXIMATION. The server sends the typical time and the SPREAD (the width of the middle half of the nights)
// but not the quartiles themselves, so the band is drawn as the typical time plus and minus half the spread. For a lopsided set
// of nights the true middle half sits off-centre by some minutes. The legend says "about".
export function DriftChart({ title, nights, field, figure }) {
  const dots = nights.map((n, i) => ({ i, date: n.date, value: n[field] })).filter((p) => Number.isFinite(p.value));
  const typical = figure?.ready && Number.isFinite(figure.value) ? figure : null;
  const domain = driftDomain(dots.map((p) => p.value), typical);
  if (!domain) return null;
  const count = nights.length;
  const x = (i) => PAD.left + ((i + 0.5) * (W - PAD.left - PAD.right)) / count;
  const y = (v) => PAD.top + ((domain.hi - v) / (domain.hi - domain.lo)) * (H - PAD.top - PAD.bottom);
  const halfSpread = typical && Number.isFinite(typical.spread) ? typical.spread / 2 : 0;
  const spread = typical ? spreadText(typical.spread) : null;
  const desc = typical
    ? `Typical time ${clockText(typical.value)}${spread ? `, ${spread}` : ''}. ${dots.length === 1 ? '1 night' : `${dots.length} nights`} shown.`
    : `${dots.length === 1 ? '1 night' : `${dots.length} nights`} shown. Too few nights for a typical time.`;
  const id = `report-drift-${field}`;
  return (
    <figure className="report-drift">
      <figcaption className="report-drift__title">{title}</figcaption>
      <svg className="report-drift__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{desc}</desc>
        {domain.ticks.map((t) => (
          <g key={t}>
            <line className="report-axis__line" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="report-axis__text" x={PAD.left - 6} y={y(t)} dy="0.35em" textAnchor="end">{clockText(t)}</text>
          </g>
        ))}
        {typical && halfSpread > 0 && (
          <rect className="report-drift__band" x={PAD.left} width={W - PAD.left - PAD.right} y={y(typical.value + halfSpread)} height={y(typical.value - halfSpread) - y(typical.value + halfSpread)} />
        )}
        {typical && <line className="report-drift__typical" x1={PAD.left} x2={W - PAD.right} y1={y(typical.value)} y2={y(typical.value)} />}
        {dots.map((p) => <circle key={p.date} className="report-drift__dot" cx={x(p.i)} cy={y(p.value)} r="4" />)}
      </svg>
    </figure>
  );
}

// The two drift charts and the words that explain them, as one card. Renders nothing when no night has either clock time, so a
// report that cannot draw them leaves no empty box. A visually hidden table lists every night's two times: the charts are
// pictures, and the table is the same numbers for a screen reader (the dots have no accessible names of their own).
export function DriftCard({ nights, summary }) {
  const has = (f) => nights.some((n) => Number.isFinite(n[f]));
  if (!has('onset_clock') && !has('wake_clock')) return null;
  const rows = nights.filter((n) => Number.isFinite(n.onset_clock) || Number.isFinite(n.wake_clock));
  return (
    <section className="card report-card" aria-labelledby="report-drift-h">
      <h2 className="card-heading" id="report-drift-h">Fell asleep and got up</h2>
      <p className="report-hint">Each dot is one night. The dashed line is the typical time, and the shaded band is about where half the nights fell. Later times are higher up.</p>
      <DriftChart title="Fell asleep" nights={nights} field="onset_clock" figure={summary.onset_clock} />
      <DriftChart title="Got up" nights={nights} field="wake_clock" figure={summary.wake_clock} />
      <table className="report-sr">
        <caption>Fell asleep and got up, night by night</caption>
        <thead><tr><th scope="col">Night</th><th scope="col">Fell asleep</th><th scope="col">Got up</th></tr></thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.date}>
              <th scope="row">{formatDayKey(n.date, { weekday: 'short', month: 'short', day: 'numeric' })}</th>
              <td>{clockText(n.onset_clock) ?? 'not known'}</td>
              <td>{clockText(n.wake_clock) ?? 'not known'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
