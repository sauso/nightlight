import { getMediaToken } from './api.js';

// Makeup gain applied to the mic before mu-law encoding. The camera's own speaker volume is the
// bigger lever (set it high in the camera's web UI), but these speakers run quiet, so lift the
// outgoing level here too. Hard-clipped, so raising it trades headroom for loudness.
const TALK_GAIN = 3;

// G.711 mu-law encode: one 16-bit signed PCM sample -> one 8-bit mu-law byte. The camera's
// two-way-audio channel expects G.711 mu-law at 8 kHz mono (see backend/lib/twoWayAudio.js).
function linearToMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    /* find exponent */
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Downsample the mic (native rate, usually 48 kHz) to 8 kHz by box-averaging each output sample
// over its source window - a cheap low-pass that keeps voice intelligible without much aliasing.
function downsample(input, inRate) {
  if (inRate <= 8000) return input;
  const ratio = inRate / 8000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) { sum += input[j]; count++; }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

// Start push-to-talk to a camera: capture the mic, encode to G.711 mu-law @ 8 kHz, and stream it
// over a WebSocket to the backend (which forwards it to the camera's speaker). Returns a `stop`
// function synchronously - call it to end the talk (releasing the button). Safe to call stop()
// before setup finishes.
export function startTalk(cameraId, { onError, onReady } = {}) {
  let stopped = false;
  let ctx = null;
  let source = null;
  let processor = null;
  let ws = null;
  let stream = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { if (processor) processor.onaudioprocess = null; } catch { /* ignore */ }
    try { processor?.disconnect(); } catch { /* ignore */ }
    try { source?.disconnect(); } catch { /* ignore */ }
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { ctx?.close(); } catch { /* ignore */ }
    try { ws?.close(); } catch { /* ignore */ }
  };

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }

      const Ctx = window.AudioContext || window.webkitAudioContext;
      // Use the context's NATIVE rate and downsample to 8 kHz ourselves. Forcing an 8 kHz context
      // makes some browsers feed the mic in as silence (the graph runs - correct byte rate - but the
      // samples are all zero), which is exactly the "sends audio but camera is silent" symptom.
      ctx = new Ctx();
      // A freshly-created context can start suspended even from a user gesture; without resuming it,
      // onaudioprocess never fires and no audio is sent (looked like a dead mic).
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* ignore */ } }
      const inRate = ctx.sampleRate;
      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(2048, 1, 1);

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(
        `${proto}://${location.host}/api/talk?camera=${encodeURIComponent(cameraId)}&token=${encodeURIComponent(getMediaToken() || '')}`
      );
      ws.binaryType = 'arraybuffer';
      let ready = false;

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ready') { ready = true; onReady?.(); }
          else if (msg.type === 'error') { onError?.(msg.error || 'Talk failed'); stop(); }
        } catch { /* ignore non-JSON */ }
      };
      ws.onerror = () => { onError?.('Talk connection error'); stop(); };
      ws.onclose = () => stop();

      processor.onaudioprocess = (e) => {
        if (!ready || ws.readyState !== WebSocket.OPEN) return;
        const pcm = downsample(e.inputBuffer.getChannelData(0), inRate);
        const out = new Uint8Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          // Makeup gain (hard-clipped) before mu-law: these camera speakers are quiet, so lift the
          // level and let it clip like a limiter - fine for intelligible voice talk-down.
          const s = Math.max(-1, Math.min(1, pcm[i] * TALK_GAIN));
          out[i] = linearToMuLaw((s * 32767) | 0);
        }
        ws.send(out.buffer);
      };

      source.connect(processor);
      // ScriptProcessor needs to be in the graph for its callback to fire; we never write its
      // output buffer, so what reaches the speakers is silence (no local echo of your own voice).
      processor.connect(ctx.destination);
    } catch (e) {
      onError?.(e?.message || 'Could not access the microphone');
      stop();
    }
  })();

  return stop;
}
