import { Component } from 'react';

// Without this, any render-time exception anywhere in the tree unmounts the whole app to a
// blank white screen with no way back except killing and relaunching - a serious failure for
// something meant to be glanced at half-asleep. This catches those, keeps the app process
// alive, and offers a one-tap reload. It also shows the actual error text (not just a generic
// message) so a recurrence on a device you can't open a console on is still diagnosable from a
// screenshot, rather than an information-free white screen.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Best-effort log for when a console *is* reachable (browser devtools / adb logcat).
    // eslint-disable-next-line no-console
    console.error('Uncaught render error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen">
        <h1 className="crash-screen__title">Something went wrong</h1>
        <p className="crash-screen__body">
          The app hit an unexpected error. Reloading usually clears it.
        </p>
        <button className="btn btn-primary crash-screen__btn" onClick={() => window.location.reload()}>
          Reload
        </button>
        <details className="crash-screen__details">
          <summary>Error details</summary>
          <pre>{error.message || String(error)}{error.stack ? `\n\n${error.stack}` : ''}</pre>
        </details>
      </div>
    );
  }
}
