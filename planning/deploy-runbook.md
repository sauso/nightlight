# Deploy runbook — staging, then production

The end-to-end procedure for getting `dev` onto staging and then, via a release, into production on
Unraid. Written 2026-09-06 for the 0.30.0 release, but the steps are the standing ones.

**This is a living procedure, not a plan** — see `ROADMAP.md` §5. It complements the `/release` and
`/deploy-staging` skills rather than replacing them: the skills are the automation, this is the thing
you read when something does not look right, and it records the traps that have actually bitten.

> **Ground rule for every step below: a merge is not a deploy, and a green tick is not a verification.**
> Each gate here exists because skipping it cost something real once.

---

## 0. Preconditions

| | check | why |
|---|---|---|
| ☐ | The **detection holdout has closed** (~2026-09-09) | Deploying to staging changes nothing on prod, but the release that follows does, and the holdout's whole purpose is an unbiased measure of the current detector. See `ROADMAP.md` §1. |
| ☐ | **Explicit go-ahead from the owner** for anything touching `main` | Standing rule. `dev` merges do not need it; `main` is production and always does. |
| ☐ | `git status --short` clean, local `dev` fast-forwarded to `origin/dev` | A stale local `dev` silently reverts the tree on checkout, and the branch you cut next is then based on old code. Hit for real at 0.25.0, 29 commits behind. |
| ☐ | `cd backend && npm test && npm run test:core` green | The gate is an **aggregate** across the include list, not per file — read a module's own row if you care about one. |
| ☐ | `node scripts/check-changelog.mjs` exit 0 | |
| ☐ | `df -h /c \| tail -1` shows > 2 GB free | C: hit 100% mid-release once; fastest safe fix is `npm cache clean --force`. |

**Access.** `ssh -i ~/.ssh/unraid_nightlight root@192.168.1.100`. Containers: **`nightlight`** (production)
and **`nightlight-dev`** (staging), both on `br0.10` with their own routable LAN IPs.

⚠️ **Prod database writes are blocked to the agent** (reads are fine), as are prod API writes. Anything
that needs one — pressing a button, changing a setting — is handed to the owner to do in the app.

---

## 1. Staging

### 1.1 Is a deploy even needed?
Only `frontend/`, `backend/` and `mediamtx/` (plus `Dockerfile` and the entrypoint) enter the image —
the authority is `grep -n '^COPY' Dockerfile`, never memory. A change confined to `docs/`, `planning/`,
`scripts/`, `.github/` (except `docker-publish.yml`), `e2e/` or `*.md` **cannot change the running app**.

Say which rule you applied, either way. **Never deploy silently and never skip silently.**

⚠️ `backend/test/**` **does** ship inside the image, so a test-only change is still a staging deploy
(a stale image means a stale suite) — but it is **not** a production concern, because the runtime stage
does not copy it.

### 1.2 Wait for the image
A merge does not build anything you can deploy. Wait for `docker-publish.yml` to publish `:dev` **for
the exact SHA you intend**:

```bash
gh run list --repo sauso/nightlight --workflow docker-publish.yml --branch dev --limit 4 \
  --json databaseId,headSha,status,conclusion \
  -q '.[] | "\(.databaseId) \(.headSha[0:7]) \(.status) \(.conclusion)"'
gh run watch <id> --repo sauso/nightlight --exit-status     # GATE: must end "success"
```

### 1.3 Deploy
```bash
ssh -i ~/.ssh/unraid_nightlight root@192.168.1.100 'bash /boot/config/nightlight-deploy.sh dev'
```

⚠️⚠️ **NEVER hand-roll `docker run`.** It recreates the container without the
`net.unraid.docker.managed=dockerman` label, which loses the template linkage, the icon, the UI-managed
config and the update badge. The guard script refuses to run if the template is missing, precisely so
this cannot happen by accident.

### 1.4 Verify — and mind the trap in the script's own output
```bash
ssh -i ~/.ssh/unraid_nightlight root@192.168.1.100 '
  c=nightlight-dev
  docker inspect -f "managed={{index .Config.Labels \"net.unraid.docker.managed\"}}" $c
  docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" $c | grep NIGHTLIGHT_GIT_SHA
  docker inspect -f "StopTimeout={{.Config.StopTimeout}}" $c
  docker logs --tail 12 $c 2>&1'
```

- **GATE:** `managed=dockerman`. Anything else means the linkage is broken — stop and fix it.
- **GATE:** `NIGHTLIGHT_GIT_SHA` equals the SHA you deployed.
  ★★ **Use this, NOT the OCI `org.opencontainers.image.revision` label — and the guard script prints
  the label.** Measured 2026-09-06: the label is populated on `nightlight-dev` and **empty on
  `nightlight`**, so on a *production* deploy the script's own verification line prints nothing and
  looks like a failure. It is not. The env var is set on both.
- **GATE:** `StopTimeout=30`, not `<nil>` (see §3.1). ★ It really does print the literal `<nil>` when
  unset, not `<no value>` — verified both ways.
- **GATE:** logs show cameras streaming and detectors alive, with no crash-restart loop.

### 1.5 Soak
**Two nights minimum** before promoting, and longer if the release touches detection or sleep. This is
the only environment with real cameras other than production.

The `nightlight-soak` container on the Windows box is a third environment that runs the same `:dev`
image against a synthetic camera — good for fault injection (hide `ffmpeg`, hide `mediamtx`), useless
for detection quality. ⚠️ **Never point it at a bedroom camera.**

---

## 2. The release to `main`

Use `/release`, which encodes all of this with its gates. What follows is what it does and why.

### 2.1 Decide the version
While on 0.x: **minor** if `[Unreleased]` contains any `### Added`, else **patch**.

### 2.2 Release-prep, on a branch off `dev`
1. `CHANGELOG.md`: leave an **empty** `## [Unreleased]` on top, then `## [x.y.z] - YYYY-MM-DD`
   (today's date, Melbourne local) above what was under Unreleased.
   ⚠️ **Do not delete the previous top version header** — that slip orphaned `[0.24.0]` in #147.
   ⚠️ **Merge duplicate type headings** while you are in there. A release batch is assembled from many
   PRs and each adds its own `### Added` without seeing the others. `check-changelog.mjs` gates it.
2. Bump `version` in **both** `backend/package.json` and `frontend/package.json`.
3. **Prune `planning/ROADMAP.md` in the same commit** — anything this release ships comes out of it.
   This is the only checkpoint that catches drift, and skipping it is how two sections sat there
   describing already-shipped features after 0.25.0.

### 2.3 Land it, then promote
`release-x.y.z` → PR into `dev` → squash-merge. Then the `dev → main` PR.

⚠️ **Wait for e2e GREEN before merging the dev→main PR** — it only runs on PRs into `main`, so this is
the first and last time it sees the release. Do not merge on pending or fail.
⚠️ Merge that one with `--merge`, **not** `--squash` — it preserves the dev→main model. It is also the
one PR you do **not** pass `--delete-branch` to; the head is `dev` itself.

### 2.4 Tag and publish the GitHub release — **mandatory**
Missed for v0.10–v0.13. The tag is what triggers `docker-publish` to build `:latest`.

```bash
git fetch origin main -q
FULL_SHA=$(git rev-parse origin/main)      # FULL sha — a short one is rejected as "invalid target"
gh release create v<x.y.z> --repo sauso/nightlight --target "$FULL_SHA" --title "v<x.y.z>" --notes "…"
```

Then wait for `docker-publish.yml` to finish. **GATE: success.**

### 2.5 Publish the security advisories
⚠️ **Do this as part of the release, not before and not after.** Two draft advisories
(`GHSA-43c3-wrx8-fq39`, `GHSA-qffc-965c-x74m`) are fixed on `dev` but unpublished. **The CHANGELOG
already tells users to rotate their tokens and cites the GHSA IDs** — anyone who looks one up before
publication finds nothing. Publishing earlier would disclose with no released fix available.

---

## 3. Production

```bash
ssh -i ~/.ssh/unraid_nightlight root@192.168.1.100 'bash /boot/config/nightlight-deploy.sh prod'
ssh -i ~/.ssh/unraid_nightlight root@192.168.1.100 'bash /boot/config/nightlight-deploy.sh dev'  # resync staging
```

Verify exactly as in §1.4, against the **release commit** — remembering that the OCI label is empty on
prod and `NIGHTLIGHT_GIT_SHA` is the signal that works.

### 3.1 The shutdown grace — what to expect the first time
Both DockerMan templates carry `--stop-timeout 30` in `<ExtraParams>` as of 2026-09-06 (backups:
`*.xml.bak-2026-09-06`). **It applies only when the container is next recreated**, which is what
`update_container` does — so the first deploy after that edit is when it takes effect.

**GATE:** `docker inspect -f '{{.Config.StopTimeout}}' nightlight` → `30`.

It matters because shutdown now waits up to ~6 s to finish an in-flight recording, and Docker 29's bare
`docker stop` was **measured at ~4 s** before SIGKILL — short enough to lose exactly the recording the
code exists to save. The repo declares it in Compose, the shipped template and the documented
`docker run`; Unraid rebuilds from its **own saved template**, which is why the host edit was needed.

### 3.2 After a sleep or detection change — do not skip this
★★ **Recompute both children's last night on production and check the result.** Staging-green is not
prod-green: prod and staging have *different* `activity_samples`, and a fix has shipped and done
nothing on prod while looking correct on staging (0.27.0's empty-bed guard).

⚠️ Recompute is an **admin action in the app** and prod API writes are blocked to the agent — hand it
to the owner. Also outstanding: pressing **Recompute this night** for **Raffa, 2026-08-28**.

### 3.3 Migrations
Schema changes are hand-rolled at the bottom of `db.js`. After a release that adds columns or tables,
confirm they actually applied: `PRAGMA table_info(<table>)` via
`docker exec -e NODE_PATH=/app/node_modules -w /app nightlight node /tmp/x.cjs`.
⚠️ The production database is **`/app/data/babymonitor.db`**, not `nightlight.db`.

---

## 4. Rollback

The reason §2.4 is mandatory: every version has its own image tag, so rollback is a redeploy.

1. Point the template's repository at the known-good tag (`sauso/nightlight:0.29.0`) from the Unraid
   Docker tab, or edit `<Repository>` in the template.
2. `bash /boot/config/nightlight-deploy.sh prod`.
3. Verify `NIGHTLIGHT_GIT_SHA` matches the older release.

⚠️ **A rollback does not undo a migration.** Columns added by the newer version stay; the older code
ignores them. That is safe by design — but a migration that *changed* the meaning of existing data is
not, so read the release's migration block before rolling back across one.

---

## 5. Close-out

- `docker image prune -f` — the guard script does this; confirm it ran.
- Delete merged branches. ★ The authoritative test is **GitHub's merged-PR head list**, not
  `git branch --merged` (which misses squash-merges forever). **Never delete `dependabot/*`.**
- Fast-forward local `dev` in both repos.
- Update memory: PROD version, what shipped, and any gate that caught something.
- Report: version, the prod SHA, staging resynced, release URL, branches cleaned, which roadmap items
  closed, **what the definition-of-done gate found**, and anything skipped.
