// Options shared by the two MediaMTX reverse proxies in index.js (/live for WHEP signalling, /hls for
// Compatibility video). Kept in a module of its own so a test can import the real values: index.js cannot be
// imported (it spawns MediaMTX and FFmpeg).
//
// ⚠️ `agent: false` is deliberate. http-proxy-middleware 4.x (httpxy) falls back to a module-wide keep-alive
// agent (256 sockets) when no agent is given, where 3.x (http-proxy) opened a fresh connection per request. MediaMTX
// closes an idle HTTP connection after 30 s (IdleTimeout in its Go http.Server) without a `Keep-Alive: timeout`
// hint, so Node keeps the pooled socket and a request that picks it just as MediaMTX closes it fails with a 504.
// The review of the 4.2.1 bump reproduced it against an upstream that closes idle sockets (4 failures in 300
// requests spaced near that idle time; 0 with `agent: false`, and 0 in 300 on 3.x). It should be rare in
// production (the request has to land within milliseconds of the 30 s mark), but one failed HLS fetch or WHEP
// POST is a visible stall, and what we gain from reuse is a few connection setups on the loopback. `agent: false`
// is exactly what 3.x did, so live video behaves as it did before the bump. If this is ever changed, use one
// shared agent whose `timeout` is below MediaMTX's 30 s, not the default.
export const MEDIA_PROXY_BASE_OPTIONS = Object.freeze({
  changeOrigin: true,
  agent: false,
});
