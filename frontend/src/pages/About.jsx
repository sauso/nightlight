import { useEffect, useState } from 'react';
import { ExternalLink, Heart } from 'lucide-react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';

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

  useEffect(() => {
    api.get('/about').then(setInfo).catch(() => setInfo({ version: 'unknown' }));
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
          <img src="/icons/icon-192.png" alt="" className="about-hero__icon" />
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
            {/* #553: whether ffmpeg and MediaMTX run as a separate user. Shown only when the server says (an older
                server sends no field). 'off' is not an error: it is the documented fallback on a host that cannot
                do it, or the kill switch (docs/operations.md, "Media isolation"). */}
            {(info?.mediaIsolation === 'on' || info?.mediaIsolation === 'off') && (
              <div className="camera-tile__sub">
                Media isolation: {info.mediaIsolation}
              </div>
            )}
          </div>
        </div>

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
