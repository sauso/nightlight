import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// Paint the crib area onto a grid laid over a live camera still (detect_zone). The pixel-diff
// motion + sleep-activity leg only looks inside the painted cells, so a fan or a parent walking
// past outside the crib doesn't count as the baby moving. Nothing painted = whole frame.
//
// This replaced a drag-a-rectangle picker: the cameras look down into the crib on a diagonal, and
// an axis-aligned box either clips the cot or drags in a slab of floor and wall. Painting follows
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

const COLS = 32;
const ROWS = 18;
const N = COLS * ROWS;

const FILL_ALPHA = 0.55; // solid enough to read as a highlight, sheer enough to check the fit
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// 5dp keeps every column edge exact (1/32 = 0.03125) and every row edge within 0.0008 of an analysis
// pixel, which the detector's round-to-nearest edge mapping absorbs — see buildZoneMask.
const q = (v) => +v.toFixed(5);

const toRects = (zone) => (!zone ? [] : Array.isArray(zone) ? zone : [zone]);

// Stored rects -> painted cells. A cell is on when its centre falls inside any rect, which is exact
// for a zone this picker wrote and a sane approximation for an older hand-drawn box.
function rectsToCells(zone) {
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
function cellsToRects(cells) {
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

export default function CribZonePicker({ cameraId, zone, onChange }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const cellsRef = useRef(rectsToCells(zone));
  const dragRef = useRef(null);
  const [imgState, setImgState] = useState('loading'); // loading | ok | error
  const [nonce, setNonce] = useState(0);
  const [count, setCount] = useState(() => countOn(cellsRef.current));

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

  function clearAll() {
    cellsRef.current = new Uint8Array(N);
    setCount(0);
    draw();
    onChange(null);
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
            ? `Covering ${Math.round((count / N) * 100)}% of the view. Drag over painted squares to rub them out.`
            : 'Drag across the squares covering the cot to paint the crib area. Drag back over them to rub out.'}
        </span>
        <div className="crib__btns">
          <button type="button" className="btn btn-secondary btn-sm" onClick={refresh}>Refresh frame</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={clearAll} disabled={!count}>Whole frame</button>
        </div>
      </div>
    </div>
  );
}
