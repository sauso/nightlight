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
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
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
    globals: true,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.{js,jsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      // Measure the app, not the plumbing. main.jsx is the bootstrap; the players are thin wrappers
      // around browser media APIs jsdom cannot meaningfully run.
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx'],
      // Phase 5 target: >= 80% of the front end. Raise as suites land; never lower to go green.
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
