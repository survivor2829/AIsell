// Where WeChat's own chat surface ends on a row of its main window. A name search can leave WeChat's
// 搜一搜 side panel open (a WeChatAppEx child window inside the main window); the picture send learned
// to stop at its edge on 2026-11-14. The chat-header fingerprint did not: its band reached 78% of the
// window, into the panel, whose content keeps changing, so a chat that had not changed was judged
// changed before the send (8a275cd0 and c19d34bf at 100%, atomic_conversation_changed, ~640 times).
// Scanning left from x, a child of the main window owned by another process is skipped; anything else
// in the way (another top-level window) leaves x as it was. The block may appear more than once in one
// script: it compiles once.
const WECHAT_CHAT_EDGE_POWERSHELL = String.raw`
if (-not ("XiaoxiChatEdge" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class XiaoxiChatEdge {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static int Right(IntPtr main, uint wechatPid, int x, int y, int minX) {
    POINT point; point.Y = y;
    for (int cx = x; cx > minX; cx -= 2) {
      point.X = cx;
      IntPtr hit = WindowFromPoint(point);
      if (hit == IntPtr.Zero || GetAncestor(hit, 2) != main) return x;
      uint pid;
      if (GetWindowThreadProcessId(hit, out pid) == 0) return x;
      if (pid == wechatPid) return cx == x ? x : cx - 2;
    }
    return x;
  }
}
"@
}
`;

module.exports = { WECHAT_CHAT_EDGE_POWERSHELL };
