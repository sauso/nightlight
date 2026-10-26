// #553 phase 1: the MOTION detector backs off when ffmpeg cannot be run (exit 126/127 at once). The cases and the
// reasoning are in helpers/detectorExecBackoff.js, shared with sound-exec-backoff.test.js; one leg per file because the
// two cannot share a process (see that file).
import { detectorExecBackoffSuite } from './helpers/detectorExecBackoff.js';

await detectorExecBackoffSuite('motion');
