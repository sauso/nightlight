import path from 'path';

// Where clips live, resolved ONCE. Moved out of clipRecorder.js (#553 phase 2b) so that mediaFiles.js and
// mediaLayout.js, which clipRecorder.js itself imports, can know the root without importing it back (a cycle).
// clipRecorder.js re-exports both names, so no other importer changes.

export const DATA_DIR = process.env.DATA_DIR || '/app/data';

// Clips live OUTSIDE the container layer: default under the mapped /app/data, overridable to a
// separate array mount via CLIPS_DIR (see the plan's storage section). Phase 2 adds the startup
// "is this actually a mount?" guard; the spike just needs a writable dir.
//
// NORMALISED ONCE, HERE (#545). Every containment guard elsewhere (detectionEvents.unlinkClip /
// getEventClipFile, recordings.jailedFile, timelapse.jailedFile) compares `path.resolve(CLIPS_DIR, rel)`
// against `CLIPS_DIR + path.sep`. path.resolve normalises, the raw env value does not: with
// `CLIPS_DIR=/recordings/` (an easy entry in the Unraid "Recordings Directory" field) the prefix became
// `/recordings//` and nothing matched, so clips were written (path.join) but 404'd and were never
// deleted, while retention still cleared the rows and reported success — the disk filled silently.
// A relative value failed the same way. Resolving here makes every consumer agree with no per-guard patch.
// A trailing backslash is deliberately NOT stripped: on Linux (the only supported host) it is a legal
// file-name character, so removing it would silently point at a different directory; on Windows
// (dev machines only) path.resolve already handles both separators.
// SURROUNDING SPACES ARE NOT STRIPPED, for the same reason: a trailing (or leading) space is a legal character
// in a Linux directory name, so an install whose CLIPS_DIR is `/data/clips ` (a real folder with that space)
// would, if we trimmed, silently resolve to a different, empty folder after an upgrade. trim() is used ONLY to
// recognise a blank / whitespace-only value, which means "unset" (an empty compose default, `CLIPS_DIR=`).
export function resolveClipsDir(raw, dataDir) {
  const v = typeof raw === 'string' && raw.trim() !== '' ? raw : '';
  return path.resolve(v || path.join(dataDir, 'clips'));
}
export const CLIPS_DIR = resolveClipsDir(process.env.CLIPS_DIR, DATA_DIR);
