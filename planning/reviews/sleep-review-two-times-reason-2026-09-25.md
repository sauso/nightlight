# Sleep review: two headline times + a reason on "No" + daytime grouping (v2)

## Context
The owner corrects nights on **staging** every evening. Investigating tonight's corrections (session
02c5615b, folded into `bed-transition-classifier-flaws.md`) found:
1. **Bedtime looks wrong on every reading night**, but it isn't wrong — it's answering a different
   question. The app reports "asleep" (when the room went quiet), and on a night with a bedtime story
   that's several minutes after "in bed" (when the child was placed down). The owner wants both shown.
2. **"No" can't say who it was.** The correction screen's verdict is `correct`/`wrong`/`unclear` only, so
   a parent leaving after reading, someone walking past, and a child actually moving in bed are all just
   "wrong" — indistinguishable in the data. Replaying the owner's own proposed rule ("movement after they
   leave = it was the parent") against all 542 staging-verdicted exits showed **zero discrimination** (it
   fires on 16-17% of both `correct` and `wrong` exits alike), so no such rule can be designed OR scored
   until the labels themselves carry who it was.
3. **Daytime noise floods the "Check the N events" list** — e.g. a walk across the zone at 2pm — with no
   way to dismiss a run of them at once.

Two issues get filed (before the build, referenced in the PR): one for A+B below (closed by tonight's
PR), one for the deferred "I left here" marker + an actual parent-exit rule (open, blocked on the
reason-labeled data this change starts collecting — rushing that rule tonight already produced a
validated-worthless first attempt, see the investigation above). Labels: `enhancement`.

## ★★★ v2 — plan reviewed by Codex `gpt-6-sol` and an Opus subagent, IN PARALLEL, 2026-09-25 evening
(astra dropped from the pipeline as of tonight, per the owner). Both traced the actual code rather than
trusting v1's claims, and both found real, overlapping defects — including **one that would crash
`computeAndStoreNight` on every non-`'ok'` night** (Opus reproduced it with an in-memory `better-sqlite3`
run: `RangeError: Missing named parameter "b"`). Every fix below is folded in; v1's text is superseded.
No further plan-review round is needed unless the build turns up something these two didn't cover — these
were mechanism-level fixes, not an open design question.

### Fixed: A) the two-times feature
- **`onsetTransitionAt` is a raw timestamp STRING already** (`t.created_at`, e.g.
  `'2026-09-24 08:58:50'`) — assign it to `out.in_bed_at` **directly, never through `minuteTime()`**
  (v1 self-contradicted on this). It carries seconds precision while `onset`/`algoOnset` are floored to
  the minute, so it can be up to 59s later than `onset_at` even on a night with no real gap — comparisons
  must be one-directional (`onset_at − in_bed_at ≥ 60s`) and never an absolute difference.
- **CRASH FIX (blocking): `in_bed_at` must also be added to the `base` object** (`sleepAnalysis.js:561-
  584`, next to `onset_at_shadow: null` at `:573`), not only to `out` (`:1437+`). Five early-return paths
  — `off` (`:585`), `no_data` (`:586`/`:598`/`:658`), `no_sleep` (`:844`), `empty` (`:1361`) — return
  `base`/`result` without ever reaching `out`, and `upsertNight` binds it as a named SQL parameter
  (`@in_bed_at`) unconditionally. Without the null default in `base`, storing any non-`'ok'` night throws.
  **Add a test that stores a `no_data`/`off` night and reads it back** — this is exactly the class of gap
  CLAUDE.md's "test the branches real data cannot reach" rule names, and the crash was invisible to both
  the plan's own author and one reviewer.
- **`getNightReview`'s `computed` object must also include `in_bed_at`** (`sleepReviews.js:179-185`
  currently selects only `status, onset_at, wake_at, asleep_minutes, wake_count`) — both reviewers caught
  this independently. Without it, the review screen (B2's anchor) never receives the value at all, even
  once `computeNight` returns it correctly.
- **db.js line references corrected**: the `sleep_nights` migration guards are at `db.js:754-810` (v1
  wrongly cited `:383-386`, which is `sleep_reviews`). Existing pattern there (confirmed): most columns
  (`onset_at_shadow`, `onset_at_algo`) are `ALTER TABLE`-only; only `unknown_minutes` is in both the
  literal CREATE and a guarded ALTER, which is the model to copy for `in_bed_at` (belongs to both a fresh
  install and an upgrade). New guard must run after `sleepNightsColumns` is read (`:754`).
- **Corrected-night coherence, no extra plumbing needed**: `applyCorrection` only overrides `onset_at`,
  never `in_bed_at` (`sleepReviews.js:291-300`), so a manually-corrected night could otherwise show an
  incoherent pair (in-bed time later than the corrected asleep time). Resolve this with the SAME display
  rule that already handles "no real gap": **only render the "In bed" line when `in_bed_at != null &&
  (onset_at − in_bed_at) ≥ 60s`.** A corrected night where the owner's typed onset lands before the
  computed put-down fails that check and silently falls back to showing "Asleep" alone — correct behavior
  for free, not a special case.
- **Known, stated limitation (not fixed tonight)**: tapping "Put down here" fills the *asleep* field
  (`NightReview.jsx:462-465`) with that transition's own time — on a story night, confirming the put-down
  frame this way sets the corrected onset equal to in-bed, erasing the gap part A displays. Pre-existing
  behavior, not introduced by this change. State it in the PR body as a known limit per CLAUDE.md's rule,
  not a silent gap.

### Fixed: B1) reason-on-wrong
- **Stale-reason bug (both reviewers, independently)**: if a row is saved `wrong` + reason `adult`, then
  later the verdict changes to `correct`/`unclear`/cleared, the reason must not survive. Do this **inside
  the same UPDATE that sets the verdict**, not as a client-driven "drop the reason" convention — extend
  `setTransitionVerdict` (`bedTransitions.js:339-344`) so that whenever the verdict being written is not
  `'wrong'`, `wrong_reason` is set to `NULL` in the same statement. This makes it correct even for an
  already-open old client tab that never sends a `reasons` field at all.
- **Ordering/atomicity (Opus, concrete)**: fold reason handling into `applyVerdicts` itself rather than a
  parallel `applyReasons` call — validate every id (night-scoped, via the existing `transitionsFor`
  membership check) and every reason value (against `WRONG_REASONS`) for **both** maps up front, before
  writing anything; then write verdicts+reasons together. Reuse the single `transitionsFor` result already
  computed for the verdict scoping check rather than re-querying (a save already calls `transitionsFor`
  effectively 3x — once in `applyVerdicts`, twice via `transitionInstant` for the onset/wake frame ids — a
  4th full scan for reasons is avoidable and should be).
- **The "resulting verdict" check has a null-vs-absent trap**: whether a reason is allowed for id X depends
  on X's verdict *after this save*, which is `Object.hasOwn(verdicts, id) ? verdicts[id] : <stored
  verdict>` — **never `verdicts[id] ?? stored`**, because an explicit `verdicts[id] = null` (clearing the
  verdict) must NOT fall back to treating it as "still wrong" via `??`. Any reason submitted for an id
  whose resulting verdict isn't `'wrong'` is dropped (not a validation error — this is the one deliberate
  asymmetry from `applyVerdicts`' existing all-or-nothing behavior; comment it as intentional). An unknown
  `WRONG_REASONS` value IS a validation error (400s the whole save), matching how a bad verdict value
  already behaves — no silent-drop for that case, only for the wrong-verdict-mismatch case.
- **Which UIs get the reason follow-up — narrowed from v1**: only the **full "Check the N recorded
  events" list's** plain `VERDICTS` buttons get the 3-chip reason follow-up. The quick-reversal card
  ("That was me" / "They got up" / "Not sure") and the lingering-motion card ("No, still in bed" / "Yes,
  they got up" / "Not sure") do **not** get it — their own bespoke labels already carry more specific
  meaning than a generic "wrong", and layering a redundant reason picker under "That was me" (already
  self-answering "who") is confusing, not additive. This also sidesteps a real contradiction Opus flagged:
  those two cards write into the *same* shared `verdicts` map as the full list, so a reason UI keyed only
  off `verdicts[id] === 'wrong'` would otherwise also appear under "No, still in bed" with mismatched
  framing.
- **New CSS wrapper class for the reason-chip row** (e.g. `.review-event__reasons`), **not** reused from
  `.review-chip`'s container — `MorningReview.test.jsx:376` counts `.review-event__verdicts` elements, and
  a shared container would corrupt that existing count-based assertion. The chip buttons themselves can
  still reuse the `.review-chip` visual class.
- **`touched`/`verdictsTouched` trap — this file has been bitten by this exact bug class twice already.**
  The `reasons` state must load from `t.wrong_reason` **inside the existing `if (!verdictsTouched)` guard**
  in the seed effect (`NightReview.jsx:109-124`), not in a separate unguarded effect — otherwise a `tz`
  resolving late (SettingsContext's async arrival, the same mechanism both prior incidents in this file
  trace back to) wipes an in-progress reason pick. Copy the existing late-timezone regression test shape
  (`MorningReview.test.jsx:401-415`) for a reason tap specifically, not just the verdict case it already
  covers.
- **`fmtTime` note**: it's a local closure in each of `SleepSummaryCard.jsx`/`SleepDetail.jsx` (not a
  shared export) — reuse each file's own copy, don't invent a new import path for it.

### Fixed: B2) group events well before bedtime — cutoff redesigned
v1 anchored the cutoff on the *computed* onset, which both reviewers showed is unsafe:
- **No anchor at all** (no named put-down frame, no computed onset yet — the state the screen is in
  before the owner has done anything) must not produce a `NaN` comparison that silently mis-groups
  everything. Explicit rule: **if there is no `in_bed_at`, no named onset frame, and no `computed.onset_at`,
  skip grouping entirely — render the flat list exactly as today.**
- **A badly-late computed onset can hide the very transition the owner needs to see.** The pre-existing
  4:20am mis-onset case (`sleepAnalysis.js:857`'s own comment) would put the REAL put-down inside "Before
  bedtime", collapsed, with its "Put down here" button out of sight — exactly backwards. **Anchor on a
  fixed local-clock cutoff instead of an offset from the (possibly wrong) computed onset**: group any
  transition before **16:00 local** (matches the owner's own phrasing, "early afternoon... walked across
  the zone") into "Before bedtime (N)". This is independent of whatever the algorithm currently believes
  bedtime is, so a bad computed onset can no longer hide a real transition. State plainly in a code comment
  that 16:00 is a starting guess, not a measured threshold, per CLAUDE.md's "say so if it isn't tuned" rule.
- **Naps are real, documented transitions inside this window** (`sleepAnalysis.js:793`'s own nap-exclusion
  guard exists because naps happen; a real 16:33 into_bed is cited in that file's comments). Bulk-answering
  the whole group `wrong` would write false labels over genuine nap transitions into the ground-truth set
  this whole feature exists to build honestly. Fix: the bulk button's copy and action must NOT claim "none
  of these happened" — it means **"none of these were a bedtime event"**, and it should pre-fill `wrong`
  only for transitions **not already flagged as a quick-reversal or lingering-motion case** (those get their
  own cards/verdicts and must be left alone) **and not already carrying a non-null verdict** (never
  silently overwrite an existing `correct`/`unclear` answer, or one set earlier in the same session before
  saving — Sol's concrete failure case).
- **The pre-fill is a starting point, not a lock**: expanding "Before bedtime" still shows each transition
  individually with its own chips, exactly like the current expanded list, so any pre-filled answer can be
  overridden before the actual save.

### Tests (folded in, on top of v1's list)
- Backend: a `no_data`/`off` night stores and reads back `in_bed_at` cleanly (the crash-fix regression
  test — must fail without the `base` fix).
- Backend: `getNightReview()`'s `computed` object includes `in_bed_at`.
- Backend: verdict wrong→adult→correct round trip via the real PUT route, reading the raw DB row after —
  `wrong_reason` must be NULL once the verdict is no longer `wrong`.
- Backend: a reason submitted for an id whose resulting verdict (post-save) isn't `wrong` is dropped, not
  stored, and does NOT reject the rest of the batch (explicit test for the deliberate asymmetry vs.
  `applyVerdicts`' existing all-or-nothing verdict validation).
- Backend: an id present in `verdicts` with an explicit `null` (clearing) does not get treated as "still
  wrong" by a `??`-style fallback — plant this exact case.
- Frontend: reason chips render ONLY on the full list's plain "No", never on the quick-reversal or
  lingering-motion cards' own wrong buttons.
- Frontend: switching a verdict away from "wrong" (or re-tapping to clear it) hides and clears the local
  reason state before save.
- Frontend: the late-`tz`-arrival regression test, copied for a reason tap.
- Frontend: grouping — an event just before vs. just after 16:00 local lands in the correct bucket (both
  sides tested, not one); a night with no anchor at all renders flat, no crash; the bulk button skips a
  transition that already carries a non-null verdict and skips any quick-reversal/lingering-flagged
  transition; the bulk pre-fill writes into the exact same `verdicts` map a manual tap does, so a save
  after a mix of bulk + manual works in one PUT.
- Frontend: `MorningReview.test.jsx:376`'s existing `.review-event__verdicts` count assertion still passes
  unchanged (confirms the new reason-chip wrapper didn't leak into that container).

## Build / review process
Touches `sleepAnalysis.js`, `bedTransitions.js`, `sleepReviews.js` (all in `test:core`'s core-logic
coverage list) and adds schema columns (`sleep_nights.in_bed_at`, `bed_transitions.wrong_reason`) — the
standing rule routes this to an **Opus build**, not Sonnet. Current checkout is on `fix/373-observation-
time` with real uncommitted #373 Step 0 work that must not be touched — **the build happens in an isolated
git worktree off `dev`** (`521cb72`), never in the primary checkout. Code review after the build: Codex
`gpt-6-sol` + a parallel Opus subagent, same pairing as the plan review. Mutation re-run by a Haiku
subagent after any review-driven fixes. Ask before commit; ask before merge to `dev` — no exception for
"tonight".

**Definition-of-done checklist for the PR:**
- Tests per the list above, including the crash-regression case and both sides of the grouping cutoff.
- Docs: no new user-facing setting, but the correction screen's own copy is the documentation here — the
  three reason labels, the "Before bedtime" bulk-button copy (must not overclaim "none of these
  happened"), and the "In bed"/"Asleep" labels themselves. Nothing assumes a specific timezone, camera, or
  child — the 16:00-local cutoff is a stated starting guess, not tuned to one house's schedule, and applies
  the same way regardless of which camera/child it's viewing.
- CHANGELOG: one entry under `[Unreleased]` → `### Added` (a fresh heading — `[Unreleased]` is currently
  empty post-0.33.2; confirmed via reading `check-changelog.mjs` that a first heading under an empty
  section is accepted).
- `git show HEAD` read before opening the PR (the PR #229 "comments lost to a revert" class of mistake).
- Response-shape ADDITIONS only (`in_bed_at`, `wrong_reason` via `SELECT *`, a new `reasons` PUT field) —
  nothing existing removed/renamed (never-break-open-clients).

## Verification
- Haiku subagent runs the backend suite + `test:core` (never directly) after the build and after each fix
  round; confirm coverage doesn't regress on the three touched core files.
- Deploy to staging (not prod) once merged — the owner corrects nights there tonight/tomorrow, so this is
  exercised live immediately.
- After deploy, spot-check one real night on staging: "In bed"/"Asleep" show correctly (both when they
  differ and when they don't), tapping "No" on the full list reveals reason chips (and does NOT on the
  quick-reversal/lingering cards), a pre-16:00 transition lands in "Before bedtime", the bulk button
  doesn't touch an already-answered or flagged transition.

## Deferred (separate issue, not built tonight)
"I left here" frame-naming button on exits + an actual parent-exit classifier rule using whole-night
occupancy. Blocked on B1's reason-labeled data accumulating; the owner's originally-proposed "movement
shortly after they leave" rule was replayed against all 542 currently-verdicted staging exits tonight and
showed no discrimination (16% vs 17% fire rate on wrong vs. correct) — don't rebuild that exact rule
without new evidence.
