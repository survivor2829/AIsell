// Where WeChat's chat list ends and the open chat begins, measured from the window's own pixels.
// The auto-reply readers used to assume the list is 300 dp wide. On customer PCs it is not: the list is
// draggable and WeChat lays it out differently when the window is clamped to a small screen (field strips
// 2026-11-15..21: about 0.27 of the window at 125%, 0.35 at 200%, more than half at 225% full screen).
// Everything after it (title, messages, bubble sides, the selected row) was measured from that guess.
//
// The edge is the one column where, row after row from the title bar down, a flat background on the left
// meets a different flat background on the right (or a one-pixel divider line between two flat sides). The
// leftmost such column that holds for most rows, the bottom of the window included, wins; text, avatars and bubbles never line up that long
// (lossless capture on the dev PC: divider 1.00, icon-bar edge 0.90, every other column under 0.30).
// Not found → -1, and the caller keeps its old estimate. The block may appear more than once in one
// script: it compiles once.
const WECHAT_SESSION_LIST_EDGE_POWERSHELL = String.raw`
if (-not ("XiaoxiSessionListEdge" -as [type])) {
Add-Type -TypeDefinition @"
using System;
public static class XiaoxiSessionListEdge {
  static int Diff(byte[] b, int i, int j) {
    return Math.Max(Math.Abs(b[i] - b[j]), Math.Max(Math.Abs(b[i + 1] - b[j + 1]), Math.Abs(b[i + 2] - b[j + 2])));
  }
  // bytes: 32bpp BGRA rows of the WeChat window, physical pixels. scale: window DPI / 96.
  // flat/step: largest change still flat, smallest change that is an edge (lossless capture: 2 and 3).
  public static double Score(byte[] bytes, int stride, int width, int height, double scale, int x, int flat, int step) {
    return Score(bytes, stride, width, height, scale, x, flat, step, 0.06, 0.96);
  }
  public static double Score(byte[] bytes, int stride, int width, int height, double scale, int x, int flat, int step, double from, double to) {
    int d = Math.Max(1, (int)Math.Round(scale));
    if (x - 2 * d < 0 || x + 2 * d >= width) return 0;
    int top = (int)Math.Round(height * from), bottom = (int)Math.Round(height * to);
    int rowStep = Math.Max(1, (int)Math.Round(2 * scale));
    int rows = 0, hits = 0;
    for (int y = top; y < bottom; y += rowStep) {
      rows++;
      int o = y * stride;
      int l2 = o + (x - 2 * d) * 4, l1 = o + (x - d) * 4, m = o + x * 4, r1 = o + (x + d) * 4, r2 = o + (x + 2 * d) * 4;
      if (Diff(bytes, l1, l2) > flat || Diff(bytes, r1, r2) > flat) continue;
      if (Diff(bytes, l1, r1) >= step || (Diff(bytes, m, l1) >= step && Diff(bytes, m, r1) >= step)) hits++;
    }
    return rows == 0 ? 0 : (double)hits / rows;
  }
  public static int Right(byte[] bytes, int stride, int width, int height, double scale, int flat, int step, double need) {
    if (bytes == null || width < 50 || height < 50 || stride < width * 4 || bytes.Length < stride * height) return -1;
    scale = Math.Max(0.5, Math.Min(4.0, scale));
    // Past WeChat's left icon bar, whose edge is the other long one. It is about 60 dp here but WeChat
    // draws larger than the system scale on some PCs (about 0.10 of the window on a 225% laptop), so the
    // window share counts too; the list edge was 0.27..0.62 in the field. Never past 80% of the window.
    int min = (int)Math.Round(Math.Max(120 * scale, width * 0.15)), max = (int)Math.Round(width * 0.80);
    int d = Math.Max(1, (int)Math.Round(scale));
    for (int x = min; x <= max; x++) {
      if (Score(bytes, stride, width, height, scale, x, flat, step) < need) continue;
      // The list runs to the bottom of the window, beside the message box; a popup over it (the search
      // dropdown, field 2026-11-17: down to about 0.8 of the window) ends above, so its straight side
      // never reaches down there. The top is no help: a title strip spans the whole width on some PCs.
      if (Score(bytes, stride, width, height, scale, x, flat, step, 0.86, 0.96) < need) continue;
      // The same edge seen a pixel or two later can score higher (anti-aliasing): settle on the best nearby.
      int best = x; double bestScore = 0;
      for (int cx = x; cx <= Math.Min(max, x + 2 * d); cx++) {
        double s = Score(bytes, stride, width, height, scale, cx, flat, step);
        if (s > bestScore) { bestScore = s; best = cx; }
      }
      return best;
    }
    return -1;
  }
}
"@
}
# A captured frame (32bpp bytes, stride, width, height) → the measured edge in frame pixels, or -1.
# Lossless capture: flat ≤ 2, edge ≥ 3; the edge must hold for 60% of the rows (field JPEGs: 0.73).
function Get-XiaoxiSessionListRight($frame, [double]$scale) {
  if ($null -eq $frame -or $null -eq $frame.bytes -or -not $frame.stride) { return -1 }
  try {
    return [XiaoxiSessionListEdge]::Right([byte[]]$frame.bytes, [int]$frame.stride, [int]$frame.width, [int]$frame.height, $scale, 2, 3, 0.6)
  } catch { return -1 }
}
`;

module.exports = { WECHAT_SESSION_LIST_EDGE_POWERSHELL };
