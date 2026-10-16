import { RefreshCw } from 'lucide-react';

// The inline "could not load" message shared by every screen that fetches a list (#375; the three states are
// described in docs/design-language.md). Never an alert()/confirm(): it sits in the page where the list would be.
//
//   stale=false  a BLOCKING failure: nothing to show, so it says what to do next (check the connection, retry).
//   stale=true   a refresh failed but the last list is still on screen below: it says that list may be out of date.
//
// `what` is a plain noun phrase ("children", "this child's alerts"). `error` is the server's or the network's
// own words; it sits in its own element so it can be read on its own. Retry is a native <button>, so it is
// reachable by keyboard and announced as a button without any extra wiring. `role="alert"` so the failure is
// spoken when it appears rather than only when someone happens to navigate to it.
export default function LoadFailed({ what, error, onRetry, stale = false }) {
  return (
    <div className="error-banner load-failed" role="alert">
      <div className="load-failed__text">
        <strong>{stale ? `Couldn’t refresh ${what}. Showing what we had.` : `Couldn’t load ${what}.`}</strong>{' '}
        {error && <span className="load-failed__detail">{error}</span>}
        {!stale && <span> Check your connection, then try again.</span>}
      </div>
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm load-failed__retry" onClick={onRetry}>
          <RefreshCw size={13} aria-hidden="true" /> Retry
        </button>
      )}
    </div>
  );
}
