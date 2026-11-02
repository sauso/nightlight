const TITLES = {
  welcome: 'Welcome to Nightlight',
  children: 'Add a child',
  camera: 'Add a camera',
  monitor_test: 'Check the picture',
  review: 'Review setup',
};

export default function SetupStepShell({ step, error, busy, onBack, onExit, onRetry, children }) {
  const steps = Object.keys(TITLES);
  const position = steps.indexOf(step) + 1;
  return (
    <main className="app-main setup-main">
      <div className="card setup-card">
        <p className="camera-tile__sub" aria-label={`Step ${position} of ${steps.length}`}>
          Step {position} of {steps.length}
        </p>
        <h1>{TITLES[step]}</h1>
        {error && <div className="error-banner" role="alert">{error} {onRetry && <button className="btn btn-secondary" type="button" onClick={onRetry}>Try again</button>}</div>}
        {children}
        <div className="setup-actions">
          {onBack && <button className="btn btn-secondary" type="button" disabled={busy} onClick={onBack}>Back</button>}
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={onExit}>Save and exit</button>
        </div>
      </div>
    </main>
  );
}
