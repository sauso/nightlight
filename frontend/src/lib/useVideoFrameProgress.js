import { useEffect, useRef } from 'react';

// A connection, playlist or decoder counter is not a picture shown to this browser.
// This optional observer reports only successive presented frames, or later playback
// time progress on older WebViews. Each effect run owns its callbacks so reconnects
// cannot finish a newer monitor test.
export function useVideoFrameProgress(videoRef, enabled, testId, onFrames, generation) {
  const latest = useRef({ testId, onFrames });
  latest.current = { testId, onFrames };

  useEffect(() => {
    const video = videoRef.current;
    if (!enabled || !testId || !onFrames || !video) return undefined;
    let cancelled = false;
    let done = false;
    const report = () => {
      if (!cancelled && !done && latest.current.testId === testId && latest.current.onFrames) {
        done = true;
        latest.current.onFrames(testId);
      }
    };

    if (typeof video.requestVideoFrameCallback === 'function') {
      let handle;
      let previous = null;
      const frame = (_now, metadata) => {
        if (cancelled) return;
        const count = metadata?.presentedFrames;
        if (Number.isFinite(count) && previous !== null && count > previous) report();
        previous = count;
        if (!done) handle = video.requestVideoFrameCallback(frame);
      };
      handle = video.requestVideoFrameCallback(frame);
      return () => {
        cancelled = true;
        if (typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(handle);
      };
    }

    // Native HLS seeks to its live edge on loadedmetadata. A seek (including that
    // programmatic one) resets the baseline and cannot count as playback progress.
    let previous = null;
    let advances = 0;
    let firstAdvanceAt = 0;
    let ignoreUntil = 0;
    const reset = () => {
      previous = null;
      advances = 0;
      firstAdvanceAt = 0;
      ignoreUntil = Date.now() + 800;
    };
    video.addEventListener('seeking', reset);
    video.addEventListener('seeked', reset);
    video.addEventListener('loadedmetadata', reset);
    const interval = setInterval(() => {
      if (cancelled || done || Date.now() < ignoreUntil || video.seeking) return;
      const time = video.currentTime;
      if (!Number.isFinite(time)) return;
      if (previous !== null) {
        const delta = time - previous;
        if (delta < 0 || delta > 2) { reset(); previous = time; return; }
        if (delta > 0) {
          if (!firstAdvanceAt || Date.now() - firstAdvanceAt > 4000) {
            firstAdvanceAt = Date.now();
            advances = 1;
          } else advances += 1;
          if (advances >= 2) report();
        }
      }
      previous = time;
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(interval);
      video.removeEventListener('seeking', reset);
      video.removeEventListener('seeked', reset);
      video.removeEventListener('loadedmetadata', reset);
    };
  }, [videoRef, enabled, testId, !!onFrames, generation]);
}
