import { Component, Suspense, lazy } from 'react';

// #386: route-level code splitting. A screen wrapped by lazyPage() is fetched the first time its route is
// visited instead of being part of the entry chunk.
//
// WHY RETRY RELOADS THE DOCUMENT (and does not just import again): a dynamic import of a module URL that
// failed once is remembered by the browser's module map for the life of the document, so a second
// import() of the SAME url replays the first failure without asking the network again (verified in headless
// Chrome: the server saw one request for two imports). React.lazy also caches a rejection, but building a
// fresh lazy() does not help, because the cache that matters is the browser's. The only thing that clears it
// is a new document, which is also what the app already does to repair itself (it reloads after being
// backgrounded for 15 s), so Retry is `window.location.reload()`.
//
// WHY ONLY fetch/load failures are tagged: a module whose top level throws (an evaluation error) rejects the
// same import() promise but is a bug, not a connection problem. It must keep reaching the app-level
// ErrorBoundary (full-screen crash page with details), exactly as when every screen was eagerly imported,
// instead of being shown as "check your connection". So the factory's rejection is tagged only when it
// looks like a failed load, and the boundary rethrows anything untagged.
class ChunkLoadError extends Error {
  constructor(cause) {
    super('Could not load this screen');
    this.name = 'ChunkLoadError';
    this.cause = cause;
  }
}

// The messages browsers (and Vite's preload helper) use when a module could not be FETCHED:
// Chrome "Failed to fetch dynamically imported module: <url>", Firefox "error loading dynamically imported
// module: <url>", Safari "Importing a module script failed." (all TypeErrors), and Vite's own Error
// "Unable to preload CSS for <url>" (raised by its preload helper before the import runs). Message text is
// all a browser gives us; a browser that words it differently falls through to the app ErrorBoundary, which
// is a harsher screen, not a blank one.
const FETCH_FAILURE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;
const PRELOAD_FAILURE = /Unable to preload CSS/i;

export function isChunkFetchFailure(error) {
  if (!error) return false;
  if (error.name === 'ChunkLoadError') return true;
  const message = String(error.message ?? '');
  if (error.name === 'TypeError') return FETCH_FAILURE.test(message);
  return PRELOAD_FAILURE.test(message);
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
          <p>Couldn’t load this screen. Check your connection, then reload the page.</p>
          <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </main>
    );
  }
}

export function lazyPage(factory) {
  const Inner = lazy(() => factory().catch((e) => {
    throw isChunkFetchFailure(e) ? new ChunkLoadError(e) : e;
  }));
  return function LazyPage(props) {
    return (
      <ChunkBoundary>
        <Suspense fallback={<main className="app-main"><div className="empty-state" role="status">Loading…</div></main>}>
          <Inner {...props} />
        </Suspense>
      </ChunkBoundary>
    );
  };
}
