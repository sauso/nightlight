#!/bin/sh
# A publish must use the newest main-push test attempt for this exact commit.
# gh run list can return partial SHA matches, so check headSha before trusting a run.
set -eu

: "${GITHUB_SHA:?GITHUB_SHA is required}"
GATE_WORKFLOW=${GATE_WORKFLOW:-test.yml}
GATE_BRANCH=${GATE_BRANCH:-main}
GATE_TIMEOUT_S=${GATE_TIMEOUT_S:-2700}
GATE_POLL_S=${GATE_POLL_S:-30}

case $GATE_TIMEOUT_S:$GATE_POLL_S in
  *[!0-9:]*|:*|*:) echo 'gate: timeout and poll interval must be non-negative seconds' >&2; exit 1 ;;
esac

list_runs() {
  gh run list --workflow "$GATE_WORKFLOW" --commit "$GITHUB_SHA" --event push --branch "$GATE_BRANCH" \
    --json databaseId,headSha,status,conclusion,createdAt,url --limit 20
}

# Node is available on GitHub-hosted runners and makes the full-SHA and newest-run
# selection explicit. The fake gh in tests supplies the same JSON as the real CLI.
select_run() {
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const runs = JSON.parse(input);
      if (!Array.isArray(runs)) throw new Error("gh run list did not return an array");
      const matching = runs.filter(run => run.headSha === process.env.GITHUB_SHA);
      matching.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) ||
        Number(b.databaseId) - Number(a.databaseId));
      const run = matching[0];
      console.log(run ? [run.databaseId, run.status, run.conclusion || "-", run.url].join("|") : "none");
    });
  '
}

deadline=$(($(date +%s) + GATE_TIMEOUT_S))
while :; do
  runs=$(list_runs)
  selected=$(printf '%s\n' "$runs" | select_run)
  if [ "$selected" = none ]; then
    echo "gate: waiting for a push test run on $GATE_BRANCH for $GITHUB_SHA"
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "gate: no test run for this commit: it is never published untested" >&2
      exit 2
    fi
  else
    id=${selected%%|*}
    rest=${selected#*|}
    status=${rest%%|*}
    rest=${rest#*|}
    conclusion=${rest%%|*}
    url=${rest#*|}
    if [ "$status" != completed ]; then
      echo "gate: waiting for test run $id ($status): $url"
      if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "gate: timed out waiting for test run $id: $url" >&2
        exit 2
      fi
    elif [ "$conclusion" = success ]; then
      echo "gate: test run $id passed: $url"
      exit 0
    else
      echo "gate: test run $id ended $conclusion: $url" >&2
      exit 1
    fi
  fi
  sleep "$GATE_POLL_S"
done
