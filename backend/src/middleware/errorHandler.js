import { logger } from '../lib/logger.js';

// The last middleware in index.js. Turns anything a route handler throws, rejects, or hands to `next(err)`
// into ONE JSON answer, so a failure is never a request left hanging (issue #544; see lib/asyncHandler.js
// for how a rejected async handler gets here).
//
// The shape is `{ error: '<message>' }`, the same key every route already uses for its own errors, so no
// client has to learn anything new.
//
// THE 4xx-vs-5xx RULE (also stated for operators in docs/architecture.md):
//   - A 4xx means "the request was wrong and the person can fix it"; it carries a readable message.
//     Cloudflare, and some other proxies, REPLACE a 5xx body with their own page, so a message the user
//     must read can only survive as a 4xx. Hence: a SQLite foreign-key failure (a stale tab saving a
//     reference to something deleted in another tab) is a 409, and an error carrying its own 4xx
//     `status`/`statusCode` (body-parser's 400 for malformed JSON, 413 for an oversized body) keeps it.
//   - Anything else is a server bug: 500 with a GENERIC message. The real error (class, message, stack) is
//     logged here and never sent. A SqliteError message names tables and columns and a stack names source
//     paths; neither belongs in a response to a caller who may be unauthenticated.
//
// Errors are never swallowed: every 5xx, and every 4xx that did not come with a client-safe message, is
// logged.

const GENERIC_500 = 'Something went wrong on the server. Check the Nightlight logs for details.';

const GENERIC_4XX = {
  400: 'The request was not valid.',
  404: 'Not found.',
  405: 'That method is not allowed here.',
  409: 'That conflicts with the current state. Reload the page and try again.',
  413: 'The request is too large.',
  415: 'Unsupported content type.',
  422: 'The request could not be processed.',
};

// SQLite names a failed foreign key with this extended result code. better-sqlite3 puts it on `err.code`.
const FOREIGN_KEY = 'SQLITE_CONSTRAINT_FOREIGNKEY';
const FOREIGN_KEY_MESSAGE =
  'That refers to something that no longer exists (it may have been deleted in another tab). Reload the page and try again.';

// A 4xx the error asked for, or 0. 401 and 403 are excluded on purpose: the web UI treats them as "your
// session ended" / "you may not", so a library error that happens to carry the HTTP status of ITS upstream
// (a 401 from a push provider, say) must not sign the user out of Nightlight. Auth responses are only ever
// produced by middleware/auth.js.
function requestedClientStatus(err) {
  for (const candidate of [err?.status, err?.statusCode]) {
    if (Number.isInteger(candidate) && candidate >= 400 && candidate <= 499 && candidate !== 401 && candidate !== 403) {
      return candidate;
    }
  }
  return 0;
}

// Query strings can carry a media token (`?token=` on snapshot/HLS/clip routes), so they never go to the log.
function loggablePath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function describe(err) {
  if (err instanceof Error) return err.stack || err.message;
  try { return typeof err === 'string' ? err : JSON.stringify(err); } catch { return String(err); }
}

// Four parameters: that is how Express recognises an error handler. Do not drop `next`.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const where = `${req.method} ${loggablePath(req)}`;

  if (res.headersSent) {
    // A response is already on the wire (a streamed body that failed half-way, say). If it is still open,
    // Express's own handler is the right one: it destroys the socket so the client sees a failure instead
    // of a truncated body that looks complete. If it already ended, the client has its full answer and
    // there is nothing to close, so just record that something went wrong AFTER the reply (before this
    // existed that case was an unhandled rejection that was logged and ignored; destroying a finished
    // keep-alive socket over it would be a new, worse behaviour).
    logger.error(`[http] ${where}: error after the response was started: ${describe(err)}`);
    if (!res.writableEnded) return next(err);
    return undefined;
  }

  if (err?.code === FOREIGN_KEY) {
    logger.warn(`[http] ${where}: foreign key failed (answered 409): ${describe(err)}`);
    return res.status(409).json({ error: FOREIGN_KEY_MESSAGE });
  }

  const clientStatus = requestedClientStatus(err);
  if (clientStatus) {
    // Only `expose === true` (http-errors / body-parser's "safe to show a client" flag) lets the message out.
    // A bare `{ status: 400 }` from some other library gets the generic text for its status, and is logged
    // so it is not invisible.
    const exposable = err.expose === true && typeof err.message === 'string' && err.message;
    if (!exposable) logger.warn(`[http] ${where}: answered ${clientStatus} from an error that carried that status: ${describe(err)}`);
    const message = exposable ? err.message.slice(0, 200) : (GENERIC_4XX[clientStatus] || GENERIC_4XX[400]);
    return res.status(clientStatus).json({ error: message });
  }

  logger.error(`[http] ${where}: unhandled error (answered 500): ${describe(err)}`);
  return res.status(500).json({ error: GENERIC_500 });
}
