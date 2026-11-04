<#
.SYNOPSIS
    Interactive region selection: dim the desktop, drag a rectangle, keep the pixels.

.DESCRIPTION
    Dot-sourced by screenshot-core.ps1 so the daemon, the helper and anything else
    that already loads the capture core can show the same selection UI.

    The design decision that matters: the desktop is photographed BEFORE the window
    appears, and the selection is cut out of that frozen snapshot. Two consequences,
    both wanted:

      * the overlay can never photograph itself - no "hide the window, wait a
        frame, hope it is gone" race, which is the bug every screenshot tool has;
      * what the user framed is exactly what they saw when they pressed the key,
        even if a window underneath keeps repainting.

    The window paints a pre-shaded copy for everything except the selection and
    blits the untouched snapshot inside it, so only the invalidated rectangle is
    redrawn per mouse move instead of a full virtual-desktop repaint.

    Everything here works in PHYSICAL pixels because the capture core enables
    per-monitor DPI awareness before this runs (a DPI-unaware process reports a
    2560x1600 monitor as 1707x1067). WPF was avoided for that reason: it would
    hand back device-independent units that have to be converted back per monitor.

    Controls: drag = select, click = the monitor under the pointer, right click or
    Esc = cancel. The size tag and the shaded area are painted on top of the
    snapshot, never into it.

    ASCII-only source and PowerShell 5.1 syntax, like the other host scripts: the
    selection UI carries no text of its own beyond the pixel size, so nothing here
    needs characters that Windows PowerShell would misread as ANSI.
#>

# Compiled once per process on first use: the Add-Type cost is paid by the user's
# first selection instead of by plugin startup, which must stay fast and cannot
# afford to fail here.
$script:DshOverlayReady = $false

function Select-DshRegion {
    <#
    .SYNOPSIS
        Let the user drag a rectangle over the current desktop.
    .DESCRIPTION
        Returns $null when the user cancels, otherwise a record whose `image` is a
        freshly allocated Bitmap the caller owns and must dispose.

        x/y are virtual-screen coordinates in physical pixels, so the record drops
        straight into a capture target of kind 'region'.
    .PARAMETER IdleTimeoutSeconds
        Dismiss the overlay after this long without any mouse activity, so a stray
        hotkey press can never leave a modal window trapping the daemon.
    #>
    param([int]$IdleTimeoutSeconds = 120)

    Initialize-DshShot | Out-Null

    if (-not $script:DshOverlayReady) {
        if (-not ('DshOverlay.RegionSelector' -as [type])) {
            Add-Type -TypeDefinition $script:DshOverlaySource -Language CSharp `
                -ReferencedAssemblies System.dll, System.Drawing.dll, System.Windows.Forms.dll, System.Core.dll `
                -ErrorAction Stop | Out-Null
        }
        $script:DshOverlayReady = $true
    }

    $geometry = Get-DshScreens
    $virtual = $geometry.virtualScreen

    # Photograph first, show the window second. See the file header.
    $snapshot = [DshShot.Win32]::CaptureRect([int]$virtual.x, [int]$virtual.y, [int]$virtual.width, [int]$virtual.height)
    if ($null -eq $snapshot) { throw 'OVERLAY_CAPTURE_FAILED: the desktop returned no pixels' }

    $selection = $null
    try {
        $selection = [DshOverlay.RegionSelector]::Pick($snapshot, [int]$virtual.x, [int]$virtual.y, [int]$IdleTimeoutSeconds)
    }
    finally {
        $snapshot.Dispose()
    }

    if ($null -eq $selection -or [bool]$selection.Cancelled) { return $null }

    $bounds = $selection.Bounds
    $centreX = $bounds.X + [int]($bounds.Width / 2)
    $centreY = $bounds.Y + [int]($bounds.Height / 2)

    return [pscustomobject]@{
        x           = $bounds.X
        y           = $bounds.Y
        width       = $bounds.Width
        height      = $bounds.Height
        monitor     = (Get-DshMonitorIndexAtPoint -X $centreX -Y $centreY)
        wholeMonitor = [bool]$selection.WholeMonitor
        image       = $selection.Image
    }
}

$script:DshOverlaySource = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace DshOverlay
{
    /// <summary>Outcome of one interactive selection; the caller owns Image.</summary>
    public sealed class Selection
    {
        public Bitmap Image;
        public Rectangle Bounds;
        public bool Cancelled;
        public bool WholeMonitor;
    }

    /// <summary>
    /// Full-virtual-desktop selection surface over a frozen snapshot of the screen.
    /// Static Pick() runs the modal loop and returns once the user decides.
    /// </summary>
    public sealed class RegionSelector : Form
    {
        private const int ShadeAlpha = 150;
        private const int BorderWidth = 2;
        private const int ClickSlop = 4;
        private const int LabelGap = 6;

        private readonly Bitmap _snapshot;
        private readonly Bitmap _shaded;
        private readonly int _originX;
        private readonly int _originY;
        private readonly Font _labelFont;
        // Fully qualified: System.Threading is imported too, so a bare "Timer"
        // is ambiguous between the thread pool timer and the message-loop one.
        private readonly System.Windows.Forms.Timer _idle;

        private bool _dragging;
        private Point _anchor;
        private Rectangle _selection;
        private Selection _result;

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        public static Selection Pick(Bitmap snapshot, int originX, int originY, int idleTimeoutSeconds)
        {
            if (snapshot == null) throw new ArgumentNullException("snapshot");
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
                throw new InvalidOperationException("OVERLAY_NOT_STA: the selection window needs an STA thread");

            using (RegionSelector form = new RegionSelector(snapshot, originX, originY, idleTimeoutSeconds))
            {
                form.ShowDialog();
                return form._result;
            }
        }

        public RegionSelector(Bitmap snapshot, int originX, int originY, int idleTimeoutSeconds)
        {
            _snapshot = snapshot;
            _originX = originX;
            _originY = originY;

            _labelFont = new Font("Segoe UI", 9f, FontStyle.Regular, GraphicsUnit.Point);

            SetStyle(ControlStyles.UserPaint, true);
            SetStyle(ControlStyles.AllPaintingInWmPaint, true);
            SetStyle(ControlStyles.OptimizedDoubleBuffer, true);
            SetStyle(ControlStyles.Opaque, true);

            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            ControlBox = false;
            TopMost = true;
            KeyPreview = true;
            Text = "dsh-quick-screenshot-selection";
            Cursor = Cursors.Cross;
            BackColor = Color.Black;
            Bounds = new Rectangle(originX, originY, snapshot.Width, snapshot.Height);

            _shaded = Shade(snapshot);

            if (idleTimeoutSeconds > 0)
            {
                _idle = new System.Windows.Forms.Timer();
                _idle.Interval = idleTimeoutSeconds * 1000;
                _idle.Tick += delegate { Cancel(); };
                _idle.Start();
            }
        }

        /// <summary>One dimmed copy of the whole snapshot, built once.</summary>
        private static Bitmap Shade(Bitmap snapshot)
        {
            Bitmap shaded = new Bitmap(snapshot.Width, snapshot.Height, PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(shaded))
            {
                g.CompositingMode = CompositingMode.SourceCopy;
                g.DrawImage(snapshot, new Rectangle(0, 0, snapshot.Width, snapshot.Height), 0, 0, snapshot.Width, snapshot.Height, GraphicsUnit.Pixel);
                g.CompositingMode = CompositingMode.SourceOver;
                using (SolidBrush shade = new SolidBrush(Color.FromArgb(ShadeAlpha, 0, 0, 0)))
                    g.FillRectangle(shade, 0, 0, snapshot.Width, snapshot.Height);
            }
            return shaded;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // Escape only works with keyboard focus. A hotkey press usually happens
            // while another app is frontmost, so ask for the foreground explicitly -
            // and stay usable when Windows refuses (right click still cancels).
            try { Activate(); SetForegroundWindow(Handle); }
            catch (Exception) { }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Rectangle clip = Rectangle.Round(g.VisibleClipBounds);
            clip.Intersect(ClientRectangle);
            if (clip.Width <= 0 || clip.Height <= 0) return;

            g.DrawImage(_shaded, clip, clip, GraphicsUnit.Pixel);

            if (_selection.Width > 1 && _selection.Height > 1)
            {
                // Undimmed pixels inside the rectangle: the selection is a hole, not
                // a translucent rectangle, so the user judges the real colours.
                g.DrawImage(_snapshot, _selection, _selection, GraphicsUnit.Pixel);
                using (Pen outer = new Pen(Color.FromArgb(255, 78, 160, 255), BorderWidth))
                    g.DrawRectangle(outer, _selection.X, _selection.Y, _selection.Width - 1, _selection.Height - 1);
                DrawSizeTag(g);
            }
        }

        private void DrawSizeTag(Graphics g)
        {
            string text = _selection.Width.ToString() + " x " + _selection.Height.ToString();
            Size size = TextRenderer.MeasureText(text, _labelFont);
            int width = size.Width + 12;
            int height = size.Height + 6;

            int x = _selection.X;
            int y = _selection.Y - height - LabelGap;
            if (y < 0) y = _selection.Y + LabelGap;
            if (x + width > ClientSize.Width) x = ClientSize.Width - width;
            if (x < 0) x = 0;

            Rectangle box = new Rectangle(x, y, width, height);
            using (SolidBrush background = new SolidBrush(Color.FromArgb(232, 22, 22, 24)))
                g.FillRectangle(background, box);
            using (Pen edge = new Pen(Color.FromArgb(90, 255, 255, 255), 1f))
                g.DrawRectangle(edge, box.X, box.Y, box.Width - 1, box.Height - 1);
            TextRenderer.DrawText(g, text, _labelFont, box, Color.White,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Right || e.Button == MouseButtons.Middle)
            {
                Cancel();
                return;
            }
            if (e.Button != MouseButtons.Left)
            {
                base.OnMouseDown(e);
                return;
            }

            Touch();
            _dragging = true;
            _anchor = e.Location;
            _selection = Rectangle.Empty;
            Capture = true;
            Invalidate();
            Update();
            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (!_dragging)
            {
                base.OnMouseMove(e);
                return;
            }

            Touch();
            Rectangle next = Normalize(_anchor, e.Location);
            if (next == _selection) return;

            // Repaint the band the rectangle left and the one it entered: the size
            // tag floats just outside the top edge, hence the extra margin.
            Rectangle dirty = Rectangle.Union(_selection, next);
            dirty.Inflate(BorderWidth + 2, BorderWidth + 40);
            _selection = next;
            Invalidate(dirty);
            Update();
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (!_dragging || e.Button != MouseButtons.Left)
            {
                base.OnMouseUp(e);
                return;
            }

            _dragging = false;
            Capture = false;

            Rectangle picked = Normalize(_anchor, e.Location);
            bool wholeMonitor = picked.Width < ClickSlop || picked.Height < ClickSlop;
            if (wholeMonitor) picked = MonitorBounds(e.Location);
            picked.Intersect(ClientRectangle);
            if (picked.Width < 2 || picked.Height < 2)
            {
                Cancel();
                return;
            }

            _result = new Selection();
            _result.Image = Crop(picked);
            _result.Bounds = new Rectangle(picked.X + _originX, picked.Y + _originY, picked.Width, picked.Height);
            _result.WholeMonitor = wholeMonitor;
            Close();
            base.OnMouseUp(e);
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape)
            {
                Cancel();
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        private void Touch()
        {
            if (_idle != null) _idle.Stop();
            if (_idle != null) _idle.Start();
        }

        private void Cancel()
        {
            _result = new Selection();
            _result.Cancelled = true;
            Close();
        }

        private static Rectangle Normalize(Point a, Point b)
        {
            int x = Math.Min(a.X, b.X);
            int y = Math.Min(a.Y, b.Y);
            return new Rectangle(x, y, Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
        }

        /// <summary>Client-space rect of the monitor under a client point.</summary>
        private Rectangle MonitorBounds(Point client)
        {
            Screen screen = Screen.FromPoint(new Point(client.X + _originX, client.Y + _originY));
            Rectangle bounds = screen.Bounds;
            return new Rectangle(bounds.X - _originX, bounds.Y - _originY, bounds.Width, bounds.Height);
        }

        private Bitmap Crop(Rectangle rect)
        {
            Bitmap image = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(image))
            {
                g.CompositingMode = CompositingMode.SourceCopy;
                g.DrawImage(_snapshot, new Rectangle(0, 0, rect.Width, rect.Height), rect.X, rect.Y, rect.Width, rect.Height, GraphicsUnit.Pixel);
            }
            return image;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_idle != null) { _idle.Stop(); _idle.Dispose(); }
                if (_shaded != null) _shaded.Dispose();
                if (_labelFont != null) _labelFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
'@
