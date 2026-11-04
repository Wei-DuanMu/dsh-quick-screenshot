<#
.SYNOPSIS
    Resident JSON-Lines bridge between the DSH plugin and the Win32 capture core.

.DESCRIPTION
    One request per stdin line, one response per stdout line:

        -> {"id":"1","cmd":"list_windows","args":{...}}
        <- {"id":"1","ok":true,"data":{...}}
        <- {"id":"1","ok":false,"error":{"code":"...","message":"..."}}

    The process is long-lived on purpose. A cold start costs about a second
    (PowerShell startup plus the Add-Type compile of the P/Invoke layer) while a
    warm request takes tens of milliseconds, so the plugin keeps this process
    alive between captures instead of paying that cost per screenshot.

    Invariants:
    * stdout carries protocol frames and nothing else. Any other write would
      desynchronize the stream, so diagnostics never use Write-Host.
    * Responses are single-line compressed JSON with a depth high enough for
      nested target geometry.
    * Errors are reported as a code plus an English detail; the Node layer owns
      the localized wording.

    ASCII-only source, and PowerShell 5.1 syntax only: Windows PowerShell reads a
    .ps1 as ANSI unless it carries a UTF-8 BOM, and it has no ?? operator. Runtime
    data (window titles, paths) is unaffected because the console encodings are
    pinned to UTF-8 below.

.EXAMPLE
    '{"id":"1","cmd":"ping"}' | powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File host\helper.ps1
#>

[CmdletBinding()]
param(
    [string]$Root
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

if (-not $Root) {
    $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
. (Join-Path $Root 'host\screenshot-core.ps1')

$protocolVersion = 1

function Write-Frame {
    param([Parameter(Mandatory = $true)]$Payload)
    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Write-Ok {
    param($Id, $Data)
    Write-Frame ([ordered]@{ id = $Id; ok = $true; data = $Data })
}

function Write-ErrorFrame {
    param($Id, [string]$Code, [string]$Message)
    Write-Frame ([ordered]@{ id = $Id; ok = $false; error = [ordered]@{ code = $Code; message = $Message } })
}

function Get-Arg {
    <# Read one optional field from a ConvertFrom-Json object without assuming it exists. #>
    param($Bag, [string]$NameName, $Default)
    if ($null -eq $Bag) { return $Default }
    $property = $Bag.PSObject.Properties[$NameName]
    if ($null -eq $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Split-ErrorCode {
    <# Turn "CODE: detail" into its two parts; a bare message gets a generic code. #>
    param([string]$Message)
    $index = $Message.IndexOf(':')
    if ($index -gt 0 -and $index -lt 40) {
        $candidate = $Message.Substring(0, $index).Trim()
        if ($candidate -match '^[A-Z][A-Z0-9_]*$') {
            return [pscustomobject]@{ code = $candidate; message = $Message.Substring($index + 1).Trim() }
        }
    }
    return [pscustomobject]@{ code = 'HELPER_ERROR'; message = $Message }
}

function Invoke-HelperCommand {
    param([string]$Cmd, $RequestArgs)

    switch ($Cmd) {
        'ping' {
            Initialize-DshShot | Out-Null
            $geometry = Get-DshScreens
            return [ordered]@{
                protocol      = $protocolVersion
                powershell    = $PSVersionTable.PSVersion.ToString()
                edition       = $PSVersionTable.PSEdition
                apartment     = [string][System.Threading.Thread]::CurrentThread.GetApartmentState()
                dpiLevel      = Get-DshDpiLevel
                monitors      = @($geometry.monitors)
                virtualScreen = $geometry.virtualScreen
                pid           = $PID
            }
        }
        'list_windows' {
            $includeMinimized = [bool](Get-Arg $RequestArgs 'includeMinimized' $false)
            $includeUntitled = [bool](Get-Arg $RequestArgs 'includeUntitled' $false)
            $windows = Get-DshWindows -IncludeMinimized:$includeMinimized -IncludeUntitled:$includeUntitled
            return [ordered]@{
                activeId = Get-DshForegroundWindowId
                windows  = @($windows)
            }
        }
        'capture' {
            $path = Get-Arg $RequestArgs 'path' $null
            $target = Get-Arg $RequestArgs 'target' $null
            if (-not $path) { throw 'BAD_REQUEST: capture requires a path' }
            if (-not $target) { throw 'BAD_REQUEST: capture requires a target' }

            $result = Save-DshCapture -Target $target `
                -Path ([string]$path) `
                -Format ([string](Get-Arg $RequestArgs 'format' 'png')) `
                -JpegQuality ([int](Get-Arg $RequestArgs 'jpegQuality' 90)) `
                -MaxWidth ([int](Get-Arg $RequestArgs 'maxWidth' 0)) `
                -Prefer ([string](Get-Arg $RequestArgs 'prefer' 'auto')) `
                -Clipboard:([bool](Get-Arg $RequestArgs 'clipboard' $false))
            return [ordered]@{ capture = $result }
        }
        'clipboard_from_file' {
            $path = Get-Arg $RequestArgs 'path' $null
            if (-not $path) { throw 'BAD_REQUEST: clipboard_from_file requires a path' }
            $image = [System.Drawing.Image]::FromFile([string]$path)
            try {
                $written = [DshShot.Win32]::CopyToClipboard($image)
            }
            finally {
                $image.Dispose()
            }
            if (-not $written) { throw 'CLIPBOARD_BUSY: another process kept the clipboard locked' }
            return [ordered]@{ written = $true }
        }
        'window_geometry' {
            $handle = Get-Arg $RequestArgs 'handle' $null
            if (-not $handle) { throw 'BAD_REQUEST: window_geometry requires a handle' }
            $geometry = Get-DshWindowGeometry -Handle ([long]$handle)
            if ($null -eq $geometry) { throw "WINDOW_NOT_FOUND: no capturable window with handle $handle" }
            return $geometry
        }
        'screens' {
            return (Get-DshScreens)
        }
        'cursor_monitor' {
            # Target fallback when no foreground window can be resolved, so a
            # capture never fails just because the desktop was mid-transition
            # (alt-tab, virtual-desktop switch, window destruction).
            $cursor = Get-DshCursorPosition
            if ($null -eq $cursor) { return [ordered]@{ index = -1; x = 0; y = 0 } }
            return [ordered]@{
                index = (Get-DshMonitorIndexAtPoint -X $cursor.x -Y $cursor.y)
                x     = $cursor.x
                y     = $cursor.y
            }
        }
        'select_region' {
            # Interactive selection: the caller is blocked until the user drags,
            # clicks a monitor or dismisses the overlay. Every other capture command
            # runs on a resolved rectangle; this is the only one that asks.
            $selection = Select-DshRegion
            if ($null -eq $selection) { throw 'SELECTION_CANCELLED: the selection overlay was dismissed' }
            try {
                $path = Get-Arg $RequestArgs 'path' $null
                if (-not $path) { throw 'BAD_REQUEST: select_region requires a path' }
                $result = Save-DshCapture -Bitmap $selection.image `
                    -Path ([string]$path) `
                    -Format ([string](Get-Arg $RequestArgs 'format' 'png')) `
                    -JpegQuality ([int](Get-Arg $RequestArgs 'jpegQuality' 90)) `
                    -MaxWidth ([int](Get-Arg $RequestArgs 'maxWidth' 0)) `
                    -Clipboard:([bool](Get-Arg $RequestArgs 'clipboard' $false))
            }
            finally {
                $selection.image.Dispose()
            }
            return [ordered]@{
                capture = $result
                region  = [ordered]@{
                    x            = $selection.x
                    y            = $selection.y
                    width        = $selection.width
                    height       = $selection.height
                    monitor      = $selection.monitor
                    wholeMonitor = $selection.wholeMonitor
                }
            }
        }
        'quit' {
            return [ordered]@{ bye = $true }
        }
        default {
            throw "UNKNOWN_COMMAND: no handler for '$Cmd'"
        }
    }
}

$running = $true
while ($running) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $request = $null
    try {
        $request = $line | ConvertFrom-Json
    }
    catch {
        Write-ErrorFrame -Id $null -Code 'BAD_JSON' -Message 'request line is not valid JSON'
        continue
    }

    $id = $request.id
    try {
        $data = Invoke-HelperCommand -Cmd ([string]$request.cmd) -RequestArgs $request.args
        Write-Ok -Id $id -Data $data
        if ([string]$request.cmd -eq 'quit') { $running = $false }
    }
    catch {
        $split = Split-ErrorCode -Message $_.Exception.Message
        Write-ErrorFrame -Id $id -Code $split.code -Message $split.message
    }
}

exit 0
