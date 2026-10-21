// Which settings the sleep detail page works a night out with (#361 PR 4a), and how a set of settings is named.
//
// A finished night whose saved settings (camera, timezone, sleep window) differ from today's is shown WITH the
// saved ones by default, so the page agrees with the child's card; the page can switch to today's and back. The
// server makes that decision (sleepAnalysis.js computeNightForDisplay), from the `context` the page sends:
//   - 'auto':    what the page sends by default. The server replays the saved settings when that applies and
//                otherwise uses today's. Only ever sent on a READ: a save with it is refused (400).
//   - 'current': today's settings, the "Show with today's settings" switch, and what the Recompute dialog compares
//                against when the page is showing the saved settings.
//
// ⚠️ ONE builder for the page's night URL, used by the page's own fetch (and its 2-minute refresh) and by the
// Recompute dialog's re-reads, so no re-read can quietly drop the view the page is in (plan R5).
export function nightDetailPath(childId, date, view = 'auto') {
  return `/children/${childId}/sleep/${date}?detail=1&context=${view === 'current' ? 'current' : 'auto'}`;
}

// The parts of one scoring context, as the page and the Recompute dialog name them: the camera (by its LIVE name
// from the server; the context itself holds only the id), the window as saved, and the timezone. A context with
// no camera means none was turned on; a named one with no name is a camera that has since been deleted.
export function settingsParts(ctx, cameraName) {
  let camera = cameraName;
  if (ctx.camera_id == null) camera = 'no camera';
  else if (!cameraName) camera = 'a camera that no longer exists';
  return { camera, window: `${ctx.window.start}–${ctx.window.end}`, tz: ctx.tz };
}

// "Bed cam, 19:30–07:00, Australia/Melbourne": one context as a single phrase.
export function describeSettings(ctx, cameraName) {
  const p = settingsParts(ctx, cameraName);
  return `${p.camera}, ${p.window}, ${p.tz}`;
}
