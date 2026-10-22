#Requires -Version 5.1
<#
.SYNOPSIS
Installs and manages the Nightlight server with Docker Desktop on Windows.
.DESCRIPTION
Run Install.cmd, or this script in PowerShell. Docker Desktop must already be
running with its Linux engine. No administrator rights are needed by this script.
Data remains in the nightlight-windows_data volume, including after uninstall.
.EXAMPLE
.\Setup-Nightlight.ps1 -ServerAddress 192.168.1.50
.EXAMPLE
.\Setup-Nightlight.ps1 -Action Update
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Start', 'Stop', 'Update', 'Status', 'Uninstall')]
    [string] $Action = 'Install',
    [string] $ServerAddress,
    [ValidateRange(1, 65535)] [int] $HttpPort = 4000,
    [ValidateRange(1, 65535)] [int] $WebRtcPort = 8189,
    [string] $InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Nightlight'),
    [switch] $NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-NightlightDocker {
    param([string[]] $DockerArguments, [switch] $ShowOutput)

    # Pin the local Desktop engine: a selected remote Docker context must never
    # turn a Windows installer into a deployment to some other machine.
    # PowerShell 5.1 converts native stderr to ErrorRecords. Collect it without
    # terminating early, then use the native exit code as the success condition.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & docker --context desktop-linux @DockerArguments 2>&1 | ForEach-Object {
            if ($ShowOutput) { Write-Host $_ }
            $_
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw "Docker failed ($exitCode): $($output -join [Environment]::NewLine)"
    }
    return $output
}

function Assert-NightlightDockerDesktop {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/, enable its WSL 2 Linux engine, start it, then run this setup again.'
    }
    try {
        $engine = (Invoke-NightlightDocker -DockerArguments @('info', '--format', '{{.OSType}}')) -join ''
        if ($engine.Trim() -ne 'linux') {
            throw 'The Docker engine is not running Linux containers.'
        }
        $null = Invoke-NightlightDocker -DockerArguments @('compose', 'version')
    } catch {
        throw "Start Docker Desktop with its WSL 2 Linux engine, then retry. $($_.Exception.Message)"
    }
}

function Resolve-NightlightServerAddress {
    param([string] $Address)

    if (-not $Address) {
        # Default-gateway interfaces avoid choosing a WSL/Hyper-V adapter just
        # because it happens to be the first address returned by Windows.
        $addresses = @(Get-NetIPConfiguration | Where-Object {
            $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up'
        } | ForEach-Object {
            $_.IPv4Address | ForEach-Object { $_.IPAddress }
        } | Where-Object {
            $_ -and $_ -notlike '169.254.*' -and $_ -notlike '127.*'
        } | Select-Object -Unique)
        if ($addresses.Count -ne 1) {
            throw "Could not choose one LAN address ($($addresses -join ', ')). Run Setup-Nightlight.ps1 -ServerAddress <this PC's LAN IPv4 address>. Find it with ipconfig; choose the adapter that reaches your cameras."
        }
        $Address = $addresses[0]
    }
    $parsed = $null
    # Require dotted decimal as well as TryParse: .NET also accepts abbreviated
    # and numeric address forms, which should never end up in a Compose env file.
    if ($Address -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or
        -not [System.Net.IPAddress]::TryParse($Address, [ref] $parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
        $Address -match '^(0\.|127\.|169\.254\.)' -or
        $parsed.GetAddressBytes()[0] -ge 224) {
        throw 'ServerAddress must be this PC''s LAN IPv4 address, for example 192.168.1.50.'
    }
    return $parsed.ToString()
}

function Invoke-NightlightCompose {
    param([string] $Directory, [string[]] $ComposeArguments)
    $null = Invoke-NightlightDocker -ShowOutput -DockerArguments (@(
        'compose', '--project-name', 'nightlight-windows',
        '--file', (Join-Path $Directory 'docker-compose.yml'),
        '--env-file', (Join-Path $Directory 'nightlight.env')
    ) + $ComposeArguments)
}

function Get-NightlightWebUrl {
    param([string] $Directory)
    $settings = Get-Content -LiteralPath (Join-Path $Directory 'nightlight.env') -Raw | ConvertFrom-StringData
    return "http://localhost:$($settings.NIGHTLIGHT_HTTP_PORT)"
}

function Set-NightlightShortcut {
    param([string] $Url)
    $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $null = New-Item -ItemType Directory -Path $programs -Force
    Set-Content -LiteralPath (Join-Path $programs 'Nightlight.url') -Encoding ASCII -Value "[InternetShortcut]`r`nURL=$Url"
}

function Invoke-NightlightSetup {
    [CmdletBinding()]
    param(
        [ValidateSet('Install', 'Start', 'Stop', 'Update', 'Status', 'Uninstall')]
        [string] $Action = 'Install',
        [string] $ServerAddress,
        [ValidateRange(1, 65535)] [int] $HttpPort = 4000,
        [ValidateRange(1, 65535)] [int] $WebRtcPort = 8189,
        [string] $InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Nightlight'),
        [switch] $NoBrowser
    )

    Assert-NightlightDockerDesktop
    $configPath = Join-Path $InstallDirectory 'nightlight.env'
    if ($Action -eq 'Install') {
        if (-not (Test-Path -LiteralPath $configPath)) {
            $address = Resolve-NightlightServerAddress $ServerAddress
            $null = New-Item -ItemType Directory -Path $InstallDirectory -Force
            Set-Content -LiteralPath $configPath -Encoding ASCII -Value @(
                "NIGHTLIGHT_HOST=$address"
                "NIGHTLIGHT_HTTP_PORT=$HttpPort"
                "NIGHTLIGHT_WEBRTC_PORT=$WebRtcPort"
            )
        } elseif ($PSBoundParameters.ContainsKey('ServerAddress') -or
            $PSBoundParameters.ContainsKey('HttpPort') -or $PSBoundParameters.ContainsKey('WebRtcPort')) {
            throw "An installation already exists. Edit $configPath and use -Action Start to apply changed addresses or ports. Your saved settings have been kept."
        }
        foreach ($file in @('docker-compose.yml', 'Setup-Nightlight.ps1')) {
            $source = Join-Path $PSScriptRoot $file
            $destination = Join-Path $InstallDirectory $file
            if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) {
                Copy-Item -LiteralPath $source -Destination $destination -Force
            }
        }
    } elseif (-not (Test-Path -LiteralPath $configPath)) {
        throw 'Nightlight is not installed here. Run Install.cmd first.'
    }

    switch ($Action) {
        { $_ -in 'Install', 'Update' } {
            Write-Host 'Downloading the Nightlight image. The first download can take a few minutes...'
            Invoke-NightlightCompose -Directory $InstallDirectory -ComposeArguments @('pull')
        }
    }
    switch ($Action) {
        { $_ -in 'Install', 'Start', 'Update' } {
            Write-Host 'Starting Nightlight and waiting for its health check...'
            Invoke-NightlightCompose -Directory $InstallDirectory -ComposeArguments @('up', '-d', '--wait', '--wait-timeout', '180')
            $url = Get-NightlightWebUrl $InstallDirectory
            Set-NightlightShortcut $url
            Write-Host "Nightlight is ready at $url. A shortcut is in the Start menu."
            Write-Host "Settings and management script: $InstallDirectory"
            Write-Host 'Keep Docker Desktop running and prevent this PC from sleeping while monitoring.'
            if (-not $NoBrowser) {
                try { Start-Process $url } catch { Write-Warning "Open $url in your browser." }
            }
        }
        'Stop' {
            Invoke-NightlightCompose -Directory $InstallDirectory -ComposeArguments @('stop', '--timeout', '30')
            Write-Host 'Nightlight is stopped. Its data has been kept.'
        }
        'Status' {
            # Show output for this action; the other Compose calls are quiet on
            # success because native progress output differs across PS versions.
            Invoke-NightlightDocker -DockerArguments @(
                'compose', '--project-name', 'nightlight-windows',
                '--file', (Join-Path $InstallDirectory 'docker-compose.yml'),
                '--env-file', $configPath, 'ps'
            ) | Out-Host
        }
        'Uninstall' {
            Invoke-NightlightCompose -Directory $InstallDirectory -ComposeArguments @('down', '--timeout', '30')
            $shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nightlight.url'
            if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
            # Only remove files this installer owns. The directory may contain a
            # user's notes or backups; never recursively delete it.
            foreach ($file in @('nightlight.env', 'docker-compose.yml', 'Setup-Nightlight.ps1')) {
                $path = Join-Path $InstallDirectory $file
                if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
            }
            Write-Host 'Nightlight was uninstalled. Your cameras, accounts and recordings remain in the Docker volume nightlight-windows_data and will be reused if you reinstall.'
        }
    }
}

# Dot-sourcing loads the same functions the Windows tests exercise without
# installing anything. Normal execution reports failures with a non-zero exit.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-NightlightSetup @PSBoundParameters
    } catch {
        Write-Host "Nightlight setup failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host 'See https://github.com/sauso/nightlight/blob/main/docs/windows.md for setup and troubleshooting.'
        exit 1
    }
}
