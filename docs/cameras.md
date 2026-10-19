# Cameras and caregivers

Add cameras from the **Cameras** tab (admin only). Enter the camera IP, RTSP port (often 554), stream path and credentials. Nightlight builds the stream URL for you.

For ONVIF cameras, Nightlight can fetch the stream port and path from the camera's IP address (it doesn't scan your network for cameras) and supports pan/tilt where the camera reports it. RTSP-only cameras can be added by hand. Thingino-based cameras are a recommended tested option; for reliable audio, G711 a-law may work better than AAC on some builds. Other cameras vary by firmware and model.

Camera support and two-way audio specifics are described in [camera controls](camera-controls.md) and [known issues](../KNOWN-ISSUES.md).

If a camera cannot connect, the add-camera screen can create a redacted diagnostic report. **Read the report before sharing it**: passwords are masked, but addresses, usernames and firmware error messages may contain identifying details. Use [private security reporting](../SECURITY.md) for sensitive findings.

Nightlight trusts everything a camera sends it, and the programs that read the video run as the same user that owns your data. Cameras are often the least-updated devices on a network, so put them on their own VLAN or network segment, with no route to the internet and no access to your other devices, and let only the Nightlight host reach them. This is advice; Nightlight doesn't check or enforce it. Detail: [cameras are trusted input](readme-reference.md#managing-cameras).

## Moving and removing cameras

Where a camera is mounted affects sleep tracking. See "Where to put the camera" in the [full reference](readme-reference.md#where-to-put-the-camera).

Removing a camera asks for confirmation, then permanently deletes everything stored for it: its recordings, alerts, snapshots, activity history and event log.

## Caregivers

Create caregiver accounts in the app to give other trusted people access. For sign-in and multi-factor authentication, see [MFA](mfa.md). Only share access with people you trust.
