import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// Draw/move/resize a rectangle over a live camera still to set the crib area (detect_zone, {x,y,w,h} in
// 0..1 frame fractions). The pixel-diff motion + sleep-activity leg then only looks inside it, so a fan
// or a parent walking past outside the crib doesn't count as the baby moving. null = whole frame.

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const MIN = 0.04; // rectangles smaller than this (either axis) are treated as "whole frame"
const CORNERS = [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]];

export default function CribZonePicker({ cameraId, zone, onChange }) {
  const wrapRef = useRef(null);
  const dragRef = useRef(null);
  const [imgState, setImgState] = useState('loading'); // loading | ok | error
  const [nonce, setNonce] = useState(0);
  const [z, setZ] = useState(zone || null);

  useEffect(() => { if (!dragRef.current) setZ(zone || null); }, [zone]);

  const src = (() => {
    const base = api.url(`/cameras/${cameraId}/snapshot`);
    return `${base}${base.includes('?') ? '&' : '?'}_=${nonce}`;
  })();

  function frac(e) {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  function onDown(e) {
    if (imgState !== 'ok') return;
    const handle = e.target.getAttribute?.('data-handle');
    const onRect = e.target.getAttribute?.('data-zone') != null;
    const mode = handle || (onRect ? 'move' : 'draw');
    e.preventDefault();
    wrapRef.current.setPointerCapture?.(e.pointerId);
    const start = frac(e);
    dragRef.current = { mode, start, orig: z };
    if (mode === 'draw') setZ({ x: start.x, y: start.y, w: 0, h: 0 });
  }

  function onMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const p = frac(e);
    if (d.mode === 'draw') {
      setZ({ x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) });
    } else if (d.mode === 'move' && d.orig) {
      const o = d.orig;
      setZ({ ...o, x: clamp01(Math.min(o.x + (p.x - d.start.x), 1 - o.w)), y: clamp01(Math.min(o.y + (p.y - d.start.y), 1 - o.h)) });
    } else if (d.orig) {
      const o = d.orig;
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (d.mode.includes('w')) x0 = p.x;
      if (d.mode.includes('e')) x1 = p.x;
      if (d.mode.includes('n')) y0 = p.y;
      if (d.mode.includes('s')) y1 = p.y;
      setZ({ x: clamp01(Math.min(x0, x1)), y: clamp01(Math.min(y0, y1)), w: clamp01(Math.abs(x1 - x0)), h: clamp01(Math.abs(y1 - y0)) });
    }
  }

  function onUp() {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setZ((cur) => {
      if (!cur || cur.w < MIN || cur.h < MIN) { onChange(null); return null; }
      const clean = { x: +cur.x.toFixed(3), y: +cur.y.toFixed(3), w: +cur.w.toFixed(3), h: +cur.h.toFixed(3) };
      onChange(clean);
      return clean;
    });
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
        <img
          className="crib__img"
          src={src}
          alt="Camera view"
          draggable="false"
          onLoad={() => setImgState('ok')}
          onError={() => setImgState('error')}
        />
        {imgState === 'loading' && <div className="crib__msg">Grabbing a frame…</div>}
        {imgState === 'error' && (
          <div className="crib__msg">
            Couldn’t grab a frame. <button type="button" className="linkbtn" onClick={() => { setImgState('loading'); setNonce((n) => n + 1); }}>Try again</button>
          </div>
        )}
        {imgState === 'ok' && z && (
          <div className="crib__zone" data-zone="1" style={{ left: pct(z.x), top: pct(z.y), width: pct(z.w), height: pct(z.h) }}>
            {CORNERS.map(([h, cx, cy]) => (
              <span key={h} data-handle={h} className="crib__handle" style={{ left: pct(cx), top: pct(cy) }} />
            ))}
          </div>
        )}
      </div>
      <div className="crib__row">
        <span className="camera-tile__sub">
          {z ? 'Drag to move, or drag a corner to resize. Draw a new box anywhere.' : 'Drag on the image to draw the crib area.'}
        </span>
        <div className="crib__btns">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setImgState('loading'); setNonce((n) => n + 1); }}>Refresh frame</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setZ(null); onChange(null); }} disabled={!z}>Whole frame</button>
        </div>
      </div>
    </div>
  );
}
