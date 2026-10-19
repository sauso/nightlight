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

For a reverse proxy such as SWAG, use HTTPS and set `TRUST_PROXY` to the address your proxy connects from, for proxies you control only. The default, `loopback`, trusts only a proxy on the same host, so a proxy that reaches Nightlight by its LAN IP is not trusted until you set it. Details: [`TRUST_PROXY`](readme-reference.md#trust_proxy--telling-nightlight-your-real-client-addresses). WebRTC media may require a reachable UDP port even when the website loads correctly through HTTPS. HLS travels over HTTP(S) but generally has higher latency.

A router that remaps the external WebRTC UDP port to a different internal port can break the advertised connection. Set `PUBLIC_HOST` and `WEBRTC_UDP_PORT` as appropriate for your deployment.

## Data security

Nightlight stores camera credentials and notification tokens in its local database. Protect the data directory and backups. The default permissions are restrictive, but host filesystem behavior varies; see [operations](operations.md).

This guide is an overview, not a security audit. Review [SECURITY.md](../SECURITY.md) before reporting vulnerabilities.
