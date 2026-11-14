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

## 1. Brand colour

One periwinkle ("peri") identifies actions and navigation. By day it is `#5663D6`; at night it is the lighter
`#8995FF` (the owner's choice, 2026-11-06; it was a violet, `#7C5CD6`, before 2026-11-05). The logo's crescent is its
own colour, `#778FFD` (the owner, 2026-11-06), lighter than the day accent. The two themes need different text on a peri fill, which sets the rules:

- `--accent` is for **fills**: buttons, the active segment, switches' tracks, selected chips. Text **on** a peri fill is
  always `--on-accent`, never a literal colour: **white by day** (5.06:1 on `#5663D6`) and the header navy `#14142A`
  **at night** (6.71:1 on `#8995FF`). The other pairings fail WCAG's 4.5:1: navy on `#5663D6` is 3.57:1, white on
  `#8995FF` is 2.69:1.
- **Lines, rings and icons** use `--accent-line` (the same colour as `--accent` in both themes today; the separate
  token is there because they have a lower, 3:1 target and may diverge): focus rings, selected borders, row icons, chevrons.
- **Small text** (links, "Saved ✓") uses `--accent-text`: a deeper periwinkle by day, a lighter tint at night.
- The header uses the same navy (`--bar`, `#14142A`) in both themes.
- The **complement** (`--complement`, a warm gold; peri's opposite) is for small highlights only: the current step in
  the setup progress bar, the "Recommended" badge (`status-badge--highlight`, dark text on gold) and the border of the
  avatar's camera badge. Not buttons, tabs or links. The gold border is decoration (1.65:1 on a day card): the badge's
  own fill and its icon carry the meaning.

The page and card surfaces (`--bg`, `--bg-elevated-2`, `--border`, `--field-bg`) are the **original navy and lavender
neutrals** (owner, 2026-11-13: the navy background is wanted). A warm-grey trial on 2026-11-12 was rejected; what it
added and the owner kept are the **accent colours**: the score band colours and the retuned timeline colours below,
re-measured on the navy surfaces (design v3). Periwinkle marks **actions and navigation only**, and the gold complement
stays a small highlight; neither is a surface colour.

---

## 2. Themes

`lib/theme.js` resolves the device choice (`light`, `dark`, or `system`) and stamps
`data-theme` on `<html>`. The Live header has a moon button to switch to night
and a sun button to switch to day. Account → Appearance keeps the three-way
Light / Dark / System choice. This preference stays on each device.

### Tokens

These are the owner's approximate day/night palette, grouped at the top of
`frontend/src/index.css` for later adjustment.

| Token | Day | Night | Use |
|---|---|---|---|
| `--bg` | `#F7F4FD` | `#14142A` | Page |
| `--bg-elevated` | `#FFFFFF` | `#221F3C` | Cards |
| `--bg-elevated-2` | `#EAE3F8` | `#100F1C` | Insets |
| `--text-primary` | `#1D1A3A` | `#E8E2F7` | Main text |
| `--text-secondary` | `#625C7F` | `#BCB3D5` | Supporting text |
| `--accent` | `#5663D6` | `#8995FF` | Fills: buttons, active segments, selected chips |
| `--on-accent` | `#FFFFFF` | `#14142A` | Text on an `--accent` fill |
| `--accent-line` | `#5663D6` | `#8995FF` | Focus rings, selected borders, icons and chevrons |
| `--accent-text` | `#4A55C8` | `#A7B1FF` | Small linked text |
| `--accent-soft` | `#D3D8FF` | `#C5CBFF` | Header controls and subtle accents |
| `--complement` | `#F2C14E` | `#F6D365` | Small highlights only (see section 1) |
| `--on-complement` | `#14142A` | `#14142A` | Text on a `--complement` fill |
| `--bar` | `#14142A` | `#14142A` | Header |
| `--bar-text` | `#E8E2F7` | `#E8E2F7` | Header title |
| `--live` | `#23734F` | `#8BDBAD` | Live status |
| `--offline` | `#AA3F54` | `#F4A3AD` | Offline / destructive |
| `--border` | `#DDD5EE` | `#383450` | Borders |
| `--field-bg` | `#EAE3F8` | `#100F1C` | Inputs |

Measured with the WCAG formula (2026-11-13, design v3). Text: `--text-primary` is 16.65:1 on a day card, 15.31:1 on the page
and 13.35:1 on an inset; at night 12.53:1 on a card, 14.32:1 on the page and 15.04:1 on an inset. `--text-secondary` is
6.26:1, 5.75:1 and 5.02:1 by day (the inset is its tightest surface) and 7.93:1, 9.07:1 and 9.53:1 at night. Accent:
`--on-accent` on `--accent` is 5.06:1 by day (white on `#5663D6`) and 6.71:1 at night (navy on `#8995FF`). By day
`--accent-text` (`#4A55C8`) is 6.13:1 on white cards, 5.64:1 on the page and 4.92:1 on inset fields (plain `#5663D6` would
only reach 4.06:1 on an inset, which is why the text token is deeper); at night `#A7B1FF` is 7.81:1 on cards, 8.92:1 on the
page and 9.37:1 on insets. `--accent-line` is 5.06:1 on white and 4.65:1 on the page by day (3:1 is the non-text target),
and 5.87:1 on night cards. `--on-complement` on `--complement` is 10.76:1 by day and 12.40:1 at night. The header's text
(`#E8E2F7`) is 14.32:1 on `--bar` and its controls (`--accent-soft`) 12.93:1. The logo's crescent on its `#14142A` ground is
6.13:1 (a graphic needs 3:1). Night live and offline text have 9.65:1 and 8.04:1 on cards; by day they have 5.77:1 and
5.92:1 on white cards. These clear WCAG's 4.5:1 normal-text target. A new accent use must pick its token by what it is
(fill, text on a fill, line, small text). `test/paletteTokens.test.jsx` recomputes these ratios from the stylesheet's own
token values and fails if a colour change makes any of them too low, if white or near-white text lands on an `--accent`
fill, if a focus ring uses plain `--accent`, or if the logo's fill stops being `#778FFD`. It also checks the band colours,
the timeline colours and the night-card text below, and **names the pairs that are known to sit below their floor** (see
"Known pairs below their floor").

The header colour is repeated in `index.html`'s `theme-color` meta (`#14142A`), which tints the phone's browser chrome; the
manifest's `theme_color` and `background_color` and the app icons' ground are the same navy.

### Search card and item cards (#1074, #1076)

ESPHome and Cameras use one `.night.find-card` search surface: **Find devices** or **Find cameras**. The search button is its main action; the card's error line uses `--night-error` (`#F4A3AD`) on the lightest gradient stop (`#2C2F63`) to stay above 4.5:1 contrast. Results are 56px rows with wrapping names and full-opacity unavailable states labelled **Added** or **Not added**. The manual action appears inside the card after an empty search. It reads **Add by IP address** for ESPHome and **Add a camera manually** for cameras. The camera's manual disclosure row remains below the card.

Saved ESPHome devices and cameras share `.dev-card`: a status dot and word, wrapping name, muted address, optional detail lines, and a 44px **⋯** action menu. ESPHome keeps Edit, Test connection, Download CSV and Delete device, plus a separate **Sensors** disclosure. Camera cards show only supported capability chips, a Motion/Sound line when available, and a visible **Assigned to** foot row. The camera menu holds Edit camera, Enable/Disable camera and Remove camera. A disabled camera has a neutral dot; an unknown status keeps the amber connecting dot. The camera list's Remove dialog gives the full permanent-deletion warning.

### Edit camera in groups, and the navigation row (#1076)

`components/CameraForm.jsx` (Edit camera, and the manual card on Add camera and in the setup guide) is four groups, each a `.section-title` over a `.card`: **Camera** (name; address and RTSP port on a `2fr 1fr` grid; username and password on a `1fr 1fr` grid that stacks below 360px; a quiet **Fetch from ONVIF** button with one hint sentence), **Assigned to** (the **Child (optional)** select), **Detection** (existing camera only; three navigation rows, then the read-only recording summary) and a collapsed **Advanced** row. Every control sits inside a `.field`: the page's field look is `.field input` / `.field select`, so a bare `<select>` or `<input>` outside one renders as a browser default (the Cameras list's "Assigned to" select shipped that way). Inputs in these cards are 44px tall.

**Advanced** is a button with `aria-expanded` that mounts its fields (stream path, low-quality path, two-way audio, MQTT topic) only while open, so a closed row leaves nothing for a keyboard to land on. It is closed for a saved camera, and opens by itself in three cases: a new or embedded form whose stream path is empty; the first save error, Save-anyway question or ONVIF failure shown (those messages name no field, so the likely ones are exposed and nothing is focused); and a restored draft holding a value inside it. The person can close it again; it does not reopen for the same message.

**`NavRow`** (`components/NavRow.jsx`) is the 56px "go deeper" row: icon chip, label, optional sub line, the current value and a chevron. It is a real `<button type="button">` (or a `<Link>` given `to`), so Enter and Space come from the browser; its accessible name is the visible label followed by the value ("Motion detection On"). Hover is pointer-only and the focus ring is `--accent-line`. It replaced `DetectionRow`; `.det-row` stays only for the recording summary.

**Remove camera** is the one item of the header **⋯** menu (`MoreMenu` through `AppHeader`'s `actions`), shown to an admin on a saved camera. There is no red button under Save. It opens the same `RemoveCameraDialog` as the Cameras list.

### Child hero card (`.night`)

One fixed navy gradient in both themes: `linear-gradient(165deg, #2C2F63 0%, #191B38 100%)`, so its text colours are
literals, held as four custom properties on `.night` (`--night-text` `#EEF0FF`, `--night-muted` `#B9BDF0`, `--night-link`
`#C7CAFF`, `--night-number` white) plus `--night-divider` (white at 10%) so no rule below repeats a hex. Measured on the
gradient's lightest stop (`#2C2F63`), where contrast is lowest: `--night-text` 10.95:1, `--night-muted` 6.85:1 (5.07:1 or
more at the corner the ring's 12% band wash lightens, per the design), `--night-link` 7.86:1 (small text needs 4.5:1).
Everything secondary on the card (the age, the label, the "asleep" unit) is `--night-muted`; the settings gear, the chevron and
the quiet birthday line use `--night-link`. The score ring's colours on this card are in "Score ring" below.

**What the card holds (UI refresh PR C, 2026-11-13).** Top to bottom, one card, nothing else:
1. **Identity row**: the avatar (64px, with a small camera badge: it is the way to set the photo, and goes to child settings when
   there is none), the name, the age (the line is left out when there is no birthday: there is no "Tap to add birthday & photo"
   any more), and one **settings gear** (44px, named "Settings for <name>") that opens child settings.
2. A hairline, then the **sleep row**, one button into the sleep page: a "Last night" label with a small moon (or "Tonight · so
   far"), the duration in 28px ("9h 40m" with a smaller "asleep"), **one ring** (72px, band word under the number: "82 / Good",
   "Early" for an early estimate, no word under the lowest band) and a chevron. Under the row, **one headline line**
   (`.night__headline`, 15px bold, **wraps** to a second line on a narrow phone rather than ending in an ellipsis). No time range, no wake-up count, no longest stretch, no "In bed" line, no
   bullet list and no estimate note: they are all on the sleep page, one tap away. The button's name still carries the headline and
   the score ("View sleep detail and history. A fairly steady night overall. Sleep score 82, Good").
3. Under the sleep row, a quiet "Add a birthday in settings to see a score sooner" line, only when a night has no score for want of a birthday.
4. A hairline, then the **morning question** (`components/MorningReviewCard.jsx`) while a night is waiting to be reviewed: "Up at
   6:20 AM. Is that right?" with two 44px buttons, **That's right** (the card's own periwinkle, `--night-action` with
   `--night-on-action` text, which are NOT the theme's `--accent` pair because this card is the same navy in both themes) and
   **Not quite** (an outline). It is asked once, here; there is no separate review card below the hero. Answered, it becomes a
   one-line receipt ("Thanks — that's recorded / You said up at 6:20 AM. Tap to change it.") in the same place. A small dismiss
   (44px hit area) is kept at the question's right edge, as on the old card. While the app's settings are still loading the
   question is not drawn (no time is shown in a guessed timezone); if the settings request failed, the card shows "Was last night
   right? Tap to check the times." with one **Check the times** button into the review screen and no way to save from the card.

States without a score (tracking off, loading, no data, no clear sleep, an empty bed) keep their wording and show no ring.
Colour is never the only signal: the band word and the number are drawn, and the button's name says both.

### Band colours

Five score bands get colours so the ring, the nights strip and the breakdown bars can show how a night went at a glance.
The tokens are `--band-*` in `index.css`. Today the score ring (see "Score ring"), the seven-night strip's bars, the
line under the sleep page's header and the "Why this score?" sheet's factor bars use them. **A colour is never the only signal** (the
band word and the number always show) and **text is never set in a band colour**: they are marks (rings, bars, dots) only.

| Band | `--band-*` by day (card / inset) | `--band-*` at night (card / inset) | `--band-*-ring` on the night card (card / track) |
|---|---|---|---|
| great | `#1E6B3D` 6.51 / 5.22 | `#A8EDBE` 11.68 / 14.02 | `#A8EDBE` 9.16 / 11.37 |
| good | `#0F555C` 8.49 / 6.81 | `#5CBFC6` 7.31 / 8.78 | `#5CBFC6` 5.74 / 7.12 |
| fair | `#A36A10` 4.54 / 3.64 | `#D99C50` 6.64 / 7.97 | `#D99C50` 5.21 / 6.46 |
| low | `#B85A7E` 4.37 / 3.51 | `#C77790` 4.87 / 5.84 | `#C77790` 3.82 / 4.74 |
| early estimate | `#7A7496` 4.41 / 3.53 | `#D3CDE6` 10.27 / 12.32 | `#D3CDE6` 8.06 / 10.00 |

Marks need 3:1 (a graphic), and every pair above clears it; the weakest are the day early-estimate bar on the inset
(3.53:1), the day rose on the inset (3.51:1) and the night-card rose (3.82:1 on the bare gradient, 3.27:1 with the 12% tint
the design lays over the card). The ring variants do not switch with the theme because the `.night` card does not. Three
day marks and the early-estimate neutral moved from the 2026-11-12 warm trial, for the navy surfaces: good `#126067` to
`#0F555C` (so it stays apart from the rose under protanopia), low `#C4688A` to `#B85A7E` (it fell to 2.96:1 on the
lavender track, under the 3:1 floor), early `#6B6158` to `#7A7496` by day and beige `#CCC3B8` to lavender `#D3CDE6` at night
(beige on navy looked like a dirty highlight). Swapping the rose for a quieter hue later is a token change.
`test/paletteTokens.test.jsx` recomputes all three columns from the stylesheet.

**The ring's own track.** The second figure above is the inset the bars will use; on a themed card the ring's track is
`--border`, so the test also measures each arc against that, and against the card, at 3:1. Every band clears both in both
themes. The weakest on the track are by day: rose `#B85A7E` on `#DDD5EE` 3.09:1, early estimate `#7A7496` 3.11:1, fair `#A36A10`
3.20:1 (the warm trial's rose was 2.72:1 there and was fixed by the navy re-tune above, not excused). Should a later palette
change drop a pair under 3:1 again, name it with its real ratio next to this paragraph and in the test, rather than lowering the floor.

### Sleep timeline colours

The timeline tokens (`--sleep-*`) are categorical data colours; keep them separate from branding. Asleep is
`#4B53B5` by day and `#7C85E6` at night, stirring `#7279C6` by day and `#A7ADE4` at night (design v3.1; v3 had `#A7ADE4`
and the dim indigo `#4A4F86`), awake (the "before or after sleep" segment) the original lavender `#D2D0E2` / `#3C3F60`, the
wake-up amber `#F0A257` / `#F6C899`, and room activity the teal `#279189` in both themes (v3: `#2FA39A`; before that
`#3EC4B8` at night, which had the same lightness as the Good band's `#5CBFC6` and could not be told from it). The
v3.1 teal is darker so that by day it clears 3:1 on the card (3.82:1) and on the lavender track (3.06:1). Amber by day is
only 2.10:1 on a card, so where the colour is **text** (a duration, a badge, an icon) the rule uses `--sleep-wake-text`
(`#9A5410` by day, 5.75:1 on a card, 4.61:1 on an inset); the segment keeps the lighter amber. Room-activity teal is
3.82:1 on a day card, so its text (a duration, the "Movement outside the bed" tag, the "refined" label) uses
`--sleep-visit-text`: `#17706A` by day (5.90:1 on a card, 4.97:1 on its own tag) and the brighter `#3EC4B8` at night
(7.37:1 on a card, 6.17:1 on its tag; `#279189` itself would be 3.46:1 on the tag); the dots and legend swatch keep
`#279189`. The design also has a dashed "still to come" / "not counted" edge (`#8C86AE` at night, 4.62:1 on the card);
there is no token for it yet because nothing draws it.

**The states are told apart by shape and gaps, not by colour alone (design v3.1, 2026-11-13).** Several neighbouring colours
are close in lightness (the table below), so each state also has its own silhouette:

| State | Shape on the bar | Gaps |
|---|---|---|
| Asleep | The full-height bar (30px). | A 2px track-coloured edge only where it touches a wide stirring block (both themes) or awake (night only). |
| Stirring | A wide run is a **half-height** block: 14px, centred. A short run is a quiet 6px dash drawn on the asleep colour (no pale sliver beside it). Both have a 3px minimum width. | 2px of the track colour on each side only for a wide run. |
| Awake (the amber segment) | **Rises 5px above the bar**: 33px tall from 5px above the top, 3px minimum width, 1px top corners. | At night, 2px of the track colour on each side (`--sleep-wake-gap`); by day none (the old 1px white separators are gone). |
| Before/after sleep, No data | Full height, as before; "No data" stays hatched. | None. |
| Room activity | A ring above the bar, 20px up (the bar's wrapper reserves 22px so nothing clips; 6px when there is none, for the awake rise). | n/a |

Stirs separated by less than three asleep minutes join into one block for drawing only. The original segments still
drive the hover time and status, and the reported counts do not change. A lone one-minute stir, or a drawn run under
8px wide at the current screen size, uses the quiet dash without side gaps: there is too little space for both a
block and readable gaps.
The drawing segments keep their total width in the row (so the onset and wake marks stay exact)
and are drawn centred on that slot, so a one-minute stir is still 3px wide without pushing the rest along. The bar no
longer clips (awake rises out of it); the first and last segments round their own outer corners, and a stirring or awake block that
is first or last in the row is anchored to that edge so it never paints outside the bar. Tiny neighbouring blocks (one-minute
segments are about half a pixel wide on a phone) can overlap; the later one in the row is drawn on top, which can hide a
one-minute stirring block next to it but never asleep, the before/after segment or an awake block, which are taller. The
onset, wake and "now" marks are the bar's 30px height (they were declared taller but clipped to that before). The legend swatches match: stirring a
flat 14x5 block, awake a 4x14 tick. **Day awake against the white card stays 2.10:1 on purpose**: a darker amber would sit
next to the Fair band's amber and look the same to a colour-blind reader, and the rise above the bar is what carries it.

The card is titled **Timeline**. Its legend lists only states and markers present in that night. The next card has a
two-segment **Wake-ups · count** / **Room activity · count** tab control. Wake-ups is selected first unless it is empty
and room activity has rows. Each tab keeps its own rows and quiet empty line; arrow keys and Home/End move between tabs.
The Wake-ups count follows the summary's wake-up figure: the server's standalone morning-wake row is listed last as
**Up for the day** (with its clip and alerts, if any) and is not counted.

Nothing on the timeline may poke past the card's content box (owner, on a real phone, 2026-11-13). The first hour label is
left-aligned to the bar's left edge and the last right-aligned to its right edge (the rest are centred), and the room-activity
rings and the into/out-of-bed triangles are positioned with `clamp()` so a marker at the very start or end sits fully inside
the bar and still points at its minute as nearly as it can (`lib/timelineEdges.js`).

#### Known pairs below their floor

These pairs are below 3:1 and are accepted (design v3.1, 2026-11-13). Each is two data colours next to each other, or a segment on its surface, never
text, and each is told apart by shape (see above), position, order or a label as well as by colour. `test/paletteTokens.test.jsx` names them
and fails if one stops being true, so a fix is noticed rather than silently left in the list.

| Pair | Ratio | Why it is accepted |
|---|---|---|
| Night: wake-up amber `#F6C899` against asleep `#7C85E6` | 2.15 | Neighbouring segments; the awake block rises above the bar and has 2px gaps at night, and the segment order carries it. |
| Night: stirring `#A7ADE4` against asleep `#7C85E6` | 1.53 | Worse than v3 (2.31): the same colour pair the 2026-11-12 trial dropped. Told apart by shape instead: a short dash or half-height block against the full-height bar, with gaps when wide enough. |
| Day: stirring `#7279C6` against asleep `#4B53B5` | 1.64 | New with v3.1 (stirring was a pale lavender, which cleared this pair). Same: a short dash or half-height block, with gaps when wide enough. |
| Day: stirring `#7279C6` against the wake-up amber `#F0A257` | 1.90 | Close in lightness, different hue; the stirring block is half height and the amber block rises above the bar (v3: 1.03 with the pale lavender). |
| Night: stirring `#A7ADE4` against the wake-up amber `#F6C899` | 1.40 | New with v3.1. The two are told apart by shape: stirring is half height, awake rises above the bar, and awake has gaps at night. |
| Day: stirring `#7279C6` against the before/after-sleep segment `#D2D0E2` | 2.63 | Two neighbours; the stirring block is half height with gaps, the other is the faint full-height segment. |
| Day: wake-up amber `#F0A257` against the white card | 2.10 | Deliberate and kept (see above). The amber is a segment and a dot, never text (its text is `--sleep-wake-text`, 5.75:1). |
| Day: wake-up amber `#F0A257` against the inset track `#EAE3F8` | 1.68 | A segment on the track it is drawn on; told apart by hue and by rising above the bar. |
| Day: before/after-sleep segment `#D2D0E2` against the inset track `#EAE3F8` | 1.22 | A deliberately faint "nothing counted here" segment (it was already this faint before the 2026-11-12 trial). |
| Night: before/after-sleep segment `#3C3F60` against the inset track `#100F1C` | 1.87 | Same. |
| Day: before/after-sleep segment `#D2D0E2` against the white card | 1.52 | The segment is drawn on the inset track, not on the card; listed because the bar's ends meet the card. |
| Night: before/after-sleep segment `#3C3F60` against the card `#221F3C` | 1.56 | Same. |
| Day: wake-up amber `#F0A257` against the before/after-sleep segment `#D2D0E2` | 1.38 | Same as the amber above: told apart by hue and by the rise above the bar. |
| Day: "No data" hatch `#C7C7C7` against the white card / the inset track `#EAE3F8` | 1.69 / 1.36 | The hatch is its own pattern (stripes of `#C7C7C7` on the track colour), so it reads by its diagonal stripes, not its lightness; against the track it is the pattern's own two stripes. Unchanged by v3.1; found missing from this table in review. |
| Day: "No data" hatch `#C7C7C7` against stirring `#7279C6` / amber `#F0A257` / before-after `#D2D0E2` | 2.36 / 1.24 / 1.12 | Same: the stripes, not the colour, mark missing data. |
| Night: "No data" hatch `#5A5C6E` against the card `#221F3C` / the inset track `#100F1C` | 2.40 / 2.88 | Same. |
| Night: "No data" hatch `#5A5C6E` against asleep `#7C85E6` / before-after `#3C3F60` | 1.99 / 1.54 | Same. |

One more pair sits under 3:1 and is named in the same test file, in its own block (it is not a timeline colour): the **Wake-ups | Room
activity tab control**'s selected pill fill against its track, 1.22 by day and 1.31 at night. It is not what marks the selected tab: the
3px `--accent-line` indicator is (3.54 and 3.69 against the pill, 4.31 and 4.83 against the track, both clearing 3:1), with the bolder,
darker label as a second cue. The test fails if the indicator drops under 3:1 or the fill pair stops being what is documented.

What v3.1 cleared and removed from this table: stirring against the card and the inset track in both themes (day 3.99 and
3.20, night 7.33 and 8.80), room activity against the day track (2.47 to 3.06), and night stirring against the
before/after-sleep segment (1.33 to 4.70). What it made worse or added is in the rows above and is named, not hidden.

The test enumerates every pair of bar segments (asleep, stirring, awake, before/after sleep and the "No data" hatch) and every
segment or room-activity dot on the card and the inset track, so this table is complete for those (the "No data" hatch was
missing until the review of the v3.1 change; the grouped rows above name nine pairs): a pair under 3:1 that is not named fails it. (Room activity is a dot drawn above the bar, so it is
measured against the surfaces only.) All are graphics, never text. The shapes and gaps themselves are CSS and are checked by
eye on a real render (the screenshots in the change that introduced them), not pinned as pixel values in a test.

The Settings API still accepts and returns `accent_color`, `live_color`,
`offline_color`, and `font_choice` for older clients. This web UI ignores
those stored values and Settings → General no longer edits them. The app
name, timezone and temperature unit remain editable.

---

## 3. Typography

Inter is the body face at weights 400, 500, 600 and 700. Nunito ExtraBold
(800) is the wordmark and page-heading face, including `h1`–`h3`.
Small uppercase `.section-title` labels stay Inter. `--font-mono` remains
the system mono stack for IDs and logs.

Both fonts ship as local `@fontsource` latin assets imported from `main.jsx`.
Vite emits them under its own assets path, so the LAN PWA works without
Google Fonts, a CDN, or a CSP exception.

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
| `favicon-32.png` | 32 × 32, transparent rounded corners | Browser tab (a copy of the website's favicon; not generated, see below) | `index.html` |
| `apple-touch-icon.png` | 180 × 180 | iOS home screen | `index.html` |
| `icon-192.png` | 192 × 192 | App icon (home screen, install prompt); not used in the app screens any more | direct reference |
| `icon-512.png` | 512 × 512 | High-DPI app icon (the Unraid template points at it) | direct reference |
| `icon-maskable-192.png` | 192 × 192 | PWA install + Android launcher | `manifest.webmanifest` |
| `icon-maskable-512.png` | 512 × 512 | PWA splash / high-DPI launcher | `manifest.webmanifest` |
| `now-playing-512.png` | 512 × 512 | Media-session artwork (lock screen) | `useNowPlaying.js` |

Run `node frontend/scripts/make-icons.mjs` after replacing the 1024 × 1024
`frontend/branding/logo-source.png`. The script uses Python Pillow
(`python -m pip install Pillow`) and regenerates six of the seven icons together.
`favicon-32.png` is the exception (owner, 2026-11-10): it is a copy of the website's rounded `nightlight-website/assets/favicon.png`
so the two match; re-copy it there when the logo changes. Maskable icons place the
artwork within the central 80% on navy so launchers can crop the edges.
Bump the `now-playing-512.png?v=` value in `useNowPlaying.js` after changing
that image.

The manifest lists the maskable pair with `purpose: 'any maskable'`.
The HTML and manifest browser colours both use `#14142A` to match `--bar`.

**The logo in the app** (header, setup guide, About, sign-in) is not one of these PNGs. It is the SVG
`public/icons/nightlight-logo.svg` (the owner's periwinkle crescent and sleeping baby, transparent ground), drawn
by `components/Logo.jsx`: bare in the header (the bar already is `--bar`, `#14142A`), and everywhere else on a
`--bar` rounded square with a corner radius of 25% of its size, so the setup guide, About, sign-in and "Can't
reach" screens show the same tile. The PNGs above are made from the same SVG on `#14142A`
(`branding/logo-source.png` is that 1024px render; the standard icons are opaque full-bleed squares, and the OS
rounds them).

**The setup screens have no header** (the Welcome and Create-your-account screens, then the guide). On a phone,
`html.setup-wizard` (set by `lib/useSetupChrome.js`) draws a navy `--bar` strip exactly as tall as the status bar and
nothing else, because the phone draws its status-bar icons light and the page colour hid them by day; on a computer
the strip has no height. The counter is "Step n of 7": Create your account is Step 1, the Welcome screen is not
numbered, and the review page is not counted. The avatar in the account and caregiver forms is centred, with Remove
under it.

---

## 5. Layout, spacing, radius

### Camera detection screens (#1076)

Motion, Sound and Alert schedule use the same card order: a 56px switch row, trigger settings,
Timing where relevant, extras where relevant, then Recording where relevant. The switch-off
message replaces the later cards. Each settings card has a visible 16px `h2` title. Motion's
source selector uses the local `.seg-track` and `.seg-track__btn` rules, with `aria-pressed` on
each button; the shared `.segmented` control elsewhere keeps its existing look. Sound's first
detector limit is visible, while the other four and the longer Timing note use separate
44px disclosures. The fields remain inside `.field`, and calibration retains its live status.

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
- `.app-shell` reserves `padding-bottom: 64px` **plus `env(safe-area-inset-bottom)`** for the bottom nav (the nav pads by the inset, so the page must too; without it the last line of a page, the sleep page's estimate line, was clipped on a phone with a gesture bar).

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
The bar stays navy in both themes, so the button uses `--accent-soft`, not the changing
`--text-secondary`. It is compact in short landscape and keeps a 44px touch target.
Other pages and sub-pages have no header theme button; use Account → Appearance instead.
The back label uses up to about 35% of the bar, then ends with an ellipsis to leave room
for the page title. This width is estimated from phone screenshots, not measured on devices.

### A read-only detail card (title, badge, sub-heading, value)
For a card that only reports something (Settings → About → Connection, and the Remote Access card it mirrors), use the Remote
Access card's look: a 16px/800 title with a `.status-badge` on the right, a 14px/700 sub-heading, the value in
`.tailscale-address` (15px/600, wraps anywhere), and, only when there is something to explain, a muted `.tailscale-hint` line under it. In CSS the About cards are
`.about-card`, grouped with `.tailscale-card` so the two change together. Every card on the About page (Connection, Links,
Support the project, Not a safety device) uses it: a 16px/800 title, 14px text, so the page reads as one set. So do the four
cards inside Remote Access → "Use your own domain or port forward (advanced)" (owner, 2026-11-10: the small grey title over
larger body text read upside down). The
sub-heading on About is set in Inter (owner, 2026-11-07), an exception to "`h1`–`h3` are Nunito" in section 3; only the card
titles stay Nunito there. The Remote Access card's sub-heading is still Nunito. Two layouts were tried and dropped (owner,
2026-11-07): a 16px label and a small value on one `.list-row` (on a phone the label wrapped and a long address broke mid-word),
and a 12px label over each value (it looked unlike every other card). Spacing and look are checked on a phone, not by a test.

### Buttons
`.btn` — inline-flex, `gap: 6px`, radius 10px, `padding: 12px 18px`, 14px/600, and **`width: 100%`
by default** (mobile-first: buttons are full-width unless constrained).

| Variant | Style | Use |
|---|---|---|
| `.btn-primary` | `--accent` bg, white text | The one main action per screen |
| `.btn-peri` | `--accent` bg, white text | Filled secondary action |
| `.btn-secondary` | transparent, `--border` outline | Everything secondary |
| `.btn-danger` | transparent, `--offline` outline + text | Destructive — outlined, never filled |
| `.btn-sm` | `padding: 6px 14px`, 12.5px, `nowrap` | In a row |
| `.btn-block` | full-width block | Explicit full width |

`:disabled` → `opacity: 0.55`. `.icon-btn` is the bare icon button: no background/border,
`--text-secondary`, `padding: 6px 8px`; `.icon-btn--danger` recolours to `--offline`.

`.btn-primary` uses `--on-accent` on the peri accent: white by day (5.06:1), navy at night (6.71:1).

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
42 × 24 track, radius 999px; 18px thumb inset 3px, `translateX(18px)` when on; track goes `--accent`
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

### Avatar editor (`components/AvatarEditor.jsx`)

Where someone changes a photo (the child's settings, your own Account, an admin editing a caregiver) the avatar is the control: the round photo, or the
initials on their colour, with a small camera badge at its bottom-right, and a tap opens the file picker. The badge is a
rounded square in the card colour with a complement (gold) border and a 16px-scale camera icon (`Camera`, sized from the avatar);
it is decoration (`aria-hidden`), and the invisible file input that covers the avatar carries the name "Add photo" / "Change photo".
The component is only the picker: resizing, saving, the Saving / Saved text and the Remove button stay with the page, since a
child's photo and your own go to different endpoints and a new child holds its photo until its first save. Avatars that are only
shown (lists, headers, the Settings row) stay the plain `Avatar` with no badge. Keyboard focus draws one ring around the whole
avatar (`:focus-visible` only); a click or tap draws nothing, since a second box around the badge looked wrong on the owner's phone.

### Badges, chips, status

- A protected clip uses a quiet lock badge with the accessible name **Protected** in list metadata.
  The player’s admin-only lock button uses **Protect this clip** / **Unprotect this clip** and a pressed state; disable Delete while protected.
- `.status-badge` — filled pill, 3px 10px, 12px/600, white text; `--ok` `--live`, `--bad`
  `--offline`, `--off` `--text-secondary`. `--sm` = 2px 8px / 11px.
- `.cam-badge` — **outlined** pill (colour + border, transparent fill), 11px/600. Filled = state,
  outlined = attribute.

### Breathing dot — the live indicator
14px box, 8px core + expanding ring. `--live` breathing at **3.6s** (calm, steady), `--accent`
at **1.4s** (connecting, urgent), `--offline` static with no ring. The tempo carries the meaning;
if you add a state, pick its tempo deliberately.

**Tile overlay states** (the text over a camera's video when it is not playing): *Connecting…*, *No signal*
(the camera or its stream is down), and *Streaming service unavailable. Your camera may still be online.* (the
server's own status check timed out, so the camera's state is unknown), the last as an icon, text and a Retry
button in `--text-secondary`, not `--offline` red, because it does not claim the camera is down. Its dot stays
on the amber "connecting" tempo and never turns red.

### Score ring (`components/ScoreRing.jsx`)
The sleep score as a ring with the number in the middle: an inline SVG arc filled to the score out of 100. **The arc is
coloured by band** (owner approved the colour-scaled design, 2026-11-12; it was one colour before, out of caution that a
red or green ring reads as a verdict) and there is **no animation** (section 7). The band comes from `bandOf(score)` in
`lib/sleepScoreText.js` and is passed as the optional `band` prop (`great`, `good`, `fair`, `low`, `early`; default none, which
keeps the old periwinkle arc, so a caller that does not pass one is unchanged). `bandOf` follows the server's own band key
and repeats none of its edges: `great`/`good`/`fair` as sent, `low` when the server sent a number with no band (under 55, a
soft rose rather than an alarm red), `early` for an early estimate whatever the key says, and no band at all for a key it does
not know (a newer server), so a possibly good night is never painted rose. **An early estimate is a neutral arc on a dashed
track**: provisional by shape, with no colour needed. Three rules hold: **colour is never the only signal** (the number and the
band word, or "Early estimate", are always beside the ring), **text is never set in a band colour** (the number stays
`--text-primary` or white; only the arc takes the colour), and the low band is soft, not red. Three sizes, from the type scale: 44px with a 15px number, 64px with
a 20px number (the sleep detail page) and 72px with a 22px number and the **band word** drawn under it in 11px (the child's card,
"82 / Good"; the word is decorative like the rest of the ring). The ring is `aria-hidden`; the control around it carries the score in its name.
**The groove is wide on purpose (v3.1, 2026-11-13)**: the track and the arc share one stroke, 6px on the 44px ring and 9px on the
64px ring (they were 4px and 6px), so the ring reads as a shape and the arc is never thinner than its track. The early
estimate keeps its dashed track, with dashes scaled to the stroke. No contrast figure changes: the colours are untouched, and a
stroke's width is not part of the WCAG ratio. (The design canvas drew 7 to 11 and 8 to 12 on a 112px ring; this app's rings are
44px and 64px, so the widths were scaled to the same proportion, not copied.)

`surface` picks the colours. On a `.card`: the arc is `--band-<band>` (which switches with the theme, contrast in "Band colours")
on a `--border` track and the number is `--text-primary` (the number 16.65:1 and 12.53:1; with no band the arc is
`--accent-line`, 5.06:1 on a day card, 5.87:1 on a night card, 3.57:1 and 4.40:1 against the track).
On the child and sleep-page night cards (`.night`), which use the same navy gradient in both themes, the colours are **literals or fixed
tokens**, because the day `--accent-line` is only 2.45:1 there: the arc is `--band-<band>-ring` (the same in both themes;
with no band, the literal periwinkle `#A7B1FF`, 6.13:1 at the gradient's lightest point, `#2C2F63`, and 7.60:1 against its
track), the number `#FFFFFF` (12.40:1), the track near-black at 35% (`rgba(10, 8, 12, 0.35)`, which composites to the navy
`#202145`), a groove darker than the card; the band ring colours are measured against this track.
Measured with the WCAG formula, 2026-11-13; contrast only rises towards the darker end of the gradient.

**The night card's tint.** While a score is shown, the child page's `.night` card takes a flat 12% wash of the band's ring
colour over its gradient (class `night--<band>` set by `ChildDetail.jsx`, from the band the sleep card reports; a background
layer, so it cannot cover text or take a tap; no score means no class and the plain gradient; the class is dropped at once
when you switch to another child, until that child's own score arrives). The tint rules sit inside an `@supports (background:
color-mix(...))` block: a `background` holding `color-mix()` and `var()` is valid when parsed on every engine and only fails when
computed, which on a WebView without `color-mix()` (iOS 15 to 16.1, Android WebView before Chromium 111) would make the whole
background transparent. Skipping the block keeps the plain gradient there, and only the tint is lost. Re-measured on the TINTED
lightest stop `#2C2F63` (the worst case; every figure only rises towards `#191B38`): `--night-text` is 8.11 to 9.38:1,
`--night-muted` 5.07 (great) / 5.53 (good) / 5.68 (fair) / 5.87 (low) / 5.17 (early):1 (6.85:1 on the bare gradient; 4.5:1
needed), `--night-link` 5.82 to 6.74:1, and the arc against the tinted card 6.79 / 4.63 / 4.32 / 3.27 / 6.08:1
(a graphic needs 3:1; rose is the weakest). `test/paletteTokens.test.jsx` recomputes them from the stylesheet, including the 12%.

### Night summary (`components/SleepScoreCard.jsx`, `lib/nightSummaryPhrases.js`)
A few plain sentences about the night sit beside the score ring and duration in one navy card under the date.
The detail page joins related observations into a two or three sentence blurb. The child's card keeps the
headline as **one line** under the duration
(`.night__headline`, 15px bold, under the sleep row at the card's full width) and **wraps rather than ending in an ellipsis**: at
320px "Steady, with some waking or stirring." was cut to "Steady, with some waking or stirri...", which hides what the line is for.
It is also in the button's `aria-label`. The observations list is not on the child's card at all.

The detail card's **Why this score?** button opens a bottom sheet on a phone and a centred dialog from
1024px. Each of the five factors has the name and measured value on one row, and under it a 72px bar and a
short word on one line (the factor's number is read out by screen readers, not drawn), then a muted line
of detail. On a phone the card's ring and time asleep share the top row and the blurb takes the full width
beneath. The close button has a 44px target. Long names wrap rather than scroll. The fill uses the
factor's own score band through `--band-great`, `--band-good`, `--band-fair` or `--band-low` on the
card surface, against the `--border` track. These pairs are checked at 3:1 in both themes. A factor
left out of the score has a dashed empty track and a reason. The sheet follows with available night
figures and notes that apply to this score. The page's estimate line remains at its foot.

The words are descriptive only: what was measured and how it compares with this child's own recent nights, never a cause, advice,
praise or blame, never a sleep stage, no emoji and no exclamation mark. The headline's class follows the score's parts, so a
headline cannot contradict the score. See the voice rules at the top of `lib/nightSummaryPhrases.js`.

### States without a score ring (`NightPendingRing.jsx`) and the review rows
UI refresh PR H. Every state keeps the same words it had; what is new is the shape beside them.

- **Tonight in progress**, on both the child card and the sleep page's night card: a **dashed ring with a moon** (the same 72px as the
  score ring, so the card does not change shape when the score arrives), and "Score and night summary after 7:00 AM". The time is the
  end of the night window **in the configured timezone** (`pendingNightText` in `lib/sleepScoreText.js`). The child card shows this
  line **instead of** its headline (a night that has not finished has no whole-night sentence); the sleep page keeps the facts so far
  above it. The ring has no number and no band, and is never a band colour: it uses the neutral early-estimate strokes
  (`--band-early`, `--band-early-ring`), and as a stroke, not text colour (`paletteTokens.test.jsx` forbids a band token on text).
  A child whose **Show sleep score** switch is off has no `score` key, so neither card shows the ring or the line (they would promise a
  score that never appears); a night with no window end or an older server falls back to the earlier wording.
- **No data**: the sleep page's empty night shows the dashed ring above "No sleep data for this night — ...". The design's "Go to last
  night" button is **not built** (the strip and the calendar already reach other nights).
- **Early estimate**, **no score** and **score switch off** are unchanged: a number with a neutral dashed-track ring and "Early"; no
  ring and "No score yet" with its reason; no ring at all.
- **The review screen** keeps one question card ("Up at 6:20 AM. Is that right?" with That's right and Not quite). **Not quite** opens
  the correcting step as drawn (UI refresh PR I): "When did <child> get up for the day?", a "We had 6:20 am." line, a **-5m / time / +5m
  stepper**, the logged out-of-bed times near it as tappable chips ("6:20 am · out of bed"), "Add a note" and Save. The middle of the
  stepper is a real time field (typing still works and is sent as typed), the side buttons are labelled "-5m, 5 minutes earlier" and "+5m, 5 minutes
  later", and every control is at least 44px. The stepper **stops at 00:00 and 23:59 instead of wrapping, and at 11:59 and 12:00
  instead of crossing noon**: the server reads a bare time before 12:00 as the morning after the night's date and from 12:00 on
  as the night's own date, so a wrap or a step across noon would silently change the calendar day. A time that really is on the
  other side is typed by hand. It does nothing on an empty field (it never invents a starting time). The
  chips are out-of-bed events within an hour of a time the page already shows, at most four; a tap sets the time and records which
  logged event it was, and typing or stepping afterwards drops that link. "Up between A and B" keeps its three buttons (Around A,
  Around B, Another time), restyled at 44px; "Another time" leads into the same step, empty as before.
  The one quieter answer is a **row in a card of its own**, "Something else was off" (icon, words, chevron, 44px), which opens an
  **Edit sleep times** bottom sheet: In bed, Fell asleep (each with a "We had ..." line), "Add a note", Save, and "No one was in the bed".
  The sheet is the shared `Modal` (focus moves in, Tab stays in, Escape or a tap outside closes it and focus returns to the row).
  **Closing it discards what was typed in it**, and the sheet says so. Its **Save also sends the wake the page shows** (the same
  answer the page's own buttons send, so nothing stored changes), so while that wake is still the app's guess (or a time just
  stepped to) the sheet says "Saving also confirms the up time shown on the page. In bed and fell asleep are saved only if you
  change them."; with a stored answer, or in "Up between" mode with nothing typed (no wake is sent), it says only "Only a time you
  change here is saved." **Not built**, because the app has no field to store a reason:
  the design's "What was off?" chips.
- **Card headings are one treatment**: an icon (16px, `--accent-line`) and a 15px bold title in `--text-primary`, as on Timelapse, Recent
  alerts and Recordings. "Room climate · last 24h", the sleep page's "Timeline" and "Sleep & room temperature" were 12 to 13px grey or
  uppercase labels and now match.
- **Room activity** (the second tab): every row is **one line** ("7:14 PM – 7:31 PM", the duration, a chevron when it opens). The common
  kind, "Movement outside the bed", is a small teal dot (the timeline's ring colour) that carries the words as its name and title, so a
  screen reader still hears them on every row; a chip appears only for the less common "Out of bed". One caption line above the list
  says what the dot is, with a **What is this?** button (44px, `aria-expanded`, and `aria-controls` only while the explanation is open
  and so exists) that opens the full explanation, worded as before. **At 320px every row is still one line** (measured at 320 and
  375px, both themes): the right-hand group (chip, duration, arrow) never drops under the time. Under 380px the chip reads "Out" on
  screen (" of bed" stays in the page, visually hidden, so a screen reader still hears "Out of bed"), the amber dot beside the time
  (which only repeats the chip's colour) is hidden, and the caption above is 12px. A viewer away from home sees a zone suffix on both
  times, which cannot fit on one line at 320px: there the **time wraps inside its own cell** and the chip stays on the row, rather
  than the time being cut (text that carries meaning wraps).
- **The tab control** (Wake-ups | Room activity) has a light accent tint for its track and a stronger tint with a 3px `--accent-line`
  indicator for the selected tab, in both themes. It was the near-black inset `--bg-elevated-2` at night, which read as a black hole
  beside the raised selected tab. **Contrast, recomputed from the stylesheet** (`paletteTokens.test.jsx`): the selected pill's fill
  against the track is only 1.22:1 by day and 1.31:1 at night (named in "Known pairs below their floor"), so the fill is not what
  carries the state; the 3px `--accent-line` indicator is, and it is 3.54:1 (day) and 3.69:1 (night) against the pill fill and 4.31:1
  and 4.83:1 against the track, over the 3:1 a non-text mark needs. The bolder, darker label is a second cue. The control's ids are
  per instance (React `useId`), so two on one page never share an `aria-controls` target.
- **"Up for the day"** is one row with **only the time** the child got up (the old row showed a start-to-end range and a duration;
  the owner approved the single time). The counted wake-ups above it keep their ranges. It is shown for a wake the detector did not
  doubt, and for one a **parent gave** in the review, even though the detector's own "set aside an earlier exit" note stays on the
  night (that note alone hides the row only when no parent has confirmed the time: the score treats the wake the same way).
- **The review question belongs to the night the card shows.** The child page's question and its receipt come from a request about
  the last completed night, so they are drawn only when the night card above shows that finished night: while "Tonight · so far" is
  on the card there is no review row and no receipt from the night before. The review route and the notification's link
  (`/children/:id/review/:date`) name their own date and are unchanged.
- **Phone rules found by this pass** (320 and 375px, both themes): text that carries meaning wraps, it is not cut with an ellipsis; a
  heading that wraps is balanced (`text-wrap: balance`) so one word is not left alone; a hover tint is only for pointer devices
  (`@media (hover: hover)`), because on a phone it stays on a row after a tap.

### Sleep page frame (`MoreMenu.jsx`, `SleepNightStrip.jsx`, `AppHeader`'s `actions` and `bandLine`)
The top of the sleep detail page, as drawn in the UI refresh.
- **Header.** Back link, "Sleep", and a **⋯** button on the right (`MoreMenu`, passed to `AppHeader` as `actions`). Along the
  bar's bottom edge runs a 3px **band line** (`bandLine`): the night on screen's band colour, or neutral for no score and for an
  early estimate. It is an **inset shadow of the header itself** (a modifier class `app-header--band-<band>` on the `<header>`, not a child
  element), so it is always painted over the bar's navy (`--bar` `#14142A`, one navy in both themes) and can never land on the page
  background, where the band colours do not reach 3:1 (they are 1.24 to 2.99:1 on the light page, which is why it is not a child at the
  edge). It uses the fixed `--band-*-ring` colours at full strength, never an opacity blend; an early estimate and no score share one
  solid neutral, `--band-early-ring`. Contrast against `--bar`: great 13.34, good 8.36, fair 7.58, low 5.56, neutral 11.73 (needs 3:1);
  `test/paletteTokens.test.jsx` recomputes all five from the stylesheet. It is a mark, not text, and nothing for assistive technology.
- **`⋯` menu.** A menu button (`aria-haspopup="menu"`, `aria-expanded`) over a popover of `role="menuitem"` buttons, each at least
  44px tall. Enter, Space or ArrowDown opens it and focuses the first item; Up, Down, Home and End move; Escape closes it and
  returns focus to the button; so does choosing an item; a press outside, or tabbing out, closes it without taking focus back.
  It holds "Show with today's settings" (shown to every viewer when the night has a saved-settings view) and "Recompute this
  night" (admin only, and only where it is offered). **A viewer with neither gets no `⋯` button at all.** The panel is always
  in the page, only `hidden` while closed: Recompute's item belongs to `RecomputeNight` (portaled into the panel), whose dialog
  must outlive the menu closing, so the menu listens to clicks and keys natively (a React handler would never hear the portaled item).
  A failed Recompute read is shown on the page, not in the menu, because the menu has closed by then.
- **Title.** "Night of <weekday, date>" (with a "so far" badge for the night in progress) and a 44px calendar button. The native
  date input lies invisibly over the button, so a tap opens the platform picker; its min and max keep the 30-night history window.
- **Night strip.** Seven buttons, oldest to newest, right-aligned: weekday, date number, score (a dash with no score), and a 4px
  band bar. The selected night has `aria-current="date"` and an accent border. Each button's accessible name carries the date and
  the score ("Sat, Aug 29, score 75", "…, no score", "…, score 58 (early estimate)"). It is a **heat map by design** (the owner
  accepted that): no comparison wording is added, and the bar is never the only signal. The window is the newest seven nights while the selected
  night is among them. An older night (picked from the calendar, or reached by walking back) slides the window so the selected night
  is in the **centre**, clamped at the first and last night available, so its neighbours are one tap away on both sides and walking
  back to the 30-night floor is a tap per night. A night with no stored row shows a dash. The strip is cut off at the child's first
  stored night unless the selected night is older (then it reaches the calendar's floor). It reads the stored scores once per child
  from `GET /children/:id/sleep?nights=30` (the history window; the route allows 60), slices them in the browser, and renders nothing
  while loading or if the request fails. It is not shown for a child until that child's own newest night is known, so it is never
  drawn against the previous child's.

### Modal (`components/Modal.jsx`)
On phone widths a **sheet**, not a centred dialog: overlay `rgba(10, 13, 28, 0.7)`, card
`max-width: 440`, hugging the bottom edge (`placement="top"` for the top), rounded 20px on the inner
side only, title 18px, `✕` close button with `aria-label="Close"`. The close button is **44 x 44px** in every modal (its own class,
`modal-card__close`; a bare `.icon-btn` is a 6 x 8px padding), so the other `.icon-btn` uses (list-row actions, "Refresh now") keep
their text-button look.

A bottom sheet has **28px plus the device's bottom inset** (`env(safe-area-inset-bottom)`) under its last control, not the
card's usual 16px: on a phone the sheet sits on the screen edge, by the gesture bar and rounded corners, and 16px looked
jammed against it. A `placement="top"` sheet and a centred `wide` dialog keep 16px.

**`focusDialog`** is for a notice that opens by itself (a server message, a link: nobody tapped anything to get it). Focus goes
to the dialog, not to a button: a browser draws the keyboard focus ring on a button that script focuses with no tap or key before
it, which looked like a defect on the OK button. A screen reader still announces the dialog (role and name) and Tab reaches the
buttons, which show the global ring as always. A dialog the person opened keeps focus on its first field or action.

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
`--accent` + weight 600 for the active choice, supports a submenu (`--submenu` row with a `--value` on
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

### The child page below the night card (`pages/ChildDetail.jsx`, UI refresh PR D, 2026-11-13)
The `.night` card is described under "Child hero card" above. Below it, in this order (which is also the DOM order, the
reading order and the keyboard order):

1. **Camera tile** (`components/ChildCameraTile.jsx`, `.child-cam`): one **slim row** per camera of the child (about 64px
   tall, 18px radius, the dark navy gradient from `--thumb-hi`/`--thumb-lo` in both themes). It used to be a 192px tile with a large
   empty bed icon where a picture would be; this tile never has a picture, so that space was always empty and pushed the page
   down (owner, staging phone 2026-11-13). The row holds, left to right, a status chip (a dot and the camera's name; offline and
   disabled add " · Offline" / " · Disabled" in words, so the colour is never the only signal; online adds visually hidden
   "(online)" only) with the detection line under it, **Watch live** (44px, `#8995ff` with `#14142a` text, the night card's action
   pair), which goes to the Live tab, and the gear. If a preview image is ever added it goes above the row at 16:9 and only when
   an image exists. It is **not offered on a
   disabled camera**: the Live tab hides disabled cameras, so the button would lead nowhere (the chip says "Disabled"). An admin also gets a
   44px settings gear at the row's end ("Camera settings for <name>"); a caregiver does not (camera settings are admin-only). It is
   **not a live picture**: no stream is opened by opening the page. There is no "Cameras · n" heading and no Online/Offline pill or
   PTZ/TALK badges (the Cameras tab shows ONVIF, PTZ and Two-way Audio badges). Instead, one quiet muted line under the camera's name, **for every role**, says whether detection is on in words: "Motion on · Sound on", or "Motion off" / "Sound off" for what is off (from the camera's `detect_motion_enabled` and `detect_sound_enabled`; owner decision, 2026-11-13: the first version had no such line, so a caregiver could not tell). It is left out on a disabled camera and on a camera object that carries neither field. A child with no camera gets a plain card with the existing
   "No cameras assigned yet" sentence (the admin and caregiver wordings differ, as before).
2. **Timelapse** (`components/TimelapseCard.jsx`): the card title (15px bold, accent icon), one player (the newest night, 16:9),
   and a strip of recent nights as small thumbnails, four in view and scrolling for the rest, each labelled with its **weekday**
   in a dark chip on the picture. A weekday repeats weekly, so the full date is the accessible name ("Show Tue, 1 Sept
   timelapse") and the tooltip. Renders nothing at all when the child has no timelapse (no empty card).
3. **Recent alerts** (`components/AlertList.jsx`, `.alert-list`): the newest **three**, each row 56px or more: a 56 × 40 thumbnail,
   the kind (icon and word, "Motion" or "Sound") and under it the **clock time** in the home timezone ("3:12 AM"; an earlier day
   adds "Wed, 11 Nov, "; the zone label appears when the device is elsewhere, as on every time in the app). A row **with a clip**
   is one button (the whole row; accessible name "Play clip from <camera>") with a chevron; a row without one is plain, with no
   chevron. The camera name is the row's tooltip, not printed. **See all alerts** (44px, only when there are more than three)
   expands the rest in place (the page already holds the newest 20), and becomes "Show fewer". There is no alerts page to link
   to. The empty and failed states keep the title and say what happened, as before ("No alerts for <name> yet.", or the failed
   message with Retry).
4. **Recordings** (`components/RecordingsCard.jsx`, `.recordings-row`): one 56px row, "Recordings", the newest recording's time, a
   chevron. It is a disclosure (`aria-expanded`), closed until tapped. It opens a scrolling strip of 16:9 pictures with a peek of
   the next one; each picture carries a short chip and a play mark: weekday and home time ("Wed 12:09 am") for a recording
   under seven days old, the date and time ("30 Aug, 7:00 pm") from seven days on, so an old recording is not mistaken for
   this week's. The full date and time are the accessible name and the tooltip. The row's own time uses the same short form
   (the long form lost its AM/PM at 320px) and keeps the full one as its name and tooltip. For a viewer away from home the zone
   suffix ("GMT+11") is its own item beside the time: at 320px, when both do not fit, **the zone drops under the time** (right-aligned,
   inside the 56px row) rather than being cut off, and only a time that alone is wider than the row ends in an ellipsis (checked in a
   browser at 320 and 375px, both themes). Tap a picture to play it. A failed recording has a warning mark and opens
   its explanation instead. Older recordings stay reachable (recordings have no retention). A newest recording that failed says
   "Couldn't be saved" on the row. Renders nothing when there are none.
5. **Sensor history** (a camera with an MQTT topic), unchanged.

On these child-page cards, the alerts disclosure and Recordings row keep the card colour when open. A pointer hover gives them
a light tint, and pressing gives a slightly stronger one; on a touch screen there is no lingering hover fill after a tap.
Alert rows with clips use the same treatment. Focus rings stay visible for keyboard users. Timelapse and recording pictures
also show a focus ring. The camera tile's controls retain their own light-on-dark colours and only show hover feedback to a
hovering pointer.

From **1024px** the same elements sit in two columns by grid placement (never `order`): the night card then recent alerts on the
left; the camera, timelapse, recordings and sensor history on the right. The camera column stretches to the night card's height.
The page is 1040px wide at that size (the other pages stay at 720px). Cards take their margin on the inside of their wrapper, so
an absent section leaves no gap.

Known trade-off (accepted in review): because the DOM stays in phone order, at 1024px and wider the keyboard and reading order
(night card, camera, timelapse, alerts, recordings) no longer matches the screen order in the left column (night card, then
alerts), so Tab leaves the night card for the camera tile in the right column before reaching the alerts under it.

Known limits: the layout has been checked in a desktop browser at 375 and 1280 wide, light and dark; it has not been seen on a
real phone or tablet, and a screen reader has not been run over it.

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
- **An accessible name contains the text the control prints, and starts with it where practical** (WCAG 2.5.3, label in name).
  When a button shows "Sun 7:00 pm" its `aria-label` begins "Sun 7:00 pm", then the camera and the full date; never "Sun, 30
  Aug, 7:00 pm from the camera", or "Play ..." in front of a printed date. A voice-control user says what they see, and a name
  that does not contain it does not match. Put the verb or the extra detail after the printed text. Where the printed text is a
  long sentence the name may carry only its opening. A symbol that is not a word anyone says (the sleep strip's dash for "no
  score") need not be in the name. Test it with `nameStartsWithPrinted` (`frontend/test/helpers/accessibleName.js`).
  Two controls only CONTAIN the printed text, a known and accepted limit: the Room activity rows (the dot's "Movement outside
  the bed" comes before the time range) and "Why this score?" (the spoken score comes first). Icon-only controls have no
  printed text and are exempt (they only need a name).
- **No tap-highlight flash, and a press state in its place.** One rule in `index.css` sets
  `-webkit-tap-highlight-color: transparent` on buttons, links, summaries, selects, labels, checkbox and radio inputs (the
  Switch included), the button, tab, menuitem and link roles, and two plain click targets (`.camera-tile__video-wrap`,
  `.clip-row__body`), because the Android WebView paints a square grey flash over a tapped control that is not part of the
  design. Do not set it per component. A touch tap does not show `:focus-visible`, so removing the flash would leave a control
  with no feedback; a generic fallback therefore dims any enabled button, `[role=button]`, summary, tab or menuitem with
  `filter: brightness(0.9)` while pressed. It is written with `:where()` so its specificity is only the `:active`, and a
  control's own `:active` rule replaces it. The fallback is brightness only: no `transform` (a shrinking full-width button
  lost taps within about 2px of its edge) and no colour. A control with a specific press state is better than the
  fallback:
  `--child-action-active` as the tint (hover: `--child-action-hover`, inside `@media (hover: hover)`), beside its
  `:focus-visible` ring. **Never `--bg-elevated-2` or `--field-bg` in any `:active` rule**: they are the inset colours,
  near-black in the dark theme, and drew the black bars #1064 removed (`paletteTokens.test.jsx` fails any `:active` rule that
  names them). **The same goes for `:hover`**: no `:hover` rule anywhere uses an inset token (`paletteTokens.test.jsx` fails one),
  because a hover fill was the same near-black bar at night. Hover tints use `--child-action-hover`, and only inside
  `@media (hover: hover)`. That is how the sleep page's `⋯` menu items, the clip calendar's buttons and days (the selected day keeps its
  accent fill under the pointer), the desktop sidebar's hovered link and the unused `.hamburger-item` were fixed. **Any `:hover`
  rule that sets a background fill is inside `@media (hover: hover)`** (a phone keeps a tapped control in `:hover`, so an unwrapped
  fill stays painted; `.tile-menu__item` and `.night__settings` were the last two), and the test enforces it for the whole
  stylesheet. The deliberate exceptions set no fill: `.clip-datepicker__trigger`, `.detect-toggle` and `.log-chip` change only a border
  or text colour (the last two exclude their lit state with `:not(...)`), and are named in the test. The sidebar's
  *selected* link keeps `--bg-elevated-2` on purpose: it is a resting surface, not a hover. `.btn` has its own, `brightness(0.92)` (a tint cannot work: secondary and danger are transparent outlines).
  Specific tints: the review stepper buttons, the logged-time chips, the "Something else was off" row, the sleep strip, and
  the child page's rows and tiles. **Everything else relies on the generic dim** (`.more-menu__btn`, the tabs,
  `.sleep-score__open`, `.sleep-events__what`, `.review-add`, `.night__sleep--btn`, the bottom-nav links, `.child-card` whose
  own `:active` only undoes its hover lift). The Switch toggles visibly, and the two plain click targets (a `div`, not a
  button) have no press state at all: both are a known limit.
- `aria-pressed` on toggles, `aria-expanded` (+ `aria-haspopup`) on disclosures.
- Real `<input>`s behind custom controls, not `div`s with click handlers.
- `prefers-reduced-motion` honoured for every loop.
- Both themes must clear normal contrast: `--text-secondary` on `--bg-elevated` is the tightest
  common pair — check any new neutral against it.

---

## 10. Before shipping a UI change

1. **Both themes** — light and dark, not just the one you built in.
2. **A non-default palette** — switch to Dusk lavender; nothing gold should remain hardcoded.
3. **Fonts** — confirm Inter and Nunito load from local assets, including when offline.
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
- The camera-tile CSS family is split across `.camera-tile*` and `.cam-*` prefixes.

None of these are bugs. Match the **rule**, not the nearest drifted example.
