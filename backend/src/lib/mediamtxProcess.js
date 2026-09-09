import { spawn } from 'child_process';
import { networkInterfaces } from 'os';
import { logger } from './logger.js';
import { killIfSpawned } from './processGuards.js';

let proc = null;
let stopped = false;
// Consecutive launches that could not spawn at all, and the last WebRTC host list we logged. Both
// exist only to keep a permanent spawn failure from flooding the log — see the 'error' handler.
let spawnFailures = 0;
let lastAdvertised = null;

const RESTART_DELAY_MS = 3000;
// At container start the host network may not have surfaced a routable address yet; wait up to
// TRIES × INTERVAL (5 s) for one before the first launch, so MediaMTX is unlikely to advertise only
// loopback for WebRTC. A BUDGET, NOT A GUARANTEE — see the header comment on detectHostIPv4s.
const NETWORK_WAIT_TRIES = 10;
const NETWORK_WAIT_INTERVAL_MS = 500;

function forwardLines(chunk, onLine) {
  chunk
    .toString()
    .split('\n')
    .filter((line) => line.length > 0)
    .forEach(onLine);
}

// This host's routable (non-loopback) IPv4 addresses. We pass these to MediaMTX explicitly as
// MTX_WEBRTCADDITIONALHOSTS so it advertises a reachable WebRTC ICE candidate rather than relying on
// its own interface auto-detection (webrtcIPsFromInterfaces), which has been seen to latch onto
// 127.0.0.1 when it runs before host networking is ready at container start - silently breaking
// WebRTC for every client (no media, while all stream health still reads green) until a restart.
//
// ⚠️ THIS IS A MITIGATION WITH A 5-SECOND BUDGET, NOT A GUARANTEE — three comments in this file used
// to say "ALWAYS"/"never" (issue #313). If no routable IP has appeared by then we launch anyway, and
// there is NO RECOVERY while MediaMTX stays up: the host list is recomputed only on a relaunch, which
// happens on unexpected exit, and startMediaMTX is called once (index.js). A MediaMTX that starts
// loopback-only runs loopback-only.
//
// ★ IF YOU ARE DIAGNOSING "everything green, no video": look for `no routable host IP found` in the
// log at startup. That error IS the signal the budget was not enough, and the fix is to restart the
// container once the network is up.
function detectHostIPv4s() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

// Manages the MediaMTX binary as a child process of this app - same restart-on-exit
// pattern as transcoder.js uses for FFmpeg. Combining the two into one image means
// this app is now responsible for both, rather than Docker/compose supervising two
// separate containers.
export async function startMediaMTX(configPath) {
  // First launch only: give the network a moment to surface a routable IP (host networking can
  // lag right at container start). Best-effort - after a few tries we launch anyway. Restarts
  // (from the exit handler below) skip this: the network is long up by then.
  for (let i = 0; i < NETWORK_WAIT_TRIES && detectHostIPv4s().length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_INTERVAL_MS));
  }

  function launch() {
    // MediaMTX reads its own env-var overrides (like MTX_WEBRTCADDITIONALHOSTS) from whatever
    // process spawns it. Advertise PUBLIC_HOST (if set, for outside-the-LAN access) AND every
    // detected host IP, so WebRTC clients get a reachable candidate independently of MediaMTX's own
    // detection timing (see detectHostIPv4s — and note its warning: if the list is EMPTY here, this
    // launch advertises nothing and stays that way until a relaunch). Recomputed on every (re)launch.
    const env = { ...process.env };
    const hosts = [];
    if (process.env.PUBLIC_HOST) {
      for (const h of process.env.PUBLIC_HOST.split(',')) {
        if (h.trim()) hosts.push(h.trim());
      }
    }
    hosts.push(...detectHostIPv4s());
    const advertised = [...new Set(hosts)];
    // Log the host list only when it CHANGES. It is recomputed every launch, and the spawn-failure
    // retry below relaunches every 3s forever, so logging it unconditionally added a second line to
    // the flood described there — and this one is info, i.e. pure noise once it has been said once.
    const advertisedKey = advertised.join(',');
    if (advertised.length) {
      env.MTX_WEBRTCADDITIONALHOSTS = advertisedKey;
      if (advertisedKey !== lastAdvertised) logger.info(`[mediamtx] advertising WebRTC hosts: ${advertised.join(', ')}`);
    } else if (lastAdvertised !== '') {
      logger.error('[mediamtx] no routable host IP found - WebRTC may only advertise loopback');
    }
    lastAdvertised = advertisedKey;

    // Both streams piped (not 'ignore'/'inherit') so every line can be forwarded
    // through our own logger - this is what makes MediaMTX's output show up in both
    // `docker logs` and the in-app log viewer, rather than being silently discarded.
    proc = spawn('mediamtx', [configPath], { stdio: ['ignore', 'pipe', 'pipe'], env });

    // A spawn that never started. Node emits 'error' INSTEAD OF 'exit', so the restart below never
    // runs — and an EventEmitter 'error' with no listener THROWS, taking the whole backend down before
    // it can serve anything. ENOENT here means the mediamtx binary is missing from the image, which is
    // fatal to video but should still leave the app up to say so. See issue #257.
    //
    // Unlike the camera legs this DOES keep retrying: there is no reconcile pass for MediaMTX itself,
    // so nothing else would ever bring it back, and the same backoff the exit path uses is the only
    // route to recovery if the binary appears (a fixed mount, a corrected image).
    proc.on('error', (err) => {
      // Loud, then quiet — the same pattern as clipRecorder's fast-fail exit path, and for a sharper
      // reason here. A missing binary retries every 3s forever, which is ~1200 lines/hour into
      // logger.js's 1000-line ring: within the hour it would have evicted EVERY other line, including
      // the per-camera "could not start ffmpeg" lines that diagnose the same broken image. A log that
      // scrolls away the evidence of the fault it is reporting is worse than no log. So: log the
      // first failure, then roughly once a minute (20 x 3s). Measured/found by review of PR #274.
      spawnFailures += 1;
      if (spawnFailures === 1 || spawnFailures % 20 === 0) {
        const note = spawnFailures > 1 ? ` (${spawnFailures}x, still retrying every ${RESTART_DELAY_MS / 1000}s)` : '';
        logger.error(`[mediamtx] could not start: ${err.code || err.message}${note}`);
      }
      if (!stopped) {
        setTimeout(() => {
          if (!stopped) launch();
        }, RESTART_DELAY_MS);
      }
    });

    let lastLine = '';
    proc.stdout.on('data', (chunk) => {
      forwardLines(chunk, (line) => {
        lastLine = line;
        logger.raw('mediamtx', line);
      });
    });
    proc.stderr.on('data', (chunk) => {
      forwardLines(chunk, (line) => {
        lastLine = line;
        logger.raw('mediamtx', line);
      });
    });

    proc.on('exit', (code) => {
      // Reaching 'exit' at all means this launch really spawned, so a later spawn failure starts its
      // own fresh loud-then-quiet cycle rather than inheriting an old run's count.
      spawnFailures = 0;
      if (!stopped) {
        logger.error(
          `[mediamtx] exited (code ${code}), restarting in ${RESTART_DELAY_MS / 1000}s. Last output: ${lastLine}`
        );
        setTimeout(() => {
          if (!stopped) launch();
        }, RESTART_DELAY_MS);
      }
    });
  }

  launch();
}

export function stopMediaMTX() {
  stopped = true;
  // `proc` is non-null even for a launch that never spawned (it is assigned from spawn()'s return
  // value), and killing one of those is unsafe — but ONLY in the window between spawn() and the
  // 'error' event, while the child still holds a libuv handle with no OS process behind it; after
  // 'error' the handle is nulled and kill() just returns false. Covered by spawn-failure.test.js's
  // "stopping inside the pre-error window" case, which is the ONLY thing that reaches it: a case that
  // waits for the error first cannot see it.
  //
  // ⚠️ THIS COMMENT USED TO SAY THE HAZARD WAS `Error: kill EINVAL`, "verified on win32", and be a
  // try/catch. That is the Windows half only. On Linux there is no throw — the kill resolves to
  // `kill(0, …)`, which signals the entire process group, taking MediaMTX and the backend down
  // together during the very shutdown this is trying to make orderly. See killIfSpawned.
  killIfSpawned(proc, 'SIGTERM');
}
