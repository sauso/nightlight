# Nightlight design language

The reference for any change to the Nightlight UI. It describes what the app **already is**, so a
new screen looks like it was always there.

Everything here was read out of `frontend/src/index.css`, `frontend/src/lib/` and the components —
it documents the real system, not an aspiration. Where the code has drifted from its own rules,
that's called out as **drift** rather than quietly tidied away.

**Precedence when they disagree:** what the owner asked for → this document → what surrounding code
happens to do.

**Scope:** the web UI in `frontend/`, which is also the UI the Android/iOS shell displays (it loads
the deployed frontend live rather than bundling it). There is no separate native design language.

---

## 1. The two-accent idea

This is the single most important thing to understand, and the easiest to get wrong.

Nightlight has **two accent colours with different jobs**:

| Token | Role | Used for | User-editable |
|---|---|---|---|
| `--peri` | **Chrome** — "this is interactive" | active nav tab, switches, sliders, row icons, back link, drill-in chevrons, chips | **No** — fixed in both themes |
| `--accent` | **Call to action** — "this is the thing to press" | primary buttons, camera-tile glow, temperature/humidity icons, focus rings | **Yes** — recoloured in Settings → General |

Reach for `--peri` when marking something as navigable or toggleable. Reach for `--accent` for the
one action a screen exists to perform. A screen with three gold buttons has no primary action.

`--bar` (the navy header) is fixed in both themes, and so is `--peri`. **Only the neutrals flip
between light and dark.**

---

## 2. Themes

### The mechanism (deviates from the usual pattern — don't "fix" it)

`lib/theme.js` resolves the user's choice (`light` | `dark` | `system`) to a concrete value **in
JS** and stamps it on `<html>` as `data-theme`. The stylesheet therefore contains
**zero `@media (prefers-color-scheme)` blocks** and never needs any:

```css
:root { /* complete light palette */ }
:root[data-theme='dark'] { /* neutrals + live/offline re-declared */ }
```

Theme is **per-device** (localStorage, key `nightlight_theme`) and deliberately not synced through
the account — so a phone and a wall-mounted tablet can each pick what suits them.

**Rule:** every colour goes through a token. Never write a hex literal in a component rule; it will
be wrong in one of the two themes.

### Tokens

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--bg` | `#f0eff5` | `#0f1124` | Page ground |
| `--bg-elevated` | `#ffffff` | `#181a33` | Cards, tiles, bottom nav |
| `--bg-elevated-2` | `#eeedfa` | `#1e2140` | Nested surface, hover, switch track |
| `--text-primary` | `#1b1c33` | `#eceaf6` | Body text |
| `--text-secondary` | `#70718f` | `#8d8fb4` | Labels, meta, captions, inactive tabs |
| `--accent` | `#f4c56a` | `#f4c56a` | CTA (user-recolourable) |
| `--accent-dim` | `#cda94f` | `#cda94f` | Pressed/secondary accent |
| `--peri` | `#7c83db` | `#7c83db` | Interactive chrome (fixed) |
| `--peri-soft` | `#cfd2f5` | `#cfd2f5` | Chrome on the navy bar (back link) |
| `--bar` | `#12143a` | `#12143a` | App header (fixed) |
| `--bar-text` | `#f4f4fb` | `#f4f4fb` | Text on the bar |
| `--live` | `#6fae90` | `#7fc9a3` | Streaming / healthy (user-recolourable) |
| `--offline` | `#d9707a` | `#e08585` | Offline / destructive (user-recolourable) |
| `--border` | `#e6e4f0` | `#282a48` | Hairlines, field borders |
| `--field-bg` | `#ffffff` | `#1e2140` | Input backgrounds |

Sleep-timeline palette (its own pair, both themes, near line 1123 of `index.css`):
`--sleep-asleep`, `--sleep-stir`, `--sleep-wake`, `--sleep-awake`, `--sleep-visit`, `--sleep-temp`.
These are **data colours** — categorical, tuned for adjacency on a timeline. Don't borrow them for
UI chrome, and don't use `--peri`/`--accent` inside the timeline.

### Runtime theming — why you must never hardcode

`SettingsContext` overwrites five tokens at runtime from the user's saved settings, via CSSOM:

```js
root.setProperty('--accent', settings.accent_color);
root.setProperty('--live', settings.live_color);
root.setProperty('--offline', settings.offline_color);
root.setProperty('--font-display', font.display);
root.setProperty('--font-body', font.body);
```

Two consequences:

1. **A hardcoded `#f4c56a` silently stops following the user's theme.** Four palette presets ship
   (Nursery, Dusk lavender, Ocean calm, Rose quartz) plus a free colour picker, so the accent is
   very often *not* gold.
2. **This is CSSOM `setProperty`, not an inline `<style>` — that's deliberate.** CSP is enforced
   (see the repo `CLAUDE.md`) and `script-src` has no `unsafe-inline`. `setProperty` isn't policed
   by CSP; injecting a stylesheet would be. Keep theming on this path.

---

## 3. Typography

### Families

| Token | Job |
|---|---|
| `--font-display` | `h1`–`h3` only. Set globally: `font-weight: 600`, `letter-spacing: 0.01em` |
| `--font-body` | Everything else, incl. `button { font-family: inherit }` |
| `--font-mono` | Paths, IDs, log output, byte counts — `'SF Mono', 'IBM Plex Mono', Menlo, Consolas, monospace` |

Four user-selectable presets (`lib/fonts.js`), default **Warm Serif**:

| Preset | Display | Body |
|---|---|---|
| `warm-serif` *(default)* | Iowan Old Style / Palatino / Georgia | system sans |
| `modern-sans` | system sans | system sans |
| `rounded-friendly` | ui-rounded / SF Pro Rounded | same |
| `classic-serif` | Georgia / Times | same |

**All four are system font stacks — Nightlight ships no webfont.** That's a deliberate fit with an
offline-capable, self-hosted, CSP-enforcing PWA on a LAN. Don't add a font file or a Google Fonts
link without raising it first.

Because the display face can be a serif *or* a rounded sans depending on the user, never rely on a
specific face's metrics for alignment.

### Scale

The real, dominant sizes — stay on these:

| px | Use |
|---|---|
| 22 | Page title in the header (`17` on short landscape) |
| 20 | Large numeric readouts |
| 18 | Modal title |
| 16 | Sidebar nav label (desktop), sheet title |
| 15 | Input text, list-row name, sheet item |
| 14 | Button label |
| 13 | Default small text, `.section-title`, `.icon-btn` |
| 12 | Field label, badge |
| 11 | Bottom-nav label, chip, meta |

**Drift:** `12.5`, `13.5`, `14.5`, `11.5`, `10.5` and `9` each appear once or twice. Don't add more
half-pixel sizes; round to the scale in new work.

`.section-title` is the workhorse group header — 13px, weight 700, `letter-spacing: 0.02em`,
**uppercase**, `--text-secondary`, `margin: 22px 0 10px`. Uppercase micro-labels also appear on
sheets at 12px/`0.05em`.

Use `font-variant-numeric: tabular-nums` for any column of digits (durations, temperatures, byte
counts) — several sleep/recording views already depend on it.

---

## 4. Icons

Three distinct icon systems. Do not mix them up.

### 4.1 UI icons — `lucide-react`

The only icon library (`lucide-react` ^1.31.0). **51 distinct icons in use**; check that list before
introducing a 52nd, since the vocabulary is meant to stay small.

| Property | Value |
|---|---|
| Grid / viewBox | **24 × 24** |
| Colour | `currentColor` — inherits from the parent, so it themes for free |
| Stroke width | **2** (lucide's default; pass `strokeWidth={2}` only where it must survive scaling) |
| Caps / joins | `round` / `round` |
| Fill | none — Nightlight's icons are stroked outlines, not filled glyphs |

**Size scale** (`size={n}`, in px — the actual distribution in the codebase):

| Size | Count | Use |
|---|---|---|
| **16** | 35 | **The default.** Inline with text, row affordances, button leading icons |
| **18** | 14 | Slightly emphasised inline, tile controls |
| **20** | 7 | Bottom-nav tabs, primary tile actions |
| 13–15 | 20 | Dense meta rows, chips, badges |
| 22–26 | 7 | Section headers, prominent single actions |
| 50–100 | 6 | Empty-state and hero illustrations only |

New work should use **16 by default, 20 for navigation, 24 for a section-level icon.** Anything
≥50 is an empty state, not an icon.

Sizing rules:
- Set size with the `size` prop, **not** CSS width/height — lucide sets both attributes plus the
  viewBox, and CSS overrides desync them.
- Never scale an icon by a non-integer factor; strokes go blurry off the pixel grid.
- Pair size with the text it sits beside: 16px icon ↔ 13–15px text, 20px icon ↔ 11px nav label.

Accessibility (already applied 78×/43× in the codebase — keep it up):
- Decorative icon next to a visible text label → `aria-hidden="true"`.
- Icon **alone** in a button → the button needs `aria-label`.
- Toggle buttons carry `aria-pressed`; disclosure buttons carry `aria-expanded`.

Semantic assignments already established — reuse rather than reinvent:
`ChevronRight` drill-in · `ChevronLeft` back · `Play`/`Square` stream start/stop ·
`Volume2`/`VolumeX` mute · `AudioLines` audio activity · `Mic` two-way talk · `Zap` detection ·
`Moon` sleep · `Thermometer`/`Droplet` climate · `Cctv` cameras · `Baby` children · `Video` live ·
`Settings` settings · `Trash2` destructive · `DoorOpen` out-of-bed.

### 4.2 Brand / service icons — local SVG components

Third-party marks that lucide doesn't carry live in `frontend/src/components/icons/` as hand-written
React components: `FirebaseIcon`, `GotifyIcon`, `MqttIcon`, `NtfyIcon`, `PushoverIcon`.

They keep the vendor's own viewBox (`0 0 600 599`, `0 0 48 48`, `0 0 50.8 50.8`, `1 1 22 22`) and
the vendor's own colours — a brand mark must stay recognisable, so these are the **one exception** to
`currentColor`. Add a new one here, as a component, never as a remote image (CSP blocks it, and the
app must work offline on a LAN).

### 4.3 App icons — raster PNG

Served from `frontend/public/icons/`. **All seven are square PNGs. The full set must be regenerated
together whenever the artwork changes.**

| File | Resolution | Purpose | Referenced from |
|---|---|---|---|
| `favicon-32.png` | 32 × 32 | Browser tab | `index.html` |
| `apple-touch-icon.png` | 180 × 180 | iOS home screen | `index.html` |
| `icon-192.png` | 192 × 192 | **In-app illustrated logo** (header, login) | `AppHeader.jsx` |
| `icon-512.png` | 512 × 512 | High-DPI illustrated logo | direct reference |
| `icon-maskable-192.png` | 192 × 192 | PWA install + Android launcher | `manifest.webmanifest` |
| `icon-maskable-512.png` | 512 × 512 | PWA splash / high-DPI launcher | `manifest.webmanifest` |
| `now-playing-512.png` | 512 × 512 | Media-session artwork (lock screen) | `useNowPlaying.js` |

Two rules that are easy to break:

1. **The manifest lists only the maskable pair, with `purpose: 'any maskable'`.** Chrome's install
   dialog applies its own rounded-square crop, while the Android launcher applies a mask; using the
   same full-bleed artwork for both means neither reveals the other icon's inner shape boundary. The
   illustrated icon is still used in-app via direct references — that split is deliberate.
2. **Maskable artwork needs the safe zone.** Keep all meaning inside the central circle of diameter
   80% of the canvas (≈154px on 192, ≈410px on 512); the outer 10% on each edge can be cropped away.

In-app the logo renders at **36 × 36 with `border-radius: 9px`** (28 × 28 in short landscape) — it's
sourced from the 192 for retina headroom.

**Colours that live outside CSS** and must be changed in lockstep with the artwork:
`<meta name="theme-color">` = `#12172B` (`index.html`) and the manifest's `background_color` /
`theme_color` = `#12172b`. These are near-`--bar` but **not** token-driven — a token can't reach
them. Note they're currently one shade off `--bar` (`#12143a`); harmless, but don't propagate it.

---

## 5. Layout, spacing, radius

### Spacing

Effectively a **2/4px scale**. Gaps, most to least used: `8`, `12`, `10`, `6`, `4`, `5`, `14`, `16`.
Padding: `12px`, `10px 12px`, `12px 14px`, `16px` (card), `24px`.

Use `gap` on a flex/grid parent rather than margins on children — the stylesheet is consistent about
this and it avoids collapse/doubling bugs.

### Radius

| Value | Use |
|---|---|
| `--radius` (16px) | Nominal card radius — **drift: referenced only once**; `.card` hardcodes it |
| 12px | Cards in practice, nav tab, sheet section, tile-menu done button |
| 10px | **Camera tile** (deliberately gentler than 16 so it reads as a video panel), buttons, inputs |
| 9px | Header logo, sheet item, thumbnails |
| 8px | Small surfaces (most common raw value) |
| 20px | Modal sheet, on the leading edge only (`20px 20px 0 0` bottom, `0 0 20px 20px` top) |
| 999px | Pills, badges, switch track, grabbers |
| 50% | Dots, avatars, switch thumb |

New surfaces: **12px card, 10px control, 999px pill.** Don't introduce another value.

### Breakpoints

| Width | Change |
|---|---|
| ≥540px / ≥560px | Grid goes 2-up (tiles, sensors) |
| ≥768px, ≥1024px | Tile grid widens |
| **≥1200px** | **Bottom tab bar becomes a 220px left sidebar rail** — `.bottom-nav` flips to `flex-direction: column`, the header widens by `-220px` margin to sit above it. The *same component* renders both; don't fork it |
| ≤400px | Tightened small-phone spacing |
| landscape & ≤480px tall | Compact header (17px title, 28px logo) and nav |

Also: `@media (prefers-reduced-motion: reduce)` — see §7.

### Viewport and safe areas

- The app is **fixed-layout, not a scrollable document**: page zoom is disabled in `index.html`
  (`maximum-scale=1, user-scalable=no`) because double-tap zoom left the Android PiP window stuck.
  Don't re-enable it without reading that comment.
- Heights use `100dvh` behind `@supports`, so fixed elements don't drift as mobile browser chrome
  hides. `html, body, #root` are painted `var(--bg)` so iOS elastic overscroll doesn't flash white.
- **Every fixed edge must respect the safe area:** `env(safe-area-inset-top)` in the header,
  `env(safe-area-inset-bottom)` in the bottom nav and sheets.
- `overscroll-behavior-y: contain` keeps the browser's own pull-to-refresh from firing under the
  app's custom one (`usePullToRefresh.js`).
- `.app-shell` reserves `padding-bottom: 64px` for the bottom nav.

---

## 6. Components

### Card — the default container
```css
background: var(--bg-elevated); border: 1px solid var(--border);
border-radius: var(--radius); padding: 16px; margin-bottom: 14px;
```
One hairline border, no shadow. Shadows are reserved for things that float (sheets, the child card).

### Buttons
`.btn` — inline-flex, `gap: 6px`, radius 10px, `padding: 12px 18px`, 14px/600, and **`width: 100%`
by default** (mobile-first: buttons are full-width unless constrained).

| Variant | Style | Use |
|---|---|---|
| `.btn-primary` | `--accent` bg, `#21170a` text | The one main action per screen |
| `.btn-peri` | `--peri` bg, white text | Chrome-level action |
| `.btn-secondary` | transparent, `--border` outline | Everything secondary |
| `.btn-danger` | transparent, `--offline` outline + text | Destructive — outlined, never filled |
| `.btn-sm` | `padding: 6px 14px`, 12.5px, `nowrap` | In a row |
| `.btn-block` | full-width block | Explicit full width |

`:disabled` → `opacity: 0.55`. `.icon-btn` is the bare icon button: no background/border,
`--text-secondary`, `padding: 6px 8px`; `.icon-btn--danger` recolours to `--offline`.

Note `.btn-primary`'s text is `#21170a` — a near-black brown, not a token, because it must stay
legible on *any* user-chosen accent. Keep it.

### Fields
Label 12px `--text-secondary`, 6px below. Input: full width, `--field-bg`, 1px `--border`, radius
10px, `padding: 11px 12px`, **15px text** (≥16px would be ideal to stop iOS zoom, but page zoom is
disabled app-wide so 15 is safe here). `.field` has `margin-bottom: 14px`; `.field-row` puts two
side by side on a `1fr 1fr` grid.

**Focus is global and must not be removed:**
```css
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

### Switch
42 × 24 track, radius 999px; 18px thumb inset 3px, `translateX(18px)` when on; track goes `--peri`
when checked; transitions 0.16s. The real `<input>` is present but `opacity: 0` over the whole
control — keep it, it's what makes the switch keyboard- and screen-reader-accessible.

### Badges, chips, status
- `.status-badge` — filled pill, 3px 10px, 12px/600, white text; `--ok` `--live`, `--bad`
  `--offline`, `--off` `--text-secondary`. `--sm` = 2px 8px / 11px.
- `.cam-badge` — **outlined** pill (colour + border, transparent fill), 11px/600. Filled = state,
  outlined = attribute.
- `.cam-chip` — `--peri` on a 12% `--peri` tint, for the child a camera belongs to.

### Breathing dot — the live indicator
14px box, 8px core + expanding ring. `--live` breathing at **3.6s** (calm, steady), `--accent`
at **1.4s** (connecting, urgent), `--offline` static with no ring. The tempo carries the meaning;
if you add a state, pick its tempo deliberately.

### Modal (`components/Modal.jsx`)
On phone widths a **sheet**, not a centred dialog: overlay `rgba(10, 13, 28, 0.7)`, card
`max-width: 440`, hugging the bottom edge (`placement="top"` for the top), rounded 20px on the inner
side only, title 18px, `✕` close button with `aria-label="Close"`.

**`wide` opts a modal into a desktop treatment**: at ≥1024px it becomes a centred dialog,
`max-width: min(1040px, 92vw)`, `max-height: 92vh`, 16px all round. Only the video player uses it — a
440px sheet wastes a desktop screen on a video, but a confirmation must stay narrow at any width. Don't
add `wide` to a modal that is mostly text or a short form.

Layout lives in **CSS** (`.modal-overlay` / `.modal-card`), not inline styles. That is load-bearing: a
media query cannot reach an inline style, and inline styles beat stylesheet rules, so the desktop rules
would silently lose. Only the two values the visual-viewport effect computes stay inline.

It sizes itself to `window.visualViewport` and scrolls internally so the on-screen keyboard can't
push a focused field out of view, and it pads for `env(safe-area-inset-top)`. Both behaviours were
bug fixes — preserve them.

**Standing rule: never use browser `confirm()` / `alert()` / `prompt()`.** Every confirmation is an
in-app `Modal` (the camera-remove flow is the reference implementation).

### Tile menu — the bottom sheet
`.tile-menu` is the per-tile action sheet: bottom-anchored, `max-width: 520`, radius `18px 18px 0 0`,
a 38 × 4 grabber, uppercase 12px section labels, `--bg-elevated-2` grouped sections, 15px items,
`--peri` + weight 600 for the active choice, supports a submenu (`--submenu` row with a `--value` on
the right, plus a `--back` item). Backdrop `rgba(0,0,0,0.45)`, `sheet-fade` 0.16s in.

### Camera tile
The signature component. `--bg-elevated`, 1px `--border`, **radius 10px**, `overflow: hidden`.
The video wrap is 16:9 (`height: 50vh` when not fullscreen) so `object-fit: cover` fills exactly
rather than cropping the camera's own timestamp overlay. Stopped state is a `#0a0d1c` panel with a
centred restart button. Controls overlay the video; identity (name, child, drag handle, live dot)
sits in the strip below.

### List row (`.cam-row`)
Full-width button, `padding: 11px 14px`, 12px gap, hairline `--border` between rows (none on the
last), `--bg-elevated-2` on hover, 15px/600 name with a meta row 6px under. Thumbnails are 54 × 40
(radius 9px) or 40 × 30 `.sm` (radius 7px), with a radial-gradient placeholder and a 6px live dot
ringed in translucent `--live`. Offline thumbs get `filter: grayscale(1) brightness(0.62)`.

---

## 7. Motion

Transitions are **0.12s–0.25s**, clustered at **0.15s / 0.16s**, easing `ease`. Named keyframes:
`breathe`, `ptr-spin`, `spin`, `sheet-up`, `sheet-fade`, `talk-pulse`, `recpulse`, `push-banner-in`.

Motion in Nightlight is **status, not decoration** — a breathing ring means live, a pulse means
recording, a slide means a sheet arrived. Don't animate anything that isn't reporting state or
acknowledging a gesture.

**Every looping animation must have a `prefers-reduced-motion: reduce` opt-out.** The stylesheet
already carries per-feature overrides (`.rec-dot`, `.sleep-wakes__chev`, `.rec-btn--active`) plus a
global block; add yours when you add an animation. This matters more than usual here: the app runs
overnight on a bedside screen.

---

## 8. Copy and voice

Calm, plain, parental. Never alarming — this is a device watching a sleeping child.

**Say "bed". Never "crib", never "cot".** Standing convention (PR #179). It matches the database
(`bed_transitions`, `into_bed`, `out_of_bed`), stays correct as a child outgrows a cot, and is
neutral between AU/US usage for a publicly distributed image.

**Distinguish a moment from a span** — this distinction is load-bearing, don't collapse it:

| Kind | Label |
|---|---|
| Instant (timeline marker) | "Got into bed" / "Got out of bed" |
| Duration (activity span) | "Out of bed" |
| Someone else present | "Someone in the room" |

Identifiers deliberately **not** renamed: `detect_zone`, `.crib__*`, `cribActive`,
`CribZonePicker`. That divergence is documented in `NAMING:` comments in `motionDetector.js` and
`CribZonePicker.jsx` — don't "fix" it without accepting the schema/API churn.

Other rules:
- Sentence case for labels and buttons; uppercase only via `.section-title`.
- A button says what happens ("Save changes", "Add camera"), and the result confirms it.
- Errors say what went wrong and what to do. **User-facing API errors must be 4xx, not 5xx** — the
  Cloudflare proxy replaces 5xx bodies with its own bodiless page and the message is lost.
- Name things as a parent would: "Live", "Children", "Cameras" — not "Streams", "Subjects".

---

## 9. Accessibility floor

- Global `:focus-visible` ring — never `outline: none` without a replacement.
- Icon-only control → `aria-label`. Decorative icon → `aria-hidden="true"`.
- `aria-pressed` on toggles, `aria-expanded` (+ `aria-haspopup`) on disclosures.
- Real `<input>`s behind custom controls, not `div`s with click handlers.
- `prefers-reduced-motion` honoured for every loop.
- Both themes must clear normal contrast: `--text-secondary` on `--bg-elevated` is the tightest
  common pair — check any new neutral against it.

---

## 10. Before shipping a UI change

1. **Both themes** — light and dark, not just the one you built in.
2. **A non-default palette** — switch to Dusk lavender; nothing gold should remain hardcoded.
3. **A non-default font** — switch to Modern Sans; the layout must not depend on serif metrics.
4. **Phone width and ≥1200px** — the nav becomes a sidebar; confirm nothing collides.
5. **Safe areas** — anything fixed to an edge needs the `env()` inset.
6. **Keyboard** — tab through it; the focus ring must be visible on every control.
7. **Reduced motion** — any new animation has an opt-out.
8. **Copy** — "bed", sentence case, moment vs span, in-app modal not `confirm()`.
9. **Changelog** — every user-visible change goes under `[Unreleased]` in the same commit.

---

## 11. Known drift

Recorded honestly so it isn't mistaken for intent, and so it can be cleaned up deliberately:

- `--radius` (16px) is referenced exactly once; 12px and 10px are what cards and controls actually
  use. The token doesn't describe the system any more.
- Half-pixel font sizes (`12.5`, `13.5`, `14.5`, `11.5`, `10.5`) — a handful of one-offs.
- 20 distinct `border-radius` values across the stylesheet, against the ~6 the system needs.
- `theme-color` (`#12172B`) is one shade off `--bar` (`#12143a`).
- The camera-tile CSS family is split across `.camera-tile*` and `.cam-*` prefixes.

None of these are bugs. Match the **rule**, not the nearest drifted example.
