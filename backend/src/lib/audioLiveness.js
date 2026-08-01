import { spawn } from 'child_process';

// How long to wait for audio packets before giving up on a probe.
const PROBE_TIMEOUT_MS = 6000;
// Fewer than this many audio packets within the window = treat the audio as stalled. A healthy
// stream delivers dozens per second, so this is comfortably above any single-packet jitter.
const MIN_AUDIO_PACKETS = 3;

// MediaMTX track names that are audio (used to skip the check for cameras with no audio at all -
// they legitimately have no audio flowing and must never be restarted for it).
const AUDIO_CODECS = ['G711', 'G722', 'MPEG-4 Audio', 'MPEG-1 Audio', 'Opus', 'AC-3', 'LPCM'];

export function tracksHaveAudio(tracks) {
  return Array.isArray(tracks) && tracks.some((t) => AUDIO_CODECS.includes(t));
}

// Reads a few audio packets from a camera's published stream to confirm audio is actually FLOWING,
// not merely that the audio track is declared. Some cameras (jittery-audio Sonoffs) wedge into a
// state where the audio track exists but no audio data flows, while video keeps going - so the
// path still reads "ready" and the frame watchdog never catches it (the symptom: sound works in
// VLC, i.e. a fresh connection, but not in the app). Resolves:
//   true  - audio packets arrived (flowing)
//   false - no audio packets within the window (stalled)
//   null  - couldn't run ffprobe at all (inconclusive - caller should not act on this)
export function probeAudioFlowing(mediamtxPath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-select_streams', 'a:0',
      '-read_intervals', '%+#20', // read up to 20 audio packets, then stop
      '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0',
      '-i', `rtsp://127.0.0.1:8554/${mediamtxPath}`,
    ];
    let proc;
    try {
      proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }

    let count = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(value);
    };

    proc.stdout.on('data', (chunk) => {
      count += chunk.toString().split('\n').filter((l) => l.trim().length > 0).length;
      if (count >= MIN_AUDIO_PACKETS) finish(true); // enough packets - definitely flowing
    });
    // Exited on its own before the timeout: flowing if we saw packets, stalled if we saw none.
    proc.on('exit', () => finish(count >= MIN_AUDIO_PACKETS ? true : count > 0 ? true : false));
    proc.on('error', () => finish(null)); // ffprobe missing / couldn't spawn
    const timer = setTimeout(() => finish(count > 0 ? true : false), PROBE_TIMEOUT_MS);
  });
}
