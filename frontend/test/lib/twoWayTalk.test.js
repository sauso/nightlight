import { describe, expect, test } from 'vitest';
import { downsample, linearToMuLaw } from '../../src/lib/twoWayTalk.js';

// G.711 mu-law decoding is the inverse segment expansion, independent of the encoder's search.
function decodeMuLaw(byte) {
  const code = byte ^ 0xff;
  const magnitude = (((code & 0x0f) << 3) + 0x84) << ((code >> 4) & 0x07);
  const pcm = magnitude - 0x84;
  return code & 0x80 ? -pcm : pcm;
}

describe('G.711 mu-law encoding', () => {
  test.each([
    [0, 0xff],
    [32767, 0x80],
    [-32768, 0x00],
    [11, 0xfe],
    [-11, 0x7e],
    [12, 0xfd],
    [-12, 0x7d],
    [1000, 0xce],
    [-1000, 0x4e],
  ])('PCM %i has the expected G.711 code', (sample, byte) => {
    expect(linearToMuLaw(sample)).toBe(byte);
  });

  test('opposite PCM signs differ only in the G.711 sign bit', () => {
    for (const sample of [11, 1000, 16000, 32767]) {
      expect(linearToMuLaw(-sample)).toBe(linearToMuLaw(sample) ^ 0x80);
    }
  });

  test('out-of-range PCM clips before segment selection instead of wrapping', () => {
    expect(linearToMuLaw(40000)).toBe(0x80);
    expect(linearToMuLaw(-40000)).toBe(0x00);
  });

  test('encoded samples round trip through an independent G.711 decoder', () => {
    expect(decodeMuLaw(0xce)).toBe(988); // pin the reference decoder's scale
    for (const sample of [0, 1000, -1000, 16000, -16000, 30000, -30000]) {
      expect(Math.abs(decodeMuLaw(linearToMuLaw(sample)) - sample)).toBeLessThanOrEqual(128);
    }
  });
});

describe('8 kHz box downsampling', () => {
  test.each([
    [48000, 480],
    [44100, 441],
  ])('%i Hz yields 80 samples for 10 ms of DC input', (rate, length) => {
    const output = downsample(new Float32Array(length).fill(0.25), rate);
    expect(output).toHaveLength(80);
    expect(Array.from(output)).toEqual(Array(80).fill(0.25));
  });

  // Review of #564: constant input cannot tell a mean from "take the first sample of each block".
  test('each output sample is the mean of its 6-sample block at 48 kHz', () => {
    const input = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5]);
    const output = downsample(input, 48000);
    expect(output).toHaveLength(2);
    expect(output[0]).toBeCloseTo(1 / 6, 6);
    expect(output[1]).toBeCloseTo(0.5 / 6, 6);
  });

  test('empty input stays empty', () => {
    expect(downsample(new Float32Array(0), 48000)).toHaveLength(0);
  });
});
