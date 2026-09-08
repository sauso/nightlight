# Comment-accuracy audit runbook

A repeatable, **provably complete** pass over every reassurance-shaped comment in the codebase,
checking whether the comment is true of the code beside it. Written 2026-09-09, after a two-agent
sampling audit covered maybe 15–20% of the source and still found a real defect.

**This is a living procedure** — see `ROADMAP.md` §5. Update the ledger at the bottom as each agent
lands, and correct the cost model with what it actually measured.

---

## 1. Why this exists

**A comment that says a case is handled stops the next person looking.** That is not a theory here:

- **#297** — five call sites carried a comment stating a `kill()` hazard was `EINVAL`, *"verified on
  win32"*, in a product that only ships on Linux. The real Linux behaviour was that killing a child
  whose spawn failed signals **the whole process group** — the backend killed itself. The comment is
  what stopped anyone looking, for days, while the failure was misattributed to GitHub's runners.
- **N1** (2026-09-08) — `routes/children.js:145` says *"comparing a recompute against a recompute can
  never differ."* False for an in-progress night: `computeNight` caps analysis at `Date.now()`, and
  `computeAndStoreNight` has no guard against storing one. The project already has a recorded incident
  about exactly this drift making a night worse.

Both are the same class, and neither was found by tests. A green suite proves the code does what the
code does; it says nothing about whether the prose next to it is true.

## 2. Scope, and why the unit of work is a list

The audit is driven by an **enumerated candidate list**, not by "read the files and see what turns up".
That is the whole point: with a list, completeness is checkable — *N candidates in, N verdicts out* —
and a gap is visible instead of invisible.

Generate the list with:

```bash
cd nightlight
PAT='^\s*(//|\*).*\b(never|always|cannot|can.t|impossible|guaranteed|safe|handled)\b'
grep -rnE -i "$PAT" backend/src frontend/src --include=*.js --include=*.jsx
```

Measured 2026-09-09: **441 candidates across 92 files, spanning 19,426 lines (~78% of the codebase).**

⚠️ **This is a candidate pool, not 441 real claims.** The pattern matches prose that merely uses the
word — *"One definition, imported, never copied"*, *"A bedtime is never a rigid clock time"*. Expect a
large fraction to be disposed of immediately as NOT-A-CLAIM. That is why the verdict set below has a
fast-dispose option: without it, an agent spends its budget writing paragraphs about prose.

★ **Consequence worth knowing before planning:** because the candidates span ~78% of the source, this
audit *is* effectively a full read of the codebase. It is not a cheap subset of one.

## 3. The four verdicts

Every candidate gets exactly one. No candidate may be skipped or merged.

| verdict | meaning |
|---|---|
| **NOT-A-CLAIM** | Prose that happens to use the word. Not an assertion about code behaviour. One line, move on. |
| **TRUE** | Asserts something about the code, and the code guarantees it. Must name what was read or run. |
| **FALSE** | Asserts something the code does not guarantee. **This is a finding.** |
| **UNVERIFIABLE** | A real claim, but resting on data or an environment the agent cannot reach (production behaviour, a device, a timing race). Say what would settle it. |

★ **UNVERIFIABLE is a wanted answer, not a failure.** Marking a claim unverifiable and saying what
would settle it is more useful than a guess dressed as a verdict.

## 4. The partition — 8 agents, one at a time

Balanced by candidate count against line count so no agent accumulates unmanageable context.

| # | scope | cands | lines |
|---|---|---|---|
| 1 | `lib/sleepAnalysis.js` | 47 | 1,352 |
| 2 | `index.js` + `db.js` | 36 | 1,452 |
| 3 | `routes/cameras.js` + `routes/auth.js` | 31 | 1,610 |
| 4 | clip pipeline — `clipRecorder`, `clipStorage`, `recordings`, `transcoder` | 55 | ~1,700 |
| 5 | detection — `motionDetector`, `soundDetector`, `soundBaseline`, `audioLiveness` | ~45 | ~1,800 |
| 6 | media/camera — `onvif`, `twoWayAudio`, `subStream`, `mediamtx*` | ~35 | ~1,900 |
| 7 | remaining backend `lib/` + `routes/` tail (~40 small files) | ~80 | ~4,000 |
| 8 | all frontend | 76 | ~5,600 |

Then **one verifier** over the union of findings, briefed to falsify each by name.

**Agent 1 is `sleepAnalysis.js` alone, deliberately** — densest, highest-stakes, and the file where a
wrong verdict costs most. It is also the calibration run: its measured cost sizes the rest.

⚠️ **Agent 7 is the awkward one** — ~40 files holding one or two candidates each, so it pays the most
file-opening overhead per verdict. Expect to split it in two.

★ **Run them one at a time.** Sequential, not parallel: it keeps the cost observable, lets the brief
improve between runs, and lets findings be raised as issues while they are fresh.

## 5. Per-agent workflow

1. **Generate that agent's candidate list to a file** and hand it over as an explicit checklist, with
   line numbers. Never make the agent re-derive it from a regex — a re-derived list is unprovable.
2. **Launch on Sonnet, read-only** (§6), in the background.
3. **Read its report; verify its findings yourself.** ⚠️ Non-negotiable. These agents produce
   confident, plausible, wrong findings. Trust them on *correctness* (does the comment match the
   code), not on *design*.
4. **Raise one GitHub issue per confirmed finding** (§7) — ⚠️ **unless it is a security defect, which
   goes to a private draft advisory instead, never a public issue** (§7).
5. **Update the ledger** (§8) with candidates, verdict split, findings, tokens, duration.
6. Only then launch the next agent.

## 6. The brief — what every agent must be told

Reused verbatim each time, with the scope and checklist swapped.

**Read-only, absolute.** No deletes, ever. No edits, creates or moves inside the repo. No mutating git
(`checkout`, `restore`, `reset`, `clean`, `stash`, `add`, `commit`, `rm`). The only write is its report,
outside the repo. It must end by running `git status --short` and pasting the result as proof.

**Evidence rules.** Every verdict labelled with what was read or run (file:line, or the command).
Quote the comment verbatim — never paraphrase a comment you are calling wrong. **Do not manufacture
findings**: "all 47 checked, 3 FALSE" is the wanted shape, and a run that finds nothing is a result.

**Write incrementally** — skeleton first, fill as you go, so a long run that gets cut off still leaves
something on disk. Use the Write tool, never a shell heredoc or `python -c`: shell expansion has eaten
backticks out of markdown in this repo six times, and these reports are full of code spans.

⚠️ **Traps that generate false positives if omitted:**
1. `dev` runs ahead of production — docs and comments describing unreleased work are **correct**.
2. The version in `package.json` lags on purpose; it is bumped at release time, not per commit.
3. Repo files are **CRLF**. `cat -A` and `grep -c` lie here; use `od -c`.
4. **Calibrated numbers are correct when the comment says so.** Detection/sleep thresholds were
   measured on two cameras in one house, and naming the night a number came from is the house style.
5. Identifiers still say `crib`/`cot` deliberately while user-facing text says "bed".
6. Comments narrating their own history (*"THIS COMMENT USED TO SAY…"*) are the house style for a
   corrected comment, not a finding.

⚠️ **Settled by measurement — must be listed, or the agent re-proposes discarded designs:** the
calibrated thresholds; bed-transition times authoritative since 0.26.1 (`USE_TRANSITION_TIMES` is the
revert); ~53% of wakes producing no alert is expected, not a bug; the definition-of-done CI job is
deliberately a warning; the mutation harness is deliberately not in CI; the `test:core` include list
must never shrink and its thresholds are an aggregate; `backend/test/**` is deliberately not in the
runtime image.

★ **Include control cases where possible** — comments known to be accurate (the #297 rewrites in
`processGuards.js`, `mediamtxProcess.js`, `transcoder.js`). An agent that calls a control wrong is
telling you about itself, not about the code.

## 7. Raising issues

**One issue per confirmed finding**, after your own verification — never straight from the agent's
report.

- **Title**: `<file>: <the false claim, stated plainly>`
- **Body**: the verbatim comment; what the code actually does, with file:line; the failure scenario or
  why it misleads; and **who is affected** — a comment that misleads a maintainer is worth less than
  one that hides a live defect.
- **Label** by severity as assessed *after* verification, not as the agent rated it.
- ⚠️ **Public repo — placeholder IPs only**, and never paste credentials, tokens or `rtsp_url`.
- State plainly in the issue whether the claim is *demonstrated* or *suspected*. An issue that
  overstates its evidence is the same defect as the comment it reports.

### ⚠️ When the finding is a security defect, it does NOT get a public issue

★ **Learned on agent 3, 2026-09-09.** A false reassurance about *credentials* is not a documentation
bug — it is a vulnerability report, and this repo's image is publicly distributed. Filing it as a
normal issue would disclose an unfixed credential leak to everyone running it, and **public disclosure
cannot be undone.**

So: **a security finding goes to a GitHub draft security advisory**, which is private to repo admins
and is the same vehicle already used for `GHSA-43c3-wrx8-fq39` and `GHSA-qffc-965c-x74m`. Create it
with `gh api repos/sauso/nightlight/security-advisories -X POST --input <payload.json>`.

⚠️ **The API rejects the obvious payload twice over**: `severity` must be one of
`critical|high|medium|low` (**not** `moderate`, the word GitHub's own UI displays), and a
`vulnerabilities` array is required — a `package` with an `ecosystem` (`other` is valid) and a
`vulnerable_version_range`. Build that JSON with a script and **verify the description round-trips**;
an advisory body is markdown full of backticks and is exactly the payload that shell expansion eats.

★ **The instruction "raise an issue for each finding" was given before anyone knew a finding would be
a vulnerability.** Do not read a general instruction as authorising an irreversible public disclosure —
take the private path and say plainly that you did, and why.

## 8. Ledger

Fill in as each agent lands. This is the resume point — the audit spans sessions.

| agent | scope | cands | NOT-A-CLAIM | TRUE | FALSE | UNVERIF | tokens | duration | issues |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `sleepAnalysis.js` | 47 | 3 | 40 | **0** | 4 | 153k | 8m48s | 0 |
| 2 | `index.js` + `db.js` | 36 | 2 | 32 | **2** | 0 | 187k | 7m29s | #304, #305 |
| 3 | `cameras.js` + `auth.js` | 31 | 0 | 29 | **1** | 1 | 186k | 7m28s | GHSA-wcgj-6p3c-vr9h |
| 4 | clip pipeline | 55 | | | | | | | |
| 5 | detection | ~45 | | | | | | | |
| 6 | media/camera | ~35 | | | | | | | |
| 7 | backend tail | ~80 | | | | | | | |
| 8 | frontend | 76 | | | | | | | |
| V | verifier over all findings | — | | | | | | | |

**Cost model — settled by agent 2. Scope by LINES, not by candidate count.**

| | lines | cands | tokens | tok/line | tok/cand |
|---|---|---|---|---|---|
| agent 1 | 1,352 | 47 | 153k | 113 | 3.3k |
| agent 2 | 1,452 | 36 | 187k | 129 | 5.2k |

Tokens-per-line agree within 14%; tokens-per-candidate differ by 59%. **Lines is the predictor.**
Projecting 19,426 scoped lines at ~130 tok/line gives **~2.5M total**, plus the verifier — the *upper*
end of the original guess, not the lower. Budget accordingly.

⚠️ **The hop rule costs ~14% and is worth every token.** Agent 2 read well beyond its 1,452 scoped
lines (12 external modules opened), which is why its tok/line is higher. It bought **both** of the
audit's first two findings — neither was visible from the file it lived in. Do not drop the hop rule
to save budget.

⚠️ **Wall clock is ~8 min per ~1,400-line scope**, near-constant across both runs. ~16,600 scoped lines
remain → roughly **1.5–2 hours** for agents 3–8 plus the verifier.

⚠️ **Two predictions this runbook made were wrong; both are corrected above.** The NOT-A-CLAIM fraction
was predicted as "a large majority" and came in at 3/47 then 2/36 — it is **small**, because the
pattern's false positives are rarer in real code than a two-line sample suggested. And the cost range
was quoted as 1.4M–2.2M when the answer is ~2.5M. ★ Both errors came from extrapolating a confident
number off one unrepresentative sample — the same failure this audit exists to catch, committed in the
audit's own planning doc.

## 9. Prior findings this audit follows on from

From the 2026-09-08 sampling pass, all verified independently:

| id | file | status |
|---|---|---|
| F1 | `docker-hub-overview.md:23` — "host networking is required" is false; ipvlan/macvlan is supported and is what prod runs | confirmed |
| F2 | `planning/sleep-marker-review-runbook.md:108` — `onset_at`/`wake_at` vs `*_shadow` labelled backwards since `USE_TRANSITION_TIMES` flipped in #184 | confirmed |
| F3 | `README.md:365` — "go to Account"; it is Settings → Account | confirmed, cosmetic |
| N1 | `routes/children.js:145` — "comparing a recompute against a recompute can never differ" | confirmed |
