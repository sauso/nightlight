#!/bin/sh
# Captured ffmpeg fixtures for issue #373 Stage 2, plan v4 (LEAN taps + the round-3 fps slot runs).
# The v3 set beside this script (capture.sh) is kept as the record of what Step 0 confirmed before the
# lean decision; it is not regenerated here, because the golden test pins addresses from it.
#
# ★ THESE ARE CAPTURED, NOT HAND-WRITTEN. Every file this script writes is the literal stderr/stdout of
# the ffmpeg in the `sauso/nightlight:dev` image (ffmpeg 8.1.2, Alpine). The tests that read them use
# them as an INDEPENDENT oracle: for Adler-32 (the `out` checksum against the stdout bytes), for the lean
# tap names, and, for the fps-slot-*.err runs, for which input frame `fps=5` really emitted into which
# output slot. Synthetic lavfi sources only: no camera, no recording.
#
# Regenerate (from the repo root, Git Bash on Windows shown; drop MSYS_NO_PATHCONV elsewhere):
#   MSYS_NO_PATHCONV=1 docker run --rm --network none -v "$(pwd -W)/backend/test/fixtures/obs:/out" \
#     --entrypoint sh sauso/nightlight:dev /out/capture-v4.sh
# ⚠️ A regenerated set differs in the 0x... context addresses (ASLR). The tests never compare addresses.
set -u
cd /out
ffmpeg -version | head -1 > ffmpeg-version-v4.txt

# --- the LEAN motion chain (plan v4 decision A) --------------------------------------------------------
# Two taps: `in` with its checksum OFF (that Adler-32 over every full-resolution input frame was the
# measured cost), and `out` after format=gray with its checksum ON (it aligns stdout by content). Named
# instances, so the log tags are `showinfo@in` / `showinfo@out` and nothing has to guess a position.
LEAN32="showinfo@in=checksum=0,fps=5,scale=32:18,format=gray,showinfo@out"
LEAN320="showinfo@in=checksum=0,fps=5,scale=320:180,format=gray,showinfo@out"
# 32x18 output. Input: 10 fps with the frames in t=[1.0,1.65] removed, so fps=5 has to CLONE across the
# hole. -t 3 stops muxing after 15 frames while the graph has already emitted a 16th `out` record: an
# `out` record with no stdout frame, which is exactly the end-of-generation case (plan v4 refinement 3).
ffmpeg -nostdin -loglevel +level+info -nostats \
  -f lavfi -i "testsrc2=size=320x180:rate=10,select='not(between(t,1.0,1.65))'" \
  -t 3 -an -vf "$LEAN32" -f rawvideo - > lean-32x18.gray 2> lean-32x18.err
# Production geometry (320x180), 2 frames: the Adler-32 check at the real frame size.
ffmpeg -nostdin -loglevel +level+info -nostats \
  -f lavfi -i "testsrc2=size=640x360:rate=10" \
  -frames:v 2 -an -vf "$LEAN320" -f rawvideo - > lean-320x180.gray 2> lean-320x180.err

# --- how fps=5 picks a source frame (plan v4, "Round-3 experiments", runs A-E) --------------------------
# Ported from the plan's fps-slot-experiments.sh. Every input frame is unique noise, so an `out` checksum
# names exactly one `in` frame: these captures say which input reached which output slot, independently
# of any rule the observation clock implements. Both taps have checksum=1 HERE ONLY, because the checksum
# is the oracle; the production `in` tap runs without one. Input PTS are planted with setpts (seconds).
SRC="color=c=black:size=64x48:rate=20,geq=lum='random(1)*255':cb=128:cr=128"
slot() { # $1 run name, $2 setpts expression in seconds, $3 frame count
  ffmpeg -nostdin -hide_banner -nostats -loglevel +level+info -f lavfi -i "$SRC" \
    -vf "trim=end_frame=$3,setpts='($2)/TB',showinfo@in=checksum=1,fps=5,showinfo@out=checksum=1" \
    -f null - 2> fps-slot-$1.err
}
# A: pts 0, 0.05, 0.2. The first two share slot 0: which one wins it? (R4-1)
slot A 'if(eq(N,0),0,if(eq(N,1),0.05,0.2))' 3
# B: the normal case, 10 fps in (pts N*0.1): half the inputs are never a source; is the last one emitted
# at end of stream? (R4-1, R4-3)
slot B 'N*0.1' 7
# E: latest vs nearest. Slot 1 is 0.2 s; n1 sits exactly on it, n2 (0.25) is later in the same slot. (R4-1)
slot E 'if(eq(N,0),0,if(eq(N,1),0.2,if(eq(N,2),0.25,0.4)))' 4
# C: backwards pts (0, 0.4, 0.2, 0.8): what does slot membership say vs what fps emitted? (R4-2)
slot C 'if(eq(N,0),0,if(eq(N,1),0.4,if(eq(N,2),0.2,0.8)))' 4
# D: a stall (0, 0.1, then nothing until 1.5, then 1.6): the clone run and its source. (R4-4)
slot D 'if(eq(N,0),0,if(eq(N,1),0.1,if(eq(N,2),1.5,1.6)))' 4
# F: B cut to 6 frames, so the FINAL input (n5, 0.5 s -> slot 2.5 -> 3) is ALONE in its slot. Does fps
# still emit it at end of stream? If so, losing that one record leaves an output slot with no input in it
# and no later record to prove a clone: the case R4-3 exists for. (Added by the v4 build.)
slot F 'N*0.1' 6
ls -la /out
