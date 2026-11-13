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
