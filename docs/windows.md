# Install Nightlight on Windows

The Windows setup runs the **Nightlight server** on your PC using Docker Desktop's
WSL 2 Linux engine. It adds a Start menu shortcut and management commands. Docker
Desktop must be installed first; this package does not include a native Windows
server executable.

## What you need

- A Windows PC supported by the current [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/), with hardware virtualization and WSL 2 enabled.
- Docker Desktop installed, started, and using **Linux containers** with its WSL 2 engine. Its `desktop-linux` context and bundled Docker Compose are used by setup.
- The PC must be able to reach your RTSP/ONVIF cameras by their LAN addresses.
- Keep the PC powered on and awake while monitoring. Docker Desktop must keep running. This setup does not create a Windows service; enable Docker Desktop's **Start Docker Desktop when you sign in** option to resume after signing in following a restart.

No Node.js, FFmpeg or MediaMTX installation is needed on Windows; they come in
Nightlight's Docker image. The setup script itself does not require administrator
rights. Installing Docker Desktop or adding firewall rules may require them.

## Install

1. Download the [repository ZIP](https://github.com/sauso/nightlight/archive/refs/heads/main.zip), extract it, and open its **windows** folder. Alternatively, download and extract `Nightlight-Windows-Setup.zip` from a successful [Windows setup workflow](https://github.com/sauso/nightlight/actions/workflows/windows.yml) run (GitHub sign-in is required for workflow downloads).
2. Start Docker Desktop and wait until its engine is running.
3. Double-click **Install.cmd**. Keep the window open while Nightlight's image downloads and the server passes its health check. A first download can take several minutes.
4. Nightlight opens at **http://localhost:4000**. Create your administrator account, add a child and add your cameras by IP address or RTSP details. A **Nightlight** browser shortcut is now in your Start menu.

The setup chooses the active IPv4 adapter with a default gateway. If it finds
several (for example Wi-Fi plus a VPN), it asks you to supply the correct address.
Open PowerShell in the extracted **windows** folder and run:

```powershell
.\Setup-Nightlight.ps1 -ServerAddress 192.168.1.50
```

Replace the address with this PC's LAN IPv4 address from `ipconfig`, on the network
that reaches your cameras. If PowerShell blocks a downloaded script, run the
launcher from that same folder instead:

```powershell
.\Install.cmd -ServerAddress 192.168.1.50
```

For different ports, add `-HttpPort 4080 -WebRtcPort 8190` to the first install.
Both accept whole numbers from 1 to 65535; defaults are 4000 and 8189. Use the
chosen ports in your browser and firewall rules. The UDP port is mapped to the
same port inside the container so WebRTC's advertised port stays correct.

## Watch from phones and other computers

Open `http://<PC-LAN-IP>:4000` on a device connected to the same home network.
For example, if setup used `192.168.1.50`, open `http://192.168.1.50:4000`.

If Windows Firewall blocks access, allow Docker Desktop on your private home
network, or add these rules from **PowerShell as administrator**:

```powershell
New-NetFirewallRule -DisplayName 'Nightlight web' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4000 -Profile Private -RemoteAddress LocalSubnet
New-NetFirewallRule -DisplayName 'Nightlight video' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 8189 -Profile Private -RemoteAddress LocalSubnet
```

These example rules are restricted to the local subnet and the Private network
profile. Setup does not change your firewall or network profile automatically.
Only mark a network Private if it is your trusted home network. Use your custom
ports if you changed them. Removing these optional rules is a separate Windows
Firewall action; uninstall does not remove rules you added yourself.

Reserve the PC's IP address in your router's DHCP settings so it stays stable.
If it changes, edit `NIGHTLIGHT_HOST` in
`%LOCALAPPDATA%\Nightlight\nightlight.env`, then use **Start** below to recreate
the container with the new address. Camera setup uses camera IP addresses;
multicast discovery through Docker Desktop's VM is not part of this setup.

## Start, stop, update and uninstall

Open PowerShell and load the installed script path into a variable:

```powershell
$nightlightSetup = "$env:LOCALAPPDATA\Nightlight\Setup-Nightlight.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $nightlightSetup -Action Status
```

Use the same command with the action you need:

| Action | What it does |
| --- | --- |
| `Start` | Starts Nightlight, applies edited settings, waits for its health check and opens the browser. |
| `Stop` | Stops monitoring and allows up to 30 seconds for recordings to finish saving. |
| `Update` | Pulls `sauso/nightlight:latest`, recreates the container and waits for its health check. Saved data and settings are kept. Back up before updating. |
| `Status` | Shows the container's status and health. |
| `Uninstall` | Stops and removes the container, installed setup files and Start menu shortcut. **Keeps the data volume.** Reinstalling reuses it. |

Add `-NoBrowser` for Start or Update if you want to keep the browser closed.
Running Install again resumes an interrupted installation and keeps existing
settings. To change an existing address or port, edit `nightlight.env` and use
Start; Install refuses arguments that would overwrite those settings.

The Docker project is always `nightlight-windows`. It is separate from a Linux
Compose install. The setup uses the local `desktop-linux` context regardless of
which Docker context you selected elsewhere. One Windows setup per Docker Desktop
engine is supported.

## Where your data lives and how to back it up

Settings, accounts, camera credentials and recordings live in the named Docker
volume **nightlight-windows_data**. The volume is stored inside Docker Desktop's
Linux storage, rather than a Windows folder shared into the container, so SQLite
and Linux file permissions work normally. Keep sufficient free disk space for
Docker Desktop's virtual disk and your recordings.

Stopping, updating and uninstalling Nightlight keep that volume. Deleting it in
Docker Desktop, or resetting/uninstalling Docker Desktop with its data removed,
can erase it. Protect backups: they contain camera passwords and other secrets.

To back up a stopped server from PowerShell:

```powershell
$nightlightSetup = "$env:LOCALAPPDATA\Nightlight\Setup-Nightlight.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $nightlightSetup -Action Stop
$backupDirectory = (New-Item -ItemType Directory -Path "$env:USERPROFILE\NightlightBackups" -Force).FullName
docker --context desktop-linux run --rm --mount type=volume,source=nightlight-windows_data,target=/data,readonly --mount "type=bind,source=$backupDirectory,target=/backup" alpine sh -c 'tar -czf /backup/nightlight-data.tar.gz -C /data .'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $nightlightSetup -Action Start -NoBrowser
```

Check that the archive was created successfully before relying on it. This
example overwrites a previous archive of the same name. More about backups and
restore: [operations](operations.md).

## Troubleshooting and current limits

- **Docker Desktop is not running / wrong engine:** start it with the WSL 2 Linux engine, then retry Install. Setup stops before writing files if the engine check fails.
- **Download failed:** check Docker Hub connectivity and free disk space, then rerun Install. Existing settings are preserved. A failed update download leaves the existing container running.
- **Server failed its health check:** settings are kept for retry. Run `docker --context desktop-linux compose --project-name nightlight-windows --file "$env:LOCALAPPDATA\Nightlight\docker-compose.yml" --env-file "$env:LOCALAPPDATA\Nightlight\nightlight.env" logs --tail 100`. Fix the reported error, then run Start. A failed health check is not reported as a successful installation.
- **Port is already allocated:** edit `NIGHTLIGHT_HTTP_PORT` or `NIGHTLIGHT_WEBRTC_PORT` in `nightlight.env` and run Start. Match your firewall rules to the new ports.
- **Page loads, low-latency video does not:** check the PC's saved LAN address and the UDP firewall rule. Try **Compatibility (HLS)** mode to check the HTTP path separately. HLS has higher latency. Do not publish MediaMTX's internal API, RTSP, HLS or signalling ports; the authenticated web app proxies the needed HTTP traffic.
- **Monitoring stops after a restart or while idle:** start Docker Desktop, enable its sign-in startup option, and check Windows sleep settings. Start menu launches the browser; it does not wake a stopped Docker engine or PC.
- **Remote viewing:** this setup is configured for the home network, with public STUN disabled. Follow [remote access](remote-access.md) for HTTPS, VPN or public WebRTC setup; do not assume the LAN firewall rules provide internet access.

Automated checks exercise the installer with Docker/network/browser commands
stubbed, and validate the configuration with the real Docker Compose parser, on
Windows PowerShell 5.1 and PowerShell 7. They do **not** run Docker Desktop with a
real camera. Camera connectivity, Windows Firewall behaviour and WebRTC/HLS
playback on a Windows host still need a manual end-to-end check.
