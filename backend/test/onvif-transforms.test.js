import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  profileToken,
  pickBestProfile,
  pickSubProfile,
  rtspPartsFromStreamUri,
  classifyBackchannel,
  classifyMotionEvents,
  extractMotion,
} from '../src/lib/onvif.js';

// The probe chooses by video resolution; bitrate and encoding are present as real ONVIF profiles supply them.
const main = { token: 'main', videoEncoderConfiguration: { encoding: 'H264', resolution: { width: 1920, height: 1080 }, rateControl: { bitrateLimit: 4096 } } };
const middle = { $: { token: 'middle' }, videoEncoderConfiguration: { encoding: 'H264', resolution: { width: 1280, height: 720 }, rateControl: { bitrateLimit: 1024 } } };
const low = { $: { Token: 'low' }, videoEncoderConfiguration: { encoding: 'H264', resolution: { width: 640, height: 360 }, rateControl: { bitrateLimit: 512 } } };
const noEncoder = { token: 'metadata-only' };

for (const [name, profile, expected] of [
  ['direct token', main, 'main'],
  ['parsed lowercase attribute', middle, 'middle'],
  ['parsed uppercase attribute', low, 'low'],
  ['missing token', {}, null],
]) {
  test(`profileToken: ${name}`, () => {
    assert.equal(profileToken(profile), expected);
  });
}

test('the highest resolution is main and the lowest different profile is sub', () => {
  const profiles = [middle, low, main];
  const originalOrder = [...profiles];
  const best = pickBestProfile(profiles);
  const sub = pickSubProfile(profiles, best);
  assert.equal(profileToken(best), 'main');
  assert.equal(profileToken(sub), 'low');
  assert.notEqual(profileToken(sub), profileToken(best));
  assert.deepEqual(profiles, originalOrder, 'selection does not reorder the camera profile list');
});

test('a profile without a video encoder cannot outrank a video profile as main', () => {
  assert.equal(profileToken(pickBestProfile([noEncoder, middle, main])), 'main');
});

for (const [name, incompleteResolution] of [
  ['missing width', { height: 2160 }],
  ['missing height', { width: 3840 }],
]) {
  test(`a profile with ${name} does not outrank a complete video resolution`, () => {
    const incomplete = { token: 'incomplete', videoEncoderConfiguration: { resolution: incompleteResolution } };
    assert.equal(profileToken(pickBestProfile([incomplete, low])), 'low');
    assert.equal(profileToken(pickBestProfile([low, incomplete])), 'low');
  });
}

test('a single profile has no separate low-quality stream', () => {
  assert.equal(pickSubProfile([main], main), null);
});

test('a metadata-only profile cannot displace the low-quality video profile', () => {
  assert.equal(pickSubProfile([main, low, noEncoder], main), low);
});

test('a metadata-only profile does not create a low-quality stream', () => {
  assert.equal(pickSubProfile([main, noEncoder], main), null);
});

test('a video profile without a resolution remains eligible for low quality', () => {
  const noResolution = { ...low, videoEncoderConfiguration: { encoding: 'H264' } };
  assert.equal(pickSubProfile([main, noResolution], main), noResolution);
});

test('a duplicate main token is not a separate low-quality stream', () => {
  assert.equal(pickSubProfile([main, { ...main }], main), null);
});

for (const [name, streamUri, host, expected] of [
  ['Hikvision-style query stays in the raw parts for probe-level manufacturer handling', 'rtsp://0.0.0.0:8554/Streaming/Channels/101?transportmode=unicast&profile=Profile_1', 'camera.example', { host: 'camera.example', port: '8554', path: '/Streaming/Channels/101?transportmode=unicast&profile=Profile_1' }],
  ['internal address is replaced and query remains for other brands', 'rtsp://192.168.10.12/cam/realmonitor?channel=1&subtype=0', '203.0.113.8', { host: '203.0.113.8', port: '554', path: '/cam/realmonitor?channel=1&subtype=0' }],
  ['URI credentials are discarded', 'rtsp://camera-user:camera-pass@192.168.10.12:7447/live/main', 'camera.example', { host: 'camera.example', port: '7447', path: '/live/main' }],
  ['hostless URI with credentials retains its path', 'rtsp://camera-user:camera-pass@/live/sub', 'camera.example', { host: 'camera.example', port: '554', path: '/live/sub' }],
  ['IPv6 authority with a non-default port', 'rtsp://[fd00::20]:8555/live', 'fd00::30', { host: 'fd00::30', port: '8555', path: '/live' }],
  ['plain stream path', 'rtsp://camera.example/live', 'camera.example', { host: 'camera.example', port: '554', path: '/live' }],
  ['secure RTSP keeps its port and path', 'rtsps://camera.example:7448/live/secure', 'camera.example', { host: 'camera.example', port: '7448', path: '/live/secure' }],
  ['surrounding whitespace is ignored', ' \t rtsp://camera.example:8554/live/sub \n', 'camera.example', { host: 'camera.example', port: '8554', path: '/live/sub' }],
  ['missing URI falls back to root and default port', '', 'camera.example', { host: 'camera.example', port: '554', path: '/' }],
]) {
  test(`rtspPartsFromStreamUri: ${name}`, () => {
    assert.deepEqual(rtspPartsFromStreamUri({ streamUri, host }), expected);
  });
}

for (const [name, err, configs, expected] of [
  ['audio output present', null, [{ token: 'speaker' }], 'yes'],
  ['empty audio output list', null, [], 'no'],
  ['missing audio output list', null, undefined, 'no'],
  ['explicit unsupported fault', new Error('AudioOutputNotSupported'), undefined, 'no'],
  ['generic unsupported fault', new Error('Audio output not supported'), undefined, 'no'],
  ['other SOAP fault', new Error('NotAuthorized'), undefined, 'unknown'],
  ['fault without a message', new Error(), undefined, 'unknown'],
]) {
  test(`classifyBackchannel: ${name}`, () => {
    assert.equal(classifyBackchannel(err, configs), expected);
  });
}

for (const [name, err, xml, expected] of [
  ['MotionAlarm topic', null, '<TopicSet><VideoSource><MotionAlarm/></VideoSource></TopicSet>', 'yes'],
  ['CellMotionDetector rule', null, '<TopicSet><RuleEngine><CellMotionDetector><Motion/></CellMotionDetector></RuleEngine></TopicSet>', 'yes'],
  ['standalone CellMotionDetector rule', null, '<TopicSet><RuleEngine><CellMotionDetector/></RuleEngine></TopicSet>', 'yes'],
  ['standalone MotionDetector rule', null, '<TopicSet><RuleEngine><MotionDetector/></RuleEngine></TopicSet>', 'yes'],
  ['generic Motion element', null, '<TopicSet><Motion/></TopicSet>', 'yes'],
  ['Motion element with attributes', null, '<TopicSet><Motion Name="detected"/></TopicSet>', 'yes'],
  ['Motion element with a closing angle', null, '<TopicSet><Motion></Motion></TopicSet>', 'yes'],
  ['recognised response without motion', null, '<GetEventPropertiesResponse><TopicSet><Tamper/></TopicSet></GetEventPropertiesResponse>', 'no'],
  ['response wrapper alone without motion', null, '<GetEventPropertiesResponse><Tamper/></GetEventPropertiesResponse>', 'no'],
  ['topic set alone without motion', null, '<TopicSet><Tamper/></TopicSet>', 'no'],
  ['fault despite a motion topic', new Error('NotAuthorized'), '<TopicSet><MotionAlarm/></TopicSet>', 'unknown'],
  ['missing XML', null, null, 'unknown'],
  ['malformed message without an event response', null, '<truncated', 'unknown'],
]) {
  test(`classifyMotionEvents: ${name}`, () => {
    assert.equal(classifyMotionEvents(err, xml), expected);
  });
}

for (const [name, message, expected] of [
  ['nested motion true', { topic: { _: 'tns1:VideoSource/MotionAlarm' }, message: { message: { data: { simpleItem: { $: { Name: 'IsMotion', Value: 'true' } } } } } }, { topic: 'tns1:VideoSource/MotionAlarm', state: true }],
  ['flat motion clear', { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', message: { data: { simpleItem: { Name: 'State', Value: 'false' } } } }, { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', state: false }],
  ['standalone CellMotionDetector topic', { topic: 'tns1:RuleEngine/CellMotionDetector', message: { data: { simpleItem: { Name: 'State', Value: 'true' } } } }, { topic: 'tns1:RuleEngine/CellMotionDetector', state: true }],
  ['Motion at topic start', { topic: 'Motion/Zone', message: { data: { simpleItem: { Name: 'State', Value: 'true' } } } }, { topic: 'Motion/Zone', state: true }],
  ['Motion after a slash', { topic: 'Rule/Motion/Zone', message: { data: { simpleItem: { Name: 'State', Value: 'true' } } } }, { topic: 'Rule/Motion/Zone', state: true }],
  ['Motion before a slash', { topic: 'tns1:Motion/Zone', message: { data: { simpleItem: { Name: 'State', Value: 'true' } } } }, { topic: 'tns1:Motion/Zone', state: true }],
  ['array skips unrelated data then accepts numeric true', { topic: 'tns1:Motion', message: { Data: { SimpleItem: [{ $: { Name: 'ObjectId', Value: '4' } }, { $: { Name: 'IsMotion', Value: '1' } }] } } }, { topic: 'tns1:Motion', state: true }],
  ['numeric clear', { topic: 'tns1:IsMotion', message: { data: { SimpleItem: { name: 'motion', value: '0' } } } }, { topic: 'tns1:IsMotion', state: false }],
  ['lowercase true value', { topic: 'tns1:MotionAlarm', message: { data: { simpleItem: { name: 'motion', value: 'true' } } } }, { topic: 'tns1:MotionAlarm', state: true }],
  ['motion topic without data', { topic: 'tns1:MotionAlarm', message: {} }, { topic: 'tns1:MotionAlarm', state: null }],
  ['motion topic with unrelated data', { topic: 'tns1:MotionAlarm', message: { data: { simpleItem: { Name: 'ObjectId', Value: '4' } } } }, { topic: 'tns1:MotionAlarm', state: null }],
  ['non-motion rule', { topic: 'tns1:RuleEngine/Tamper', message: { data: { simpleItem: { Name: 'State', Value: 'true' } } } }, null],
  ['malformed message', { message: { data: { simpleItem: null } } }, null],
]) {
  test(`extractMotion: ${name}`, () => {
    assert.deepEqual(extractMotion(message), expected);
  });
}
