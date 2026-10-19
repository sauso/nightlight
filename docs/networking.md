# Networking, privacy and remote access

Nightlight is intended for local use by default. Live video uses MediaMTX to make RTSP streams available to browsers through WebRTC (low latency) and HLS (compatibility). The Node/Express backend manages camera streams and stores application data locally.

## Local networking

**Host networking** is the default: Nightlight shares the host's address and ports. It is simple but can conflict with other services.

**Dedicated LAN IP** via ipvlan/macvlan lets each container use its own IP. A macvlan container is typically unreachable from its own host without additional configuration; this can affect reverse proxies. Consider ipvlan or a host shim when needed.

For multiple instances, use separate LAN IPs or different HTTP ports. Remote WebRTC also requires distinct advertised UDP ports and matching 1:1 router forwarding.

## STUN and WebRTC

By default the browser and MediaMTX use Google's `stun.l.google.com:19302` for WebRTC address discovery. Google can observe public IP and connection timing metadata; it does **not** carry your video stream as a TURN relay. On a LAN, STUN is not required. Set `STUN_SERVERS` to an empty value to disable it or configure a server you control.

HLS compatibility playback doesn't use STUN. Optional push notification providers involve their own external connections; see [notifications](notifications.md).

## Remote access

Do not expose Nightlight directly to the public internet without understanding authentication, HTTPS and network restrictions. A VPN is often the simplest way to reach your home network securely.

For a reverse proxy such as SWAG, use HTTPS and set `TRUST_PROXY` to the address your proxy connects from, for proxies you control only. The default, `loopback`, trusts only a proxy on the same host, so a proxy that reaches Nightlight by its LAN IP is not trusted until you set it. Details: [`TRUST_PROXY`](remote-access.md#trust_proxy--telling-nightlight-your-real-client-addresses). WebRTC media may require a reachable UDP port even when the website loads correctly through HTTPS. HLS travels over HTTP(S) but generally has higher latency.

To watch low-latency video away from home:

1. Put Nightlight behind HTTPS, for example with a reverse proxy such as SWAG.
2. Set `PUBLIC_HOST` to your public IP or a DDNS name. It must **not** be a Cloudflare-proxied (orange cloud) name, because that proxy carries only HTTP(S), never the UDP video. Use a DNS-only record.
3. Forward UDP port 8189 (or your `WEBRTC_UDP_PORT`: a bare port number from 1 to 65535, blank means 8189) on your router to the server.

Compatibility (HLS) mode needs no extra forwarding. On iPhone and iPad, background audio works in low-latency mode only. More: [remote access](remote-access.md#remote--internet-access-watching-from-outside-your-home-network).

A router that remaps the external WebRTC UDP port to a different internal port can break the advertised connection. Set `PUBLIC_HOST` and `WEBRTC_UDP_PORT` as appropriate for your deployment.

## Data security

Nightlight stores camera credentials and notification tokens in its local database. Protect the data directory and backups. The default permissions are restrictive, but host filesystem behavior varies; see [operations](operations.md).

This guide is an overview, not a security audit. Review [SECURITY.md](../SECURITY.md) before reporting vulnerabilities.

## Networking modes

Nightlight needs its own routable IP on your LAN so WebRTC has no NAT/ICE trouble — MediaMTX advertises
that IP to browsers. There are two supported ways to provide one:

- **Host networking (default, simplest).** The container shares the host's IP (`--network host`, or
  `<Network>host</Network>` in the Unraid template). Nothing to configure — it's what the quick start and
  the template use. The trade-off is that it binds its ports (4000, plus MediaMTX's) directly on the host,
  which clashes if something else there already uses them.
- **A dedicated LAN IP (ipvlan / macvlan).** Put the container on a Docker `ipvlan`/`macvlan` network so it
  gets its **own** address on your LAN, separate from the host. Nightlight auto-detects the container's IP
  and has MediaMTX advertise it, so WebRTC works on the LAN with **no extra configuration** (no `PUBLIC_HOST`
  needed for local viewing). Use this to avoid host-mode port conflicts, or just to keep the app on a tidy
  fixed IP of its own.
  - **On Unraid:** create a custom Docker network on your NIC (e.g. `br0`, or a VLAN like `br0.10`), then in
    the container template set the **Network Type** to that network and give it a fixed IP.
  - **macvlan caveat:** with plain `macvlan`, the **host itself usually can't reach the container** (a Linux
    kernel limitation) — which matters if your reverse proxy (e.g. SWAG) runs on that same host. Use
    **`ipvlan`** (or add a macvlan shim interface) so the host can reach it.

| | Host networking | ipvlan | macvlan |
|---|---|---|---|
| Setup | None — the default | Custom Docker network + fixed IP | Custom Docker network + fixed IP |
| Port collisions with other containers | Possible — shares the host's ports | None — has its own IP | None — has its own IP |
| Host itself can reach the container | Yes (it *is* the host) | Yes | **No** (Linux kernel limitation) — use ipvlan instead if a reverse proxy runs on the host |
| Multiple instances on one host | Awkward — only one can hold port 4000 | Easy — each gets its own IP | Easy — each gets its own IP |

Either way, the app is still served on port **4000** (change it with the `PORT` env var if you need to).
For **remote / internet** access, see [Remote / internet access](remote-access.md#remote--internet-access-watching-from-outside-your-home-network) — that part is the same in both
modes.

### Running more than one instance (e.g. staging + production)

Running two copies on one host is easiest with the **dedicated LAN IP** mode above: give each its own IP
and they can keep the same internal ports without clashing (host networking can't — two host-mode
containers would both try to grab port 4000). Set a different `PORT` on an instance if you'd rather change
its HTTP port instead.

Watching **both remotely in Low latency (WebRTC)** takes one extra step, because each instance's WebRTC
media needs its own UDP port forwarded **1:1** — the port a browser must reach has to match the port
MediaMTX advertises, so a router that *remaps* the port breaks WebRTC:

1. Give each instance a **distinct WebRTC UDP port**: leave one at the default `8189` and set the other
   with the `WEBRTC_UDP_PORT` setting (a bare number between 1 and 65535, **no colon**; blank = `8189`),
   e.g. `WEBRTC_UDP_PORT=8190`. On Unraid it is the **WebRTC UDP Port** field in the container's
   advanced view. An invalid value is ignored with a warning in the log and `8189` is used. (The raw
   MediaMTX override `MTX_WEBRTCLOCALUDPADDRESS` still works for a bind address a bare port cannot
   express and wins if both are set, but you should not need it.)
2. **Forward each 1:1** on your router — external UDP `8189` → instance A's `8189`, external UDP `8190` →
   instance B's `8190` (same number in and out).
3. Set `PUBLIC_HOST` (your public IP or DDNS) on **both**.
4. Put each behind its **own subdomain** in SWAG (e.g. `nursery.example.com`, `nursery-dev.example.com`);
   the HTTP and the WebRTC signalling both ride 443, so the only per-instance forwards are those two UDP
   media ports.

**Compatibility (HLS)** needs none of this — it's all HTTP over 443, so both instances work remotely with
no extra port forwarding.
