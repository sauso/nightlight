import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';

// NAMING: the component and its CSS classes are still `Crib*`/`.crib__*`, and the column is still
// `detect_zone`, but all user-facing wording is "bed" — the rename deliberately stopped short of
// identifiers and schema. Same concept, different vintage of name.
// Paint the bed area onto a grid laid over a live camera still (detect_zone). The pixel-diff
// motion + sleep-activity leg only looks inside the painted cells, so a fan or a parent walking
// past outside the bed doesn't count as the baby moving. Nothing painted = whole frame.
//
// This replaced a drag-a-rectangle picker: the cameras look down into the bed on a diagonal, and
// an axis-aligned box either clips the bed or drags in a slab of floor and wall. Painting follows
// the shape.
//
// The grid is 32x18 because the detector analyses a 320x180 gray frame (motionDetector.js), so one
// cell is exactly 10x10 analysis pixels — the grid is the detector's own working resolution, and a
// finer one would only pretend to be more precise than the thing consuming it.
//
// STORAGE IS UNCHANGED — still a list of {x,y,w,h} frame fractions, so the backend, every stored
// zone and the legacy single-rect shape all keep working untouched. Painted cells are run-length
// encoded into rects on the way out and rasterised back on the way in; the grid is fixed, so a
// grid-painted zone round-trips through the database exactly.

// Exported for tests. vite.config.js's coverage note is explicit that a component's pure logic
// should be extracted into exported helpers rather than left buried where nothing can reach it —
// and the round-trip below is a claim this file's header makes ("a grid-painted zone round-trips
// through the database exactly") that nothing checked.
export const COLS = 32;
export const ROWS = 18;
const N = COLS * ROWS;

const FILL_ALPHA = 0.55; // solid enough to read as a highlight, sheer enough to check the fit
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// 5dp keeps every column edge exact (1/32 = 0.03125) and every row edge within 0.0008 of an analysis
// pixel, which the detector's round-to-nearest edge mapping absorbs — see buildZoneMask.
const q = (v) => +v.toFixed(5);

const toRects = (zone) => (!zone ? [] : Array.isArray(zone) ? zone : [zone]);

// Stored rects -> painted cells. A cell is on when its centre falls inside any rect, which is exact
// for a zone this picker wrote and a sane approximation for an older hand-drawn box.
export function rectsToCells(zone) {
  const cells = new Uint8Array(N);
  for (const r of toRects(zone)) {
    if (!r || !['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number')) continue;
    for (let row = 0; row < ROWS; row++) {
      const cy = (row + 0.5) / ROWS;
      if (cy < r.y || cy > r.y + r.h) continue;
      for (let col = 0; col < COLS; col++) {
        const cx = (col + 0.5) / COLS;
        if (cx >= r.x && cx <= r.x + r.w) cells[row * COLS + col] = 1;
      }
    }
  }
  return cells;
}

// Painted cells -> the smallest sensible list of rects: horizontal runs per row, each grown down
// into the row above it when the columns line up. A solid blob stores as a handful of rects rather
// than one per row. Edges are rounded (not widths) so neighbouring rects stay flush.
export function cellsToRects(cells) {
  const out = [];
  for (let row = 0; row < ROWS; row++) {
    const y0 = q(row / ROWS);
    const y1 = q((row + 1) / ROWS);
    let col = 0;
    while (col < COLS) {
      if (!cells[row * COLS + col]) { col++; continue; }
      const start = col;
      while (col < COLS && cells[row * COLS + col]) col++;
      const x = q(start / COLS);
      const w = q(q(col / COLS) - x);
      const above = out.find((p) => p.x === x && p.w === w && q(p.y + p.h) === y0);
      if (above) above.h = q(y1 - above.y);
      else out.push({ x, y: y0, w, h: q(y1 - y0) });
    }
  }
  return out;
}

const countOn = (cells) => cells.reduce((n, v) => n + v, 0);

// --- pasting a zone (#905) ------------------------------------------------------------------------
// A pasted zone is written straight to the camera's stored detect_zone (the picker autosaves) and the
// detector restarts on it, and nothing downstream checks that a zone sits on the bed. So the text is
// held to exactly the shape this picker writes, and anything else is refused with a reason rather than
// "fixed up": a guess at what someone meant is a wrong zone saved silently.

// A zone this picker writes is a few hundred bytes (a ragged hand-painted bed is a few dozen rects, ~40
// bytes each). 100 000 characters is hundreds of times the largest it could ever produce (576 rects,
// ~25 KB), so it only refuses text that is not a zone at all, before JSON.parse spends time on it.
export const MAX_ZONE_TEXT = 100000;
// A tolerance on the "stays inside the frame" bound. Checked on every grid edge, the picker's own Copy output
// never sums above 1, so this is not what lets it paste back; it keeps a hand-edited or other-tool zone that
// is a floating-point hair over 1 (x + w = 1.0000000000000002) from being refused for a rounding error.
const EDGE_EPS = 1e-6;

const refuse = (reason) => ({ ok: false, reason });

// Pasted text -> { ok: true, rects } (already snapped to the grid) or { ok: false, reason } in plain words.
// Accepts the stored shape: a list of {x,y,w,h}, or one bare object (the legacy single-rect shape the
// backend still reads, and rectsToCells still accepts). Extra keys are ignored, and are gone after the snap.
export function parseZoneText(text) {
  if (typeof text !== 'string' || text.length > MAX_ZONE_TEXT) return refuse('That text is too long to be a bed area.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return refuse('That does not look like a bed area. Paste the text exactly as Copy gave it.'); }
  if (parsed === null || typeof parsed !== 'object') return refuse('That does not look like a bed area. Paste the text exactly as Copy gave it.');

  const list = Array.isArray(parsed) ? parsed : [parsed];
  // An empty list is "no zone", which the backend reads as the whole frame. Say so rather than apply it: the
  // Whole frame button is the deliberate way to get there, and it asks first.
  if (list.length === 0) return refuse('An empty list would mean the whole frame. Use the Whole frame button instead.');
  // One rect per cell is the most the picker can ever write, so more than that is not from here and would
  // only make the backend and the detector chew on a long list.
  if (list.length > N) return refuse(`That has more than ${N} shapes, which is more than the grid can hold.`);

  for (const r of list) {
    // `1e999` parses to Infinity, which is typeof 'number'; isFinite is what catches it.
    if (!r || typeof r !== 'object' || !['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))) {
      return refuse('Every shape needs numbers for x, y, w and h.');
    }
    if (r.w <= 0 || r.h <= 0) return refuse('Every shape needs a width and height above 0.');
    if ([r.x, r.y, r.w, r.h].some((v) => v < 0 || v > 1) || r.x + r.w > 1 + EDGE_EPS || r.y + r.h > 1 + EDGE_EPS) {
      return refuse('Every shape must sit inside the frame, with numbers between 0 and 1.');
    }
  }

  // Snap to the grid so what is shown is exactly what is saved. It also means a thin pasted sliver can
  // never reach the backend's silent drop of any rect with w or h <= 0.02 (serializeZone): a grid rect is
  // at least one cell, 1/32 wide and 1/18 tall, both over that line.
  const rects = cellsToRects(rectsToCells(list));
  if (rects.length === 0) return refuse('That area covers no squares of the grid.');
  return { ok: true, rects };
}

// The one confirmation both ways of replacing a painted zone share ("Whole frame" and a paste, #906/#905).
// Cancel comes first and holds the autofocus, so Enter on the dialog never does the destructive thing; the
// danger button is the other one. Same pattern as the caregiver Remove dialog. Escape and the overlay click
// close it from Modal and mean Cancel.
function ReplaceZoneConfirm({ title, message, confirmLabel, onCancel, onConfirm }) {
  return (
    <Modal title={title} placement="top" onClose={onCancel}>
      <p style={{ marginTop: 0 }}>{message}</p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" type="button" data-autofocus onClick={onCancel}>Cancel</button>
        <button className="btn btn-danger" type="button" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

export default function CribZonePicker({ cameraId, zone, onChange }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const cellsRef = useRef(rectsToCells(zone));
  const dragRef = useRef(null);
  const [imgState, setImgState] = useState('loading'); // loading | ok | error
  const [nonce, setNonce] = useState(0);
  const [count, setCount] = useState(() => countOn(cellsRef.current));
  // Which replace-the-zone confirmation is open (#906, #905): null, { kind: 'clear' } or { kind: 'paste', rects }.
  // The pasted rects ride along so Confirm applies exactly what was parsed and shown, not a re-parse.
  const [confirm, setConfirm] = useState(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState(''); // the Apply button's own failure, shown inside the modal
  const [copyNote, setCopyNote] = useState('');
  // True from a successful paste until the next stroke, so the hint asks for the one check nothing else does.
  const [pasted, setPasted] = useState(false);
  const copyBoxRef = useRef(null);

  const src = (() => {
    const b = api.url(`/cameras/${cameraId}/snapshot`);
    return `${b}${b.includes('?') ? '&' : '?'}_=${nonce}`;
  })();

  // The canvas is painted imperatively rather than through React: a drag touches cells at pointer
  // rate, and re-rendering hundreds of elements per move is exactly the jank this picker exists to
  // avoid. React only re-renders for the coverage readout.
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const stage = wrapRef.current;
    if (!cv || !stage) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;

    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cw = w / COLS;
    const ch = h / ROWS;
    // Read the accent live: it's user-recolourable in Settings, so hardcoding it here would leave
    // the zone gold on somebody's blue theme.
    const accent = getComputedStyle(stage).getPropertyValue('--accent').trim() || '#f4c56a';
    const cells = cellsRef.current;
    const on = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS && cells[r * COLS + c];
    // Rounding both edges of every cell (rather than a position plus a width) means neighbours land
    // on the same device pixel — no hairline seams through the middle of a filled blob.
    const gx = (c) => Math.round(c * cw);
    const gy = (r) => Math.round(r * ch);

    ctx.fillStyle = accent;
    ctx.globalAlpha = FILL_ALPHA;
    for (let r = 0; r < ROWS; r++) {
      let c = 0;
      while (c < COLS) {
        if (!cells[r * COLS + c]) { c++; continue; }
        const s = c;
        while (c < COLS && cells[r * COLS + c]) c++;
        ctx.fillRect(gx(s), gy(r), gx(c) - gx(s), gy(r + 1) - gy(r));
      }
    }

    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; // has to stay readable over a bright wall and over IR
    ctx.beginPath();
    for (let c = 1; c < COLS; c++) { const x = gx(c) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let r = 1; r < ROWS; r++) { const y = gy(r) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();

    // Outline only the border of the painted region, so the zone reads as one shape instead of a
    // mosaic of squares.
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!on(r, c)) continue;
        const x0 = gx(c); const x1 = gx(c + 1); const y0 = gy(r); const y1 = gy(r + 1);
        if (!on(r - 1, c)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); }
        if (!on(r + 1, c)) { ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); }
        if (!on(r, c - 1)) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); }
        if (!on(r, c + 1)) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
      }
    }
    ctx.stroke();
  }, []);

  // Re-sync from the parent when we're not mid-drag (e.g. after a save round-trip).
  useEffect(() => {
    if (dragRef.current) return;
    cellsRef.current = rectsToCells(zone);
    setCount(countOn(cellsRef.current));
    draw();
  }, [zone, draw]);

  // The stage tracks the image's aspect, so it resizes with the viewport and on rotation.
  useEffect(() => {
    const stage = wrapRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [draw]);

  function frac(e) {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }
  const cellAt = (p) => Math.min(ROWS - 1, Math.floor(p.y * ROWS)) * COLS + Math.min(COLS - 1, Math.floor(p.x * COLS));

  function apply(i) {
    const d = dragRef.current;
    if (!d || cellsRef.current[i] === d.mode) return false;
    cellsRef.current[i] = d.mode;
    return true;
  }

  function onDown(e) {
    if (imgState !== 'ok') return;
    e.preventDefault();
    wrapRef.current.setPointerCapture?.(e.pointerId);
    const p = frac(e);
    const i = cellAt(p);
    // The first cell decides the stroke: start on a painted cell and you're erasing, the way a
    // toggle brush works everywhere else.
    dragRef.current = { mode: cellsRef.current[i] ? 0 : 1, last: p };
    setPasted(false); // the person is editing the zone now, so "check the pasted zone" no longer applies
    apply(i);
    draw();
    setCount(countOn(cellsRef.current));
  }

  function onMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const p = frac(e);
    // Walk the segment since the last event, or a fast drag skips cells and leaves gaps in the
    // stroke — pointermove doesn't fire per pixel.
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(p.x - d.last.x) * COLS, Math.abs(p.y - d.last.y) * ROWS)));
    let changed = false;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      changed = apply(cellAt({ x: d.last.x + (p.x - d.last.x) * t, y: d.last.y + (p.y - d.last.y) * t })) || changed;
    }
    d.last = p;
    if (!changed) return;
    draw();
    setCount(countOn(cellsRef.current));
  }

  function onUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    const rects = cellsToRects(cellsRef.current);
    onChange(rects.length ? rects : null);
  }

  // The zone autosaves and every save restarts the detector, so one stray tap on "Whole frame" used to wipe
  // a painted bed area with no way back (#906, it happened). The button only asks; confirmClear does it.
  function clearAll() {
    setConfirm({ kind: 'clear' });
  }

  function confirmClear() {
    setConfirm(null);
    setPasted(false);
    cellsRef.current = new Uint8Array(N);
    setCount(0);
    draw();
    onChange(null);
  }

  // Writes a parsed (already grid-snapped) zone the way painting does: through the SAME onChange, so it takes
  // the same path to PUT /cameras/:id/detection, and the parent hands it back as `zone` like any other save.
  function commitPaste(rects) {
    cellsRef.current = rectsToCells(rects);
    setCount(countOn(cellsRef.current));
    setPasted(true);
    setConfirm(null);
    setPasteOpen(false); // closed so the new zone shows over the live frame, which is what needs checking
    setPasteText('');
    setPasteError('');
    draw();
    onChange(rects);
  }

  function applyPaste() {
    const res = parseZoneText(pasteText);
    if (!res.ok) { setPasteError(res.reason); return; }
    setPasteError('');
    // Replacing a painted zone asks first, like Whole frame. With nothing painted there is nothing to lose.
    if (count > 0) setConfirm({ kind: 'paste', rects: res.rects });
    else commitPaste(res.rects);
  }

  function openPaste() {
    setPasteText('');
    setPasteError('');
    setCopyNote('');
    setPasteOpen(true);
  }

  // What the picker would save right now, so a pasted copy reproduces this zone exactly.
  const zoneText = count ? JSON.stringify(cellsToRects(cellsRef.current)) : '';

  // Copies the box. navigator.clipboard exists only in a secure context (https or localhost), and Nightlight
  // is often run over plain http on a home network, so it is optional: try it, then select the text and ask
  // the browser to copy it, then say how to do it by hand. The box is selectable text in every case, so
  // nobody is ever stuck.
  async function copyZone() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(zoneText);
        setCopyNote('Copied.');
        return;
      }
    } catch { /* denied or unavailable: fall through to the next way */ }
    try {
      const box = copyBoxRef.current;
      box.focus();
      box.select();
      if (document.execCommand('copy')) { setCopyNote('Copied.'); return; }
    } catch { /* no execCommand either */ }
    setCopyNote('Select the text and copy it yourself.');
  }

  function refresh() {
    setImgState('loading');
    setNonce((n) => n + 1);
  }

  return (
    <div className="crib">
      <div
        ref={wrapRef}
        className={`crib__stage${imgState === 'ok' ? ' is-ready' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <img className="crib__img" src={src} alt="Camera view" draggable="false"
          onLoad={() => { setImgState('ok'); draw(); }} onError={() => setImgState('error')} />
        <canvas ref={canvasRef} className="crib__canvas" hidden={imgState !== 'ok'} />
        {imgState === 'loading' && <div className="crib__msg">Grabbing a frame…</div>}
        {imgState === 'error' && (
          <div className="crib__msg">
            Couldn’t grab a frame. <button type="button" className="linkbtn" onClick={refresh}>Try again</button>
          </div>
        )}
      </div>
      <div className="crib__row">
        <span className="camera-tile__sub">
          {count
            ? `${pasted ? 'Pasted zone applied. Check it covers the bed. ' : ''}Covering ${Math.round((count / N) * 100)}% of the view. Drag over painted squares to rub them out.`
            : 'Drag across the squares covering the bed to paint the bed area. Drag back over them to rub out.'}
        </span>
        <div className="crib__btns">
          <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}>Refresh frame</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={openPaste}>Copy / paste zone</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={clearAll} disabled={!count}>Whole frame</button>
        </div>
      </div>

      {pasteOpen && (
        <Modal title="Copy or paste the bed area" placement="top" error={pasteError} onClose={() => setPasteOpen(false)}>
          <div className="field">
            <label htmlFor="zone-copy">This camera’s bed area</label>
            <textarea
              id="zone-copy"
              ref={copyBoxRef}
              className="crib__text"
              rows={4}
              readOnly
              spellCheck={false}
              value={zoneText || '(whole frame, nothing painted)'}
              // Selecting the lot on focus makes a manual copy one keystroke, which is the way out where the
              // clipboard is blocked.
              onFocus={(e) => e.target.select()}
            />
            <div className="crib__btns" style={{ marginTop: 8, alignItems: 'center' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={copyZone} disabled={!count}>Copy</button>
              {copyNote && <span className="camera-tile__sub" role="status">{copyNote}</span>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="zone-paste">Paste a bed area</label>
            <textarea
              id="zone-paste"
              className="crib__text"
              rows={4}
              spellCheck={false}
              autoComplete="off"
              placeholder='[{"x":0.2,"y":0.3,"w":0.4,"h":0.5}]'
              value={pasteText}
              onChange={(e) => { setPasteError(''); setPasteText(e.target.value); }}
            />
            <div className="camera-tile__sub" style={{ marginTop: 6 }}>
              A bed area is a share of the picture, not a position on the bed. Pasted onto a camera with a different
              view, it lands in the same place of a different picture, so check it over the live frame afterwards.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" type="button" onClick={applyPaste} disabled={!pasteText.trim()}>Apply</button>
          </div>
        </Modal>
      )}

      {confirm && (
        <ReplaceZoneConfirm
          title={confirm.kind === 'clear' ? 'Use the whole frame?' : 'Replace the bed area?'}
          message={confirm.kind === 'clear'
            ? 'The painted area will be cleared and the camera will watch the whole frame. This is saved straight away.'
            : 'This replaces the painted area with the pasted one and saves straight away.'}
          confirmLabel={confirm.kind === 'clear' ? 'Use whole frame' : 'Replace'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => (confirm.kind === 'clear' ? confirmClear() : commitPaste(confirm.rects))}
        />
      )}
    </div>
  );
}
