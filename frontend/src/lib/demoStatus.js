import { useEffect, useState } from 'react';
import { api } from './api.js';

let demoStatusPromise;

function loadDemoStatus() {
  if (!demoStatusPromise) {
    demoStatusPromise = api.get('/auth/status')
      .then((status) => status?.demo || null)
      .catch(() => null);
  }
  return demoStatusPromise;
}

// `undefined` means the one page-level request is still resolving. Once resolved, consumers receive
// either the demo descriptor or null. Keeping the promise at module scope makes StrictMode's effect
// replay — and multiple consumers mounted together — share the same request.
export function useDemoStatus() {
  const [demo, setDemo] = useState(undefined);

  useEffect(() => {
    let live = true;
    loadDemoStatus().then((value) => {
      if (live) setDemo(value);
    });
    return () => { live = false; };
  }, []);

  return demo;
}

// A browser page never clears this cache; tests do so to model a fresh page load per case.
export function resetDemoStatusForTests() {
  demoStatusPromise = undefined;
}
