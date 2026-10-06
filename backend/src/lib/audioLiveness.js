import { spawn } from 'child_process';
import { killIfSpawned } from './processGuards.js';

// How long to wait for audio packets before giving up on a probe.
const PROBE_TIMEOUT_MS = 6000;
// This many audio packets end the probe EARLY as flowing. A healthy stream delivers dozens per second, so
// this is comfortably above any single-packet jitter. It is not a threshold for a run that ends by itself:
// one or two packets before a clean exit or the timeout still count as flowing (A2/A8), and only NO packets
// is a stall.
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
//   null  - couldn't run ffprobe, or it ran and FAILED (non-zero exit, or killed from outside)
//           (inconclusive: not a reading either way. The two callers treat it differently on purpose:
//           createAudioWatchdog resets its stall count; the detector watchdog's sound leg acts on the second
//           consecutive one, exactly as it does for a spawn failure)
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
    // Exited on its own before the timeout (#515). Two rules, both taken from probeVideoFlowing below:
    //  * 'close', not 'exit': stdout can still drain AFTER 'exit' (processOutput.js) and a block-buffered
    //    ffprobe writes everything at the very end, so classifying on 'exit' counted packets that had not
    //    arrived yet and could read a healthy stream as `false`.
    //  * a non-zero exit is `null`, not `false`: a failed run prints nothing, and "could not probe" is not
    //    "confirmed no audio". Consequence that made it worth fixing: createAudioWatchdog restarts a camera's
    //    TRANSCODER after two `false` in a row (`null` resets its count), so a failed run could count toward a
    //    restart of a healthy transcoder. HOW OFTEN a run fails is limited, and stated plainly (#515 review): the
    //    probe reads the LOCAL MediaMTX (127.0.0.1:8554, no authentication) and only runs on a path the API has
    //    just reported ready, so a refused connection or wrong credentials cannot happen here; a failure needs
    //    the path to drop between that status read and the probe, twice in a row. The late-drain fix above is
    //    plausibly the more common effect. Not verified (no ffprobe on the build machine): whether ffprobe exits
    //    non-zero when a session drops AFTER setup; if it exits 0 with no packets that still reads `false`.
    //    An external kill (code null) lands here too: also not a reading.
    // A clean exit: flowing if we saw any packets, stalled if we saw none. One packet is enough (A2): the
    // three-packet bar above only ends the probe EARLY, it is not a threshold for a run that ended by itself.
    // NOT changed: a probe that never exits (live RTSP does not end) is still classified by the 6 s timer below,
    // and "no packets by the deadline" stays `false`, the audio watchdog's one real stall signal (A5). The timer
    // is only cleared by finish(), so an 'exit' landing within microseconds of that deadline, before 'close', can
    // still be classified by the timer from an incomplete count: accepted, because the timer is also the only
    // backstop for a child whose stdout never closes.
    proc.on('close', (code) => {
      if (code !== 0) return finish(null);
      finish(count > 0);
    });
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
