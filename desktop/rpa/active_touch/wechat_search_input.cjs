// Scoped to one search PowerShell process. The hook retains only ownership,
// receipt counts and timestamps; it never stores keyboard text or mouse points.
const WECHAT_SEARCH_INPUT_GUARD_CSHARP = String.raw`
public sealed class WechatSearchInputReceipt {
  private readonly object sync = new object();
  private ulong marker;
  private uint beforeTick, ownedTick;
  private readonly System.Collections.Generic.HashSet<uint> ownedTicks = new System.Collections.Generic.HashSet<uint>();
  private int expected, received;
  private bool active, external;
  public bool External { get { lock (sync) { return external; } } }
  public uint OwnedTick { get { lock (sync) { return ownedTick; } } }
  public bool Begin(ulong token, uint before, int count) {
    lock (sync) {
      if (external || active || token == 0 || count < 1 || before == uint.MaxValue) return false;
      marker = token; beforeTick = before; ownedTick = uint.MaxValue; ownedTicks.Clear();
      expected = count; received = 0; active = true;
      return true;
    }
  }
  public void Keyboard(uint flags, ulong extraInfo, uint time) {
    lock (sync) {
      if (active && (flags & 0x10u) != 0 && extraInfo == marker && time != uint.MaxValue && received < expected) {
        ownedTick = time; ownedTicks.Add(time); received++;
      }
      else external = true;
    }
  }
  public void Mouse() { lock (sync) { external = true; } }
  public string Evaluate(int sent, uint currentTick, bool expired) {
    lock (sync) {
      if (external) return "wechat_external_input_detected";
      if (sent != expected) return "wechat_search_input_failed";
      if (currentTick == uint.MaxValue) return "wechat_input_lease_unavailable";
      if (currentTick != beforeTick && !ownedTicks.Contains(currentTick)) return "wechat_external_input_detected";
      if (active && received == expected && currentTick == ownedTick) { active = false; return "confirmed"; }
      return expired ? "wechat_input_lease_unavailable" : "pending";
    }
  }
}

public static class WechatSearchInputGuard {
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct Message { public System.IntPtr hwnd; public uint message; public System.UIntPtr wParam; public System.IntPtr lParam; public uint time; public int x, y; public uint extra; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct LastInput { public uint size, time; }
  private delegate System.IntPtr HookCallback(int code, System.IntPtr message, System.IntPtr data);
  [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] private static extern System.IntPtr SetWindowsHookEx(int hook, HookCallback callback, System.IntPtr module, uint thread);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(System.IntPtr hook);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern System.IntPtr CallNextHookEx(System.IntPtr hook, int code, System.IntPtr message, System.IntPtr data);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern int GetMessage(out Message message, System.IntPtr hwnd, uint min, uint max);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, System.IntPtr hwnd, uint min, uint max, uint remove);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, System.UIntPtr wParam, System.IntPtr lParam);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] private static extern System.IntPtr GetModuleHandle(string name);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput info);
  [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern System.IntPtr GetForegroundWindow();
  private static readonly WechatSearchInputReceipt receipt = new WechatSearchInputReceipt();
  private static readonly System.Threading.ManualResetEventSlim ready = new System.Threading.ManualResetEventSlim(false);
  private static readonly HookCallback keyboardCallback = OnKeyboard;
  private static readonly HookCallback mouseCallback = OnMouse;
  private static System.Threading.Thread worker;
  private static System.IntPtr keyboardHook, mouseHook, expectedWindow;
  private static uint threadId;
  private static volatile bool stopping, available;
  public static string FailureReason = "wechat_input_lease_unavailable";
  public static uint ConfirmedTick = uint.MaxValue;
  public static bool IsAvailable { get { return available && !stopping && worker != null && worker.IsAlive; } }
  public static bool IsStopped { get { return !available && (worker == null || !worker.IsAlive); } }
  public static bool ExternalInput { get { return receipt.External; } }
  private static System.IntPtr OnKeyboard(int code, System.IntPtr message, System.IntPtr data) {
    if (code >= 0) {
      // KBDLLHOOKSTRUCT offsets: skip vkCode and scanCode entirely.
      uint flags = unchecked((uint)System.Runtime.InteropServices.Marshal.ReadInt32(data, 8));
      uint time = unchecked((uint)System.Runtime.InteropServices.Marshal.ReadInt32(data, 12));
      ulong marker = unchecked((ulong)System.Runtime.InteropServices.Marshal.ReadIntPtr(data, 16).ToInt64());
      receipt.Keyboard(flags, marker, time);
    }
    return CallNextHookEx(System.IntPtr.Zero, code, message, data);
  }
  private static System.IntPtr OnMouse(int code, System.IntPtr message, System.IntPtr data) {
    if (code >= 0) receipt.Mouse();
    return CallNextHookEx(System.IntPtr.Zero, code, message, data);
  }
  private static void Run() {
    try {
      threadId = GetCurrentThreadId();
      Message message;
      PeekMessage(out message, System.IntPtr.Zero, 0, 0, 0);
      if (stopping) return;
      keyboardHook = SetWindowsHookEx(13, keyboardCallback, GetModuleHandle(null), 0);
      mouseHook = SetWindowsHookEx(14, mouseCallback, GetModuleHandle(null), 0);
      available = keyboardHook != System.IntPtr.Zero && mouseHook != System.IntPtr.Zero;
      ready.Set();
      while (available && !stopping && GetMessage(out message, System.IntPtr.Zero, 0, 0) > 0) {}
    } finally {
      available = false;
      if (keyboardHook != System.IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
      if (mouseHook != System.IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
      ready.Set();
    }
  }
  public static bool Start(long hwnd) {
    if (worker != null || hwnd == 0) return false;
    expectedWindow = new System.IntPtr(hwnd);
    worker = new System.Threading.Thread(Run);
    worker.IsBackground = true;
    worker.Name = "wechat-search-input-receipts";
    worker.Start();
    return ready.Wait(1200) && IsAvailable;
  }
  public static void Stop() {
    stopping = true;
    if (threadId != 0) PostThreadMessage(threadId, 0x0012u, System.UIntPtr.Zero, System.IntPtr.Zero);
    if (worker != null) worker.Join(1200);
    // The parent PowerShell always exits after this search. Windows also removes
    // the hooks if that process terminates before the background thread returns.
  }
  private static uint ReadTick() {
    LastInput input = new LastInput(); input.size = (uint)System.Runtime.InteropServices.Marshal.SizeOf(input);
    return GetLastInputInfo(ref input) ? input.time : uint.MaxValue;
  }
  public static System.UIntPtr Begin(int count, uint expectedTick) {
    FailureReason = "wechat_input_lease_unavailable";
    if (!IsAvailable) return System.UIntPtr.Zero;
    if (receipt.External) { FailureReason = "wechat_external_input_detected"; return System.UIntPtr.Zero; }
    if (GetForegroundWindow() != expectedWindow) { FailureReason = "wechat_window_not_foreground"; return System.UIntPtr.Zero; }
    uint before = ReadTick();
    if (before == uint.MaxValue) return System.UIntPtr.Zero;
    if (before != expectedTick) { FailureReason = "wechat_external_input_detected"; return System.UIntPtr.Zero; }
    byte[] bytes = new byte[8];
    using (var random = System.Security.Cryptography.RandomNumberGenerator.Create()) { random.GetBytes(bytes); }
    ulong marker = System.BitConverter.ToUInt64(bytes, 0) | 1UL;
    if (!receipt.Begin(marker, before, count)) return System.UIntPtr.Zero;
    return new System.UIntPtr(marker);
  }
  public static bool Confirm(uint sent) {
    var timer = System.Diagnostics.Stopwatch.StartNew();
    while (true) {
      if (!IsAvailable) { FailureReason = "wechat_input_lease_unavailable"; return false; }
      if (GetForegroundWindow() != expectedWindow) { FailureReason = "wechat_window_not_foreground"; return false; }
      string result = receipt.Evaluate((int)sent, ReadTick(), timer.ElapsedMilliseconds >= 1000);
      if (result == "confirmed") { ConfirmedTick = receipt.OwnedTick; return true; }
      if (result != "pending") { FailureReason = result; return false; }
      System.Threading.Thread.Sleep(10);
    }
  }
}
`;

module.exports = { WECHAT_SEARCH_INPUT_GUARD_CSHARP };
