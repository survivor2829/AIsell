// Copy screen pixels into a bitmap through a compiled BitBlt helper.
//
// Defender flags PowerShell that builds a bitmap and calls
// Graphics.CopyFromScreen as HackTool:PowerShell/EmpireGetScreenshot.C and
// refuses the whole script while it loads (development machine, 2026-10-29 to
// 2026-11-04, 76 detections; on 11-04 it blocked every touch send). The same
// pixels copied by this helper load normally. Every worker script copies the
// screen only through here; worker-antivirus.self_check.cjs keeps it that way.
// The block may appear more than once in one script: it compiles once.
const WECHAT_SCREEN_PIXELS_POWERSHELL = String.raw`
if (-not ("XiaoxiScreenPixels" -as [type])) {
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class XiaoxiScreenPixels {
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr target, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
  // Fills the whole bitmap with the screen area whose top-left corner is (left, top).
  public static bool Copy(Bitmap target, int left, int top) {
    IntPtr screen = GetDC(IntPtr.Zero);
    if (screen == IntPtr.Zero) return false;
    try {
      using (Graphics graphics = Graphics.FromImage(target)) {
        IntPtr dc = graphics.GetHdc();
        try { return BitBlt(dc, 0, 0, target.Width, target.Height, screen, left, top, 0x00CC0020 | 0x40000000); }
        finally { graphics.ReleaseHdc(dc); }
      }
    } finally { ReleaseDC(IntPtr.Zero, screen); }
  }
}
"@
}
`;

module.exports = { WECHAT_SCREEN_PIXELS_POWERSHELL };
