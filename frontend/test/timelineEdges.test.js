import { describe, expect, test } from 'vitest';
import { EDGE_LABEL_ZONE_PCT, markerLeft, tickLabelAlign } from '../src/lib/timelineEdges.js';
import { splitMorningWake } from '../src/lib/nightWakes.js';

describe('markerLeft keeps a centred marker inside the bar', () => {
  test('the centre is held half a marker width from each end, and stays at its minute in between', () => {
    expect(markerLeft(0, 5.5)).toBe('clamp(5.5px, 0%, calc(100% - 5.5px))');
    expect(markerLeft(100, 4)).toBe('clamp(4px, 100%, calc(100% - 4px))');
    expect(markerLeft(37.5, 5.5)).toBe('clamp(5.5px, 37.5%, calc(100% - 5.5px))');
  });

  test('a position outside the bar is pulled to its end; one that is not a number draws nothing', () => {
    expect(markerLeft(-3, 4)).toContain(', 0%,');
    expect(markerLeft(140, 4)).toContain(', 100%,');
    for (const bad of [null, undefined, NaN, Infinity, '12']) expect(markerLeft(bad, 4)).toBeUndefined();
  });
});

describe('tickLabelAlign: first label left, last label right, the rest centred', () => {
  test('ticks on the bar ends align to them', () => {
    expect(tickLabelAlign(0)).toBe('start');
    expect(tickLabelAlign(100)).toBe('end');
  });

  test('the zone boundary: just inside the zone aligns, exactly on it centres', () => {
    expect(tickLabelAlign(EDGE_LABEL_ZONE_PCT - 0.01)).toBe('start');
    expect(tickLabelAlign(EDGE_LABEL_ZONE_PCT)).toBe('center');
    expect(tickLabelAlign(100 - EDGE_LABEL_ZONE_PCT)).toBe('center');
    expect(tickLabelAlign(100 - EDGE_LABEL_ZONE_PCT + 0.01)).toBe('end');
    expect(tickLabelAlign(50)).toBe('center');
  });

  test('a position that is not a number is centred (nothing to align to)', () => {
    expect(tickLabelAlign(NaN)).toBe('center');
    expect(tickLabelAlign(undefined)).toBe('center');
  });
});

describe('splitMorningWake: the tab count and wake_count come from the same rows', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ start_at: `t${i}`, end_at: `t${i}e`, minutes: 5 }));

  test('a list exactly one longer than wake_count ends in the standalone morning row', () => {
    const { counted, morning } = splitMorningWake(rows(3), 2);
    expect(counted).toHaveLength(2);
    expect(morning.start_at).toBe('t2');
  });

  test('a list that already matches wake_count (the morning wake was merged into the last run) is left whole', () => {
    expect(splitMorningWake(rows(2), 2)).toEqual({ counted: rows(2), morning: null });
  });

  test('no wake_count (an older server) or a non-numeric one counts every row; a longer mismatch is not guessed at', () => {
    for (const wc of [undefined, null, '2', NaN]) expect(splitMorningWake(rows(3), wc).morning).toBeNull();
    expect(splitMorningWake(rows(4), 2).morning).toBeNull();
  });

  test('no wakes at all', () => {
    expect(splitMorningWake(undefined, 0)).toEqual({ counted: [], morning: null });
    expect(splitMorningWake([], 0)).toEqual({ counted: [], morning: null });
  });

  test('zero counted wake-ups plus one row is the morning row alone', () => {
    const { counted, morning } = splitMorningWake(rows(1), 0);
    expect(counted).toEqual([]);
    expect(morning.start_at).toBe('t0');
  });
});
