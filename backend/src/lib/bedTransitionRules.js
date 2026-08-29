// Pure decision rules for the bed-boundary detector. No imports, deliberately: `motionDetector.js`
// pulls in ffmpeg, MediaMTX and the alert stack, so anything that lives there is unreachable from a
// unit test — which is how the exit rule below stayed unable to see a child climbing out unaided for
// months without a single test going red. Rules that can be stated as a function belong here.

// --- "Out of bed": how long after the bed last moved may an outside burst still be the same body? ---
//
// TWO windows, because the two ways a body leaves a bed do not look alike:
//
//   - An adult LIFTING a child out is one continuous movement, so the bed and the area beside it are in
//     motion within a few hundred milliseconds of each other. Every confirmed exit in the production
//     logs links in 190-620 ms, comfortably inside the fast window.
//   - A child climbing out HIMSELF shakes the bed, then stands on the floor, and only moves across the
//     room some seconds later. Nothing bridges that pause. Prod, 2026-08-28: Renz was out at 05:52 (bed
//     0.050, outside quiet), moving around the room by 05:53 (outside 0.104, bed quiet) and gone by
//     05:55 — no candidate was ever opened, and with no departure to corroborate the empty-bed gap his
//     wake was reported as 07:14 instead of 05:52.
//
// The slow window is therefore allowed, but only for a substantial outside burst. That floor is what
// keeps it from admitting noise, and it is measured rather than guessed: across 10.7 days of retained
// samples on both cameras the "bed active, then outside-only the next minute" shape occurs four times —
// three at outside 0.010-0.012 with nobody in either room, and one at 0.104, the real exit above. 0.05
// separates those two populations with a wide margin on both sides.
export const OOB_LINK_MS = 8000; // bed active within this long before the outside burst = a lift-out
export const OOB_LINK_SLOW_MS = 60000; // ...or this long, if the outside burst is big enough to be a body
export const OOB_SLOW_OUT_MIN = 0.05; // outside changed-fraction required to use the slow window

// Which link window (if any) lets this outside burst be read as motion that LEFT the bed.
// Returns 'fast' | 'slow' | null.
export function oobLinkKind(sinceMs, outFraction) {
  if (sinceMs <= OOB_LINK_MS) return 'fast';
  if (sinceMs <= OOB_LINK_SLOW_MS && outFraction >= OOB_SLOW_OUT_MIN) return 'slow';
  return null;
}
