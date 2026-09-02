/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// One config for the app build and the tests, so the React plugin's JSX transform applies to both.
// A separate vitest.config.js REPLACES this file rather than merging with it, which left test files
// compiling with the classic JSX runtime ("React is not defined").
export default defineConfig({
  plugins: [react({ include: /\.(js|jsx)$/ })],
  // Belt and braces for the automatic JSX runtime: without this, test files outside src/ were
  // compiled with the classic runtime and every render threw "React is not defined".
  //
  // This was `esbuild: { jsx: 'automatic', jsxImportSource: 'react' }` until vitest 4 / vite 8, which
  // transform with oxc instead and IGNORED the esbuild block — announcing it only as a startup notice
  // ("Both esbuild and oxc options were set... esbuild options will be ignored"). Tests kept passing,
  // because the React plugin above does the transform on its own, so the safety net had quietly
  // stopped existing without anything failing. Restated for oxc so it means something again.
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
  // Front-end tests. Two layers, deliberately:
  //   * component tests (fast, every push) for rendering, state and ROLE GATING;
  //   * role-based Playwright flows in e2e/ for what a person actually does end to end.
  //
  // Role gating gets first-class attention because it is real in this UI (`isAdmin` branches in the
  // tiles, camera pages and settings) and because that is exactly where a shipped bug hid: an
  // admin-only route that 403'd everyone, invisible until someone clicked it.
  test: {
    environment: 'jsdom',
    // Pinned so the suite does not give a different verdict on a different developer's clock. Without
    // it, a mutant that formatted times in the BROWSER's zone instead of the app's configured one
    // survived here — because this machine happens to share Melbourne's offset. This repo has already
    // shipped one daylight-saving bug; a timezone-dependent test suite is how the next one gets missed.
    //
    // ⚠️⚠️ IT IS PINNED TO A ZONE THAT IS NOT UTC, AND THAT IS THE WHOLE POINT. It was `UTC`, which
    // is deterministic but blind: under UTC, "parse this timestamp as local" and "parse it as UTC"
    // are THE SAME OPERATION, so no test could ever catch the two being confused — and that confusion
    // is exactly what shipped here before (a review window anchored on a literal `04:00Z`, and a
    // daylight-saving bug). Measured 2026-09-01: with `TZ: 'UTC'`, a mutant dropping the `Z` from
    // `utcMs` and a mutant building `addDays` in local time BOTH survived the whole suite. Under this
    // zone both die.
    //
    // The choice is deliberate on three counts, and a replacement needs all three:
    //   * NOT UTC — so local-vs-UTC confusion is visible at all;
    //   * AHEAD of UTC — so local midnight falls on the PREVIOUS UTC day, which is what exposes
    //     date-arithmetic that formats a local Date with `toISOString()`;
    //   * NOT a zone any test passes as the app's own timezone — otherwise the original mutant this
    //     pinning was introduced for (format in the browser's zone rather than the app's) comes back
    //     to life, because the two zones would agree again.
    // Pacific/Auckland is UTC+12/+13, observes DST, and is used nowhere as an app timezone.
    env: { TZ: 'Pacific/Auckland' },
    globals: true,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.{js,jsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: ['src/**/*.{js,jsx}'],
      // Measure the app, not the plumbing.
      //
      // ⚠️ EVERY ENTRY HERE NEEDS A REASON, AND THE REASON MUST BE "jsdom CANNOT RUN THIS", never
      // "this is hard to test" or "this would take the number down". The list exists because the
      // threshold below is meaningless otherwise: measured 2026-09-01, these files are 2,646 of the
      // front end's 11,035 lines — 24% — so with them counted, 80% GLOBAL was unreachable even with
      // perfect coverage of everything else, and a target nobody can hit is a target everyone ignores.
      // Covering these would mean mocking the browser and then asserting the mocks; they are covered
      // for real by the Playwright suite in e2e/, which runs an actual Chromium.
      exclude: [
        'src/main.jsx', // the bootstrap: mounts the tree, no logic of its own
        // --- media: jsdom implements none of these APIs ---
        'src/components/WhepPlayer.jsx', // RTCPeerConnection / WHEP
        'src/components/HlsPlayer.jsx', // hls.js + MediaSource Extensions
        // Mounts both players above, plus the Fullscreen, Picture-in-Picture and pointer-gesture APIs.
        // ⚠️ NOT a licence to stop testing it: its pure logic is deliberately extracted into exported
        // helpers (detectionPayload, readingParts, fmtElapsed) which ARE tested, and anything else
        // worth pinning should be extracted the same way rather than left here to hide.
        'src/components/CameraTile.jsx',
        // A dnd-kit wrapper that renders CameraTile — mounting it mounts the whole player stack, so it
        // inherits the exclusion above rather than being untestable in itself.
        'src/components/SortableCameraTile.jsx',
        // The live grid. Renders one SortableCameraTile per camera, so mounting it mounts the whole
        // player stack too, and its own effects are Capacitor (picture-in-picture, background pause)
        // and pointer-gesture pull-to-refresh — none of which exist in jsdom.
        // ⚠️ Same condition as CameraTile: its one piece of real logic, the drag-reorder, is exported
        // as `reorderCameras` and IS tested (liveMonitorHelpers.test.jsx). Anything else worth pinning
        // gets extracted the same way rather than left in here to hide behind this line.
        'src/components/LiveMonitor.jsx',
        'src/components/InstallPrompt.jsx', // the `beforeinstallprompt` PWA event
        // --- native shell: Capacitor plugins are simply absent outside the APK ---
        'src/lib/nativeBridge.js',
        'src/lib/pushNotifications.js',
        'src/lib/useHardwareBack.js',
        // --- other browser-only surfaces ---
        'src/lib/twoWayTalk.js', // getUserMedia + a WebSocket audio pipe
        'src/lib/useNowPlaying.js', // the MediaSession API
        'src/lib/usePullToRefresh.js', // touch gestures against real scroll position
        'src/lib/useSwipeBack.js', // touch gestures
        'src/lib/imageResize.js', // canvas drawImage/toBlob — jsdom's canvas is a stub
      ],
      // Phase 5 target: >= 80% of the front end that CAN be tested. Raise as suites land; never lower
      // to go green, and never widen the exclude list to go green either — that is the same thing
      // wearing a different hat, and it is why each entry above has to justify itself.
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
