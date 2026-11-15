// ScoreRing on its own: the band class, the dashed early-estimate track, and that nothing about a ring that is given no
// band has changed (a caller that does not know the band must look exactly as before). The colours themselves are CSS
// and are checked in paletteTokens.test.jsx; here it is which class the svg carries.
import { describe, test, expect } from 'vitest';
import { render } from '@testing-library/react';
import ScoreRing from '../src/components/ScoreRing.jsx';

const ring = (props) => render(<ScoreRing value={72} {...props} />).container.querySelector('svg');
const bandClasses = (svg) => (svg.getAttribute('class').match(/score-ring--(great|good|fair|low|early)/g) || []);

describe('ScoreRing bands', () => {
  test.each(['great', 'good', 'fair', 'low', 'early'])('★ band %s sets its class on either surface', (band) => {
    for (const surface of ['card', 'dark']) {
      const svg = ring({ band, surface });
      expect(bandClasses(svg), `${band} on ${surface}`).toEqual([`score-ring--${band}`]);
      expect(svg.classList.contains(`score-ring--${surface}`)).toBe(true);
    }
  });

  test('★ no band, or one this build does not know, keeps today\'s classes exactly (the periwinkle arc)', () => {
    expect(ring({ surface: 'dark' }).getAttribute('class')).toBe('score-ring score-ring--dark');
    expect(ring({}).getAttribute('class')).toBe('score-ring score-ring--card');
    expect(ring({ band: null }).getAttribute('class')).toBe('score-ring score-ring--card');
    expect(ring({ band: 'superb' }).getAttribute('class')).toBe('score-ring score-ring--card');
    // A class that happens to be a surface name must not be taken for a band.
    expect(ring({ band: 'dark', surface: 'card' }).getAttribute('class')).toBe('score-ring score-ring--card');
  });

  test('★ only an early estimate has a dashed track; the arc is never dashed by the early flag', () => {
    expect(ring({ band: 'early' }).querySelector('.score-ring__track').getAttribute('stroke-dasharray')).toBeTruthy();
    for (const band of ['great', 'good', 'fair', 'low', undefined]) {
      expect(ring({ band }).querySelector('.score-ring__track').getAttribute('stroke-dasharray'), String(band)).toBeNull();
    }
    // The arc keeps its own dash (length of the filled part), which has nothing to do with the early dashes.
    const arc = ring({ band: 'early', value: 50 }).querySelector('.score-ring__arc');
    expect(arc.getAttribute('stroke-dasharray')).not.toBe(ring({ band: 'early' }).querySelector('.score-ring__track').getAttribute('stroke-dasharray'));
  });

  test('★ the arc is never thinner than its track, at either size (v3.1 widened both together)', () => {
    for (const size of ['sm', 'lg']) {
      for (const band of ['great', 'early']) {
        const svg = ring({ size, band });
        const track = Number(svg.querySelector('.score-ring__track').getAttribute('stroke-width'));
        const arc = Number(svg.querySelector('.score-ring__arc').getAttribute('stroke-width'));
        expect(arc, `${size} ${band}`).toBeGreaterThanOrEqual(track);
        expect(track).toBeGreaterThan(4); // wider than the pre-v3.1 hairline (4px on the small ring)
      }
    }
  });

  test('the early estimate\'s dashes scale with the stroke (a dash shorter than the groove is wide reads as a sliver)', () => {
    for (const size of ['sm', 'lg']) {
      const track = ring({ size, band: 'early' }).querySelector('.score-ring__track');
      const [dash] = track.getAttribute('stroke-dasharray').split(' ').map(Number);
      expect(dash).toBeGreaterThanOrEqual(Number(track.getAttribute('stroke-width')) / 2);
    }
  });

  test('the number is unchanged by a band, the ring stays decorative, and it is not animated', () => {
    const svg = ring({ band: 'great', value: 91.4 });
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('text').textContent).toBe('91');
    // No SMIL or inline animation on a ring: the arc is simply drawn where it ends.
    expect(svg.querySelector('animate, animateTransform, set')).toBeNull();
    expect(svg.innerHTML).not.toMatch(/animation|transition/i);
  });

  test('no number, no ring, whatever the band', () => {
    expect(render(<ScoreRing value={null} band="great" />).container.querySelector('svg')).toBeNull();
  });
});

// The band word inside the ring (the child card's "82 / Good", UI refresh PR C). Colour is never the only signal, so the word is
// drawn where a person looks, not only in the button's accessible name.
describe('ScoreRing word', () => {
  const words = (svg) => [...svg.querySelectorAll('.score-ring__word')].map((t) => t.textContent);
  const y = (el) => Number(el.getAttribute('y'));

  test('★ the xl ring draws the word under the number, and the pair is centred on the ring', () => {
    const svg = ring({ size: 'xl', surface: 'dark', band: 'good', value: 82, word: 'Good' });
    expect(words(svg)).toEqual(['Good']);
    const num = svg.querySelector('.score-ring__num');
    const word = svg.querySelector('.score-ring__word');
    expect(num.textContent).toBe('82');
    // The number is ABOVE the centre line and the word BELOW it (SVG y grows downwards), so neither sits on the other.
    const mid = Number(svg.getAttribute('width')) / 2;
    expect(y(num)).toBeLessThan(mid);
    expect(y(word)).toBeGreaterThan(mid);
    // ...and with enough room between their centres for the two font sizes (22px over 11px): no overlap.
    expect(y(word) - y(num)).toBeGreaterThan((Number(num.getAttribute('font-size')) + Number(word.getAttribute('font-size'))) / 2);
  });

  test('no word given: the number stays on the centre, as on every other ring', () => {
    const svg = ring({ size: 'xl', value: 82 });
    expect(words(svg)).toEqual([]);
    expect(y(svg.querySelector('.score-ring__num'))).toBe(Number(svg.getAttribute('width')) / 2);
  });

  test('a word on a ring too small to hold it is ignored, not squeezed in', () => {
    for (const size of ['sm', 'lg']) {
      const svg = ring({ size, value: 82, word: 'Good' });
      expect(words(svg), size).toEqual([]);
      expect(y(svg.querySelector('.score-ring__num')), size).toBe(Number(svg.getAttribute('width')) / 2);
    }
  });

  test('the xl ring keeps the v3.1 stroke rule (the arc is never thinner than the track) and a wider groove than the old rings', () => {
    const svg = ring({ size: 'xl', band: 'early', value: 64 });
    const track = Number(svg.querySelector('.score-ring__track').getAttribute('stroke-width'));
    expect(Number(svg.querySelector('.score-ring__arc').getAttribute('stroke-width'))).toBeGreaterThanOrEqual(track);
    expect(track).toBeGreaterThan(4);
  });

  test('the word is as decorative as the rest of the ring (the svg stays hidden from a screen reader)', () => {
    expect(ring({ size: 'xl', value: 82, word: 'Good' }).getAttribute('aria-hidden')).toBe('true');
  });
});
