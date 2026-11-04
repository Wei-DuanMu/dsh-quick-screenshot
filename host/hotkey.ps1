<#
.SYNOPSIS
    Global-hotkey capture daemon for dsh-quick-screenshot.

.DESCRIPTION
    Registers one system-wide hotkey and, on every press, captures the window the
    user is looking at, writes it into the archive folder, copies it to the
    clipboard, and records the result. It runs independently of DSH on purpose:
    the point of a hotkey is that it fires while DSH is behind other windows or
    not focused at all.

    Files it owns, all inside -StateDir:
        daemon.json      liveness + the registered combo (written once at start).
        events.ndjson    one JSON object per press, append-only, bounded on read
                         by the plugin rather than rewritten here.
        latest.json      the most recent successful capture, for target "latest".

    The combo is parsed and validated by the Node layer (one implementation,
    unit-tested) and arrives as an ordered candidate list of modifier bits plus
    virtual-key codes, so this script never re-implements keyboard notation.

    ASCII-only source and PowerShell 5.1 syntax only, for the same reason as the
    other host scripts.

.PARAMETER CombosFile
    Path to an ordered JSON array of candidates: [{"combo":"Ctrl+Alt+A","mods":3,"vk":65}, ...].
    A file rather than an inline argument on purpose: a JSON array carries
    double quotes, and every Windows caller quotes command-line arguments
    slightly differently, so passing it inline is a bug waiting for the second
    caller. The script registers the first candidate Windows actually accepts,
    so a machine where another app already owns the preferred combo still gets a
    working hotkey instead of a plugin that silently never fires.
.PARAMETER Requested
    The combo the user asked for, echoed into daemon.json so status can answer
    "you asked for X, this machine gave you Y".
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$CombosFile,
    [string]$Requested = '',
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$StateDir
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Drawing -ErrorAction Stop
Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop

. (Join-Path $Root 'host\screenshot-core.ps1')

$daemonPath = Join-Path $StateDir 'daemon.json'
$eventsPath = Join-Path $StateDir 'events.ndjson'
$latestPath = Join-Path $StateDir 'latest.json'

if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
}

$hotkeySource = @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DshHotkey
{
    /// <summary>Hidden window that owns the hotkey registration and its message pump.</summary>
    public class HotkeyWindow : Form
    {
        public const int WM_HOTKEY = 0x0312;
        public const uint MOD_ALT = 0x0001;
        public const uint MOD_CONTROL = 0x0002;
        public const uint MOD_SHIFT = 0x0004;
        public const uint MOD_WIN = 0x0008;
        public const uint MOD_NOREPEAT = 0x4000;

        public int HotkeyId = 1;
        public event EventHandler Pressed;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        public HotkeyWindow()
        {
            this.ShowInTaskbar = false;
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.Manual;
            this.Size = new System.Drawing.Size(1, 1);
            this.Text = "dsh-quick-screenshot";
            this.Opacity = 0;
            this.Visible = false;
        }

        /// <summary>Force handle creation, then register; false means the combo is probably taken.</summary>
        public int TryRegister(uint mods, uint vk)
        {
            IntPtr handle = this.Handle;
            bool ok = RegisterHotKey(handle, this.HotkeyId, mods | MOD_NOREPEAT, vk);
            if (ok) return 0;
            return Marshal.GetLastWin32Error();
        }

        public void Release()
        {
            try { UnregisterHotKey(this.Handle, this.HotkeyId); }
            catch (Exception) { }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == this.HotkeyId)
            {
                EventHandler handler = this.Pressed;
                if (handler != null) handler(this, EventArgs.Empty);
            }
            base.WndProc(ref m);
        }
    }
}
'@

if (-not ('DshHotkey.HotkeyWindow' -as [type])) {
    Add-Type -TypeDefinition $hotkeySource -Language CSharp -ReferencedAssemblies System.dll, System.Drawing.dll, System.Windows.Forms.dll -ErrorAction Stop | Out-Null
}

function Write-DaemonState {
    param([hashtable]$State)
    $json = $State | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::WriteAllText($daemonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-CaptureConfig {
    <# Re-read on every press so the plugin can retarget the archive without a restart. #>
    $defaults = [ordered]@{
        archiveDir  = $StateDir
        format      = 'png'
        jpegQuality = 90
        maxWidth    = 0
        clipboard   = $true
        showBalloon = $true
        captureMode = 'active'
    }
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $defaults }
    try {
        $raw = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
        $parsed = $raw | ConvertFrom-Json
    }
    catch {
        return $defaults
    }
    foreach ($name in @($defaults.Keys)) {
        $property = $parsed.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) { $defaults[$name] = $property.Value }
    }
    return $defaults
}

function Get-SafeFileName {
    param([string]$Text, [int]$MaxLength = 40)
    if ([string]::IsNullOrWhiteSpace($Text)) { return 'capture' }
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    $builder = New-Object System.Text.StringBuilder
    foreach ($character in $Text.ToCharArray()) {
        if ($invalid -contains $character -or [int]$character -lt 32) { continue }
        if ($character -eq ' ') { [void]$builder.Append('_'); continue }
        [void]$builder.Append($character)
    }
    $cleaned = $builder.ToString().Trim('_', '.')
    if ($cleaned.Length -eq 0) { return 'capture' }
    if ($cleaned.Length -gt $MaxLength) { $cleaned = $cleaned.Substring(0, $MaxLength) }
    return $cleaned
}

function Add-DaemonEvent {
    param([hashtable]$Event)
    $line = $Event | ConvertTo-Json -Depth 8 -Compress
    try {
        [System.IO.File]::AppendAllText($eventsPath, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    }
    catch {
        # An unwritable log must never break the capture that already succeeded.
    }
}

$script:notify = $null
function Show-CaptureBalloon {
    param([string]$Text, [bool]$Failure = $false)
    try {
        if ($null -eq $script:notify) {
            $script:notify = New-Object System.Windows.Forms.NotifyIcon
            $script:notify.Icon = [System.Drawing.SystemIcons]::Information
            $script:notify.Text = 'dsh-quick-screenshot'
            $script:notify.Visible = $true
        }
        $script:notify.BalloonTipTitle = if ($Failure) { 'Capture failed' } else { 'Captured' }
        $script:notify.BalloonTipText = $Text
        $script:notify.BalloonTipIcon = if ($Failure) { [System.Windows.Forms.ToolTipIcon]::Error } else { [System.Windows.Forms.ToolTipIcon]::Info }
        $script:notify.ShowBalloonTip(2000)
    }
    catch {
        # Notification is a nicety; losing it is not a capture failure.
    }
}

function Invoke-HotkeyCapture {
    $config = Read-CaptureConfig
    $started = Get-Date
    try {
        Initialize-DshShot | Out-Null

        $mode = [string]$config['captureMode']
        $windows = Get-DshWindows -IncludeMinimized
        $foregroundId = Get-DshForegroundWindowId
        $target = $null
        $label = 'screen'
        $windowInfo = $null

        if ($mode -eq 'active') {
            # The enumerated record carries the title for the file name, but the
            # capture target needs explicit geometry and a kind: an untitled
            # window is still capturable even though enumeration skips it.
            $enumerated = @($windows | Where-Object { $_.id -eq $foregroundId }) | Select-Object -First 1
            $geometry = Get-DshWindowGeometry -Handle ([long]$foregroundId)
            if ($null -eq $geometry) {
                throw 'FOREGROUND_WINDOW_UNKNOWN: the foreground window has no readable geometry (try captureMode monitor)'
            }
            $target = [pscustomobject]@{
                kind      = 'window'
                handle    = [long]$geometry.id
                x         = $geometry.x
                y         = $geometry.y
                width     = $geometry.width
                height    = $geometry.height
                minimized = $geometry.minimized
            }
            if ($null -ne $enumerated) {
                $label = $enumerated.title
                $windowInfo = [ordered]@{ id = $enumerated.id; title = $enumerated.title; process = $enumerated.process }
            }
            else {
                $label = 'window'
                $windowInfo = [ordered]@{ id = $geometry.id; title = ''; process = '' }
            }
        }
        elseif ($mode -eq 'monitor') {
            $active = @($windows | Where-Object { $_.id -eq $foregroundId }) | Select-Object -First 1
            $monitorIndex = 0
            if ($null -ne $active -and [int]$active.monitor -ge 0) { $monitorIndex = [int]$active.monitor }
            $target = [pscustomobject]@{ kind = 'monitor'; index = $monitorIndex }
            $label = "monitor $monitorIndex"
        }
        else {
            $target = [pscustomobject]@{ kind = 'screen' }
            $label = 'virtual desktop'
        }

        $extension = 'png'
        if ([string]$config['format'] -eq 'jpeg') { $extension = 'jpg' }
        $stamp = $started.ToString('yyyyMMdd_HHmmss')
        $fileName = '{0}_{1}.{2}' -f $stamp, (Get-SafeFileName -Text $label), $extension
        $path = Join-Path ([string]$config['archiveDir']) $fileName

        $result = Save-DshCapture -Target $target -Path $path `
            -Format ([string]$config['format']) `
            -JpegQuality ([int]$config['jpegQuality']) `
            -MaxWidth ([int]$config['maxWidth']) `
            -Clipboard:([bool]$config['clipboard'])

        $record = [ordered]@{
            ts        = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            ok        = $true
            path      = $result.path
            width     = $result.width
            height    = $result.height
            method    = $result.method
            blank     = [bool]$result.blank
            clipboard = [bool]$result.clipboardWritten
            mode      = $mode
            window    = $windowInfo
            elapsedMs = $result.elapsedMs
        }
        [System.IO.File]::WriteAllText($latestPath, ($record | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
        Add-DaemonEvent $record

        if ([bool]$config['showBalloon']) {
            $note = '{0}x{1}  {2}' -f $result.width, $result.height, (Get-SafeFileName -Text $label -MaxLength 30)
            if ([bool]$result.blank) { $note = $note + '  (looks blank)' }
            Show-CaptureBalloon -Text $note -Failure ([bool]$result.blank)
        }
    }
    catch {
        $message = $_.Exception.Message
        $code = 'CAPTURE_FAILED'
        $index = $message.IndexOf(':')
        if ($index -gt 0 -and $index -lt 40) { $code = $message.Substring(0, $index).Trim() }
        $record = [ordered]@{
            ts        = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            ok        = $false
            code      = $code
            message   = $message
        }
        Add-DaemonEvent $record
        if ((Read-CaptureConfig)['showBalloon']) { Show-CaptureBalloon -Text $message -Failure $true }
    }
}

$candidates = @()
try {
    $rawCandidates = [System.IO.File]::ReadAllText($CombosFile, [System.Text.Encoding]::UTF8)
    $candidates = @($rawCandidates | ConvertFrom-Json)
}
catch {
    $candidates = @()
}
if ($candidates.Count -eq 0) {
    Write-DaemonState ([ordered]@{
            pid       = $PID
            ready     = $false
            requested = $Requested
            error     = [ordered]@{ code = 'BAD_REQUEST'; message = 'no hotkey candidates were supplied' }
            startedAt = (Get-Date).ToString('o')
        })
    exit 2
}

$window = New-Object DshHotkey.HotkeyWindow
$tried = @()
$chosen = $null

foreach ($candidate in $candidates) {
    $candidateMods = [int]$candidate.mods
    $candidateVk = [int]$candidate.vk
    $win32Error = $window.TryRegister([uint32]$candidateMods, [uint32]$candidateVk)
    $tried += [ordered]@{ combo = [string]$candidate.combo; mods = $candidateMods; vk = $candidateVk; win32 = $win32Error }
    if ($win32Error -eq 0) {
        $chosen = $candidate
        break
    }
}

if ($null -eq $chosen) {
    Write-DaemonState ([ordered]@{
            pid       = $PID
            ready     = $false
            requested = $Requested
            tried     = $tried
            error     = [ordered]@{ code = 'HOTKEY_REGISTER_FAILED'; win32 = 1409 }
            startedAt = (Get-Date).ToString('o')
        })
    exit 3
}

$chosenCombo = [string]$chosen.combo
Write-DaemonState ([ordered]@{
        pid       = $PID
        ready     = $true
        combo     = $chosenCombo
        requested = $Requested
        fellBack  = ($chosenCombo -ne $Requested)
        mods      = [int]$chosen.mods
        vk        = [int]$chosen.vk
        tried     = $tried
        script    = $MyInvocation.MyCommand.Path
        startedAt = (Get-Date).ToString('o')
        dpiLevel  = (Initialize-DshShot)
    })

$window.add_Pressed({ Invoke-HotkeyCapture })

try {
    [System.Windows.Forms.Application]::Run()
}
finally {
    $window.Release()
    if ($null -ne $script:notify) {
        try { $script:notify.Visible = $false; $script:notify.Dispose() } catch { }
    }
    Write-DaemonState ([ordered]@{
            pid       = $PID
            ready     = $false
            combo     = $chosenCombo
            requested = $Requested
            stoppedAt = (Get-Date).ToString('o')
        })
}

exit 0
