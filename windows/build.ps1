#Requires -Version 5.1
[CmdletBinding()]
param([string] $OutputDirectory = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = Split-Path $PSScriptRoot -Parent
$build = Join-Path $PSScriptRoot 'build'
$payload = Join-Path $build 'payload'
$downloads = Join-Path $build 'downloads'
$null = New-Item -ItemType Directory -Path $downloads -Force
if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
foreach ($dir in @($payload, "$payload\bin", "$payload\app", "$payload\licenses", $OutputDirectory)) {
    $null = New-Item -ItemType Directory -Path $dir -Force
}

function Get-Download {
    param([string] $Url, [string] $File, [string] $Sha256)
    Write-Host "Downloading $([IO.Path]::GetFileName($File))"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $File
    if ($Sha256 -and (Get-FileHash $File -Algorithm SHA256).Hash -ine $Sha256) {
        throw "SHA-256 mismatch: $File"
    }
}
function Run-Npm {
    param([string[]] $Arguments)
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm failed: $Arguments" }
}

# Build the same locked frontend/backend used by Docker, on Windows so native
# better-sqlite3 bindings match the target OS. No compiler/runtime install is
# required on the end user's PC.
Run-Npm -Arguments @('--prefix', "$repo\frontend", 'ci')
Run-Npm -Arguments @('--prefix', "$repo\frontend", 'run', 'build')
Run-Npm -Arguments @('--prefix', "$repo\backend", 'ci', '--omit=dev')
Copy-Item "$repo\backend\src" "$payload\app\src" -Recurse
Copy-Item "$repo\backend\node_modules" "$payload\app\node_modules" -Recurse
Copy-Item "$repo\backend\package.json" "$payload\app\package.json"
Copy-Item "$repo\frontend\dist" "$payload\app\public" -Recurse
Copy-Item "$repo\mediamtx\mediamtx.yml" "$payload\app\mediamtx.yml"
Copy-Item "$PSScriptRoot\launch.mjs", "$PSScriptRoot\Nightlight.Service.xml" $payload
Copy-Item "$repo\LICENSE" "$payload\licenses\Nightlight.txt"

$nodeVersion = '24.19.0'
$nodeArchive = "node-v$nodeVersion-win-x64.zip"
$nodeBase = "https://nodejs.org/dist/v$nodeVersion"
$sums = (Invoke-WebRequest -UseBasicParsing "$nodeBase/SHASUMS256.txt").Content
$line = @($sums -split "`n" | Where-Object { $_.Trim().EndsWith("  $nodeArchive") })
if ($line.Count -ne 1) { throw "No upstream checksum for $nodeArchive" }
$nodeHash = ($line[0].Trim() -split '\s+')[0]
Get-Download "$nodeBase/$nodeArchive" "$downloads\node.zip" $nodeHash
Expand-Archive "$downloads\node.zip" "$downloads\node" -Force
$nodeDir = Join-Path "$downloads\node" "node-v$nodeVersion-win-x64"
Copy-Item "$nodeDir\node.exe" "$payload\node.exe"
Copy-Item "$nodeDir\LICENSE" "$payload\licenses\Node.txt"

# Pins are deliberate: the detector's showinfo grammar is exercised against
# FFmpeg 8.1. Update the asset URL AND checksum together when upgrading tools.
$mtxUrl = 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_windows_amd64.zip'
Get-Download $mtxUrl "$downloads\mediamtx.zip" 'a84224f5a490855684e62ba6fb71e80ea2a5e16aed61883bb58380290e93e467'
Expand-Archive "$downloads\mediamtx.zip" "$downloads\mediamtx" -Force
Copy-Item "$downloads\mediamtx\mediamtx.exe" "$payload\bin\mediamtx.exe"
Get-Download 'https://raw.githubusercontent.com/bluenviron/mediamtx/v1.21.2/LICENSE' "$payload\licenses\MediaMTX.txt" ''

$ffmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-22-13-06/ffmpeg-n8.1.3-23-g5c4f5744cd-win64-gpl-8.1.zip'
Get-Download $ffmpegUrl "$downloads\ffmpeg.zip" '75f5d6b673be7d93f59dcffb81a92c003580a7dcdbff768976b7907869aee09a'
Expand-Archive "$downloads\ffmpeg.zip" "$downloads\ffmpeg" -Force
$ffmpegDir = @(Get-ChildItem "$downloads\ffmpeg" -Directory)[0].FullName
Copy-Item "$ffmpegDir\bin\ffmpeg.exe", "$ffmpegDir\bin\ffprobe.exe" "$payload\bin"
Copy-Item "$ffmpegDir\LICENSE*" "$payload\licenses"

# WinSW 2 uses the .NET Framework already present on supported Windows 10/11.
# This older upstream release does not publish a checksum; its versioned HTTPS
# release URL is pinned, and the downloaded hash is included in the manifest.
$winswUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
Get-Download $winswUrl "$payload\Nightlight.Service.exe" ''
Get-Download 'https://raw.githubusercontent.com/winsw/winsw/v2.12.0/LICENSE.txt' "$payload\licenses\WinSW.txt" ''

@"
Nightlight bundles separate executables from these projects:
Node.js ${nodeVersion}: $nodeBase/ (MIT and bundled third-party notices in Node.txt)
MediaMTX 1.21.2: https://github.com/bluenviron/mediamtx/tree/v1.21.2 (MIT)
WinSW 2.12.0: https://github.com/winsw/winsw/tree/v2.12.0 (MIT)
FFmpeg 8.1.3, revision 5c4f5744cd: https://github.com/FFmpeg/FFmpeg/tree/5c4f5744cd (GPL build, including libx264)
FFmpeg build configuration and dependency sources: https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-10-22-13-06
FFmpeg binary: $ffmpegUrl
License texts are in this directory. FFmpeg is invoked as a separate process.
"@ | Set-Content "$payload\licenses\THIRD-PARTY-NOTICES.txt" -Encoding UTF8

$hashes = @('node.exe', 'Nightlight.Service.exe', 'bin\ffmpeg.exe', 'bin\ffprobe.exe', 'bin\mediamtx.exe') | ForEach-Object {
    $file = Join-Path $payload $_
    [pscustomobject]@{ file = $_; sha256 = (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$hashes | ConvertTo-Json | Set-Content "$payload\runtime-manifest.json" -Encoding ASCII
$version = (Get-Content "$repo\backend\package.json" -Raw | ConvertFrom-Json).version
$compiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
if (-not (Test-Path $compiler)) { throw 'Install Inno Setup 6 to build the Windows installer.' }
& $compiler "/DAppVersion=$version" "/DPayloadDir=$payload" "/DOutputDir=$OutputDirectory" "$PSScriptRoot\installer.iss"
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed' }
$installer = Join-Path $OutputDirectory "Nightlight-$version-windows-x64-setup.exe"
"$((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($installer))" | Set-Content "$OutputDirectory\SHA256SUMS.txt" -Encoding ASCII
Write-Host "Built $installer"
