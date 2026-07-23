import { useEffect, useState } from 'react';
import { ExternalLink, Heart } from 'lucide-react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from '../components/AppHeader.jsx';

const LINKS = [
  { label: 'GitHub — Nightlight', url: 'https://github.com/sauso/nightlight' },
  { label: 'GitHub — Android app', url: 'https://github.com/sauso/nightlight-android' },
  { label: 'Changelog', url: 'https://github.com/sauso/nightlight/blob/main/CHANGELOG.md' },
  { label: 'Report an issue', url: 'https://github.com/sauso/nightlight/issues' },
];

const DONATE_URL = 'https://www.paypal.com/donate/?hosted_button_id=VGCB7WFYPJQ3G';

export default function About() {
  const { settings } = useSettings();
  const [version, setVersion] = useState(null);

  useEffect(() => {
    api.get('/about').then((info) => setVersion(info.version)).catch(() => setVersion('unknown'));
  }, []);

  return (
    <>
      <AppHeader title="About" />
      <main className="app-main">
        <div className="card about-hero">
          <img src="/icons/icon-192.png" alt="" className="about-hero__icon" />
          <div>
            <div className="about-hero__name">{settings.app_name}</div>
            <div className="camera-tile__sub">
              Version {version ?? '…'}
            </div>
            <div className="camera-tile__sub">
              Self-hosted baby monitor — no cloud, no subscription.
            </div>
          </div>
        </div>

        <div className="section-title">Links</div>
        <div className="card">
          {LINKS.map(({ label, url }) => (
            <a key={url} className="list-row about-link" href={url} target="_blank" rel="noreferrer">
              <span>{label}</span>
              <ExternalLink size={15} aria-hidden="true" />
            </a>
          ))}
        </div>

        <div className="section-title">Support the project</div>
        <div className="card">
          <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
            Nightlight is free and open source. If it helps you keep watch over your
            little ones, consider supporting its development.
          </div>
          <a className="btn btn-primary" href={DONATE_URL} target="_blank" rel="noreferrer">
            <Heart size={16} aria-hidden="true" />
            Donate via PayPal
          </a>
        </div>
      </main>
    </>
  );
}
