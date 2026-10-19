# How it works

> This page was moved, word for word, from the old README. The wording has not been edited yet; only cross-references changed.

- **FFmpeg** pulls each camera's RTSP stream, copies the video through untouched, and
  transcodes just the audio to AAC (many IP cameras send audio as G711, a codec HLS can't
  carry at all — WebRTC can, which is why this only matters for Compatibility/HLS mode).
  The result is published into MediaMTX.
- **MediaMTX** re-publishes that as WebRTC (WHEP) and HLS, which browsers can play
  natively — RTSP itself cannot be played in a browser, so this bridge is required either way.
- **Backend** (Node/Express + SQLite) stores children, cameras, and caregiver accounts,
  and manages both MediaMTX and one FFmpeg process per camera as child processes —
  starting them, restarting on crash, and stopping them when a camera's removed.
- **Frontend** (React) is a mobile-first, installable app: a live dashboard grouped by
  child, plus screens to manage children, cameras, and caregiver accounts. Cameras can be
  added by IP over **ONVIF** (auto-filling the stream details), and PTZ (pan/tilt) cameras
  get on-screen controls — see [Managing cameras](cameras.md#managing-cameras).

Everything above runs in a **single Docker container**, which needs its own routable IP on your LAN so
WebRTC connects without NAT/ICE headaches (MediaMTX advertises that IP to browsers). The simple default
is **host networking** — the container shares the host's IP — used by the quick start and the Unraid
template. If host mode doesn't suit you (e.g. a port clash with another service), you can instead give
the container its **own dedicated LAN IP**; see [Networking modes](networking.md#networking-modes).

This is designed for **local network use by default** — see [Remote / internet access](remote-access.md#remote--internet-access-watching-from-outside-your-home-network)
if you want it reachable from outside your home too.
