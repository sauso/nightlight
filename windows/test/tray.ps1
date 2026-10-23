[CmdletBinding()]
param([Parameter(Mandatory)] [string] $PayloadDirectory, [string[]] $IconExecutables = @())
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testExe = Join-Path (Split-Path $PayloadDirectory -Parent) 'Nightlight.Tray.Tests.exe'
& $csc '/nologo' '/target:exe' '/platform:x64' '/main:Nightlight.Desktop.TrayTests' "/out:$testExe" '/reference:System.Windows.Forms.dll' '/reference:System.Drawing.dll' "$PSScriptRoot\..\Tray\Program.cs" "$PSScriptRoot\TrayTests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the tray tests.' }
& $testExe $PayloadDirectory @IconExecutables
if ($LASTEXITCODE -ne 0) { throw 'Nightlight tray tests failed.' }
