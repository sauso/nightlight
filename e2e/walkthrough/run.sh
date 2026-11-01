#!/bin/sh
# Refresh the documentation walkthrough screenshots (docs/screenshots/). See e2e/README.md.
#
#   sh e2e/walkthrough/run.sh [image]        # default image: sauso/nightlight:dev
#
# Starts two throwaway containers from the real image (one seeded with the fictional demo household, one empty
# for the first-run screen), runs capture.mjs against them, then removes them. Needs Docker, and the Playwright
# install in e2e/playwright (npm ci there first). Touches no real data.
set -eu

IMAGE=${1:-sauso/nightlight:dev}
# Docker bind mounts need native paths: on Git Bash for Windows `pwd -W` gives C:/..., elsewhere plain `pwd`.
export MSYS_NO_PATHCONV=1
abs() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
HERE=$(abs "$(dirname "$0")")
OUT=$(abs "$HERE/../..")/docs/screenshots
WORK=$(abs "$(mktemp -d)")
SEEDED=nl-walkthrough-seeded
EMPTY=nl-walkthrough-empty

cleanup() {
  docker rm -f "$SEEDED" "$EMPTY" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# A synthetic 12 s clip (and its poster) stands in for camera footage; see make-loop.sh.
docker run --rm -v "$WORK:/out" -v "$HERE:/w:ro" --entrypoint sh "$IMAGE" /w/make-loop.sh /out/loop.mp4
cp "$HERE/fakecam.yml" "$HERE/prepare.mjs" "$HERE/start.sh" "$WORK/"

start() { # name host-port extra-env
  docker run -d --name "$1" -p "$2:4000" -e PUID=0 -e PGID=0 -e TZ=UTC $3 \
    --tmpfs /app/data -v "$WORK:/app/demo:ro" "$IMAGE" sh /app/demo/start.sh >/dev/null
}
start "$SEEDED" 4101 ""
start "$EMPTY" 4102 "-e WALKTHROUGH_EMPTY=1"

# Wait until both camera paths are publishing (the seeded app) and the empty app answers.
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4102/api/health || true)" = "200" ] \
   && docker exec "$SEEDED" node -e "fetch('http://127.0.0.1:9997/v3/paths/list').then(r=>r.json()).then(j=>{const p=new Map((j.items||[]).map(x=>[x.name,x.ready]));process.exit(p.get('demo-avery')&&p.get('demo-riley')?0:1)}).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || { echo "walkthrough stack did not become ready" >&2; docker logs "$SEEDED" | tail -20; exit 1; }
  sleep 1
done

mkdir -p "$OUT"
cd "$HERE/../playwright"
WALK_SEEDED=http://127.0.0.1:4101 WALK_EMPTY=http://127.0.0.1:4102 WALK_OUT="$OUT" node ../walkthrough/capture.mjs
