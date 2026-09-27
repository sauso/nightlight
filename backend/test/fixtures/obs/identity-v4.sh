#!/bin/sh
# Stdout byte identity for issue #373 Stage 2, plan v4 (LEAN taps), plan §Tests 6b. NOT run by the test
# suite (it needs ffmpeg and a few hundred MB of scratch); it is committed so the claim can be re-checked.
#
# ★ THE CLAIM: the new detector args (the showinfo/ashowinfo taps, `-loglevel +level+info`, `-nostats`)
# change what ffmpeg PRINTS, never the bytes it WRITES to stdout. If that holds, every detection decision
# sees exactly the bytes it saw before, which is what "no stored number moves, so no A/B" rests on.
#
# Usage (Git Bash; drop MSYS_NO_PATHCONV elsewhere). SCRATCH is any empty directory OUTSIDE the repo; it
# receives the generated synthetic inputs. Extra positional args are real recordings, mounted read-only:
#   MSYS_NO_PATHCONV=1 docker run --rm --network none -v "$(pwd -W)/backend/test/fixtures/obs:/fx:ro" \
#     -v "<SCRATCH>:/w" -v "<DIR WITH RECORDINGS>:/rec:ro" --entrypoint sh sauso/nightlight:dev \
#     /fx/identity-v4.sh /rec/a.mkv /rec/b.mkv
# ⚠️ Real camera recordings are never written anywhere by this script: stdout goes straight into
# sha256sum, and only hashes and line counts are printed. Do not commit a recording, ever.
#
# `-rtsp_transport tcp` is dropped from BOTH sides: it is an RTSP demuxer option, and ffmpeg refuses an
# unconsumed input option on a file ("Option not found"). It does not touch decoding or filtering.
set -u
mkdir -p /w/files
cd /w/files
# Synthetic inputs (lavfi only). The same shapes Step 0 used: a fakecam-like stream (the soak fakecam's
# generator), 1080p15 and 4K30 camera-like H.264 with temporal noise, and AAC at 16 and 48 kHz (no AAC
# camera exists in this house, so sine + noise encoded to AAC).
[ -f fake640.mkv ] || ffmpeg -nostdin -loglevel error -f lavfi -i testsrc=size=640x480:rate=15 \
  -f lavfi -i sine=frequency=500:sample_rate=8000 -t 120 -c:v libx264 -profile:v baseline -pix_fmt yuv420p \
  -preset ultrafast -tune zerolatency -g 30 -c:a pcm_mulaw -ar 8000 -ac 1 -f matroska -y fake640.mkv
[ -f v1080p15.mkv ] || ffmpeg -nostdin -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=15,noise=alls=12:allf=t" \
  -t 45 -c:v libx264 -preset veryfast -bf 0 -g 30 -b:v 3M -maxrate 3M -bufsize 6M -pix_fmt yuv420p \
  -f matroska -y v1080p15.mkv
[ -f v4k30.mkv ] || ffmpeg -nostdin -loglevel error -f lavfi -i "testsrc2=size=3840x2160:rate=30,noise=alls=12:allf=t" \
  -t 30 -c:v libx264 -preset veryfast -bf 0 -g 60 -b:v 8M -maxrate 8M -bufsize 16M -pix_fmt yuv420p \
  -f matroska -y v4k30.mkv
for r in 16000 48000; do
  [ -f aac$r.mkv ] || ffmpeg -nostdin -loglevel error -f lavfi -i "sine=frequency=440:sample_rate=$r:duration=60" \
    -f lavfi -i "anoisesrc=r=$r:a=0.05:d=60" -filter_complex amix=inputs=2:normalize=0 \
    -c:a aac -b:a 64k -f matroska -y aac$r.mkv
done

# The OLD args are exactly dev b379737's motionDetector.js / soundDetector.js; the NEW ones are what
# ffmpegSideChannel.js builds (buildMotionTaps / buildSoundTaps / SIDE_CHANNEL_LOG_ARGS).
MOLD="fps=5,scale=320:180,format=gray"
MNEW="showinfo@in=checksum=0,fps=5,scale=320:180,format=gray,showinfo@out"

for f in "$@" /w/files/fake640.mkv /w/files/v1080p15.mkv /w/files/v4k30.mkv /w/files/aac16000.mkv /w/files/aac48000.mkv; do
  echo "input $(sha256sum "$f" | cut -c1-64) bytes=$(wc -c < "$f") $(basename "$f")"
done

motion() { # $1 file
  o=$( { ffmpeg -nostdin -loglevel error -i "$1" -an -vf $MOLD -f rawvideo - | sha256sum; } 2>/dev/null | cut -c1-64)
  n=$( { ffmpeg -nostdin -loglevel +level+info -nostats -i "$1" -an -vf $MNEW -f rawvideo - | sha256sum > /tmp/sha; } 2>/tmp/err; cut -c1-64 /tmp/sha)
  bytes=$( { ffmpeg -nostdin -loglevel error -i "$1" -an -vf $MOLD -f rawvideo - | wc -c; } 2>/dev/null)
  frames=$((bytes / 57600))
  lines=$(grep -c '' /tmp/err); inrec=$(grep -c 'showinfo@in @.*\] n: *[0-9]' /tmp/err); outrec=$(grep -c 'showinfo@out @.*\] n: *[0-9]' /tmp/err)
  same=NO; [ "$o" = "$n" ] && same=yes
  # Output seconds = frames / 5 (fps=5): the stderr line rate the detector's Node side has to classify.
  echo "motion $(basename "$1") old=$o new=$n identical=$same frames=$frames stderrLines=$lines inRecords=$inrec outRecords=$outrec linesPerSec=$(awk "BEGIN { printf \"%.1f\", $lines / ($frames / 5) }")"
}
sound() { # $1 file
  o=$( { ffmpeg -nostdin -loglevel error -i "$1" -vn -ac 1 -ar 8000 -f s16le - | sha256sum; } 2>/dev/null | cut -c1-64)
  n=$( { ffmpeg -nostdin -loglevel +level+info -nostats -i "$1" -vn -af ashowinfo -ac 1 -ar 8000 -f s16le - | sha256sum > /tmp/sha; } 2>/tmp/err; cut -c1-64 /tmp/sha)
  bytes=$( { ffmpeg -nostdin -loglevel error -i "$1" -vn -ac 1 -ar 8000 -f s16le - | wc -c; } 2>/dev/null)
  lines=$(grep -c '' /tmp/err); recs=$(grep -c 'ashowinfo.*\] n:[0-9]' /tmp/err)
  same=NO; [ "$o" = "$n" ] && same=yes
  echo "sound $(basename "$1") old=$o new=$n identical=$same stdoutBytes=$bytes stderrLines=$lines records=$recs linesPerSec=$(awk "BEGIN { printf \"%.1f\", $lines / ($bytes / 16000) }")"
}
for f in "$@" /w/files/fake640.mkv /w/files/v1080p15.mkv /w/files/v4k30.mkv; do motion "$f"; done
for f in "$@" /w/files/fake640.mkv /w/files/aac16000.mkv /w/files/aac48000.mkv; do sound "$f"; done
rm -f /tmp/sha /tmp/err
echo done
