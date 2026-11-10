import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin, verifyToken } from '../middleware/auth.js';
import { detectHostNetwork } from '../lib/hostNetwork.js';
import { tailnetEnableBlocker } from '../lib/tailnetPreconditions.js';
import { startTailscale, stopTailscale, getTailscaleStatus, getTailscalePid, hasLiveTailscaleProcess } from '../lib/tailscaleProcess.js';
import { runTailscaleCli, validateHostname, getTailscaleLinks, cancelTailscaleCli, approvedLoginUrl } from '../lib/tailscaleCli.js';
import { resetTailscaleState } from '../lib/tailscaleState.js';
import { isDemoModeActive } from '../middleware/demoMode.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { vettedTailnetIPv4, setTailnetAddress } from '../lib/tailnetAddress.js';
import { applyVideoAddressNow, videoAddressPending } from '../lib/videoAddressSync.js';

function cleanStatus(result) {
  if (!result.ok) return { state: 'error', addresses: [], dns_name: null, login_url: null,
    error: typeof result.code === 'string' && /^[a-z_]+$/.test(result.code) ? result.code : 'status_unavailable' };
  const self = result.json.Self;
  const backendState = result.json.BackendState;
  const addresses = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs.filter((value) => vettedTailnetIPv4([value]) !== null) : [];
  const dns = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
  const dns_name = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(dns) ? dns : null;
  const state = backendState === 'Running' ? 'connected' :
    (backendState === 'NeedsLogin' || result.json.AuthURL ? 'needs-sign-in' : 'starting');
  // MEASURED 2026-11-05 on the owner's staging node: deleting the device from the tailnet flips `Self.Online` from true to false
  // within about two seconds while `BackendState` stays "Running" and `Health` stays empty, so this is the only field that says
  // the node has lost its coordination server. A boolean or null (a daemon that does not say, or a status we could not read):
  // the card must tell "false" from "unknown". Not a cause: an outage, a Tailscale incident and a removed device all read false.
  const online = typeof self?.Online === 'boolean' ? self.Online : null;
  return { state, addresses, dns_name, login_url: approvedLoginUrl(result.json.AuthURL), online };
}

export function createTailscaleRouter({ database = db, dataDir = process.env.DATA_DIR || '/app/data',
  detect = detectHostNetwork, detector = () => detect({ ownedPid: getTailscalePid() }),
  blocker = tailnetEnableBlocker, start = startTailscale,
  stop = stopTailscale, status = getTailscaleStatus, hasLiveProcess = hasLiveTailscaleProcess,
  verify = verifyToken, onEnqueued = () => {}, cli = runTailscaleCli,
  pendingVideoAddress = videoAddressPending, applyVideoAddress = applyVideoAddressNow,
  addressCacheMs = 5000,
  write = (value) => database.prepare("UPDATE settings SET tailscale_enabled = ? WHERE id = 'app'").run(value) } = {}) {
  const router = Router();
  let tail = Promise.resolve();
  let lastError = null;
  const enabled = () => database.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get()?.tailscale_enabled === 1;
  const hostname = () => database.prepare("SELECT tailscale_hostname FROM settings WHERE id = 'app'").get()?.tailscale_hostname ?? 'nightlight';
  // What the daemon says right now, shared by the admin status below and by the signed-in address endpoint further down.
  const readRemote = async () => {
    const hostNetwork = detector();
    const process = status();
    let remote = { state: !enabled() ? 'off' : process.state === 'unavailable' ? 'error' : 'starting',
      addresses: [], dns_name: null, login_url: null };
    let serve = { enabled: false, consent_url: getTailscaleLinks().consentUrl };
    // false only when the serve-status read itself failed: `serve.enabled` is then false for lack of an answer, which the admin
    // status shows as "not on" but which /address must not report as "off" (Codex review of #1001, verified).
    let serveKnown = true;
    if (enabled() && process.state === 'running') {
      remote = cleanStatus(await cli('status-peerless'));
      const served = await cli('serve-status');
      serveKnown = served.ok === true;
      const web = served.ok ? served.json?.Web : null;
      // Lead review of #978 (Codex, verified): after a rename Tailscale leaves the Serve entry under the OLD name (measured
      // 2026-11-04), so 'any :443 entry' reported the secure address as on while the NEW name served nothing. The entry must
      // be for the name this node has now. With no vetted DNS name there is nothing to compare, so it is not on.
      const serving = web && typeof web === 'object' && remote.dns_name && Object.entries(web).some(([address, config]) =>
        address === `${remote.dns_name}:443` && config?.Handlers?.['/']?.Proxy === 'http://127.0.0.1:4000');
      serve = { enabled: Boolean(serving),
        consent_url: getTailscaleLinks().consentUrl };
    }
    return { hostNetwork, process, remote, serve, serveKnown };
  };
  const view = async () => {
    const { hostNetwork, process, remote, serve } = await readRemote();
    return { enabled: enabled(), process,
      blocker: blocker(database, { hostNetwork })?.code ?? null, host_network: hostNetwork,
      state: remote.state, addresses: remote.addresses, dns_name: remote.dns_name, online: remote.online ?? null,
      login_url: remote.state === 'connected' || remote.state === 'off' ? null :
        (remote.login_url ?? getTailscaleLinks().loginUrl), serve,
      last_error: lastError ?? remote.error ?? (process.state === 'unavailable' && typeof process.reason === 'string' &&
        /^[a-z_]+$/.test(process.reason) ? process.reason : null),
      hostname: hostname(), video_address_pending: pendingVideoAddress() };
  };
  const conflict = (res, code, message) => res.status(409).json({ error: message, code });

  // #970 CI: the class guard in async-errors.test.js refuses an unwrapped async route handler, and
  // this one became async when status started reading the CLI. The try/catch keeps its own 409 shape.
  router.get('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    try { res.json(await view()); }
    catch { conflict(res, 'status_unavailable', 'Tailscale status is unavailable.'); }
  }));
  // The address the phone apps may fall back to when the local one does not answer (owner, 2026-11-06). ANY signed-in user, not
  // only admins, because a caregiver's phone needs it as much as an admin's; the answer is a single https address that only
  // opens from inside the tailnet, and the admin-only status above stays the one place that shows everything else.
  //
  // Three answers, and the difference matters because the phone DROPS a saved address on `url: null`:
  //   * { url: "https://<name>.ts.net" }  Tailscale is connected AND private HTTPS Serve is on for the node's CURRENT name
  //                                       (the same test as `serve.enabled`, #978).
  //   * { url: null }                     definitely not available: an admin has Tailscale off, or it is connected with Serve off.
  //   * 409                               not known right now (the daemon is starting, needs sign-in, or its status could not be
  //                                       read). The phone keeps what it has: a daemon restart must not erase the address.
  //
  // Each answer costs two CLI runs, so concurrent callers share one read and a finished read is reused for a few seconds
  // (Codex review of #1001: 30 concurrent callers ran the CLI 60 times). Only the DAEMON read is shared: the admin's on/off
  // intent is read fresh on every request, so turning Tailscale off shows at once.
  let addressRead = null;
  let addressReadAt = 0;
  const readAddress = () => {
    const now = Date.now();
    if (!addressRead || now - addressReadAt >= addressCacheMs) {
      addressReadAt = now;
      addressRead = readRemote().then(({ remote, serve, serveKnown }) => {
        if (remote.state === 'connected' && remote.dns_name && serveKnown) {
          return { known: true, url: serve.enabled ? `https://${remote.dns_name}` : null };
        }
        return { known: false };
      }, () => ({ known: false }));
    }
    return addressRead;
  };
  // Both routes use this instance, including its daemon-read cache. The enabled switch stays fresh on every request.
  router.resolveAddress = async () => !enabled() ? { known: true, url: null } : readAddress();
  router.get('/address', requireAuth, asyncHandler(async (req, res) => {
    const answer = await router.resolveAddress();
    if (answer.known) return res.json({ url: answer.url });
    return conflict(res, 'status_unavailable', 'The Tailscale address is not known right now.');
  }));
  router.put('/', requireAuth, requireAdmin, (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 ||
      typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'Expected only enabled as a boolean.' });
    }
    // Opus review of #970 (verified by running): a sign-in that never prints a link holds the route
    // queue for its whole 5 minute timeout, so a disable queued behind it waited just as long. The
    // cancel runs BEFORE queueing so the stalled job ends. It is safe for any admin that got past
    // the middleware: it only ends a pending sign-in and clears the stored links.
    if (req.body.enabled === false) void cancelTailscaleCli();
    // Opus plan review of #967: a queued request can lose its live session or
    // admin role while an earlier stop waits for its child to exit.
    const job = async () => {
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
      const live = verify(token);
      if (!live) return res.status(401).json({ error: 'Invalid or expired session' });
      if (live.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      try {
        if (req.body.enabled) {
          const hostNetwork = detector();
          const blocked = blocker(database, { hostNetwork });
          if (blocked) return conflict(res, blocked.code, blocked.message);
          start({ db: database, dataDir });
          const now = status();
          if (now.state === 'stopping' || (now.state === 'unavailable' && hasLiveProcess())) {
            return conflict(res, 'busy', 'The tunnel daemon is still stopping.');
          }
          if (now.state === 'unavailable') {
            // Opus fix review of #967: launch() stops a spawned child in its
            // catch; a live child was already handled by the busy branch.
            return conflict(res, now.reason || 'unavailable', 'The tunnel daemon could not start.');
          }
          if (!['starting', 'running', 'backoff'].includes(now.state)) {
            return conflict(res, 'busy', 'The tunnel daemon is not ready.');
          }
          try { write(1); }
          catch {
            await stop();
            return conflict(res, 'could_not_save', 'The Tailscale setting could not be saved.');
          }
        } else {
          try { write(0); }
          catch { return conflict(res, 'could_not_save', 'The Tailscale setting could not be saved.'); }
          lastError = null; // Opus review of #970: an old action error must not outlive a disable.
          setTailnetAddress(null);
          await cancelTailscaleCli();
          await stop();
          if (status().state !== 'off') {
            return res.status(409).json({ ...await view(), error: 'The tunnel daemon may still be running.', code: 'stop_uncertain' });
          }
        }
        return res.json(await view());
      } catch { return conflict(res, 'operation_failed', 'Tailscale could not complete the request.'); }
    };
    // Opus plan review of #967: a rejected job must not poison later requests.
    // Opus fix review of #967: this seam records that a queued request passed
    // both auth middlewares before a test revokes or demotes its live session.
    onEnqueued(req);
    const current = tail.then(job, job);
    tail = current.catch(() => {});
    return current.catch(() => {
      if (!res.headersSent) conflict(res, 'operation_failed', 'Tailscale could not complete the request.');
    });
  });
  const actions = new Set(['sign-in', 'hostname', 'serve-enable', 'serve-disable', 'logout', 'reset', 'apply-video-address']);
  router.post('/actions', requireAuth, requireAdmin, (req, res) => {
    if (!req.body || Array.isArray(req.body) || !actions.has(req.body.action) ||
      Object.keys(req.body).some((key) => !['action', 'hostname'].includes(key)) ||
      (req.body.action === 'hostname' ? !validateHostname(req.body.hostname) || Object.keys(req.body).length !== 2
        : Object.keys(req.body).length !== 1)) {
      return res.status(400).json({ error: 'Invalid Tailscale action.' });
    }
    onEnqueued(req);
    // Same reason as the PUT: logout and reset must not wait out a stalled sign-in.
    if (req.body.action === 'logout' || req.body.action === 'reset') void cancelTailscaleCli();
    const job = async () => {
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
      const live = verify(token);
      if (!live?.id) return res.status(401).json({ error: 'Invalid or expired session' });
      if (live.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      if (isDemoModeActive()) return res.status(403).json({ error: 'This is a read-only public demo - that action is disabled here.' });
      const action = req.body.action;
      // #974: applying a cached host is available even after the daemon is turned off.
      if (action === 'apply-video-address') {
        const applied = await applyVideoAddress();
        if (applied === null) return res.status(409).json({ ...await view(), applied: false,
          code: 'busy', error: 'A video address check is in progress. Try again in a moment.' });
        if (applied === false) return res.status(409).json({ ...await view(), applied: false,
          code: 'video_address_not_applied', error: 'The video address could not be applied.' });
        return res.json({ ...await view(), applied });
      }
      const blocked = blocker(database, { hostNetwork: detector() });
      if (blocked) return conflict(res, blocked.code, blocked.message);
      if (action !== 'reset' && (!enabled() || status().state !== 'running'))
        return conflict(res, 'daemon_not_ready', 'The tunnel daemon is not ready.');
      let result;
      if (action === 'reset') {
        await cancelTailscaleCli();
        await stop();
        if (status().state !== 'off') return conflict(res, 'stop_uncertain', 'The tunnel daemon may still be running.');
        if (!resetTailscaleState({ dataDir })) return conflict(res, 'reset_failed', 'Could not reset the Tailscale connection.');
        setTailnetAddress(null);
        if (enabled()) start({ db: database, dataDir });
        result = { ok: true };
      } else if (action === 'hostname') {
        result = await cli('set-hostname', { hostname: req.body.hostname });
        if (result.ok) database.prepare("UPDATE settings SET tailscale_hostname = ? WHERE id = 'app'").run(req.body.hostname);
      } else if (action === 'sign-in') result = await cli('up', { hostname: hostname() });
      else if (action === 'logout') { await cancelTailscaleCli(); result = await cli('logout'); if (result.ok) setTailnetAddress(null); }
      else if (action === 'serve-enable') result = await cli('serve-set');
      else result = await cli('serve-reset');
      if (!result.ok) {
        lastError = result.code;
        return res.status(409).json({ code: result.code,
          error: result.code === 'consent_required' ? 'Tailscale needs HTTPS approval.' : 'Tailscale could not complete the request.',
          ...(result.consentUrl ? { consent_url: result.consentUrl } : {}) });
      }
      lastError = null;
      return res.json({ ...await view(), ...(result.loginUrl ? { login_url: result.loginUrl } : {}) });
    };
    const current = tail.then(job, job);
    tail = current.catch(() => {});
    return current.catch(() => { if (!res.headersSent) conflict(res, 'operation_failed', 'Tailscale could not complete the request.'); });
  });
  return router;
}

export default createTailscaleRouter();
