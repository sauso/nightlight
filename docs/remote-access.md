# Watch from anywhere

## Watch from anywhere with Tailscale

Tailscale lets you open Nightlight away from home without changing your router or making Nightlight public. Every person who watches away from home needs the Tailscale app and access to your Tailscale network. They still sign in with their own Nightlight account. Watching at home continues to work as before.

1. Give the Nightlight container its own network address using bridge, ipvlan or macvlan. Tailscale cannot run when it shares the server's network; see [Networking modes](networking.md#networking-modes).
2. Sign in to Nightlight as an admin and open **Settings → Remote Access**, or use the optional **Watch from anywhere** setup step. Select **Turn on Tailscale**.
3. Choose a neutral device name, then select **Sign in with Tailscale**. Open the link or scan the code and approve the device. The sign-in link appears after you start sign-in.
4. Select **Turn on the secure address**. If Tailscale asks for one-time HTTPS approval for your account, open the approval link, approve it and select **Try again**. On a tailnet with HTTPS already enabled, no approval is needed.
5. Install Tailscale on each viewer's phone or computer. Invite them to your tailnet or share this device from the Tailscale admin console. They open the secure address shown in Nightlight and sign in with their Nightlight account. Add caregiver accounts in **Settings → Caregivers**.

The card has **Test video** once a camera is running. Run it from the secure `.ts.net` page on a device connected to Tailscale. A successful test from your home-network address cannot prove remote viewing; test on a phone away from home. Low latency video needs the container's UDP listener to accept the tailnet address. The hosted demo's custom `MTX_WEBRTCLOCALUDPADDRESS` binding prevents that. Tailscale viewers may show as **Unknown** in the own-domain network card; that is expected. Renaming the device changes its address immediately and Nightlight turns HTTPS Serve on again for the new name. While the card is open it checks again about every 30 seconds. If the Tailscale software on the server cannot reach Tailscale for two checks in a row, the card says **Tailscale isn't connected right now** instead of **Connected**. That is usually a network problem that fixes itself; it also happens if you remove the device from your Tailscale account, and the card cannot tell those apart. If it does not come back, open **Advanced**, use **Reset this device's Tailscale identity**, then sign in again (the device gets a new address). People on your home network can still use Nightlight meanwhile.

Alert links keep pointing at your home address. Nightlight learns that address from an admin's phone app, and it never uses a Tailscale address for this (a `.ts.net` name, an address starting 100.64 to 100.127, or one in Tailscale's IPv6 range), so an admin phone that is away from home does not change where everyone's alert links go. If the only admin phone ever uses the Tailscale address, alert links open the app in place without naming the server, which is how they behave when no address is known.

### The phone apps and the Tailscale address

With Tailscale connected and **Secure address** on, the Android app and the iPhone app learn the secure address by themselves: each time someone signs in or starts the app, it asks the server for it and keeps it beside the address that person set the app up with. The first time it learns the address from a plain `http` page, and again if the address changes, the app asks **Use this secure address?** and shows the full name. Accept it only if you have just turned the secure address on here and the name matches. If you choose **Don't use it**, nothing changes and the app does not ask about that address again for a week. It asks at most once every 10 minutes. A caregiver's phone does this too. Turn Tailscale or the secure address off and the app drops the saved address the next time it starts and can reach the server. **Change server** keeps the saved address, so away from home you can open **Settings → Change server**, tap your saved server on the setup screen and the app reconnects through the Tailscale address (your home address cannot answer on mobile data). The **✕** on a saved server forgets the address too. If a different server later answers at your home address, the old Tailscale address is dropped the next time you connect to that home address from the setup screen.

To see what the app is doing, open **Settings → About** in the app and look at the **Connection** card, which is laid out like this screen: the badge beside its title (**Using local address** or **Using Tailscale**) says which address this session is on ("local address" means the address you set the app up with, which is normally your home network address; if you set it up with a public domain, that is the one it means), and **Your secure address** shows the address that is saved for use away from home (for example `name.tailnet.ts.net`; a screenshot of this page shows your tailnet name). When none is saved, a line under it says why, from the app's last check in this session: the server isn't offering one (turn it on in **Settings → Remote Access**), the server couldn't say just now (the app asks again each time it starts), the server offered one but the phone couldn't reach it (the address only answers while Tailscale is on in the phone itself, so turn it on and restart the app), or the address belongs to a different server. There is no line before that check has run. The wording of the "couldn't reach" and "different server" reasons depends on the app's own messages; an app that words them differently shows a general "did not accept" line instead.

On start, the app opens the secure Tailscale address first when it has one, and the address it was set up with if that does not answer. With no secure address saved, nothing changes. This matters on a phone hotspot with Tailscale on: the plain `http` home address can answer there, but two-way talk only works over the secure address. At home with Tailscale off, opening takes at most about a quarter of a second longer (about a second with another VPN on). If Tailscale is slow to answer when the app starts, the app opens the home address and moves to the secure one the next time you open it. While you use the app, it only changes address when the page on screen stops answering, or when the network changes (below). Away from home the app needs the Tailscale app on the phone, signed in to the same Tailscale network as the server; without it the app shows its "Can't reach your server" screen.

**One sign-in for both addresses.** The two addresses are different web addresses, so each used to ask for its own sign-in. The Android app now keeps your sign-in for you, encrypted in the app's own private storage with a key that never leaves the phone's secure keystore (hardware-backed on phones that have it), and hands it to the Tailscale address only. Sign in once on your home address, and the first time you open the app away from home it is already signed in. Signing out (or a sign-in the server refuses, because it expired or you ended it from another device) removes the saved copy. The app's saved copy is not included in Android's cloud backup or in a phone-to-phone transfer. Android's backup and phone-to-phone transfer also leave out the app's web storage, where the web app's own sign-in lives, so a restored phone asks you to sign in again. **The iPhone app does this too,** with the sign-in kept in the iPhone's Keychain instead (marked "this device only": it is not synced through iCloud Keychain and does not move to another phone in a backup or a transfer). The app also clears its saved sign-in on the first start of a new install, because iOS keeps Keychain items when an app is deleted. The Keychain part of the iPhone app, and that clean-up, had been tried only in automated tests and not yet on a phone when this was written. The saved copy is only handed to a page that is the Tailscale address saved for this server, and only while that server still answers as the same one (on both phones). A sign-in is saved for that address only if your own server has just offered the same address; if the phone could not ask the server (no network, an older server), the copy is saved without it and is not handed out until a later sign-in or start where the server answered; **Change server** or forgetting the server removes it. Changing the saved address or the Tailscale address, or the server no longer offering it, makes the saved copy unusable (turning the secure address off also deletes it).

Known limits (2026-11):
- Signing in on the Tailscale address first, then opening your home address, asks for one sign-in there: the saved sign-in is never given to the home address, which is usually plain `http`.
- Two separate sign-ins, one on each address, stay separate. Signing out on one does not end the other's own session. With one shared sign-in (the usual case) signing out ends it everywhere, because the server ends that session.
- Signing out while the phone cannot reach the server clears the phone, but the server only ends the session when it expires, as it always has.
- A person who has an account on your server and also controls a device at your home address on another network could store their own sign-in in the app, and the app would later use it on the Tailscale address. Only accounts on your server can do this, which is why the saved sign-in is never given to a plain `http` page.
- **Changing network.** The Android app and the iPhone app move to the other address by themselves, within a few seconds, when Wi-Fi turns to mobile data. Coming home, they do not switch back while you are using the app (the Tailscale address keeps working on Wi-Fi); they move back the next time you open the app or turn the screen on, and not while a video is already floating in Picture-in-Picture. Each move reloads the app onto its home screen, so a video you were watching starts again, and the screen can pause for up to about 3 seconds while the app picks the address. They do this at most 3 times in 5 minutes, and only while the app is on screen: audio playing with the screen off is not rescued until you open the app. On the iPhone, the app does not move back home while it is inactive (Control Center, a call banner), and a video that starts floating in the last instant before a reload is not caught. An older server, or an app without these features, is simply left as it was.

## Tailscale details and limits

### How the bundled service works

Tailscale 1.104.5 is bundled in the image. It runs in userspace mode, without a TUN device. The admin UI can start sign-in, set a machine name, configure HTTPS Serve, log out and reset a node identity. HTTPS Serve answered 200 with a valid certificate on a tailnet that already had HTTPS enabled (measured 2026-11-04). Nightlight adds the vetted 100.x address to MediaMTX's WebRTC host list. Low latency viewing over the tailnet worked from a phone on cellular with the router's UDP forward closed, on one staging install and one phone: the MediaMTX log showed the remote candidate as `127.0.0.1`, which is how tailnet forwarding presents (measured 2026-11-04). Long sessions, relayed-only (DERP) paths and other devices are not yet tested. It refuses host networking, an unverified network, a missing daemon, or an installation without an admin. The usual host-network Docker setup therefore cannot use this route; give the container its own address through bridge, ipvlan or macvlan first. Check the container's network mode in Docker or your container manager before trying it.

After Tailscale sign-in, Nightlight checks the address every 15 seconds and adds it to the WebRTC candidate list. The first addition briefly disconnects Low latency viewers; cameras and recordings continue. Later address changes wait until no Low latency viewer is connected, or an admin can choose **Apply now** to disconnect those viewers immediately. Failed changes retry after 30 seconds, then double the wait up to 10 minutes. The poll and retry intervals are fixed, not settings. The tailnet candidate uses the same WebRTC UDP port as the LAN candidate and needs no router forward. If `MTX_WEBRTCLOCALUDPADDRESS` binds UDP to a specific host instead of all interfaces (as the hosted demo does), nothing listens on `127.0.0.1` and the tailnet candidate cannot work there.

The Tailscale enable setting defaults to **off** and accepts only on or off. The machine name defaults to **nightlight** and accepts one lowercase DNS label, 1–63 characters, beginning with a letter and ending with a letter or digit; digits and hyphens are allowed between. Choose a neutral name: once HTTPS is enabled, the certificate name appears in public Certificate Transparency logs. The status and sign-in links are shown only to a Nightlight admin. Tailscale access does not replace a Nightlight account.

HTTPS Serve is limited to port 443 forwarding to Nightlight at `127.0.0.1:4000`. If Tailscale asks the tailnet admin to approve HTTPS, follow the admin link and retry; a tailnet that already had HTTPS enabled needed no approval link (measured 2026-11-04). Renaming the node changed its address immediately but left Serve under the old name, so enable HTTPS again after a rename. Only Nightlight's own Serve setting is offered; Funnel is not used. Keep the app port at 4000 for this feature. The daemon automatically opens separate IPv4 and IPv6 wildcard UDP sockets on random ports. Logged out, it opens only UDP; connected, it also opens one TCP listener on a random wildcard port that accepted no outside connection: a LAN connect scan of ports 1024-65535 found only port 4000 open (measured 2026-11-04). No router port forward is needed for Tailscale: if a direct path is unavailable, Tailscale's DERP relays can carry the connection (a phone through a relay played live video in a test on 2026-11-03; not yet re-tested with this image). Bundling Tailscale makes the image about 78 MB larger on disk on amd64 (about 73 MB on arm64) and about 41 MB (38 MB on arm64) larger to download.

The network check looks at interfaces and TCP listeners when the daemon starts and on each API read or action. A TCP listener on `127.0.0.1` or a wildcard address counts as evidence of a shared network, except the daemon's own socket, identified by its socket inode; Docker's own DNS listener on `127.0.0.11` does not count. Every other qualifying TCP listener still counts. If the daemon's fd directory cannot be read, none is exempted. A passed-through physical network card may be refused. A nested Docker host without a bridge in its namespace may go undetected, and a listener opened after the check is reported on a later API call and blocks further Tailscale actions, but it does not stop a tunnel that is already running (turn Tailscale off to stop it). UDP-only services on `127.0.0.1` in a shared namespace are not detected, even though userspace tailscaled can relay UDP to them. There is no override in this version.

If you copy Nightlight's data folder to a second installation, you also copy its Tailscale identity. Turn Tailscale off in the copy, then use **Reset this device's Tailscale identity** under **Advanced** before rejoining. Reset stops its daemon and removes only `private/tailscale`; the rest of `private/` stays in place. Keep the original and copy from running as the same node at once. Treat backups of the Tailscale state as secrets.

While a sign-in is waiting for you to approve it in your browser, the other Tailscale actions answer "busy" (one action runs at a time); turning Tailscale off or choosing log out cancels the wait. Measured 2026-11-04 against the real daemon.

The project maintainers watch Tailscale security bulletins. Updating the bundled version and its two SHA-256 pins requires a reviewed PR; the weekly image rebuild does not update the pinned version.

## Your own domain or port forward

If you prefer to use your own domain, set up a reverse proxy with HTTPS (a VPN into your home network is another option; see [networking](networking.md#watching-away-from-home)). Choose Low latency for near-instant video or Compatibility when you cannot forward UDP.

### Check your setup in Nightlight

Admins can open **Settings → Remote Access** and expand **Use your own domain or port forward (advanced)**. The first card there shows how Nightlight sees this device: home network, VPN, outside home, or unknown. **Your setup** lists the app and UDP video ports, public hosts and their DNS results, advertised addresses, and whether STUN is on. The checklist links back to this guide.

**Test from this device** makes one short Low latency video connection to a running camera, then closes its connection. When the server gives a session address, the test also asks it to end the session (DELETE); otherwise MediaMTX frees it when the connection closes. A successful UDP connection **from outside your home** shows that the port forward works for this device. A TCP connection means video connected, but it does not confirm the UDP forward. A failed or timed-out test points you to the UDP forward and `PUBLIC_HOST`; Compatibility (HLS) remains available without UDP. The test only proves the forward from **outside** your home. A connection from your home network, a VPN, or behind an untrusted proxy cannot prove it, even if the test connects. Try again from mobile data.

If the network shows **Unknown**, Nightlight cannot reliably identify this device's network. A LAN reverse proxy may need its own address in `TRUST_PROXY`, as described [below](#trust_proxy--telling-nightlight-your-real-client-addresses). When a tunnel daemon is attached, a tailnet peer may also show Unknown; changing `TRUST_PROXY` will not identify that peer. The page makes no third-party reachability check. The test uses the same connection as live video, including your configured STUN server if enabled.

## Remote / internet access (watching from outside your home network)

By default this is LAN-only. There are two ways to watch remotely, and each camera tile
has a toggle to switch between them ("Low latency" / "Compatibility"):

**Low latency (WebRTC)** — near-instant video, same as at home. This requires:

1. Set up SWAG as described in [Running behind a reverse proxy](#running-behind-a-reverse-proxy-eg-swag-on-unraid) (HTTPS for the app itself).
2. Set `PUBLIC_HOST` to your public IP or a DDNS hostname. ⚠️ It must **not** be a
   Cloudflare-proxied (orange cloud) name: Cloudflare's proxy carries only HTTP(S), never the UDP
   media, so remote Low latency would never connect while the page itself loads fine. Use a
   separate DNS-only (grey cloud) record, e.g. `rtc.example.com`, for `PUBLIC_HOST` and keep the
   proxied name for the web page.
3. Forward **UDP port 8189** (or your `WEBRTC_UDP_PORT`, see "Running more than one instance" in [Networking modes](networking.md#running-more-than-one-instance-eg-staging--production)) on your router to your server's
   LAN IP.

In Nightlight's setup the actual audio/video travels over UDP between your browser and MediaMTX,
so low-latency viewing from outside needs this one UDP port forward; it is a requirement of this
setup, not a workaround. There is no setting that removes it: Nightlight does not support TURN relay
servers (`STUN_SERVERS` accepts `stun:` URLs only), and MediaMTX's optional TCP media listener
(`webrtcLocalTCPAddress`) is off by default and is neither configured nor tested by Nightlight. This
single UDP port forward is all you need, unless you're behind CGNAT. If you would rather not forward
a port, use Compatibility (HLS) below.

**Compatibility (HLS)** — a few seconds of delay, but pure HTTP/TCP, so it rides through
the same port 443 as everything else with **no extra port forwarding at all**. Use this if
you'd rather not forward a UDP port, or if you're ever watching from a network that blocks
outbound UDP (some corporate/public Wi-Fi).

Compatibility mode works as soon as SWAG is set up — it needs nothing further, since it's already
proxied through the app's normal port. Low latency additionally needs `PUBLIC_HOST` and the UDP port
forward (steps 2 and 3 above).

> **iOS background audio:** On iPhone/iPad, background listening (screen off / app minimised) works
> in **Low latency** mode only — its WebRTC audio lets Nightlight fully own the lock screen (camera
> name, artwork, Pause/Play). **Compatibility** is HLS, which iOS runs its own native lock-screen
> session for that we can't reliably control, so Background isn't offered for a Compatibility camera
> on iOS (it was tried and removed for being inconsistent — see [KNOWN-ISSUES.md](../KNOWN-ISSUES.md)).
> Compatibility still works for live viewing. Android is unaffected — its background-listening
> service keeps both modes alive.

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
LAN IP, so with the [SWAG setup](#running-behind-a-reverse-proxy-eg-swag-on-unraid) **it is not trusted and every remote visitor looks like one client**.

Set it to the address your proxy connects *from*:

```bash
-e TRUST_PROXY=10.0.0.20        # SWAG's own LAN IP
```

> **⚠️ Only set this to an address you control.** Whatever you trust here is allowed to declare a
> client's IP. Too broad a value — or `true`, which trusts *every* upstream — lets anyone forge
> `X-Forwarded-For` and slip the per-address login limits entirely, which is worse than leaving it unset. If
> you are not sure, leave it alone. Password guesses are also limited per account whatever address a request
> claims ([Password guesses](mfa.md#password-guesses-553)), but that is a backstop, not a reason to trust more.

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

### While a tunnel daemon is attached

These rules apply while the Tailscale daemon is attached.

- Nightlight ignores `X-Forwarded-For` from any loopback hop, or any hop that is not a normal IP address, whatever `TRUST_PROXY` says. A proxy that reaches Nightlight by a LAN address is unaffected as long as no hop in its chain is loopback.
- Sign-in limits for each account use the person's Tailscale identity, so one person's mistakes do not use another person's allowance. The whole tunnel still shares a separate, looser per-address limit. Tagged devices, which have no identity header, share the old account allowance; people signed in through a shared-in device use their own identity. Two people can rarely land in the same one of 64 buckets and share an allowance. A process on the server can forge the identity header, but it cannot evade the shared tunnel limit or the separate account and MFA guess limits this way.
- Tailscale will not turn on until an admin account exists, and first-admin setup cannot be completed through a tunnel. Finish setup on your home network first. A same-host proxy that reaches Nightlight over loopback also cannot finish setup while the tunnel daemon is attached.

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
