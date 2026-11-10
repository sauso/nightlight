// `app.listen` that fails LOUDLY when the port cannot be bound.
//
// Express 4 let a listen failure (EADDRINUSE, EACCES) surface as an uncaught error on the server, and
// processGuards.js turns an uncaught error DURING BOOT into exit code 1, so the container restarts instead of
// sitting there. Express 5 changed `app.listen`: it registers the callback as the server's `once('error')`
// handler too, so the failure arrives as the callback's FIRST ARGUMENT and nothing is thrown. A callback that
// ignores it (as index.js's did) logs "listening", calls markBootComplete() and starts Tailscale, mDNS, clip
// storage and camera reconciliation with no server bound: the healthy-looking container with no server that
// processGuards.js exists to prevent. Found by the Express 4 vs 5 comparison of the Express 5 move (reproduced
// with the port already taken: Express 4 crashed, Express 5 called the callback with the error).
//
// `fail` is a parameter only so a test can observe the error; the default rethrows it, which is what the
// boot guard needs to see.
export function listenOrFail(app, port, onListening, fail = (err) => { throw err; }) {
  return app.listen(port, (err) => {
    if (err) return fail(err);
    return onListening();
  });
}
