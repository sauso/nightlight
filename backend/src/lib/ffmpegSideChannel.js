// The ffmpeg STDERR side channel for the motion and sound detectors (issue #373 Stage 2).
//
// WHAT IT IS FOR. The detectors used to run ffmpeg at `-loglevel error`, so stderr carried only errors and
// they were forwarded to the log verbatim. #373 needs ffmpeg's OWN per-frame input timestamps (the PTS the
// transcoder stamped when each real camera frame reached the server), so the detectors now run with two
// `showinfo` taps on the motion leg and one `ashowinfo` tap on the sound leg, at `+level+info`. That makes
// stderr a mixed stream: tap RECORDS (for observationClock.js), a lot of harmless INFO/WARNING chatter, and
// the same errors as before. This module splits it, one decision per complete line:
//   - a tap record -> the observation clock, never the log;
//   - a tap continuation line, and every [info]/[verbose]/[warning]/[debug] line -> dropped and counted
//     (today's `-loglevel error` never showed warnings either);
//   - [error]/[fatal]/[panic] -> the log, with the level token stripped so the text is byte-for-byte what
//     `-loglevel error` printed (fixtures/obs/loglevel-*.err are the same run captured both ways);
//   - an untagged line (no level token) -> the same fate as the line before it ("Rule B", below);
//   - a tap-tagged line that looks like a record but fails the WHOLE grammar -> the log (see below). The
//     one exception is an AUDIO line whose first half (the part the clock reads) is intact: that is
//     delivered to the clock as a record, and the log still gets what it always got (#573, ASHOWINFO_CORE).
// It also owns the Adler-32 that aligns stdout samples with `out` records, and the tap/argument builders,
// so the detectors and this parser can never disagree about which tag is which tap.
//
// ★ NOTHING HERE MAY CHANGE A DETECTION DECISION. It only ever sees stderr; stdout (the bytes every
// decision is computed from) never passes through it. fixtures/obs/identity-v4.sh ran the OLD and NEW args
// over two real 2-minute camera recordings, a fakecam-like file, 1080p15 and 4K30 synthetic H.264 and AAC
// at 16 and 48 kHz: stdout sha256 identical on all of them (2026-09-26, ffmpeg 8.1.2).
//
// ★ MEASURED STDERR VOLUME PER CAMERA (plan C8, lean taps, fixtures/obs/identity-v4.sh, 2026-09-26). Lines
// per second of media, every stderr line counted (records + continuation lines + banners):
//   motion, a 10 fps sub stream (a real Thingino recording) ...... 30.2 lines/s
//   motion, a 15 fps main stream (the same camera) ................ 40.1 lines/s
//   motion, 1080p15 / 4K30 synthetic .............................. 40.8 / 71.2 lines/s
//   sound, G711 8 kHz (the same camera's audio, 25 packets/s) ..... 25.9-26.4 lines/s
//   sound, AAC 16 / 48 kHz synthetic (1024-sample frames) ......... 16.1 / 47.4 lines/s
// The motion figure is 2 lines per input frame (record + colour line) plus 2 per output frame at 5 fps, so
// it scales with the CAMERA's frame rate, not the detector's: a 30 fps camera without a sub stream costs
// ~70 lines/s. Other cameras may add showinfo "side data" lines per frame (SEI, HDR metadata), which are
// dropped like the colour line but still cost a parse. Plan v3's figures (40/50 lines/s) were for three taps.
//
// ⚠️ THE LOG LEVEL SPELLING IS LOAD-BEARING. `+level+info` is the RELATIVE form: it adds the level prefix
// and sets INFO without clearing ffmpeg's AV_LOG_SKIP_REPEATED. The absolute `level+info` clears it, and
// a repeated error then prints once per repeat (fixtures/obs/loglevel-abs.err: 0 "Last message repeated"
// lines, against 20 in loglevel-rel.err for the same input). Even with the right spelling, ffmpeg can only
// collapse repeats that are ADJACENT, and a tap record now lands between two repeats of a per-frame error
// (fixtures/obs/interleave-rel.err), so this module re-collapses identical forwarded lines itself (plan v4
// decision B). `-nostats` is not optional either: the periodic stats line ends in a bare `\r` and glued
// itself onto the next record in the Stage 1 soak runs, eating it (probe-sample-timing.mjs's header).
import { performance } from 'node:perf_hooks';

export const SIDE_CHANNEL_LOG_ARGS = Object.freeze(['-loglevel', '+level+info', '-nostats']);

// Adler-32 with an INITIAL VALUE OF 0, not zlib's 1. showinfo computes `av_adler32_update(0, ...)` over each
// line of the frame, and a stdout frame only aligns with its `out` record if both use the same start value.
// Step 0 checked both starts against real ffmpeg output (fixtures/obs/motion-*.gray): 0 matches every frame
// and 1 matches none; ffmpeg-side-channel.test.js re-checks it on the lean capture.
export const ADLER_INIT = 0;
const ADLER_MOD = 65521;
// zlib's NMAX. JS numbers are exact to 2^53, so the chunking is not needed for correctness at a 57,600-byte
// frame; it keeps the running sums small for an input of any length.
const ADLER_NMAX = 5552;

export function adler32(buf, init = ADLER_INIT) {
  let a = init & 0xffff;
  let b = (init >>> 16) & 0xffff;
  const len = buf.length;
  let i = 0;
  while (i < len) {
    const end = Math.min(len, i + ADLER_NMAX);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= ADLER_MOD;
    b %= ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}

// showinfo prints checksums as %08X; the clock compares them as numbers.
export function parseChecksum(hex) {
  return Number.parseInt(hex, 16) >>> 0;
}

// --- tap builders ------------------------------------------------------------------------------------------
// ONE function returns both the filter string and the tag -> tap map, so nothing anywhere guesses a
// position. The motion taps are NAMED instances: ffmpeg 8.1.2 logs `[showinfo@in @ 0x…]` for
// `showinfo@in` (fixtures/obs/lean-32x18.err). Positional names would be `Parsed_showinfo_0` and
// `Parsed_showinfo_4`, and would silently change meaning if a filter were ever added in between.
//
// ★ LEAN TAPS (plan v4 decision A, owner 2026-09-25): `in` runs with `checksum=0` because its Adler-32 over
// every FULL-RESOLUTION input frame was the measured cost (+49% CPU at 4K30 with it, +1-2% without,
// Step 0 cost2.txt). Provenance does not need it: the clock attributes each output slot by integer slot
// arithmetic alone (observationClock.js, R4-1..R4-4). `out` keeps its checksum: it is computed on the
// 320x180 gray frame, which is cheap, and it is how a stdout sample is matched to its record by CONTENT.
export const MOTION_TAP_IN = 'showinfo@in';
export const MOTION_TAP_OUT = 'showinfo@out';

export function buildMotionTaps({ fps, width, height }) {
  return {
    filter: `${MOTION_TAP_IN}=checksum=0,fps=${fps},scale=${width}:${height},format=gray,${MOTION_TAP_OUT}`,
    taps: { [MOTION_TAP_IN]: 'in', [MOTION_TAP_OUT]: 'out' },
  };
}

// The sound leg has ONE filter in its -af chain, so its instance is `Parsed_ashowinfo_0` by construction
// (fixtures/obs/sound-*.err). It sits BEFORE `-ac 1 -ar 8000`, so it logs the camera's own rate and
// sample counts, which is what the clock's sample-clock model needs.
export function buildSoundTaps() {
  return { filter: 'ashowinfo', taps: { Parsed_ashowinfo_0: 'audio' } };
}

// --- line grammar ------------------------------------------------------------------------------------------
// ffmpeg's log line: zero or more `[context @ 0x…] ` groups (fftools prints two, e.g.
// `[vist#0:0/h264 @ 0x…] [dec:h264 @ 0x…]`), then, with `+level`, ONE `[level] ` token, then the message.
// A line with no level token is "untagged": ffmpeg's own "    Last message repeated N times", or the second
// line of a multi-line message (fixtures/obs/mjpeg-rel.err: "Consider increasing the value…").
const LINE = /^((?:\[[^[\]]+ @ [^[\]\s]+\] )*)(?:\[(quiet|panic|fatal|error|warning|info|verbose|debug|trace)\] )?([\s\S]*)$/;
const CONTEXT_NAME = /^\[([^[\]]+) @ /;

// av_ts2timestr prints "%.6g" (so "1e-05" and "1.23457e+06" both occur) or NOPTS.
const TS = String.raw`(?:-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|NOPTS)`;
// ★ THE WHOLE GRAMMAR, ANCHORED AT BOTH ENDS (plan v4 refinement 2). ffmpeg 8's threads share log.c's
// `print_prefix` flag, and showinfo builds one record from several av_log calls, so another thread's error
// can land in the MIDDLE of a record with no prefix of its own (the rest of the record then continues on a
// fresh prefixed line). A prefix match ("tagged showinfo@in, starts with n:") would accept that glued line
// as a record and throw the error away. Only a line that is exactly a record, from `n:` to the last field,
// is one; everything else falls through to the ordinary rules.
const SHOWINFO_RECORD = new RegExp(
  String.raw`^n:\s*(\d+) pts:\s*(-?\d+|NOPTS) pts_time:(${TS})\s+duration:\s*(-?\d+) duration_time:(${TS})\s+` +
    String.raw`fmt:\S+ cl:\S+ sar:\d+/\d+ s:\d+x\d+ i:\S iskey:[01] type:\S ?` +
    String.raw`(?:checksum:([0-9A-F]{8}) plane_checksum:\[[0-9A-F]{8}(?: [0-9A-F]{8}){0,3}\] ` +
    String.raw`mean:\[\d+(?: \d+){0,3}\] stdev:\[\d+\.\d(?: \d+\.\d){0,3}\])?\s*$`
);
// chlayout is av_channel_layout_describe(): a name ("mono", "5.1(side)"), or "N channels" with an optional
// "(FL+FR+…)". Spelled out rather than `.+?`, which the hostile test caught swallowing a glued error
// (`chlayout:monono frame! rate:8000` parsed as a record).
const CHLAYOUT = String.raw`(?:[\w.()+@-]+|\d+ channels(?: \([\w.+@-]+\))?)`;
const ASHOWINFO_RECORD = new RegExp(
  String.raw`^n:(\d+) pts:(-?\d+|NOPTS) pts_time:(${TS}) fmt:\S+ channels:\d+ chlayout:${CHLAYOUT} rate:(\d+) ` +
    String.raw`nb_samples:(\d+) checksum:([0-9A-F]{8}) plane_checksums: \[ (?:[0-9A-F]{8} )+\]\s*$`
);
// ★ THE CORE GRAMMAR (#573): the first half of an `ashowinfo` record, which is the half the clock reads.
// ffmpeg's ashowinfo prints one record in several av_log calls. The FIRST call carries every field
// observationClock.js uses (n, pts, pts_time, rate, nb_samples) and ends `checksum:%08X ` (with a trailing
// space); then come `plane_checksums: [ `, one `%08X ` per plane and `]\n`. A call is written under log.c's
// mutex, so another thread's text (the muxer's `Application provided invalid, non monotonically increasing
// dts`) can land only AFTER the first call, never inside it. That is why the strict grammar above threw
// away a COMPLETE record: its unused tail was glued to foreign text, the line failed the whole-line match,
// the clock was told a record was lost, and one lost record blinds the rest of that ffmpeg run (R1-F11,
// observationClock.js). 18 of 18 real torn records in the saved staging and prod logs (2026-09-28 .. 10-04,
// fixtures/obs/torn-ashowinfo-real.txt) tore AFTER the first call; none tore inside it.
//
// The core takes the same sub-patterns as the strict grammar and stops at the checksum token. The lookahead
// after the 8 hex digits is a literal SPACE (not \s): it is the first call's own trailing space, so
// `checksum:AAAAAAAAno frame!` (a cut inside the digits with foreign text glued on) is not salvaged. The end
// of the line is deliberately NOT accepted either (round-1 review): it is unreachable in real data (the first
// call always ends with its own space, and the line buffer strips only a `\r`), and refusing it keeps the
// pre-#573 behaviour (a lost record) for any line that does not end in that space. Everything before `checksum:` must still match, so a cut anywhere before it stays a lost
// record and still opens the hole, exactly as before.
//
// What is NOT claimed: (1) a cut INSIDE the 8 hex digits followed by hex-looking foreign text can salvage a
// wrong CHECKSUM, which nothing reads (the five fields the clock reads were right in every case of a
// reviewer's one-off fuzz over 4 record shapes, every offset, 11 foreign texts, which is not kept in the
// repo; ashowinfo-torn-record.test.js C4 re-runs the same shapes and offsets with 4 foreign texts); (2) that the first call is atomic rests on a read
// of the ffmpeg 8.1.2 source and on the 18 real tears, not on a test that runs real ffmpeg; a future ffmpeg
// that prints the record in a different number of calls is covered only by this being audio-only and by the
// hole warning in observationClock.js; (3) the salvage is AUDIO ONLY: the motion clock handles a lost record
// locally (a few samples `unknown`), and salvaging an `in` record would let the clone filter label frames it
// now calls unknown, which moves stored motion numbers: a separate change.
const ASHOWINFO_CORE = new RegExp(
  String.raw`^n:(\d+) pts:(-?\d+|NOPTS) pts_time:(${TS}) fmt:\S+ channels:\d+ chlayout:${CHLAYOUT} rate:(\d+) ` +
    String.raw`nb_samples:(\d+) checksum:([0-9A-F]{8})(?= )`
);
// The per-frame lines a tap prints AFTER a record, and its one-time config banner. Each is matched in full
// for the same reason as the record: a glued error must not be dropped as a "continuation".
const CONFIG_LINE = /^config (in|out) time_base: (\d+)\/(\d+), frame_rate: (\d+)\/(\d+)\s*$/;
const COLOR_LINE = /^color_range:\S+ color_space:\S+ color_primaries:\S+ color_trc:\S+\s*$/;
// ⚠️ KNOWN LIMIT: side data lines are open-ended (SEI payloads, HDR metadata, per camera), so they are
// accepted by their prefix. An error glued into one would be dropped with it. The Thingino cameras measured
// here printed none in 250k+ records; a camera that does still has every error on every OTHER line.
const SIDE_DATA_LINE = /^\s*side data - /;
// The OTHER half of a glued line. When another thread's text lands inside a tap line, the tap's remaining
// av_log calls start a fresh prefixed line holding nothing but leftover fields. Captured for real in
// fixtures/obs/interleave-mix-rel.err: `color_range:unknownnon-existing PPS 0 referenced` (an error glued
// into a colour line, forwarded) is followed by ` color_space:unknown color_primaries:unknown ...` (the
// leftover, dropped), and `108 133 129] stdev:[56.5 64.6 72.3]` is the tail of a split record. A line is a
// fragment only if EVERY token is a tap field, a number, a hex checksum or a bracket, so any foreign word —
// which is what an error message is made of — keeps the line out of this class and in the log.
const FRAGMENT_TOKEN = /^(?:(?:n|pts|pts_time|duration|duration_time|fmt|cl|sar|s|i|iskey|type|checksum|plane_checksum|plane_checksums|mean|stdev|channels|chlayout|rate|nb_samples|color_range|color_space|color_primaries|color_trc):\S*|\[?-?[0-9A-Fa-f.]+\]?|[[\]])$/;
function isFragment(message) {
  const tokens = message.trim().split(/\s+/);
  return tokens.length > 0 && tokens[0] !== '' && tokens.every((t) => FRAGMENT_TOKEN.test(t));
}

const DROPPED_LEVELS = new Set(['quiet', 'warning', 'info', 'verbose', 'debug', 'trace']);
// For the classifier's failure path only (see createStderrRouter): a raw line carrying one of these tokens.
const FATAL_TOKEN = /\[(?:fatal|panic)\] /;

// Pure: one line in, one decision out. Exported so the tests can drive the grammar directly and inject a
// throwing replacement into the router.
//   kind: 'record' | 'config' | 'continuation' | 'fragment' | 'dropped' | 'error' | 'fatal' | 'untagged'
//         | 'unparseable'
//   lost: true when the line was a record that did not survive (the clock treats it like an n-hole)
export function classifyLine(line, taps) {
  const m = LINE.exec(line);
  const contexts = m[1];
  const level = m[2];
  const message = m[3];
  const name = CONTEXT_NAME.exec(contexts)?.[1];
  const tap = name !== undefined ? taps[name] : undefined;

  if (tap !== undefined && level === 'info') {
    if (/^n:/.test(message)) {
      const rec = tap === 'audio' ? parseAudioRecord(message) : parseVideoRecord(message);
      // An `out` record is useless without its checksum (it is how stdout is aligned), so one without is
      // treated like any other malformed record.
      if (rec && (tap !== 'out' || rec.checksum !== null)) return { kind: 'record', tap, rec };
      // #573: an AUDIO line that failed the whole-line grammar but whose first av_log call (the core) is
      // intact is a complete record with foreign text glued after it: hand the clock the record instead of
      // telling it one was lost. `salvaged: true` marks it (the healthy result above carries no extra key).
      // What reaches the log is exactly what the old code sent: the old rule on the WHOLE message (nothing
      // foreign -> it was a `fragment`, dropped; any foreign token -> it was `unparseable`, the original line
      // forwarded), decided on the whole message and not on the remainder after the core, because the two
      // differ (a valid multi-word chlayout such as `2 channels` makes isFragment see a foreign word, and the
      // old code forwarded that line). The router reads `forwardText` and keeps the log byte-identical.
      if (tap === 'audio') {
        const salvaged = salvageAudioRecord(message);
        if (salvaged) {
          return isFragment(message)
            ? { kind: 'record', tap, rec: salvaged, salvaged: true }
            : { kind: 'record', tap, rec: salvaged, salvaged: true, forwardText: line };
        }
      }
      // A record that failed the whole grammar is LOST to the clock either way. It reaches the log unless
      // it is nothing but record fields (no foreign text glued into it), which would only be noise there.
      return isFragment(message) ? { kind: 'fragment', tap, lost: true } : { kind: 'unparseable', tap, text: line, lost: true };
    }
    const c = CONFIG_LINE.exec(message);
    if (c) {
      return { kind: 'config', tap, dir: c[1], tbNum: Number(c[2]), tbDen: Number(c[3]) };
    }
    if (COLOR_LINE.test(message) || SIDE_DATA_LINE.test(message) || message.trim() === '') {
      return { kind: 'continuation', tap };
    }
    if (isFragment(message)) return { kind: 'fragment', tap, lost: false };
    // Tap-tagged, INFO, and none of the tap's own line shapes: foreign text glued into a tap line.
    // Forwarded rather than dropped (R2-O4): a garbled line in the log is a lesser harm than a lost error.
    return { kind: 'unparseable', tap, text: line, lost: false };
  }
  if (level === undefined) return { kind: 'untagged', text: line };
  if (DROPPED_LEVELS.has(level)) return { kind: 'dropped', level };
  // Strip ONLY the level token: the context groups and the message are exactly what `-loglevel error`
  // printed (fixtures/obs/rtsp-refused-*.err, mjpeg-*.err, loglevel-*.err).
  return { kind: level === 'error' ? 'error' : 'fatal', text: contexts + message };
}

function parseVideoRecord(message) {
  const r = SHOWINFO_RECORD.exec(message);
  if (!r || r[2] === 'NOPTS') return null;
  return {
    n: Number(r[1]),
    pts: Number(r[2]),
    checksum: r[6] === undefined ? null : parseChecksum(r[6]),
  };
}

function parseAudioRecord(message) {
  const r = ASHOWINFO_RECORD.exec(message);
  if (!r || r[2] === 'NOPTS') return null;
  return {
    n: Number(r[1]),
    pts: Number(r[2]),
    ptsTime: Number(r[3]),
    rate: Number(r[4]),
    nbSamples: Number(r[5]),
    checksum: parseChecksum(r[6]),
  };
}

// #573: the same record object as parseAudioRecord, read from the intact first call of a torn line (see
// ASHOWINFO_CORE). `NOPTS` is still "no record", as in the strict path. Same keys in the same order, so a
// salvaged record is indistinguishable from a healthy one to the clock.
function salvageAudioRecord(message) {
  const r = ASHOWINFO_CORE.exec(message);
  if (!r || r[2] === 'NOPTS') return null;
  return {
    n: Number(r[1]),
    pts: Number(r[2]),
    ptsTime: Number(r[3]),
    rate: Number(r[4]),
    nbSamples: Number(r[5]),
    checksum: parseChecksum(r[6]),
  };
}

// --- forwarding limits (R2-O5, R3-8) -----------------------------------------------------------------------
// Two token buckets per generation, so a flood of junk can never starve a real error:
//   - untagged and unparseable-tap lines share a SMALL one. Today's error lines are rare; a drifted format
//     (a future ffmpeg that no longer parses) floods at the full record rate above, 30-70 lines/s per
//     camera, and would wipe the 1,000-line in-memory log (logger.js MAX_BUFFERED_LINES) within a minute;
//   - recognised [error] lines get their own LARGER one: only a pathological error storm binds it;
//   - [fatal]/[panic] are never suppressed.
// Each suppression is summarised by one note with the count and the LAST suppressed line's text. These are
// design numbers sized from the measured record rates, not measurements of error traffic: another install
// with a chattier camera can see more of its errors summarised, and the note says so when it happens.
export const LOG_FWD_RATE = 10; // lines/s
export const LOG_FWD_BURST = 50;
export const LOG_ERR_RATE = 50; // lines/s
export const LOG_ERR_BURST = 500;

function createBucket(rate, burst, monoNow) {
  let tokens = burst;
  let last = null;
  return {
    take() {
      const now = monoNow();
      if (last !== null) tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}

// ffmpeg's own wording (libavutil/log.c), so a collapsed run reads exactly as it did under -loglevel error.
function repeatNote(count) {
  return `    Last message repeated ${count} times`;
}

// The per-generation router the detectors put between `forwardProcessLines` and the logger.
//
// ★ GUARDED. This runs inside the child's stderr 'data' listener, where an exception is uncaught and takes
// the whole backend down. A throwing classifier forwards the RAW line through the small bucket and is
// counted; a throwing callback (the observation clock) is caught and counted, and its line is still
// treated as what it was.
export function createStderrRouter({
  taps,
  forward,
  onRecord = () => {},
  onConfig = () => {},
  onParseError = () => {},
  monoNow = () => performance.now(),
  classify = classifyLine,
  limits = {},
} = {}) {
  const small = createBucket(limits.fwdRate ?? LOG_FWD_RATE, limits.fwdBurst ?? LOG_FWD_BURST, monoNow);
  const errors = createBucket(limits.errRate ?? LOG_ERR_RATE, limits.errBurst ?? LOG_ERR_BURST, monoNow);
  const stats = {
    lines: 0, records: 0, config: 0, continuation: 0, fragments: 0, dropped: 0, forwarded: 0, suppressed: 0,
    unparseable: 0, lostRecords: 0, untagged: 0, collapsed: 0, classifierErrors: 0, callbackErrors: 0,
    // #573: audio records recovered from a line that had foreign text glued after the first av_log call.
    salvaged: 0,
  };
  // Rule B's memory: did the previous line reach (or try to reach) the log?
  let prevForwarded = null;
  // The re-collapse state: the last text handed to the log, and how many identical lines followed it.
  let lastText = null;
  let repeats = 0;
  // Pending suppression, reported once the log is reachable again (or at end()).
  let suppressedCount = 0;
  let suppressedLast = null;
  let ended = false;

  const safeForward = (text) => {
    try {
      forward(text);
      stats.forwarded += 1;
    } catch {
      stats.callbackErrors += 1;
    }
  };
  const flushRepeats = () => {
    if (repeats > 0) safeForward(repeatNote(repeats));
    repeats = 0;
  };
  const flushSuppressed = () => {
    if (suppressedCount > 0) {
      safeForward(`[obs] ${suppressedCount} ffmpeg stderr line(s) not shown (rate limit); last: ${suppressedLast}`);
      suppressedCount = 0;
      suppressedLast = null;
    }
  };

  // bucket: 'small' | 'error' | null (null = never suppressed: fatal/panic).
  function emit(text, bucket) {
    // ★ Decision B: identical CONSECUTIVE forwarded lines collapse into ffmpeg's own repeat note. Only
    // lines headed for the log take part — tap records never do, which is exactly why they no longer
    // break a run of identical errors apart the way they break ffmpeg's native collapse.
    // F4 (fix round 1): the key is the text AND its severity. The level token is stripped before this
    // point, so on text alone a [fatal] repeating an [error]'s words became "Last message repeated 1
    // times" and its severity never reached the log.
    const key = `${bucket ?? 'fatal'}\u0000${text}`;
    if (key === lastText) {
      repeats += 1;
      stats.collapsed += 1;
      return;
    }
    flushRepeats();
    const ok = bucket === null || (bucket === 'error' ? errors : small).take();
    if (!ok) {
      suppressedCount += 1;
      suppressedLast = text;
      stats.suppressed += 1;
      // Not "the last line shown": a repeat of a SUPPRESSED line must not be summarised as "Last message
      // repeated" under a line the log never received.
      lastText = null;
      return;
    }
    flushSuppressed();
    safeForward(text);
    lastText = key;
  }

  function callback(fn, arg) {
    try {
      fn(arg);
    } catch {
      stats.callbackErrors += 1;
    }
  }

  return {
    line(raw) {
      if (ended) return;
      stats.lines += 1;
      let d;
      try {
        d = classify(raw, taps);
      } catch {
        stats.classifierErrors += 1;
        prevForwarded = true;
        // F5 (fix round 1): the safety net must keep the promise the classifier keeps: a line that says
        // [fatal] or [panic] is never suppressed, even when the classifier that would have said so threw.
        emit(raw, FATAL_TOKEN.test(raw) ? null : 'small');
        return;
      }
      switch (d.kind) {
        case 'record':
          stats.records += 1;
          if (d.salvaged) stats.salvaged += 1;
          if (d.forwardText !== undefined) {
            // #573: a record recovered from a line with FOREIGN text glued on. The record goes to the clock;
            // the line still goes to the log exactly as the old `unparseable` sent it (same text, same
            // small bucket, counted as `unparseable`), because the foreign text is a real message (an
            // error from another thread) that must not be lost. `prevForwarded = true` is Rule B: the next
            // UNTAGGED line may be the second line of that foreign message, and the old `unparseable` left
            // it forwarded; with `false` that line would be dropped. No onParseError and no lostRecords:
            // the clock lost nothing.
            stats.unparseable += 1;
            prevForwarded = true;
            callback(onRecord, { tap: d.tap, ...d.rec });
            emit(d.forwardText, 'small');
            return;
          }
          prevForwarded = false;
          callback(onRecord, { tap: d.tap, ...d.rec });
          return;
        case 'config':
          stats.config += 1;
          prevForwarded = false;
          callback(onConfig, { tap: d.tap, dir: d.dir, tbNum: d.tbNum, tbDen: d.tbDen });
          return;
        case 'continuation':
          stats.continuation += 1;
          prevForwarded = false;
          return;
        case 'fragment':
          stats.fragments += 1;
          prevForwarded = false;
          if (d.lost) {
            stats.lostRecords += 1;
            callback(onParseError, d.tap);
          }
          return;
        case 'dropped':
          stats.dropped += 1;
          prevForwarded = false;
          return;
        case 'error':
          prevForwarded = true;
          emit(d.text, 'error');
          return;
        case 'fatal':
          prevForwarded = true;
          emit(d.text, null);
          return;
        case 'unparseable':
          stats.unparseable += 1;
          prevForwarded = true;
          if (d.lost) {
            stats.lostRecords += 1;
            callback(onParseError, d.tap);
          }
          emit(d.text, 'small');
          return;
        case 'untagged':
        default:
          stats.untagged += 1;
          // ★ RULE B (plan v4 refinement 1): an untagged line takes the fate of the line before it. A
          // multi-line message is written under one log.c lock, so its continuation directly follows it,
          // and "Last message repeated" always describes the line before it. The first line of a stream
          // has no predecessor and is forwarded (conservative). Fixes the two leaks the Step-0 build found:
          // a multi-line WARNING's second line reaching the log, and an orphaned repeat note.
          if (prevForwarded === false) {
            stats.dropped += 1;
            return;
          }
          prevForwarded = true;
          emit(d.text ?? raw, 'small');
      }
    },
    // Generation end: say what is still owed (a held repeat count, a suppression summary) so nothing is
    // silently lost with the process.
    end() {
      if (ended) return;
      ended = true;
      flushRepeats();
      flushSuppressed();
    },
    stats: () => ({ ...stats }),
  };
}
