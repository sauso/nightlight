// The ESPHome logo as an icon (components/icons/EsphomeIcon.jsx): one colour with the "E" cut out, a mask id that is
// unique per instance (two on a page must not share one), and the same { size, color } shape as MqttIcon.
import { describe, test, expect } from 'vitest';
import { render } from '@testing-library/react';
import EsphomeIcon from '../src/components/icons/EsphomeIcon.jsx';

describe('EsphomeIcon', () => {
  test('takes a size and a colour, and is hidden from screen readers', () => {
    const { container } = render(<EsphomeIcon size={22} color="var(--peri)" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '22');
    expect(svg).toHaveAttribute('height', '22');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.querySelector('path[fill="var(--peri)"]')).not.toBeNull();
  });

  test('defaults to 24 px in the surrounding text colour', () => {
    const { container } = render(<EsphomeIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '24');
    expect(container.querySelector('path[fill="currentColor"]')).not.toBeNull();
  });

  test('★ the "E" is cut out of the house by a mask, and the house is the masked shape', () => {
    const { container } = render(<EsphomeIcon />);
    const mask = container.querySelector('mask');
    const [house, letter] = mask.querySelectorAll('path');
    expect(house).toHaveAttribute('fill', '#fff');   // kept
    expect(letter).toHaveAttribute('fill', '#000');  // knocked out
    const drawn = container.querySelector('svg > path');
    expect(drawn.getAttribute('mask')).toBe(`url(#${mask.id})`);
    expect(drawn.getAttribute('d')).toBe(house.getAttribute('d'));
  });

  test('★ two icons on one page get different mask ids, so neither masks the other', () => {
    const { container } = render(<><EsphomeIcon /><EsphomeIcon /></>);
    const ids = [...container.querySelectorAll('mask')].map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
  });
});
