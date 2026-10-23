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
foreach ($dir in @($payload, "$payload\bin", "$payload\app", "$payload\licenses", "$payload\redist", $OutputDirectory)) {
    $null = New-Item -ItemType Directory -Path $dir -Force
}

# Compile the script with a tiny payload first. Catch syntax/flag mistakes before
# spending time building the frontend and downloading the large video runtimes.
$compiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
if (-not (Test-Path $compiler)) { throw 'Install Inno Setup 6 to build the Windows installer.' }
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw 'The Windows .NET Framework compiler is required to build the tray companion.' }
# Reuse the website's Nightlight artwork at eight Windows icon sizes. Embed the same
# icon in the desktop executable, setup and uninstaller; ship it for shortcuts.
& "$PSScriptRoot\build-icon.ps1" -Source "$PSScriptRoot\assets\Nightlight.png" -Destination "$payload\Nightlight.ico"
& $csc '/nologo' '/target:winexe' '/platform:x64' '/optimize+' "/out:$payload\Nightlight.Tray.exe" "/win32icon:$payload\Nightlight.ico" "/win32manifest:$PSScriptRoot\Tray\app.manifest" '/reference:System.Windows.Forms.dll' '/reference:System.Drawing.dll' "$PSScriptRoot\Tray\Program.cs"
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the Nightlight tray companion.' }
& "$PSScriptRoot\test\tray.ps1" -PayloadDirectory $payload
$syntaxPayload = Join-Path $build 'syntax-payload'
$null = New-Item -ItemType Directory -Path $syntaxPayload -Force
Set-Content "$syntaxPayload\placeholder.txt" -Value 'Installer compiler check' -Encoding ASCII
Copy-Item "$payload\Nightlight.ico" "$syntaxPayload\Nightlight.ico" -Force
& $compiler '/Qp' "/DPayloadDir=$syntaxPayload" "/DOutputDir=$build\syntax-output" "$PSScriptRoot\installer.iss"
if ($LASTEXITCODE -ne 0) { throw 'Installer script compilation failed' }

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
# FFmpeg 8.1. Use a month-end build (retained for two years), not a daily build
# that upstream deletes after 14 days. Update URLs and checksums together.
$mtxUrl = 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_windows_amd64.zip'
Get-Download $mtxUrl "$downloads\mediamtx.zip" 'a84224f5a490855684e62ba6fb71e80ea2a5e16aed61883bb58380290e93e467'
Expand-Archive "$downloads\mediamtx.zip" "$downloads\mediamtx" -Force
Copy-Item "$downloads\mediamtx\mediamtx.exe" "$payload\bin\mediamtx.exe"
Get-Download 'https://raw.githubusercontent.com/bluenviron/mediamtx/v1.21.2/LICENSE' "$payload\licenses\MediaMTX.txt" ''

$ffmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip'
Get-Download $ffmpegUrl "$downloads\ffmpeg.zip" '7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa'
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

# Native SQLite bindings can need the MSVC runtime on a clean Windows machine.
# Bundle Microsoft's redistributable so setup works without a separate download
# on the target PC. Verify the Microsoft signature on this serviced prerequisite.
$redist = "$payload\redist\vc_redist.x64.exe"
Get-Download 'https://aka.ms/vc14/vc_redist.x64.exe' $redist ''
$signature = Get-AuthenticodeSignature $redist
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw 'The Visual C++ prerequisite does not have a valid Microsoft signature.'
}

@"
Nightlight bundles separate executables from these projects:
Node.js ${nodeVersion}: $nodeBase/ (MIT and bundled third-party notices in Node.txt)
MediaMTX 1.21.2: https://github.com/bluenviron/mediamtx/tree/v1.21.2 (MIT)
WinSW 2.12.0: https://github.com/winsw/winsw/tree/v2.12.0 (MIT)
FFmpeg 8.1.3, revision 29e619e767: https://github.com/FFmpeg/FFmpeg/tree/29e619e767 (GPL build, including libx264)
FFmpeg build configuration and dependency sources: https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-09-30-13-08
FFmpeg binary: $ffmpegUrl
Microsoft Visual C++ Redistributable: https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist (Microsoft license, embedded in the signed prerequisite installer)
License texts are in this directory. FFmpeg is invoked as a separate process.
"@ | Set-Content "$payload\licenses\THIRD-PARTY-NOTICES.txt" -Encoding UTF8

$hashes = @('node.exe', 'Nightlight.Service.exe', 'Nightlight.Tray.exe', 'Nightlight.ico', 'bin\ffmpeg.exe', 'bin\ffprobe.exe', 'bin\mediamtx.exe', 'redist\vc_redist.x64.exe') | ForEach-Object {
    $file = Join-Path $payload $_
    [pscustomobject]@{ file = $_; sha256 = (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$hashes | ConvertTo-Json | Set-Content "$payload\runtime-manifest.json" -Encoding ASCII
$version = (Get-Content "$repo\backend\package.json" -Raw | ConvertFrom-Json).version
& $compiler '/Qp' "/DAppVersion=$version" "/DPayloadDir=$payload" "/DOutputDir=$OutputDirectory" "$PSScriptRoot\installer.iss"
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed' }
$installer = Join-Path $OutputDirectory "Nightlight-$version-windows-x64-setup.exe"
"$((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($installer))" | Set-Content "$OutputDirectory\SHA256SUMS.txt" -Encoding ASCII
Write-Host "Built $installer"
