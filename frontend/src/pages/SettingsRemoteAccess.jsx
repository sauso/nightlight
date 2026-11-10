import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { probeLowLatency } from '../lib/webrtcProbe.js';
import AppHeader from '../components/AppHeader.jsx';
import TailscaleCard from '../components/TailscaleCard.jsx';

const DOCS = 'https://github.com/sauso/nightlight/blob/main/docs/remote-access.md';
const TRUST_PROXY_DOCS = `${DOCS}#trust_proxy--telling-nightlight-your-real-client-addresses`;
const STUN_DOCS = `${DOCS}#stun_servers--which-stun-servers-low-latency-webrtc-uses`;

// #962: network stays unknown for tunnel peers and untrusted proxies. The separate via field
// explains which guidance applies without guessing whether the viewer is at home.
const NETWORK = {
  home: "You're on your home network. From here this page can't prove your port forwards work: open it from mobile data to check.",
  vpn: "You're connected through a VPN (such as Tailscale). Remote access through your router isn't being tested from here.",
  remote: "You're outside your home network. A successful test below shows your port forwards work.",
  unknown: "Nightlight can't tell where you're connecting from.",
};
const DNS_ERRORS = { not_found: 'name not found', timeout: 'lookup timed out', failed: 'lookup failed' };

function hostSentence(entry) {
  if (entry.error) return `${entry.host}: ${DNS_ERRORS[entry.error] || 'lookup failed'}.`;
  if (!entry.addresses.length) return `No addresses returned for ${entry.host}.`;
  return entry.kind === 'ip'
    ? `${entry.host} is an IP address, advertised as ${entry.addresses.join(', ')}.`
    : `${entry.host} resolves to ${entry.addresses.join(', ')}.`;
}

function DocsLink({ href = DOCS, children }) {
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}

function testMessage(network, via, result, port) {
  if (!result) return null;
  if (result.outcome === 'unsupported') return "This browser can't make a Low latency connection.";
  if (result.outcome === 'connected') {
    if (via === 'tailscale') return 'Low latency video works through Tailscale.';
    if (network === 'remote') {
      return result.protocol?.toLowerCase() === 'udp'
        ? 'Low latency video works from outside your home. Your port forward and PUBLIC_HOST are set up correctly.'
        : 'Low latency video connected, but not over UDP. Check the UDP port forward.';
    }
    return "Connected, but you're not outside your home network, so this doesn't prove the forward works. Try again from mobile data.";
  }
  if (via === 'tailscale') return "Couldn't connect. Low latency video isn't working from here (Compatibility mode still works).";
  return network === 'remote'
    ? `Couldn't connect from outside. Check the UDP forward (port ${port}) and PUBLIC_HOST.`
    : "Couldn't connect. Low latency video isn't working from here (Compatibility mode still works).";
}

export default function SettingsRemoteAccess() {
  const { cameras } = useCameras();
  const camera = cameras.find((item) => !item.disabled && item.status?.ready && item.mediamtx_path);
  const [setup, setSetup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const active = useRef(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setSetup(await api.get('/remote-access')); }
    catch { setError("Couldn't load remote access details. Check your connection, then try again."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; active.current?.abort(); };
  }, [load]);

  async function runTest() {
    if (active.current || !camera || !setup) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setResult(null);
    // No automatic or external reachability check: this is the viewer's normal WHEP connection (#558).
    const next = await probeLowLatency({ mediamtxPath: camera.mediamtx_path, signal: controller.signal });
    if (mounted.current) { setResult(next); setBusy(false); }
    if (active.current === controller) active.current = null;
  }

  const network = setup?.client?.network || 'unknown';
  const via = setup?.client?.via ?? null;
  const message = testMessage(network, via, result, setup?.webrtc_udp_port);

  return <>
    <AppHeader title="Remote Access" back={{ to: '/settings', label: 'Settings' }} />
    <main className="app-main">
      <TailscaleCard publicHostSet={Boolean(setup?.public_host_set)} />
      {loading && !setup && <p>Loading…</p>}
      {error && <div className="error-banner" role="alert">{error} <button type="button" className="btn btn-secondary" onClick={load}>Retry</button></div>}
      {setup && <>
        <details className="remote-advanced"><summary>Use your own domain or port forward (advanced)</summary>
        <section className="card about-card" aria-labelledby="remote-network-title">
          <div className="about-card__heading">
            <h2 id="remote-network-title" className="card-title">Where you're connecting from</h2>
            <span className={`status-badge ${via === 'tailscale' ? 'status-badge--ok' : 'status-badge--off'}`}>{via === 'tailscale' ? 'Tailscale' : network === 'vpn' ? 'VPN' : network === 'home' ? 'Home' : network === 'remote' ? 'Outside home' : 'Unknown'}</span>
          </div>
          <p className="about-card__text">{via === 'tailscale' ? "This looks like a connection through your private Tailscale address. If so, your router isn't involved and the port-forward test below doesn't apply."
            : via === 'proxy' ? "Nightlight received a forwarded address it doesn't trust, usually from a reverse proxy that TRUST_PROXY doesn't list, so it can't tell where you are."
              : NETWORK[network] || NETWORK.unknown}{via === 'proxy' && <> (<DocsLink href={TRUST_PROXY_DOCS}>docs</DocsLink>).</>}</p>
        </section>
        <section className="card about-card" aria-labelledby="remote-setup-title">
          <div className="about-card__heading"><h2 id="remote-setup-title" className="card-title">Your setup</h2></div>
          <p className="about-card__text"><strong>App port:</strong> {setup.app_port}</p>
          <p className="about-card__text"><strong>UDP video port:</strong> {setup.webrtc_udp_port}</p>
          <div><strong>Public host(s):</strong>
            {!setup.public_host_set ? <p className="about-card__text">Not set. Low latency video from outside the home needs PUBLIC_HOST.</p> :
              <ul>{setup.public_hosts.map((entry) => <li key={entry.host}>{hostSentence(entry)}</li>)}</ul>}
          </div>
          <p className="about-card__text"><strong>Advertised addresses:</strong> {setup.advertised_hosts.join(', ') || 'None'}</p>
          <p className="about-card__text"><strong>STUN:</strong> {setup.stun.enabled ? 'On' : 'Off'}</p>
          {setup.stun.enabled && <p className="about-card__text">A STUN server can see the public IP of anyone who watches live video from outside; you can turn it off (<DocsLink href={STUN_DOCS}>docs</DocsLink>).</p>}
        </section>
        <section className="card about-card" aria-labelledby="remote-test-title">
          <div className="about-card__heading"><h2 id="remote-test-title" className="card-title">Test Low latency video from this device</h2></div>
          {!camera && <p className="about-card__text">No camera is running yet, so there is nothing to test. Add or start a camera first.</p>}
          <button type="button" className="btn btn-primary" disabled={!camera || busy} onClick={runTest}>{busy ? 'Testing…' : 'Test from this device'}</button>
          <p className="about-card__text">This connects your device to your Nightlight server, the same way live video does. With STUN on, your device also contacts the STUN server, exactly as live video does.</p>
          {message && <p className="about-card__text" role="status">{message} {network === 'remote' && (result.outcome === 'failed' || result.outcome === 'timeout') && <DocsLink>Setup guide</DocsLink>}</p>}
        </section>
        <section className="card about-card" aria-labelledby="remote-checklist-title">
          <div className="about-card__heading"><h2 id="remote-checklist-title" className="card-title">Before watching from outside</h2></div>
          <ul>
            <li>The app port (TCP) must be reachable, normally through an HTTPS reverse proxy. <DocsLink>Setup guide</DocsLink></li>
            <li>For Low latency video, forward UDP {setup.webrtc_udp_port} 1:1 to this server and set PUBLIC_HOST to a DNS-only name or your public IP. A Cloudflare-proxied name will not carry UDP video.</li>
            <li>Compatibility (HLS) video needs no UDP forward.</li>
          </ul>
          <p className="about-card__text">Keep the raw app port off the internet; use HTTPS.</p>
        </section>
        </details>
      </>}
    </main>
  </>;
}
