# UI/UX refresh (v2) — scope, reconciliation & decisions

**Status:** scoped & decided (2026-08-11), not started. Baseline **v0.13.0**.
Open questions Q1–Q6 were answered by the user on 2026-08-11 — see §5 (now "Decisions, resolved").
The **v1 cut** is defined in §0.
**Source material (from the design pass, Aug 2026):** `NIGHTLIGHT-UX-HANDOFF.md`,
`TESTER-BRIEF.md`, `TOGGLE-SWITCH-CSS.md`, and two clickable mocks
(`nightlight-CURRENT-state.html`, `nightlight-PROPOSED-state.html`).
**This doc supersedes the handoff for scope/sequencing.** The handoff is kept for rationale;
where the two disagree about how the *current* app works, this doc is right (it was checked against
the code). The mocks are illustrative only — their buttons don't all match real behaviour.

The proposal is a navigation + camera-tile restructure plus two features (dark mode; a
switch style for toggles). **Most of it is frontend-only.** The parts that touch the backend or the
data model are listed explicitly in §6.

---

## 0. The v1 cut (what we build first)

All six decisions are made (§5). With dark mode landing **per-device** (zero backend) and the Alerts
feed needing only **one small read endpoint**, v1 is everything except the per-camera **routing
refactor** and the **split detection screens**. Concretely:

**In v1:**
- **Phase 0** — toggle switches on immediate-apply toggles.
- **Phase 1** — 4-tab nav (Live / Alerts / Family / Settings) + role-aware Family & Settings hubs +
  labelled back-nav.
- **Phase 2** — camera-tile restyle.
- **Phase 3** — gear bottom sheet. Detection / "All camera settings" links open the **existing edit
  modal** for now (Q2 interim), so v1 isn't blocked on routing.
- **Phase 6** — About folded into the Settings hub.
- **Phase 7** — dark mode, **per-device** (Light / Dark / System), zero backend.
- **Phase 8 (lean)** — Alerts tab: caregiver-visible feed **with the snapshot thumbnail**, **no
  badge**. This is the *only* backend in v1: one non-admin read endpoint for detection events (§6).

**Deferred to v2:**
- **Phase 4** — per-camera settings as real routes (the structural refactor). Target design is the
  mock's full routes; see §5-Q2.
- **Phase 5** — Motion / Sound / Schedule as separate routed screens (depends on Phase 4).
- Alerts **unread badge** (Q4) — add later; v1 leaves room for it.

So v1 is frontend-only **except one read endpoint** for the Alerts feed. No schema change.

---

## 1. Reconciliation with the current code (read this first)

The handoff makes a few claims about "how it works today" that are inaccurate against the real
codebase. Correcting them changes the plan, so they're first.

### 1a. The camera tile does NOT navigate — the video zooms
Handoff §3 says "the video area previously navigated to camera settings" and builds a rule around
not letting stray taps fall through to navigation. **In the real `CameraTile.jsx` there is no
navigation from the tile at all.** The video wrap's `onClick` is `handleVideoTap` — double-tap to
zoom, single-tap-while-zoomed to re-pan (lines ~392–425). So:
- The "don't put a click handler on the video" rule is already satisfied and is about the *prototype*,
  not our code. No work there.
- The real constraint is the opposite one (§1b): there is currently **no route to a single camera's
  settings**, so anything in the new design that links to "camera settings / detection screens" is
  *new* navigation we have to build, not a handler we have to remove.

### 1b. Camera settings today = a modal in `pages/Cameras.jsx`, not a screen
Editing a camera is a `<Modal>` opened from the Cameras list (`openEdit` → `doSave`). There is no
`/cameras/:id` route and no per-camera settings screen. The proposal's **gear sheet → "All camera
settings"**, its **Motion / Sound / Schedule as separate screens**, and its **back-nav-to-origin
rule** all assume routed per-camera screens. **This is the single biggest structural change in the
whole refresh** and most of §5's questions hang off it. Options in §3, Phase 4.

### 1c. The gear already exists and already does mode / quality / stop
The tile's gear (`settings-btn`) opens a `tile-menu` that today already has: Low latency /
Compatibility, a High/Low quality submenu (only when `camera.has_sub`), and **Stop / Start camera**
(persisted per-device in `localStorage['nightlight_stopped_<id>']`, with the "Camera stopped"
overlay). So the "gear sheet" is an *expansion* of an existing menu, and **Stop camera is already
shipped** (handoff §7 confirms this) — we reshape the menu into a bottom sheet and add the detection
links, we don't build stop/mode/quality from scratch.

### 1d. Real field names on the camera object (use these, not the mock's)
`camera.ptz_supported`, `camera.talk_configured`, `camera.has_sub`, `camera.mqtt` (temp/humidity),
`camera.statusLevel`. Per-device tile state is localStorage: `nightlight_muted_<id>` (three-state
`on|off|bg`), `nightlight_quality_<id>`, `nightlight_stopped_<id>`. Temp/humidity render via
`formatReading()` joined with ` · ` — matches the handoff.

### 1e. Alerts today are **admin-only** and have no read/unread concept
"Recent alerts" lives in `SettingsLogs.jsx`, which is under `/settings/*` = `AdminProtected`. So
today a caregiver can't see alerts at all. Promoting Alerts to a top-level tab (§3 Phase 1) is also a
**permission change** (caregivers would gain the alert feed) and needs a **read/unread model that
does not exist** for the badge (the `detection_events` table has no per-user seen state). See §5-Q4.

### 1f. There is no per-user preferences store anywhere
Auth users have role / names / password / sessions only. Every "per person" toggle in the app today
is actually **per-device localStorage** (mute, quality, stopped, and even *notifications* —
`nightlight_notifications_enabled`). So "dark mode per user" has real weight: per-**device** matches
every existing pattern and needs zero backend; per-**account** is net-new backend (a
`user_preferences` table + endpoints + wiring). See §5-Q1.

### 1g. Detection defaults — verified against `db.js`, handoff is correct
`detect_sensitivity` 50, `detect_confirm_s` **3**, `detect_cooldown_s` **60**; `sound_sensitivity`
50, `sound_confirm_s` **4**, `sound_cooldown_s` **120**; `detect_schedule_enabled` 0;
`detect_zone` exists (TEXT JSON) and stays unused. Don't unify the motion vs sound timing defaults.

### 1h. Role-awareness is a cross-cutting concern the mock ignores
`/settings/*` is admin-only; `/children`, `/cameras`, `/account`, `/about` are any-user. In the new
4-tab model: **Family** would mix any-user (Children, Cameras) with admin-only (Caregivers =
`SettingsUsers`); **Settings** would be almost entirely admin-only except Account/About. Every new
hub needs to render role-appropriately (a caregiver's Settings tab is basically just Account +
About). Not hard, but must be designed in, not bolted on.

---

## 2. What's genuinely new vs. re-dressing existing UI

| Area | New build? | Notes |
|---|---|---|
| 4-tab nav (Live/Alerts/Family/Settings) | Re-dress + **1 new tab** | Replaces `NavBar.jsx` 3 tabs; Alerts is the only truly new destination |
| Alerts tab | **New** (data exists) | Feed exists in Logs; needs de-admin + read/unread for badge (§5-Q4) |
| Family hub | Re-dress | Merges existing Children + Cameras + Users pages under one hub |
| Camera tile restyle | Re-dress | Icon sizing/glow, temp+humidity icons; behaviour largely unchanged |
| Gear → bottom sheet | Re-dress + **new links** | Existing mode/quality/stop + new detection links + "all settings" |
| Per-camera settings **screens** | **New structure** | Modal → routes; see §1b / Phase 4 |
| Motion / Sound / Schedule split | Re-dress of existing form sections into screens | Fields already exist in `Cameras.jsx` |
| Unify Add/Edit camera form | **Fix** | Edit really is missing IP/port/user/pass — worth doing regardless |
| Dark mode | **New feature** | Storage decision gates it (§5-Q1) |
| Toggle switches | Trivial | `TOGGLE-SWITCH-CSS.md` is drop-in; obey the immediate-vs-save rule below |
| About into Settings | Trivial | `pages/About.jsx` already exists and is routed |

---

## 3. Restructured phase plan

Ordered so each phase is shippable and low-risk before the structural ones. (Handoff §9 order kept
where it still holds; re-sequenced around §1b.)

**Phase 0 — Toggle switches (trivial, do first as a warm-up).**
Add `.switch` from `TOGGLE-SWITCH-CSS.md` to `index.css`; apply to *immediate-apply* toggles only:
Account notifications, MQTT enable, Push enable, Logs auto-refresh. **Rule:** switch = applies
instantly; checkbox = applies on Save. By that rule the motion/sound "Enable" toggles are a judgement
call — they live in a Save-on-submit modal today but the backend `/detection` route applies
immediately, so they become switches *if and only if* Phase 4/5 makes the detection screens
immediate-apply. Frontend-only, no backend. Files: `index.css`, `Account.jsx`, `SettingsMqtt.jsx`,
`SettingsPush.jsx`, `SettingsLogs.jsx`.

**Phase 1 — 4-tab nav + back-nav rule.**
Rewrite `NavBar.jsx` to Live / Alerts / Family / Settings; introduce Family and Settings **hub**
pages; make each tab role-aware (§1h). Back buttons carry a label ("‹ Live", "‹ Camera") and return
to origin — implement with router location state (a `from` in `navigate(..., { state })` or a
location key), **not** a hardcoded parent. Everything else hangs off this. Files: `NavBar.jsx`,
`App.jsx` routes, new `Family.jsx` + `SettingsHub.jsx` (or restructure existing `Settings.jsx`).

**Phase 2 — Camera tile restyle (highest visual impact, no backend).**
Icon set to one optical size (the path must fill the viewBox, not just the box — the old speaker
glyph problem); glow-not-chip styling; mic hot-state = red rounded fill + pulse (already
`talk-btn--active`, verify it matches); **temp + humidity get thermometer/droplet icons** in front
of the existing `formatReading()` output (presentation only, keep unit handling). No tap target on
the tile body — but note this is *already* true (§1a), so it's a styling pass, not a behaviour
change. Files: `CameraTile.jsx`, `index.css`, icon components.

**Phase 3 — Gear bottom sheet.**
Reshape the existing `tile-menu` into a bottom sheet with grabber + Done + backdrop-dismiss. Keep
mode / quality / stop. Add Detection links (Motion / Sound / Schedule) and "All camera settings".
**These links depend on Phase 4 existing** — until per-camera screens are routed, wire the sheet but
point the detection/settings links at a placeholder or keep them disabled. Files: `CameraTile.jsx`,
`index.css`.

**Phase 4 — Per-camera settings as routes (the structural one).**
Convert camera edit from a modal in `Cameras.jsx` to routed screens so both the gear sheet and
Family → Cameras can deep-link into them and back-nav works. Sub-decisions in §5-Q2. This unlocks
Phase 3's links and Phase 5's screens. Also the right moment to **unify Add/Edit into one shared form
component** (handoff §6 — Edit currently omits IP/port/user/pass; this is a real bug worth fixing on
its own). Files: `App.jsx` routes, `Cameras.jsx` (extract form), new camera-settings screen(s).

**Phase 5 — Split Motion / Sound / Schedule screens.**
Break the detection sections out of the camera form into three screens with their real, distinct
fields/defaults (§1g). `detect_zone` stays unrendered. Decide immediate-apply vs save (ties back to
Phase 0's switch rule and the existing `/detection` immediate route). Files: new detection screens,
`routes/cameras.js` already supports `/detection` immediate updates.

**Phase 6 — About into the Settings hub.**
Show it as a row with the version inline (`0.13.0 ›`). Content already exists in `About.jsx`; don't
reword the "Not a safety device" disclaimer. Files: `SettingsHub.jsx`, `About.jsx` (reuse).

**Phase 7 — Dark mode (per §5-Q1 outcome).**
`Settings → Account → Appearance`: Light / Dark / System. Implementation note that bit the mock:
set the theme token on the theming *container*, not `body`, so a dark scope re-resolves inherited
colours; audit hardcoded colours (alert tags, drag handles, secondary text, empty states). If
per-account (Q1), this also needs the backend from §6. Files: theme container, `Account.jsx`, CSS
tokens, (maybe) backend.

**Phase 8 — Alerts tab feed (lean, in v1; badge deferred).**
Add a **caregiver-visible read endpoint** for detection events (today the feed is admin-only under
`/settings/logs` — Q3). The Alerts screen renders the feed as a list **with each event's snapshot
thumbnail** (images already exist via per-camera `snapshot_url` / ffmpeg grab — [[camera-snapshot-api-idea]]),
so it doubles as the in-app alert view for users without push (Q4). **No badge in v1** — leave room
for a per-device "last seen" badge later. This is the *only* backend change in v1. Files: a
caregiver-allowed detection-events route, Alerts screen; **no schema change**.

---

## 4. The two mocks vs. reality — quick map

- The **PROPOSED** mock's `from`-tracking for back-nav → implement with react-router location state.
- Its switches, dark-mode toggle, and gear sheet are the intended look; its data is fake.
- The **CURRENT** mock is a fair likeness of today *except* it implies tapping the tile opens
  settings — it doesn't (§1a). Don't treat the mock as the behavioural spec for current code.

---

## 5. Decisions (resolved 2026-08-11)

**Q1 — Dark mode storage → PER-DEVICE.** "Keep it the same as the sound options." Store the theme
choice in localStorage exactly like `nightlight_muted_<id>` / quality / stopped — a single
`nightlight_theme` key (`light|dark|system`), applied before login, zero backend. No
`user_preferences` table. (This is what removes the last would-be schema change from v1.)

**Q2 — Camera settings → keep the modal for v1; full routes are the v2 target.** The user likes the
mock's flow (full per-camera routes) and is open to a better option. Recommendation, adopted: the
mock's **full routes** (`/cameras/:id`, `/cameras/:id/motion`, …) are the right *end state* — cleanest
back-nav, real deep-linking from the gear sheet — but that's the big structural change (§1b), so it's
**Phase 4 / v2**. For **v1**, the gear sheet's Detection + "All camera settings" links open the
**existing edit modal** (interim), so we ship the new nav/tile/sheet without blocking on the refactor.
When we do Phase 4, we go straight to full routes (not a half-step), matching the mock.

**Q3 — Alerts tab → VISIBLE TO CAREGIVERS.** Confirmed. This is the one backend change in v1: a
**non-admin read path** for detection events (today the feed is behind admin-only `/settings/logs`).
Add a caregiver-allowed `GET` for the events feed; keep event *config* admin-only.

**Q4 — Unread badge → NO BADGE for v1.** Ship the Alerts feed without a badge; leave the design room
to add a per-device "last seen" badge later (§0 deferred). **Scope in the snapshot:** the Alerts feed
**shows each event's snapshot thumbnail** — the images already exist (per-camera `snapshot_url` /
ffmpeg grab, see [[camera-snapshot-api-idea]]). Rationale (user): the in-app feed with images is
genuinely useful **for users who don't have push configured** — it becomes their primary alert view,
not just a log.

**Q5 — Switches on detection "Enable" toggles → deferred with Phase 5.** Detection stays in the
Save-on-submit edit modal for v1, so those remain checkboxes per the switch/checkbox rule. Revisit
when Phase 5 makes the detection screens immediate-apply.

**Q6 — First cut → the v1 defined in §0.** "Do what you suggest first. We can iterate." v1 = Phases
0–3, 6, 7 (dark mode per-device), and the lean Phase 8 Alerts feed. Phase 4/5 routing refactor → v2.

---

## 6. Backend / data-model touch points

Given the resolved decisions, **v1 touches the backend in exactly one place, and touches no schema:**
- **Alerts feed visible to caregivers (Q3=yes):** add a non-admin detection-events **read** endpoint
  (today the feed is behind admin-only `/settings/logs`). Keep event *config* admin-only. The snapshot
  images it displays already exist — no new storage.

Explicitly **not** needed now (were the other schema risks, all avoided):
- Dark mode is **per-device** (Q1) → no `user_preferences` table, no endpoints.
- Alerts badge is **deferred** (Q4) → no per-user `seen` state.
- Detection split (Phase 5, v2) reuses the existing immediate-apply path (`routes/cameras.js`
  `/detection`) → no new backend when we get to it.

---

## 7. Not to redo (litigated in the design pass — keep as-is)
- Video does not navigate (already true — §1a); it zooms.
- Latency/quality stay one tap away in the gear, not buried in camera settings.
- Motion and sound are **separate** screens with different defaults — don't merge or unify defaults.
- No detection-zone picker (`detect_zone` stays in the schema, unrendered).
- No PTZ explainer/help screen; no close-X on the PTZ pad; the D-pad is self-evident (tap the PTZ
  button or outside to close). Current PTZ already works this way.
- Logo unchanged; **Stop camera already ships** — just moves into the sheet.
- Don't port the prototype HTML; rebuild in the existing React/Vite + CSS-variable system.

---

## 8. Related
`ptz-control-scope.md`, `motion-detection-source-scope.md`,
`motion-sound-push-notifications-scope.md`, `adaptive-stream-quality-scope.md`. Feature status:
[[motion-detection-status]], [[feature-work-aug-2026]].
