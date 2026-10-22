# Install Nightlight on Windows

The Windows installer runs Nightlight as a background service, much like a
Sonarr installation. It includes Node.js, FFmpeg and MediaMTX. You do not need
Docker, WSL or a separate runtime installation.

## Install

1. Download `Nightlight-<version>-windows-x64-setup.exe` from a successful [Windows installer build](https://github.com/sauso/nightlight/actions/workflows/windows.yml). Open the run and download **Nightlight-Windows-x64**, then extract the installer. GitHub sign-in is required for workflow artifact downloads.
2. Run the installer and approve the Windows administrator prompt.
3. Choose an installation folder and web port (default **4000**). Leave **Allow devices on my private home network to connect** selected if you want to use phones or other computers at home.
4. Open **Nightlight** from the Start menu, or visit **http://localhost:4000**. Create your administrator account, then add a child and your cameras.

The target is 64-bit Windows 10 version 2004 or later and Windows 11. The build
and installation checks run on GitHub's current Windows runner; older Windows
versions have not been separately verified. The installer is currently unsigned.

Nightlight starts automatically at boot as the **Nightlight** Windows service,
including before anyone signs in. Its account is **NT AUTHORITY\LocalService**.
Keep the PC powered on and prevent Windows from sleeping while monitoring.

## Watch from another device

On the same home network, open `http://<PC-LAN-IP>:4000`, replacing the address
with the PC's IPv4 address shown by `ipconfig`. Use the web port you chose during
installation if it differs from 4000.

The installer's optional firewall rules allow the web port over TCP and
low-latency video on UDP **8189**. They apply only to the **Private** network
profile and **local subnet**. They do not change your network profile. Only mark
your trusted home network Private.

Camera RTSP and ONVIF traffic is outbound from the PC. Add cameras by their LAN
address or stream details as described in [cameras](cameras.md). Internal
MediaMTX ports remain on loopback; they do not need firewall exceptions.

## Start, stop and update

Open **Services** from the Windows Start menu and find **Nightlight** to start,
stop or restart it. From PowerShell as administrator you can also use:

```powershell
Get-Service Nightlight
Stop-Service Nightlight
Start-Service Nightlight
Restart-Service Nightlight
```

Stopping allows up to **30 seconds** for Nightlight to finish its shutdown,
including an in-flight recording. Avoid ending its Node process from Task
Manager when you can stop the service instead.

To update, back up your data, download the newer installer and run it over the
existing installation. The installer stops the service before replacing the app
files and starts it again afterward. It keeps your cameras, accounts, recordings
and selected web port. Updates are installed manually; no updater runs in the
background.

The web port is saved in `%ProgramData%\Nightlight\server.ini`:

```ini
[Server]
Port=4000
```

The allowed range is 1 to 65535. To change it together with the Start menu link
and firewall rule, run the installer again and choose the new port. Directly
editing the file and restarting the service changes the server port but does not
rewrite the shortcut or firewall rule.

## Data, logs and backups

Program files default to `C:\Program Files\Nightlight`. Data is separate, under
**`%ProgramData%\Nightlight`** (normally `C:\ProgramData\Nightlight`):

| Location | Contents |
| --- | --- |
| `babymonitor.db` and its WAL files | Accounts, camera credentials and settings |
| `clips` | Recordings and saved media |
| `server.ini` | Native server's web port |
| `logs` | Service output and startup/shutdown errors |
| `tmp` | Temporary runtime configuration |

The installer grants LocalService access to the data directory, with full access
for administrators and SYSTEM. Camera passwords and other stored secrets are
unencrypted in the database; protect backups as well.

Stop the Nightlight service, copy the **entire** data directory to a protected
backup location, then start the service again. For a restore, stop the service,
restore the complete directory and its permissions, then restart it. See
[operations](operations.md) for the database and media backup rules.

## Uninstall

Remove **Nightlight** from Windows **Installed apps**, or use **Uninstall
Nightlight** in its Start menu group. This removes the service, application,
shortcuts and installer-created firewall rules.

**Uninstall keeps `%ProgramData%\Nightlight`.** Reinstalling reuses your accounts,
cameras and recordings. Remove that directory yourself only if you intend to
erase all Nightlight data.

## Troubleshooting and validation

- **The browser cannot connect:** check the Nightlight service in Services, then check `%ProgramData%\Nightlight\logs`. A port conflict or invalid `server.ini` setting can stop startup.
- **The PC works but a phone cannot connect:** check the PC's LAN address, chosen web port and the Private network firewall rules. Networks outside the local subnet need their own networking setup.
- **The page loads but low-latency video does not:** check UDP 8189 and try **Compatibility (HLS)** mode to check the HTTP path separately. HLS has higher latency.
- **Monitoring stops while idle:** check Windows sleep and power settings. A service cannot monitor while the PC sleeps or is turned off.
- **Remote viewing:** this package is configured for your home network, with public STUN disabled. Follow [remote access](remote-access.md) for HTTPS, VPN and public WebRTC configuration.

The Windows workflow installs the actual setup executable and checks its service
account, boot startup mode, frontend, synthetic RTSP input, snapshot, HLS,
recording, graceful stop, upgrade, uninstall and reinstall. It uses generated
video, not household footage. Physical camera compatibility and playback from
other devices on a real home network still need a manual check.

## Build from source

On a Windows build machine with Node.js 24 and Inno Setup 6 installed, run
`windows/build.ps1` from PowerShell. It installs the committed npm lockfiles,
builds the frontend, downloads pinned Windows runtimes, and writes the installer
and SHA-256 checksum to `windows/dist`. Bundled licenses and runtime hashes are
installed alongside the application. The FFmpeg and MediaMTX version/checksum
pins live in the build script and must be updated together when changing tools.
