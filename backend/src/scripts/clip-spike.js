// Phase-1 recording spike — proves the Option A capture core (lib/clipRecorder.js) end to end against
// a REAL camera inside the running container, without touching the schema, API, or UI. It starts a
// segmenter on a camera's live MediaMTX path, lets pre-roll accumulate, fires a simulated trigger,
// concatenates a clip, and ffprobes it so we can see exactly what came out.
//
//   docker exec nightlight-dev node src/scripts/clip-spike.js                 # list camera paths
//   docker exec nightlight-dev node src/scripts/clip-spike.js cam_<id>        # spike that camera
//   docker exec nightlight-dev node src/scripts/clip-spike.js cam_<id> 5 15   # custom pre/post-roll
//
// The finished clip lands at CLIPS_DIR/<path>/<ts>.mp4 (default /app/data/clips/...), so on staging
// it's under /mnt/user/appdata/nightlight-dev/clips — copy it to a phone to close the manual half of
// the spike (does it play in a plain <video> on iOS Safari + the Android WebView?).
//
// This script imports the SAME clipRecorder module the real feature will use, so a green run here is a
// green light for Phase 2. It is a dev/diagnostic tool — not wired into the app.
import db from '../db.js';
import { getPathStatus } from '../lib/mediamtx.js';
import { startSegmenter, stopSegmenter, extractClip, CLIPS_DIR } from '../lib/clipRecorder.js';

const SEGMENT_SEC = 2;

async function listPaths() {
  const cams = db.prepare('SELECT id, name, mediamtx_path FROM cameras ORDER BY sort_order').all();
  if (!cams.length) {
    console.log('No cameras configured.');
    return;
  }
  console.log('Cameras (pass a path as the first argument):\n');
  for (const c of cams) {
    let ready = false;
    try {
      ready = (await getPathStatus(c.mediamtx_path)).ready;
    } catch {
      /* MediaMTX not reachable */
    }
    console.log(`  ${c.mediamtx_path.padEnd(24)} ${ready ? 'READY  ' : 'not ready'} ${c.name}`);
  }
  console.log(`\nClips will be written under: ${CLIPS_DIR}`);
}

async function spike(pathName, preRollSec, postRollSec) {
  const cam = db.prepare('SELECT id, name, mediamtx_path FROM cameras WHERE mediamtx_path = ?').get(pathName);
  if (!cam) {
    console.error(`No camera with MediaMTX path "${pathName}". Run with no arguments to list them.`);
    process.exit(1);
  }
  const status = await getPathStatus(pathName).catch(() => ({ ready: false }));
  console.log(`Camera:    ${cam.name} (${pathName})`);
  console.log(`Stream:    ${status.ready ? 'ready' : 'NOT READY (spike will likely fail)'}`);
  console.log(`Pre/post:  ${preRollSec}s / ${postRollSec}s`);
  console.log(`Clips dir: ${CLIPS_DIR}\n`);

  // Keyed by the path so the ring dir is human-identifiable during the spike.
  const key = pathName;
  startSegmenter(key, pathName, { preRollSec, postRollSec });

  // Let enough pre-roll accumulate that the backward reach has real segments to grab.
  const primeMs = (preRollSec + 2 * SEGMENT_SEC) * 1000;
  console.log(`Buffering pre-roll for ${Math.round(primeMs / 1000)}s...`);
  await new Promise((r) => setTimeout(r, primeMs));

  const at = Date.now();
  console.log(`Trigger fired. Capturing clip (waits out the ${postRollSec}s post-roll)...`);
  try {
    const res = await extractClip(key, { preRollSec, postRollSec, at });
    console.log('\n=== CLIP PRODUCED ===');
    console.log(`file:      ${res.file}`);
    console.log(`thumb:     ${res.thumb || '(none)'}`);
    console.log(`segments:  ${res.segments} concatenated`);
    console.log(`container: ${res.probe.format}`);
    console.log(`video:     ${res.probe.video}`);
    console.log(`audio:     ${res.probe.audio || '(none — video-only)'}`);
    console.log(`duration:  ${res.probe.durationSec?.toFixed(2)}s (expected ~${preRollSec + postRollSec}s)`);
    console.log(`size:      ${res.probe.bytes ? (res.probe.bytes / 1e6).toFixed(2) + ' MB' : '?'}`);

    const audioOk = !res.probe.audio || /aac/i.test(res.probe.audio);
    console.log('\n=== CHECKS ===');
    console.log(`${/mp4|mov/i.test(res.probe.format || '') ? 'PASS' : 'FAIL'} container is MP4`);
    console.log(`${/h264|hevc/i.test(res.probe.video || '') ? 'PASS' : 'FAIL'} video is H.264/HEVC`);
    console.log(`${audioOk ? 'PASS' : 'FAIL'} audio is AAC (or absent) — NOT G711/pcm_*`);
    console.log('NOTE  <video> playback on a real iOS/Android device is the manual half — copy the file off and try it.');
  } catch (e) {
    console.error(`\nSPIKE FAILED: ${e.message}`);
    stopSegmenter(key);
    process.exit(1);
  }
  stopSegmenter(key);
  process.exit(0);
}

const arg = process.argv[2];
const preRoll = Number(process.argv[3]) || 5;
const postRoll = Number(process.argv[4]) || 15;

if (!arg) {
  await listPaths();
  process.exit(0);
} else {
  await spike(arg, preRoll, postRoll);
}
