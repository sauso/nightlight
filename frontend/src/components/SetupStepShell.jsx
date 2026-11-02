const STEPS = ['children', 'camera', 'monitor_test', 'caregivers', 'remote', 'review'];
const TITLES = {
  welcome: 'Welcome to Nightlight',
  children: 'Add your child',
  camera: 'Connect your camera',
  monitor_test: 'Test your monitor',
  caregivers: 'Invite caregivers',
  remote: 'Watch from anywhere',
  review: "You're all set!",
};
const SUBTITLES = {
  welcome: 'Your baby monitor, your way.',
  children: 'Start with the child you want to watch.',
  camera: 'Choose a camera for your child.',
  monitor_test: 'Make sure the picture moves in this browser.',
  caregivers: 'Give trusted people their own login, if you like.',
  remote: 'Check what you need to watch away from home.',
  review: 'Your setup at a glance.',
};

export default function SetupStepShell({ step, error, busy, onBack, onExit, onRetry, primary, subtitle, children, terminal = false }) {
  const position = STEPS.indexOf(step) + 1;
  return (
    <main className={`app-main setup-main${terminal ? ' setup-main--terminal' : ''}`}>
      <div className="card setup-card">
        {!terminal && <>
          <div className="setup-head">
            <div className="setup-wordmark"><img src="/icons/icon-192.png" alt="" />Nightlight</div>
            {step !== 'welcome' && step !== 'review' && <span aria-label={`Step ${position} of 6`}>Step {position} of 6</span>}
          </div>
          {step !== 'welcome' && step !== 'review' && <div className="setup-progress" role="progressbar" aria-label={`Step ${position} of 6`} aria-valuenow={position} aria-valuemin={1} aria-valuemax={6}>
            {STEPS.map((item, index) => <span key={item} className={index < position - 1 ? 'is-complete' : index === position - 1 ? 'is-current' : ''} />)}
          </div>}
        </>}
        <div className="setup-intro"><h1>{TITLES[step]}</h1><p>{subtitle || SUBTITLES[step]}</p></div>
        {error && <div className="error-banner" role="alert">{error} {onRetry && <button className="btn btn-secondary" type="button" onClick={onRetry}>Try again</button>}</div>}
        <div className="setup-content">{children}</div>
        {(onBack || primary) && <div className="setup-actions">
          {onBack && <button className="btn btn-secondary" type="button" disabled={busy} onClick={onBack}>Back</button>}
          {primary && <button className="btn btn-primary" type={primary.form ? 'submit' : 'button'} form={primary.form} disabled={busy || primary.disabled} onClick={primary.onClick}>{primary.label}</button>}
        </div>}
        {onExit && <button className="setup-exit" type="button" disabled={busy} onClick={onExit}>Save and exit</button>}
      </div>
    </main>
  );
}
