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
The button at the far right of the Live page header flips between light and dark. On every
other page, change the theme under Account → Appearance, which also offers **System** to
follow the device again.

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

The only icon library (`lucide-react` ^1.31.0). **57 distinct icons in use**; check the current imports before
introducing another, since the vocabulary is meant to stay small.

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
`Settings` settings · `Plug` integrations · `Trash2` destructive · `DoorOpen` out-of-bed.

**Record** on a camera tile: `RecordIcon` (a ring with a centre dot, a hand-written component, see 4.2) in
BOTH states, white with the same soft black glow as the other tile controls; while recording the button
becomes the red chip with the elapsed timer and the icon keeps its shape. It is a ring on purpose: a
solid white disc is a lot of light on a bedside screen at night, and the icon must not swell into one
when recording starts.

### 4.2 Brand / service icons — local SVG components

Third-party marks that lucide doesn't carry live in `frontend/src/components/icons/` as hand-written
React components: `FirebaseIcon`, `GotifyIcon`, `MqttIcon`, `NtfyIcon`, `PushoverIcon`.

They keep the vendor's own viewBox (`0 0 600 599`, `0 0 48 48`, `0 0 50.8 50.8`, `1 1 22 22`) and
the vendor's own colours — a brand mark must stay recognisable, so these are the **one exception** to
`currentColor`. Add a new one here, as a component, never as a remote image (CSP blocks it, and the
app must work offline on a LAN).

`RecordIcon` lives in the same folder but is not a brand mark: it is a UI glyph lucide does not
carry (the classic record ring-and-dot), and unlike the marks above it **does** use `currentColor`
(its `color` prop defaults to it), so it themes like the lucide icons.

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

An in-card title directly above media or a chart needs its own bottom margin; rows with their own padding do not.

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

- The app is **fixed-layout, not a scrollable document**, but page zoom differs by where it runs
  (#562). `index.html` ships the locked viewport (`maximum-scale=1, user-scalable=no`), and the
  **native app keeps it**: double-tap zoom left the Android PiP window stuck. In a **browser**
  (a home-screen install included) `lib/viewport.js` relaxes it at start: an Android or desktop
  browser loses both tokens, so pinch-zoom works for anyone who needs larger text; an **iOS
  browser** loses only `user-scalable=no` and keeps `maximum-scale=1`, because WebKit pinch-zooms
  regardless and that token is what stops Safari zooming into a focused field (see Fields). A
  zoomed-in browser is now a state the layout can be in. Read the comment in `index.html` before
  changing either side.
- Heights use `100dvh` behind `@supports`, so fixed elements don't drift as mobile browser chrome
  hides. `html, body, #root` are painted `var(--bg)` so iOS elastic overscroll doesn't flash white.
- **Every fixed edge must respect the safe area:** `env(safe-area-inset-top)` in the header,
  `env(safe-area-inset-bottom)` in the bottom nav and sheets. In fullscreen, camera controls
  also keep clear of the safe-area insets on every edge.
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

Settings sub-menus (Integrations and Camera and Recording) share a pattern: a row on the Settings hub
opens a sub-menu page. Its rows pass `state.from` for Back, and each destination has the sub-menu as
its fallback Back target for direct links and refreshes.
The Live page's theme button sits at the far right of the full-width bar, including at ≥1200px.
The bar stays navy in both themes, so the button uses fixed `--peri-soft`, not the changing
`--text-secondary`. It is compact in short landscape and keeps a 44px touch target.
Other pages and sub-pages have no header theme button; use Account → Appearance instead.
The back label uses up to about 35% of the bar, then ends with an ellipsis to leave room
for the page title. This width is estimated from phone screenshots, not measured on devices.

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
10px, `padding: 11px 12px`, **15px text**. iOS Safari zooms the page in when a field under 16px is
focused unless the viewport has `maximum-scale=1`, which is why an iOS browser keeps that token
when the app relaxes page zoom (#562, `lib/viewport.js`); 15 is safe there only because of it.
Expected from WebKit's behaviour, not checked on a device. `.field` has `margin-bottom: 14px`;
`.field-row` puts two side by side on a `1fr 1fr` grid.

**Focus is global and must not be removed:**
```css
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

### Switch
42 × 24 track, radius 999px; 18px thumb inset 3px, `translateX(18px)` when on; track goes `--peri`
when checked; transitions 0.16s. The real `<input>` is present but `opacity: 0` over the whole
control — keep it, it's what makes the switch keyboard- and screen-reader-accessible.

### Forms with a Save button: one model (#391, #377)

A screen with a **Save changes** button commits **only** when it is pressed, and that includes its
switches. A page must not mix a switch that writes at once with controls that wait: Recording did, and
someone could turn a feature off, leave, and believe it had stopped. The exceptions are screens that
declare the opposite for the whole page and have no Save button (the camera Motion / Sound / Schedule
screens, which save themselves and say **Saving… / Saved ✓**). The other exception is a photo, which saves
on its own the moment it is chosen (the child, caregiver and Account forms; owner decision on #384), and
Account has one more: its "Send motion alerts to this device" switch (app only) is a setting for the device,
not for the account, so it applies at once and the card says so, while the name and password forms beside it
wait for their own Save buttons.

While the screen differs from what is stored it shows `components/UnsavedNotice.jsx` ("Unsaved changes",
with **Discard changes**). The notice is derived from the data, so putting a value back removes it. What
is typed is kept for 6 hours in the browser tab (`lib/formDraft.js`) and restored after the app's
background reload or a visit to another screen, with the notice saying so; **a secret field is never
kept**, so a screen with a password must say, when it restores, that the password has to be typed again.

Covered today: the child form, the camera form, Settings → Camera and Recording → Recording, Settings → General, Settings → Integrations → MQTT, the Gotify, ntfy and
Pushover pages, and the add/edit caregiver screen. **Not covered** (they still lose unsaved edits on a reload):
the Firebase page (one switch), the caregiver list, the Account name form (two fields, and its values come
from the sign-in context), and Detection settings (no Save button; they recover through their own save queue,
`lib/detectionSaves.js`). A new Save-button form should join this, not invent another store.

What a covered form keeps is a per-form allow-list, and it is narrower than "everything not a password" on
purpose: the ntfy **topic** (the page itself calls it the only thing keeping a public feed private), the MQTT
**certificate text** (a free text box where a private key could be pasted) and any value holding a URL with
credentials in it (`https://user:pass@host`) are never kept, whatever the field is called, because the
credential-name check reads field names only. A screen that restores must say which of its fields are not kept.

### Badges, chips, status

- A protected clip uses a quiet lock badge with the accessible name **Protected** in list metadata.
  The player’s admin-only lock button uses **Protect this clip** / **Unprotect this clip** and a pressed state; disable Delete while protected.
- `.status-badge` — filled pill, 3px 10px, 12px/600, white text; `--ok` `--live`, `--bad`
  `--offline`, `--off` `--text-secondary`. `--sm` = 2px 8px / 11px.
- `.cam-badge` — **outlined** pill (colour + border, transparent fill), 11px/600. Filled = state,
  outlined = attribute.
- `.cam-chip` — `--peri` on a 12% `--peri` tint, for the child a camera belongs to.

### Breathing dot — the live indicator
14px box, 8px core + expanding ring. `--live` breathing at **3.6s** (calm, steady), `--accent`
at **1.4s** (connecting, urgent), `--offline` static with no ring. The tempo carries the meaning;
if you add a state, pick its tempo deliberately.

**Tile overlay states** (the text over a camera's video when it is not playing): *Connecting…*, *No signal*
(the camera or its stream is down), and *Streaming service unavailable. Your camera may still be online.* (the
server's own status check timed out, so the camera's state is unknown), the last as an icon, text and a Retry
button in `--text-secondary`, not `--offline` red, because it does not claim the camera is down. Its dot stays
on the amber "connecting" tempo and never turns red.

### Modal (`components/Modal.jsx`)
On phone widths a **sheet**, not a centred dialog: overlay `rgba(10, 13, 28, 0.7)`, card
`max-width: 440`, hugging the bottom edge (`placement="top"` for the top), rounded 20px on the inner
side only, title 18px, `✕` close button with `aria-label="Close"`.

**`wide` opts a modal into a desktop treatment**: at ≥1024px it becomes a centred dialog,
`max-width: min(1040px, 92vw)`, `max-height: 92vh`, 16px all round. Only the video player uses it — a
440px sheet wastes a desktop screen on a video, but a confirmation must stay narrow at any width. Don't
add `wide` to a modal that is mostly text or a short form.

**`dismissible={false}`** (default `true`) is for a dialog holding something that cannot be got back — today
only the one-time two-factor backup codes (#557). It drops the overlay-click close and the `✕`, so the caller's
own explicit button is the only way out. **Escape** honours it too: it closes an ordinary dialog and does nothing
in a non-dismissible one.

**Keyboard and screen reader (#376).** Every `Modal` does the same four things, so a caller does not have to:
focus moves to the first field or action (a child with `autoFocus`, or an element marked `data-autofocus`, wins;
the `✕` is chosen only if it is all there is); **Tab and Shift+Tab stay inside** the dialog; the rest of the page is
made `inert` while it is open (`aria-modal` only describes a dialog, it does not block the page behind it), which
leaves the page looking exactly as before; and on close **focus returns to the control that opened it**. When that
control is gone (a dialog that replaces another in the same step, like the two-factor set-up handing over to the
backup codes, or a button the dialog's action swapped for another), focus goes to the control that opened the
first dialog of the chain, then to the first control in the place where it was (#768); never to `<body>`, and never
to something behind a dialog that is still open, `hidden`, or `aria-hidden` (those are skipped, and the next place
up is tried). With a dialog over a dialog, Escape and Tab belong to the top one. Not done: scroll lock on the page behind, and the
tile's bottom-sheet menu, which is not a `Modal`. The inactive Live monitor is `inert` as well as `aria-hidden`,
so its buttons are not in the Tab order while another screen shows; it stays mounted, so streams and background
audio carry on.

Layout lives in **CSS** (`.modal-overlay` / `.modal-card`), not inline styles. That is load-bearing: a
media query cannot reach an inline style, and inline styles beat stylesheet rules, so the desktop rules
would silently lose. Only the two values the visual-viewport effect computes stay inline.

It sizes itself to `window.visualViewport` and scrolls internally so the on-screen keyboard can't
push a focused field out of view, and it pads for `env(safe-area-inset-top)`. Both behaviours were
bug fixes — preserve them.

**`error`** (optional string, default none; #378) is for the failure of the dialog's **own action**, such as
a Remove the server refused. It renders as an `.error-banner` with `role="alert"` **inside the card, under the
title**, and nothing at all when empty, so a caller that does not pass it is unchanged. Rule: **an error from
what a modal's button did goes in the modal.** A page-level banner sits in `<main>`, under the overlay, so the
person tapped Remove and saw nothing happen. Keep it as its own state (`removeError`, not the page's `error`),
clear it when the dialog opens and at the start of a confirm, and leave the dialog open with its button
re-enabled so the person can read it and retry or cancel. Errors from actions that are not in a modal still use
the page banner.

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

Picture-in-Picture hides every control and panel over the video, including Record. Fullscreen
in the updated Android app hides the system status and gesture bars so they do not cover the
controls. Older app builds still show those bars until the app is updated. Fullscreen controls
also stay clear of safe-area insets, including in a phone browser or home-screen install.

**Touch targets (#381).** Every control on a tile is tappable over **44px**, even though it draws smaller:
the seven over-video buttons (Mute, Talk, Record, Picture-in-Picture, PTZ, Settings, Fullscreen) are drawn
30px with a 20px icon and the drag handle 24px, and an invisible `::after` reaches 7px (10px for the handle)
past each edge to make up the difference. Two things follow for anyone adding a control: the button must be
`position: absolute` (or `relative`, as the handle is) for the `::after` to anchor to, and **neighbours must
be at least 14px apart** or their enlarged areas overlap and a tap lands on the wrong one. That is why the
three inner buttons (Record, Picture-in-Picture, PTZ) sit 54px from the edge, not the 48px they used to: the
visible change is 6px more space between those pairs. The icons did not change size.

**Keyboard reorder (#381).** Focus a camera tile's reorder handle. Press Space or Enter to pick it up,
use the arrow keys to move it, then press Space or Enter to place it. Press Escape to cancel. The handle
keeps the global focus ring, and screen readers hear the camera's name and its position among the tiles
shown on the grid. A disabled camera stays in the saved order but is not counted in that spoken position.

### Not-found page (`pages/NotFound.jsx`, #379)
The last route in the shell's route table (`path="*"`), so an address that matches no screen shows the app
chrome around a short page instead of a blank one: header **"Page not found"**, one sentence, and a
**"Go to Live"** button. No back link (it has no parent; the header logo and the nav both lead home).
It is deliberately small: it does **not** tell "no such child or camera" from "still loading" for a real
route with a missing id (that is #375), and an address that matches a *pattern* route with an unknown last
segment, such as `/cameras/<id>/<unknown>`, still lands on that route's screen, not here.

### Loading, failed and empty are three different screens (#375)
A list that comes from the server can be in one of these states, and each says something different. Never let
one stand in for another: "No children yet" next to an outage tells a parent their setup is gone.

| State | What the screen shows | Setup actions ("Add child", "+ Add camera") |
|---|---|---|
| **Loading** (nothing has answered yet) | A plain "Loading…" line. Not the empty copy, not an error. | Hidden |
| **Failed** (the request failed and there is no list to keep) | An inline message with a **Retry** button (`components/LoadFailed.jsx`): what could not load, the cause, and "Check your connection, then try again." Not the empty copy. Never `alert()` or `confirm()`. | Hidden |
| **Stale** (a refresh failed after a good load) | The last list stays, with a "Couldn't refresh … Showing what we had." message and **Retry** above it. | As for a normal list |
| **Empty** (a request succeeded and returned none) | The screen's own empty copy. | Shown (to those allowed to use them) |

`lib/loadState.js` makes the call: `loadState({ loaded, error, count })` returns `loading`, `error`, `stale`,
`empty` or `ready`. `loaded` means a request has **succeeded** at least once (not that one has finished), which
is why `CamerasContext` publishes it next to `error`. A failure after a good load of an **empty** list is `error`,
not `stale`: there is no list on screen to keep, and the empty copy would be unverifiable. Keep the failure apart
from the data: a catch block that sets the data to `[]` or `null` puts the failed state back into the empty one.

Covered: Children, Cameras, Live, a child's alerts and unknown-child page, Sleep detail, Settings → Camera and Recording → Clip management.
Not yet: Logs (a failed fetch shows its error banner above "No log activity yet", the same conflation), Camera
events and Recent alerts (they show their error and hide the empty copy, but have only "Refresh now", not
**Retry**), and the Night review, Timelapse, Recordings and sensor cards.

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
- **Times are home time.** Format every time through `lib/homeTime.js` / `useHomeTime()` (the zone is
  `settings.timezone`), never `toLocaleString()` or `getHours()` on the device. When the device is in a
  different zone the formatter appends the short zone name ("7:00 pm GMT-7") as plain text in the same run
  as the time — no badge, no separate colour; when it is the same zone there is nothing to add. Locale and
  12/24-hour stay the device's own (#561).
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
