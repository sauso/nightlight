import { spawn } from 'child_process';
import { killIfSpawned } from './processGuards.js';

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

// #369: how much of the stream the video probe reads (ffprobe `-read_intervals %+N`, i.e. N seconds of stream
// time from the first packet), and the wall-clock backstop that kills it if it never finishes. The read is
// TIME-bounded, not packet-bounded, so ffprobe reaches the end of its interval and exits on its own, which is
// the only way its block-buffered stdout is flushed: a killed ffprobe loses whatever it had not yet written.
// 8 s leaves 3 s over the 5 s read for the RTSP setup; a setup that stalls longer is exactly the case where the
// kill fires, and it reports null.
const VIDEO_PROBE_READ_SECONDS = 5;
const VIDEO_PROBE_KILL_MS = 8000;

// #369: what ARRIVES on a published path, for the detector watchdog's diagnosis line. It is NEVER a gate on
// any action (plan v5 F/E6, after Astra and Sol both showed why it cannot be):
//   * a probe cannot prove a negative: live RTSP never reaches EOF, a stalled RTSP setup looks like a silent
//     path, and stdout is block-buffered, so "saw nothing" is not evidence of anything;
//   * a video PACKET is not a decodable FRAME: the publisher copies H.264 packets, so a path can carry them
//     while the detector gets nothing it can decode (no usable keyframe, damaged references).
// So its answers are worded as observations:
//   true             at least one VIDEO packet arrived (packets, not decodable frames: never proof the restream
//                    is fine)
//   'video-missing'  AUDIO packets arrived but no video packet: the strongest evidence available of the
//                    video-only failure #369 observed on staging (sound working, motion getting nothing)
//   null             anything else: no packets, a non-zero exit, a spawn failure, or the kill timer firing
// It reads ALL streams on purpose: no `-select_streams` (the audio probe above selects `a:0`, and copying that
// line would make 'video-missing' impossible to observe).
export function probeVideoFlowing(mediamtxPath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-read_intervals', `%+${VIDEO_PROBE_READ_SECONDS}`,
      '-show_entries', 'packet=codec_type',
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

    let video = 0;
    let audio = 0;
    let partial = ''; // stdout arrives in arbitrary chunks, not lines
    const count = (line) => {
      const type = line.trim();
      if (type === 'video') video += 1;
      else if (type === 'audio') audio += 1;
    };
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    proc.stdout.on('data', (chunk) => {
      const lines = (partial + chunk.toString()).split('\n');
      partial = lines.pop();
      for (const line of lines) count(line);
    });
    // 'close', not 'exit': stdout can still drain AFTER 'exit' (processOutput.js), and a block-buffered
    // ffprobe writes everything at the very end, so classifying on 'exit' would usually see nothing.
    proc.on('close', (code) => {
      count(partial); // a last line with no trailing newline
      partial = '';
      if (code !== 0) return finish(null); // it failed: what it printed first is not a trustworthy reading
      finish(video > 0 ? true : audio > 0 ? 'video-missing' : null);
    });
    proc.on('error', () => finish(null)); // ffprobe missing / could not spawn
    // The backstop. killIfSpawned, not proc.kill: on POSIX a pid-less child's kill signals our whole process
    // group (processGuards.js). A probe that had to be killed did not finish its read, so what it printed is a
    // partial, buffer-dependent view: null, whatever it contained.
    const timer = setTimeout(() => {
      killIfSpawned(proc, 'SIGKILL');
      finish(null);
    }, VIDEO_PROBE_KILL_MS);
  });
}
