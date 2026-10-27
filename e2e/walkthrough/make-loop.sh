#!/bin/sh
# Makes the synthetic "camera footage" for the walkthrough: a 12 s clip and its poster frame. Runs inside the
# Nightlight image (it has ffmpeg). The picture is deliberately plain: the image ships no fonts, so there is no
# caption on the video, and the docs say in words that the video is synthetic.
# H.264 baseline + yuv420p so a phone's hardware decoder can play it; AAC because MP4 cannot hold G.711
# (fakecam.yml converts to pcm_mulaw when it publishes the stream).
set -eu

out=${1:-/out/loop.mp4}
poster=${out%.*}.jpg

# A dim room with a pale mattress and a pillow, so a tile reads as "a bed seen from above" and not as an error.
video='color=c=0x17202a:s=1280x720:r=15,drawbox=x=300:y=110:w=680:h=500:color=0x3b4a63:t=fill,drawbox=x=330:y=140:w=620:h=440:color=0x8aa0c0:t=fill,drawbox=x=420:y=160:w=440:h=110:color=0xdfe6f0:t=fill'

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "$video" \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 12 -shortest \
  -c:v libx264 -profile:v baseline -level:v 3.1 -pix_fmt yuv420p -preset veryfast \
  -r 15 -g 15 -keyint_min 15 -sc_threshold 0 \
  -c:a aac -b:a 64k -ar 48000 -ac 1 -movflags +faststart "$out"
ffmpeg -hide_banner -loglevel error -y -i "$out" -frames:v 1 "$poster"
