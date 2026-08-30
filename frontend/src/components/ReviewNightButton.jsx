import { useNavigate } from 'react-router-dom';

// The way into a night's review from the sleep detail page — and the only way into a night the card
// is not currently offering.
//
// ⚠️ It is its own component ON PURPOSE. It first lived inline inside SleepDetail's `NightBody`, which
// is a separate function component from `SleepDetail` itself, so the `navigate` it called was never in
// scope: every click threw a ReferenceError and the button did precisely nothing. Nothing caught it —
// the build does not resolve identifiers, and there was no test that clicked it. A control with
// behaviour gets its own component and its own test.
export default function ReviewNightButton({ childId, date, corrected }) {
  const navigate = useNavigate();
  if (!childId || !date) return null;
  return (
    <button
      type="button"
      className="btn btn-secondary btn-block sleep-detail__review"
      onClick={() => navigate(`/children/${childId}/review/${date}`)}
    >
      {corrected ? 'Change what you told us about this night' : 'Was this night right?'}
    </button>
  );
}
