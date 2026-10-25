#!/usr/bin/env bash
# The move of the database and secrets into DATA_DIR/private/ (#553 phase 2a), proven against the real images.
#
# An install made by the LAST RELEASE (NIGHTLIGHT_OLD_IMAGE, default sauso/nightlight:0.43.0) is upgraded to the image
# built from this commit, exactly as a user's would be:
#   upgrade  the old image makes a real install (first-run admin, a session); then, as the app leaves it after a stop,
#            the database has a NON-EMPTY -wal (a marker account is added by a process killed before it could close, so
#            that row is ONLY in the -wal); plus a .jwt_secret, a Firebase file copied in as ROOT (the start-up must
#            re-own it before the app user can move it), alert and bed pictures, and a backup made with the OLD
#            documented command (root-owned, at the top level). Then the new image starts with the documented
#            six-capability hardening and must: move everything into private/ (700, files 600, owned PUID:PGID), keep
#            the .jwt_secret byte for byte (the old session still works), keep the marker row, say so in one
#            `[entrypoint] private layout:` line with no warning, and leave nothing to move behind it. The console
#            scripts and the new backup command work against the moved database. A second, NEW container on the same
#            data directory is a no-op. Then the documented ROLLBACK statement is shown true: the old image on the
#            moved data directory starts EMPTY (first-run setup). And starting the new image again after that is the
#            "two copies" case: the private/ copy wins, the old image's empty one is set aside, About says so, and the
#            old session still works.
#   puid0    the same upgrade with PUID=0 (as the e2e and demo stacks run): moved, signs in.
#   empty    `docker exec` on a volume that never started (root, no start-up script) creates nothing, private/ least
#            of all: a root-owned private/ would lock the app out of its own folder.
#
#   bash e2e/private-layout.sh            # all three
#   bash e2e/private-layout.sh upgrade    # or puid0, empty: one part only
#   bash e2e/private-layout.sh teardown   # remove whatever a killed run left behind
#
# The helpers are hardened.sh's, SOURCED, with this script's own project name and host port (4300), so it never meets
# the Playwright stack (4000), hardened.sh (4100) or media-isolation.sh (4200). Needs a Linux Docker host and network
# access to pull the old image. CI: the `private-layout` job in .github/workflows/e2e.yml, on an image built from the
# checked-out commit.
set -euo pipefail

export HARDENED_PROJECT=${PRIVATE_LAYOUT_PROJECT:-nightlight-private-layout}
export E2E_HARDENED_PORT=${E2E_PRIVATE_LAYOUT_PORT:-4300}
# shellcheck source=hardened.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hardened.sh"

# The last release, which writes the old layout. A release tag, never rebuilt (docs/operations.md, "The weekly rebuild").
OLD_IMAGE=${NIGHTLIGHT_OLD_IMAGE:-sauso/nightlight:0.43.0}
ADMIN_USER=e2e
ADMIN_PW=e2e-admin-pw
MARKER_USER=walmarker
LAYOUT_OK='[entrypoint] private layout: the database and secrets are in /app/data/private'
LAYOUT_WARN='[entrypoint] warning: private layout:'
SET_ASIDE_WARN='was set aside in /app/data/private/legacy-'

# ── Containers ───────────────────────────────────────────────────────────────────────────────────────
# The app, from the old or the new image. kind: six (the documented hardening) or default.
start_layout_app() { # name volume image six|default puid
  local name=$1 vol=$2 image=$3 kind=$4 puid=$5 cap
  local -a flags=()
  if [ "$kind" = six ]; then
    flags=(--cap-drop=ALL)
    while read -r cap; do flags+=("--cap-add=$cap"); done < <(caps_without "")
    flags+=("--security-opt=$NO_NEW_PRIVS")
  fi
  docker run -d --name "$name" --label "$LABEL" --label "$ROLE_APP" \
    --network "$NET" -p "127.0.0.1:$PORT:4000" \
    -e TZ=UTC -e "PUID=$puid" -e "PGID=$APP_PGID" \
    --stop-timeout 30 \
    -v "$vol:/app/data" \
    "${flags[@]}" \
    "$image" >/dev/null
}

# A throwaway container on the volume, with no start-up script: `as` is a uid:gid, or root.
on_volume() { # volume image as command...
  local vol=$1 image=$2 as=$3
  shift 3
  local -a user=()
  [ "$as" = root ] || user=(--user "$as")
  docker run --rm --network none --label "$LABEL" "${user[@]}" --entrypoint "$1" -v "$vol:/app/data" "$image" "${@:2}"
}

fresh_volume() {
  docker volume rm -f "$1" >/dev/null 2>&1 || true
  docker volume create --label "$LABEL" "$1" >/dev/null
}

# ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────
setup_admin() { # -> token
  local out
  out=$(curl -fsS -m 15 -X POST "$BASE/api/auth/setup" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\",\"first_name\":\"E2E\"}") || die "first-run setup failed"
  printf '%s' "$out" | field token
}

login() { # -> token
  local out
  out=$(curl -fsS -m 15 -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\"}") || die "sign-in with the old password failed"
  printf '%s' "$out" | field token
}

about() { curl -fsS -m 15 "$BASE/api/about" -H "Authorization: Bearer $1"; }

# The old session still works, and About reports the layout and the conflict flag as expected.
check_about() { # token layout conflict(true|false) what
  local body
  body=$(about "$1") || die "$4: GET /api/about refused the session made before the upgrade (signed out?)"
  printf '%s' "$body" | grep -qF "\"dataLayout\":\"$2\"" || die "$4: About does not say dataLayout $2: $body"
  printf '%s' "$body" | grep -qF "\"layoutConflict\":$3" || die "$4: About does not say layoutConflict $3: $body"
  ok "$4: the session from before the upgrade still works; About says dataLayout $2, layoutConflict $3"
}

# ── The old install ──────────────────────────────────────────────────────────────────────────────────
# Leaves OLD_TOKEN (a session of the old install) and SECRET_SUM (the .jwt_secret's sha256).
OLD_TOKEN=
SECRET_SUM=
make_old_install() { # volume puid
  local vol=$1 puid=$2 c="$PROJECT-old" log wal
  fresh_volume "$vol"
  start_layout_app "$c" "$vol" "$OLD_IMAGE" default "$puid"
  ready_or_die "$c" "old image ($OLD_IMAGE), first start"
  OLD_TOKEN=$(setup_admin)
  [ -n "$OLD_TOKEN" ] || die "no token from the old image's first-run setup"
  ok "old image: first-run admin '$ADMIN_USER' created, session kept for later"
  stop_app "$c"
  log=$(save_log "$c")
  [ "$EXIT_CODE" = 0 ] || die_log "$log" "old image: did not stop cleanly"
  docker rm "$c" >/dev/null
  local as="$puid:$APP_PGID"
  [ "$puid" != 0 ] || as=root
  # A row ONLY in the -wal: written by a process that is killed before it can close the database (the app itself never
  # closes it either, docs/operations.md, "Backing up").
  on_volume "$vol" "$OLD_IMAGE" "$as" node -e "
    const Database = require('/app/node_modules/better-sqlite3');
    const db = new Database('/app/data/babymonitor.db');
    db.pragma('wal_autocheckpoint = 0');
    db.prepare(\"INSERT INTO users (id, username, password_hash, role) VALUES ('u-walmarker', '$MARKER_USER', '!', 'caregiver')\").run();
    process.kill(process.pid, 'SIGKILL');" || true
  wal=$(on_volume "$vol" "$OLD_IMAGE" root stat -c %s /app/data/babymonitor.db-wal) || die "the old install has no -wal"
  [ "$wal" -gt 0 ] || die "the old install's -wal is empty, so 'the rows survive' would prove nothing"
  ok "old install: babymonitor.db-wal is $wal bytes and holds a row ($MARKER_USER) the .db file does not"
  # A Firebase file copied in by hand AS ROOT, world-readable: the start-up must re-own it before the move.
  on_volume "$vol" "$OLD_IMAGE" root sh -c 'umask 022 && printf "{}" > /app/data/google-services.json'
  # Pictures in both snapshot folders (made by the old app at its start).
  on_volume "$vol" "$OLD_IMAGE" "$as" sh -c 'printf jpg > /app/data/detection-snapshots/1.jpg && printf jpg > /app/data/transition-snapshots/1.jpg'
  # A backup made with the OLD documented command, as `docker exec` runs it: root, at the top level.
  on_volume "$vol" "$OLD_IMAGE" root node -e "
    process.umask(0o077);
    const Database = require('/app/node_modules/better-sqlite3');
    const db = new Database('/app/data/babymonitor.db', { readonly: true });
    db.backup('/app/data/backup-20260101-000000.db').then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });" \
    || die "the old documented backup command failed on the old install"
  SECRET_SUM=$(on_volume "$vol" "$OLD_IMAGE" root sha256sum /app/data/.jwt_secret | cut -d' ' -f1)
  [ -n "$SECRET_SUM" ] || die "the old install has no .jwt_secret"
  info "old install, top level: $(on_volume "$vol" "$OLD_IMAGE" root ls -A /app/data | tr '\n' ' ')"
}

# ── Checks on the moved volume ───────────────────────────────────────────────────────────────────────
# Nothing that belongs in private/ is left at the top level.
check_top_level_clean() { # volume what
  local left
  left=$(on_volume "$1" "$IMAGE" root sh -c 'cd /app/data && ls -A | grep -E "^(babymonitor\.db.*|\.jwt_secret|firebase-service-account\.json|google-services\.json|detection-snapshots|transition-snapshots|backup-.*\.db)$" || true')
  [ -z "$left" ] || die "$2: still at the top of the data directory: $(printf '%s' "$left" | tr '\n' ' ')"
  ok "$2: nothing that belongs in private/ is left at the top level ($(on_volume "$1" "$IMAGE" root ls -A /app/data | tr '\n' ' '))"
}

# Mode and owner of each moved item, as `stat` prints them: "<mode> <uid>:<gid>".
check_private_modes() { # volume puid what
  local vol=$1 owner="$2:$APP_PGID" what=$3 spec item mode got want
  for spec in "private 700" "private/babymonitor.db -" "private/.jwt_secret 600" "private/google-services.json 600" \
    "private/backup-20260101-000000.db 600" "private/detection-snapshots/1.jpg -" "private/transition-snapshots/1.jpg -"; do
    item=${spec% *}
    mode=${spec##* }
    got=$(on_volume "$vol" "$IMAGE" root stat -c '%a %u:%g' "/app/data/$item" 2>&1) || die "$what: $item is missing: $got"
    if [ "$mode" = - ]; then want="${got%% *} $owner"; else want="$mode $owner"; fi
    [ "$got" = "$want" ] || die "$what: $item is '$got', expected '$want'"
  done
  ok "$what: private/ is 700 and the secrets in it 600, everything owned by $owner (the root-owned Firebase file and backup were re-owned)"
}

check_secret_kept() { # volume what
  local now
  now=$(on_volume "$1" "$IMAGE" root sha256sum /app/data/private/.jwt_secret | cut -d' ' -f1)
  [ "$now" = "$SECRET_SUM" ] || die "$2: the .jwt_secret changed in the move (everyone would be signed out)"
  ok "$2: the .jwt_secret is byte for byte the old one"
}

check_marker_row() { # container what
  local out
  out=$(docker exec "$1" node src/scripts/promote-admin.js 2>&1) || die "$2: promote-admin.js failed: $out"
  case "$out" in *"- $MARKER_USER (caregiver)"*) ok "$2: the row that was only in the -wal survived the move (promote-admin.js lists it)" ;;
    *) die "$2: the marker account is gone, or the script read another database: $out" ;; esac
}

check_console_scripts() { # container what
  local out
  out=$(docker exec "$1" node src/scripts/reset-mfa.js --list 2>&1) || die "$2: reset-mfa.js --list failed: $out"
  case "$out" in *"$MFA_LIST_OK"*) ;; *) die "$2: reset-mfa.js --list printed: $out" ;; esac
  out=$(docker exec "$1" node src/scripts/backup-db.js 2>&1) || die "$2: backup-db.js failed: $out"
  case "$out" in *"Backup written to /app/data/private/backup-"*) ;; *) die "$2: backup-db.js printed: $out" ;; esac
  ok "$2: reset-mfa.js and backup-db.js work on the moved database ($out)"
}

# ── The parts ────────────────────────────────────────────────────────────────────────────────────────
phase_upgrade() {
  local vol="$PROJECT-upgrade-data" c1="$PROJECT-new-1" c2="$PROJECT-new-2" c3="$PROJECT-rollback" c4="$PROJECT-new-3" log status
  say "UPGRADE: $OLD_IMAGE install -> this image (six capabilities), twice; then the rollback, then two copies"
  cleanup_apps
  make_old_install "$vol" "$APP_PUID"

  start_layout_app "$c1" "$vol" "$IMAGE" six "$APP_PUID"
  ready_or_die "$c1" "new image, first start (the move)"
  check_about "$OLD_TOKEN" private false "first start"
  [ -n "$(login)" ] || die "first start: no token from signing in"
  ok "first start: signing in with the old password works"
  check_marker_row "$c1" "first start"
  check_console_scripts "$c1" "first start"
  stop_app "$c1"
  log=$(save_log "$c1")
  show_startup "$log"
  check_clean_stop "$c1" "$log" "first start"
  grep -qF "$LAYOUT_OK" "$log" || die_log "$log" "first start: no '$LAYOUT_OK' line"
  if grep -qF "$LAYOUT_WARN" "$log"; then die_log "$log" "first start: a private layout warning"; fi
  grep -qF '[private-layout] moved babymonitor.db into private/' "$log" || die_log "$log" "first start: the move did not say it moved the database"
  grep -qF '[private-layout] quick_check of the moved database: ok' "$log" || die_log "$log" "first start: no quick_check ok line"
  grep -qE '\[entrypoint\] .*google-services\.json is owned by 0:0, not 99:100; re-owning it' "$log" \
    || die_log "$log" "first start: the root-owned Firebase file was not re-owned before the move"
  ok "first start: one '[entrypoint] private layout:' line, no warning; the moves and the re-own were logged"
  docker rm "$c1" >/dev/null
  check_top_level_clean "$vol" "after the first start"
  check_private_modes "$vol" "$APP_PUID" "after the first start"
  check_secret_kept "$vol" "after the first start"

  # A NEW container on the same data directory (an update, Unraid's Apply): nothing left to do.
  start_layout_app "$c2" "$vol" "$IMAGE" six "$APP_PUID"
  ready_or_die "$c2" "new image, second start"
  check_about "$OLD_TOKEN" private false "second start"
  stop_app "$c2"
  log=$(save_log "$c2")
  check_clean_stop "$c2" "$log" "second start"
  grep -qF "$LAYOUT_OK" "$log" || die_log "$log" "second start: no '$LAYOUT_OK' line"
  if grep -qE '\[private-layout\] (moved|.* was set aside)' "$log"; then die_log "$log" "second start: the move did something again"; fi
  if grep -qF "$LAYOUT_WARN" "$log"; then die_log "$log" "second start: a private layout warning"; fi
  grep -qF "$ALREADY_OWNED_LINE" "$log" || die_log "$log" "second start: no '$ALREADY_OWNED_LINE' line"
  ok "second start: a no-op (nothing moved, nothing set aside, no warning)"
  docker rm "$c2" >/dev/null

  # ROLLBACK, as docs/operations.md states it: an older image finds no database at the top level and starts EMPTY.
  start_layout_app "$c3" "$vol" "$OLD_IMAGE" default "$APP_PUID"
  ready_or_die "$c3" "old image on the moved data directory (the rollback)"
  status=$(curl -fsS -m 15 "$BASE/api/auth/status") || die "rollback: GET /api/auth/status failed"
  case "$status" in *'"needsSetup":true'*) ok "rollback: the old image starts EMPTY, asking for first-run setup ($status)" ;;
    *) die "rollback: the old image did NOT start empty, so the documented rollback statement is wrong: $status" ;; esac
  stop_app "$c3"
  docker rm "$c3" >/dev/null

  # Back to the new image: the old image's EMPTY top-level database and secret are the "two copies" case.
  start_layout_app "$c4" "$vol" "$IMAGE" six "$APP_PUID"
  ready_or_die "$c4" "new image after the rollback"
  check_about "$OLD_TOKEN" private true "after the rollback"
  stop_app "$c4"
  log=$(save_log "$c4")
  show_startup "$log"
  check_clean_stop "$c4" "$log" "after the rollback"
  grep -F "$LAYOUT_WARN" "$log" | grep -qF "$SET_ASIDE_WARN" \
    || die_log "$log" "after the rollback: no warning that a copy was set aside"
  ok "after the rollback: private/ won, the old image's empty copy was set aside, with ONE warning saying so"
  docker rm "$c4" >/dev/null
  on_volume "$vol" "$IMAGE" root sh -c 'ls /app/data/private/legacy-*/babymonitor.db >/dev/null' \
    || die "after the rollback: the set-aside database is not in private/legacy-*/"
  check_top_level_clean "$vol" "after the rollback"
  say "UPGRADE PASSED"
}

phase_puid0() {
  local vol="$PROJECT-puid0-data" c="$PROJECT-puid0" log
  say "PUID0: the same upgrade with PUID=0"
  cleanup_apps
  make_old_install "$vol" 0
  start_layout_app "$c" "$vol" "$IMAGE" default 0
  ready_or_die "$c" "new image, PUID=0"
  check_about "$OLD_TOKEN" private false "PUID=0"
  [ -n "$(login)" ] || die "PUID=0: no token from signing in"
  check_marker_row "$c" "PUID=0"
  stop_app "$c"
  log=$(save_log "$c")
  grep -qF "$LAYOUT_OK" "$log" || die_log "$log" "PUID=0: no '$LAYOUT_OK' line"
  docker rm "$c" >/dev/null
  check_top_level_clean "$vol" "PUID=0"
  say "PUID0 PASSED"
}

phase_empty() {
  local vol="$PROJECT-empty-data" out rc=0 left
  say "EMPTY: docker exec (root, no start-up script) on a volume that never started creates nothing"
  fresh_volume "$vol"
  for script in "reset-mfa.js --list" "promote-admin.js" "backup-db.js"; do
    # shellcheck disable=SC2086
    out=$(on_volume "$vol" "$IMAGE" root node src/scripts/$script 2>&1) || rc=$?
    [ "$rc" != 0 ] || die "$script succeeded on an empty volume: $out"
    rc=0
  done
  left=$(on_volume "$vol" "$IMAGE" root ls -A /app/data)
  [ -z "$left" ] || die "a console script left something on an empty volume: $left"
  ok "the three console scripts fail cleanly on an empty volume and leave it empty (no root-owned private/)"
  say "EMPTY PASSED"
}

# ── Main ─────────────────────────────────────────────────────────────────────────────────────────────
MODE=${1:-all}
MODE=${MODE,,}
case "$MODE" in
  teardown) teardown; exit 0 ;;
  all) PHASES=(upgrade puid0 empty) ;;
  upgrade | puid0 | empty) PHASES=("$MODE") ;;
  *) printf 'usage: bash e2e/private-layout.sh [all|upgrade|puid0|empty|teardown]   (default: all)\n' >&2; exit 2 ;;
esac

command -v docker >/dev/null || die "docker is not on PATH"
command -v curl >/dev/null || die "curl is not on PATH"
docker info >/dev/null 2>&1 || die "no Docker daemon answers"

if [ -n "${PRIVATE_LAYOUT_LOG_DIR:-}" ]; then
  LOG_DIR=$PRIVATE_LAYOUT_LOG_DIR
  mkdir -p "$LOG_DIR"
else
  LOG_DIR=$(mktemp -d)
fi

trap teardown EXIT
teardown

say "Setting up"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null
ok "new image $IMAGE ($(docker image inspect -f '{{.Id}}' "$IMAGE"))"
docker image inspect "$OLD_IMAGE" >/dev/null 2>&1 || docker pull "$OLD_IMAGE" >/dev/null
ok "old image $OLD_IMAGE ($(docker image inspect -f '{{.Id}}' "$OLD_IMAGE"))"
docker network create --label "$LABEL" "$NET" >/dev/null
ok "network $NET, host port $PORT, container logs in $LOG_DIR"

RESULTS=()
FAILED=0
for phase in "${PHASES[@]}"; do
  set +e
  (
    set -e
    "phase_$phase"
  )
  rc=$?
  set -e
  if [ "$rc" = 0 ]; then RESULTS+=("  OK    $phase"); else RESULTS+=("  FAIL  $phase"); FAILED=1; fi
done

say "Summary"
printf '%s\n' "${RESULTS[@]}"
if [ "$FAILED" = 0 ]; then
  say "PRIVATE LAYOUT CHECKS PASSED"
else
  say "PRIVATE LAYOUT CHECKS FAILED"
  exit 1
fi
