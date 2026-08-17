import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// Draw one or more rectangles over a live camera still to set the crib area (detect_zone). The
// pixel-diff motion + sleep-activity leg only looks inside them, so a fan or a parent walking past
// outside the crib doesn't count as the baby moving. Multiple boxes let a crib on a diagonal be
// covered by a few axis-aligned rectangles. Empty = whole frame.

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const MIN = 0.04; // boxes smaller than this on either axis are discarded (treated as a stray click)
const CORNERS = [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]];

// The zone prop may be a list of rects, a legacy single rect, or null — normalise to an array.
const toRects = (zone) => (!zone ? [] : Array.isArray(zone) ? zone : [zone]);

export default function CribZonePicker({ cameraId, zone, onChange }) {
  const wrapRef = useRef(null);
  const dragRef = useRef(null);
  const [imgState, setImgState] = useState('loading'); // loading | ok | error
  const [nonce, setNonce] = useState(0);
  const [rects, setRects] = useState(() => toRects(zone));
  const [selected, setSelected] = useState(-1);

  // Re-sync from the parent when we're not mid-drag (e.g. after a save round-trip).
  useEffect(() => { if (!dragRef.current) setRects(toRects(zone)); }, [zone]);

  const src = (() => {
    const b = api.url(`/cameras/${cameraId}/snapshot`);
    return `${b}${b.includes('?') ? '&' : '?'}_=${nonce}`;
  })();

  function frac(e) {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  function onDown(e) {
    if (imgState !== 'ok') return;
    const handle = e.target.getAttribute?.('data-handle');
    const rectAttr = e.target.getAttribute?.('data-rect');
    e.preventDefault();
    wrapRef.current.setPointerCapture?.(e.pointerId);
    const start = frac(e);
    if (handle != null) {
      const idx = Number(e.target.getAttribute('data-idx'));
      setSelected(idx);
      dragRef.current = { mode: handle, idx, start, orig: rects[idx] };
    } else if (rectAttr != null) {
      const idx = Number(rectAttr);
      setSelected(idx);
      dragRef.current = { mode: 'move', idx, start, orig: rects[idx] };
    } else {
      const idx = rects.length; // draw a new box on top
      setRects((prev) => [...prev, { x: start.x, y: start.y, w: 0, h: 0 }]);
      setSelected(idx);
      dragRef.current = { mode: 'draw', idx, start, orig: { x: start.x, y: start.y, w: 0, h: 0 } };
    }
  }

  function onMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const p = frac(e);
    setRects((prev) => {
      const next = prev.slice();
      const o = d.orig;
      if (d.mode === 'draw') {
        next[d.idx] = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
      } else if (d.mode === 'move') {
        next[d.idx] = { ...o, x: clamp01(Math.min(o.x + (p.x - d.start.x), 1 - o.w)), y: clamp01(Math.min(o.y + (p.y - d.start.y), 1 - o.h)) };
      } else {
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        if (d.mode.includes('w')) x0 = p.x;
        if (d.mode.includes('e')) x1 = p.x;
        if (d.mode.includes('n')) y0 = p.y;
        if (d.mode.includes('s')) y1 = p.y;
        next[d.idx] = { x: clamp01(Math.min(x0, x1)), y: clamp01(Math.min(y0, y1)), w: clamp01(Math.abs(x1 - x0)), h: clamp01(Math.abs(y1 - y0)) };
      }
      return next;
    });
  }

  function onUp() {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setRects((prev) => {
      let next = prev.slice();
      const r = next[d.idx];
      if (!r || r.w < MIN || r.h < MIN) {
        next = next.filter((_, i) => i !== d.idx); // discard a too-small box / stray click
        setSelected(-1);
      } else {
        next[d.idx] = { x: +r.x.toFixed(3), y: +r.y.toFixed(3), w: +r.w.toFixed(3), h: +r.h.toFixed(3) };
      }
      onChange(next.length ? next : null);
      return next;
    });
  }

  function removeSelected() {
    if (selected < 0) return;
    const next = rects.filter((_, i) => i !== selected);
    setSelected(-1);
    setRects(next);
    onChange(next.length ? next : null);
  }
  function clearAll() {
    setSelected(-1);
    setRects([]);
    onChange(null);
  }

  const pct = (v) => `${(v * 100).toFixed(2)}%`;

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
          onLoad={() => setImgState('ok')} onError={() => setImgState('error')} />
        {imgState === 'loading' && <div className="crib__msg">Grabbing a frame…</div>}
        {imgState === 'error' && (
          <div className="crib__msg">
            Couldn’t grab a frame. <button type="button" className="linkbtn" onClick={() => { setImgState('loading'); setNonce((n) => n + 1); }}>Try again</button>
          </div>
        )}
        {imgState === 'ok' && rects.map((z, i) => (
          <div key={i} data-rect={i} className={`crib__zone${i === selected ? ' is-sel' : ''}`}
            style={{ left: pct(z.x), top: pct(z.y), width: pct(z.w), height: pct(z.h) }}>
            {i === selected && CORNERS.map(([h, cx, cy]) => (
              <span key={h} data-handle={h} data-idx={i} className="crib__handle" style={{ left: pct(cx), top: pct(cy) }} />
            ))}
          </div>
        ))}
      </div>
      <div className="crib__row">
        <span className="camera-tile__sub">
          {rects.length
            ? 'Drag on an empty area to add another box; tap a box to move or resize it. Use a few boxes for an angled crib.'
            : 'Drag on the image to draw the crib area — add more than one box for an angled crib.'}
        </span>
        <div className="crib__btns">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setImgState('loading'); setNonce((n) => n + 1); }}>Refresh frame</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={removeSelected} disabled={selected < 0}>Remove box</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={clearAll} disabled={!rects.length}>Whole frame</button>
        </div>
      </div>
    </div>
  );
}
