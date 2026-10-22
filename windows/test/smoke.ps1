# Run ONLY on an ephemeral GitHub Windows runner. This exercises the real .exe,
# service account, bundled runtimes, RTSP/HLS pipeline and recording filesystem.
[CmdletBinding()]
param([Parameter(Mandatory)] [string] $Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This installation test is only for disposable GitHub Actions runners.' }
$dataDir = Join-Path $env:ProgramData 'Nightlight'
if (Test-Path $dataDir) { throw 'Refusing to touch an existing Nightlight data directory.' }
$installDir = Join-Path $env:RUNNER_TEMP 'Nightlight installed with spaces'
$base = 'http://127.0.0.1:4000'
$script:Headers = @{}
$source = $null
$publisher = $null

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw $Message }
}
function Wait-Until {
    param([scriptblock] $Check, [string] $Description, [int] $Seconds = 90)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        try { if (& $Check) { return } } catch { $lastFailure = $_.Exception.Message }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $Description. $lastFailure"
}
function Api {
    param([string] $Path, [string] $Method = 'GET', $Body = $null)
    $params = @{ Uri = "$base$Path"; Method = $Method; Headers = $script:Headers; TimeoutSec = 90 }
    if ($null -ne $Body) { $params.Body = ConvertTo-Json -InputObject $Body; $params.ContentType = 'application/json' }
    Invoke-RestMethod @params
}
function Install-Native {
    $process = Start-Process $Installer -Wait -PassThru -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$installDir`"",
        '/TASKS="lan"', "/LOG=`"$env:RUNNER_TEMP\nightlight-install.log`""
    )
    Assert-True ($process.ExitCode -eq 0) "Installer exited $($process.ExitCode)"
    Wait-Until { (Invoke-WebRequest -UseBasicParsing "$base/api/health" -TimeoutSec 2).StatusCode -eq 200 } 'Nightlight health'
    $service = Get-CimInstance Win32_Service -Filter "Name='Nightlight'"
    Assert-True ($service.State -eq 'Running') 'Service is not running'
    Assert-True ($service.StartMode -eq 'Auto') 'Service will not start at boot'
    Assert-True ($service.StartName -match 'LocalService$') 'Service is running with an unexpected account'
    # Exercise the real media-server defaults, not just the template text. A new
    # upstream protocol must not silently add public listeners to this bundle.
    $script:MediaProcess = $null
    Wait-Until {
        $script:MediaProcess = Get-CimInstance Win32_Process -Filter "Name='mediamtx.exe'" | Where-Object { $_.ExecutablePath -eq "$installDir\bin\mediamtx.exe" } | Select-Object -First 1
        $script:MediaProcess -and @(Get-NetUDPEndpoint -OwningProcess $script:MediaProcess.ProcessId -ErrorAction SilentlyContinue).Count -ge 1
    } 'the media server listener'
    $tcp = @(Get-NetTCPConnection -OwningProcess $script:MediaProcess.ProcessId -State Listen -ErrorAction SilentlyContinue)
    $udp = @(Get-NetUDPEndpoint -OwningProcess $script:MediaProcess.ProcessId)
    Assert-True (@($tcp | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count -eq 0) 'An internal media TCP listener is exposed on the network'
    Assert-True (@($udp | Where-Object { $_.LocalPort -ne 8189 }).Count -eq 0) 'Unused UDP media listeners are open'
}
function Uninstall-Native {
    $uninstaller = Join-Path $installDir 'unins000.exe'
    if (Test-Path $uninstaller) {
        $process = Start-Process $uninstaller -Wait -PassThru -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
        Assert-True ($process.ExitCode -eq 0) 'Uninstaller failed'
        Wait-Until { -not (Get-Service Nightlight -ErrorAction SilentlyContinue) } 'service removal' -Seconds 30
    }
}

try {
    Install-Native
    Assert-True ((Invoke-WebRequest -UseBasicParsing $base).Content -match 'id="root"') 'Built frontend was not served'
    $account = Api '/api/auth/setup' 'POST' @{ username = 'native-test-admin'; password = [Guid]::NewGuid().ToString() }
    $script:Headers = @{ Authorization = "Bearer $($account.token)" }
    $child = Api '/api/children' 'POST' @{ name = 'Test child'; track_sleep = $false }

    # A separate RTSP server stands in for a camera. Its ports do not overlap
    # Nightlight's bundled MediaMTX. No LAN camera or household data is used.
    $sourceConfig = Join-Path $env:RUNNER_TEMP 'nightlight-source.yml'
    @"
rtsp: yes
rtspAddress: 127.0.0.1:18554
rtspTransports: [tcp]
api: no
webrtc: no
hls: no
rtmp: no
srt: no
moq: no
paths:
  synthetic:
    source: publisher
"@ | Set-Content $sourceConfig -Encoding ASCII
    $source = Start-Process "$installDir\bin\mediamtx.exe" -ArgumentList "`"$sourceConfig`"" -PassThru -RedirectStandardOutput "$env:RUNNER_TEMP\nightlight-source-out.log" -RedirectStandardError "$env:RUNNER_TEMP\nightlight-source-err.log"
    Start-Sleep -Seconds 2
    $source.Refresh()
    if ($source.HasExited) {
        throw "Synthetic RTSP source exited: $(Get-Content "$env:RUNNER_TEMP\nightlight-source-out.log" -Raw) $(Get-Content "$env:RUNNER_TEMP\nightlight-source-err.log" -Raw)"
    }
    $publisher = Start-Process "$installDir\bin\ffmpeg.exe" -PassThru -RedirectStandardOutput "$env:RUNNER_TEMP\nightlight-publisher-out.log" -RedirectStandardError "$env:RUNNER_TEMP\nightlight-publisher-err.log" -ArgumentList @(
        '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '10', '-bf', '0',
        '-c:a', 'aac', '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://127.0.0.1:18554/synthetic'
    )
    Wait-Until {
        $probe = & "$installDir\bin\ffprobe.exe" -v error -timeout 2000000 -rtsp_transport tcp -show_entries stream=codec_type -of json rtsp://127.0.0.1:18554/synthetic 2>$null
        $LASTEXITCODE -eq 0 -and ($probe -join '') -match 'video'
    } 'the synthetic camera stream' -Seconds 30
    $camera = Api '/api/cameras' 'POST' @{
        name = 'Synthetic camera'; rtsp_host = '127.0.0.1'; rtsp_port = 18554; rtsp_path = '/synthetic'; child_id = $child.id
    }
    Wait-Until {
        $current = @(Api '/api/cameras') | Where-Object { $_.id -eq $camera.id }
        $current.status.ready -and $current.can_record
    } 'camera readiness and recording buffer'
    $snapshot = Invoke-WebRequest -UseBasicParsing "$base/api/cameras/$($camera.id)/snapshot" -Headers $script:Headers -TimeoutSec 30
    Assert-True ($snapshot.RawContentLength -gt 500) 'No decoded snapshot was returned'
    # Match the browser player: HLS uses a short-lived media token in the URL,
    # including when redirects/segment requests cannot carry a session header.
    $media = Api '/api/auth/media-token' 'POST'
    $hlsUrl = "$base/hls/$($camera.mediamtx_path)-hls/index.m3u8?token=$([Uri]::EscapeDataString($media.token))"
    Wait-Until {
        (Invoke-WebRequest -UseBasicParsing $hlsUrl -TimeoutSec 10).Content -match '#EXTM3U'
    } 'the HLS playlist'

    $null = Api "/api/cameras/$($camera.id)/record/start" 'POST'
    Start-Sleep -Seconds 7
    $finished = Api "/api/cameras/$($camera.id)/record/stop" 'POST'
    $video = Invoke-WebRequest -UseBasicParsing "$base/api/recordings/$($finished.recording_id)/video" -Headers $script:Headers -TimeoutSec 30
    Assert-True ($video.RawContentLength -gt 1000) 'The native recording did not produce a video'
    Write-Host 'PASS: service, frontend, native RTSP input, decoded snapshot, HLS and recording'

    # Stop with an active recording: this fails if the wrapper force-kills Node
    # instead of allowing its SIGINT handler to finish the clip.
    $null = Api "/api/cameras/$($camera.id)/record/start" 'POST'
    Start-Sleep -Seconds 7
    Stop-Service Nightlight
    Wait-Until { (Get-Service Nightlight).Status -eq 'Stopped' } 'graceful service stop' -Seconds 40
    Start-Service Nightlight
    Wait-Until { (Invoke-WebRequest -UseBasicParsing "$base/api/health" -TimeoutSec 2).StatusCode -eq 200 } 'service restart'
    $recordings = @(Api "/api/recordings/child/$($child.id)")
    Assert-True ($recordings.Count -ge 2) 'Shutdown lost the active recording'
    Assert-True (@($recordings | Where-Object { $_.status -ne 'ready' }).Count -eq 0) 'Shutdown left a failed recording'
    Write-Host 'PASS: service shutdown finishes an in-flight recording'

    # These fixture processes borrow the installed binaries. Release their file
    # handles before upgrading so only the real service owns application files.
    Stop-Process -Id $publisher.Id, $source.Id -Force -ErrorAction SilentlyContinue
    $publisher = $null
    $source = $null
    Install-Native
    Assert-True (@(Api '/api/cameras').Count -eq 1) 'Upgrade lost camera settings'
    Assert-True (@(Api "/api/recordings/child/$($child.id)").Count -ge 2) 'Upgrade lost recordings'
    Write-Host 'PASS: upgrade preserves authentication, cameras and recordings'
    Uninstall-Native
    Assert-True (Test-Path "$dataDir\babymonitor.db") 'Uninstall deleted the database'
    Assert-True (@(Get-ChildItem "$dataDir\clips" -Filter '*.mp4' -Recurse).Count -ge 2) 'Uninstall deleted recordings'
    Install-Native
    Assert-True (@(Api '/api/cameras').Count -eq 1) 'Reinstall did not reuse existing data'
    Write-Host 'PASS: uninstall keeps data and reinstall reuses it'
} finally {
    foreach ($process in @($publisher, $source)) {
        if ($process) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
    Uninstall-Native
}
