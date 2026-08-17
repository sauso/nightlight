import { spawn } from 'child_process';
import { logger } from './logger.js';
import { recordCameraEvent, EVENT } from './cameraEvents.js';
import { ffprobeAudioCodec } from './rtspProbe.js';

// camera_id -> { proc, stopped }
const processes = new Map();

// rtsp_url -> source audio codec (probed once, reused across restarts — the codec doesn't change while
// a camera stays put). Lets buildArgs pick the right WebRTC audio track without an ffprobe per restart.
const audioCodecCache = new Map();
async function sourceIsAac(rtspUrl) {
  if (!audioCodecCache.has(rtspUrl)) {
    const codec = await ffprobeAudioCodec(rtspUrl);
    if (!codec) return false; // couldn't probe (camera momentarily down?) — safe default, retry next start
    audioCodecCache.set(rtspUrl, codec);
  }
  return audioCodecCache.get(rtspUrl) === 'aac';
}

const RESTART_DELAY_MS = 5000;
// If SIGTERM hasn't actually stopped the process within this long, escalate to
// SIGKILL rather than wait indefinitely - a stuck FFmpeg process should never be
// able to block a restart forever.
const FORCE_KILL_TIMEOUT_MS = 3000;

function buildArgs(rtspUrl, mediamtxPath, aacSource) {
  // Track 0 = the WebRTC (Low-latency) audio track. WebRTC can't carry AAC, and MediaMTX's MPEG-TS HLS
  // muxer refuses more than one carriable audio track — so if the SOURCE is AAC, copying it here gives
  // WebRTC an unusable track AND leaves two AAC tracks that crash HLS ("single audio track only" → no
  // stream in Compatibility mode). For an AAC source we instead down-convert track 0 to G711 (µ-law,
  // 8 kHz mono): WebRTC carries G711 natively, and MPEG-TS HLS can't carry G711 so it skips it, leaving
  // the AAC track 1 as HLS's single audio track — exactly how a native-G711 camera already behaves. For
  // a non-AAC source (G711 etc.) we keep the cheap passthrough copy, so those cameras are unchanged.
  const track0 = aacSource
    ? ['-ac:a:0', '1', '-ar:a:0', '8000', '-c:a:0', 'pcm_mulaw']
    : ['-c:a:0', 'copy'];
  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    // Every RTSP reconnect legitimately starts a fresh, near-zero timestamp epoch;
    // genpts smooths that transition. This camera also occasionally sends one
    // corrupted RTP timestamp (jumping to billions) that no amount of PTS/DTS
    // reinterpretation can clean up after the fact - see the discontinuity
    // detector below, which is the real defense against that.
    '-fflags', '+genpts',
    // Discard the camera's own (buggy) RTP timestamps entirely and stamp each packet
    // with the server's arrival time instead. Some cameras - notably the Sonoff
    // GK-200MP2-B - send jittery/backward audio timestamps and occasional corrupt video
    // timestamps; replacing them at the input with a monotonic wall-clock fixes both at
    // the source, for every downstream track at once (the WebRTC copy tracks too, which
    // the per-output aresample below can't reach). Trade-off: timing is arrival-based, so
    // A/V lip-sync can drift slightly - acceptable for a monitor, and the alternative was
    // stalled audio / stream restarts. Applied to the input, so it must precede -i.
    '-use_wallclock_as_timestamps', '1',
    '-i', rtspUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?', // "?" makes these optional, in case a camera has no audio track at all
    '-map', '0:a:0?',
    '-c:v', 'copy',
    // Two audio tracks, not one: WebRTC (Low Latency mode) and HLS (Compatibility mode) each carry a
    // different codec, and MediaMTX silently hands each protocol whichever track it supports. Track 0
    // is the WebRTC track (see the buildArgs note above for the AAC-source special case).
    ...track0,
    // Track 1 (AAC, for HLS/Compatibility mode). Some cameras send audio with jittery,
    // occasionally-backward RTP timestamps (logged as "Queue input is backward in time");
    // fed straight to the AAC encoder those poison the HLS muxer's timeline and show up as
    // "No signal" in Compatibility mode. We used to fix this with aresample=async=1, but that
    // "fix" DROPS/inserts samples on every jitter event and made Compatibility-mode audio
    // audibly choppy (measured on the Sonoff test cam: ~15 dropouts in 15s). Instead we
    // resample to 48k and then REBUILD the audio PTS purely from the sample count
    // (asetpts=N/SR/TB): the output clock is perfectly monotonic — so the HLS muxer never
    // sees a backward jump ("No signal" stays gone) — while no samples are dropped, so the
    // audio is clean (measured: 0 dropouts, 0 backward-time warnings). Trade-off: a genuine
    // audio gap collapses (isn't silence-padded) rather than holding A/V sync, so lip-sync can
    // drift slightly on a bad camera — already an accepted trade here (see the wallclock note
    // above) and far better than choppy. Only track 1 — the WebRTC copy track (a:0) is
    // untouched and tolerates the jitter anyway. See KNOWN-ISSUES.md.
    '-filter:a:1', 'aresample=48000,asetpts=N/SR/TB',
    '-c:a:1', 'aac', '-b:a:1', '64k',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    `rtsp://127.0.0.1:8554/${mediamtxPath}`,
  ];
}

export function isRunning(cameraId) {
  return processes.has(cameraId);
}

export async function startTranscoder(cameraId, rtspUrl, mediamtxPath, cameraName = mediamtxPath) {
  // Wait for any previous process for this camera to actually be gone before
  // starting a new one - previously this fired stop and start back-to-back, which
  // left a real window where the old FFmpeg process was still holding the MediaMTX
  // publish connection when the new one tried to claim the same path. That collision
  // could leave MediaMTX's own state for the path confused well beyond just this one
  // restart, causing repeated "broken pipe" failures rather than a single clean blip.
  await stopTranscoder(cameraId);

  // Probe the source audio codec once (cached) so we can build the right WebRTC audio track. A probe
  // failure/timeout returns false → the current passthrough-copy behaviour, so nothing regresses.
  const aacSource = await sourceIsAac(rtspUrl);
  if (aacSource) logger.info(`[ffmpeg:${mediamtxPath}] AAC-audio source — using G711 for the WebRTC track so HLS stays valid`);

  function launch() {
    const proc = spawn('ffmpeg', buildArgs(rtspUrl, mediamtxPath, aacSource), { stdio: ['ignore', 'ignore', 'pipe'] });
    const entry = { proc, stopped: false };
    processes.set(cameraId, entry);

    let lastLine = '';
    // This camera occasionally sends one corrupted RTP timestamp (jumping to
    // billions, near the 32-bit rollover point) which poisons every downstream
    // PTS/DTS calculation for the rest of the session - no ffmpeg flag can clean
    // that up after the fact once it's happened. Catching the discontinuity as
    // soon as ffmpeg reports it and restarting immediately limits the damage to
    // a ~5s reconnect blip instead of hours of garbled output.
    let restarting = false;
    proc.stderr.on('data', (chunk) => {
      chunk
        .toString()
        .split('\n')
        .filter((line) => line.length > 0)
        .forEach((line) => {
          lastLine = line;
          logger.raw(`ffmpeg:${mediamtxPath}`, line);
          if (!restarting && line.includes('DTS discontinuity in stream')) {
            restarting = true;
            logger.error(
              `[ffmpeg:${mediamtxPath}] camera sent a corrupt timestamp - restarting now rather than let the session run poisoned`
            );
            recordCameraEvent(cameraId, cameraName, EVENT.RESTART, 'camera sent a corrupt timestamp');
            proc.kill('SIGTERM');
          }
        });
    });

    proc.on('exit', (code) => {
      // Only the entry currently tracked in the map "owns" this camera. A stale
      // process (superseded while it was still running) must NOT schedule its own
      // resurrection: MediaMTX lets a new publisher override the current one, so a
      // second lineage doesn't fail fast - it kicks the legitimate one off the
      // path, which then restarts and kicks it back, indefinitely. That exact
      // ping-pong once flapped a camera every ~10 seconds for 2.5 hours (901
      // restarts) after a camera glitch got two lineages running at once.
      const wasTracked = processes.get(cameraId) === entry;
      if (wasTracked) processes.delete(cameraId);
      if (!entry.stopped && wasTracked) {
        logger.error(
          `[ffmpeg:${mediamtxPath}] exited (code ${code}), restarting in 5s. Last output: ${lastLine}`
        );
        // The DTS-discontinuity path already recorded its own, more specific event just
        // before killing the process - don't double-log that same restart here.
        if (!restarting) {
          recordCameraEvent(cameraId, cameraName, EVENT.RESTART, `stream ended (exit code ${code})`);
        }
        setTimeout(() => {
          // Re-checked at fire time too: startTranscoder (watchdog, camera edit)
          // may have started a new owner during the 5s delay - launching anyway
          // would create exactly the two-lineage fight described above.
          if (!entry.stopped && !processes.has(cameraId)) launch();
        }, RESTART_DELAY_MS);
      }
    });
  }

  launch();
}

export function stopTranscoder(cameraId) {
  const entry = processes.get(cameraId);
  if (!entry) return Promise.resolve();

  entry.stopped = true;
  processes.delete(cameraId);

  return new Promise((resolve) => {
    let resolved = false;
    function done() {
      if (resolved) return;
      resolved = true;
      resolve();
    }
    entry.proc.once('exit', done);
    entry.proc.kill('SIGTERM');
    // Belt-and-suspenders: don't let a stuck process block a restart indefinitely.
    setTimeout(() => {
      if (resolved) return;
      entry.proc.kill('SIGKILL');
      done();
    }, FORCE_KILL_TIMEOUT_MS);
  });
}

export async function stopAllTranscoders() {
  await Promise.all([...processes.keys()].map(stopTranscoder));
}