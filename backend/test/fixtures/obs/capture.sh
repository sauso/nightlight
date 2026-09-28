#!/bin/sh
# Captured ffmpeg fixtures for issue #373 Stage 2 (the observation clock). Step 0, the evidence gate.
#
# ★ THESE ARE CAPTURED, NOT HAND-WRITTEN. Every .err/.gray/.pcm file beside this script is the literal
# stderr/stdout of the ffmpeg in the `sauso/nightlight:dev` image (ffmpeg 8.1.2, Alpine), produced by
# this script. The tests that read them use them as an INDEPENDENT oracle for what ffmpeg really
# prints, so a parser written from memory of ffmpeg's source cannot pass by agreeing with itself.
# Synthetic lavfi sources only (testsrc2, sine, anoisesrc, aevalsrc): no camera, no recording.
#
# Regenerate (from the repo root, Git Bash on Windows shown; drop MSYS_NO_PATHCONV elsewhere):
#   MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/backend/test/fixtures/obs:/out" \
#     --entrypoint sh sauso/nightlight:dev /out/capture.sh
# ⚠️ A regenerated set differs in the 0x... context addresses (ASLR) and, after an ffmpeg upgrade,
# possibly in format. That is the point of keeping them: a format drift shows up as a diff here.
# ⚠️ The files must stay byte-exact, so this directory is `-text` in .gitattributes (no CRLF
# conversion: a 0x0A inside a raw gray frame would otherwise be rewritten on a Windows checkout).
set -u
cd /out
ffmpeg -version | head -1 > ffmpeg-version.txt
TAPS_NAMED="showinfo@in,fps=5,showinfo@pick,scale=32:18,format=gray,showinfo@out"
TAPS_POS320="showinfo,fps=5,showinfo,scale=320:180,format=gray,showinfo"
OLDVF="fps=5,scale=32:18,format=gray"

# --- motion taps -------------------------------------------------------------------------------------
# 32x18 output, named taps. Input: 10 fps with the frames in t=[1.0,1.65] removed, so fps=5 has to
# CLONE across the hole (picks 6-8 repeat input n=9). -t 3 stops muxing after 15 frames while the
# graph has already emitted a 16th `out` record: a record with no stdout frame, as at a generation end.
ffmpeg -nostdin -loglevel +level+info -nostats \
  -f lavfi -i "testsrc2=size=320x180:rate=10,select='not(between(t,1.0,1.65))'" \
  -t 3 -an -vf "$TAPS_NAMED" -f rawvideo - > motion-32x18.gray 2> motion-32x18.err

# Production geometry (320x180), 2 frames, the POSITIONAL spelling: tags are Parsed_showinfo_0/2/5.
ffmpeg -nostdin -loglevel +level+info -nostats \
  -f lavfi -i "testsrc2=size=640x360:rate=10" \
  -frames:v 2 -an -vf "$TAPS_POS320" -f rawvideo - > motion-320x180.gray 2> motion-320x180.err

# Integer slot edges on the RTSP clock (1/90000). One 5 fps slot = 18000 ticks, a half slot = 9000.
# Input pts, and pts/18000:
#   0 0 | 26999 1.49994 | 45000 2.5 | 81001 4.50006 | 116999 6.49994 | 153000 8.5 | 171000 9.5
#   | 207001 11.50006 | 234000 13 | 252000 14 | 270000 15 | 288000 16
# 2.5 and 8.5 separate round-half-away-from-zero (NEAR_INF, gives 3 and 9) from half-even and from
# truncation (2 and 8); the +-1 tick pairs pin which side of each edge a frame lands.
PTS='if(eq(N,0),0,if(eq(N,1),26999,if(eq(N,2),45000,if(eq(N,3),81001,if(eq(N,4),116999,if(eq(N,5),153000,if(eq(N,6),171000,if(eq(N,7),207001,if(eq(N,8),234000,if(eq(N,9),252000,if(eq(N,10),270000,288000)))))))))))'
ffmpeg -nostdin -loglevel +level+info -nostats \
  -f lavfi -i "testsrc2=size=320x180:rate=10:duration=1.2,settb=1/90000,setpts='$PTS'" \
  -an -vf "$TAPS_NAMED" -f rawvideo - > slot-edges-32x18.gray 2> slot-edges-32x18.err

# --- log level spellings ------------------------------------------------------------------------------
# A synthetic H.264 stream (4 slices/frame) with its SPS/PPS stripped: every slice fails with the same
# ERROR, "non-existing PPS 0 referenced" (what a reader that joins without parameter sets sees). Run
# three ways: today's `-loglevel error`, the absolute `level+info`, and the relative `+level+info`.
ffmpeg -nostdin -loglevel error -f lavfi -i testsrc2=size=160x90:rate=10:duration=1 \
  -c:v libx264 -x264-params slices=4 -g 5 -bsf:v h264_mp4toannexb -f h264 -y /tmp/ok4.h264
ffmpeg -nostdin -loglevel error -i /tmp/ok4.h264 -c copy -bsf:v 'filter_units=remove_types=7|8' -f h264 -y /tmp/nops4.h264
ffmpeg -nostdin -loglevel error -i /tmp/nops4.h264 -an -vf "$OLDVF" -f rawvideo - > /dev/null 2> loglevel-error.err
ffmpeg -nostdin -loglevel level+info -nostats -i /tmp/nops4.h264 -an -vf "$TAPS_NAMED" -f rawvideo - > /dev/null 2> loglevel-abs.err
ffmpeg -nostdin -loglevel +level+info -nostats -i /tmp/nops4.h264 -an -vf "$TAPS_NAMED" -f rawvideo - > /dev/null 2> loglevel-rel.err

# Interleaving, deterministic: volume=NaN warns once per audio frame. Without a tap the repeats collapse
# ("Last message repeated 8 times"); with an ashowinfo record printed between repeats they cannot.
ffmpeg -nostdin -loglevel warning -f lavfi -i sine=frequency=440:sample_rate=8000:duration=1 \
  -af "volume=volume='0/0':eval=frame" -f s16le -y /dev/null 2> interleave-warning.err
ffmpeg -nostdin -loglevel +level+info -nostats -f lavfi -i sine=frequency=440:sample_rate=8000:duration=1 \
  -af "volume=volume='0/0':eval=frame,ashowinfo" -f s16le -y /dev/null 2> interleave-rel.err

# Interleaving at ERROR level, NOT deterministic (thread scheduling): the broken stream decoded at -re
# while a second, working input prints tap records in the same process.
ffmpeg -nostdin -loglevel error -probesize 32 -analyzeduration 0 -re -c:v h264 -i /tmp/nops4.h264 \
  -re -f lavfi -i testsrc2=size=160x90:rate=10:duration=1 \
  -map 0:v -f null -y /dev/null -map 1:v -vf "$OLDVF" -f rawvideo -y /dev/null 2> interleave-mix-error.err
ffmpeg -nostdin -loglevel +level+info -nostats -probesize 32 -analyzeduration 0 -re -c:v h264 -i /tmp/nops4.h264 \
  -re -f lavfi -i testsrc2=size=160x90:rate=10:duration=1 \
  -map 0:v -f null -y /dev/null -map 1:v -vf "$TAPS_NAMED" -f rawvideo -y /dev/null 2> interleave-mix-rel.err

# --- error-line format --------------------------------------------------------------------------------
# An RTSP/network-context error (connection refused on a closed local port) under both flags.
ffmpeg -nostdin -loglevel error -rtsp_transport tcp -i rtsp://127.0.0.1:1/nope -an -vf "$OLDVF" \
  -f rawvideo - > /dev/null 2> rtsp-refused-error.err
ffmpeg -nostdin -loglevel +level+info -nostats -rtsp_transport tcp -i rtsp://127.0.0.1:1/nope -an -vf "$TAPS_NAMED" \
  -f rawvideo - > /dev/null 2> rtsp-refused-rel.err
# fftools' double-prefixed lines ([vist#0:0/mjpeg @ ..] [dec:mjpeg @ ..]) and a multi-line WARNING whose
# second line carries no prefix and no level token: a wrong decoder forced on an H.264 file.
ffmpeg -nostdin -loglevel error -c:v mjpeg -i /tmp/ok4.h264 -an -vf "$OLDVF" -f rawvideo - > /dev/null 2> mjpeg-error.err
ffmpeg -nostdin -loglevel +level+info -nostats -c:v mjpeg -i /tmp/ok4.h264 -an -vf "$TAPS_NAMED" -f rawvideo - > /dev/null 2> mjpeg-rel.err
rm -f /tmp/ok4.h264 /tmp/nops4.h264

# --- ashowinfo ------------------------------------------------------------------------------------------
# 0.5 s each: G711 a-law 8 kHz in 320-sample packets (the ~25 records/s Stage 1 measured on cameras),
# and AAC at 16 and 48 kHz (no AAC camera exists here, so sine + noise encoded to AAC).
ffmpeg -nostdin -loglevel error -f lavfi -i "sine=frequency=440:sample_rate=8000:samples_per_frame=320:duration=0.5" \
  -f lavfi -i "anoisesrc=r=8000:a=0.05:d=0.5:n=320" -filter_complex amix=inputs=2:normalize=0 \
  -c:a pcm_alaw -f matroska -y /tmp/alaw8k.mkv
for r in 16000 48000; do
  ffmpeg -nostdin -loglevel error -f lavfi -i "sine=frequency=440:sample_rate=$r:duration=0.5" \
    -f lavfi -i "anoisesrc=r=$r:a=0.05:d=0.5" -filter_complex amix=inputs=2:normalize=0 \
    -c:a aac -b:a 64k -f matroska -y /tmp/aac$r.mkv
done
for s in alaw8k aac16000 aac48000; do
  ffmpeg -nostdin -loglevel +level+info -nostats -i /tmp/$s.mkv -vn -af ashowinfo -ac 1 -ar 8000 -f s16le - \
    > sound-$s.pcm 2> sound-$s.err
  rm -f /tmp/$s.mkv
done
ls -la /out
