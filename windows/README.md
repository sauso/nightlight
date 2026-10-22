# Nightlight for Windows

This installs the Nightlight **server** using Docker Desktop's Linux engine.
It requires Docker Desktop with WSL 2 already installed and running.

1. Extract all files in this ZIP to a folder.
2. Double-click **Install.cmd**. Keep its window open while the image downloads
   and the server starts.
3. Nightlight opens in your browser. Create your administrator account, then add
   your cameras. A **Nightlight** shortcut is added to your Start menu.

If setup cannot choose a network adapter, open PowerShell in this folder and run
`./Setup-Nightlight.ps1 -ServerAddress 192.168.1.50`, replacing the address with
this PC's LAN IPv4 address from `ipconfig`.

The installed management script is at `%LOCALAPPDATA%\Nightlight\Setup-Nightlight.ps1`.
It accepts `-Action Start`, `Stop`, `Update`, `Status` and `Uninstall`.
Uninstall keeps your data in the Docker volume `nightlight-windows_data`.

Keep the PC awake and Docker Desktop running while monitoring. For access from
phones, use the PC's LAN address and allow TCP 4000 and UDP 8189 through Windows
Firewall on your private home network.

[Full setup, management, backup and troubleshooting guide](https://github.com/sauso/nightlight/blob/main/docs/windows.md)
