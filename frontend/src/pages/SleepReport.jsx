import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowRight, ArrowUp, ChevronLeft, ChevronRight, Minus, Moon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import LoadFailed from '../components/LoadFailed.jsx';
import NavRow from '../components/NavRow.jsx';
import { DriftCard, NightBars } from '../components/ReportCharts.jsx';
import { bandOfValue, bandWord, minutesText } from '../lib/sleepScoreText.js';
import { formatDayKey } from '../lib/homeTime.js';
import {
  FIGURE_TILES, canGoNext, canGoPrevious, changeText, chartModel, gapSummary, localeWeekStart, nextPeriodDate,
  periodTitle, periodWord, previousPeriodDate, readReportParams, reportApiPath, reportQuery, spreadText, typicalText,
} from '../lib/reportFormat.js';

// The weekly and monthly sleep report (issue #1236): how a child slept over a calendar week or month, beside the period before
// it. READ-ONLY: the one request is GET /api/children/:id/sleep/report (any signed-in user, an admin and a caregiver alike).
// What counts as a night, the medians and the comparison are the SERVER's (backend/src/lib/sleepReport.js, described in
// docs/sleep-tracking.md "Weekly and monthly reports"); this page draws the answer and words it (lib/reportFormat.js). It
// invents no figure and repeats no rule of the server's, so the 3-night minimum, the "steady" floors and the 80% coverage are
// read as `ready`, `direction` and `status_class`, never restated.
//
// THE ADDRESS IS THE STATE. `?period=week|month&date=YYYY-MM-DD` in the hash route (`#/children/3/reports?period=month&date=
// 2026-10-01`), so a link works and the browser's Back button steps through the periods you looked at. No `date` means today,
// and TODAY IS THE SERVER'S: it works it out in the app's timezone, so this page never guesses it from the device clock or from
// a settings value that may not have loaded yet (docs/design-language.md, "Times are home time"). The arrows take their target
// from the answer's own bounds (the day before `from`, the day after `to`), so the week and month arithmetic is done once, on
// the server.
//
// WITH NO PDF YET: the heading row has room for one more button on its right (a later change adds Download); nothing renders there.

const KIND_BUTTONS = [{ kind: 'week', label: 'Week' }, { kind: 'month', label: 'Month' }];

const TREND_ICON = { up: ArrowUp, down: ArrowDown, steady: ArrowRight, none: Minus };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A report is only drawn from an answer that has the pieces this page reads; anything else is shown as a failure, not as
// a half-empty page (a proxy's HTML error page that came back with a 200 parses as null, for one).
function isReport(r) {
  return Boolean(r) && typeof r === 'object' && r.period && typeof r.period.from === 'string' && typeof r.period.to === 'string'
    && r.summary && typeof r.summary === 'object' && Array.isArray(r.nights);
}

export default function SleepReport() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { kids } = useCameras();
  const kid = kids.find((k) => k.id === id);
  const { kind, date } = readReportParams(searchParams);
  // The viewer's own first day of the week, once per mount (the locale does not change under an open page).
  const weekStart = useMemo(() => localeWeekStart(), []);
  const [retry, setRetry] = useState(0);
  // The answer, KEPT WITH THE REQUEST IT WAS FOR (`key`). The page draws it only while its key is the current request's, so
  // a period that is still loading never wears the previous period's figures under its own title.
  const [view, setView] = useState({ key: null });
  const key = `${id}|${kind}|${date ?? ''}|${weekStart}|${retry}`;

  useEffect(() => {
    // ⚠️ A SUPERSEDED REQUEST MUST NOT OVERWRITE THE NEWER ANSWER. Week / Month and a Retry can start a second request while the
    // first is still out, and the first can come back SECOND (a slow week, a fast month). Cleanup flips `alive`, so the late
    // answer of the old request is dropped whichever way it settles, and the abort frees its connection. Without the flag
    // the week would land after the month and the page would show a week under the Month button.
    let alive = true;
    const controller = new AbortController();
    api.get(reportApiPath(id, { kind, date, weekStart }), { signal: controller.signal })
      .then((r) => {
        if (!alive) return;
        setView(isReport(r) ? { key, report: r } : { key, error: 'The server sent an answer this page could not read.' });
      })
      .catch((err) => { if (alive) setView({ key, error: err?.message || 'Request failed' }); });
    return () => { alive = false; controller.abort(); };
    // `key` is built from exactly these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind, date, weekStart, retry]);

  const current = view.key === key ? view : null;
  const report = current?.report ?? null;
  const loading = !current;
  const empty = Boolean(report) && report.earliest_night_date == null;

  const go = (next) => setSearchParams(next);
  const pickKind = (next) => { if (next !== kind) go(reportQuery(next, date)); };

  const back = { to: `/children/${id}`, label: kid?.name || 'Child' };
  const prevOk = Boolean(report) && !empty && canGoPrevious(report);
  const nextOk = Boolean(report) && !empty && canGoNext(report);
  const word = periodWord(kind);

  return (
    <>
      <AppHeader title="Reports" back={back} />
      <main className="app-main report-page">
        {!empty && (
          <div className="report-controls">
            <div className="report-controls__row">
              <div className="seg-track report-seg" role="group" aria-label="Report length">
                {KIND_BUTTONS.map((b) => (
                  <button key={b.kind} type="button" className={`seg-track__btn${kind === b.kind ? ' seg-track__btn--active' : ''}`}
                    aria-pressed={kind === b.kind} onClick={() => pickKind(b.kind)}>{b.label}</button>
                ))}
              </div>
              {/* The room for the Download button (a later change). Nothing renders here yet. */}
              <div className="report-controls__actions" />
            </div>
            <div className="report-nav">
              <button type="button" className="report-nav__btn" aria-label={`Previous ${word}`} disabled={!prevOk}
                onClick={() => go(reportQuery(kind, previousPeriodDate(report.period)))}>
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
              <h2 className="report-nav__title" aria-live="polite">
                {report ? periodTitle(kind, report.period.from, report.period.to) : (loading ? 'Loading…' : '')}
              </h2>
              <button type="button" className="report-nav__btn" aria-label={`Next ${word}`} disabled={!nextOk}
                onClick={() => go(reportQuery(kind, nextPeriodDate(report.period)))}>
                <ChevronRight size={20} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {/* Loading, failed and empty are three different screens (docs/design-language.md, #375): none of them stands in for another. */}
        {loading && <div className="card"><div className="empty-state" role="status">Loading report…</div></div>}
        {current?.error && <LoadFailed what="this report" error={current.error} onRetry={() => setRetry((n) => n + 1)} />}
        {empty && <EmptyReport />}
        {report && !empty && <ReportBody report={report} kind={kind} childId={id} />}
      </main>
    </>
  );
}

// The child has no saved night at all (the server's `earliest_night_date` is null), which is not a failed request and not a
// quiet week: nothing has been recorded yet, so there is nothing to step through.
function EmptyReport() {
  return (
    <div className="card">
      <div className="empty-state">
        <strong>No nights yet</strong>
        <p>Reports appear after the first night is recorded. Once there is a night of sleep, you can see how each week and month went here.</p>
      </div>
    </div>
  );
}

function ReportBody({ report, kind, childId }) {
  const { summary, comparison, nights } = report;
  const model = useMemo(() => chartModel(report), [report]);
  const gaps = gapSummary(model.slots);
  const word = periodWord(kind);
  const tiles = FIGURE_TILES.filter((t) => summary[t.key] != null);
  // "Not enough nights": no figure of the report is ready. The chart and its gaps are still drawn, so the person can see WHY.
  const insufficient = !tiles.some((t) => summary[t.key]?.ready && typicalText(t.key, summary[t.key].value) !== null);
  const counted = Number.isFinite(summary.nights_counted) ? summary.nights_counted : 0;
  const inPeriod = Number.isFinite(summary.nights_in_period) ? summary.nights_in_period : 0;
  // Only a note this build knows is shown; a code it does not know is ignored (forward compatible, see docs).
  const contextChanged = Array.isArray(report.notes) && report.notes.includes('context_changed');

  return (
    <>
      {report.period.complete === false && (
        <p className="report-note" role="status">
          {inPeriod > 0
            ? `So far: ${counted} of ${plural(inPeriod, 'night', 'nights')}. This ${word} is still running, and its figures can change.`
            : `So far: no nights have finished yet this ${word}.`}
        </p>
      )}
      {contextChanged && (
        <p className="report-note">
          The camera or sleep window changed within this and the previous {word}, so some comparisons may not be like for like.
        </p>
      )}

      {insufficient ? <Insufficient counted={counted} inPeriod={inPeriod} word={word} /> : (
        <>
          <section aria-labelledby="report-typical-h">
            <h2 className="section-title" id="report-typical-h">A typical night</h2>
            <dl className="report-tiles">
              {tiles.map((t) => <Tile key={t.key} spec={t} figure={summary[t.key]} comparison={comparison?.[t.key]} />)}
            </dl>
            <p className="report-hint">
              {report.previous
                ? `Changes are against ${periodTitle(kind, report.previous.from, report.previous.to)}.`
                : `There is no earlier ${word} with saved nights to compare with.`}
            </p>
          </section>
          <Extremes summary={summary} childId={childId} />
        </>
      )}

      <section className="card report-card" aria-labelledby="report-nights-h">
        <h2 className="card-heading" id="report-nights-h">Night by night</h2>
        <p className="report-hint">
          {model.mode === 'score' ? 'Bar height is the sleep score, and its colour is the score band.' : 'Bar height is the time asleep.'}
          {' '}Tap a night to open it. A dashed mark is a night that did not count.
        </p>
        <NightBars childId={childId} kind={kind} slots={model.slots} />
        {gaps && <p className="report-hint report-hint--after">{gaps}</p>}
      </section>

      <DriftCard nights={nights} summary={summary} />

      <div className="report-est">
        <Moon size={13} aria-hidden="true" /> Estimated from movement &amp; sound over each night window — a sleep-pattern guide, not a medical measurement.
      </div>
    </>
  );
}

function Insufficient({ counted, inPeriod, word }) {
  return (
    <div className="card report-insufficient" role="status">
      <h2 className="card-heading">Not enough nights yet</h2>
      <p>
        {counted > 0
          ? `Only ${plural(counted, 'night', 'nights')} counted${inPeriod > 0 ? ` of ${inPeriod}` : ''} this ${word}, which is too few to say what a typical night was.`
          : `No night counted this ${word}, so there is no typical night to show.`}
        {' '}A night counts once it is over and the camera watched most of it. The chart below shows each night and why any did not count.
      </p>
    </div>
  );
}

// One figure: the typical value in tabular numbers, then the change against the previous period as an arrow AND words. A figure
// the server calls not ready is "Not enough nights yet", never a dash or a zero.
function Tile({ spec, figure, comparison }) {
  const text = figure?.ready ? typicalText(spec.key, figure.value) : null;
  if (text === null) {
    return (
      <div className="report-tile">
        <dt className="report-tile__label">{spec.label}</dt>
        <dd className="report-tile__value report-tile__value--none">Not enough nights yet</dd>
      </div>
    );
  }
  const change = changeText(spec.change, comparison);
  const Arrow = TREND_ICON[change.trend] || Minus;
  const isScore = spec.key === 'score';
  const band = isScore ? bandOfValue(figure.value) : null;
  const wordForBand = band ? bandWord({ band }) : null;
  const spread = spec.change === 'clock' ? spreadText(figure.spread) : null;
  return (
    <div className="report-tile">
      <dt className="report-tile__label">{spec.label}</dt>
      <dd className="report-tile__value">
        {band && <span className={`report-tile__mark report-tile__mark--${band}`} aria-hidden="true" />}
        <span className="report-tile__num">{text}</span>
        {spec.unit && <span className="report-tile__unit">{spec.unit}</span>}
        {wordForBand && <span className="report-tile__unit">{wordForBand}</span>}
      </dd>
      {spread && <dd className="report-tile__sub">{spread}</dd>}
      <dd className={`report-tile__change report-tile__change--${change.trend}`}>
        <Arrow size={14} aria-hidden="true" /> <span>{change.text}</span>
      </dd>
    </div>
  );
}

// The two ends of the period, each a link to that night. Hidden when the server sends neither (fewer nights than it will rank).
// With scores: the highest and the lowest score. Without (the child's score switch is off, so the server ranks by time asleep):
// the most and the least sleep. "Best" and "worst" are the API's names; on the page they would judge a night, so it says what
// was measured.
function Extremes({ summary, childId }) {
  const { best_night: best, worst_night: worst } = summary;
  const rows = [];
  const row = (night, label) => {
    if (!night || typeof night.date !== 'string') return;
    const byScore = Number.isFinite(night.score);
    const value = byScore ? String(Math.round(night.score)) : minutesText(night.asleep_minutes);
    if (value === null) return;
    rows.push({ night, label, value });
  };
  const hasScore = (n) => n && Number.isFinite(n.score);
  const scored = hasScore(best) || hasScore(worst);
  row(best, scored ? 'Highest score' : 'Most sleep');
  row(worst, scored ? 'Lowest score' : 'Least sleep');
  if (!rows.length) return null;
  return (
    <div className="card report-links">
      {rows.map(({ night, label, value }) => (
        <NavRow key={label} to={`/children/${childId}/sleep?date=${night.date}`} Icon={Moon} label={label}
          sub={formatDayKey(night.date, { weekday: 'short', day: 'numeric', month: 'short' })} value={value} />
      ))}
    </div>
  );
}
