import Logo from './Logo.jsx';

// Creating the account is Step 1 (owner, 2026-11-06: it felt like a detour before "step 1"), so the guide's own first step is
// Step 2. `review` closes the list but is never counted, so the counter reads "of 7" with six steps shown.
const STEPS = ['account', 'children', 'camera', 'monitor_test', 'caregivers', 'remote', 'review'];
const TITLES = {
  welcome: 'Welcome to Nightlight',
  // `welcome` is the unnumbered start screen; `account` (FirstRun.jsx) is Step 1.
  account: 'Create your account',
  children: 'Add your child',
  camera: 'Connect your camera',
  monitor_test: 'Test your monitor',
  caregivers: 'Invite caregivers',
  remote: 'Watch from anywhere',
  review: "You're all set!",
};
const SUBTITLES = {
  welcome: 'Your baby monitor, your way.',
  account: 'You will use this to sign in and to manage Nightlight.',
  children: 'Start with the child you want to watch.',
  camera: 'Choose a camera for your child.',
  monitor_test: 'Make sure the picture moves in this browser.',
  caregivers: 'Give trusted people their own login, if you like.',
  remote: 'Check what you need to watch away from home.',
  review: 'Your setup at a glance.',
};

export default function SetupStepShell({ step, error, busy, onBack, onExit, onRetry, primary, subtitle, children, terminal = false }) {
  const position = STEPS.indexOf(step) + 1;
  // The counter and progress bar belong to the counted steps; the review page and the welcome page have none.
  const counted = STEPS.includes(step) && step !== 'review';
  return (
    <main className={`app-main setup-main${terminal ? ' setup-main--terminal' : ''}`}>
      <div className="card setup-card">
        {!terminal && <>
          <div className="setup-head">
            <div className="setup-wordmark"><Logo size={32} />Nightlight</div>
            {counted && <span aria-label={`Step ${position} of ${STEPS.length}`}>Step {position} of {STEPS.length}</span>}
          </div>
          {counted && <div className="setup-progress" role="progressbar" aria-label={`Step ${position} of ${STEPS.length}`} aria-valuenow={position} aria-valuemin={1} aria-valuemax={STEPS.length}>
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
