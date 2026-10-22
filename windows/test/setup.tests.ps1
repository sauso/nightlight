# No Pester/module installation needed. Run in Windows PowerShell 5.1 and pwsh.
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('nightlight-setup-' + [Guid]::NewGuid())
$originalAppData = $env:APPDATA
$originalLocalAppData = $env:LOCALAPPDATA
$env:APPDATA = Join-Path $testRoot 'Roaming'
$env:LOCALAPPDATA = Join-Path $testRoot 'Local'
$null = New-Item -ItemType Directory -Path $testRoot -Force
. (Join-Path $PSScriptRoot '..\Setup-Nightlight.ps1')

# Stub only the OS commands, so tests execute the real installer, Docker wrapper,
# file writes, argument construction, config preservation and failure handling.
function docker {
    $call = @($args | ForEach-Object { [string] $_ })
    $script:DockerCalls.Add($call)
    $global:LASTEXITCODE = 0
    if ($script:FailOn -and $call -contains $script:FailOn) {
        $global:LASTEXITCODE = 1
        return 'simulated Docker failure'
    }
    if ($call -contains 'info') { return $script:Engine }
    if ($call -contains 'version') { return 'Docker Compose version v2' }
}
function Get-NetIPConfiguration { return $script:Interfaces }
function Start-Process { $script:BrowserUrls.Add([string] $args[0]) }

function Assert-Equal {
    param($Expected, $Actual)
    $want = ConvertTo-Json -InputObject $Expected -Compress -Depth 10
    $got = ConvertTo-Json -InputObject $Actual -Compress -Depth 10
    if ($want -cne $got) { throw "Expected $want, got $got" }
}
function Assert-True {
    param([bool] $Value, [string] $Message)
    if (-not $Value) { throw $Message }
}
function Assert-Throws {
    param([scriptblock] $Operation, [string] $Pattern)
    $caught = $null
    try { & $Operation } catch { $caught = $_ }
    if (-not $caught) { throw "Expected an error matching $Pattern" }
    if ($caught.Exception.Message -notmatch $Pattern) { throw $caught }
}
function Get-ComposeCalls {
    # 'compose version' is a dependency check, not a container operation.
    $script:DockerCalls | Where-Object { $_ -contains '--project-name' }
}
function Assert-ComposeCall {
    param([int] $Index, [string[]] $Arguments)
    $calls = @(Get-ComposeCalls)
    Assert-Equal (@(
        '--context', 'desktop-linux', 'compose', '--project-name', 'nightlight-windows',
        '--file', (Join-Path $script:InstallPath 'docker-compose.yml'),
        '--env-file', (Join-Path $script:InstallPath 'nightlight.env')
    ) + $Arguments) $calls[$Index]
}
function Reset-TestState {
    $script:DockerCalls = New-Object 'System.Collections.Generic.List[object]'
    $script:BrowserUrls = New-Object 'System.Collections.Generic.List[string]'
    $script:FailOn = ''
    $script:Engine = 'linux'
    $script:Interfaces = @(
        [pscustomobject]@{
            IPv4DefaultGateway = 'gateway'; NetAdapter = [pscustomobject]@{ Status = 'Up' }
            IPv4Address = @([pscustomobject]@{ IPAddress = '192.168.1.50' })
        },
        [pscustomobject]@{
            IPv4DefaultGateway = $null; NetAdapter = [pscustomobject]@{ Status = 'Up' }
            IPv4Address = @([pscustomobject]@{ IPAddress = '172.20.0.1' })
        }
    )
    $script:InstallPath = Join-Path $testRoot ('User profile & spaces\' + [Guid]::NewGuid())
    $shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nightlight.url'
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
}
function Install-TestServer {
    Invoke-NightlightSetup -InstallDirectory $script:InstallPath -NoBrowser
}
function Test-Case {
    param([string] $Name, [scriptblock] $Operation)
    Reset-TestState
    & $Operation
    $script:Passed++
    Write-Host "PASS: $Name"
}

$script:Passed = 0
try {
    Test-Case 'chooses the active LAN adapter, excluding the VM adapter' {
        Assert-Equal '192.168.1.50' (Resolve-NightlightServerAddress)
    }
    Test-Case 'accepts an explicit LAN address' {
        Assert-Equal '10.0.0.25' (Resolve-NightlightServerAddress '10.0.0.25')
    }
    Test-Case 'rejects non-LAN addresses and env-file injection' {
        foreach ($address in @('127.0.0.1', '0.0.0.0', '169.254.1.2', '224.0.0.1', '255.255.255.255', '999.1.1.1', 'localhost', '::1', '1234', "192.168.1.50`nOTHER=value")) {
            Assert-Throws { Resolve-NightlightServerAddress $address } 'LAN IPv4'
        }
    }
    Test-Case 'ambiguous or missing LAN addresses fail before writing settings' {
        $script:Interfaces += [pscustomobject]@{
            IPv4DefaultGateway = 'vpn'; NetAdapter = [pscustomobject]@{ Status = 'Up' }
            IPv4Address = @([pscustomobject]@{ IPAddress = '10.0.0.20' })
        }
        Assert-Throws { Install-TestServer } 'Could not choose one LAN address'
        Assert-True (-not (Test-Path -LiteralPath $script:InstallPath)) 'An ambiguous install wrote files'
        $script:Interfaces = @()
        Assert-Throws { Resolve-NightlightServerAddress } 'Could not choose one LAN address'
    }
    Test-Case 'installs with explicit port mappings, a shortcut and a healthy-start wait' {
        Invoke-NightlightSetup -InstallDirectory $script:InstallPath -ServerAddress '10.0.0.25' -HttpPort 4080 -WebRtcPort 8190
        $settings = Get-Content -LiteralPath (Join-Path $script:InstallPath 'nightlight.env') -Raw | ConvertFrom-StringData
        Assert-Equal '10.0.0.25' $settings.NIGHTLIGHT_HOST
        Assert-Equal '4080' $settings.NIGHTLIGHT_HTTP_PORT
        Assert-Equal '8190' $settings.NIGHTLIGHT_WEBRTC_PORT
        Assert-Equal 2 @(Get-ComposeCalls).Count
        Assert-ComposeCall -Index 0 -Arguments @('pull')
        Assert-ComposeCall -Index 1 -Arguments @('up', '-d', '--wait', '--wait-timeout', '180')
        Assert-Equal 'http://localhost:4080' $script:BrowserUrls[0]
        $shortcut = Get-Content -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nightlight.url') -Raw
        Assert-True ($shortcut -match 'URL=http://localhost:4080') 'Shortcut URL was wrong'
        Assert-True (Test-Path -LiteralPath (Join-Path $script:InstallPath 'Setup-Nightlight.ps1')) 'Management script was not installed'
    }
    Test-Case 'a repeated install preserves settings and can resume a failed download' {
        $script:FailOn = 'pull'
        Assert-Throws { Install-TestServer } 'simulated Docker failure'
        Assert-Equal 1 @(Get-ComposeCalls).Count
        $saved = Get-Content -LiteralPath (Join-Path $script:InstallPath 'nightlight.env') -Raw
        $script:FailOn = ''
        Install-TestServer
        Assert-Equal $saved (Get-Content -LiteralPath (Join-Path $script:InstallPath 'nightlight.env') -Raw)
        Assert-Equal 0 $script:BrowserUrls.Count
    }
    Test-Case 'reinstall refuses to overwrite existing custom settings' {
        Install-TestServer
        $saved = Get-Content -LiteralPath (Join-Path $script:InstallPath 'nightlight.env') -Raw
        Assert-Throws { Invoke-NightlightSetup -InstallDirectory $script:InstallPath -ServerAddress '10.0.0.99' } 'saved settings have been kept'
        Assert-Equal $saved (Get-Content -LiteralPath (Join-Path $script:InstallPath 'nightlight.env') -Raw)
    }
    Test-Case 'start applies edited settings without pulling or stopping the container' {
        Install-TestServer
        $script:DockerCalls.Clear()
        $path = Join-Path $script:InstallPath 'nightlight.env'
        (Get-Content -LiteralPath $path -Raw).Replace('4000', '4081') | Set-Content -LiteralPath $path -Encoding ASCII
        Invoke-NightlightSetup -Action Start -InstallDirectory $script:InstallPath -NoBrowser
        Assert-Equal 1 @(Get-ComposeCalls).Count
        Assert-ComposeCall -Index 0 -Arguments @('up', '-d', '--wait', '--wait-timeout', '180')
        Assert-Equal 'http://localhost:4081' (Get-NightlightWebUrl $script:InstallPath)
    }
    Test-Case 'update pulls before recreating and preserves the config' {
        Install-TestServer
        $script:DockerCalls.Clear()
        $saved = Get-Content -LiteralPath (Join-Path $script:InstallPath 'nightlight.env') -Raw
        Invoke-NightlightSetup -Action Update -InstallDirectory $script:InstallPath -NoBrowser
        Assert-Equal 2 @(Get-ComposeCalls).Count
        Assert-ComposeCall -Index 0 -Arguments @('pull')
        Assert-ComposeCall -Index 1 -Arguments @('up', '-d', '--wait', '--wait-timeout', '180')
        Assert-Equal $saved (Get-Content -LiteralPath (Join-Path $script:InstallPath 'nightlight.env') -Raw)
    }
    Test-Case 'stop gives recordings time to finish' {
        Install-TestServer
        $script:DockerCalls.Clear()
        Invoke-NightlightSetup -Action Stop -InstallDirectory $script:InstallPath
        Assert-Equal 1 @(Get-ComposeCalls).Count
        Assert-ComposeCall -Index 0 -Arguments @('stop', '--timeout', '30')
    }
    Test-Case 'status only reads the current container state' {
        Install-TestServer
        $script:DockerCalls.Clear()
        Invoke-NightlightSetup -Action Status -InstallDirectory $script:InstallPath
        Assert-Equal 1 @(Get-ComposeCalls).Count
        Assert-ComposeCall -Index 0 -Arguments @('ps')
    }
    Test-Case 'uninstall retains the data volume and unrelated files' {
        Install-TestServer
        $script:DockerCalls.Clear()
        $notes = Join-Path $script:InstallPath 'my-notes.txt'
        Set-Content -LiteralPath $notes -Value 'keep this'
        Invoke-NightlightSetup -Action Uninstall -InstallDirectory $script:InstallPath
        Assert-Equal 1 @(Get-ComposeCalls).Count
        Assert-ComposeCall -Index 0 -Arguments @('down', '--timeout', '30')
        Assert-True (Test-Path -LiteralPath $notes) 'Uninstall deleted an unrelated file'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $script:InstallPath 'nightlight.env'))) 'Uninstall kept its settings'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nightlight.url'))) 'Uninstall kept its shortcut'
    }
    Test-Case 'a failed uninstall keeps the management files and shortcut' {
        Install-TestServer
        $script:FailOn = 'down'
        Assert-Throws { Invoke-NightlightSetup -Action Uninstall -InstallDirectory $script:InstallPath } 'Docker failed'
        Assert-True (Test-Path -LiteralPath (Join-Path $script:InstallPath 'nightlight.env')) 'Failed uninstall removed settings'
        Assert-True (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nightlight.url')) 'Failed uninstall removed shortcut'
    }
    Test-Case 'a Windows-container engine fails before writing anything' {
        $script:Engine = 'windows'
        Assert-Throws { Install-TestServer } 'Linux engine'
        Assert-Equal 0 @(Get-ComposeCalls).Count
        Assert-True (-not (Test-Path -LiteralPath $script:InstallPath)) 'Wrong-engine install wrote files'
    }
    Test-Case 'a stopped or missing Docker Desktop fails before any writes' {
        $script:FailOn = 'info'
        Assert-Throws { Install-TestServer } 'Start Docker Desktop'
        Assert-Equal 0 @(Get-ComposeCalls).Count
        Assert-True (-not (Test-Path -LiteralPath $script:InstallPath)) 'Failed engine check wrote files'
    }
    Test-Case 'a failed update pull never recreates the running container' {
        Install-TestServer
        $script:DockerCalls.Clear()
        $script:FailOn = 'pull'
        Assert-Throws { Invoke-NightlightSetup -Action Update -InstallDirectory $script:InstallPath } 'Docker failed'
        Assert-Equal 1 @(Get-ComposeCalls).Count
        Assert-ComposeCall -Index 0 -Arguments @('pull')
    }
    Test-Case 'an unhealthy start fails without opening the browser or adding a shortcut' {
        $script:FailOn = 'up'
        Assert-Throws { Invoke-NightlightSetup -InstallDirectory $script:InstallPath } 'Docker failed'
        Assert-Equal 0 $script:BrowserUrls.Count
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Nightlight.url'))) 'Failed start added a shortcut'
        Assert-True (Test-Path -LiteralPath (Join-Path $script:InstallPath 'nightlight.env')) 'Failed start lost its config'
    }
    Test-Case 'management commands reject an absent installation' {
        Assert-Throws { Invoke-NightlightSetup -Action Start -InstallDirectory $script:InstallPath } 'not installed'
        Assert-Equal 0 @(Get-ComposeCalls).Count
    }
    Test-Case 'ports are validated before touching Docker or the filesystem' {
        Assert-Throws { Invoke-NightlightSetup -HttpPort 0 -InstallDirectory $script:InstallPath } 'range'
        Assert-Throws { Invoke-NightlightSetup -WebRtcPort 65536 -InstallDirectory $script:InstallPath } 'range'
        Assert-Equal 0 $script:DockerCalls.Count
    }
    Write-Host "$script:Passed setup tests passed. Docker, network adapters and the browser were stubbed; real camera playback was not tested."
} finally {
    $env:APPDATA = $originalAppData
    $env:LOCALAPPDATA = $originalLocalAppData
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
