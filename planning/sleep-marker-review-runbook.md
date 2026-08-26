# Runbook: reviewing a night's sleep markers (staging)

How to pull a night's OOB / into-bed markers, `bed_transitions`, and the shadow
onset/wake numbers off **staging** without the trial-and-error. Read-only; safe.

> Prod DB is **read-only from here** and is a *different database* with different
> camera IDs — see "Identifiers". Don't cross prod and staging IDs.

## 1. Identifiers (staging `nightlight-dev`)

`sleep_nights` is keyed by **`child_id`**, `bed_transitions` by **`camera_id`** — they
are different values for the same kid. Look them up fresh if unsure:
`SELECT id,name,child_id FROM cameras`.

| Camera (staging) | camera_id | child_id |
|---|---|---|
| Renz Cam | `501ca6c2-5688-4381-940d-edfa0d1e721d` | `884974cd-b11c-4393-9608-dde3099779f0` |
| Raffa Room | `96f35fdc-f12f-4a6b-9c82-887be7e95108` | `c75ed329-de89-42ca-83aa-edaf692295b6` |
| Test Cam | `902098f5-4982-4844-8cf8-575387b326da` | *(none — no child assigned)* |
| Test | `01248e86-7715-44dc-984f-40fa838ea8ae` | *(none — no child assigned)* |

Verified against the staging DB 2026-08-24.

> ⚠️ **"Test Cam" and "Test" are two different cameras.** *Test Cam* is the Sonoff; *Test* is a
> Hikvision with **no child assigned**, so it produces no `sleep_nights` rows at all — an empty
> result for it is correct, not a bug.

Prod ("Renz Room") is `cam_a6f9b0a4` in a separate DB — **not** valid on staging. If a
staging query returns empty, first suspect a prod ID pasted by mistake.

## 2. Schema gotchas (actual column names)

- **`sleep_nights`**: `child_id`, `night_date`, `window_start`, `window_end`, `status`,
  `onset_at`, `wake_at`, `onset_at_shadow`, `wake_at_shadow`, `wake_count`,
  `asleep_minutes`, `awake_minutes`, `longest_stretch_minutes`, `coverage_minutes`,
  `avg_temperature`, `avg_humidity`, `computed_at`.
  (NOT `camera_id`, NOT `date`, NOT `total_wakes`.)
- **`bed_transitions`**: `camera_id`, `type` (`out_of_bed` | `into_bed`), `peak`
  (0–1 fraction, i.e. 0.2 = 20%), `created_at`.
- **All timestamps are UTC text** `"YYYY-MM-DD HH:MM:SS"`. **Melbourne = UTC+10** — add
  10h for AEST. (Container *logs* are already AEST; the *DB* is UTC. Don't mix them up.)
- A night's window is `window_start`→`window_end` in UTC. For an overnight, `night_date`
  is the evening's date and `window_end` is ~07:00 AEST the next morning.

## 3. The reliable DB-query recipe

Write the JS locally, base64 it, decode it **inside the container to a fresh filename**,
then run it. Two hard-won rules:

- **Never reuse `/tmp/bt.js`.** A past `docker cp /dev/stdin` left it as a symlink to
  `/proc/self/fd/0`, which silently swallows writes and makes `docker cp` fail with
  `Could not find the file /proc/self/fd`. Always write to a fresh name (or `rm -f` first).
- **Don't use `docker cp`** for this — pipe base64 through `docker exec sh -c` instead.

```bash
# 1. author query locally
cat > /tmp/x.js <<'EOF'
const db = require('better-sqlite3')('/app/data/babymonitor.db', { readonly: true });
// ... query here ...
EOF

# 2. ship + run (fresh filename inside the container)
B64=$(base64 -w0 /tmp/x.js)
ssh -i ~/.ssh/unraid_nightlight -o StrictHostKeyChecking=no root@192.168.1.100 \
  "docker exec nightlight-dev sh -c 'rm -f /tmp/q.js; echo $B64 | base64 -d > /tmp/q.js' && \
   docker exec -e NODE_PATH=/app/node_modules -w /app nightlight-dev node /tmp/q.js"
```

Ready-made query for a night's review (edit the child/camera as needed):

```js
const db = require('better-sqlite3')('/app/data/babymonitor.db', { readonly: true });
const cams = db.prepare("SELECT id,name,child_id FROM cameras").all();
const c = cams.find(x => /renz/i.test(x.name));

console.log('=== bed_transitions (UTC; +10 = AEST) ===');
for (const r of db.prepare(
  "SELECT type,peak,created_at FROM bed_transitions WHERE camera_id=? AND created_at >= datetime('now','-24 hours') ORDER BY created_at"
).all(c.id)) console.log(r.created_at, r.type.padEnd(11), 'peak='+r.peak);

console.log('\n=== sleep_nights (latest 3) ===');
for (const r of db.prepare(
  "SELECT night_date,window_start,window_end,status,onset_at,wake_at,onset_at_shadow,wake_at_shadow,wake_count,asleep_minutes,coverage_minutes FROM sleep_nights WHERE child_id=? ORDER BY night_date DESC LIMIT 3"
).all(c.child_id)) console.log(JSON.stringify(r));
```

## 4. Log review (candidate detail the DB doesn't keep)

`bed_transitions` stores only *confirmed* transitions. The candidate/cancel churn (why a
transition did or didn't fire) is log-only:

```bash
ssh -i ~/.ssh/unraid_nightlight root@192.168.1.100 \
  "docker logs --since 20h nightlight-dev 2>&1 | grep -E 'OUT OF BED|INTO BED' | grep -i renz"
# add \[oob\]|\[intobed\] to the grep for the candidate/cancelled detail
```

Log lines are **AEST**. A confirmed line looks like:
`[oob] "Renz Cam" OUT OF BED — motion left the bed, quiet 6000ms since, outside peak 6.3%`

## 5. Reading it

- **Restless cluster** = many alternating out/into within an hour, low outside peaks
  (<~11%) → stirring/re-settling in the bed, not actually on the floor. High outside
  peaks (>~15%) + a *terminal* out_of_bed followed by long quiet → genuinely up.
- **Consecutive same-type** transitions (e.g. five `into_bed` in a row) = repeated
  re-entry/stir during a restless patch; they collapse to one interval in the analysis.
- Compare `onset_at`/`wake_at` (movement-only algo) vs `*_shadow` (transition-corrected).
  Known shadow weaknesses to sanity-check against the markers before trusting a shift:
  - **Onset**: FIXED 2026-08-24. Previously the rule took the *latest* into-bed-followed-by-quiet,
    so a ~4am re-settle after a mid-night waking masqueraded as onset (put onset at 4:20am on
    2026-08-23). Now takes the *earliest* qualifying into_bed — the first put-down that leads to
    sustained sleep. Mid-night re-settles no longer move it.
  - **Wake**: the empty-bed heuristic is robust — on 2026-08-24 it correctly caught a 6:39 rise
    that the *transition* detector missed (he climbed out without lighting the outside-bed zone
    enough to confirm an out_of_bed). Residual theoretical risk only if a child sleeps well past
    window+lookahead with truly no motion and no exit; watch for a wake that lands suspiciously
    early with no nearby transition.
