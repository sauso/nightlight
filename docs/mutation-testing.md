# Mutation testing

`scripts/mutate.mjs` breaks the source one way at a time (the catalogue is `scripts/mutants.json`, about 1,900
entries) and reports any mutant the tests fail to kill. Coverage measures execution; this measures whether a test
would notice. It is a tool for finding missing tests, not a merge gate.

Contributor reference. Nothing here changes how Nightlight runs.

## Where it runs

| What | When | Cost | What a red result means |
| --- | --- | --- | --- |
| `mutate.mjs --check` (via `backend/test/mutants-catalogue.test.js`) | every push and PR | seconds | an entry no longer **applies**: its `find` moved, or a test it names was renamed |
| `.github/workflows/mutation.yml` | **weekly** (Sundays 02:43 UTC) and **by hand**; never on a PR | about 16 runner-hours in total, about 30 minutes to 1 hour on the clock | a test no longer **kills** an entry |

The second one is the whole catalogue split into 16 parallel shards. Run serially it takes about 7 hours.

## Running it by hand

On GitHub: **Actions → Mutation testing (full catalogue, sharded) → Run workflow**. The optional **only** box takes
a piece of a mutant label (the same text as `--only=`), for example `#679`. Shards with nothing to run in that case
finish immediately and are not failures.

Locally, one slice or a few mutants:

```bash
node scripts/mutate.mjs --shard=3/16            # every 16th mutant, starting at the third (about 30 minutes)
node scripts/mutate.mjs --only=sweeper          # mutants whose label contains "sweeper"
node scripts/mutate.mjs --only=sweeper --shard=1/2   # --shard is applied after --only
node scripts/mutate.mjs --shard=3/16 --list     # print what that shard would run, run nothing
```

`--shard=<i>/<n>` takes whole numbers with `1 <= i <= n`; anything else exits 2 with the usage. The shards are
round-robin by position in the catalogue, so for any `n` they are disjoint, they add up to the whole catalogue, and
they differ in size by at most one. A shard that ends up with no mutants (`n` larger than the number of matches)
exits 2 with `no mutants match`; the workflow checks first with `--list` and skips such a shard.

The script edits source files in place and puts them back (see the header of `scripts/mutate.mjs`). Do not run two
at once in one checkout, and do not edit the tree while one runs. The workflow gives every shard its own runner and
checkout, so it has neither problem.

## Reading the result

Each shard uploads its full log as the artifact **`mutation-shard-<i>`** (kept 30 days). The last job, **Collect
results**, lists problems in its log and in the run's **Summary** page, and is red when any of these is true:

| Line in the summary | Meaning | What to do |
| --- | --- | --- |
| `SURVIVED: <label>` | the tests pass with this change applied: nothing notices it | add a test that fails with the mutant (watch it fail), or, if the change cannot alter behaviour, mark the entry `expect: "equivalent"` with a `note` saying why |
| `ERRORED (cancelled test files …)` | the mutant's test run was cancelled, so there is no verdict | re-run that mutant with `--only=`; if it repeats, the entry or a test file is broken |
| `ABORT: …` / `STALE: …` | an entry's `find` no longer matches once, or it ran no test: the catalogue has drifted from the code | re-anchor the entry (`node scripts/mutate.mjs --check` names it); the shard stopped early, so the later entries of that shard were **not** run |
| `A CONTROL MUTANT WAS KILLED` / `RESTORE FAILED` | the harness itself is not measuring what it claims; every result of that shard is void | investigate before trusting any result of the run |
| `no log from shard <i>` | that shard never reported (cancelled, or the runner died) | re-run the workflow |

`HANG` lines (a mutant killed only by the 5-minute clock) are a **warning**, not a failure: they count as killed but
are a weaker kill, so look at them.

Known limits of the sharded run:

- **GitHub starts a `schedule` or `workflow_dispatch` run only from a workflow file that is on the repository's
  default branch (`main`).** Until a release carries this file to `main`, `gh workflow run mutation.yml --ref <branch>`
  answers `HTTP 404: workflow mutation.yml not found on the default branch` (seen when PR #722 was reviewed), and the
  weekly run does not fire. Before then, run the catalogue locally (`node scripts/mutate.mjs --only=...`).

- The catalogue's *control* mutants (a comment edit, which must survive; it proves the harness works) are spread over
  the shards by the same rule. A shard that holds none cannot detect a broken harness by itself; it relies on the
  other shards' controls. A harness broken for one runner only would go unnoticed.
- A run narrowed with `--only=` always carries one control: if the text matches mutants but none of them is a control,
  the first control in the catalogue is added (listed as `CONTROL`), so a broken test environment cannot report every
  selected mutant as killed and pass. With `--shard` as well, only the shard that draws the control carries it.
- The runs are only as repeatable as the runner. A mutant near its time limit can be a `HANG` in one run and a kill in
  the next.
- Nothing posts the result anywhere or opens an issue. Someone has to look at the red run.
- The workflow has been checked for syntax and its shard logic is tested (`backend/test/mutate-args.test.js`), but the
  first full run on GitHub's runners had not happened when this was written. Expect to adjust the shard count or the
  120-minute job limit after seeing real timings.
