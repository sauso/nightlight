import { useEffect } from 'react';
import {
  subscribeBackgroundCameras,
  backgroundCameraCount,
  subscribeBackgroundAudioCommand,
  commandBackgroundAudio,
} from './nativeBridge.js';

// App icon shown as the lock-screen / Now Playing artwork (same-origin URLs the OS fetches).
// Without any artwork, iOS shows a blank tile; without metadata at all it falls back to just
// the app name.
// Dedicated Now Playing tile (icons/now-playing-512.png): the app icon's night scene cropped to
// fill the whole square edge-to-edge - no border/corners at any size (the app icon is a rounded
// square, so anything short of a full-bleed crop shows its navy corners when enlarged on the lock
// screen). The ?v= is a cache-buster: this URL is otherwise stable, so the WebView / iOS artwork
// cache keeps serving an old image after we change the file. BUMP THIS whenever the file changes.
export const NOW_PLAYING_ARTWORK = [
  { src: '/icons/now-playing-512.png?v=3', sizes: '512x512', type: 'image/png' },
];

// Own the system media session (Now Playing / lock screen) while this camera is the active
// Background-audio one and actually playing. Shared by both players so Low latency (WebRTC) and
// Compatibility (HLS, iOS background) present identical metadata + controls - the same camera
// name, the same artwork, the same real Pause/Play.
//
// `mediaElRef` is the element actually carrying the background sound (the dedicated <audio>
// element in both callers). Pause/Play operate on it for real (not a mute): iOS tracks the
// element's actual playback state for Now Playing, so a mute-with-playbackState='paused' mismatch
// made it drop our session (-> "My music") and refuse to resume. Pausing the element keeps our
// session shown as paused and lets Play resume it at the live edge. Pause/Play broadcast to ALL
// background players (commandBackgroundAudio) so several cameras pause/resume together, not just
// whichever one happens to own the media session.
export function useNowPlayingSession({ enabled, cameraName, mediaElRef }) {
  useEffect(() => {
    if (!('mediaSession' in navigator) || !enabled) return undefined;
    // Title shows this camera's name when it's the only one being listened to, or "Multiple
    // Cameras" when several are. Re-applied whenever the background-camera set changes, since a
    // second camera joining (or leaving) should flip the title live.
    function applyMetadata() {
      try {
        const title = backgroundCameraCount() >= 2 ? 'Multiple Cameras' : cameraName || 'Camera';
        navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Nightlight', artwork: NOW_PLAYING_ARTWORK });
      } catch {
        // ignore
      }
    }
    try {
      applyMetadata();
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('pause', () => {
        commandBackgroundAudio(true);
        try { navigator.mediaSession.playbackState = 'paused'; } catch { /* ignore */ }
      });
      navigator.mediaSession.setActionHandler('play', () => {
        commandBackgroundAudio(false);
        try { navigator.mediaSession.playbackState = 'playing'; } catch { /* ignore */ }
      });
    } catch {
      // Not every engine supports the full Media Session API - non-fatal.
    }
    const unsubscribe = subscribeBackgroundCameras(applyMetadata);
    // Respond to Pause/Play from whichever camera owns the media session, so this one pauses/
    // resumes in lock-step with the rest.
    const unsubscribeCmd = subscribeBackgroundAudioCommand((paused) => {
      if (paused) mediaElRef.current?.pause();
      else mediaElRef.current?.play().catch(() => {});
    });
    return () => {
      unsubscribe();
      unsubscribeCmd();
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
      } catch {
        // ignore
      }
    };
  }, [enabled, cameraName, mediaElRef]);
}
