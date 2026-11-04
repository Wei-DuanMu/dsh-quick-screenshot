<#
.SYNOPSIS
    Self-check for dsh-quick-screenshot: verifies the Win32 capture layer works on
    this machine, without needing DSH or an agent turn.

.DESCRIPTION
    Run it when a capture fails, comes back blank, or the hotkey will not
    register. It prints the DPI awareness level, every monitor, the windows the
    plugin can currently see, and a real capture of the foreground window - so
    "it doesn't work" becomes a specific, reportable fact.

    ASCII-only on purpose: Windows PowerShell 5.1 reads a .ps1 as ANSI unless it
    has a UTF-8 BOM.

.EXAMPLE
    powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File scripts\doctor.ps1
#>

[CmdletBinding()]
param(
    [string]$OutFile,
    [switch]$NoCapture
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $root 'host\screenshot-core.ps1')

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host "== $Title ==" -ForegroundColor Cyan
}

Write-Section 'environment'
Write-Host "powershell : $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
Write-Host "os         : $([System.Environment]::OSVersion.VersionString)"
Write-Host "process    : $([System.Diagnostics.Process]::GetCurrentProcess().Id)"
Write-Host "apartment  : $([System.Threading.Thread]::CurrentThread.GetApartmentState())"
Write-Host "plugin     : $root"

Write-Section 'capture layer'
try {
    $check = Test-DshWindowsCapability
    Write-Host "dpi level  : $($check.dpiLevel)"
    Write-Host "monitors   : $($check.monitors)"
    Write-Host "windows    : $($check.windows)"
    Write-Host 'OK' -ForegroundColor Green
}
catch {
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Section 'monitors'
$geometry = Get-DshScreens
foreach ($monitor in $geometry.monitors) {
    $primary = if ($monitor.primary) { ' (primary)' } else { '' }
    Write-Host ("#{0} {1}{2}  {3}x{4} at {5},{6}" -f $monitor.index, $monitor.device, $primary, $monitor.width, $monitor.height, $monitor.x, $monitor.y)
}
Write-Host ("virtual desktop: {0}x{1} at {2},{3}" -f $geometry.virtualScreen.width, $geometry.virtualScreen.height, $geometry.virtualScreen.x, $geometry.virtualScreen.y)

Write-Section 'windows'
$windows = Get-DshWindows -IncludeMinimized
$activeId = Get-DshForegroundWindowId
foreach ($window in ($windows | Sort-Object -Property @{ Expression = 'active'; Descending = $true }, @{ Expression = 'title' })) {
    $marker = if ($window.active) { '*' } else { ' ' }
    Write-Host ("{0} [{1}] {2}x{3} @{4},{5} mon{6} {7}" -f $marker, $window.id, $window.width, $window.height, $window.x, $window.y, $window.monitor, $window.title)
}
Write-Host "total: $(@($windows).Count), foreground id: $activeId"

if ($NoCapture) { exit 0 }

Write-Section 'capture'
$target = $windows | Where-Object { $_.id -eq $activeId } | Select-Object -First 1
if (-not $target) { $target = $windows | Select-Object -First 1 }
if (-not $target) {
    Write-Host 'No window to capture.' -ForegroundColor Yellow
    exit 0
}

if (-not $OutFile) { $OutFile = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-quick-screenshot-doctor.png' }
$result = Save-DshCapture -Target ([pscustomobject]@{
        kind      = 'window'
        handle    = [long]$target.id
        x         = $target.x
        y         = $target.y
        width     = $target.width
        height    = $target.height
        minimized = $target.minimized
    }) -Path $OutFile

Write-Host "target     : $($target.title)"
Write-Host "file       : $($result.path)"
Write-Host "size       : $($result.width)x$($result.height)"
Write-Host "method     : $($result.method)"
Write-Host "elapsed    : $($result.elapsedMs) ms"
if ($result.blank) {
    Write-Host 'blank      : YES - this frame is a single flat colour' -ForegroundColor Red
    exit 2
}
Write-Host "distinct   : $($result.distinctColors) sampled colours (luminance $($result.minLuminance)..$($result.maxLuminance))"
Write-Host 'capture OK' -ForegroundColor Green
