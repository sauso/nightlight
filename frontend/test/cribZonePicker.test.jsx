// The bed-zone picker. Its own header states a property that nothing checked: "the grid is fixed, so
// a grid-painted zone round-trips through the database exactly."
//
// That claim is load-bearing in a way little else in the front end is. The painted `detect_zone` is
// the ONLY thing the motion/sleep detector looks at, and nothing anywhere validates that a zone sits
// on the bed — a zone that shifts by one cell on every save/load cycle would drift off the mattress
// over a few edits and present as a detection problem, weeks later, with no trace back to here.
// (A real zone in this house turned out to cover wall and a moving curtain and to stop short of the
// foot of the bed; it took drawing it over a frame to see. Silent corruption of the same data is the
// failure mode worth being paranoid about.)
//
// The rest is jsdom-honest: the canvas is never exercised, because `draw()` bails on a zero-size
// stage and jsdom has no layout engine. That is stated here rather than pretended otherwise — the
// painting maths is covered through the exported helpers, and the visual result is not something a
// unit test could judge anyway.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import CribZonePicker, { rectsToCells, cellsToRects, parseZoneText, MAX_ZONE_TEXT, COLS, ROWS } from '../src/components/CribZonePicker.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

const cellCount = (cells) => cells.reduce((n, v) => n + v, 0);
const on = (cells, col, row) => !!cells[row * COLS + col];
/** Paint a rectangle of CELLS (inclusive bounds), the way a drag would. */
function paint(cols, rows) {
  const cells = new Uint8Array(COLS * ROWS);
  for (const r of rows) for (const c of cols) cells[r * COLS + c] = 1;
  return cells;
}

// --- the storage round-trip ---------------------------------------------------------------------

describe('zone storage round-trip', () => {
  test('a painted zone survives cells -> rects -> cells UNCHANGED', () => {
    // An awkward shape on purpose: two disjoint blobs, one of them ragged, spanning both axes.
    const cells = paint([3, 4, 5, 6], [2, 3, 4]);
    for (const c of [10, 11]) for (const r of [4, 5, 6, 7]) cells[r * COLS + c] = 1;
    cells[7 * COLS + 12] = 1; // a ragged corner that breaks the run alignment
    cells[0] = 1; // the very first cell
    cells[ROWS * COLS - 1] = 1; // and the very last

    const back = rectsToCells(cellsToRects(cells));
    // ⚠️ Compared cell by cell, not by count: two zones can cover the same NUMBER of cells and be in
    // completely different places, which is precisely the confusion that let a badly-placed zone look
    // fine by every number available.
    expect([...back]).toEqual([...cells]);
  });

  test('every single-cell position round-trips, including all four corners', () => {
    // ⚠️ THE CONSTANTS ARE PINNED HERE, and it is not ceremony. The loop below is parameterised by
    // COLS/ROWS, so "exhaustive over all 576 cells" is only true if the grid IS 32x18 — shrink ROWS
    // to 16 and this test quietly becomes exhaustive over 512 and still passes. Found by an
    // adversarial review. The grid is also not free to change: the detector analyses a 320x180 frame,
    // so one cell is exactly 10x10 analysis pixels and a different grid would pretend to a precision
    // the thing consuming it does not have.
    expect(COLS).toBe(32);
    expect(ROWS).toBe(18);
    expect(COLS * ROWS).toBe(576);

    // One cell at a time across the whole grid, because an off-by-one in the edge rounding would only
    // show at a boundary.
    let checked = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cells = new Uint8Array(COLS * ROWS);
        cells[r * COLS + c] = 1;
        const back = rectsToCells(cellsToRects(cells));
        expect(cellCount(back)).toBe(1);
        expect(on(back, c, r)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(576);
  });

  test('a full-frame paint round-trips as one rect covering everything', () => {
    const cells = new Uint8Array(COLS * ROWS).fill(1);
    const rects = cellsToRects(cells);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(cellCount(rectsToCells(rects))).toBe(COLS * ROWS);
  });

  test('nothing painted stores as no rects', () => {
    expect(cellsToRects(new Uint8Array(COLS * ROWS))).toEqual([]);
  });
});

describe('cellsToRects packing', () => {
  test('a solid blob merges into ONE rect, not one per row', () => {
    // The whole reason for the vertical merge: a hand-painted bed is a few dozen rows, and storing a
    // rect per row would bloat every zone in the database.
    const rects = cellsToRects(paint([4, 5, 6], [2, 3, 4, 5]));
    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBeCloseTo(4 / COLS, 5);
    expect(rects[0].w).toBeCloseTo(3 / COLS, 5);
    expect(rects[0].y).toBeCloseTo(2 / ROWS, 5);
    expect(rects[0].h).toBeCloseTo(4 / ROWS, 5);
  });

  test('rows that do NOT line up stay separate rects', () => {
    const cells = paint([4, 5, 6], [2]);
    for (const c of [5, 6, 7]) cells[3 * COLS + c] = 1; // shifted one column right
    const rects = cellsToRects(cells);
    expect(rects).toHaveLength(2);
  });

  test('two runs in the same row are two rects', () => {
    const cells = paint([1, 2], [5]);
    for (const c of [10, 11]) cells[5 * COLS + c] = 1;
    expect(cellsToRects(cells)).toHaveLength(2);
  });

  test('adjacent rects are FLUSH — the right edge of one is the left edge of the next', () => {
    // Edges are rounded rather than widths, precisely so neighbours meet exactly. A gap here is a
    // one-cell blind stripe through the middle of a bed zone.
    const rects = cellsToRects(paint([0, 1, 2], [0]));
    const only = rects[0];
    const nextX = cellsToRects(paint([3, 4], [0]))[0].x;
    expect(+(only.x + only.w).toFixed(5)).toBe(nextX);
  });
});

describe('rectsToCells rasterising', () => {
  test('accepts the LEGACY single-rect shape, not just an array', () => {
    // Old zones were stored as one object rather than a list; the picker still has to open them.
    const fromObject = rectsToCells({ x: 0, y: 0, w: 0.5, h: 0.5 });
    const fromArray = rectsToCells([{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
    expect([...fromObject]).toEqual([...fromArray]);
    expect(cellCount(fromObject)).toBe((COLS / 2) * (ROWS / 2));
  });

  test('null, undefined and an empty list all mean "whole frame", i.e. nothing painted', () => {
    for (const z of [null, undefined, []]) expect(cellCount(rectsToCells(z))).toBe(0);
  });

  test('malformed rects are SKIPPED, not allowed to poison the whole zone', () => {
    // ⚠️ One bad row in the database must not blank a zone that is otherwise fine — the detector
    // would silently start watching the whole frame, which looks like "detection got worse".
    const cells = rectsToCells([
      null,
      { x: 0, y: 0 }, // missing w/h
      { x: '0', y: 0, w: 1, h: 1 }, // string, not a number
      { x: 0, y: 0, w: 0.25, h: 0.5 }, // the good one
    ]);
    expect(cellCount(cells)).toBe((COLS / 4) * (ROWS / 2));
  });

  test('a centre sitting EXACTLY on a rect edge is INSIDE it', () => {
    // ⚠️ Three comparisons in rectsToCells are inclusive (`cx >= r.x`, `cx <= r.x+r.w`, and the
    // `cy < r.y` skip), and every other fixture in this file uses zones this picker WROTE — where a
    // cell centre never lands on an edge, so all three flip freely and survive. Legacy hand-drawn
    // boxes are exactly the case where a centre CAN land on an edge, and the source comment calls
    // them out as the thing this function approximates.
    // Centres sit at (k+0.5)/N, so this rect's left edge is cell 0's centre and its right edge is
    // cell 2's centre; its top edge is row 0's centre. h is 0.45 on purpose — nowhere near a centre —
    // so the bottom edge is not also a boundary and each assertion below has one reason to fail.
    const cells = rectsToCells([{ x: 0.5 / COLS, y: 0.5 / ROWS, w: 2 / COLS, h: 0.45 }]);
    expect(on(cells, 0, 0)).toBe(true); // left edge == centre → in
    expect(on(cells, 2, 0)).toBe(true); // right edge == centre → in
    expect(on(cells, 3, 0)).toBe(false); // and it stops there
    expect(cellCount(cells)).toBe(3 * 9); // cols 0-2, rows 0-8
  });

  test('a cell is on when its CENTRE is inside the rect', () => {
    // A rect covering just under one column must not light the next column up.
    const cells = rectsToCells([{ x: 0, y: 0, w: 1 / COLS, h: 1 }]);
    expect(on(cells, 0, 0)).toBe(true);
    expect(on(cells, 1, 0)).toBe(false);
    expect(cellCount(cells)).toBe(ROWS);
  });
});

// --- the component ------------------------------------------------------------------------------

describe('CribZonePicker', () => {
  const show = (props = {}) =>
    renderAsAdmin(<CribZonePicker cameraId="cam-a" zone={null} onChange={vi.fn()} {...props} />);

  const img = () => screen.getByAltText('Camera view');

  test('shows a still from THIS camera, cache-busted so Refresh gets a new frame', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}?token=abc`);
    const { user } = show();
    const first = img().getAttribute('src');
    expect(first).toContain('/cameras/cam-a/snapshot');
    // The URL already carries a token, so the nonce has to be appended with & — with ? it would
    // truncate the token and every refresh would 401.
    expect(first).toMatch(/\?token=abc&_=0$/);

    fireEvent.load(img());
    await user.click(screen.getByRole('button', { name: 'Refresh frame' }));
    expect(img().getAttribute('src')).toMatch(/&_=1$/);
  });

  test('appends the nonce with ? when the snapshot URL has no query of its own', () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    show();
    expect(img().getAttribute('src')).toMatch(/snapshot\?_=0$/);
  });

  test('says it is grabbing a frame, then reveals the canvas once it loads', () => {
    vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
    const { container } = show();
    expect(screen.getByText('Grabbing a frame…')).toBeInTheDocument();
    expect(container.querySelector('canvas')).toHaveAttribute('hidden');

    fireEvent.load(img());
    expect(screen.queryByText('Grabbing a frame…')).not.toBeInTheDocument();
    expect(container.querySelector('canvas')).not.toHaveAttribute('hidden');
  });

  test('a snapshot that will not load offers a retry, which asks for a fresh frame', async () => {
    vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
    const { user } = show();
    fireEvent.error(img());
    expect(screen.getByText(/Couldn’t grab a frame/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    // Back to loading, with a new nonce on the URL.
    expect(screen.getByText('Grabbing a frame…')).toBeInTheDocument();
    expect(img().getAttribute('src')).toMatch(/_=1$/);
  });

  test('the hint tells you what to do when empty, and the coverage when not', () => {
    vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
    const { unmount } = show();
    expect(screen.getByText(/Drag across the squares covering the bed/)).toBeInTheDocument();
    unmount();

    // 8 of 32 columns by 9 of 18 rows = 72 of 576 cells = 12.5%, which the readout rounds to 13%.
    show({ zone: [{ x: 0, y: 0, w: 0.25, h: 0.5 }] });
    expect(screen.getByText(/Covering 13% of the view/)).toBeInTheDocument();
  });

  test('"Whole frame" is dead when nothing is painted, and clears the zone once confirmed when it is', async () => {
    vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
    const onChange = vi.fn();
    const { unmount } = show({ onChange });
    expect(screen.getByRole('button', { name: 'Whole frame' })).toBeDisabled();
    unmount();

    const { user } = show({ zone: [{ x: 0, y: 0, w: 0.5, h: 0.5 }], onChange });
    const clear = screen.getByRole('button', { name: 'Whole frame' });
    expect(clear).toBeEnabled();
    await user.click(clear);
    // #906: the click only asks. Nothing is cleared or saved until Confirm.
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use whole frame' }));
    // ⚠️ NULL, not []. The backend reads "no zone" as "watch the whole frame"; an empty array is a
    // zone covering nothing, which would mean the detector sees nothing at all.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.getByText(/Drag across the squares covering the bed/)).toBeInTheDocument();
  });

  test('re-syncs from the parent when the saved zone comes back changed', () => {
    vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
    const { rerenderWith } = show({ zone: null });
    expect(screen.getByText(/Drag across the squares/)).toBeInTheDocument();
    // A save round-trips through the server and the parent hands back what was stored; the picker
    // has to adopt it rather than keep showing what was on screen before.
    rerenderWith({ ui: <CribZonePicker cameraId="cam-a" zone={[{ x: 0, y: 0, w: 1, h: 1 }]} onChange={vi.fn()} /> });
    expect(screen.getByText(/Covering 100% of the view/)).toBeInTheDocument();
  });

  describe('painting', () => {
    // jsdom has no layout, so the stage measures 0x0 and pointer fractions would all be 0. Give it a
    // real box; `draw()` still bails (clientWidth stays 0), which is fine — the canvas is not what
    // these assert.
    const stageAt = (container) => {
      const stage = container.querySelector('.crib__stage');
      stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: COLS * 10, height: ROWS * 10 });
      stage.setPointerCapture = vi.fn();
      return stage;
    };
    const at = (col, row) => ({ clientX: col * 10 + 5, clientY: row * 10 + 5 });

    test('a tap paints one cell and reports the rect on release', () => {
      vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
      const onChange = vi.fn();
      const { container } = show({ onChange });
      fireEvent.load(img());
      const stage = stageAt(container);

      fireEvent.pointerDown(stage, { pointerId: 1, ...at(5, 3) });
      // One cell of 576 is 0.17%, which rounds to 0 — so the readout reads "Covering 0%" even though
      // something IS painted. Slightly odd, deliberately not changed: the sentence that follows it
      // ("Drag over painted squares to rub them out") is the part that tells you the state changed,
      // and it only appears once at least one cell is on. Asserted so the oddity is on the record.
      expect(screen.getByText(/Covering 0% of the view. Drag over painted squares/)).toBeInTheDocument();
      // ⚠️ Nothing is reported until the stroke ENDS: onChange during a drag would fire hundreds of
      // times and mark the form dirty on every cell.
      expect(onChange).not.toHaveBeenCalled();

      fireEvent.pointerUp(stage);
      expect(onChange).toHaveBeenCalledTimes(1);
      const cells = rectsToCells(onChange.mock.calls[0][0]);
      expect(cellCount(cells)).toBe(1);
      expect(on(cells, 5, 3)).toBe(true);
    });

    test('a drag fills EVERY cell along the path, not just where the events landed', () => {
      // pointermove does not fire per pixel, so the component walks the segment since the last event.
      // Without that, a fast drag leaves a dotted line with gaps in the bed zone.
      vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
      const onChange = vi.fn();
      const { container } = show({ onChange });
      fireEvent.load(img());
      const stage = stageAt(container);

      fireEvent.pointerDown(stage, { pointerId: 1, ...at(2, 2) });
      fireEvent.pointerMove(stage, at(9, 2)); // one big jump across seven cells
      fireEvent.pointerUp(stage);

      const cells = rectsToCells(onChange.mock.calls[0][0]);
      for (let c = 2; c <= 9; c++) expect(on(cells, c, 2)).toBe(true);
      expect(cellCount(cells)).toBe(8);
    });

    test('starting a stroke ON a painted cell ERASES, the way a toggle brush does', () => {
      vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
      const onChange = vi.fn();
      const { container } = show({ zone: [{ x: 0, y: 0, w: 1, h: 1 }], onChange });
      fireEvent.load(img());
      const stage = stageAt(container);

      fireEvent.pointerDown(stage, { pointerId: 1, ...at(5, 3) });
      fireEvent.pointerMove(stage, at(7, 3));
      fireEvent.pointerUp(stage);

      const cells = rectsToCells(onChange.mock.calls[0][0]);
      expect(cellCount(cells)).toBe(COLS * ROWS - 3);
      for (let c = 5; c <= 7; c++) expect(on(cells, c, 3)).toBe(false);
    });

    test('erasing the LAST painted cell reports null, not an empty list', () => {
      vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
      const onChange = vi.fn();
      const { container } = show({ zone: [{ x: 0, y: 0, w: 1 / COLS, h: 1 / ROWS }], onChange });
      fireEvent.load(img());
      const stage = stageAt(container);
      fireEvent.pointerDown(stage, { pointerId: 1, ...at(0, 0) });
      fireEvent.pointerUp(stage);
      expect(onChange).toHaveBeenCalledWith(null);
    });

    test('a pointer that leaves the stage is clamped inside it', () => {
      vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
      const onChange = vi.fn();
      const { container } = show({ onChange });
      fireEvent.load(img());
      const stage = stageAt(container);

      fireEvent.pointerDown(stage, { pointerId: 1, ...at(0, 0) });
      fireEvent.pointerMove(stage, { clientX: -500, clientY: -500 });
      fireEvent.pointerMove(stage, { clientX: 99999, clientY: 99999 });
      fireEvent.pointerUp(stage);
      // Without clamp01 these would index outside the grid; the count just has to be sane and the
      // corners have to be the extremes that got painted.
      const cells = rectsToCells(onChange.mock.calls[0][0]);
      expect(on(cells, 0, 0)).toBe(true);
      expect(on(cells, COLS - 1, ROWS - 1)).toBe(true);
    });

    test('a drag past the LEFT edge clamps, rather than wrapping onto the row above', () => {
      // ⚠️ The sharp case for clamp01, and the one the existing "clamped inside it" test misses:
      // dragging far outside gives a hugely negative index that a Uint8Array simply ignores, so
      // removing the clamp changes nothing there. Slipping just a few pixels past the edge is
      // different — the column becomes -1 and `row * COLS + (-1)` lands on the LAST CELL OF THE ROW
      // ABOVE. Verified: without clamp01 this paints (31, 4). Found by an adversarial review.
      vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
      const onChange = vi.fn();
      const { container } = show({ onChange });
      fireEvent.load(img());
      const stage = stageAt(container);

      fireEvent.pointerDown(stage, { pointerId: 1, ...at(3, 5) });
      fireEvent.pointerMove(stage, { clientX: -5, clientY: at(0, 5).clientY });
      fireEvent.pointerUp(stage);

      const cells = rectsToCells(onChange.mock.calls[0][0]);
      expect(on(cells, 0, 5)).toBe(true);
      expect(on(cells, 31, 4)).toBe(false);
      // The stroke stays entirely on the row it started on.
      for (let c = 0; c <= 3; c++) expect(on(cells, c, 5)).toBe(true);
      expect(cellCount(cells)).toBe(4);
    });

    test('painting is inert until the frame has loaded', () => {
      // No frame means no idea what you are painting over. The stage swallows the gesture rather
      // than letting someone paint a zone blind.
      vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
      const onChange = vi.fn();
      const { container } = show({ onChange });
      const stage = stageAt(container);
      fireEvent.pointerDown(stage, { pointerId: 1, ...at(5, 3) });
      fireEvent.pointerUp(stage);
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByText(/Drag across the squares/)).toBeInTheDocument();
    });

    test('a move with no stroke in progress does nothing', () => {
      vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
      const onChange = vi.fn();
      const { container } = show({ onChange });
      fireEvent.load(img());
      const stage = stageAt(container);
      fireEvent.pointerMove(stage, at(5, 3));
      fireEvent.pointerUp(stage);
      expect(onChange).not.toHaveBeenCalled();
    });

    test('a cancelled pointer ends the stroke the same way a release does', () => {
      // A phone call or a system gesture mid-drag fires pointercancel, not pointerup. Without it the
      // stroke would never commit and the zone the user just painted would be silently discarded.
      vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
      const onChange = vi.fn();
      const { container } = show({ onChange });
      fireEvent.load(img());
      const stage = stageAt(container);
      fireEvent.pointerDown(stage, { pointerId: 1, ...at(5, 3) });
      fireEvent.pointerCancel(stage);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(cellCount(rectsToCells(onChange.mock.calls[0][0]))).toBe(1);
    });
  });
});

// --- #906: "Whole frame" asks first ----------------------------------------------------------------
// The zone autosaves and each save restarts the detector, so a stray tap used to wipe a painted bed area
// for good. The claim under test is that NOTHING is cleared or saved until the person confirms, however
// they leave the dialog.

// 8 of 32 columns by 9 of 18 rows = 13% of the view.
const ZONE_A = [{ x: 0, y: 0, w: 0.25, h: 0.5 }];
// The ragged two-blob zone from the round-trip test: awkward on purpose (disjoint, ragged, both corners).
function raggedCells() {
  const cells = paint([3, 4, 5, 6], [2, 3, 4]);
  for (const c of [10, 11]) for (const r of [4, 5, 6, 7]) cells[r * COLS + c] = 1;
  cells[7 * COLS + 12] = 1;
  cells[0] = 1;
  cells[ROWS * COLS - 1] = 1;
  return cells;
}

const showZone = (props = {}) => {
  vi.spyOn(api, 'url').mockReturnValue('http://host/snap');
  return renderAsAdmin(<CribZonePicker cameraId="cam-a" zone={null} onChange={vi.fn()} {...props} />);
};
const wholeFrameBtn = () => screen.getByRole('button', { name: 'Whole frame' });
const copyPasteBtn = () => screen.getByRole('button', { name: 'Copy / paste zone' });
const copyBox = () => screen.getByLabelText(/^This camera/);
const pasteBox = () => screen.getByLabelText('Paste a bed area');
const typeZone = (text) => fireEvent.change(pasteBox(), { target: { value: text } });
const hasDialog = (name) => screen.queryByRole('dialog', { name }) !== null;

describe('"Whole frame" asks before it clears a painted zone (#906)', () => {
  /** What the picker would save for these rects, read back through the Copy box (the real cell state). */
  const savedText = (rects) => JSON.stringify(cellsToRects(rectsToCells(rects)));
  /** Open Copy / paste, read the box, close again. Reads the picker's CELLS, not just its hint. */
  async function copyBoxNow(user) {
    await user.click(copyPasteBtn());
    const text = copyBox().value;
    await user.click(screen.getByRole('button', { name: 'Close' }));
    return text;
  }

  test('the click opens a confirmation with Cancel focused, and clears nothing yet', async () => {
    const onChange = vi.fn();
    const { user } = showZone({ zone: ZONE_A, onChange });
    await user.click(wholeFrameBtn());
    expect(hasDialog('Use the whole frame?')).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    // Cancel holds the focus so Enter on the dialog is the safe answer.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByText(/Covering 13% of the view/)).toBeInTheDocument();
  });

  test.each([
    ['Cancel', async (user) => user.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['Escape', async (user) => user.keyboard('{Escape}')],
    ['a click on the overlay', async () => fireEvent.click(document.querySelector('.modal-overlay'))],
  ])('%s leaves the zone and onChange exactly as they were, and focus returns to the button', async (_name, leave) => {
    const onChange = vi.fn();
    const { user } = showZone({ zone: ZONE_A, onChange });
    await user.click(wholeFrameBtn());
    await leave(user);

    expect(hasDialog('Use the whole frame?')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Covering 13% of the view/)).toBeInTheDocument();
    expect(wholeFrameBtn()).toHaveFocus();
    // The cells themselves, not only the hint, are untouched.
    expect(await copyBoxNow(user)).toBe(savedText(ZONE_A));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('Confirm clears once, with null (not an empty list)', async () => {
    const onChange = vi.fn();
    const { user } = showZone({ zone: ZONE_A, onChange });
    await user.click(wholeFrameBtn());
    await user.click(screen.getByRole('button', { name: 'Use whole frame' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
    expect(hasDialog('Use the whole frame?')).toBe(false);
    expect(wholeFrameBtn()).toBeDisabled();
  });
});

// --- #905: copy and paste a zone -------------------------------------------------------------------

describe('parseZoneText', () => {
  test('accepts the legacy single object and ignores extra keys', () => {
    // rectsToCells still reads the single-rect shape the backend still reads, so a paste does too.
    const res = parseZoneText('{"x":0,"y":0,"w":0.5,"h":0.5,"label":"bed","extra":[1]}');
    expect(res.ok).toBe(true);
    expect(res.rects).toEqual(cellsToRects(rectsToCells([{ x: 0, y: 0, w: 0.5, h: 0.5 }])));
    for (const r of res.rects) expect(Object.keys(r).sort()).toEqual(['h', 'w', 'x', 'y']);
  });

  test('tolerates the float noise that makes x + w a hair over 1, but not a real overshoot', () => {
    // 0.5 + 0.5000000000000002 is 1.0000000000000002 in floating point (0.5000000000000001 would round back to 1).
    expect(parseZoneText('[{"x":0.5,"y":0,"w":0.5000000000000002,"h":1}]').ok).toBe(true);
    expect(parseZoneText('[{"x":0.5,"y":0,"w":0.50001,"h":1}]')).toMatchObject({ ok: false });
    expect(parseZoneText('[{"x":0,"y":0.5,"w":1,"h":0.50001}]')).toMatchObject({ ok: false });
  });

  test('snaps to the grid: a sliver becomes one whole cell, which survives the backend drop rule', () => {
    // serializeZone silently drops any rect with w or h <= 0.02. A grid rect is at least 1/32 x 1/18.
    const res = parseZoneText('[{"x":0.04,"y":0.01,"w":0.01,"h":0.03}]');
    expect(res.ok).toBe(true);
    expect(res.rects).toEqual(cellsToRects(paint([1], [0])));
    for (const r of res.rects) {
      expect(r.w).toBeGreaterThan(0.02);
      expect(r.h).toBeGreaterThan(0.02);
    }
  });

  test('the size cap is checked, and the cap itself is accepted', () => {
    const atCap = '[{"x":0,"y":0,"w":1,"h":1}]'.padEnd(MAX_ZONE_TEXT, ' ');
    expect(atCap).toHaveLength(MAX_ZONE_TEXT);
    expect(parseZoneText(atCap).ok).toBe(true);
    expect(parseZoneText(`${atCap} `)).toMatchObject({ ok: false, reason: expect.stringMatching(/too long/) });
  });

  test('exactly one rect per cell is the most allowed', () => {
    const cell = '{"x":0,"y":0,"w":0.1,"h":0.1}';
    expect(parseZoneText(`[${Array(COLS * ROWS).fill(cell).join(',')}]`).ok).toBe(true);
    expect(parseZoneText(`[${Array(COLS * ROWS + 1).fill(cell).join(',')}]`)).toMatchObject({ ok: false });
  });
});

describe('Copy / paste zone (#905)', () => {
  test('round trip: what Copy shows, pasted into a fresh picker, gives the SAME zone cell by cell', async () => {
    const original = raggedCells();
    const rects = cellsToRects(original);
    const first = showZone({ zone: rects });
    await first.user.click(copyPasteBtn());
    const text = copyBox().value;
    expect(JSON.parse(text)).toEqual(rects);
    first.unmount();

    const onChange = vi.fn();
    const { user } = showZone({ zone: null, onChange });
    await user.click(copyPasteBtn());
    typeZone(text);
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    // Nothing was painted, so there was nothing to lose: no confirmation.
    expect(hasDialog('Replace the bed area?')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(rects);
    // Cell by cell, not by count (two zones can cover as many cells and be in different places).
    expect([...rectsToCells(onChange.mock.calls[0][0])]).toEqual([...original]);
    // The modal closes so the zone shows over the frame, and the hint asks for the check nothing else does.
    expect(hasDialog('Copy or paste the bed area')).toBe(false);
    expect(screen.getByText(/Pasted zone applied\. Check it covers the bed\./)).toBeInTheDocument();
  });

  test('Copy is dead and the box says so when nothing is painted', async () => {
    const { user } = showZone({ zone: null });
    await user.click(copyPasteBtn());
    expect(copyBox().value).toMatch(/whole frame/);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
  });

  test('Apply is dead while the paste box is blank', async () => {
    const { user } = showZone({ zone: ZONE_A });
    await user.click(copyPasteBtn());
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    typeZone('   ');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    typeZone('[]');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  // Each of these is text a person could really paste, and each must leave the zone, the saved value and
  // the hint exactly as they were, with a reason in the dialog. The zone is PAINTED so a wrongly accepted
  // paste would show up as a confirmation dialog or an onChange call.
  test.each([
    ['not JSON', 'hello', /does not look like a bed area/],
    ['null', 'null', /does not look like a bed area/],
    ['a bare number', '5', /does not look like a bed area/],
    ['a bare string', '"abc"', /does not look like a bed area/],
    ['an empty list', '[]', /whole frame/],
    ['577 rects', `[${Array(COLS * ROWS + 1).fill('{"x":0,"y":0,"w":0.1,"h":0.1}').join(',')}]`, /more than 576/],
    ['a missing field', '[{"x":0,"y":0,"w":0.5}]', /numbers for x, y, w and h/],
    ['a string field', '[{"x":"0","y":0,"w":0.5,"h":0.5}]', /numbers for x, y, w and h/],
    ['an infinite field (1e999)', '[{"x":0,"y":0,"w":1e999,"h":0.5}]', /numbers for x, y, w and h/],
    ['a null rect in the list', '[null]', /numbers for x, y, w and h/],
    ['a negative x', '[{"x":-0.1,"y":0,"w":0.5,"h":0.5}]', /inside the frame/],
    ['a value over 1', '[{"x":0,"y":0,"w":0.5,"h":1.5}]', /inside the frame/],
    ['x + w over 1', '[{"x":0.6,"y":0,"w":0.5,"h":0.5}]', /inside the frame/],
    ['y + h over 1', '[{"x":0,"y":0.6,"w":0.5,"h":0.5}]', /inside the frame/],
    ['a zero width', '[{"x":0,"y":0,"w":0,"h":0.5}]', /above 0/],
    ['a zero height', '[{"x":0,"y":0,"w":0.5,"h":0}]', /above 0/],
    ['text over the size cap', `${' '.repeat(MAX_ZONE_TEXT)}[{"x":0,"y":0,"w":1,"h":1}]`, /too long/],
    ['a rect that covers no cell centre', '[{"x":0.001,"y":0.001,"w":0.01,"h":0.01}]', /covers no squares/],
  ])('refuses %s, with a reason, and changes nothing', async (_name, text, reason) => {
    const onChange = vi.fn();
    const { user } = showZone({ zone: ZONE_A, onChange });
    await user.click(copyPasteBtn());
    const before = copyBox().value;
    typeZone(text);
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(screen.getByRole('alert').textContent).toMatch(reason);
    expect(onChange).not.toHaveBeenCalled();
    expect(hasDialog('Replace the bed area?')).toBe(false);
    expect(copyBox().value).toBe(before);
    expect(screen.getByText(/Covering 13% of the view/)).toBeInTheDocument();
    expect(screen.queryByText(/Pasted zone applied/)).toBeNull();
  });

  test('the reason goes away as soon as the text is edited', async () => {
    const { user } = showZone({ zone: null });
    await user.click(copyPasteBtn());
    typeZone('hello');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    typeZone('[]');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('over a painted zone it asks first', () => {
    const NEW_ZONE = [{ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }];
    async function pasteNew(props = {}) {
      const ctx = showZone({ zone: ZONE_A, ...props });
      await ctx.user.click(copyPasteBtn());
      typeZone(JSON.stringify(NEW_ZONE));
      await ctx.user.click(screen.getByRole('button', { name: 'Apply' }));
      return ctx;
    }

    test('Apply opens the confirmation and saves nothing yet', async () => {
      const onChange = vi.fn();
      await pasteNew({ onChange });
      expect(hasDialog('Replace the bed area?')).toBe(true);
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });

    test('Cancel and Escape leave the old zone and keep the paste dialog open with the text', async () => {
      const onChange = vi.fn();
      const { user } = await pasteNew({ onChange });
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(hasDialog('Replace the bed area?')).toBe(false);
      expect(hasDialog('Copy or paste the bed area')).toBe(true);
      expect(pasteBox().value).toBe(JSON.stringify(NEW_ZONE));

      await user.click(screen.getByRole('button', { name: 'Apply' }));
      expect(hasDialog('Replace the bed area?')).toBe(true);
      // Escape belongs to the dialog on top: it closes the confirmation, not the paste dialog under it.
      await user.keyboard('{Escape}');
      expect(hasDialog('Replace the bed area?')).toBe(false);
      expect(hasDialog('Copy or paste the bed area')).toBe(true);

      expect(onChange).not.toHaveBeenCalled();
      expect(copyBox().value).toBe(JSON.stringify(cellsToRects(rectsToCells(ZONE_A))));
    });

    test('Confirm replaces the zone with ONE onChange and closes both dialogs', async () => {
      const onChange = vi.fn();
      const { user } = await pasteNew({ onChange });
      await user.click(screen.getByRole('button', { name: 'Replace' }));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(cellsToRects(rectsToCells(NEW_ZONE)));
      expect(hasDialog('Replace the bed area?')).toBe(false);
      expect(hasDialog('Copy or paste the bed area')).toBe(false);
      // 8 columns x 5 rows = 40 of 576 cells = 6.9%, shown as 7%, where the old zone read 13%.
      expect(screen.getByText(/Covering 7% of the view/)).toBeInTheDocument();
    });
  });

  describe('without clipboard access (plain http has no navigator.clipboard)', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const setClipboard = (value) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
    afterEach(() => {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete navigator.clipboard;
      delete document.execCommand;
    });

    test('the dialog still opens with the text in a box, and Copy falls back without throwing', async () => {
      const { user } = showZone({ zone: ZONE_A });
      setClipboard(undefined);
      await user.click(copyPasteBtn());
      expect(copyBox().value).toBe(JSON.stringify(cellsToRects(rectsToCells(ZONE_A))));

      // No execCommand either (jsdom has none): the person is told to copy by hand.
      await user.click(screen.getByRole('button', { name: 'Copy' }));
      expect(screen.getByRole('status').textContent).toMatch(/Select the text and copy it yourself/);
    });

    test('and execCommand("copy") is used when it works', async () => {
      const { user } = showZone({ zone: ZONE_A });
      setClipboard(undefined);
      document.execCommand = vi.fn(() => true);
      await user.click(copyPasteBtn());
      await user.click(screen.getByRole('button', { name: 'Copy' }));
      expect(document.execCommand).toHaveBeenCalledWith('copy');
      expect(screen.getByRole('status').textContent).toBe('Copied.');
    });

    test('a clipboard that refuses (permission denied) falls back instead of failing', async () => {
      const { user } = showZone({ zone: ZONE_A });
      setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
      await user.click(copyPasteBtn());
      await user.click(screen.getByRole('button', { name: 'Copy' }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/copy it yourself/));
    });

    test('with a working clipboard, Copy writes exactly the box text', async () => {
      const { user } = showZone({ zone: ZONE_A });
      const writeText = vi.fn().mockResolvedValue(undefined);
      setClipboard({ writeText });
      await user.click(copyPasteBtn());
      await user.click(screen.getByRole('button', { name: 'Copy' }));
      expect(writeText).toHaveBeenCalledWith(copyBox().value);
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied.'));
    });
  });
});
