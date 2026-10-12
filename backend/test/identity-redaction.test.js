// lib/identityRedaction.js (#547) on its own: the matching rules the route test cannot pin one by one.
// Each test names the rule it holds and what would be published if that rule were wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityRedactor } from '../src/lib/identityRedaction.js';

const make = (over = {}) => createIdentityRedactor({
  children: [{ id: 'k1', name: 'Zed Zephyr' }],
  cameras: [{ id: 'c1', name: 'Zed Room' }, { id: 'c2', name: 'Hall' }],
  users: [],
  ...over,
});

test('aliases are numbered by position and are the same on every call', () => {
  const r = make();
  assert.equal(r.childAlias('k1'), 'Child 1');
  assert.equal(r.cameraAlias('c1'), 'Camera 1');
  assert.equal(r.cameraAlias('c2'), 'Camera 2');
  assert.equal(make().cameraAlias('c2'), 'Camera 2');
});

test('longest literal first: "Zed Room" is one name, not "Zed" plus "Room"', () => {
  // A child "Zed" and a camera "Zed Room": an alternation takes the first branch that matches, so without
  // the longest-first order the camera name would be split and its tail published.
  const r = make({ children: [{ id: 'k1', name: 'Zed' }] });
  assert.equal(r.scrub('motion in Zed Room, Zed asleep'), 'motion in Camera 1, Child 1 asleep');
});

test('a name is matched as a whole word, case-insensitively, and through a possessive', () => {
  const r = make({ children: [{ id: 'k1', name: 'Eli' }], cameras: [] });
  assert.equal(r.scrub('elimination of Eli, eli and ELI\'s bed'), 'elimination of Child 1, Child 1 and Child 1\'s bed');
  assert.equal(r.scrub('Eli2 and Elis'), 'Eli2 and Elis', 'inside a longer word or number: not the name');
});

test('non-ASCII names, and regex metacharacters in a name, are matched literally', () => {
  const r = make({
    children: [{ id: 'k1', name: 'Zoë' }],
    cameras: [{ id: 'c1', name: 'Baby (C++) [2nd] ^$' }, { id: 'c2', name: 'a.b*c' }],
  });
  assert.equal(r.scrub('Zoë and ZOË'), 'Child 1 and Child 1');
  assert.equal(r.scrub('"Baby (C++) [2nd] ^$" up'), '"Camera 1" up');
  assert.equal(r.scrub('a.b*c / axbbc'), 'Camera 2 / axbbc', '"." and "*" are not wildcards');
});

test('a name under 3 characters is not searched for in free text, but is still aliased by id', () => {
  // "Jo" would turn "Jo" inside every sentence into an alias; the structured field is aliased by the route.
  const r = make({ children: [{ id: 'k1', name: 'Jo' }], cameras: [{ id: 'c1', name: 'B' }] });
  assert.equal(r.scrub('Jo said B'), 'Jo said B');
  assert.equal(r.childAlias('k1'), 'Child 1');
  assert.equal(r.findLeak({ line: 'Jo said B' }), null, 'a limit that is documented is not a failure of the gate');
});

test('an empty redactor changes nothing and finds nothing (no regex is built from zero literals)', () => {
  const r = createIdentityRedactor({});
  assert.equal(r.scrub('anything at all'), 'anything at all');
  assert.equal(r.findLeak({ a: 'anything at all' }), null);
});

test('a name is replaced once: a replacement is not rescanned (a camera named like another\'s alias)', () => {
  const r = make({ children: [], cameras: [{ id: 'c1', name: 'Hall' }, { id: 'c2', name: 'Camera 1x' }] });
  assert.equal(r.scrub('Hall then Camera 1x'), 'Camera 1 then Camera 2');
});

test('a literal that is a prefix of an alias does not split the alias (a camera called "Child")', () => {
  const r = make({ children: [{ id: 'k1', name: 'Zed Zephyr' }], cameras: [{ id: 'c1', name: 'Child' }] });
  assert.equal(r.scrub('Child 1 saw Child'), 'Child 1 saw Camera 1');
  assert.equal(r.findLeak({ line: 'Child 1 saw Camera 1' }), null);
});

test('a name that looks like an alias is a placeholder by form: not searched, not flagged', () => {
  const r = make({ children: [{ id: 'k1', name: 'Child 1' }, { id: 'k2', name: 'Zed Zephyr' }], cameras: [] });
  assert.equal(r.scrub('Child 1 / Zed Zephyr'), 'Child 1 / Child 2');
  assert.equal(r.findLeak({ line: 'Child 1 / Child 2' }), null);
});

test('the same text for a child and a camera becomes both aliases, children first', () => {
  const r = make({ children: [{ id: 'k1', name: 'Pip' }], cameras: [{ id: 'c1', name: 'pip' }] });
  assert.equal(r.scrub('on "Pip"'), 'on "Child 1 / Camera 1"');
  assert.equal(r.findLeak({ line: 'on "Child 1 / Camera 1"' }), null);
});

test('a percent-encoded name (an RTSP path) is replaced', () => {
  const r = make({ cameras: [{ id: 'c1', name: 'Baby Room' }], children: [] });
  assert.equal(r.scrub('/Baby%20Room/stream'), '/Camera 1/stream');
});

test('a lone surrogate in a name does not throw', () => {
  assert.doesNotThrow(() => make({ cameras: [{ id: 'c1', name: 'bad\uD800name' }], children: [] }).scrub('x'));
});

test('generic account names are not identity; a real login and a real first name are', () => {
  const r = make({
    children: [], cameras: [],
    users: [{ username: 'admin' }, { username: 'jsmith77', first_name: 'Jessica', last_name: 'Smithers' }],
  });
  assert.equal(r.scrub('admin by jsmith77 (Jessica Smithers)'), 'admin by User 2 (User 2 User 2)');
});

test('a former account and a removed camera get their own numbered aliases, stable by sort', () => {
  const r = createIdentityRedactor({
    children: [], cameras: [{ id: 'live', name: 'Live Cam' }], users: [{ username: 'current-user' }],
    cameraNames: [
      { camera_id: 'zz', camera_name: 'Gone Two' },
      { camera_id: 'live', camera_name: 'Old Live Name' },
      { camera_id: 'aa', camera_name: 'Gone One' },
    ],
    actorUsernames: ['current-user', 'ex-user-b', 'ex-user-a'],
  });
  assert.equal(r.cameraAlias('aa'), 'Camera (removed) 1');
  assert.equal(r.cameraAlias('zz'), 'Camera (removed) 2');
  assert.equal(r.scrub('Old Live Name / Gone One / ex-user-a / ex-user-b / current-user'),
    'Camera 1 / Camera (removed) 1 / User (former) 1 / User (former) 2 / User 1');
});

test('the check finds a name the scrub did not touch, in a value, at any depth', () => {
  const r = make();
  assert.match(r.findLeak({ a: [{ b: 'seen Zed Zephyr here' }] }), /name survived/);
  assert.equal(r.findLeak({ a: [{ b: 'seen Child 1 here' }] }), null);
});

test('the check reads a class instance by what it serialises to (the scrub passes it through)', () => {
  const r = make();
  class Line { constructor(t) { this.t = t; } }
  assert.equal(r.scrub({ l: new Line('Zed Room') }).l.t, 'Zed Room', 'the scrub leaves it: that is why the check exists');
  assert.match(r.findLeak({ l: new Line('Zed Room') }), /survived/);
});

test('the check ignores object KEYS: a camera named "Camera" must not make every bundle unsendable', () => {
  const r = make({ cameras: [{ id: 'c1', name: 'Camera' }], children: [] });
  assert.equal(r.findLeak({ camera_history: [], camera_id: 'x' }), null);
  assert.match(r.findLeak({ k: 'Camera' }), /survived/, 'a VALUE is still checked');
});

test('the check fails closed on a payload it cannot serialise', () => {
  const r = make();
  const loop = {}; loop.self = loop;
  assert.match(r.findLeak(loop), /could not be serialised/);
  assert.match(r.findLeak(undefined), /serialised to nothing/);
});

test('the reason never contains the name (it would be logged, and logs reach the next bundle)', () => {
  const r = make();
  assert.ok(!r.findLeak({ l: 'Zed Zephyr' }).includes('Zed'));
});
