<#
.SYNOPSIS
    Test support: deliver a WM_HOTKEY to the daemon of a given process id.

.DESCRIPTION
    The daemon's capture handler is driven by a real WM_HOTKEY that Windows posts
    when the user presses the registered combo. A test cannot press a real
    hotkey, but it can post the identical message to the daemon's own hidden
    window - which exercises exactly the same WndProc path, without needing an
    interactive desktop or a human.

    Prints "pressed <hwnd>" on success and exits non-zero when the process has no
    enumerable window (the daemon failed to create its message window).

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\support\press-hotkey.ps1 -ProcessId 1234
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$HotkeyId = 1
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class HotkeyPress
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    public static List<IntPtr> WindowsOf(int pid)
    {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindowsProc callback = delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint windowPid;
            GetWindowThreadProcessId(hWnd, out windowPid);
            if ((int)windowPid == pid) found.Add(hWnd);
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        return found;
    }

    public static string ClassOf(IntPtr hWnd)
    {
        StringBuilder buffer = new StringBuilder(256);
        GetClassNameW(hWnd, buffer, 256);
        return buffer.ToString();
    }

    /// <summary>Post the WM_HOTKEY Windows would post for the registered id.</summary>
    public static bool Send(IntPtr hWnd, int hotkeyId)
    {
        const uint WM_HOTKEY = 0x0312;
        return PostMessageW(hWnd, WM_HOTKEY, new IntPtr(hotkeyId), IntPtr.Zero);
    }
}
'@

if (-not ('HotkeyPress' -as [type])) {
    Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies System.dll -ErrorAction Stop | Out-Null
}

$windows = [HotkeyPress]::WindowsOf($ProcessId)
if ($windows.Count -eq 0) {
    Write-Error "no window found for process $ProcessId"
    exit 1
}

# Post to every top-level window of the process, not just the first one: a
# PowerShell daemon also owns an (invisible) console window, and a message
# accepted there would never reach the WinForms WndProc that handles the hotkey.
$delivered = 0
foreach ($handle in $windows) {
    $className = [HotkeyPress]::ClassOf($handle)
    if ([HotkeyPress]::Send($handle, $HotkeyId)) {
        Write-Host "posted to $($handle.ToInt64()) class=$className"
        $delivered++
    }
}

if ($delivered -eq 0) {
    Write-Error 'wm_hotkey could not be posted to any window of the process'
    exit 1
}

exit 0
