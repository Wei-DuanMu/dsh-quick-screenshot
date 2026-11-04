<#
.SYNOPSIS
    Win32 screenshot core for dsh-quick-screenshot.

.DESCRIPTION
    Dot-source this file to get window enumeration, DPI handling, screen capture,
    blank-frame detection, PNG/JPEG writing and clipboard image support.

    All user-facing text lives in the Node layer. This file is deliberately
    ASCII-only: Windows PowerShell 5.1 reads a .ps1 as ANSI unless it carries a
    UTF-8 BOM, so non-ASCII source here would corrupt into a parse error on a
    GBK host. Runtimes values (window titles, paths) still round-trip as UTF-8
    because the callers pin the console encoding.

    Errors are thrown as "CODE: english detail" and the Node layer turns the
    code into a localized message.

    Design notes encoded here:

    * DPI awareness is raised to per-monitor-v2 BEFORE any geometry is read.
      Without it Windows virtualizes coordinates, so a 150%-scaled window is
      reported (and captured) at 2/3 of its real pixels - blurry, and offset
      from every other tool on the machine.
    * PrintWindow is tried first because it still works for occluded windows,
      but it returns a blank frame for many Electron/DWM windows (measured on
      the DSH host itself). Every PrintWindow result is blank-checked and
      screen-copy of the same rectangle is the fallback. A blank frame is never
      returned as a success.
    * Nothing here writes to stdout. Both callers (helper.ps1 speaks a JSON
      line protocol on stdout, hotkey.ps1 writes an event log) own their own
      output channel, so a stray Write-Host would corrupt it.

    The C# is written to C# 5 so the Windows PowerShell 5.1 Add-Type compiler
    accepts it (no string interpolation, no expression-bodied members, no
    null-conditional operators).
#>

$script:DshShotReady = $false

function Initialize-DshShot {
    <#
    .SYNOPSIS
        Load the P/Invoke layer once and raise process DPI awareness.
    #>
    param()

    if ($script:DshShotReady) { return $script:DshShotDpi }

    # Load the assemblies behind the multi-monitor and clipboard calls even
    # when the C# layer is already compiled in this process.
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop

    if (-not ('DshShot.Win32' -as [type])) {
        $source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace DshShot
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO
    {
        public int Size;
        public int Flags;
        public IntPtr Cursor;
        public POINT Position;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ICONINFO
    {
        public bool IsIcon;
        public int XHotspot;
        public int YHotspot;
        public IntPtr MaskBitmap;
        public IntPtr ColorBitmap;
    }

    public class WinInfo
    {
        public long Handle;
        public string Title = "";
        public string Process = "";
        public int ProcId;
        public int X, Y, W, H;
        public bool Minimized;
        public bool Active;
        public bool Cloaked;
    }

    public static class Win32
    {
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const int DWMWA_CLOAKED = 14;
        public const uint PW_RENDERFULLCONTENT = 2;
        public const uint GA_ROOT = 2;
        public const uint DI_NORMAL = 3;
        public const int CURSOR_SHOWING = 1;

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT point);

        [DllImport("user32.dll")]
        public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

        [DllImport("user32.dll")]
        public static extern bool GetCursorInfo(ref CURSORINFO info);

        [DllImport("user32.dll")]
        public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);

        [DllImport("user32.dll")]
        public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr flicker, uint flags);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr handle);

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        public static extern int GetWindowLongW(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hWnd);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

        /// <summary>Raise DPI awareness, newest API first; returns the level that took effect.</summary>
        public static string EnableDpiAwareness()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch (Exception) { }
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-3))) return "per-monitor"; } catch (Exception) { }
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-2))) return "system"; } catch (Exception) { }
            try { if (SetProcessDPIAware()) return "system-legacy"; } catch (Exception) { }
            return "none";
        }

        /// <summary>Real on-screen frame bounds, excluding the invisible DWM resize border.</summary>
        public static bool TryExtendedFrameBounds(IntPtr hWnd, out RECT bounds)
        {
            RECT raw;
            bounds = new RECT();
            if (!GetWindowRect(hWnd, out raw)) return false;
            RECT ext;
            int hr = DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out ext, Marshal.SizeOf(typeof(RECT)));
            if (hr == 0 && ext.Right > ext.Left && ext.Bottom > ext.Top) { bounds = ext; return true; }
            bounds = raw;
            return true;
        }

        /// <summary>Enumerate top-level windows a screenshot tool would consider.</summary>
        public static List<WinInfo> ListWindows(bool includeUntitled, bool includeInvisible)
        {
            List<WinInfo> found = new List<WinInfo>();
            IntPtr foreground = GetForegroundWindow();
            int selfPid = Process.GetCurrentProcess().Id;
            Dictionary<int, string> processNames = new Dictionary<int, string>();

            EnumWindowsProc callback = delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!includeInvisible && !IsWindowVisible(hWnd)) return true;

                int exStyle = GetWindowLongW(hWnd, GWL_EXSTYLE);
                if ((exStyle & WS_EX_TOOLWINDOW) != 0) return true;

                StringBuilder buffer = new StringBuilder(1024);
                GetWindowTextW(hWnd, buffer, 1024);
                string title = buffer.ToString();
                if (!includeUntitled && title.Trim().Length == 0) return true;

                RECT bounds;
                if (!TryExtendedFrameBounds(hWnd, out bounds)) return true;

                int width = bounds.Right - bounds.Left;
                int height = bounds.Bottom - bounds.Top;
                if (width < 1 || height < 1) return true;

                int cloaked = 0;
                try { DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, 4); } catch (Exception) { cloaked = 0; }
                if (cloaked != 0) return true;

                uint procId = 0;
                GetWindowThreadProcessId(hWnd, out procId);
                int pid = (int)procId;

                string processName;
                if (!processNames.TryGetValue(pid, out processName))
                {
                    try
                    {
                        Process p = Process.GetProcessById(pid);
                        processName = p.ProcessName;
                    }
                    catch (Exception) { processName = pid == selfPid ? "self" : "unknown"; }
                    processNames[pid] = processName;
                }

                WinInfo info = new WinInfo();
                info.Handle = hWnd.ToInt64();
                info.Title = title;
                info.Process = processName;
                info.ProcId = pid;
                info.X = bounds.Left;
                info.Y = bounds.Top;
                info.W = width;
                info.H = height;
                info.Minimized = IsIconic(hWnd);
                info.Active = hWnd == foreground;
                info.Cloaked = cloaked != 0;
                found.Add(info);
                return true;
            };

            EnumWindows(callback, IntPtr.Zero);
            return found;
        }

        /// <summary>Bitmap of one screen rectangle, in physical pixels.</summary>
        public static Bitmap CaptureRect(int x, int y, int width, int height)
        {
            if (width < 1) width = 1;
            if (height < 1) height = 1;
            Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                // One bad rectangle must not fail the whole capture; the caller
                // blank-checks the result and reports honestly.
                try { g.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy); }
                catch (Exception) { }
            }
            return bitmap;
        }

        /// <summary>PrintWindow bitmap, or null when the window refuses it.</summary>
        public static Bitmap CaptureWindowPrint(IntPtr hWnd, int width, int height)
        {
            if (width < 1 || height < 1) return null;
            Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                IntPtr hdc = g.GetHdc();
                bool ok = false;
                try { ok = PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
                if (!ok) { bitmap.Dispose(); return null; }
            }
            return bitmap;
        }

        /// <summary>Top-level window under a physical screen point, or IntPtr.Zero.</summary>
        public static IntPtr RootWindowAtPoint(int x, int y)
        {
            POINT point;
            point.X = x;
            point.Y = y;
            IntPtr hit = WindowFromPoint(point);
            if (hit == IntPtr.Zero) return IntPtr.Zero;
            IntPtr root = GetAncestor(hit, GA_ROOT);
            return root == IntPtr.Zero ? hit : root;
        }

        /// <summary>
        /// Composite the live pointer onto a bitmap whose top-left corner sits at
        /// (originX, originY) on the virtual desktop. Returns false when there is
        /// no pointer to draw (hidden cursor, pointer outside the frame).
        /// </summary>
        public static bool DrawCursor(Bitmap bitmap, int originX, int originY)
        {
            CURSORINFO cursor = new CURSORINFO();
            cursor.Size = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref cursor)) return false;
            if ((cursor.Flags & CURSOR_SHOWING) == 0) return false;
            if (cursor.Cursor == IntPtr.Zero) return false;
            if (cursor.Position.X < originX || cursor.Position.Y < originY) return false;

            ICONINFO icon;
            if (!GetIconInfo(cursor.Cursor, out icon)) return false;
            try
            {
                int x = cursor.Position.X - originX - icon.XHotspot;
                int y = cursor.Position.Y - originY - icon.YHotspot;
                if (x <= -64 || y <= -64) return false;
                if (x >= bitmap.Width || y >= bitmap.Height) return false;
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    IntPtr hdc = graphics.GetHdc();
                    try { return DrawIconEx(hdc, x, y, cursor.Cursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL); }
                    finally { graphics.ReleaseHdc(hdc); }
                }
            }
            finally
            {
                if (icon.MaskBitmap != IntPtr.Zero) DeleteObject(icon.MaskBitmap);
                if (icon.ColorBitmap != IntPtr.Zero) DeleteObject(icon.ColorBitmap);
            }
        }

        /// <summary>Sample luminance spread so a black frame is never reported as success.</summary>
        public static int[] Statistics(Bitmap bitmap)
        {
            int width = bitmap.Width;
            int height = bitmap.Height;
            int step = Math.Max(1, Math.Min(width, height) / 64);
            int min = 255;
            int max = 0;
            HashSet<int> distinct = new HashSet<int>();
            for (int y = 0; y < height; y += step)
            {
                for (int x = 0; x < width; x += step)
                {
                    Color c = bitmap.GetPixel(x, y);
                    int luminance = (c.R * 299 + c.G * 587 + c.B * 114) / 1000;
                    if (luminance < min) min = luminance;
                    if (luminance > max) max = luminance;
                    if (distinct.Count < 32) distinct.Add((c.R << 16) | (c.G << 8) | c.B);
                }
            }
            return new int[] { distinct.Count, min, max };
        }

        /// <summary>A frame with one flat colour is treated as blank or failed.</summary>
        public static bool IsBlank(Bitmap bitmap)
        {
            return Statistics(bitmap)[0] <= 1;
        }

        /// <summary>Downscale when wider than the limit; returns the bitmap to save.</summary>
        public static Bitmap Fit(Bitmap bitmap, int maxWidth)
        {
            if (maxWidth <= 0 || bitmap.Width <= maxWidth) return bitmap;
            int width = maxWidth;
            int height = (int)Math.Round(bitmap.Height * (double)maxWidth / bitmap.Width);
            if (height < 1) height = 1;
            Bitmap scaled = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(scaled))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(bitmap, 0, 0, width, height);
            }
            return scaled;
        }

        /// <summary>Write PNG or JPEG by extension, with an explicit JPEG quality.</summary>
        public static void SaveImage(Bitmap bitmap, string path, int jpegQuality)
        {
            string lower = path.ToLowerInvariant();
            if (lower.EndsWith(".jpg") || lower.EndsWith(".jpeg"))
            {
                if (jpegQuality < 1) jpegQuality = 90;
                if (jpegQuality > 100) jpegQuality = 100;
                ImageCodecInfo codec = null;
                foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders())
                {
                    if (candidate.FormatID == ImageFormat.Jpeg.Guid) { codec = candidate; break; }
                }
                if (codec == null) { bitmap.Save(path, ImageFormat.Jpeg); return; }
                using (EncoderParameters parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)jpegQuality);
                    bitmap.Save(path, codec, parameters);
                }
                return;
            }
            bitmap.Save(path, ImageFormat.Png);
        }

        /// <summary>Clipboard image write; works only on an STA thread.</summary>
        public static bool CopyToClipboard(Bitmap bitmap)
        {
            for (int attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    System.Windows.Forms.Clipboard.SetImage(bitmap);
                    return true;
                }
                catch (Exception)
                {
                    // Another process holds the clipboard open; retry briefly.
                    System.Threading.Thread.Sleep(80);
                }
            }
            return false;
        }
    }
}
'@
        Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies System.dll, System.Drawing.dll, System.Windows.Forms.dll, System.Core.dll -ErrorAction Stop | Out-Null
    }

    $script:DshShotDpi = [DshShot.Win32]::EnableDpiAwareness()
    $script:DshShotReady = $true
    return $script:DshShotDpi
}

function Get-DshDpiLevel {
    <# .SYNOPSIS The DPI awareness level actually applied to this process. #>
    param()
    if (-not $script:DshShotReady) { return 'uninitialized' }
    return $script:DshShotDpi
}

function Get-DshScreens {
    <#
    .SYNOPSIS
        Physical bounds of every monitor, plus the virtual desktop rectangle.
    #>
    param()

    Initialize-DshShot | Out-Null

    $screens = @()
    $index = 0
    foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
        $bounds = $screen.Bounds
        $screens += [pscustomobject]@{
            index   = $index
            device  = $screen.DeviceName
            primary = [bool]$screen.Primary
            x       = $bounds.X
            y       = $bounds.Y
            width   = $bounds.Width
            height  = $bounds.Height
        }
        $index++
    }

    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    return [pscustomobject]@{
        monitors      = $screens
        virtualScreen = [pscustomobject]@{
            x      = $virtual.X
            y      = $virtual.Y
            width  = $virtual.Width
            height = $virtual.Height
        }
    }
}

function Get-DshWindows {
    <#
    .SYNOPSIS
        Visible top-level windows with real frame bounds and monitor assignment.
    .PARAMETER IncludeMinimized
        Keep minimized windows. They can only be captured through PrintWindow,
        and often come back blank.
    .PARAMETER IncludeUntitled
        Keep windows without a title (occasionally a fullscreen game).
    #>
    param(
        [switch]$IncludeMinimized,
        [switch]$IncludeUntitled
    )

    Initialize-DshShot | Out-Null
    $geometry = Get-DshScreens

    $windows = @()
    foreach ($info in [DshShot.Win32]::ListWindows([bool]$IncludeUntitled, $false)) {
        if ($info.Minimized -and -not $IncludeMinimized) { continue }

        # A window belongs to the monitor holding its centre: for a window that
        # spans two screens, that is where the user is actually looking.
        $centreX = $info.X + [int]($info.W / 2)
        $centreY = $info.Y + [int]($info.H / 2)
        $monitorIndex = -1
        foreach ($monitor in $geometry.monitors) {
            if ($centreX -ge $monitor.x -and $centreX -lt ($monitor.x + $monitor.width) -and
                $centreY -ge $monitor.y -and $centreY -lt ($monitor.y + $monitor.height)) {
                $monitorIndex = $monitor.index
                break
            }
        }

        $windows += [pscustomobject]@{
            id        = [string]$info.Handle
            title     = $info.Title
            process   = $info.Process
            pid       = $info.ProcId
            x         = $info.X
            y         = $info.Y
            width     = $info.W
            height    = $info.H
            minimized = [bool]$info.Minimized
            active    = [bool]$info.Active
            monitor   = $monitorIndex
        }
    }

    return , $windows
}

function Get-DshForegroundWindowId {
    <# .SYNOPSIS The window handle the user is currently looking at. #>
    param()
    Initialize-DshShot | Out-Null
    return [string]([DshShot.Win32]::GetForegroundWindow().ToInt64())
}

function Get-DshCursorPosition {
    <#
    .SYNOPSIS
        Where the mouse pointer is right now, or $null when it cannot be read.
    .DESCRIPTION
        Used as the fallback target when the foreground window is not resolvable:
        during an alt-tab or a desktop switch GetForegroundWindow can briefly
        return zero, and a hotkey press must still produce a screenshot.
    #>
    param()
    Initialize-DshShot | Out-Null
    $point = New-Object DshShot.POINT
    if (-not [DshShot.Win32]::GetCursorPos([ref]$point)) { return $null }
    return [pscustomobject]@{ x = $point.X; y = $point.Y }
}

function Get-DshMonitorIndexAtPoint {
    <# .SYNOPSIS Which monitor contains a physical screen point (-1 when none). #>
    param(
        [Parameter(Mandatory = $true)][int]$X,
        [Parameter(Mandatory = $true)][int]$Y
    )
    $geometry = Get-DshScreens
    foreach ($monitor in $geometry.monitors) {
        if ($X -ge $monitor.x -and $X -lt ($monitor.x + $monitor.width) -and
            $Y -ge $monitor.y -and $Y -lt ($monitor.y + $monitor.height)) {
            return [int]$monitor.index
        }
    }
    return -1
}

function Get-DshWindowAtPoint {
    <#
    .SYNOPSIS
        Top-level window under a screen point, or $null when nothing is there.
    .DESCRIPTION
        The "under the pointer" capture mode needs the window the pointer is
        over, which is not the foreground one. WindowFromPoint returns the child
        that owns the pixels; GetAncestor walks up to the frame the user thinks
        of as the window.
    #>
    param(
        [Parameter(Mandatory = $true)][int]$X,
        [Parameter(Mandatory = $true)][int]$Y
    )
    Initialize-DshShot | Out-Null
    $handle = [DshShot.Win32]::RootWindowAtPoint($X, $Y)
    if ($handle -eq [IntPtr]::Zero) { return $null }
    return [string]$handle.ToInt64()
}

function Get-DshMonitorIndexForWindow {
    <#
    .SYNOPSIS
        The monitor a window mostly sits on (-1 when the window is unknown).
    .DESCRIPTION
        Overlap is measured rather than asking the OS, so the answer is the
        monitor whose pixels the window actually covers - what "the screen this
        app is on" means to someone pressing a screenshot key.
    #>
    param([Parameter(Mandatory = $true)][long]$Handle)

    $geometry = Get-DshWindowGeometry -Handle $Handle
    if ($null -eq $geometry) { return -1 }

    $best = -1
    $bestArea = 0
    foreach ($monitor in (Get-DshScreens).monitors) {
        $left = [Math]::Max([int]$geometry.x, [int]$monitor.x)
        $top = [Math]::Max([int]$geometry.y, [int]$monitor.y)
        $right = [Math]::Min([int]$geometry.x + [int]$geometry.width, [int]$monitor.x + [int]$monitor.width)
        $bottom = [Math]::Min([int]$geometry.y + [int]$geometry.height, [int]$monitor.y + [int]$monitor.height)
        if ($right -le $left -or $bottom -le $top) { continue }
        $area = ($right - $left) * ($bottom - $top)
        if ($area -gt $bestArea) {
            $bestArea = $area
            $best = [int]$monitor.index
        }
    }
    return $best
}

function Get-DshWindowGeometry {    <#
    .SYNOPSIS
        Frame bounds for one window handle, without going through enumeration.
    .DESCRIPTION
        Used when the foreground window is not in the enumerated list - an
        untitled splash screen, a game, a window whose title is empty but which
        is still perfectly capturable. Returns $null for a dead handle.
    #>
    param([Parameter(Mandatory = $true)][long]$Handle)

    Initialize-DshShot | Out-Null
    $pointer = [IntPtr]$Handle
    if ($pointer -eq [IntPtr]::Zero) { return $null }

    $bounds = New-Object DshShot.RECT
    if (-not [DshShot.Win32]::TryExtendedFrameBounds($pointer, [ref]$bounds)) { return $null }

    $width = $bounds.Right - $bounds.Left
    $height = $bounds.Bottom - $bounds.Top
    if ($width -lt 1 -or $height -lt 1) { return $null }

    return [pscustomobject]@{
        id        = [string]$Handle
        x         = $bounds.Left
        y         = $bounds.Top
        width     = $width
        height    = $height
        minimized = [bool][DshShot.Win32]::IsIconic($pointer)
    }
}

function Set-DshWindowForeground {
    <# .SYNOPSIS Best-effort raise; Windows may refuse for a background process. #>
    param([Parameter(Mandatory = $true)][long]$Handle)
    Initialize-DshShot | Out-Null
    return [DshShot.Win32]::SetForegroundWindow([IntPtr]$Handle)
}

function Save-DshCapture {
    <#
    .SYNOPSIS
        Capture one resolved target, write the file, optionally copy to clipboard.
    .PARAMETER Target
        Resolved geometry: kind = window | region | screen | monitor.
          window  -> handle, x, y, width, height, minimized
          region  -> x, y, width, height
          screen  -> the whole virtual desktop
          monitor -> monitor index
    .PARAMETER Prefer
        auto   = PrintWindow, blank-check it, fall back to screen copy (default)
        screen = always read desktop pixels (fails for occluded windows)
        print  = PrintWindow only (works occluded, blank for some DWM windows)
    .PARAMETER IncludeCursor
        Composite the live mouse pointer into the frame. Desktop reads never
        contain the pointer, so this is the only way to show where it was.
    #>
    param(
        [Parameter(Mandatory = $true)]$Target,
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('png', 'jpeg')][string]$Format = 'png',
        [int]$JpegQuality = 90,
        [int]$MaxWidth = 0,
        [ValidateSet('auto', 'screen', 'print')][string]$Prefer = 'auto',
        [switch]$Clipboard,
        [switch]$IncludeCursor
    )

    Initialize-DshShot | Out-Null
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    if ($Format -eq 'jpeg' -and $Path -notmatch '\.(jpg|jpeg)$') { $Path = "$Path.jpg" }

    $bitmap = $null
    $method = ''
    $originX = 0
    $originY = 0

    switch ($Target.kind) {
        'window' {
            $handle = [IntPtr][long]$Target.handle
            $width = [int]$Target.width
            $height = [int]$Target.height
            $originX = [int]$Target.x
            $originY = [int]$Target.y

            if ($Target.minimized -and $Prefer -eq 'auto') {
                # A minimized window occupies no screen pixels at all, so screen
                # copy cannot work; PrintWindow is the only possibility.
                $bitmap = [DshShot.Win32]::CaptureWindowPrint($handle, $width, $height)
                $method = 'print'
                if ($null -eq $bitmap) {
                    throw 'WINDOW_MINIMIZED_UNCAPTURABLE: the window refuses PrintWindow while minimized'
                }
                if ([DshShot.Win32]::IsBlank($bitmap)) {
                    $bitmap.Dispose()
                    throw 'WINDOW_MINIMIZED_BLANK: minimized window returned a flat frame'
                }
            }
            elseif ($Prefer -eq 'screen') {
                $bitmap = [DshShot.Win32]::CaptureRect([int]$Target.x, [int]$Target.y, $width, $height)
                $method = 'screen'
            }
            elseif ($Prefer -eq 'print') {
                $bitmap = [DshShot.Win32]::CaptureWindowPrint($handle, $width, $height)
                $method = 'print'
                if ($null -eq $bitmap) { throw 'PRINTWINDOW_FAILED: the window refused PrintWindow' }
            }
            else {
                $printed = [DshShot.Win32]::CaptureWindowPrint($handle, $width, $height)
                if ($null -ne $printed) {
                    if (-not [DshShot.Win32]::IsBlank($printed)) {
                        $bitmap = $printed
                        $method = 'print'
                    }
                    else {
                        $printed.Dispose()
                    }
                }
                if ($null -eq $bitmap) {
                    $bitmap = [DshShot.Win32]::CaptureRect([int]$Target.x, [int]$Target.y, $width, $height)
                    $method = 'screen'
                }
            }
        }
        'region' {
            $originX = [int]$Target.x
            $originY = [int]$Target.y
            $bitmap = [DshShot.Win32]::CaptureRect([int]$Target.x, [int]$Target.y, [int]$Target.width, [int]$Target.height)
            $method = 'screen'
        }
        'screen' {
            $vs = (Get-DshScreens).virtualScreen
            $originX = [int]$vs.x
            $originY = [int]$vs.y
            $bitmap = [DshShot.Win32]::CaptureRect([int]$vs.x, [int]$vs.y, [int]$vs.width, [int]$vs.height)
            $method = 'screen'
        }
        'monitor' {
            $geometry = Get-DshScreens
            $wanted = [int]$Target.index
            $monitor = $geometry.monitors | Where-Object { $_.index -eq $wanted } | Select-Object -First 1
            if ($null -eq $monitor) {
                throw "MONITOR_NOT_FOUND: no monitor with index $wanted (this machine has $($geometry.monitors.Count))"
            }
            $originX = [int]$monitor.x
            $originY = [int]$monitor.y
            $bitmap = [DshShot.Win32]::CaptureRect([int]$monitor.x, [int]$monitor.y, [int]$monitor.width, [int]$monitor.height)
            $method = 'screen'
        }
        default { throw "BAD_TARGET: unknown capture target kind '$($Target.kind)'" }
    }

    if ($null -eq $bitmap) { throw 'CAPTURE_FAILED: no pixels were produced' }

    # The pointer is composited after the pixels are read: a desktop read never
    # contains it, and a PrintWindow frame never will either.
    $cursorDrawn = $false
    if ($IncludeCursor) {
        $cursorDrawn = [DshShot.Win32]::DrawCursor($bitmap, $originX, $originY)
    }

    $isBlank = [DshShot.Win32]::IsBlank($bitmap)
    $stats = [DshShot.Win32]::Statistics($bitmap)
    $outputWidth = $bitmap.Width
    $outputHeight = $bitmap.Height
    $clipboardWritten = $false

    if ($Clipboard) { $clipboardWritten = [DshShot.Win32]::CopyToClipboard($bitmap) }

    $saved = $bitmap
    try {
        if ($MaxWidth -gt 0) {
            $saved = [DshShot.Win32]::Fit($bitmap, $MaxWidth)
            $outputWidth = $saved.Width
            $outputHeight = $saved.Height
        }
        $directory = Split-Path -Parent $Path
        if ($directory -and -not (Test-Path -LiteralPath $directory)) {
            New-Item -ItemType Directory -Force -Path $directory | Out-Null
        }
        [DshShot.Win32]::SaveImage($saved, $Path, $JpegQuality)
    }
    finally {
        if ($null -ne $saved -and -not [object]::ReferenceEquals($saved, $bitmap)) { $saved.Dispose() }
        $bitmap.Dispose()
    }

    return [pscustomobject]@{
        path             = $Path
        width            = $outputWidth
        height           = $outputHeight
        method           = $method
        blank            = [bool]$isBlank
        distinctColors   = $stats[0]
        minLuminance     = $stats[1]
        maxLuminance     = $stats[2]
        clipboardWritten = [bool]$clipboardWritten
        cursor           = [bool]$cursorDrawn
        elapsedMs        = [int]$stopwatch.ElapsedMilliseconds
    }
}

function Test-DshWindowsCapability {
    <#
    .SYNOPSIS
        Self-check used by scripts/doctor.ps1 and the integration test.
    #>
    param()
    $dpi = Initialize-DshShot
    $screen = Get-DshScreens
    $windows = Get-DshWindows -IncludeMinimized
    return [pscustomobject]@{
        dpiLevel   = $dpi
        monitors   = @($screen.monitors).Count
        windows    = @($windows).Count
        powershell = $PSVersionTable.PSVersion.ToString()
        edition    = $PSVersionTable.PSEdition
        apartment  = [string][System.Threading.Thread]::CurrentThread.GetApartmentState()
    }
}
