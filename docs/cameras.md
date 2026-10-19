# Cameras and caregivers

Add cameras from the **Cameras** tab (admin only). Enter the camera IP, RTSP port (often 554), stream path and credentials. Nightlight builds the stream URL for you.

Compatible ONVIF cameras can provide discovery, stream information and supported PTZ controls. RTSP-only cameras can be added manually. Thingino-based cameras are a recommended tested option; for reliable audio, G711 a-law may work better than AAC on some builds. Other cameras vary by firmware and model.

Camera support and two-way audio specifics are described in [camera controls](camera-controls.md) and [known issues](../KNOWN-ISSUES.md).

If a camera cannot connect, the add-camera screen can create a redacted diagnostic report. **Read the report before sharing it**: passwords are masked, but addresses, usernames and firmware error messages may contain identifying details. Use [private security reporting](../SECURITY.md) for sensitive findings.

Treat camera devices as trusted network peers. Camera-provided media and metadata are processed by server-side components that share access to the application's local data. Isolate untrusted devices and protect the host.

## Caregivers

Create caregiver accounts in the app to give other trusted people access. For sign-in and multi-factor authentication, see [MFA](mfa.md). Only share access with people you trust.
