// lib/identityRedaction.js (#547) on its own: the matching rules the route test cannot pin one by one.
// Each test names the rule it holds and what would be published if that rule were wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityRedactor } from '../src/lib/identityRedaction.js';
import { neutraliseControlChars } from '../src/lib/logger.js';

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

test('a name that starts with another entity\'s alias is replaced whole (code review: "Camera 1 Nursery")', () => {
  // The alias "Camera 1" is a PREFIX of this camera's real name. If the alias won, the line would come out
  // as "motion on Camera 1" with the rest of the name ("Nursery") published beside it, and the check, which
  // asks the same matcher, would call it clean.
  const r = make({ children: [], cameras: [{ id: 'c1', name: 'Hall' }, { id: 'c2', name: 'Camera 1 Nursery' }] });
  assert.equal(r.scrub('motion on Camera 1 Nursery, Hall, Camera 1'), 'motion on Camera 2, Camera 1, Camera 1');
  assert.ok(!r.scrub('Camera 1 Nursery').includes('Nursery'));
  assert.equal(r.findLeak({ line: 'Camera 1 Nursery' }), 'a child, camera or account name survived redaction');
});

test('a name is not matched inside a longer word on its LEFT either', () => {
  const r = make({ children: [{ id: 'k1', name: 'Eli' }], cameras: [] });
  assert.equal(r.scrub('Beli and Eli'), 'Beli and Child 1');
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

test('a lone surrogate in a name does not throw, and the name as typed is still redacted', () => {
  // ⚠️ #564: this was `doesNotThrow(() => make(...).scrub('x'))`. 'x' never contains the name, so a redactor
  // that survived the URIError by DROPPING the name (the catch in `variants` swallowing the literal too)
  // passed it, and a name nothing redacts is the leak this module exists to prevent. The text now contains
  // the name, in both spellings it can reach a published string in.
  let r;
  assert.doesNotThrow(() => { r = make({ cameras: [{ id: 'c1', name: 'bad\uD800name' }], children: [] }); });
  assert.equal(r.scrub('feed bad\uD800name is down'), 'feed Camera 1 is down');
  assert.equal(r.scrub('a perfectly ordinary line'), 'a perfectly ordinary line', 'it must not redact what it should not');
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

// #709 (review of the #539 logger change): the log buffer that goes into the bundle now holds control characters
// as visible escapes, so a name has a spelling there that is neither "as typed" nor percent-encoded. One entry per
// class the logger treats differently: named escapes (LF, CR), the \xNN form (C0, DEL, C1), the six-character form
// (U+2028 / U+2029), and tab, which the logger leaves raw (a regression guard: the raw spelling must still work).
// Built with fromCharCode so no invisible character sits in this file's source.
const CONTROLS = [
  ['LF', 0x0a], ['CR', 0x0d], ['tab', 0x09], ['SOH', 0x01], ['ESC', 0x1b], ['DEL', 0x7f], ['NEL (C1)', 0x85],
  ['LINE SEPARATOR', 0x2028], ['PARAGRAPH SEPARATOR', 0x2029],
];

test('#709: a name containing a control character is found as the logger writes it, in every identity field', () => {
  for (const [label, code] of CONTROLS) {
    const c = String.fromCharCode(code);
    // A different marker on each side of the character, so neither half can survive unnoticed.
    const n = (field) => `Qzx${field}L${c}Qzx${field}R`;
    const r = createIdentityRedactor({
      children: [{ id: 'k1', name: n('child') }],
      cameras: [{ id: 'c1', name: n('camera') }],
      users: [{ username: n('login'), first_name: n('first'), last_name: n('last') }],
      cameraNames: [{ camera_id: 'gone', camera_name: n('oldcam') }],
      actorUsernames: [n('former')],
    });
    const fields = ['child', 'camera', 'login', 'first', 'last', 'oldcam', 'former'];
    const raw = fields.map((f) => `seen "${n(f)}"`).join(' / ');
    const want = 'seen "Child 1" / seen "Camera 1" / seen "User 1" / seen "User 1" / seen "User 1" / '
      + 'seen "Camera (removed) 1" / seen "User (former) 1"';
    // The logger's own function makes the logged text: its escapes are pinned by logger-control-chars.test.js,
    // and this test is about the redactor keeping up with whatever they are.
    for (const [form, text] of [['logged', neutraliseControlChars(raw)], ['as typed (event details)', raw]]) {
      const out = r.scrub(text);
      assert.ok(!out.includes('Qzx'), `${label}, ${form}: ${JSON.stringify(out)}`);
      assert.equal(out, want, `${label}, ${form}`);
      assert.match(r.findLeak({ line: text }) ?? 'null', /survived/, `${label}, ${form}: the gate must see it too`);
    }
  }
});

test('#709: a name right after an escaped control character is still a whole word (a multi-line error, a stack)', () => {
  // The escape ends in a letter or digit (`\n`, `\x1b`, `...2028`); read as an ordinary character, that made the
  // name look like the tail of a longer word, so it was skipped, and the gate (same matcher) passed it.
  const r = make();
  for (const [label, code] of CONTROLS) {
    const c = String.fromCharCode(code);
    const logged = neutraliseControlChars(`failed:${c}Zed Room down${c}Hall${c}Zed Zephyr`);
    assert.equal(r.scrub(logged), neutraliseControlChars(`failed:${c}Camera 1 down${c}Camera 2${c}Child 1`), label);
    assert.match(r.findLeak({ l: logged }) ?? 'null', /survived/, label);
  }
  // A name stored with a leading line break is trimmed to "Qzx Lead", and the log has the escape right before it.
  const lead = createIdentityRedactor({ children: [{ id: 'k1', name: '\nQzx Lead' }] });
  assert.equal(lead.scrub(neutraliseControlChars('on \nQzx Lead')), neutraliseControlChars('on \nChild 1'));
  // Still a whole-word rule: a letter or digit that does NOT end an escape keeps the name inside a longer word.
  assert.equal(r.scrub('nZed Room x1Hall'), 'nZed Room x1Hall');
});

// Round-2 review of PR #709: nine sampled classes let a probe from U+0001 (NUL's escape missing) and a logged
// spelling that kept NUL raw both survive. This walks EVERY code unit the logger changes. The list comes from the
// logger's own function on purpose: this file is about the redactor keeping up with the logger, and the logger's
// exact set is pinned by the exhaustive walk in logger-control-chars.test.js.
function unitsTheLoggerEscapes() {
  const units = [];
  for (let u = 0; u <= 0xffff; u++) {
    const ch = String.fromCharCode(u);
    if (neutraliseControlChars(ch) !== ch) units.push(u);
  }
  return units;
}

test('#709 exhaustive: every code unit the logger escapes, inside a name or right before one, is scrubbed and gated', () => {
  const units = unitsTheLoggerEscapes();
  for (const must of [0x00, 0x0a, 0x1b, 0x7f, 0x85, 0x2029]) assert.ok(units.includes(must), `U+${must.toString(16)} not derived`);
  for (const u of units) {
    const c = String.fromCharCode(u);
    const at = `U+${u.toString(16).padStart(4, '0')}`;
    const names = { lead: `${c}Qzx-lead`, mid: `Qzx-mid-a${c}Qzx-mid-b`, end: `Qzx-end${c}`, after: 'Qzx After Room' };
    const r = createIdentityRedactor({
      cameras: Object.values(names).map((name, i) => ({ id: `c${i + 1}`, name })),
    });
    const raw = `on "${names.lead}" "${names.mid}" "${names.end}" failed:${c}${names.after} down${c}${names.mid}${c}${names.lead}${c}end`;
    for (const [form, text] of [['logged', neutraliseControlChars(raw)], ['as typed', raw]]) {
      const out = r.scrub(text);
      assert.ok(!out.includes('Qzx'), `${at}, ${form}: ${JSON.stringify(out)}`);
      assert.match(r.findLeak({ line: text }) ?? 'null', /survived/, `${at}, ${form}: the gate must see the unscrubbed text`);
      assert.equal(r.findLeak({ line: out }), null, `${at}, ${form}: and must pass the scrubbed one`);
      for (const alias of ['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4']) assert.ok(out.includes(alias), `${at}, ${form}: ${alias} missing`);
    }
  }
});

test('#709: longest SPELLING first: a name that is a prefix of another name\'s logged spelling does not split it', () => {
  // Camera 1 is "Qzx" + two line separators + " Rook" (10 characters, 20 as logged). Camera 2 is the logged
  // spelling of "Qzx" + two separators, typed with real backslashes (15 characters). Ordered by NAME length,
  // camera 2's branch came first, matched the head of camera 1's logged spelling, and published " Rook".
  const ls = String.fromCharCode(0x2028);
  const r = createIdentityRedactor({
    cameras: [{ id: 'c1', name: `Qzx${ls}${ls} Rook` }, { id: 'c2', name: neutraliseControlChars(`Qzx${ls}${ls}`) }],
  });
  assert.equal(r.scrub(neutraliseControlChars(`on Qzx${ls}${ls} Rook`)), 'on Camera 1');
  assert.equal(r.scrub(neutraliseControlChars(`on Qzx${ls}${ls}`)), 'on Camera 2', 'the shorter name is still its own');
});
