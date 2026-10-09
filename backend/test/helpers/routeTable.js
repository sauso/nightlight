// Enumerating the app's real route table, for route-permissions.test.js (issue #563).
//
// Two halves, because the app is built in two places:
//
//   1. `src/index.js` cannot be imported by a test: importing it starts MediaMTX, the MQTT client, the
//      sleep job and an HTTP listener. So its own registrations (the `app.use(...)` / `app.get(...)` calls,
//      including which router is mounted where) are READ FROM THE SOURCE by `scanAppRegistrations`.
//   2. Every router it mounts IS importable, so `enumerateRouter` walks the real `router.stack` Express
//      built — the actual function objects in front of each handler, not a reading of the text.
//
// ⚠️ BOTH HALVES FAIL CLOSED. A guard that only understands the shapes its author happened to write is not
// a guard (sourceScan.js tells the story of a timer scan that six of eight shapes walked past). So anything
// these functions do not recognise THROWS rather than being skipped: an `app.<method>` they do not know, a
// dynamic `app[...]`, `app` handed to some other function, a nested router, a `router.use` with a path, a
// route whose path is not a plain string. Each throw names what to extend. Skipping would turn "a route the
// scanner cannot see" into "a route with no gate that nobody is told about" — the exact defect being tested.
//
// ⚠️ THE index.js HALF IS A TOKENIZER, NOT A PARSER. It understands comments, the three string forms
// (template literals with nested `${...}` included) and regex literals, which is what a text scan gets
// wrong in both directions (a registration inside a comment counted; a `//` inside a regex eating the rest
// of a line). Its regex-vs-division call is the usual heuristic on the previous token, so a regex directly
// after `)` (as in `if (x) /re/.test(y)`) would be misread. index.js has no such line; the hostile cases in
// route-permissions.test.js pin what the tokenizer does handle.

// ---- index.js: tokens -------------------------------------------------------------------------------------

// A `/` after one of these starts a regex literal; after anything else (an identifier, a number, `)`, `]`)
// it is division.
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
function regexMayStart(prev) {
  if (!prev) return true;
  if (prev.t === 'p') return prev.v !== ')' && prev.v !== ']';
  if (prev.t === 'id') return REGEX_AFTER_KEYWORD.has(prev.v);
  return false; // after a string, template, number or regex: division
}

/** Split JavaScript source into { t, v, at } tokens: id, str, tpl, re, num, p (punctuation). Comments are dropped. */
export function tokenize(src) {
  const toks = [];
  // Which `{` each `}` closes. 'tpl' marks the `${` of a template literal: its `}` resumes the template text.
  const braces = [];
  const push = (t, v, at) => toks.push({ t, v, at });
  const readTemplate = (from) => {
    let j = from;
    let raw = '';
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { raw += src.slice(j, j + 2); j += 2; continue; }
      if (c === '`') { push('tpl', raw, from); return j + 1; }
      if (c === '$' && src[j + 1] === '{') { push('tpl', raw, from); braces.push('tpl'); return j + 2; }
      raw += c;
      j++;
    }
    throw new Error(`tokenize: unterminated template literal at offset ${from}`);
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && d === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`tokenize: unterminated block comment at offset ${i}`);
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (src[j] !== c) {
        if (j >= src.length || src[j] === '\n') throw new Error(`tokenize: unterminated string at offset ${i}`);
        if (src[j] === '\\') { v += src[j + 1]; j += 2; } else v += src[j++];
      }
      push('str', v, i);
      i = j + 1;
      continue;
    }
    if (c === '`') { i = readTemplate(i + 1); continue; }
    if (c === '}' && braces.at(-1) === 'tpl') { braces.pop(); i = readTemplate(i + 1); continue; }
    if (c === '/' && regexMayStart(toks.at(-1))) {
      let j = i + 1;
      let inClass = false;
      for (;; j++) {
        if (j >= src.length || src[j] === '\n') throw new Error(`tokenize: unterminated regex literal at offset ${i}`);
        const ch = src[j];
        if (ch === '\\') { j++; continue; }
        if (inClass) { if (ch === ']') inClass = false; } else if (ch === '[') inClass = true; else if (ch === '/') break;
      }
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++; // flags
      push('re', src.slice(i, j), i);
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      push('id', src.slice(i, j), i);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d ?? ''))) {
      let j = i;
      while (j < src.length && /[\w.]/.test(src[j])) j++;
      push('num', src.slice(i, j), i);
      i = j;
      continue;
    }
    if (c === '=' && d === '>') { push('p', '=>', i); i += 2; continue; }
    if (c === '.' && d === '.' && src[i + 2] === '.') { push('p', '...', i); i += 3; continue; }
    if (c === '{') braces.push('{');
    if (c === '}') braces.pop();
    push('p', c, i);
    i++;
  }
  return toks;
}

// ---- index.js: registrations ------------------------------------------------------------------------------

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

// The top-level arguments of the call whose `(` is toks[open], each as a token list.
function readArgs(toks, open) {
  const args = [];
  let cur = [];
  let depth = 0;
  for (let j = open + 1; j < toks.length; j++) {
    const t = toks[j];
    if (t.t === 'p' && OPENERS.has(t.v)) depth++;
    if (t.t === 'p' && CLOSERS.has(t.v)) {
      if (depth === 0) {
        if (cur.length) args.push(cur);
        return args;
      }
      depth--;
    }
    if (t.t === 'p' && t.v === ',' && depth === 0) { args.push(cur); cur = []; continue; }
    cur.push(t);
  }
  throw new Error(`scan: unterminated argument list at offset ${toks[open].at}`);
}

// One argument, reduced to what a permission reviewer needs to see: a path, a named middleware, a call to a
// middleware factory, or an inline handler. `value` is set for a plain path string; `ident` for a bare name.
function describeArg(tokens) {
  const [first] = tokens;
  if (tokens.length === 1 && first.t === 'str') return { text: first.v, value: first.v };
  if (tokens.length === 1 && first.t === 'id') return { text: first.v, ident: first.v };
  if (first.t === 'p' && first.v === '[' && tokens.at(-1).v === ']') {
    const inner = tokens.slice(1, -1).filter((t) => !(t.t === 'p' && t.v === ','));
    if (inner.every((t) => t.t === 'str')) return { text: `[${inner.map((t) => t.v).join(',')}]` };
  }
  let depth = 0;
  for (const t of tokens) {
    if (t.t === 'p' && OPENERS.has(t.v)) depth++;
    if (t.t === 'p' && CLOSERS.has(t.v)) depth--;
    if (depth === 0 && t.t === 'p' && t.v === '=>') return { text: '<handler>' };
  }
  if (first.t === 'id' && (first.v === 'function' || first.v === 'async')) return { text: '<handler>' };
  // a.b.c(...) with nothing after the call's closing paren: a middleware factory such as express.json().
  let k = 0;
  const name = [];
  while (tokens[k]?.t === 'id') {
    name.push(tokens[k].v);
    if (tokens[k + 1]?.t === 'p' && tokens[k + 1].v === '.') k += 2; else { k++; break; }
  }
  if (name.length && tokens[k]?.v === '(') {
    let d = 0;
    let closesAt = -1;
    for (let j = k; j < tokens.length; j++) {
      if (tokens[j].t === 'p' && OPENERS.has(tokens[j].v)) d++;
      if (tokens[j].t === 'p' && CLOSERS.has(tokens[j].v)) { d--; if (d === 0) { closesAt = j; break; } }
    }
    if (closesAt === tokens.length - 1) return { text: `${name.join('.')}()` };
  }
  return { text: '<expr>' };
}

// Express application methods that register something a request can reach, and the ones that do not.
const REGISTERS = new Set(['use', 'get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head', 'route', 'param']);
const DOES_NOT_REGISTER = new Set(['set', 'listen', 'enable', 'disable', 'engine']);
const DECLARES = new Set(['const', 'let', 'var']);

// The name of the call `app` is an argument of, e.g. `applyTrustProxy` for `applyTrustProxy(app, x)`.
function enclosingCallee(toks, k) {
  let depth = 0;
  for (let j = k - 1; j >= 0; j--) {
    const t = toks[j];
    if (t.t !== 'p') continue;
    if (CLOSERS.has(t.v)) depth++;
    else if (OPENERS.has(t.v)) {
      if (depth === 0) {
        if (t.v !== '(' || toks[j - 1]?.t !== 'id') return '<expr>';
        return toks[j - 1].v;
      }
      depth--;
    }
  }
  return '<expr>';
}

/**
 * Every registration on `app` in an Express entry file, in source order.
 * Returns { registrations: [{ verb, args: [{ text, value?, ident? }], text }], imports: Map(local -> specifier),
 * handedTo: [callee] } — `handedTo` lists the functions `app` itself is passed to, because any of them
 * could register a route this scan cannot see; the caller pins that list.
 */
export function scanAppRegistrations(src, appName = 'app') {
  const toks = tokenize(src);
  const registrations = [];
  const imports = new Map();
  const handedTo = [];
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === 'id' && tk.v === 'import' && toks[k + 1]?.t === 'id' && toks[k + 2]?.v === 'from' && toks[k + 3]?.t === 'str') {
      imports.set(toks[k + 1].v, toks[k + 3].v);
    }
    if (tk.t !== 'id' || tk.v !== appName) continue;
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (prev?.t === 'p' && prev.v === '.') continue; // `x.app` is somebody else's property
    if (next?.t === 'p' && next.v === '.') {
      const verb = toks[k + 2]?.v;
      if (DOES_NOT_REGISTER.has(verb)) continue;
      if (!REGISTERS.has(verb) || toks[k + 3]?.v !== '(') {
        throw new Error(`scan: unrecognised \`${appName}.${verb}\` at offset ${tk.at}. Teach scanAppRegistrations ` +
          'whether it registers something a request can reach, then pin it.');
      }
      const args = readArgs(toks, k + 3).map(describeArg);
      registrations.push({ verb, args, text: [verb, ...args.map((a) => a.text)].join(' ') });
      continue; // not skipping the arguments on purpose: a registration nested inside one is still found
    }
    if (next?.t === 'p' && (next.v === '[' || next.v === '?')) {
      // `app[verb](...)`, `app?.use(...)`, `app ? a : b`: none is in index.js, and a computed method name
      // cannot be checked, so refuse rather than guess.
      throw new Error(`scan: unrecognised use of \`${appName}\` (\`${next.v}\`) at offset ${tk.at}; teach scanAppRegistrations about it.`);
    }
    if (prev?.t === 'id' && DECLARES.has(prev.v)) continue; // `const app = express()`
    handedTo.push(enclosingCallee(toks, k));
  }
  return { registrations, imports, handedTo };
}

// ---- routers: the real stack ------------------------------------------------------------------------------

/**
 * Every (method, path) a router answers, with the function objects that run before its handler.
 * `chain` = every router-level `router.use(fn)` registered EARLIER in the stack (Express runs those first,
 * which is exactly how cameras.js's `router.use(requireAuth)` gates the routes after it and not the four
 * snapshot routes before it) + the route's own layers except the last, which is the handler.
 */
export function enumerateRouter(router, mount, label) {
  if (!router || !Array.isArray(router.stack)) {
    throw new Error(`${label}: the default export has no router.stack. Express internals changed, or this is not a Router; ` +
      'update enumerateRouter rather than deleting the permission test.');
  }
  const routes = [];
  const before = [];
  for (const layer of router.stack) {
    if (!layer.route) {
      if (layer.handle?.stack) throw new Error(`${label}: a nested router is mounted inside it; enumerateRouter does not walk those yet.`);
      if (!layer.regexp?.fast_slash) throw new Error(`${label}: a router.use() with a path; enumerateRouter only understands a router-wide use().`);
      before.push(layer.handle);
      continue;
    }
    const { route } = layer;
    if (typeof route.path !== 'string' || !/^[\w/:.-]*$/.test(route.path)) {
      throw new Error(`${label}: route path ${String(route.path)} is not a plain string path; enumerateRouter cannot name it.`);
    }
    const methods = Object.keys(route.methods);
    if (methods.includes('_all')) throw new Error(`${label}: ${route.path} uses router.all(); pin it per method instead.`);
    for (const method of methods) {
      const own = route.stack.filter((l) => l.method === undefined || l.method === method).map((l) => l.handle);
      routes.push({
        key: `${method.toUpperCase()} ${mount}${route.path === '/' ? '' : route.path}`,
        method,
        mount,
        path: route.path,
        chain: [...before, ...own.slice(0, -1)],
        router,
      });
    }
  }
  return routes;
}

/**
 * The gate a chain of middleware amounts to, from the guard functions it contains (compared by IDENTITY,
 * so a wrapper or a look-alike is not mistaken for the real thing):
 *   'public'     no authentication at all
 *   'optional'   optionalAuth: answers everyone, says more to a signed-in caller
 *   'media'      requireAuthQueryOrHeader: a session header OR a media-scoped token in ?token=
 *   'signed-in'  requireAuth: a session token in the Authorization header; any role
 * plus '+admin' when requireAdmin comes AFTER authentication. requireAdmin with no authentication in front
 * of it reads an unpopulated req.user and refuses everyone, admins included (the trap timelapses.js's
 * comment describes); that shape is reported as '<auth>+admin-before-auth' so it can never match a pin.
 */
export function classifyChain(chain, guards) {
  const { requireAuth, requireAuthQueryOrHeader, optionalAuth, requireAdmin } = guards;
  let auth = 'public';
  let admin = '';
  const rank = { public: 0, optional: 1, media: 2, 'signed-in': 3 };
  const raise = (to) => { if (rank[to] > rank[auth]) auth = to; };
  for (const fn of chain) {
    if (fn === requireAuth) raise('signed-in');
    else if (fn === requireAuthQueryOrHeader) raise('media');
    else if (fn === optionalAuth) raise('optional');
    else if (fn === requireAdmin) admin = rank[auth] >= rank.media ? '+admin' : '+admin-before-auth';
  }
  return auth + admin;
}

/** Readable names for a chain, for failure messages: the known guards by name, anything else by fn.name. */
export function chainNames(chain, guards) {
  const byFn = new Map(Object.entries(guards).map(([name, fn]) => [fn, name]));
  return chain.map((fn) => byFn.get(fn) || fn.name || '<anonymous>');
}

/** A concrete URL path for a route path: every :param becomes a value no literal segment uses. */
export function instantiate(path, value = 'zz563') {
  return path.replace(/:\w+/g, value);
}

/** The path of the FIRST route in `router` that would answer `method subPath`, or null. */
export function firstMatchingRoute(router, method, subPath) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (!layer.route.methods[method]) continue;
    if (layer.match(subPath)) return layer.route.path;
  }
  return null;
}
