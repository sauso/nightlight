import { Component, Suspense, lazy, useState } from 'react';

// #386: route-level code splitting. A screen wrapped by lazyPage() is fetched the first time its route is
// visited instead of being part of the entry chunk.
//
// WHY A WRAPPER AND NOT BARE React.lazy: React.lazy remembers a REJECTED import for the life of the page,
// so after one failed chunk fetch (a phone that dropped off wifi mid-tap) the route would stay broken until
// a full reload, even once the network came back. Retry therefore has to build a fresh lazy component.
//
// WHY ONLY chunk failures are caught here: any other render error must keep reaching the app-level
// ErrorBoundary (full-screen crash page with details), exactly as it did when every screen was eagerly
// imported. So the factory's rejection is tagged, and the boundary rethrows anything untagged.
class ChunkLoadError extends Error {
  constructor(cause) {
    super('Could not load this screen');
    this.name = 'ChunkLoadError';
    this.cause = cause;
  }
}

class ChunkBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (!(error instanceof ChunkLoadError)) throw error;
    // Inline, inside the route's slot: NavBar and the live monitor stay on screen and usable, which a
    // blank page or the full-screen crash page would take away. role="alert" so it is announced.
    return (
      <main className="app-main">
        <div className="empty-state" role="alert">
          <p>Couldn’t load this screen. Check your connection and try again.</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              this.props.onRetry();
              this.setState({ error: null });
            }}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }
}

export function lazyPage(factory) {
  const load = () => factory().catch((e) => { throw new ChunkLoadError(e); });
  let Inner = lazy(load);
  return function LazyPage(props) {
    // The boundary's own re-render is not enough on retry: the <Inner> element below was built by THIS
    // component with the OLD lazy type, and React would reuse it. Bumping state here re-renders LazyPage
    // so it builds the element from the fresh `Inner`.
    const [, setAttempt] = useState(0);
    const retry = () => { Inner = lazy(load); setAttempt((n) => n + 1); };
    return (
      <ChunkBoundary onRetry={retry}>
        <Suspense fallback={<main className="app-main"><div className="empty-state" role="status">Loading…</div></main>}>
          <Inner {...props} />
        </Suspense>
      </ChunkBoundary>
    );
  };
}
