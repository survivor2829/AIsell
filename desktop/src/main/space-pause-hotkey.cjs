// Double press of the space bar pauses a running 微信拓客 (user decision 2026-11-18: anywhere on the
// computer, in place of the small "先暂停" link in 小玺's bubble). While a run is on, WeChat - not
// this app - has the keyboard, so a window shortcut cannot see the key and Electron's globalShortcut
// would take the space bar away from every program. A low-level keyboard hook in its own PowerShell
// process only watches:
// - Only physical presses count. Keys the automation sends are marked injected (LLKHF_INJECTED) and
//   ignored, and messages are pasted, never typed, so a run cannot pause itself.
// - Any other key, or Ctrl/Alt/Shift/Win held, cancels the count: two spaces typed in a sentence or the
//   Ctrl+Space / Shift+Space input-method switches never pause.
// - While a WeChat step is being carried out and WeChat is in front, the space is swallowed so it can
//   never land in a draft being sent. Between steps (auto-reply listening, waiting for the next task)
//   the customer may chat by hand, so nothing is swallowed then; every other program always keeps it.
// The hook only exists while a run can be paused and records no key other than the space bar.
const { spawn } = require("node:child_process");

const DOUBLE_TAP_MS = 450;
const RESTART_AFTER_FAILURE_MS = 60_000;

const HOOK_CSHARP = String.raw`
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class XiaoxiSpacePause {
  [StructLayout(LayoutKind.Sequential)]
  private struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x, y; }
  private delegate IntPtr HookCallback(int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int hook, HookCallback callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);

  private static readonly BlockingCollection<string> events = new BlockingCollection<string>(256);
  private static readonly HookCallback callback = OnKeyboard;
  private static readonly ManualResetEventSlim ready = new ManualResetEventSlim(false);
  private static readonly HashSet<string> wechatNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Weixin", "WeChat", "WeChatAppEx" };
  private static IntPtr hook = IntPtr.Zero, lastWindow = IntPtr.Zero;
  private static bool lastWechat, spaceDown;
  private static volatile bool swallow;
  private static uint hookThread;
  private static int hookError;

  private static void Post(string line) { try { events.TryAdd(line); } catch (InvalidOperationException) { } }
  private static bool Held(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
  private static bool WechatInFront() {
    IntPtr window = GetForegroundWindow();
    if (window == lastWindow) return lastWechat;
    bool wechat = false;
    uint pid;
    GetWindowThreadProcessId(window, out pid);
    try { using (var process = System.Diagnostics.Process.GetProcessById((int)pid)) { wechat = wechatNames.Contains(process.ProcessName); } } catch { }
    lastWindow = window; lastWechat = wechat;
    return wechat;
  }
  private static IntPtr OnKeyboard(int code, IntPtr message, IntPtr data) {
    if (code >= 0) {
      int vk = Marshal.ReadInt32(data, 0);
      uint flags = unchecked((uint)Marshal.ReadInt32(data, 8));
      uint time = unchecked((uint)Marshal.ReadInt32(data, 12));
      int kind = message.ToInt32();
      bool down = kind == 0x100 || kind == 0x104, up = kind == 0x101 || kind == 0x105;
      if ((flags & 0x10u) == 0) {
        if (vk == 0x20) {
          if (down && !spaceDown) {
            spaceDown = true;
            bool modified = Held(0x11) || Held(0x12) || Held(0x10) || Held(0x5B) || Held(0x5C);
            Post((modified ? "o " : "d ") + time);
          } else if (up) spaceDown = false;
          if (swallow && WechatInFront()) return new IntPtr(1);
        } else if (down) {
          Post("o " + time);
        }
      }
    }
    return CallNextHookEx(IntPtr.Zero, code, message, data);
  }
  private static void HookLoop() {
    hookThread = GetCurrentThreadId();
    Message message;
    PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
    hook = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) hookError = Marshal.GetLastWin32Error();
    ready.Set();
    if (hook == IntPtr.Zero) return;
    try { while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { } }
    finally { UnhookWindowsHookEx(hook); }
  }
  public static void Run() {
    var worker = new Thread(HookLoop);
    worker.IsBackground = true;
    worker.Start();
    ready.Wait(5000);
    var output = Console.Out;
    if (hook == IntPtr.Zero) { output.WriteLine("failed " + hookError); output.Flush(); return; }
    output.WriteLine("ready"); output.Flush();
    // "s1"/"s0" from the desktop app turn swallowing on and off; it closes this pipe when the run stops
    // or the app exits, and the hook ends with it.
    var parent = new Thread(delegate () {
      try { string command; while ((command = Console.In.ReadLine()) != null) { if (command == "s1") swallow = true; else if (command == "s0") swallow = false; } } catch { }
      events.CompleteAdding();
    });
    parent.IsBackground = true;
    parent.Start();
    foreach (string line in events.GetConsumingEnumerable()) { output.WriteLine(line); output.Flush(); }
    PostThreadMessage(hookThread, 0x0012u, UIntPtr.Zero, IntPtr.Zero);
    worker.Join(1000);
  }
}
`;

const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${HOOK_CSHARP}
'@
[XiaoxiSpacePause]::Run()
`;

// "d <ms>" a bare physical space press, "o <ms>" anything else pressed (another key, or the space
// with a modifier held). Two bare spaces in a row within DOUBLE_TAP_MS are a double press.
function createDoubleTapDetector({ windowMs = DOUBLE_TAP_MS } = {}) {
  let last = null;
  return (line) => {
    const [kind, value] = String(line || "").trim().split(/\s+/u);
    const time = Number(value);
    if (kind === "o") { last = null; return false; }
    if (kind !== "d" || !Number.isFinite(time)) return false;
    // The tick count wraps after 49 days: a negative gap starts over.
    if (last !== null && time - last >= 0 && time - last <= windowMs) { last = null; return true; }
    last = time;
    return false;
  };
}

function createSpacePauseHotkey({ onDoubleTap = () => {}, onEvent = () => {}, spawnProcess = spawn, platform = process.platform, now = () => Date.now() } = {}) {
  let child = null;
  let failedAt = 0;
  let ready = false;
  let swallowing = false;
  const send = () => { try { child?.stdin.write(swallowing ? "s1\n" : "s0\n"); } catch { /* closing */ } };

  function failed(process_, kind, details = {}) {
    if (child === process_) { child = null; ready = false; }
    failedAt = now();
    onEvent("unavailable", { kind, ...details });
  }

  function start() {
    if (child || platform !== "win32") return false;
    if (failedAt && now() - failedAt < RESTART_AFTER_FAILURE_MS) return false;
    const detect = createDoubleTapDetector();
    let process_;
    try {
      process_ = spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      failedAt = now();
      onEvent("unavailable", { kind: "spawn_failed" });
      return false;
    }
    child = process_;
    let buffered = "";
    process_.stdout.setEncoding?.("utf8");
    process_.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (line === "ready") { if (child === process_) { ready = true; send(); } onEvent("ready", {}); }
        else if (line.startsWith("failed")) failed(process_, "hook_failed", { win_error: Number(line.split(" ")[1]) || 0 });
        else if (child === process_ && detect(line)) onDoubleTap();
      }
    });
    process_.on("error", () => failed(process_, "spawn_error"));
    process_.on("exit", (code) => {
      // Stopped by us (stop() already let go of it) or gone on its own: then not restarted at once.
      if (child === process_) failed(process_, `exited_${code}`);
    });
    return true;
  }

  function stop() {
    const running = child;
    child = null;
    ready = false;
    if (!running) return;
    try { running.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => { if (running.exitCode === null) { try { running.kill(); } catch { /* gone */ } } }, 2000);
    timer.unref?.();
  }

  // Swallow spaces in WeChat only while a step is being carried out (see the top of this file).
  function setSwallow(on) {
    if (swallowing === Boolean(on)) return;
    swallowing = Boolean(on);
    if (ready) send();
  }

  return { start, stop, setSwallow, running: () => Boolean(child), ready: () => Boolean(child) && ready };
}

module.exports = { createSpacePauseHotkey, createDoubleTapDetector, DOUBLE_TAP_MS, HOOK_CSHARP };
