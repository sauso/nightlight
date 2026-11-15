import { useEffect, useState } from 'react';
import { Heart, Globe, GitBranch, Smartphone, FileText, Bug, Lightbulb, ClipboardList } from 'lucide-react';
import { api } from '../lib/api.js';
import { getConnectionRoute } from '../lib/nativeBridge.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Logo from '../components/Logo.jsx';
import NavRow from '../components/NavRow.jsx';
import useSetupStatus from '../lib/useSetupStatus.js';

// UI consistency (PR-C): each outside link is a NavRow (the shared row, with the external-link mark), so it needs an icon chip.
const LINKS = [
  { Icon: Globe, label: 'Website', url: 'https://nightlightbaby.app/' },
  { Icon: GitBranch, label: 'GitHub — Nightlight', url: 'https://github.com/sauso/nightlight' },
  { Icon: Smartphone, label: 'GitHub — Mobile app', url: 'https://github.com/sauso/nightlight-mobile' },
  { Icon: FileText, label: 'Changelog', url: 'https://github.com/sauso/nightlight/blob/main/CHANGELOG.md' },
  { Icon: Bug, label: 'Report an issue', url: 'https://github.com/sauso/nightlight/issues' },
  // GitHub loads issue forms from the default branch (main); this opens a plain new issue until the next release.
  { Icon: Lightbulb, label: 'Got an idea?', url: 'https://github.com/sauso/nightlight/issues/new?template=feature_request.yml' },
];

// Why the Android app has no Tailscale address saved, keyed by the outcome of its last ask (nativeBridge.js tailscaleOutcome).
// No entry (not asked yet this run, or 'saved') shows no line: the app never guesses a cause. The shell's own refusal is not shown
// word for word; each line is fixed text a person can act on. "Settings -> Remote access" is the admin-only hub row.
const TAILSCALE_WHY = {
  'server-none': "This server isn't offering one. An admin can turn it on in Settings → Remote access.",
  unknown: "The server couldn't say just now. The app asks again each time it starts.",
  unreachable: "The server offered one, but this phone couldn't reach it. Turn Tailscale on in the phone, then restart the app.",
  different: 'That address belongs to a different server, so it was not saved.',
  refused: 'The app did not accept the address the server offered.',
};

const ISOLATION_DOCS_URL ='https://github.com/sauso/nightlight/blob/main/docs/operations.md#media-isolation';

const DONATE_URL ='https://www.paypal.com/donate/?hosted_button_id=VGCB7WFYPJQ3G';

export default function About() {
  const { settings } = useSettings();
  const { user } = useAuth();
  const [info, setInfo] = useState(null);
  const setupStatus = useSetupStatus(user?.role === 'admin');

  useEffect(() => {
    api.get('/about').then(setInfo).catch(() => setInfo({ version: 'unknown' }));
  }, []);

  // A capable phone app only (null elsewhere): which address this session is on, and whether a secure one is saved.
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
            and PUID=0 (`root`) show no banner: the plain "Media isolation: Off" line for those is on Settings -> Logs
            (components/ServerCard.jsx). A server that sends no reason (an older one) shows no banner. The sentence comes from the server's fixed table, never from the environment. */}
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
        {/* Owner 2026-11-07, after two layouts that read badly on a phone (label and value on one line broke the tailnet name
            mid-word; a label over each value looked unlike the rest of the app and the name outranked its card): laid out like
            the Remote access card (TailscaleCard.jsx): a 16px title with a badge, a 14px sub-heading, the address in the same
            bold wrapping style, and a muted line under it saying what that means or, when none is saved, WHY, so "Not saved" is
            not a dead end. The badge is "which address this session is using". The address is on screen, so a screenshot of
            this card shows the person's tailnet name (docs/remote-access.md). The look lives in index.css next to the
            Remote access rules it shares. */}
        {route && (
          <section className="card about-card" aria-label="Connection">
            <div className="about-card__heading">
              <h2 className="card-heading">Connection</h2>
              {route.via !== 'other' && (
                <span className="status-badge status-badge--off">
                  {route.via === 'tailscale' ? (route.kind === 'custom' ? 'Using your custom address' : 'Using Tailscale') : 'Using local address'}
                </span>
              )}
            </div>
            <h3>Your secure address</h3>
            <p className="tailscale-address">{route.tailscaleSaved ? (route.address || 'Saved') : 'Not saved'}</p>
            {/* Owner 2026-11-07: a saved address needs no line ("Saved for use away from home." told nobody anything the
                address itself did not); the line is only for the reason none is saved. */}
            {!route.tailscaleSaved && TAILSCALE_WHY[route.why] && (
              <p className="tailscale-hint">{route.kind === 'custom' && route.why === 'unreachable'
                ? "The server offered one, but this phone couldn't reach it. Check your HTTPS address, then restart the app."
                : TAILSCALE_WHY[route.why]}</p>
            )}
          </section>
        )}

        {/* Owner 2026-11-05: once setup is complete this row is clutter. Only `completed` hides it: a limited setup still needs
            the picture check, and an install upgraded from before the guide uses this link for its diagnostics (docs/installation.md).
            While the status is unknown (loading, or the read failed) the row stays hidden, so a finished install never flashes it.
            The cost: a completed install has no menu path back to the picture check (the /setup address still works). */}
        {user?.role === 'admin' && setupStatus && setupStatus !== 'completed' && <div className="card">
          <NavRow Icon={ClipboardList} label="Setup status and picture check" to="/setup" />
        </div>}

        {/* Owner 2026-11-07: Links, Support and the safety notice take the Connection card's look (a 16px bold title, 14px
            text) so the cards on this page read as one set; before, they kept the small grey title and 16px rows. */}
        <section className="card about-card" aria-label="Links">
          <div className="about-card__heading"><h2 className="card-heading">Links</h2></div>
          {LINKS.map(({ Icon, label, url }) => (
            <NavRow key={url} Icon={Icon} label={label} external={url} />
          ))}
        </section>

        <section className="card about-card" aria-label="Support the project">
          <div className="about-card__heading"><h2 className="card-heading">Support the project</h2></div>
          <p className="about-card__text">
            Nightlight is free and open source. If it helps you keep watch over your
            little ones, consider supporting its development.
          </p>
          <a className="btn btn-primary" href={DONATE_URL} target="_blank" rel="noreferrer">
            <Heart size={16} aria-hidden="true" />
            Donate via PayPal
          </a>
        </section>

        <section className="card about-card" aria-label="Not a safety device">
          <div className="about-card__heading"><h2 className="card-heading">Not a safety device</h2></div>
          <p className="about-card__text">
            Nightlight is a convenience tool — not a medical device, and not certified for
            safety monitoring of any kind. Streams can drop, apps can be stopped by the
            operating system, networks fail. Never use it as a substitute for adult supervision.
          </p>
        </section>
      </main>
    </>
  );
}
