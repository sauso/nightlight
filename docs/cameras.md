# Cameras and caregivers

Add and edit cameras from the **Cameras** tab (admin only). This page covers which cameras work, how to add and manage them, where to mount them, and what to know about trusting them. Giving other people access is at the end, under [Caregivers](#caregivers).

## Managing cameras

A camera's address is entered as separate fields: **IP address**, **RTSP port** (usually 554), **stream path** and the camera's **username / password**. Nightlight assembles the `rtsp://` URL itself, so the password never appears in a URL on screen.

### Which cameras work

Nightlight works with **ONVIF / RTSP** cameras in general: video, audio and, on ONVIF cameras, pan/tilt and two-way audio. Camera support and two-way audio specifics are in [camera controls](camera-controls.md) and [known issues](../KNOWN-ISSUES.md).

- The fully tested and **recommended** option is **open-firmware [Thingino](https://thingino.com/) cameras** (inexpensive, ONVIF, pan/tilt, two-way audio). On those, set the camera's audio codec to **G711 (a-law)** for reliable sound. Some builds default to AAC, which not all of them stream well (see `KNOWN-ISSUES.md`).
- Most other ONVIF cameras work too, and Hikvision two-way audio (ISAPI) is supported. Support varies by firmware and model.
- **If a camera won't connect**, the **Add camera** screen can generate a redacted **camera report** to help add support for it. The report is a JSON file that stays on your device. It holds the camera's address, username, ONVIF result and stream codecs, with any password replaced by `***`. It is meant to be attached to a GitHub issue, so **read it before you post it**: passwords are masked, but addresses, usernames and error messages from the camera's firmware may contain identifying details, and the redaction covers passwords, not everything a firmware might put in an error message. If you find something sensitive that shouldn't be there, see [SECURITY.md](../SECURITY.md) for how to report it privately instead.

### Adding a camera

- **Via ONVIF (easiest):** type the camera's IP and press **Fetch port & path from ONVIF**. Nightlight queries the camera and fills in the port and stream path for you, and detects whether it supports pan/tilt and two-way audio. It looks the camera up at the IP you typed; it doesn't scan your network for cameras. Most cameras answer without a login. If yours needs one, fill in the username and password before you fetch, and keep them entered when you Save.
- **Manually:** type the IP, port, path and login yourself (see the camera's manual for its RTSP path, for example `/stream1`).
- On **Save**, Nightlight briefly tests the stream first and won't store a camera it can't reach (wrong login, path or IP). It tells you why. If the camera just happens to be offline right then, you can choose **Save anyway**.

### What you see on a camera

- **Capability badges.** Cameras added via ONVIF show **PTZ** and **Two-way Audio** badges in the list: green when supported, red when not. Manually added cameras show neither, because their capabilities aren't probed.
- **Pan/tilt (PTZ).** On cameras that report PTZ, a move button appears on the camera tile (next to the stream-quality gear). Tap it for an on-screen D-pad: each press nudges the camera a fixed amount, and holding an arrow keeps it moving. It stops on release and can't run past the limit.
- **Two-way audio (talk-back).** On cameras that support it, a talk button appears on the tile: hold it to speak through the camera's speaker. It works with **Hikvision** (over ISAPI; enter the camera's *web* login when adding) and with **any ONVIF camera that has an audio backchannel** (for example Thingino or Sonoff). The backchannel is set up automatically from the ONVIF probe, using the camera's own stream login.

### Editing, removing and assigning

- **Editing.** Edit shows the same fields. Leave the **password blank to keep the existing one**; it's never sent back to your browser. Changing the address re-tests the stream, the same as adding.
- **Removing.** Remove asks for confirmation, then stops the stream and **permanently deletes everything for the camera**: its bed transitions and snapshot photos, activity history, alerts with their clips and snapshots, recordings, event log and sensor history. You can add the camera again, but none of that comes back. See [Removing a child or a camera](recording.md#removing-a-child-or-a-camera).
- **Assigning to a child.** Use the "Assigned to" dropdown on each camera (admin only; a caregiver sees the assignment as text). It is more than grouping: a camera's nights are tracked only while it is assigned to a child who has sleep tracking on, so unassigning a camera stops its tracking just as turning tracking off does.

## Where to put the camera

Nightlight works from **any** camera position: put the camera wherever it fits and you will still get sleep tracking and motion alerts. A good position makes them **more reliable**, and nothing more than that. These are suggestions from testing in one household, not guarantees, and not a measured result (a proper comparison of positions has not been done yet).

- **The suggested view:** looking down at the bed from above, at about **45 degrees**, the way most baby monitors are mounted. Have the **whole bed in frame**, and the **doorway or room entry in view as well** if you can: seeing who comes in and goes out makes an entry or exit easier to tell from other movement.
- **What to avoid:**
  - **A light that flashes, flickers or changes brightness in view of the bed** (a blinking charger or night light, a screen, a light that cycles). Every change lights up pixels in the bed, which can break the empty-bed check into short pieces, and a correct morning wake can then read wrong or be missed. Cover or move the light, or point the camera so it is out of frame.
  - **A bed zone that overlaps where a parent stands or leans** (for example a camera so low or side-on that a person at the bedside covers the bed in the picture). Their movement then counts as movement in the bed.
  - **The bed being a tiny part of the frame.** With few pixels on the bed, a real movement is a smaller share of the zone and is easier to miss. Fill the frame with the bed, within reason.
- **If you move a camera, paint the bed zone again.** The bed zone (the area the camera watches for movement in the bed) is drawn on one particular picture, so after a move it no longer sits on the bed. Nothing checks that the zone is on the bed, so look at it over a live picture after any move. Sleep nights before and after a move are **not directly comparable**: the zone and the camera's idea of a quiet room both change, so a difference in the figures may come from the move, not from the sleep.

## Cameras are trusted input

Nightlight trusts everything a camera sends it: the video and audio stream, the ONVIF replies and the snapshot images. The stream is parsed by FFmpeg and ffprobe, and the rest by the server itself, all as the same user that owns the data directory (the database, the saved secrets and the recordings). Nothing separates the media processes from the data on disk.

They are not handed the server's environment: FFmpeg and ffprobe start with only `PATH`, `TZ`, `LANG` and `LC_ALL`, and MediaMTX with the same plus your `MTX_*` overrides ([details](architecture.md#child-process-environment-backendsrclibchildenvjs-553)). That narrows what a bug in one of them could leak, but it is not a sandbox: running as the same user, a media process that a camera managed to take over could still read the server's own environment (`JWT_SECRET` included) through the process table, as well as the files.

Cameras are often the least-updated devices on a network, so put them on **their own VLAN or network segment**, ideally with no route to the internet and no access to your other devices, and let only the Nightlight host reach them (RTSP, plus ONVIF and the snapshot URL if you use them). This is advice: Nightlight does not check or enforce it.

## Caregivers

Create caregiver accounts in the app to give other trusted people access. For sign-in and multi-factor authentication, see [MFA](mfa.md). Only share access with people you trust. What caregivers and admins can each do, and how long a sign-in lasts, are in [Adding caregivers](caregivers.md).
