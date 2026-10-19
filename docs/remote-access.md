# Reverse proxy and remote access

> This page was moved, word for word, from the old README. The wording has not been edited yet; the only changes are three cross-references to sections that were not moved with it.

## Running behind a reverse proxy (e.g. SWAG on Unraid)

A ready-to-use config is in `reverse-proxy/nightlight.subdomain.conf`. Copy it to
`swag/config/nginx/proxy-confs/nightlight.subdomain.conf` and replace `UNRAID_LAN_IP`
with the container's LAN IP — the **host's IP** in host mode, or the container's **own
dedicated IP** if you gave it one (see [Networking modes](networking.md#networking-modes)). Either way SWAG
reaches it by that IP, not by container name.

> **macvlan note:** if you put Nightlight on its own IP with plain `macvlan`, SWAG running on the
> *same host* won't be able to reach it (the host↔macvlan-container limitation noted in [Networking modes](networking.md#networking-modes)) — use
> `ipvlan`, or run SWAG on a different host.

Everything is proxied through a single port (4000): the app, login, all pages, and the
video signaling handshake — no extra ports to open on your router for this part.

### `TRUST_PROXY` — telling Nightlight your real client addresses

| Variable | Default | What it does |
|---|---|---|
| `TRUST_PROXY` | `loopback` | Which upstream addresses may set `X-Forwarded-For`. Accepts an IP or CIDR (`10.0.0.20`, `172.18.0.0/16`), a comma-separated list, a hop count (`1`), or a named range. |

Behind a proxy, every request arrives from the **proxy's** address unless you tell Nightlight to trust
it. The default (`loopback`) only trusts a proxy on `127.0.0.1` — and SWAG reaches Nightlight by its
LAN IP, so with the setup above **it is not trusted and every remote visitor looks like one client**.

Set it to the address your proxy connects *from*:

```bash
-e TRUST_PROXY=10.0.0.20        # SWAG's own LAN IP
```

> **⚠️ Only set this to an address you control.** Whatever you trust here is allowed to declare a
> client's IP. Too broad a value — or `true`, which trusts *every* upstream — lets anyone forge
> `X-Forwarded-For` and slip the login rate limit entirely, which is worse than leaving it unset. If
> you are not sure, leave it alone.

**IPv6 ranges and IPv4 clients (changed with the `proxy-addr` 2.0.8 update).** An IPv6 range is now
compared with IPv4 peers only if it is an IPv4-mapped range of /96 or longer, such as `::ffff:a00:0/104`,
and that behaves exactly like the IPv4 range it maps (`10.0.0.0/8`). Any other IPv6 range, such as `::/1`,
no longer matches IPv4 peers, and a range written in mapped form but shorter than /96, such as
`::ffff:0:0/80`, now matches no peer at all. IPv4 addresses and ranges, the named ranges, hop counts and
`true`/`false` behave as before. If you relied on an IPv6 range to cover IPv4 peers, list the IPv4 address
or range instead.

A value Nightlight can't make sense of is **ignored, with a warning in the log**, and the safe default
is used instead — a typo here will never stop the app starting.

**You do not have to set it.** Login attempts are limited per account *and* per source, so even with
every remote user sharing the proxy's address, one person mistyping their password cannot lock anyone
else out. Setting `TRUST_PROXY` makes the per-source half meaningful as well.

### `STUN_SERVERS` — which STUN servers Low latency (WebRTC) uses

| Variable | Default | What it does |
|---|---|---|
| `STUN_SERVERS` | `stun:stun.l.google.com:19302` (Google's public server) | Comma-separated list of `stun:host` or `stun:host:port` URLs, used by the browser **and** by the bundled MediaMTX, and the only STUN hosts the browser is allowed to contact. |

| You set | Result |
|---|---|
| nothing (variable unset) | Google's public STUN server, as in earlier versions |
| blank (`STUN_SERVERS=`, or the field cleared on Unraid) | **No STUN server.** Nothing contacts Google or anyone else |
| `stun:stun.example.org:3478` or a comma-separated list | exactly those servers (port defaults to 3478) |
| anything that is not a `stun:` URL (`turn:`, `stuns:`, a typo) | that entry is ignored, with **one** warning in the log; if no entry is valid, STUN is **off** (never silently back to Google) |

STUN is only how a WebRTC peer learns its public address. **Watching on your home network never needs it.** A viewer
outside your network who is behind NAT may fail to connect without it (Compatibility (HLS) mode still works). With the
default, Google sees the viewer's public IP address and when each live view connected. `turn:` relay servers are not
supported. Change takes effect on restart. The log shows `[stun] ...` at start-up.

The browser starts reading this list when you sign in, before the first camera tile connects (#739).
On a very slow link, if the first tile appears before that answer arrives (for example, from a direct link),
its 1-second lookup budget can still expire. That connection then uses host candidates only, with no STUN;
later attempts use the list once it arrives. It never substitutes Google's server for a missing answer.

On Unraid it is the **STUN Servers** field: it ships with the Google URL, so clear the field to turn STUN off.

### `CLOUDFLARE_ANALYTICS` — Cloudflare Web Analytics through Cloudflare's proxy

| Variable | Default | What it does |
|---|---|---|
| `CLOUDFLARE_ANALYTICS` | blank (off) | Allows Cloudflare's Web Analytics beacon in Nightlight's Content-Security-Policy. `1`, `true`, `yes` or `on` (any case, spaces ignored) turn it on; blank, `0`, `false`, `no` or `off` keep it off. Any other value also keeps it off and logs one warning at start. |

**If you do not use Cloudflare Web Analytics, leave it blank: nothing changes.**

It matters only if you serve Nightlight through Cloudflare's proxy **and** have Cloudflare Web Analytics
turned on for that site. Cloudflare then injects its beacon script into every page, and Nightlight's
security policy **blocks it unless this is on**. You can tell it is being blocked: the browser console
shows a Content-Security-Policy violation, and the container log shows `[csp-report]` lines (at most 10
a minute). Two ways to stop that: set `CLOUDFLARE_ANALYTICS=1` to allow the beacon, or, if you do not
want the analytics, turn off Web Analytics' automatic setup (the beacon injection) for that site in the
Cloudflare dashboard.

> **Upgrading from a version before this setting existed:** the beacon used to be allowed on every
> install. If you rely on Cloudflare Web Analytics, set the variable, or your analytics stop. A container
> made from the Unraid template before this change does not gain the new field by itself: add it as a
> variable ("Add another Path, Port, Variable, Label or Device") with the key `CLOUDFLARE_ANALYTICS`.

With it off (the default), the page can only run scripts from your own server. The rest of the policy
is the same either way; see "CSP is enforced" in [docs/architecture.md](architecture.md#csp-is-enforced--keep-it-that-way).

## Remote / internet access (watching from outside your home network)

By default this is LAN-only. There are two ways to watch remotely, and each camera tile
has a toggle to switch between them ("Low latency" / "Compatibility"):

**Low latency (WebRTC)** — near-instant video, same as at home. This requires:
1. Set up SWAG as described above (HTTPS for the app itself).
2. Set `PUBLIC_HOST` to your public IP or a DDNS hostname. ⚠️ It must **not** be a
   Cloudflare-proxied (orange cloud) name: Cloudflare's proxy carries only HTTP(S), never the UDP
   media, so remote Low latency would never connect while the page itself loads fine. Use a
   separate DNS-only (grey cloud) record, e.g. `rtc.example.com`, for `PUBLIC_HOST` and keep the
   proxied name for the web page.
3. Forward **UDP port 8189** (or your `WEBRTC_UDP_PORT`, see "Running more than one instance" in [Networking modes](networking.md#running-more-than-one-instance-eg-staging--production)) on your router to your server's
   LAN IP.

This is a hard requirement of WebRTC, not a workaround — the actual audio/video always
travels over UDP between your browser and MediaMTX, no matter what. A TURN relay server
doesn't change this (it only changes how the *signaling* connects, not the media itself),
so there's no way to get the low-latency mode down to zero UDP ports. This single UDP
port forward is all you need, unless you're behind CGNAT.

**Compatibility (HLS)** — a few seconds of delay, but pure HTTP/TCP, so it rides through
the same port 443 as everything else with **no extra port forwarding at all**. Use this if
you'd rather not forward a UDP port, or if you're ever watching from a network that blocks
outbound UDP (some corporate/public Wi-Fi).

> **iOS background audio:** On iPhone/iPad, background listening (screen off / app minimised) works
> in **Low latency** mode only — its WebRTC audio lets Nightlight fully own the lock screen (camera
> name, artwork, Pause/Play). **Compatibility** is HLS, which iOS runs its own native lock-screen
> session for that we can't reliably control, so Background isn't offered for a Compatibility camera
> on iOS (it was tried and removed for being inconsistent — see [KNOWN-ISSUES.md](../KNOWN-ISSUES.md)).
> Compatibility still works for live viewing. Android is unaffected — its background-listening
> service keeps both modes alive.

Both modes work automatically once SWAG + `PUBLIC_HOST` are set up — Compatibility mode
needs nothing further, since it's already proxied through the app's normal port.
