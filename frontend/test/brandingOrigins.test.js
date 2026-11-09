// The deployed CSP permits same-origin fonts and styles only (#943).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync('src/index.css', 'utf8');
const html = readFileSync('index.html', 'utf8');

describe('branding asset origins', () => {
  test('CSS imports and URLs do not load external origins', () => {
    const declarations = css.match(/@import\s+[^;]+;|url\(\s*[^)]+\)/gi) || [];
    for (const declaration of declarations) {
      expect(declaration).not.toMatch(/https?:\/\//i);
    }
  });

  test('HTML has no externally hosted stylesheet or font', () => {
    const links = html.match(/<link\b[^>]*>/gi) || [];
    for (const link of links) {
      expect(link).not.toMatch(/href\s*=\s*["']https?:\/\//i);
    }
  });
});
