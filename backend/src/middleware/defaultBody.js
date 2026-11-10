// Gives every request an object `req.body`, as Express 4's body parser did.
//
// Express 5's body parser leaves `req.body` UNDEFINED when a request carries no body, or a content type it does
// not parse; Express 4 set it to `{}`. Most route handlers already guard (`req.body || {}`), and the Express 4 vs
// 5 comparison found no route that would 500 without this today; what it protects is exact answers (two routes'
// 400 messages: PATCH /api/setup/progress and POST /api/esphome/devices read the body directly and would give a
// different message) and any future handler that reads `req.body.x` the way handlers always could.
// Mounted straight after express.json() in index.js.
export function defaultBody(req, res, next) {
  if (req.body === undefined) req.body = {};
  next();
}
