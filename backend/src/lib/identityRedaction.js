// Replacing the names of a household's children, cameras and accounts with stable aliases ("Child 1",
// "Camera 2", "User 1") in a payload that is about to leave the server, and refusing to send one where a
// name survived.
//
// THE DEFECT THIS EXISTS FOR (issue #547). The diagnostics bundle is built to be attached to a PUBLIC
// GitHub issue and the UI says it holds no passwords or tokens, which was true. It also held each child's
// name and birthday, and, because ~40 log lines interpolate `"${camera.name}"` (and sleepAnalysis logs the
// child's name, and talkSocket logs the username), every one of those names again inside `server_logs`.
// People name cameras after their children, so a camera name is the child's name.
//
// WHY A SCRUB OVER THE WHOLE BUNDLE RATHER THAN PER-FIELD EDITS. The names do not live in a field: they are
// interpolated into free text by call sites in a dozen files, and the next one added would be missed. The
// route still edits the structured fields explicitly (so a 2-letter name is aliased where it is a field);
// this module is the net under them, and findLeak() is the check on what would be SENT, the same shape
// as scrubSecrets/findCredentialLeak in urlCredentials.js (GHSA-wcgj-6p3c-vr9h): a scrubber that silently
// passes an unrecognised container is a silent failure in a privacy control, so the sender asks again.
//
// WHAT IS DELIBERATELY NOT HERE (each one a decision, not an oversight):
//   - The birthday is not a literal. It is never written to a log (checked by grep: only the children
//     routes and this bundle read it) and it is nulled in `children[]`. As a literal it would also rewrite
//     the date part of every timestamp on the day of birth, which are the diagnosis.
//   - Literals under 3 characters are not searched for in free text (`a`, `Jo` would mangle ordinary
//     words). Same trade-off as scrubSecrets' 4-character floor. The structured fields are still aliased.
//   - A name that exists ONLY in the in-memory log buffer and is no longer in the database (a child or an
//     account renamed since the line was logged) is unknowable here. Documented in SECURITY.md.

// A letter or digit on either side means "inside a longer word": `Eli` must not hit `elimination`, `Zed`
// must hit `Zed's`. \p{L}\p{N} needs the `u` flag, which also makes `i` fold non-ASCII case.
const NOT_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_AFTER = '(?![\\p{L}\\p{N}])';

// Not identity on their own, whoever types them: the defaults a fresh install ships with and the words an
// operator picks for a role. Without this an account called "admin" would turn the camera's own login
// (`rtsp_username: admin`) into "User 1" in every bundle.
const GENERIC_ACCOUNT_NAMES = new Set(['admin', 'administrator', 'root', 'user', 'guest']);

const MIN_LITERAL_CHARS = 3;

// In u-mode only syntax characters may be escaped ("\-" is a SyntaxError there).
const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

const codePoints = (s) => [...s].length;

// encodeURIComponent throws URIError on a lone surrogate, and a name is arbitrary user input. A redactor
// must never be the thing that fails.
function encoded(s) {
  try {
    const e = encodeURIComponent(s);
    return e !== s ? e : null;
  } catch {
    return null;
  }
}

/** Every form of a literal that can appear in a published string: as typed, and percent-encoded (an RTSP path). */
function variants(literal) {
  const out = [literal];
  const e = encoded(literal);
  if (e) out.push(e);
  return out;
}

/**
 * @param {object} src
 * @param {{id:string,name:string}[]} src.children       in the order that numbers them
 * @param {{id:string,name:string}[]} src.cameras        in the order that numbers them (the live grid's)
 * @param {{username?:string,first_name?:string,last_name?:string}[]} src.users  in creation order
 * @param {{camera_id:string,camera_name:string}[]} [src.cameraNames]
 *        every (id, name) pair the history tables hold: a camera renamed or deleted since the row was
 *        written is no longer in `cameras`, and its old name is still in `camera_events.camera_name`
 * @param {string[]} [src.actorUsernames]  every username the history ever recorded (accounts renamed/deleted)
 */
export function createIdentityRedactor({ children = [], cameras = [], users = [], cameraNames = [], actorUsernames = [] }) {
  const childAliases = new Map(children.map((c, i) => [c.id, `Child ${i + 1}`]));
  const cameraAliases = new Map(cameras.map((c, i) => [c.id, `Camera ${i + 1}`]));

  // A camera that has since been removed keeps its history rows. Numbered in a stable order so two bundles
  // of the same data agree, and so every row of one removed camera shares one alias.
  let removed = 0;
  for (const row of [...cameraNames].sort((a, b) => String(a.camera_id).localeCompare(String(b.camera_id)))) {
    if (!cameraAliases.has(row.camera_id)) cameraAliases.set(row.camera_id, `Camera (removed) ${++removed}`);
  }

  // literal (case-folded) -> the set of aliases it stands for. A child and a camera with the same text (a
  // camera called after the child is common) cannot be told apart in free text, so the alias says both.
  const byLiteral = new Map();
  const add = (literal, alias, { account = false } = {}) => {
    if (typeof literal !== 'string') return;
    const text = literal.trim();
    if (codePoints(text) < MIN_LITERAL_CHARS) return;
    if (account && GENERIC_ACCOUNT_NAMES.has(text.toLowerCase())) return;
    const key = text.toLowerCase();
    if (!byLiteral.has(key)) byLiteral.set(key, { text, aliases: new Set() });
    byLiteral.get(key).aliases.add(alias);
  };

  for (const c of children) add(c.name, childAliases.get(c.id));
  for (const c of cameras) add(c.name, cameraAliases.get(c.id));
  for (const r of cameraNames) add(r.camera_name, cameraAliases.get(r.camera_id));

  const userAlias = new Map();
  users.forEach((u, i) => {
    const alias = `User ${i + 1}`;
    for (const v of [u.username, u.first_name, u.last_name]) add(v, alias, { account: true });
    if (typeof u.username === 'string') userAlias.set(u.username.toLowerCase(), alias);
  });
  let former = 0;
  for (const name of [...actorUsernames].sort()) {
    if (typeof name !== 'string' || userAlias.has(name.toLowerCase())) continue;
    const alias = `User (former) ${++former}`;
    userAlias.set(name.toLowerCase(), alias);
    add(name, alias, { account: true });
  }

  // "Child 1 / Camera 1" sorts children first, then cameras, then accounts; the order is not significant,
  // only that it is the same every time.
  const rank = (a) => (a.startsWith('Child') ? 0 : a.startsWith('Camera') ? 1 : 2);
  // The aliases this redactor hands out. They are matched too, as text to LEAVE ALONE, for two reasons:
  // the route has already written them into the structured fields (a camera named "Child" must not split
  // "Child 1"), and a name that is itself one of them (a child actually named "Child 1") reveals nothing,
  // so it is not treated as identity (the check would otherwise flag the bundle's own aliases).
  // Only the aliases actually issued are protected, not "anything shaped like one": a camera named
  // "Camera 1 Nursery" is longer than the alias "Camera 1" and must win over it (found in code review: a
  // shape-based first branch swallowed "Camera 1" and published the rest of the name).
  const issued = new Set([
    ...childAliases.values(), ...cameraAliases.values(), ...userAlias.values(),
    ...users.map((_, i) => `User ${i + 1}`), 'Child (removed) 0', 'Camera (removed) 0',
  ]);
  const issuedKeys = new Set([...issued].map((a) => a.toLowerCase()));

  const literalEntries = [...byLiteral.entries()]
    // A literal equal to an issued alias IS that alias: nothing to replace.
    .filter(([key]) => !issuedKeys.has(key))
    .map(([, e]) => ({ text: e.text, alias: [...e.aliases].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).join(' / '), keep: false }));
  const entries = [...literalEntries, ...[...issued].map((a) => ({ text: a, alias: a, keep: true }))]
    // Longest first: "Zed Room" must win over "Zed" at the same position, because an alternation takes
    // the first branch that matches, not the longest. At equal length an issued alias wins.
    .sort((a, b) => b.text.length - a.text.length || Number(b.keep) - Number(a.keep) || a.text.localeCompare(b.text));

  // One alternation, one pass: a replacement is never rescanned, so a camera named like another entity's
  // alias cannot be rewritten twice.
  const branches = []; // per capture group, in group order: { alias, keep }
  const parts = [];
  for (const e of entries) {
    for (const v of e.keep ? [e.text] : variants(e.text)) {
      parts.push(`(${escapeRe(v)})`);
      branches.push(e);
    }
  }
  // Nothing to search for unless at least one real name exists.
  const scrubRe = literalEntries.length ? new RegExp(`${NOT_BEFORE}(?:${parts.join('|')})${NOT_AFTER}`, 'giu') : null;

  const matchedBranch = (args) => branches[args.slice(1, 1 + branches.length).findIndex((g) => g !== undefined)];
  const replaceIn = (s) => {
    if (!scrubRe) return s;
    return s.replace(scrubRe, (...args) => {
      // args = [match, g1..gN, offset, string]; the group that matched is the first defined one. An issued
      // alias maps to itself, so it passes through unchanged.
      return matchedBranch(args).alias;
    });
  };

  const walk = (v) => {
    if (typeof v === 'string') return replaceIn(v);
    if (Array.isArray(v)) return v.map(walk);
    // Plain objects only, for the reason scrubSecrets gives: rebuilding a Date or a Buffer from its entries
    // destroys it. Such a value is passed through untouched and findLeak() is what catches it.
    if (v && typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v;
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };

  // The check walks string VALUES, not the JSON text, and reuses the scrub's own matcher: a "leak" is a
  // string the scrub would still change. Two reasons, both found by walking the real bundle (plan review +
  // own pass): (1) object KEYS here are fixed words ("camera_history", "host", "node"), never user data, and
  // a JSON-text search flagged them, so a camera named "Camera" made every bundle unsendable; (2) one matcher
  // cannot disagree with itself about boundaries, case or aliases, which two regexes could.
  const containsName = (s) => {
    if (!scrubRe) return false;
    let found = false;
    s.replace(scrubRe, (...args) => {
      if (!matchedBranch(args).keep) found = true;
      return args[0];
    });
    return found;
  };
  const anyName = (v) => {
    if (typeof v === 'string') return containsName(v);
    if (Array.isArray(v)) return v.some(anyName);
    if (v && typeof v === 'object') return Object.values(v).some(anyName);
    return false;
  };

  return {
    /** The alias for a child's id, or a placeholder for one this redactor was not told about. */
    childAlias: (id) => childAliases.get(id) ?? 'Child (removed) 0',
    /** The alias for a camera's id: live, or one the history remembers after its removal. */
    cameraAlias: (id) => cameraAliases.get(id) ?? 'Camera (removed) 0',
    /** Deep copy of `value` with every known name in every string replaced. Object keys are not rewritten. */
    scrub: (value) => walk(value),
    /**
     * Does this about-to-be-published value still contain a name? Returns a reason (never the name: it
     * would be logged) or null. FAIL CLOSED: an unserialisable payload is a leak.
     *
     * Looks at what would be SENT: a JSON round trip first, so a class instance the scrub passed through
     * is inspected by what it serialises to.
     */
    findLeak(payload) {
      let tree;
      try {
        const json = JSON.stringify(payload);
        if (typeof json !== 'string') return 'payload serialised to nothing';
        tree = JSON.parse(json);
      } catch {
        // Circular or unserialisable: it cannot be published either, so treat it as unsafe.
        return 'payload could not be serialised for inspection';
      }
      return anyName(tree) ? 'a child, camera or account name survived redaction' : null;
    },
  };
}
