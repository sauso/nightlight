const DNS_ERRORS = { not_found: 'name not found', timeout: 'lookup timed out', failed: 'lookup failed' };

export function hostSentence(entry) {
  if (entry.error) return `${entry.host}: ${DNS_ERRORS[entry.error] || 'lookup failed'}.`;
  if (!entry.addresses.length) return `No addresses returned for ${entry.host}.`;
  return entry.kind === 'ip'
    ? `${entry.host} is an IP address, advertised as ${entry.addresses.join(', ')}.`
    : `${entry.host} resolves to ${entry.addresses.join(', ')}.`;
}

export function buildChecklist({ setup, network, via, result, protocol, canTest = true }) {
  if (!setup) return [];
  const hosts = setup.public_hosts || [];
  // The server looks up at most 10 hosts but `public_host_count` is how many are configured (an older server omits it).
  // An unchecked host beyond the cap must never read as fine (Codex review of #1025, verified with 11 hosts).
  const total = setup.public_host_count ?? hosts.length;
  const capped = total > hosts.length;
  const resolved = !capped && hosts.length > 0 && hosts.every((entry) => entry.error === null && entry.addresses?.length > 0);
  const error = hosts.find((entry) => entry.error);
  const cloudflare = hosts.find((entry) => entry.behind_cloudflare === true);
  const cloudflareKnown = resolved && hosts.every((entry) => entry.behind_cloudflare === false);
  const remoteResult = network === 'remote' && result && ['connected', 'failed', 'timeout'].includes(result.outcome);
  const udp = remoteResult && result.outcome === 'connected' && result.protocol?.toLowerCase() === 'udp';
  // Connected but the selected candidate's transport is unknown: not a failure, not proof either.
  const udpUnknown = remoteResult && result.outcome === 'connected' && !result.protocol;
  return [
    {
      id: 'https',
      status: protocol === 'https:' ? 'ok' : protocol === 'http:' && network === 'remote' ? 'check' : 'unchecked',
      text: protocol === 'https:' ? 'You opened this page over HTTPS.'
        : protocol === 'http:' && network === 'remote' ? "You're outside your home on plain http. Use HTTPS."
          : 'This page is on plain http, which is fine at home. Open Nightlight from your own domain to check HTTPS.',
    },
    {
      id: 'public_host',
      status: !setup.public_host_set || error ? 'check' : resolved ? 'ok' : 'unchecked',
      text: !setup.public_host_set ? "PUBLIC_HOST isn't set. Low latency video from outside needs it; Compatibility video doesn't."
        : error ? hostSentence(error)
          : resolved ? `${hosts.map((entry) => entry.host).join(', ')} ${hosts.length === 1 ? 'resolves' : 'resolve'}.`
            : capped ? `Only the first ${hosts.length} of your ${total} video hostnames are looked up here.`
              : 'The video hostname could not be checked. Check PUBLIC_HOST and its DNS answers.',
    },
    {
      id: 'cloudflare',
      status: !setup.public_host_set ? 'unchecked' : cloudflare ? 'check' : cloudflareKnown ? 'ok' : 'unchecked',
      text: !setup.public_host_set ? 'Set PUBLIC_HOST first.'
        : cloudflare ? `${cloudflare.host} resolves to a Cloudflare proxy address. Its proxy carries web traffic, never UDP video: make that DNS record DNS-only (grey cloud).`
          : cloudflareKnown ? 'None of your video hostnames resolve to a Cloudflare proxy address. A cached or split-horizon DNS answer can mislead this check.'
            : 'The Cloudflare proxy check needs DNS answers and a server that reports this result.',
    },
    {
      id: 'udp',
      // "Outside your home" is Nightlight's reading of this device's address, which depends on TRUST_PROXY: a forged
      // forwarded address under a loose setting can read as remote (verified by Codex on #1025), so the OK says so.
      status: !remoteResult ? 'unchecked' : udpUnknown ? 'unchecked' : udp ? 'ok' : 'check',
      text: !remoteResult ? `${canTest ? '' : 'Start a camera, then '}${canTest ? 'Run' : 'run'} the test below from mobile data (outside your home).`
        : udpUnknown ? "The test connected, but Nightlight couldn't tell whether it used UDP. Run it again."
          : udp ? 'The test connected over UDP from an address Nightlight counts as outside your home, which is what a working forward looks like.'
            : "The test didn't connect over UDP from outside. The UDP forward is one possible cause; a camera, DNS or STUN problem are others.",
    },
    {
      id: 'proxy',
      status: via === 'proxy' ? 'check' : 'unchecked',
      text: via === 'proxy' ? "A forwarded address arrived that TRUST_PROXY doesn't trust. A stray header from a direct client looks the same."
        : 'No untrusted forwarded address was seen on this visit.',
    },
  ];
}
