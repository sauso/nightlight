# CSP hardening — what to do to safely turn Content-Security-Policy back on

**Status:** not started. This is the fix for security-review finding #2 (CSP deliberately disabled).
It's defense-in-depth, not an active vulnerability — there is currently **no** HTML-injection sink
(React escapes by default, no `dangerouslySetInnerHTML`, theming uses CSSOM `setProperty`). CSP is the
seatbelt that would contain a *future* accidental sink or a compromised dependency. Worth doing because
the app is internet-facing and streams video/audio of the kids.

## Why it's off today
`backend/src/index.js` sets `helmet({ contentSecurityPolicy: false })`. The inline comment names two
worries: (1) the theming feature "applies colors via inline styles", and (2) WebRTC connects out to a
STUN server. Both are real considerations but **neither actually forces CSP off** — they just need the
right directives. Every other helmet protection (clickjacking, MIME-sniffing, etc.) is already on.

## The golden rule: roll out in **report-only** first
Do **not** flip straight to an enforcing policy — you'll almost certainly break a stream or the PWA and
have to guess why. Instead:

1. Ship the policy as **`Content-Security-Policy-Report-Only`** first. The browser then *reports*
   violations to the console (and to a report endpoint if configured) but **blocks nothing**.
2. Exercise every feature (test matrix below) on staging, watch the console for
   `Refused to … because it violates the following Content Security Policy directive: …`.
3. Add each legitimately-needed source to the offending directive until the console is clean across all
   features.
4. Only then rename the header to the enforcing **`Content-Security-Policy`** and re-test once more.

Keep it on **staging** for this whole loop; promote to prod only after a clean enforcing run.

## Where to make the change
In `backend/src/index.js`, replace `helmet({ contentSecurityPolicy: false })` with an explicit policy.
Helmet supports report-only via `reportOnly: true`. Start here:

```js
app.use(helmet({
  contentSecurityPolicy: {
    reportOnly: true, // PHASE 1: report, don't block. Flip to false once the console is clean.
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // Vite's production build emits ONE external module script (no inline scripts), so 'self' is
      // enough — do NOT add 'unsafe-inline'/'unsafe-eval' to script-src (that's the whole point of CSP).
      // If a dependency turns out to need eval/wasm, prefer 'wasm-unsafe-eval' over 'unsafe-eval', and
      // confirm which dependency and why before adding it.
      scriptSrc: ["'self'"],
      // Theming sets CSS custom properties via element.style.setProperty (CSSOM) and React uses
      // style={{…}} — both are CSSOM, which CSP does NOT block, so try WITHOUT 'unsafe-inline' first.
      // Vite serves app CSS as an external <link> ('self'). Add 'unsafe-inline' ONLY if report-only
      // shows real style violations you can't remove (style-src injection is far lower-risk than script).
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],        // snapshots are same-origin; posters/icons use data: URIs (see HlsPlayer BLANK_POSTER)
      mediaSrc: ["'self'", 'blob:'],      // hls.js feeds the <video> via MSE blob: URLs; native HLS is same-origin
      workerSrc: ["'self'", 'blob:'],     // hls.js spawns its demuxer worker from a blob: URL — a classic CSP breaker
      // Same-origin covers the REST API, HLS proxy, and the wss:// talk WebSocket. The extra host is the
      // client-side WebRTC STUN server (frontend/src/components/WhepPlayer.jsx → stun.l.google.com:19302).
      // CSP3 gates ICE against connect-src — keep this in sync if the STUN/TURN server ever changes.
      connectSrc: ["'self'", 'stun.l.google.com:19302'],
      fontSrc: ["'self'", 'data:'],       // include data: in case any @font-face is inlined
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],         // clickjacking (modern equivalent of X-Frame-Options)
      // upgradeInsecureRequests intentionally omitted: the app is also served over plain http on the LAN
      // (and the mobile app allows cleartext for LAN installs) — forcing https would break those.
    },
  },
}));
```

## Test matrix (run for BOTH report-only and enforcing)
Tick every one on staging with the browser console open; each exercises a different directive:

- [ ] **Live view — Low latency (WebRTC / WhepPlayer):** stream plays. Watches `connect-src` (STUN + same-origin WHEP).
- [ ] **Live view — Compatibility (HLS / HlsPlayer):** stream plays in both hls.js (Chrome/Android) *and* native (Safari/iOS). Watches `media-src blob:`, `worker-src blob:`, `connect-src 'self'`.
- [ ] **Two-way audio (talk):** hold-to-talk connects. Watches the `wss://` talk WebSocket under `connect-src 'self'`.
- [ ] **Snapshots / crib-zone picker backdrop:** `<img>` loads. Watches `img-src 'self' data:`.
- [ ] **Alert clips + timelapses:** `<video>` plays. Watches `media-src`.
- [ ] **Theming:** change accent/live/offline colors and fonts in Settings → they apply live. Watches `style-src` (should pass without 'unsafe-inline' — confirm).
- [ ] **PWA install + service worker + push:** install prompt works, notifications register. Service worker registration can surface `script-src`/`worker-src` issues.
- [ ] **General app nav, login, settings screens:** no console violations anywhere.

## Known gotchas (learned/expected for this stack)
- **hls.js needs `worker-src blob:` and `media-src blob:`** — the single most likely thing to break a strict CSP here. If Compatibility mode shows a black tile with a worker/blob violation, this is why.
- **WebRTC STUN is gated by `connect-src`** in modern browsers. A silently-failing "Low latency" stream that never leaves *Connecting…* with a `connect-src` violation for `stun.l.google.com` is the tell. Keep the STUN host in sync with `WhepPlayer.jsx`.
- **Theming likely needs NOTHING extra.** `document.documentElement.style.setProperty(...)` (SettingsContext.jsx) and React `style={{…}}` are CSSOM writes, which CSP doesn't police. The old "inline styles" worry in the index.js comment is about HTML `style=` attributes / `<style>` blocks, which this app doesn't generate at runtime. Verify in report-only; only add `style-src 'unsafe-inline'` if a real violation appears.
- **Don't add `'unsafe-inline'`/`'unsafe-eval'` to `script-src`.** That negates most of CSP's value. If report-only flags an inline script, find and externalise it instead.
- **Plain-http LAN + mobile cleartext:** do *not* add `upgrade-insecure-requests` or `block-all-mixed-content` — the app is deliberately reachable over http on the LAN and the Android app allows cleartext for direct-IP installs.

## Optional: collect violation reports centrally
For the report-only phase you can capture violations server-side instead of eyeballing each console:
add a `reportUri`/`report-to` directive pointing at a tiny `POST /api/csp-report` route that logs the
JSON body (via the existing logger). Handy if you want to test from phones/other devices where you
can't watch the console. Remove or keep it as you prefer once enforcing.

## Definition of done
- Enforcing `Content-Security-Policy` (not report-only) live in `index.js`, replacing `contentSecurityPolicy: false`.
- Every item in the test matrix passes on staging with zero console violations, then again on prod after release.
- The `script-src` has no `'unsafe-inline'`/`'unsafe-eval'`.
- Update the CSP comment in `index.js` to describe the policy instead of explaining why it's disabled, and add a `### Security` CHANGELOG entry.
