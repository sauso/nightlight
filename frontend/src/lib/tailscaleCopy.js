export const blockerCopy = {
  host_network: "Nightlight can't use Tailscale while it shares your server's network. Give the container its own address (bridge, ipvlan or macvlan), then come back.",
  no_admin: "Create your admin account first. Tailscale can't be turned on until one exists.",
  not_installed: "This version of Nightlight doesn't include Tailscale. Update to the latest version to use it.",
};

export function blockerMessage(code) {
  return blockerCopy[code] || "Tailscale can't be turned on right now.";
}

export function errorMessage(code, action) {
  if (code === 'busy') return 'Tailscale is finishing another step. Try again in a moment.';
  if (code === 'consent_required') return 'Tailscale needs you to approve HTTPS for your account first.';
  if (code === 'video_address_not_applied') return "Couldn't update the video address. Try again.";
  if (code === 'daemon_not_ready' || code === 'timeout') return 'Tailscale stopped. Watching at home still works.';
  if (action === 'sign-in') return 'Sign-in expired. Sign in again.';
  if (action === 'serve-enable') return "Couldn't turn on the secure address.";
  return "Couldn't save that. Try again.";
}

export function videoTestMessage(result, onTailnetOrigin) {
  if (!result) return null;
  if (result.outcome === 'connected') return onTailnetOrigin
    ? 'Low latency video works through Tailscale.'
    : "This page isn't open through Tailscale, so this doesn't prove it works away from home. Open your secure address from your phone over Tailscale to check.";
  if (result.outcome === 'unsupported') return "This browser can't make a Low latency connection.";
  return "Couldn't connect. Tailscale is on, so check that this device is connected to Tailscale. Standard (HLS) video still works.";
}
