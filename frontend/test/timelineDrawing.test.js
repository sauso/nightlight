import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { STIR_DRAW_GAP_MIN, timelineDrawingSegments } from '../src/lib/timelineDrawing.js';

const seg = (state, minutes, start) => ({ state, minutes, from_at: start, to_at: start + minutes });

describe('timeline drawing groups only nearby stirs', () => {
  test('empty and single segments keep their meaning', () => {
    expect(timelineDrawingSegments([])).toEqual([]);
    expect(timelineDrawingSegments([seg('stir', 1, 0)])).toEqual([seg('stir', 1, 0)]);
  });

  test('consecutive and near stirs join for drawing, while the input stays untouched', () => {
    const original = [seg('stir', 1, 0), seg('stir', 1, 1), seg('asleep', 2, 2), seg('stir', 1, 4)];
    expect(timelineDrawingSegments(original)).toEqual([seg('stir', 5, 0)]);
    expect(original).toHaveLength(4);
    expect(original[2].state).toBe('asleep');
  });

  test('the named gap boundary and farther gaps do not join', () => {
    for (const gap of [STIR_DRAW_GAP_MIN, STIR_DRAW_GAP_MIN + 1]) {
      const original = [seg('stir', 1, 0), seg('asleep', gap, 1), seg('stir', 1, 1 + gap)];
      expect(timelineDrawingSegments(original)).toEqual(original);
    }
  });

  // jsdom cannot see a cascade, and this was a real defect: the "no edge beside a quiet dash" rules were written before the general
  // asleep-edge rules (same specificity), lost to them, and a busy night rendered as a pale band with sparse dashes (found in the
  // browser render, 2026-11-13). Source order is the whole mechanism, so it is asserted as order, on tokens not exact text.
  test('the quiet-dash edge rules come AFTER the general asleep-edge rules they override', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
    const general = css.indexOf('.sleep-seg--stir + .sleep-seg--asleep { --tl-edge-l');
    const quiet = css.indexOf('.sleep-seg--stir-quiet + .sleep-seg--asleep { --tl-edge-l');
    const quietRight = css.indexOf('.sleep-seg--asleep:has(+ .sleep-seg--stir-quiet) { --tl-edge-r');
    const generalRight = css.indexOf('.sleep-seg--asleep:has(+ .sleep-seg--stir) { --tl-edge-r');
    expect(general).toBeGreaterThan(-1);
    expect(generalRight).toBeGreaterThan(-1);
    expect(quiet).toBeGreaterThan(general);
    expect(quietRight).toBeGreaterThan(generalRight);
  });

  test('an awake or missing-data span always breaks a visual run', () => {
    for (const state of ['wake', 'awake', 'gap']) {
      const original = [seg('stir', 1, 0), seg(state, 1, 1), seg('stir', 1, 2)];
      expect(timelineDrawingSegments(original)).toEqual(original);
    }
  });
});
