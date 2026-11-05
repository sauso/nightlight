import { useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useDemoStatus } from '../lib/demoStatus.js';
import { useTailscale } from '../lib/useTailscale.js';
import { blockerMessage, videoTestMessage } from '../lib/tailscaleCopy.js';
import { probeLowLatency } from '../lib/webrtcProbe.js';
import { copyText } from '../lib/copyText.js';
import LoadFailed from './LoadFailed.jsx';
import Modal from './Modal.jsx';

const NETWORK_DOCS = 'https://github.com/sauso/nightlight/blob/main/docs/networking.md';
const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// These values are shown as clickable destinations and as QR data. Never let an API error
// supply a script URL or an unvetted host to either route.
function httpsLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function secureAddress(name) {
  return typeof name === 'string' && /^(?:[a-z0-9-]+\.)+ts\.net$/.test(name)
    ? `https://${name}/` : null;
}

function QrCode({ value, label }) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const cells = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) cells.push(<rect key={`${row}-${column}`} x={column + 4} y={row + 4} width="1" height="1" />);
    }
  }
  return <figure className="tailscale-qr">
    <svg role="img" aria-label={label} viewBox={`0 0 ${count + 8} ${count + 8}`} xmlns="http://www.w3.org/2000/svg">
      <rect width={count + 8} height={count + 8} className="tailscale-qr__background" />
      <g className="tailscale-qr__modules">{cells}</g>
    </svg>
    <figcaption>{label}</figcaption>
  </figure>;
}

export default function TailscaleCard({ compact = false, publicHostSet = false, onReady }) {
  const { view, loading, error, busy, consentUrl, load, act, setEnabled } = useTailscale();
  const demo = useDemoStatus();
  const readOnly = demo !== null;
  const { cameras } = useCameras();
  const camera = cameras.find((item) => !item.disabled && item.status?.ready && item.mediamtx_path);
  const [name, setName] = useState('nightlight');
  const [confirm, setConfirm] = useState(null);
  const [probe, setProbe] = useState(null);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(null); // null | 'copied' | 'manual' (see lib/copyText.js)
  const probeRef = useRef(null);
  const previousState = useRef(null);
  const region = useRef(null);

  // MEASURED 2026-11-04: after a reset Tailscale named the new device `nightlight-staging-1` because the old entry still
  // existed, while the saved setting stayed `nightlight-staging`. Show the name the device really has once it has one.
  const currentName = view?.dns_name ? view.dns_name.split('.')[0] : view?.hostname;
  useEffect(() => { if (currentName) setName(currentName); }, [currentName]);
  // Codex review of #978 (verified): the sign-in link replaces the Sign in button inside the same state, so watching the
  // state alone dropped focus to <body>. The key changes whenever the card's primary control does.
  const focusKey = view ? `${view.state}|${view.login_url ? 'link' : ''}|${consentUrl ? 'consent' : ''}|${view.serve?.enabled ? 'https' : ''}` : null;
  useEffect(() => {
    if (!focusKey) return;
    // Polls change the card in place. Put keyboard focus on its new next step only when it changes.
    if (previousState.current && previousState.current !== focusKey) {
      region.current?.querySelector('[data-tailscale-primary]')?.focus({ preventScroll: true });
    }
    previousState.current = focusKey;
  }, [focusKey]);
  useEffect(() => () => probeRef.current?.abort(), []);
  // Owner testing 2026-11-05: the setup wizard kept offering "Maybe later" on a card that already showed the secure address,
  // because only this card knows the connection state. "Ready" means the thing the card promises exists: connected AND the
  // secure address is being served. Connected without the address is still an unfinished step, so it reports false.
  const ready = view?.state === 'connected' && Boolean(view.serve?.enabled);
  useEffect(() => { onReady?.(ready); }, [ready, onReady]);

  async function signIn() {
    if (!NAME.test(name)) return;
    if (name !== view.hostname && !await act('hostname', { hostname: name })) return;
    await act('sign-in');
  }

  async function rename(event) {
    event.preventDefault();
    if (!NAME.test(name) || name === currentName) return;
    const hadHttps = view.serve?.enabled;
    if (!await act('hostname', { hostname: name })) return;
    // Measured: Tailscale leaves Serve under the old DNS name after a rename.
    if (hadHttps) await act('serve-enable');
  }

  async function testVideo() {
    if (!camera || probeRef.current) return;
    const controller = new AbortController();
    probeRef.current = controller;
    setTesting(true);
    setProbe(null);
    const result = await probeLowLatency({ mediamtxPath: camera.mediamtx_path, signal: controller.signal });
    if (probeRef.current === controller) { setProbe(result); setTesting(false); probeRef.current = null; }
  }

  async function copyAddress(address) {
    setCopied(await copyText(address));
  }

  const address = secureAddress(view?.dns_name);
  const login = httpsLink(view?.login_url);
  const consent = httpsLink(consentUrl || view?.serve?.consent_url);
  const originIsTailnet = view?.dns_name && window.location.hostname === view.dns_name;
  const disabled = busy || readOnly;
  const button = (label, onClick, primary = true, extraDisabled = false) =>
    <button type="button" className={`btn ${primary ? 'btn-primary' : 'btn-secondary'}`} data-tailscale-primary={primary ? '' : undefined}
      disabled={disabled || extraDisabled} onClick={onClick}>{label}</button>;

  let content;
  if (!view) {
    content = loading ? <p>Loading…</p> : <LoadFailed what="Tailscale details" onRetry={readOnly ? undefined : load} />;
  } else if (!view.enabled || view.state === 'off') {
    content = <>
      <p role="status">Use Tailscale to watch your cameras away from home, with no router changes. It stays private to your Tailscale account.</p>
      <ul><li>No port forwarding or public address.</li><li>Everyone who watches away from home installs the Tailscale app and joins your network.</li><li>Watching at home works either way.</li></ul>
      {publicHostSet && <p>Your own-domain setup is working and stays as it is.</p>}
      {view.blocker ? <><p>{blockerMessage(view.blocker)}</p>{view.blocker === 'host_network' && <a href={NETWORK_DOCS} target="_blank" rel="noreferrer">How to do this</a>}</>
        : button('Turn on Tailscale', () => setEnabled(true))}
    </>;
  } else if (view.state === 'error') {
    content = <><p role="status">Tailscale stopped. Watching at home still works.</p>{button('Retry', () => setEnabled(true))}</>;
  } else if (view.state === 'starting') {
    content = <><p role="status">Starting Tailscale…</p>{button('Retry', load)}</>;
  } else if (view.state === 'needs-sign-in') {
    content = <>
      <h3>Sign in to Tailscale</h3>
      {view.last_error === 'timeout' && <p role="status">Sign-in expired. Sign in again.</p>}
      {!login ? <>
        <div className="field"><label htmlFor="tailscale-name">Device name</label><input id="tailscale-name" value={name} maxLength={63}
          pattern="[a-z][a-z0-9-]*[a-z0-9]|[a-z]" onChange={(event) => setName(event.target.value)} disabled={disabled} />
          <p className="tailscale-hint">This becomes part of your address. Keep it neutral: Tailscale lists device names publicly when it issues certificates, so don't use family or child names.</p></div>
        {button('Sign in with Tailscale', signIn, true, !NAME.test(name))}
      </> : <>
        <p>Open the link and approve Nightlight. You can also scan the code with your phone.</p>
        {readOnly ? <span className="btn btn-primary" aria-disabled="true">Open Tailscale sign-in</span>
          : <a className="btn btn-primary" data-tailscale-primary href={login} target="_blank" rel="noreferrer">Open Tailscale sign-in</a>}
        <QrCode value={login} label="Scan to sign in to Tailscale" />
        <p role="status">Waiting for you to approve…</p>
        {button('Cancel', () => setEnabled(false), false)}
      </>}
    </>;
  } else if (view.state === 'connected' && !view.serve?.enabled) {
    content = <>
      <p role="status">Connected to your Tailscale account.</p>
      {consentUrl ? <>
        <p>Tailscale needs you to approve HTTPS for your account first.</p>
        {consent && (readOnly ? <span className="btn btn-secondary" aria-disabled="true">Open Tailscale approval</span>
          : <a className="btn btn-secondary" href={consent} target="_blank" rel="noreferrer">Open Tailscale approval</a>)}
        {button('Try again', () => act('serve-enable'))}
      </> : <>
        <p>Next, turn on the secure address. Phones open Nightlight over HTTPS, which two-way talk needs.</p>
        {button('Turn on the secure address', () => act('serve-enable'))}
      </>}
    </>;
  } else if (view.state === 'connected') {
    content = <>
      <p role="status">Connected to your Tailscale account.</p>
      <h3>Your secure address</h3>
      {address ? <>
        <p className="tailscale-address">{address}</p>
        <div className="tailscale-actions"><button className="btn btn-secondary" type="button" disabled={disabled} onClick={() => copyAddress(address)}>Copy</button>
          {readOnly ? <span className="btn btn-primary" aria-disabled="true">Open</span>
            : <a className={`btn ${view.video_address_pending ? 'btn-secondary' : 'btn-primary'}`} data-tailscale-primary={view.video_address_pending ? undefined : ''} href={address} target="_blank" rel="noreferrer">Open</a>}</div>
        {copied === 'copied' && <p role="status">Address copied.</p>}
        {copied === 'manual' && <p role="status">Couldn't copy. Select the address above and copy it.</p>}
        <QrCode value={address} label="Scan to open on your phone" />
      </> : <><p>Waiting for your secure address…</p>{button('Retry', load)}</>}
      <h3>Add someone</h3>
      <ol><li>Install Tailscale on their phone or computer.</li><li>Invite them to your Tailscale network, or share this device with them from the Tailscale admin console.</li><li>Open the address above and sign in with their Nightlight account.</li></ol>
      <p>Joining Tailscale doesn't replace a Nightlight account. Add caregivers in Settings → Caregivers.</p>
      {/* Codex review of #978 (verified): pending=false is also what the server says before it has found the address, so it is not proof of ready. Claim nothing until there is an update to report. */}
      {view.video_address_pending && <p role="status">Low latency video: updating. Viewers reconnect once.</p>}
      {view.video_address_pending && button('Apply now', () => act('apply-video-address'))}
      <h3>Check it works</h3>
      {!camera && <p>No camera is running yet, so there is nothing to test. Add or start a camera first.</p>}
      <button className="btn btn-secondary" type="button" disabled={disabled || testing || !camera} onClick={testVideo}>{testing ? 'Testing…' : 'Test video'}</button>
      {probe && <p role="status">{videoTestMessage(probe, originIsTailnet)}</p>}
    </>;
  }

  return <section ref={region} className={compact ? 'tailscale-card tailscale-card--compact' : 'card tailscale-card'} aria-label="Watch from anywhere">
    {!compact && <div className="tailscale-card__heading"><h2 className="card-title">Watch from anywhere</h2><span className="status-badge status-badge--ok">Recommended</span></div>}
    {compact && <span className="status-badge status-badge--ok">Recommended</span>}
    {error && view && !confirm && <div className="error-banner" role="alert">{error} {button('Retry', load, false)}</div>}
    {content}
    {view && <details className="tailscale-advanced"><summary>Advanced</summary>
      <form onSubmit={rename}><div className="field"><label htmlFor="tailscale-rename">Rename this device</label>
        <input id="tailscale-rename" value={name} maxLength={63} onChange={(event) => setName(event.target.value)} disabled={disabled || !view.enabled} /></div>
        <button type="submit" className="btn btn-secondary" disabled={disabled || !view.enabled || !NAME.test(name) || name === currentName}>Save</button></form>
      <button type="button" className="btn btn-secondary" disabled={disabled || !view.serve?.enabled} onClick={() => setConfirm('serve-disable')}>Turn off the secure address</button>
      <button type="button" className="btn btn-secondary" disabled={disabled || !view.enabled} onClick={() => setConfirm('logout')}>Log out of Tailscale</button>
      <button type="button" className="btn btn-danger" disabled={disabled} onClick={() => setConfirm('reset')}>Reset this device's Tailscale identity</button>
      <button type="button" className="btn btn-danger" disabled={disabled || !view.enabled} onClick={() => setConfirm('disable')}>Turn off Tailscale</button>
    </details>}
    {readOnly && <p>This demo is read-only, so changes are disabled.</p>}
    {confirm && <Modal title={confirm === 'reset' ? 'Reset this device’s Tailscale identity?' : confirm === 'logout' ? 'Log out of Tailscale?' : confirm === 'serve-disable' ? 'Turn off the secure address?' : 'Turn off Tailscale?'} error={error} onClose={() => setConfirm(null)}>
      <p>{confirm === 'reset' ? 'Use this for a copied installation. This device will rejoin Tailscale as a new one, and viewers will need its new address.'
        : confirm === 'logout' ? 'Viewers will lose this Tailscale connection until you sign in again.'
          : confirm === 'serve-disable' ? 'The secure address will stop working until you turn it on again.'
            : 'Viewers will lose this Tailscale connection. Watching at home still works.'}</p>
      {originIsTailnet && <p>You are viewing this page through Tailscale, so it will stop loading until Tailscale is set up again. Open Nightlight from your home network to do that.</p>}
      <div className="tailscale-actions"><button className="btn btn-secondary" type="button" onClick={() => setConfirm(null)}>Cancel</button>
        <button className="btn btn-danger" type="button" disabled={disabled} onClick={async () => { const done = confirm === 'disable' ? await setEnabled(false) : await act(confirm); if (done) setConfirm(null); }}>
          {confirm === 'reset' ? 'Reset identity' : confirm === 'logout' ? 'Log out' : confirm === 'serve-disable' ? 'Turn off address' : 'Turn off'}</button></div>
    </Modal>}
  </section>;
}
