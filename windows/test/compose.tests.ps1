# Exercise the REAL Compose parser without needing a running Docker engine.
$ErrorActionPreference = 'Stop'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('nightlight-compose-' + [Guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $tempRoot
$envPath = Join-Path $tempRoot 'settings with spaces.env'
$composePath = Join-Path $PSScriptRoot '..\docker-compose.yml'

function Assert-Equal {
    param($Expected, $Actual)
    if ($Expected -cne $Actual) { throw "Expected '$Expected', got '$Actual'" }
}
function Get-Config {
    param([int] $HttpPort, [int] $UdpPort)
    Set-Content -LiteralPath $envPath -Encoding ASCII -Value @(
        'NIGHTLIGHT_HOST=192.168.1.50'
        "NIGHTLIGHT_HTTP_PORT=$HttpPort"
        "NIGHTLIGHT_WEBRTC_PORT=$UdpPort"
    )
    $json = & docker compose --project-name nightlight-windows --file $composePath --env-file $envPath config --format json
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose rejected the Windows configuration' }
    return ($json -join "`n" | ConvertFrom-Json)
}

try {
    foreach ($ports in @(@(4000, 8189), @(4080, 8190))) {
        $config = Get-Config -HttpPort $ports[0] -UdpPort $ports[1]
        $service = $config.services.nightlight
        Assert-Equal 'sauso/nightlight:latest' $service.image
        Assert-Equal 'unless-stopped' $service.restart
        Assert-Equal '30s' $service.stop_grace_period
        Assert-Equal '192.168.1.50,127.0.0.1' $service.environment.PUBLIC_HOST
        Assert-Equal '' $service.environment.STUN_SERVERS
        Assert-Equal '4000' $service.environment.PORT
        Assert-Equal ([string] $ports[1]) $service.environment.WEBRTC_UDP_PORT
        Assert-Equal 2 $service.ports.Count
        $http = @($service.ports | Where-Object { $_.protocol -eq 'tcp' })
        $udp = @($service.ports | Where-Object { $_.protocol -eq 'udp' })
        Assert-Equal 1 $http.Count
        Assert-Equal 1 $udp.Count
        Assert-Equal 4000 ([int] $http[0].target)
        Assert-Equal $ports[0] ([int] $http[0].published)
        Assert-Equal $ports[1] ([int] $udp[0].target)
        Assert-Equal $ports[1] ([int] $udp[0].published)
        Assert-Equal 'volume' $service.volumes[0].type
        Assert-Equal '/app/data' $service.volumes[0].target
        Assert-Equal 'nightlight-windows_data' $config.volumes.data.name
        Write-Host "PASS: real Compose config (HTTP $($ports[0]), UDP $($ports[1]))"
    }
    # A missing host must not silently produce a setup where the page loads but
    # every phone's WebRTC connection uses unreachable container addresses.
    Set-Content -LiteralPath $envPath -Encoding ASCII -Value 'NIGHTLIGHT_HOST='
    $ErrorActionPreference = 'Continue'
    $output = & docker compose --project-name nightlight-windows --file $composePath --env-file $envPath config --format json 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -eq 0) { throw 'Compose accepted an empty LAN address' }
    Write-Host 'PASS: Compose rejects an empty LAN address'
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
}
