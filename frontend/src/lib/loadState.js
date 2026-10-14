// The three honest answers a screen can give about a list it fetched (#375), as one pure function so every
// screen draws the lines in the same place:
//
//   loading  nothing has answered yet                -> a "Loading…" line, NEVER the empty copy
//   error    the request failed and there is nothing -> an inline message with Retry, NEVER the empty copy
//            on screen to fall back on                  and never a setup action ("Add child")
//   stale    it failed AFTER a good load             -> keep the last list, say it may be out of date
//   empty    a request SUCCEEDED and returned none   -> the screen's own empty copy
//   ready    a request succeeded and returned some
//
// Why `error` and not `stale` when the last good answer was an empty list: that list is not on screen to
// keep, and "No children yet" beside an outage is the exact lie this exists to stop. Once the request
// recovers, `empty` comes back by itself.
//
// `loaded` means "a request has SUCCEEDED at least once", not "a request has finished": a failed first
// request leaves it false, which is what lets a failure be told apart from an empty answer.
export function loadState({ loaded, error, count }) {
  if (error) return loaded && count > 0 ? 'stale' : 'error';
  if (!loaded) return 'loading';
  return count > 0 ? 'ready' : 'empty';
}
