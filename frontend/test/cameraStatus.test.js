import { describe, expect, test } from 'vitest';
import { cameraState } from '../src/lib/cameraStatus.js';

describe('cameraState (#1076)', () => {
  test.each([
    [{ disabled: true, statusLevel: 'live' }, 'Disabled', 'neutral'],
    [{ statusUnknown: true, statusLevel: 'connecting' }, 'Status unknown', 'connecting'],
    [{ statusLevel: 'live' }, 'Online', 'live'],
    [{ statusLevel: 'offline' }, 'Offline', 'offline'],
    [{ statusLevel: 'connecting' }, 'Connecting', 'connecting'],
  ])('maps the camera state into a word and dot', (camera, word, dot) => {
    expect(cameraState(camera)).toEqual({ word, dot });
  });

  test('unknown is amber even if the last level was offline; disabled stays neutral', () => {
    expect(cameraState({ statusUnknown: true, statusLevel: 'offline' }).dot).toBe('connecting');
    expect(cameraState({ disabled: true, statusUnknown: true }).dot).toBe('neutral');
  });
});
