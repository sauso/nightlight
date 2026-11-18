import { test, expect } from 'vitest';
import { audioLabelText } from '../src/lib/audioLabel.js';

test.each([
  ['cry', 'Crying'],
  ['cough', 'Coughing'],
  ['voice', 'Talking'],
  ['other', null],
  [null, null],
  [undefined, null],
  ['unrecognised', null],
])('audio label %s displays %s', (label, text) => {
  expect(audioLabelText(label)).toBe(text);
});
