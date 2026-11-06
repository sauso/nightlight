import { useEffect, useState } from 'react';
import { ExternalLink, Heart } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { getConnectionRoute } from '../lib/nativeBridge.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Logo from '../components/Logo.jsx';
import useSetupStatus from '../lib/useSetupStatus.js';

const LINKS = [
  { label: 'GitHub — Nightlight', url: 'https://github.com/sauso/nightlight' },
  { label: 'GitHub — Mobile app', url: 'https://github.com/sauso/nightlight-mobile' },
  { label: 'Changelog', url: 'https://github.com/sauso/nightlight/blob/main/CHANGELOG.md' },
  { label: 'Report an issue', url: 'https://github.com/sauso/nightlight/issues' },
  // GitHub loads issue forms from the default branch (main); this opens a plain new issue until the next release.
  { label: 'Got an idea?', url: 'https://github.com/sauso/nightlight/issues/new?template=feature_request.yml' },
];

const ISOLATION_DOCS_URL = 'https://github.com/sauso/nightlight/blob/main/docs/operations.md#media-isolation';

const DONATE_URL ='https://www.paypal.com/donate/?hosted_button_id=VGCB7WFYPJQ3G';

export default function About() {
  const { settings } = useSettings();
  const { user } = useAuth();
  const [info, setInfo] = useState(null);
  const setupStatus = useSetupStatus(user?.role === 'admin');

  useEffect(() => {
    api.get('/about').then(setInfo).catch(() => setInfo({ version: 'unknown' }));
  }, []);

  // The Android app only (null elsewhere): which address this session is on, and whether the Tailscale one is saved.
  const [route, setRoute] = useState(null);
  useEffect(() => {
    let live = true;
    getConnectionRoute().then((value) => { if (live) setRoute(value); });
    return () => { live = false; };
  }, []);

  const version = info?.version;
  // Build provenance: "<branch> · <short sha> · built <date>" - shown so you can confirm
  // which commit an instance is actually running (staging vs prod, latest dev push, etc.).
  const buildParts = info
    ? [
        info.gitRef,
        info.gitSha ? info.gitSha.slice(0, 7) : null,
        info.buildTime ? `built ${new Date(info.buildTime).toLocaleDateString()}` : null,
      ].filter(Boolean)
    : [];

  return (
    <>
      <AppHeader title="About" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {/* #553: isolation is off although it was asked for: either the host could not give it (`fallback`) or PUID/PGID
            is the media user's id (`id-clash`, which the admin can fix). The camera programs run as the app's own
            user. Loud, but admins only (a caregiver cannot fix a container). The operator's own switch (`disabled`)
            and PUID=0 (`root`) keep the quiet line below. A server that sends no reason (an older one) shows no
            banner. The sentence comes from the server's fixed table, never from the environment. */}
        {user?.role === 'admin' && info?.mediaIsolation === 'off'
          && (info?.mediaIsolationReason === 'fallback' || info?.mediaIsolationReason === 'id-clash') && (
          <div className="form-warning" role="status">
            <strong>Media isolation could not start.</strong> The camera programs (FFmpeg and MediaMTX) are running
            without the extra protection, as the same user as the app.
            {info.mediaIsolationDetail && <> {info.mediaIsolationDetail}</>}{' '}
            <a href={ISOLATION_DOCS_URL} target="_blank" rel="noreferrer">What this means and how to fix it</a>
          </div>
        )}
        <div className="card about-hero">
          <Logo size={64} glow className="about-hero__icon" />
          <div>
            <div className="about-hero__name">{settings.app_name}</div>
            <div className="camera-tile__sub">
              Version {version ?? '…'}
            </div>
            {buildParts.length > 0 && (
              <div className="camera-tile__sub" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {buildParts.join(' · ')}
              </div>
            )}
            <div className="camera-tile__sub">
              Self-hosted baby monitor — no cloud, no subscription.
            </div>
            {/* Owner 2026-11-06: the header kept growing (media isolation, then the Android connection lines) and was crowded.
                It is now only who and what this is. The connection lines are the card below; the "Media isolation: on/off"
                line is on Settings -> Logs for admins (components/ServerCard.jsx): it means nothing to a caregiver. */}
          </div>
        </div>

        {/* The Android app, owner 2026-11-06: which address this session is using, and whether the Tailscale address is saved
            for use away from home (docs/remote-access.md). Not shown in a browser or on an app without the feature (`route`
            is null there). An address that is neither of the server's two names nothing, only whether one is saved. */}
        {route && (
          <div className="card">
            <div className="card-title">Connection</div>
            {route.via !== 'other' && (
              <div className="list-row">
                <span>Connected through</span>
                <span className="camera-tile__sub">{route.via === 'tailscale' ? 'Tailscale address' : 'Saved address'}</span>
              </div>
            )}
            <div className="list-row">
              <span>Tailscale address</span>
              <span className="camera-tile__sub">{route.tailscaleSaved ? 'Saved for use away from home' : 'Not saved'}</span>
            </div>
          </div>
        )}

        {/* Owner 2026-11-05: once setup is complete this row is clutter. Only `completed` hides it: a limited setup still needs
            the picture check, and an install upgraded from before the guide uses this link for its diagnostics (docs/installation.md).
            While the status is unknown (loading, or the read failed) the row stays hidden, so a finished install never flashes it.
            The cost: a completed install has no menu path back to the picture check (the /setup address still works). */}
        {user?.role === 'admin' && setupStatus && setupStatus !== 'completed' && <div className="card">
          <Link className="list-row about-link" to="/setup">Setup status and picture check</Link>
        </div>}

        <div className="card">
          <div className="card-title">Links</div>
          {LINKS.map(({ label, url }) => (
            <a key={url} className="list-row about-link" href={url} target="_blank" rel="noreferrer">
              <span>{label}</span>
              <ExternalLink size={15} aria-hidden="true" />
            </a>
          ))}
        </div>

        <div className="card">
          <div className="card-title">Support the project</div>
          <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
            Nightlight is free and open source. If it helps you keep watch over your
            little ones, consider supporting its development.
          </div>
          <a className="btn btn-primary" href={DONATE_URL} target="_blank" rel="noreferrer">
            <Heart size={16} aria-hidden="true" />
            Donate via PayPal
          </a>
        </div>

        <div className="card">
          <div className="camera-tile__sub">
            <strong>Not a safety device.</strong> Nightlight is a convenience tool — not a
            medical device, and not certified for safety monitoring of any kind. Streams
            can drop, apps can be stopped by the operating system, networks fail. Never
            use it as a substitute for adult supervision.
          </div>
        </div>
      </main>
    </>
  );
}
