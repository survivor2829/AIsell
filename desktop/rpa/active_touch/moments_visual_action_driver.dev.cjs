const crypto = require("node:crypto");
const path = require("node:path");
const { momentsPostFingerprint } = require("./moments_dry_run.dev.cjs");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const { runPowerShell, runPowerShellAsync } = require("./wechat_window_driver.cjs");

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMENT_SEND_MARKER_DIRECTORY = "moments_comment_send_markers";
// The reverse-engineered reference re-detects menu coordinates and accepts
// roughly 12 px of per-axis movement. We keep that rendering tolerance while
// still requiring exactly one content/avatar/geometry match before any click.
const MOMENTS_VISUAL_POST_RELOCK_TOLERANCE_PX = 12;
const VISUAL_ACTION_TIMEOUT_CAP_MS = Object.freeze({
  inspect: 20_000,
  like: 30_000,
  comment_occurrence_check: 45_000,
  comment_check: 85_000
});

function exactCommentText(value) {
  return String(value ?? "");
}

function validCommentSendMarkerPath(filePath, postFingerprint) {
  const value = String(filePath ?? "");
  return path.isAbsolute(value)
    && SHA256_PATTERN.test(String(postFingerprint ?? ""))
    && path.basename(value) === `${postFingerprint}.json`
    && path.basename(path.dirname(value)) === COMMENT_SEND_MARKER_DIRECTORY;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function validBounds(bounds, minimumWidth = 0, minimumHeight = 0) {
  return bounds !== null
    && typeof bounds === "object"
    && [bounds.left, bounds.top, bounds.width, bounds.height]
      .every((value) => typeof value === "number" && Number.isFinite(value))
    && bounds.width > minimumWidth
    && bounds.height > minimumHeight;
}

function boundsWithin(inner, outer) {
  return validBounds(inner)
    && validBounds(outer)
    && inner.left >= outer.left
    && inner.top >= outer.top
    && inner.left + inner.width <= outer.left + outer.width
    && inner.top + inner.height <= outer.top + outer.height;
}

function validCommentReadbackSeed(seed, context = {}) {
  const expectedWindow = context.expectedWindow ?? {};
  const snapshot = context.postSnapshot ?? {};
  const relativeWindow = {
    left: 0,
    top: 0,
    width: Number(expectedWindow.width),
    height: Number(expectedWindow.height)
  };
  const relativePost = {
    left: Number(snapshot.bounds?.left) - Number(expectedWindow.left),
    top: Number(snapshot.bounds?.top) - Number(expectedWindow.top),
    width: Number(snapshot.bounds?.width),
    height: Number(snapshot.bounds?.height)
  };
  const relativeMenu = {
    left: Number(snapshot.menu_bounds?.left) - Number(expectedWindow.left),
    top: Number(snapshot.menu_bounds?.top) - Number(expectedWindow.top),
    width: Number(snapshot.menu_bounds?.width),
    height: Number(snapshot.menu_bounds?.height)
  };
  const candidate = seed?.candidateBounds;
  const expectedKeys = [
    "version",
    "observationId",
    "attemptKey",
    "postFingerprint",
    "commentTextSha256",
    "candidateBounds",
    "candidatePixelHash",
    "avatarHash",
    "menuBounds",
    "expectedInputTick",
    "createdAtMs"
  ];
  const createdAtMs = Number(seed?.createdAtMs);
  return seed !== null
    && typeof seed === "object"
    && !Array.isArray(seed)
    && Object.keys(seed).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(seed, key))
    && seed.version === 1
    && seed.observationId === context.observationId
    && seed.attemptKey === context.attemptKey
    && seed.postFingerprint === context.postFingerprint
    && seed.commentTextSha256 === sha256(exactCommentText(context.commentText))
    && SHA256_PATTERN.test(String(seed.candidatePixelHash ?? ""))
    && SHA256_PATTERN.test(String(seed.avatarHash ?? ""))
    && validBounds(relativeWindow, 299, 299)
    && validBounds(relativePost)
    && validBounds(relativeMenu)
    && validBounds(candidate, 4, 4)
    && validBounds(seed.menuBounds)
    && Number.isInteger(seed.expectedInputTick)
    && seed.expectedInputTick >= 0
    && seed.expectedInputTick < 0xffff_ffff
    && boundsWithin(candidate, relativeWindow)
    && boundsWithin(seed.menuBounds, relativeWindow)
    && candidate.left >= relativePost.left - 2
    && candidate.left + candidate.width <= relativePost.left + relativePost.width + 2
    && candidate.top >= relativeMenu.top + relativeMenu.height - 2
    && Math.abs(seed.menuBounds.left - relativeMenu.left) <= 3
    && Math.abs(seed.menuBounds.top - relativeMenu.top) <= 3
    && Number.isFinite(createdAtMs)
    && createdAtMs > 0
    && createdAtMs <= Number(context.deadlineMs)
    && createdAtMs <= Date.now() + 5_000;
}

function expectedVisualObservationId(window, snapshot) {
  const payload = JSON.stringify({
    version: 5,
    pid: Number(window.pid),
    hWnd: String(window.hWnd),
    windowBounds: {
      left: Number(window.left),
      top: Number(window.top),
      width: Number(window.width),
      height: Number(window.height)
    },
    windowAutomationId: String(window.automationId ?? ""),
    windowIdentityMode: String(window.identityMode ?? ""),
    windowRootName: String(window.rootName ?? ""),
    windowRootControlType: String(window.rootControlType ?? ""),
    windowRootProcessId: Number(window.rootProcessId),
    windowFeedAutomationId: String(window.feedAutomationId ?? ""),
    windowFeedRuntimeId: String(window.feedRuntimeId ?? ""),
    windowFeedCount: Number(window.feedCount),
    windowRenderPaneName: String(window.renderPaneName ?? ""),
    windowRenderPaneAutomationId: String(window.renderPaneAutomationId ?? ""),
    windowRenderPaneControlType: String(window.renderPaneControlType ?? ""),
    windowRenderPaneProcessId: Number(window.renderPaneProcessId),
    windowRenderPaneRuntimeId: String(window.renderPaneRuntimeId ?? ""),
    windowRenderPaneBounds: {
      left: Number(window.renderPaneBounds?.left),
      top: Number(window.renderPaneBounds?.top),
      width: Number(window.renderPaneBounds?.width),
      height: Number(window.renderPaneBounds?.height)
    },
    source: String(snapshot.source ?? ""),
    identityScope: String(snapshot.identity_scope ?? ""),
    structureVerified: snapshot.structure_verified === true,
    ocrProvider: String(snapshot.ocr_provider ?? ""),
    ocrLanguage: String(snapshot.ocr_language ?? ""),
    regionHash: String(snapshot.region_hash ?? ""),
    avatarHash: String(snapshot.avatar_hash ?? ""),
    layoutHash: String(snapshot.layout_hash ?? ""),
    label: String(snapshot.label ?? ""),
    identityText: String(snapshot.identity_text ?? ""),
    ...(String(snapshot.stable_anchor_text ?? "") ? { stableAnchorText: String(snapshot.stable_anchor_text) } : {}),
    postFingerprint: String(snapshot.post_fingerprint ?? ""),
    bounds: {
      left: Number(snapshot.bounds?.left),
      top: Number(snapshot.bounds?.top),
      width: Number(snapshot.bounds?.width),
      height: Number(snapshot.bounds?.height)
    },
    menuBounds: {
      left: Number(snapshot.menu_bounds?.left),
      top: Number(snapshot.menu_bounds?.top),
      width: Number(snapshot.menu_bounds?.width),
      height: Number(snapshot.menu_bounds?.height)
    },
    avatarBounds: {
      left: Number(snapshot.avatar_bounds?.left),
      top: Number(snapshot.avatar_bounds?.top),
      width: Number(snapshot.avatar_bounds?.width),
      height: Number(snapshot.avatar_bounds?.height)
    }
  });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function validVisualContext(context = {}) {
  const window = context.expectedWindow ?? {};
  const snapshot = context.postSnapshot ?? {};
  const windowBounds = {
    left: window.left,
    top: window.top,
    width: window.width,
    height: window.height
  };
  const observationId = String(context.observationId ?? "");
  const windowValid = window.title === "朋友圈"
    && ["Weixin", "WeChat"].includes(window.processName)
    && window.automationId === ""
    && window.identityMode === "visual_mmui_render"
    && window.rootName === "朋友圈"
    && window.rootControlType === "ControlType.Window"
    && Number.isInteger(window.pid)
    && window.pid > 0
    && window.rootProcessId === window.pid
    && typeof window.hWnd === "string"
    && /^[1-9]\d*$/u.test(window.hWnd)
    && window.feedAutomationId === ""
    && window.feedRuntimeId === ""
    && window.feedCount === 0
    && window.renderPaneName === "MMUIRenderSubWindowHW"
    && typeof window.renderPaneAutomationId === "string"
    && window.renderPaneControlType === "ControlType.Pane"
    && window.renderPaneProcessId === window.pid
    && typeof window.renderPaneRuntimeId === "string"
    && Boolean(window.renderPaneRuntimeId.trim())
    && validBounds(windowBounds, 299, 299)
    && boundsWithin(window.renderPaneBounds, windowBounds);
  const snapshotValid = snapshot.source === "visual:windows_media_ocr"
    && snapshot.identity_scope === "window_session_only"
    && snapshot.structure_verified === true
    && snapshot.ocr_provider === "windows_media_ocr"
    && snapshot.ocr_language === "zh-Hans-CN"
    && SHA256_PATTERN.test(String(snapshot.region_hash ?? ""))
    && SHA256_PATTERN.test(String(snapshot.avatar_hash ?? ""))
    && SHA256_PATTERN.test(String(snapshot.layout_hash ?? ""))
    && typeof snapshot.label === "string"
    && Boolean(snapshot.label.trim())
    && snapshot.label.length <= 2000
    && typeof snapshot.identity_text === "string"
    && Boolean(snapshot.identity_text.trim())
    && snapshot.identity_text.length <= 2000
    && (snapshot.stable_anchor_text === undefined
      || (typeof snapshot.stable_anchor_text === "string" && snapshot.stable_anchor_text.length <= 2000))
    && SHA256_PATTERN.test(String(snapshot.post_fingerprint ?? ""))
    && momentsPostFingerprint(snapshot.identity_text) === snapshot.post_fingerprint
    && boundsWithin(snapshot.bounds, window.renderPaneBounds)
    && boundsWithin(snapshot.menu_bounds, window.renderPaneBounds)
    && boundsWithin(snapshot.avatar_bounds, window.renderPaneBounds);
  return windowValid
    && snapshotValid
    && SHA256_PATTERN.test(observationId)
    && snapshot.observation_id === observationId
    && expectedVisualObservationId(window, snapshot) === observationId
    && Number.isFinite(Number(context.deadlineMs))
    && Number(context.deadlineMs) > 0;
}

const MOMENTS_VISUAL_ACTION_POWERSHELL = String.raw`
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$script:momentsVisualPostRelockTolerancePx = ${MOMENTS_VISUAL_POST_RELOCK_TOLERANCE_PX.toFixed(1)}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class Win32WechatMomentsVisualAction {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public MOUSEINPUT mouseInput;
    [FieldOffset(8)] public KEYBDINPUT keyboardInput;
  }
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr newOwner);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
  [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
  [DllImport("user32.dll", SetLastError = true)] private static extern int CountClipboardFormats();
  [DllImport("user32.dll", SetLastError = true)] private static extern uint EnumClipboardFormats(uint format);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetClipboardData(uint format);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetClipboardData(uint format, IntPtr memory);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool DestroyWindow(IntPtr hWnd);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern UIntPtr GlobalSize(IntPtr memory);
  [DllImport("kernel32.dll")] private static extern void SetLastError(uint errorCode);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  private const uint CfText = 1;
  private const uint CfOemText = 7;
  private const uint CfUnicodeText = 13;
  private const uint CfLocale = 16;
  private const uint GmemMoveable = 2;
  private const ushort BackspaceScanCode = 0x0E;
  private const uint KeyEventfKeyUp = 0x0002u;
  private const uint KeyEventfUnicode = 0x0004u;
  private const uint KeyEventfScanCode = 0x0008u;
  private static readonly IntPtr HwndMessage = new IntPtr(-3);
  private const int MaxClipboardTextBytes = 8 * 1024 * 1024;

  private static bool OpenClipboardWithRetry(IntPtr owner) {
    for (int attempt = 0; attempt < 8; attempt++) {
      if (OpenClipboard(owner)) return true;
      Thread.Sleep(25);
    }
    return false;
  }

  private static bool CloseClipboardWithRetry() {
    if (CloseClipboard()) return true;
    Thread.Sleep(5);
    return CloseClipboard();
  }

  private static bool TryReadUnicodeTextLocked(out bool empty, out string text) {
    empty = false;
    text = "";
    uint format = 0;
    bool any = false;
    bool unicode = false;
    while (true) {
      uint next = EnumClipboardFormats(format);
      if (next == 0) break;
      format = next;
      any = true;
      if (format == CfUnicodeText) unicode = true;
    }
    if (!any) {
      empty = true;
      return true;
    }
    if (!unicode) return false;
    IntPtr handle = GetClipboardData(CfUnicodeText);
    if (handle == IntPtr.Zero) return false;
    ulong byteCount64 = GlobalSize(handle).ToUInt64();
    if (byteCount64 < 2 || byteCount64 > MaxClipboardTextBytes || (byteCount64 % 2) != 0) return false;
    int byteCount = (int)byteCount64;
    IntPtr pointer = GlobalLock(handle);
    if (pointer == IntPtr.Zero) return false;
    try {
      byte[] bytes = new byte[byteCount];
      Marshal.Copy(pointer, bytes, 0, byteCount);
      int textBytes = -1;
      for (int index = 0; index + 1 < bytes.Length; index += 2) {
        if (bytes[index] == 0 && bytes[index + 1] == 0) { textBytes = index; break; }
      }
      if (textBytes < 0) return false;
      text = Encoding.Unicode.GetString(bytes, 0, textBytes);
      return true;
    } finally {
      GlobalUnlock(handle);
    }
  }

  private static bool ClipboardContainsOnlyTextFormatsLocked() {
    SetLastError(0);
    int expectedCount = CountClipboardFormats();
    if (expectedCount == 0 && Marshal.GetLastWin32Error() != 0) return false;
    uint format = 0;
    int observedCount = 0;
    while (true) {
      uint next = EnumClipboardFormats(format);
      if (next == 0) return observedCount == expectedCount;
      format = next;
      observedCount++;
      if (format != CfText && format != CfOemText && format != CfUnicodeText && format != CfLocale) return false;
    }
  }

  private static IntPtr AllocateUnicodeText(string value) {
    byte[] bytes = Encoding.Unicode.GetBytes((value ?? "") + "\0");
    IntPtr memory = GlobalAlloc(GmemMoveable, new UIntPtr((uint)bytes.Length));
    if (memory == IntPtr.Zero) return IntPtr.Zero;
    IntPtr pointer = GlobalLock(memory);
    if (pointer == IntPtr.Zero) {
      GlobalFree(memory);
      return IntPtr.Zero;
    }
    try { Marshal.Copy(bytes, 0, pointer, bytes.Length); }
    finally { GlobalUnlock(memory); }
    return memory;
  }

  public static bool TryCaptureTextClipboard(out uint sequence, out bool empty, out string text) {
    sequence = 0;
    empty = false;
    text = "";
    for (int captureAttempt = 0; captureAttempt < 6; captureAttempt++) {
      if (!OpenClipboardWithRetry(IntPtr.Zero)) {
        Thread.Sleep(35);
        continue;
      }
      bool result = false;
      try {
        sequence = GetClipboardSequenceNumber();
        result = ClipboardContainsOnlyTextFormatsLocked() &&
          TryReadUnicodeTextLocked(out empty, out text) &&
          GetClipboardSequenceNumber() == sequence;
      } finally {
        if (!CloseClipboardWithRetry()) result = false;
      }
      if (result) return true;
      sequence = 0;
      empty = false;
      text = "";
      Thread.Sleep(35);
    }
    return false;
  }

  public static bool TryClipboardTextMatches(uint expectedSequence, bool expectedEmpty, string expectedText, out bool matches) {
    matches = false;
    if (!OpenClipboardWithRetry(IntPtr.Zero)) return false;
    bool captured = false;
    try {
      bool empty;
      string text;
      uint beforeSequence = GetClipboardSequenceNumber();
      if (TryReadUnicodeTextLocked(out empty, out text)) {
        uint afterSequence = GetClipboardSequenceNumber();
        captured = beforeSequence == afterSequence;
        matches = captured && beforeSequence == expectedSequence && empty == expectedEmpty &&
          (empty || String.Equals(text, expectedText ?? "", StringComparison.Ordinal));
      }
    } finally {
      if (!CloseClipboardWithRetry()) { captured = false; matches = false; }
    }
    return captured;
  }

  public static bool ClipboardTextMatches(uint expectedSequence, bool expectedEmpty, string expectedText) {
    bool matches;
    return TryClipboardTextMatches(expectedSequence, expectedEmpty, expectedText, out matches) && matches;
  }

  public static bool TryCaptureCopiedTextClipboardState(out uint sequence, out bool empty, out string text, out uint ownerPid, out long ownerHandle) {
    sequence = 0;
    empty = false;
    text = "";
    ownerPid = 0;
    ownerHandle = 0;
    if (!OpenClipboardWithRetry(IntPtr.Zero)) return false;
    bool result = false;
    try {
      sequence = GetClipboardSequenceNumber();
      IntPtr owner = GetClipboardOwner();
      ownerHandle = owner.ToInt64();
      uint confirmedOwnerPid;
      result = owner != IntPtr.Zero && GetWindowThreadProcessId(owner, out ownerPid) != 0 &&
        TryReadUnicodeTextLocked(out empty, out text) &&
        GetClipboardSequenceNumber() == sequence && GetClipboardOwner() == owner &&
        GetWindowThreadProcessId(owner, out confirmedOwnerPid) != 0 && confirmedOwnerPid == ownerPid;
    } finally {
      if (!CloseClipboardWithRetry()) result = false;
    }
    return result;
  }

  public static bool TryCaptureCopiedTextClipboard(out uint sequence, out string text, out uint ownerPid, out long ownerHandle) {
    bool empty;
    return TryCaptureCopiedTextClipboardState(out sequence, out empty, out text, out ownerPid, out ownerHandle) && !empty;
  }

  public static bool ClipboardOwnerMatchesLockedProcess(long ownerHandle, IntPtr expectedWindow, uint expectedPid) {
    if (ownerHandle == 0 || expectedWindow == IntPtr.Zero || expectedPid == 0) return false;
    uint expectedWindowPid;
    if (GetWindowThreadProcessId(expectedWindow, out expectedWindowPid) == 0 || expectedWindowPid != expectedPid) return false;
    IntPtr owner = new IntPtr(ownerHandle);
    uint ownerPid;
    return GetWindowThreadProcessId(owner, out ownerPid) != 0 && ownerPid == expectedPid;
  }

  // 3 = replacement content is known but the sequence did not advance, 2 = rolled back
  // to expected text, 1 = replaced with an advanced sequence, 0 = no mutation,
  // -1 = current clipboard is empty after failed replacement.
  // cleanupSucceeded is independent so a known mutation is never discarded when handle cleanup fails.
  public static int AtomicReplaceTextClipboard(uint expectedSequence, bool expectedEmpty, string expectedText, bool replacementEmpty, string replacementText, out uint replacementSequence, out bool cleanupSucceeded) {
    replacementSequence = 0;
    cleanupSucceeded = true;
    IntPtr replacementMemory = replacementEmpty ? IntPtr.Zero : AllocateUnicodeText(replacementText);
    IntPtr fallbackMemory = expectedEmpty ? IntPtr.Zero : AllocateUnicodeText(expectedText);
    if ((!replacementEmpty && replacementMemory == IntPtr.Zero) || (!expectedEmpty && fallbackMemory == IntPtr.Zero)) {
      if (replacementMemory != IntPtr.Zero) GlobalFree(replacementMemory);
      if (fallbackMemory != IntPtr.Zero) GlobalFree(fallbackMemory);
      return 0;
    }
    IntPtr owner = CreateWindowEx(0, "STATIC", "xiaoxi-clipboard-owner", 0, 0, 0, 0, 0, HwndMessage, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (owner == IntPtr.Zero) {
      if (replacementMemory != IntPtr.Zero) GlobalFree(replacementMemory);
      if (fallbackMemory != IntPtr.Zero) GlobalFree(fallbackMemory);
      return 0;
    }
    bool opened = false;
    bool cleanupOk = true;
    int result = 0;
    try {
      opened = OpenClipboardWithRetry(owner);
      if (opened) {
        do {
          if (GetClipboardSequenceNumber() != expectedSequence) break;
          bool currentEmpty;
          string currentText;
          if (!TryReadUnicodeTextLocked(out currentEmpty, out currentText) || currentEmpty != expectedEmpty ||
            (!currentEmpty && !String.Equals(currentText, expectedText ?? "", StringComparison.Ordinal)) ||
            GetClipboardSequenceNumber() != expectedSequence) break;
          if (!EmptyClipboard()) break;
          replacementSequence = GetClipboardSequenceNumber();
          if (replacementEmpty) {
            result = replacementSequence != expectedSequence ? 1 : 3;
            break;
          }
          if (SetClipboardData(CfUnicodeText, replacementMemory) != IntPtr.Zero) {
            replacementMemory = IntPtr.Zero;
            replacementSequence = GetClipboardSequenceNumber();
            result = replacementSequence != expectedSequence ? 1 : 3;
            break;
          }
          if (!expectedEmpty && fallbackMemory != IntPtr.Zero && SetClipboardData(CfUnicodeText, fallbackMemory) != IntPtr.Zero) {
            fallbackMemory = IntPtr.Zero;
            replacementSequence = GetClipboardSequenceNumber();
            result = 2;
            break;
          }
          replacementSequence = GetClipboardSequenceNumber();
          result = expectedEmpty ? 2 : -1;
        } while (false);
      }
    } finally {
      if (opened && !CloseClipboardWithRetry()) cleanupOk = false;
      if (!DestroyWindow(owner)) {
        Thread.Sleep(5);
        cleanupOk = DestroyWindow(owner) && cleanupOk;
      }
      if (replacementMemory != IntPtr.Zero) GlobalFree(replacementMemory);
      if (fallbackMemory != IntPtr.Zero) GlobalFree(fallbackMemory);
    }
    cleanupSucceeded = cleanupOk;
    return result;
  }

  public static uint GetLastInputTick() {
    LASTINPUTINFO info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)), dwTime = 0 };
    return GetLastInputInfo(ref info) ? info.dwTime : UInt32.MaxValue;
  }

  public static bool AtomicMouseClick(int screenX, int screenY, bool rightButton) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    if (width <= 1 || height <= 1 || screenX < left || screenY < top || screenX >= left + width || screenY >= top + height) return false;
    int dx = (int)Math.Round((screenX - left) * 65535.0 / (width - 1));
    int dy = (int)Math.Round((screenY - top) * 65535.0 / (height - 1));
    uint common = 0x0001u | 0x4000u | 0x8000u;
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 0;
    inputs[0].mouseInput = new MOUSEINPUT { dx = dx, dy = dy, mouseData = 0, dwFlags = common | (rightButton ? 0x0008u : 0x0002u), time = 0, extraInfo = UIntPtr.Zero };
    inputs[1].type = 0;
    inputs[1].mouseInput = new MOUSEINPUT { dx = dx, dy = dy, mouseData = 0, dwFlags = common | (rightButton ? 0x0010u : 0x0004u), time = 0, extraInfo = UIntPtr.Zero };
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 2;
  }

  private static INPUT KeyboardInput(ushort virtualKey, bool keyUp) {
    INPUT input = new INPUT();
    input.type = 1;
    input.keyboardInput = new KEYBDINPUT {
      virtualKey = virtualKey,
      scanCode = 0,
      flags = keyUp ? KeyEventfKeyUp : 0u,
      time = 0,
      extraInfo = UIntPtr.Zero
    };
    return input;
  }

  private static INPUT KeyboardScanInput(ushort scanCode, bool keyUp) {
    INPUT input = new INPUT();
    input.type = 1;
    input.keyboardInput = new KEYBDINPUT {
      virtualKey = 0,
      scanCode = scanCode,
      flags = KeyEventfScanCode | (keyUp ? KeyEventfKeyUp : 0u),
      time = 0,
      extraInfo = UIntPtr.Zero
    };
    return input;
  }

  public static bool AtomicKeyboardChord(ushort modifier, ushort key) {
    if (IntPtr.Size != 8 || modifier != 0x11 || (key != 0x41 && key != 0x43 && key != 0x56)) return false;
    INPUT[] inputs = new INPUT[] {
      KeyboardInput(modifier, false),
      KeyboardInput(key, false),
      KeyboardInput(key, true),
      KeyboardInput(modifier, true)
    };
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent == inputs.Length) return true;
    INPUT[] releases = new INPUT[] { KeyboardInput(key, true), KeyboardInput(modifier, true) };
    SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(INPUT)));
    return false;
  }

  public static bool AtomicKeyboardUnicodeText(string text) {
    if (IntPtr.Size != 8 || String.IsNullOrEmpty(text) || text.Length > 500) return false;
    INPUT[] inputs = new INPUT[text.Length * 2];
    for (int index = 0; index < text.Length; index++) {
      ushort codeUnit = text[index];
      inputs[index * 2].type = 1;
      inputs[index * 2].keyboardInput = new KEYBDINPUT {
        virtualKey = 0,
        scanCode = codeUnit,
        flags = KeyEventfUnicode,
        time = 0,
        extraInfo = UIntPtr.Zero
      };
      inputs[index * 2 + 1].type = 1;
      inputs[index * 2 + 1].keyboardInput = new KEYBDINPUT {
        virtualKey = 0,
        scanCode = codeUnit,
        flags = KeyEventfUnicode | KeyEventfKeyUp,
        time = 0,
        extraInfo = UIntPtr.Zero
      };
    }
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == inputs.Length;
  }

  public static bool AtomicKeyboardBackspace() {
    if (IntPtr.Size != 8) return false;
    INPUT[] inputs = new INPUT[] {
      KeyboardScanInput(BackspaceScanCode, false),
      KeyboardScanInput(BackspaceScanCode, true)
    };
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent == inputs.Length) return true;
    INPUT[] releases = new INPUT[] { KeyboardScanInput(BackspaceScanCode, true) };
    SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(INPUT)));
    return false;
  }

  public static bool AtomicKeyboardEscape() {
    if (IntPtr.Size != 8) return false;
    const ushort VkEscape = 0x1B;
    INPUT[] inputs = new INPUT[] {
      KeyboardInput(VkEscape, false),
      KeyboardInput(VkEscape, true)
    };
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent == inputs.Length) return true;
    INPUT[] releases = new INPUT[] { KeyboardInput(VkEscape, true) };
    SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(INPUT)));
    return false;
  }

}
"@

[void][Win32WechatMomentsVisualAction]::SetThreadDpiAwarenessContext([IntPtr](-4))

${MOMENTS_VISUAL_READONLY_POWERSHELL}

$script:visualActionAttempted = $false
$script:visualMenuOpen = $false
$script:visualActionStage = "initialized"
$script:visualSendClickedAt = ""
$script:visualIrreversibleMarkerReason = ""

function Set-VisualActionStage([string]$stage) {
  if (-not [string]::IsNullOrWhiteSpace($stage)) {
    $script:visualActionStage = $stage
  }
}

function Write-VisualResult($value) {
  if ($value -is [System.Collections.IDictionary]) {
    if (-not $value.Contains("stage")) { $value.stage = $script:visualActionStage }
    if (-not $value.Contains("sendClickedAt")) { $value.sendClickedAt = $script:visualSendClickedAt }
    if (-not $value.Contains("primaryReason")) { $value.primaryReason = [string]$value.reason }
    if (-not $value.Contains("cleanupReason")) { $value.cleanupReason = "" }
    if (-not $value.Contains("verificationMode")) { $value.verificationMode = "" }
    if (-not $value.Contains("realActionAttempted")) {
      $value.realActionAttempted = [bool]($script:visualActionAttempted -or [bool]$value.actionAttempted)
    }
  }
  $value | ConvertTo-Json -Compress -Depth 10
  exit
}

function Write-VisualCommentSendMarker($context) {
  $temporaryPath = ""
  try {
    $markerPath = [string]$context.sendMarkerPath
    $attemptKey = [string]$context.attemptKey
    $postFingerprint = [string]$context.postFingerprint
    $observationId = [string]$context.observationId
    $commentTextSha256 = [string]$context.commentTextSha256
    $avatarHash = [string]$context.postSnapshot.avatar_hash
    $identityText = [string]$context.postSnapshot.identity_text
    $stableAnchorText = [string]$context.postSnapshot.stable_anchor_text
    if ([string]::IsNullOrWhiteSpace($markerPath) -or
      $attemptKey -notmatch '^[0-9a-f]{64}$' -or
      $postFingerprint -notmatch '^[0-9a-f]{64}$' -or
      $observationId -notmatch '^[0-9a-f]{64}$' -or
      $commentTextSha256 -notmatch '^[0-9a-f]{64}$' -or
      $avatarHash -notmatch '^[0-9a-f]{64}$' -or
      [string]::IsNullOrWhiteSpace($identityText) -or
      $identityText.Length -gt 2000 -or
      $stableAnchorText.Length -gt 2000) {
      $script:visualIrreversibleMarkerReason = "moments_comment_send_marker_invalid"
      return $false
    }
    $fullPath = [IO.Path]::GetFullPath($markerPath)
    if ([IO.Path]::GetFileName($fullPath) -cne ($postFingerprint + ".json") -or
      [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($fullPath)) -cne "moments_comment_send_markers") {
      $script:visualIrreversibleMarkerReason = "moments_comment_send_marker_invalid"
      return $false
    }
    if ([IO.File]::Exists($fullPath)) {
      $script:visualIrreversibleMarkerReason = "moments_comment_send_marker_exists"
      return $false
    }
    $directory = [IO.Path]::GetDirectoryName($fullPath)
    if ([string]::IsNullOrWhiteSpace($directory)) {
      $script:visualIrreversibleMarkerReason = "moments_comment_send_marker_invalid"
      return $false
    }
    [void][IO.Directory]::CreateDirectory($directory)
    $clickedAt = [DateTime]::UtcNow.ToString("o")
    $marker = @{
      version = 1
      kind = "moments_comment_send_click"
      status = "click_attempted"
      attempt_key = $attemptKey
      post_fingerprint = $postFingerprint
      observation_id = $observationId
      comment_text_sha256 = $commentTextSha256
      avatar_hash = $avatarHash
      identity_text = $identityText
      stable_anchor_text = $stableAnchorText
      send_clicked_at = $clickedAt
    }
    $temporaryPath = $fullPath + "." + [Guid]::NewGuid().ToString("N") + ".tmp"
    [IO.File]::WriteAllText(
      $temporaryPath,
      ($marker | ConvertTo-Json -Compress -Depth 4),
      [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::Move($temporaryPath, $fullPath)
    $temporaryPath = ""
    $script:visualSendClickedAt = $clickedAt
    return $true
  } catch {
    $script:visualIrreversibleMarkerReason = "moments_comment_send_marker_failed"
    if (-not [string]::IsNullOrWhiteSpace($temporaryPath) -and [IO.File]::Exists($temporaryPath)) {
      try { [IO.File]::Delete($temporaryPath) } catch {}
    }
    return $false
  }
}

function Normalize-VisualText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  return ([Text.RegularExpressions.Regex]::Replace($value.Normalize([Text.NormalizationForm]::FormKC), "\s+", " ")).Trim()
}

function Test-VisualDeadline([int64]$deadlineMs) {
  if ($deadlineMs -le 0) { return $false }
  $epoch = [DateTime]::SpecifyKind([DateTime]"1970-01-01T00:00:00", [DateTimeKind]::Utc)
  $nowMs = [int64](([DateTime]::UtcNow - $epoch).TotalMilliseconds)
  return $nowMs -le $deadlineMs
}

function Test-VisualDeadlineMargin([int64]$deadlineMs, [int64]$requiredRemainingMs) {
  if ($deadlineMs -le 0 -or $requiredRemainingMs -lt 0) { return $false }
  $epoch = [DateTime]::SpecifyKind([DateTime]"1970-01-01T00:00:00", [DateTimeKind]::Utc)
  $nowMs = [int64](([DateTime]::UtcNow - $epoch).TotalMilliseconds)
  return ($deadlineMs - $nowMs) -ge $requiredRemainingMs
}

function Test-VisualBounds($bounds, [double]$minimumWidth = 0, [double]$minimumHeight = 0) {
  if ($bounds -eq $null) { return $false }
  foreach ($name in @("left", "top", "width", "height")) {
    $value = $bounds.$name
    if ($value -eq $null -or [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value)) { return $false }
  }
  return [double]$bounds.width -gt $minimumWidth -and [double]$bounds.height -gt $minimumHeight
}

function Test-VisualBoundsInside($inner, $outer) {
  return (Test-VisualBounds $inner) -and (Test-VisualBounds $outer) -and
    [double]$inner.left -ge [double]$outer.left -and [double]$inner.top -ge [double]$outer.top -and
    ([double]$inner.left + [double]$inner.width) -le ([double]$outer.left + [double]$outer.width) -and
    ([double]$inner.top + [double]$inner.height) -le ([double]$outer.top + [double]$outer.height)
}

function Test-VisualBoundsInsideWithTolerance($inner, $outer, [double]$tolerance) {
  if (-not (Test-VisualBounds $inner) -or -not (Test-VisualBounds $outer) -or
    [double]::IsNaN($tolerance) -or [double]::IsInfinity($tolerance) -or $tolerance -lt 0) { return $false }
  return [double]$inner.left -ge ([double]$outer.left - $tolerance) -and
    [double]$inner.top -ge ([double]$outer.top - $tolerance) -and
    ([double]$inner.left + [double]$inner.width) -le ([double]$outer.left + [double]$outer.width + $tolerance) -and
    ([double]$inner.top + [double]$inner.height) -le ([double]$outer.top + [double]$outer.height + $tolerance)
}

function Get-VisualVirtualScreenBounds {
  $left = [double][Win32WechatMomentsVisualAction]::GetSystemMetrics(76)
  $top = [double][Win32WechatMomentsVisualAction]::GetSystemMetrics(77)
  $width = [double][Win32WechatMomentsVisualAction]::GetSystemMetrics(78)
  $height = [double][Win32WechatMomentsVisualAction]::GetSystemMetrics(79)
  if ($width -le 1 -or $height -le 1) { return $null }
  return @{ left = $left; top = $top; width = $width; height = $height }
}

function Test-VisualPointInsideBoundsWithTolerance([double]$x, [double]$y, $bounds, [double]$tolerance) {
  if (-not (Test-VisualBounds $bounds) -or [double]::IsNaN($x) -or [double]::IsInfinity($x) -or
    [double]::IsNaN($y) -or [double]::IsInfinity($y) -or [double]::IsNaN($tolerance) -or
    [double]::IsInfinity($tolerance) -or $tolerance -lt 0) { return $false }
  return $x -ge ([double]$bounds.left - $tolerance) -and
    $x -lt ([double]$bounds.left + [double]$bounds.width + $tolerance) -and
    $y -ge ([double]$bounds.top - $tolerance) -and
    $y -lt ([double]$bounds.top + [double]$bounds.height + $tolerance)
}

function Test-VisualReadbackPopupGeometry($popupBounds, $lockedBounds, $virtualScreenBounds, [int]$anchorX, [int]$anchorY) {
  return (Test-VisualBounds $popupBounds 20 20) -and
    (Test-VisualBounds $lockedBounds 40 40) -and
    (Test-VisualBounds $virtualScreenBounds 40 40) -and
    (Test-VisualBoundsInsideWithTolerance $popupBounds $virtualScreenBounds 3.0) -and
    (Test-VisualPointInsideBoundsWithTolerance $anchorX $anchorY $lockedBounds 0.0) -and
    (Test-VisualPointInsideBoundsWithTolerance $anchorX $anchorY $popupBounds 3.0)
}

function Get-VisualReadbackPopupPlacement($popupBounds, $lock, [int]$anchorX, [int]$anchorY) {
  if ($lock -eq $null -or $lock.hWnd -eq [IntPtr]::Zero) {
    return @{ ok = $false; reason = "moments_comment_readback_popup_geometry_invalid" }
  }
  $lockedBounds = @{
    left = [double]$lock.windowRect.Left
    top = [double]$lock.windowRect.Top
    width = [double]($lock.windowRect.Right - $lock.windowRect.Left)
    height = [double]($lock.windowRect.Bottom - $lock.windowRect.Top)
  }
  $virtualScreenBounds = Get-VisualVirtualScreenBounds
  if (-not (Test-VisualBounds $popupBounds 20 20) -or -not (Test-VisualBounds $lockedBounds 40 40) -or
    -not (Test-VisualBounds $virtualScreenBounds 40 40)) {
    return @{ ok = $false; reason = "moments_comment_readback_popup_geometry_invalid" }
  }
  if (-not (Test-VisualBoundsInsideWithTolerance $popupBounds $virtualScreenBounds 3.0)) {
    return @{ ok = $false; reason = "moments_comment_readback_popup_outside_screen" }
  }
  if (-not (Test-VisualPointInsideBoundsWithTolerance $anchorX $anchorY $lockedBounds 0.0)) {
    return @{ ok = $false; reason = "moments_comment_readback_anchor_outside_window" }
  }
  if (-not (Test-VisualReadbackPopupGeometry $popupBounds $lockedBounds $virtualScreenBounds $anchorX $anchorY)) {
    return @{ ok = $false; reason = "moments_comment_readback_popup_not_anchored" }
  }
  return @{ ok = $true; reason = "" }
}

function Test-VisualBoundsNear($left, $right, [double]$tolerance = 1.5) {
  if (-not (Test-VisualBounds $left) -or -not (Test-VisualBounds $right)) { return $false }
  foreach ($name in @("left", "top", "width", "height")) {
    if ([Math]::Abs([double]$left.$name - [double]$right.$name) -gt $tolerance) { return $false }
  }
  return $true
}

function Resolve-VisualMenuAnchor($menus, $expectedBounds, [double]$tolerance = 12.0) {
  $ranked = @(@($menus) | Where-Object {
    Test-VisualBoundsNear $_.bounds $expectedBounds $tolerance
  } | ForEach-Object {
    $score = 0.0
    foreach ($name in @("left", "top", "width", "height")) {
      $score += [Math]::Abs([double]$_.bounds.$name - [double]$expectedBounds.$name)
    }
    @{ menu = $_; score = $score }
  } | Sort-Object { [double]$_.score })
  $distinct = New-Object System.Collections.Generic.List[object]
  foreach ($entry in $ranked) {
    $overlapsExisting = $false
    foreach ($existing in $distinct) {
      if (Test-VisualBoundsNear $entry.menu.bounds $existing.menu.bounds 2.5) {
        $overlapsExisting = $true
        break
      }
    }
    if (-not $overlapsExisting) { [void]$distinct.Add($entry) }
  }
  $diagnostics = @{
    rawCandidateCount = [int]$ranked.Count
    distinctCandidateCount = [int]$distinct.Count
    expectedBounds = $expectedBounds
    candidateBounds = @($distinct | ForEach-Object { $_.menu.bounds })
  }
  if ($distinct.Count -eq 0) {
    return @{ ok = $false; reason = "moments_menu_not_found"; diagnostics = $diagnostics }
  }
  return @{ ok = $true; menu = $distinct[0].menu; diagnostics = $diagnostics }
}

function ConvertTo-RelativeVisualBounds($absolute, $window) {
  return @{
    left = [double]$absolute.left - [double]$window.left
    top = [double]$absolute.top - [double]$window.top
    width = [double]$absolute.width
    height = [double]$absolute.height
  }
}

function Get-VisualContext {
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:XIAOXI_MOMENTS_VISUAL_CONTEXT_BASE64))
    return $json | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-LockedVisualRoot($context) {
  $expected = $context.expectedWindow
  if ($expected -eq $null -or [string]$expected.identityMode -cne "visual_mmui_render" -or
    [string]$expected.title -cne "朋友圈" -or [string]$expected.rootName -cne "朋友圈" -or
    [string]$expected.rootControlType -cne "ControlType.Window" -or [string]$expected.automationId -cne "" -or
    [string]$expected.feedAutomationId -cne "" -or [string]$expected.feedRuntimeId -cne "" -or
    [int]$expected.feedCount -ne 0 -or [string]$expected.renderPaneName -cne "MMUIRenderSubWindowHW" -or
    [string]$expected.renderPaneControlType -cne "ControlType.Pane" -or
    [string]::IsNullOrWhiteSpace([string]$expected.renderPaneRuntimeId)) {
    return @{ ok = $false; reason = "moments_visual_target_lock_invalid" }
  }
  $expectedPid = [int]$expected.pid
  $expectedHandleText = [string]$expected.hWnd
  if ($expectedPid -le 0 -or $expectedHandleText -notmatch '^[1-9][0-9]*$' -or
    [int]$expected.rootProcessId -ne $expectedPid -or [int]$expected.renderPaneProcessId -ne $expectedPid) {
    return @{ ok = $false; reason = "moments_visual_target_lock_invalid" }
  }
  $windowBounds = @{ left = [double]$expected.left; top = [double]$expected.top; width = [double]$expected.width; height = [double]$expected.height }
  if (-not (Test-VisualBounds $windowBounds 299 299) -or -not (Test-VisualBoundsInside $expected.renderPaneBounds $windowBounds)) {
    return @{ ok = $false; reason = "moments_visual_target_lock_invalid" }
  }

  $hWnd = [IntPtr][int64]$expectedHandleText
  if (-not [Win32WechatMomentsVisualAction]::IsWindowVisible($hWnd) -or [Win32WechatMomentsVisualAction]::IsIconic($hWnd)) {
    return @{ ok = $false; reason = "moments_window_not_found" }
  }
  [uint32]$actualPid = 0
  [void][Win32WechatMomentsVisualAction]::GetWindowThreadProcessId($hWnd, [ref]$actualPid)
  $process = Get-Process -Id $actualPid -ErrorAction SilentlyContinue
  if ($process -eq $null -or [int]$actualPid -ne $expectedPid -or @("Weixin", "WeChat") -notcontains $process.ProcessName -or
    [string]$process.ProcessName -cne [string]$expected.processName) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }
  $titleText = New-Object System.Text.StringBuilder 128
  [void][Win32WechatMomentsVisualAction]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
  if ($titleText.ToString().Trim() -cne "朋友圈") { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  $actualRect = New-Object Win32WechatMomentsVisualAction+RECT
  if (-not [Win32WechatMomentsVisualAction]::GetWindowRect($hWnd, [ref]$actualRect)) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }
  $actualBounds = @{
    left = [double]$actualRect.Left
    top = [double]$actualRect.Top
    width = [double]($actualRect.Right - $actualRect.Left)
    height = [double]($actualRect.Bottom - $actualRect.Top)
  }
  if (-not (Test-VisualBoundsNear $actualBounds $windowBounds 0.1)) {
    return @{ ok = $false; reason = "moments_window_changed" }
  }
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { $root = $null }
  if ($root -eq $null) { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  try {
    $rootAutomationId = [string]$root.Current.AutomationId
    $rootName = [string]$root.Current.Name
    $rootControlType = [string]$root.Current.ControlType.ProgrammaticName
    $rootProcessId = [int]$root.Current.ProcessId
  } catch { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  if ($rootAutomationId -cne "" -or $rootName -cne "朋友圈" -or $rootControlType -cne "ControlType.Window" -or
    $rootProcessId -ne $expectedPid) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }
  $feedCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    "sns_list"
  )
  $feeds = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $feedCondition)
  if ($feeds.Count -ne 0) { return @{ ok = $false; reason = "moments_visual_profile_conflict" } }
  $paneEvidence = Get-MomentsRenderPaneEvidence $root $expectedPid
  if (-not $paneEvidence.ok) { return @{ ok = $false; reason = $paneEvidence.reason } }
  if ([string]$paneEvidence.pane.name -cne [string]$expected.renderPaneName -or
    [string]$paneEvidence.pane.automationId -cne [string]$expected.renderPaneAutomationId -or
    [string]$paneEvidence.pane.controlType -cne [string]$expected.renderPaneControlType -or
    [int]$paneEvidence.pane.processId -ne [int]$expected.renderPaneProcessId -or
    [string]$paneEvidence.pane.runtimeId -cne [string]$expected.renderPaneRuntimeId -or
    -not (Test-VisualBoundsNear $paneEvidence.pane.bounds $expected.renderPaneBounds 1.5)) {
    return @{ ok = $false; reason = "moments_render_pane_changed" }
  }
  return @{
    ok = $true
    hWnd = $hWnd
    pid = $expectedPid
    root = $root
    windowRect = $actualRect
    windowBounds = $actualBounds
  }
}

function Test-MomentsStablePostIdentity($post, $snapshot) {
  return Test-MomentsStablePostIdentityText ([string]$post.identityText) ([string]$snapshot.identity_text) ([string]$post.stableAnchorText) ([string]$snapshot.stable_anchor_text)
}

function Get-CurrentLockedVisualPost($lock, $context, [bool]$activate = $true) {
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $activate $false
  if (-not $frame.ok) { return @{ ok = $false; reason = $frame.reason } }
  try {
    $expectedRenderPaneBounds = ConvertTo-RelativeVisualBounds $context.expectedWindow.renderPaneBounds $context.expectedWindow
    $read = Get-MomentsVisualPostCandidates $frame $expectedRenderPaneBounds
    $posts = @($read.posts)
    if ($posts.Count -eq 0) { return @{ ok = $false; reason = "moments_post_not_found"; frame = $frame } }
    $snapshot = $context.postSnapshot
    $expectedBounds = ConvertTo-RelativeVisualBounds $snapshot.bounds $context.expectedWindow
    $expectedMenuBounds = ConvertTo-RelativeVisualBounds $snapshot.menu_bounds $context.expectedWindow
    $expectedAvatarBounds = ConvertTo-RelativeVisualBounds $snapshot.avatar_bounds $context.expectedWindow
    $matchingPosts = New-Object System.Collections.Generic.List[object]
    foreach ($post in $posts) {
      if (-not (Test-MomentsStablePostIdentity $post $snapshot) -or
        [string]$post.avatarHash -cne [string]$snapshot.avatar_hash -or
        -not (Test-VisualBoundsNear $post.bounds $expectedBounds $script:momentsVisualPostRelockTolerancePx) -or
        -not (Test-VisualBoundsNear $post.menuBounds $expectedMenuBounds $script:momentsVisualPostRelockTolerancePx) -or
        -not (Test-VisualBoundsNear $post.avatarBounds $expectedAvatarBounds $script:momentsVisualPostRelockTolerancePx)) { continue }
      [void]$matchingPosts.Add($post)
    }
    if ($matchingPosts.Count -eq 0) { return @{ ok = $false; reason = "moments_post_changed"; frame = $frame } }
    if ($matchingPosts.Count -ne 1) { return @{ ok = $false; reason = "moments_post_ambiguous"; frame = $frame } }
    $post = $matchingPosts[0]
    $menuBottom = [double]$post.menuBounds.top + [double]$post.menuBounds.height
    # The nearest menu below the locked post determines which visual post is
    # actually next. Its avatar may prove the boundary without requiring OCR
    # on that post; if the nearest menu has no unique avatar, keep the region
    # incomplete instead of skipping across it to a later OCR-readable post.
    $followingBoundaries = @($read.postBoundaries | Where-Object {
      [double]$_.menuBounds.top -gt ($menuBottom + 8.0)
    } | Sort-Object { [double]$_.menuBounds.top })
    $nextPostTop = $(if ($followingBoundaries.Count -gt 0 -and
      [bool]$followingBoundaries[0].ok -and
      [double]$followingBoundaries[0].top -gt ($menuBottom + 8.0)) {
      [double]$followingBoundaries[0].top
    } else {
      $null
    })
    $menuResolution = Resolve-VisualMenuAnchor $read.menus $post.menuBounds 1.5
    if (-not $menuResolution.ok) {
      return @{
        ok = $false
        reason = $menuResolution.reason
        diagnostics = $menuResolution.diagnostics
        frame = $frame
      }
    }
    $menuHash = Get-MomentsPixelHash $frame $menuResolution.menu.bounds
    $avatarHash = Get-MomentsPixelHash $frame $post.avatarBounds
    if (-not $menuHash -or -not $avatarHash) { return @{ ok = $false; reason = "moments_post_changed"; frame = $frame } }
    return @{
      ok = $true
      frame = $frame
      post = $post
      menu = $menuResolution.menu
      menuHash = $menuHash
      avatarHash = $avatarHash
      expectedMenuBounds = $expectedMenuBounds
      expectedAvatarBounds = $expectedAvatarBounds
      nextPostTop = $nextPostTop
    }
  } catch {
    return @{ ok = $false; reason = "moments_visual_probe_failed"; frame = $frame }
  }
}

function Get-FreshVisualMenuAnchor($lock, $expectedMenuBounds, [string]$expectedHash, [bool]$activate = $false) {
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $activate $false
    if (-not $frame.ok) { return @{ ok = $false; reason = $frame.reason } }
    try {
      $menus = @(Find-MomentsMenuDots $frame)
      $resolution = Resolve-VisualMenuAnchor $menus $expectedMenuBounds $script:momentsVisualPostRelockTolerancePx
      if (-not $resolution.ok) {
        if ([string]$resolution.reason -ceq "moments_menu_not_found" -and $attempt -eq 0) {
          Close-MomentsVisualFrame $frame
          $frame = $null
          Start-Sleep -Milliseconds 160
          continue
        }
        return @{
          ok = $false
          reason = $resolution.reason
          diagnostics = $resolution.diagnostics
          frame = $frame
        }
      }
      $hash = Get-MomentsPixelHash $frame $resolution.menu.bounds
      if (-not $hash -or ($expectedHash -and $hash -cne $expectedHash)) {
        return @{ ok = $false; reason = "moments_menu_changed"; frame = $frame }
      }
      return @{
        ok = $true
        frame = $frame
        menu = $resolution.menu
        menuHash = $hash
        diagnostics = $resolution.diagnostics
      }
    } catch {
      return @{ ok = $false; reason = "moments_visual_probe_failed"; frame = $frame }
    }
  }
}

function Test-VisualOwnedHitDetailed([IntPtr]$hit, [int]$screenX, [int]$screenY, $lock, $allowedPopupBounds = $null) {
  $diagnostics = @{
    pointInsideSurface = $false
    surfaceInsidePopup = $false
    surfaceInsideWindow = $false
  }
  if ($hit -eq [IntPtr]::Zero) {
    return @{ ok = $false; reason = "moments_click_target_missing"; diagnostics = $diagnostics }
  }
  [uint32]$hitPid = 0
  [void][Win32WechatMomentsVisualAction]::GetWindowThreadProcessId($hit, [ref]$hitPid)
  if ([int]$hitPid -ne [int]$lock.pid) {
    return @{ ok = $false; reason = "moments_click_target_process_changed"; diagnostics = $diagnostics }
  }
  $hitRoot = [Win32WechatMomentsVisualAction]::GetAncestor($hit, 2)
  if ($hitRoot -eq [IntPtr]::Zero -or
    -not [Win32WechatMomentsVisualAction]::IsWindowVisible($hitRoot) -or
    [Win32WechatMomentsVisualAction]::IsIconic($hitRoot)) {
    return @{ ok = $false; reason = "moments_click_target_not_visible"; diagnostics = $diagnostics }
  }
  [uint32]$rootPid = 0
  [void][Win32WechatMomentsVisualAction]::GetWindowThreadProcessId($hitRoot, [ref]$rootPid)
  if ([int]$rootPid -ne [int]$lock.pid) {
    return @{ ok = $false; reason = "moments_click_root_process_changed"; diagnostics = $diagnostics }
  }

  $lockedBounds = @{
    left = [double]$lock.windowRect.Left
    top = [double]$lock.windowRect.Top
    width = [double]($lock.windowRect.Right - $lock.windowRect.Left)
    height = [double]($lock.windowRect.Bottom - $lock.windowRect.Top)
  }
  if ($allowedPopupBounds -eq $null) {
    if ($hitRoot -ne $lock.hWnd) {
      return @{ ok = $false; reason = "moments_click_popup_surface_missing"; diagnostics = $diagnostics }
    }
    $diagnostics.pointInsideSurface = $true
    $diagnostics.surfaceInsidePopup = $true
    $diagnostics.surfaceInsideWindow = $true
    return @{ ok = $true; root = $hitRoot; diagnostics = $diagnostics }
  }

  $expectedSurface = @{
    left = [double]$lock.windowRect.Left + [double]$allowedPopupBounds.left
    top = [double]$lock.windowRect.Top + [double]$allowedPopupBounds.top
    width = [double]$allowedPopupBounds.width
    height = [double]$allowedPopupBounds.height
  }
  if ($hitRoot -eq $lock.hWnd) {
    $popupBounds = $lockedBounds
  } else {
    $popupRect = New-Object Win32WechatMomentsVisualAction+RECT
    if (-not [Win32WechatMomentsVisualAction]::GetWindowRect($hitRoot, [ref]$popupRect)) {
      return @{ ok = $false; reason = "moments_click_popup_bounds_unavailable"; diagnostics = $diagnostics }
    }
    $popupBounds = @{
      left = [double]$popupRect.Left
      top = [double]$popupRect.Top
      width = [double]($popupRect.Right - $popupRect.Left)
      height = [double]($popupRect.Bottom - $popupRect.Top)
    }
  }
  $diagnostics.surfaceInsidePopup = [double]$expectedSurface.left -ge ([double]$popupBounds.left - 3.0) -and
    [double]$expectedSurface.top -ge ([double]$popupBounds.top - 2.0) -and
    ([double]$expectedSurface.left + [double]$expectedSurface.width) -le ([double]$popupBounds.left + [double]$popupBounds.width + 3.0) -and
    ([double]$expectedSurface.top + [double]$expectedSurface.height) -le ([double]$popupBounds.top + [double]$popupBounds.height + 3.0)
  $diagnostics.pointInsideSurface = $screenX -ge ([double]$expectedSurface.left - 2.0) -and
    $screenX -le ([double]$expectedSurface.left + [double]$expectedSurface.width + 2.0) -and
    $screenY -ge ([double]$expectedSurface.top - 2.0) -and
    $screenY -le ([double]$expectedSurface.top + [double]$expectedSurface.height + 2.0)
  $diagnostics.surfaceInsideWindow = Test-VisualBoundsInside $expectedSurface $lockedBounds
  if (-not $diagnostics.surfaceInsideWindow) {
    return @{ ok = $false; reason = "moments_click_surface_outside_window"; root = $hitRoot; diagnostics = $diagnostics }
  }
  if (-not $diagnostics.surfaceInsidePopup) {
    return @{ ok = $false; reason = "moments_click_surface_outside_popup"; root = $hitRoot; diagnostics = $diagnostics }
  }
  if (-not $diagnostics.pointInsideSurface) {
    return @{ ok = $false; reason = "moments_click_point_outside_surface"; root = $hitRoot; diagnostics = $diagnostics }
  }
  return @{ ok = $true; root = $hitRoot; diagnostics = $diagnostics }
}

function Test-VisualOwnedHit([IntPtr]$hit, [int]$screenX, [int]$screenY, $lock, $allowedPopupBounds = $null) {
  return [bool](Test-VisualOwnedHitDetailed $hit $screenX $screenY $lock $allowedPopupBounds).ok
}

function Invoke-VisualOwnedClickDetailed(
  [int]$screenX,
  [int]$screenY,
  $lock,
  [int64]$deadlineMs,
  [bool]$irreversible,
  [bool]$enforceDeadline,
  $allowedPopupBounds = $null,
  [uint32]$expectedInputTick = [uint32]::MaxValue,
  [scriptblock]$beforeIrreversibleClick = $null
) {
  $diagnostics = @{
    ownedClickReason = ""
    ownedClickPhase = "preflight"
    pointInsideSurface = $false
    surfaceInsidePopup = $false
    surfaceInsideWindow = $false
    firstRootMatchesSecond = $false
    foregroundOk = $false
  }
  if ($expectedInputTick -ne [uint32]::MaxValue -and
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) {
    $diagnostics.ownedClickReason = "moments_external_input_detected"
    return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
  }
  $point = New-Object Win32WechatMomentsVisualAction+POINT
  $point.X = $screenX
  $point.Y = $screenY
  $hit = [Win32WechatMomentsVisualAction]::WindowFromPoint($point)
  $firstProof = Test-VisualOwnedHitDetailed $hit $screenX $screenY $lock $allowedPopupBounds
  foreach ($name in @("pointInsideSurface", "surfaceInsidePopup", "surfaceInsideWindow")) {
    $diagnostics[$name] = [bool]$firstProof.diagnostics.$name
  }
  if (-not $firstProof.ok) {
    $diagnostics.ownedClickReason = [string]$firstProof.reason
    $diagnostics.ownedClickPhase = "initial_hit"
    return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
  }
  $foreground = [Win32WechatMomentsVisualAction]::GetForegroundWindow()
  $diagnostics.foregroundOk = $foreground -eq $lock.hWnd -or $foreground -eq $firstProof.root
  if (-not $diagnostics.foregroundOk) {
    $diagnostics.ownedClickReason = "moments_click_foreground_changed"
    return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
  }
  if (-not [Win32WechatMomentsVisualAction]::SetCursorPos($screenX, $screenY)) {
    $diagnostics.ownedClickReason = "moments_click_cursor_move_failed"
    $diagnostics.ownedClickPhase = "cursor_move"
    return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
  }
  Start-Sleep -Milliseconds 20
  $confirmedHit = [Win32WechatMomentsVisualAction]::WindowFromPoint($point)
  $secondProof = Test-VisualOwnedHitDetailed $confirmedHit $screenX $screenY $lock $allowedPopupBounds
  foreach ($name in @("pointInsideSurface", "surfaceInsidePopup", "surfaceInsideWindow")) {
    $diagnostics[$name] = [bool]$secondProof.diagnostics.$name
  }
  $diagnostics.firstRootMatchesSecond = $secondProof.ok -and $secondProof.root -eq $firstProof.root
  $foreground = [Win32WechatMomentsVisualAction]::GetForegroundWindow()
  $diagnostics.foregroundOk = $foreground -eq $lock.hWnd -or $foreground -eq $firstProof.root
  if (-not $secondProof.ok -or -not $diagnostics.firstRootMatchesSecond) {
    $diagnostics.ownedClickReason = $(if (-not $secondProof.ok) { [string]$secondProof.reason } else { "moments_click_target_changed" })
    $diagnostics.ownedClickPhase = "confirmed_hit"
    return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
  }
  if (-not $diagnostics.foregroundOk) {
    $diagnostics.ownedClickReason = "moments_click_foreground_changed"
    $diagnostics.ownedClickPhase = "confirmed_hit"
    return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
  }
  if ($expectedInputTick -ne [uint32]::MaxValue -and
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) {
    $diagnostics.ownedClickReason = "moments_external_input_detected"
    $diagnostics.ownedClickPhase = "confirmed_hit"
    return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
  }
  if ($enforceDeadline -and -not (Test-VisualDeadline $deadlineMs)) {
    $diagnostics.ownedClickReason = "moments_dry_run_expired"
    $diagnostics.ownedClickPhase = "deadline"
    return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
  }
  if ($irreversible -and $beforeIrreversibleClick -ne $null) {
    try {
      if (-not (& $beforeIrreversibleClick)) {
        $diagnostics.ownedClickReason = "moments_click_marker_failed"
        $diagnostics.ownedClickPhase = "before_irreversible"
        return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
      }
    } catch {
      $diagnostics.ownedClickReason = "moments_click_marker_failed"
      $diagnostics.ownedClickPhase = "before_irreversible"
      return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
    }
  }
  if ($irreversible) { $script:visualActionAttempted = $true }
  $clicked = [Win32WechatMomentsVisualAction]::AtomicMouseClick($screenX, $screenY, $false)
  if (-not $clicked) {
    $diagnostics.ownedClickReason = "moments_click_injection_failed"
    $diagnostics.ownedClickPhase = "atomic_click"
    return @{ ok = $false; reason = $diagnostics.ownedClickReason; diagnostics = $diagnostics }
  }
  $diagnostics.ownedClickPhase = "clicked"
  return @{ ok = $true; diagnostics = $diagnostics }
}

function Invoke-VisualOwnedClick(
  [int]$screenX,
  [int]$screenY,
  $lock,
  [int64]$deadlineMs,
  [bool]$irreversible,
  [bool]$enforceDeadline,
  $allowedPopupBounds = $null,
  [uint32]$expectedInputTick = [uint32]::MaxValue,
  [scriptblock]$beforeIrreversibleClick = $null
) {
  $result = Invoke-VisualOwnedClickDetailed $screenX $screenY $lock $deadlineMs $irreversible $enforceDeadline $allowedPopupBounds $expectedInputTick $beforeIrreversibleClick
  return [bool]$result.ok
}

function Test-VisualOwnedKeyboardTarget($lock, $composerBounds, [uint32]$expectedInputTick) {
  try {
    if ($lock -eq $null -or $lock.windowRect -eq $null -or
      -not (Test-VisualBounds $composerBounds 40 40) -or
      $expectedInputTick -eq [uint32]::MaxValue -or
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
      [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick -or
      -not [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd) -or
      [Win32WechatMomentsVisualAction]::IsIconic($lock.hWnd)) { return $false }
    $currentRect = New-Object Win32WechatMomentsVisualAction+RECT
    [uint32]$currentPid = 0
    if (-not [Win32WechatMomentsVisualAction]::GetWindowRect($lock.hWnd, [ref]$currentRect) -or
      [Win32WechatMomentsVisualAction]::GetWindowThreadProcessId($lock.hWnd, [ref]$currentPid) -eq 0 -or
      [int]$currentPid -ne [int]$lock.pid -or
      $currentRect.Left -ne $lock.windowRect.Left -or $currentRect.Top -ne $lock.windowRect.Top -or
      $currentRect.Right -ne $lock.windowRect.Right -or $currentRect.Bottom -ne $lock.windowRect.Bottom) { return $false }
    $focusX = [int][Math]::Round([double]$currentRect.Left + [double]$composerBounds.left + ([double]$composerBounds.width * 0.22))
    $focusY = [int][Math]::Round([double]$currentRect.Top + [double]$composerBounds.top + ([double]$composerBounds.height * 0.28))
    $point = New-Object Win32WechatMomentsVisualAction+POINT
    $point.X = $focusX
    $point.Y = $focusY
    if (-not (Test-VisualOwnedHit ([Win32WechatMomentsVisualAction]::WindowFromPoint($point)) $focusX $focusY $lock)) { return $false }
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    return $focused -ne $null -and [int]$focused.Current.ProcessId -eq [int]$lock.pid -and
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -eq $lock.hWnd -and
      [Win32WechatMomentsVisualAction]::GetLastInputTick() -eq $expectedInputTick
  } catch {}
  return $false
}

function Focus-VisualCommentKeyboardTarget($lock, $composerBounds, [int64]$deadlineMs, [uint32]$expectedInputTick) {
  if ($expectedInputTick -eq [uint32]::MaxValue -or -not (Test-VisualBounds $composerBounds 40 40)) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  $focusX = [int][Math]::Round([double]$lock.windowRect.Left + [double]$composerBounds.left + ([double]$composerBounds.width * 0.22))
  $focusY = [int][Math]::Round([double]$lock.windowRect.Top + [double]$composerBounds.top + ([double]$composerBounds.height * 0.28))
  if (-not (Invoke-VisualOwnedClick $focusX $focusY $lock $deadlineMs $false $true $null $expectedInputTick)) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  Start-Sleep -Milliseconds 90
  [uint32]$focusedInputTick = [Win32WechatMomentsVisualAction]::GetLastInputTick()
  if (-not (Test-VisualOwnedKeyboardTarget $lock $composerBounds $focusedInputTick)) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  return @{ ok = $true; inputTick = $focusedInputTick }
}

function Invoke-VisualOwnedKeyboardChord(
  $lock,
  $composerBounds,
  [uint32]$expectedInputTick,
  [uint16]$key,
  [bool]$verifyClipboard = $false,
  [uint32]$expectedClipboardSequence = 0,
  [bool]$expectedClipboardEmpty = $false,
  [string]$expectedClipboardText = ""
) {
  [uint32]$verifiedClipboardSequence = $expectedClipboardSequence
  if (@([uint16]0x41, [uint16]0x43, [uint16]0x56) -notcontains $key -or
    -not (Test-VisualOwnedKeyboardTarget $lock $composerBounds $expectedInputTick)) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  if ($verifyClipboard) {
    $clipboardMatches = $false
    if (-not [Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
      $expectedClipboardSequence,
      $expectedClipboardEmpty,
      $expectedClipboardText,
      [ref]$clipboardMatches
    ) -or -not $clipboardMatches) {
      [uint32]$currentClipboardSequence = [Win32WechatMomentsVisualAction]::GetClipboardSequenceNumber()
      $currentClipboardMatches = $false
      if (-not [Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
        $currentClipboardSequence,
        $expectedClipboardEmpty,
        $expectedClipboardText,
        [ref]$currentClipboardMatches
      ) -or -not $currentClipboardMatches) {
        return @{ ok = $false; reason = "moments_comment_clipboard_changed" }
      }
      $verifiedClipboardSequence = $currentClipboardSequence
    }
  }
  if (-not [Win32WechatMomentsVisualAction]::AtomicKeyboardChord([uint16]0x11, $key)) {
    return @{
      ok = $false
      reason = "moments_comment_keyboard_input_blocked"
      inputMayHaveBeenIssued = $true
      clipboardSequence = $verifiedClipboardSequence
    }
  }
  Start-Sleep -Milliseconds 90
  [uint32]$nextInputTick = [Win32WechatMomentsVisualAction]::GetLastInputTick()
  if (-not (Test-VisualOwnedKeyboardTarget $lock $composerBounds $nextInputTick)) {
    return @{
      ok = $false
      reason = "moments_comment_editor_changed"
      inputMayHaveBeenIssued = $true
      inputTick = $nextInputTick
      clipboardSequence = $verifiedClipboardSequence
    }
  }
  return @{
    ok = $true
    inputTick = $nextInputTick
    inputMayHaveBeenIssued = $true
    clipboardSequence = $verifiedClipboardSequence
  }
}

function Invoke-VisualOwnedUnicodeText($lock, $composerBounds, [uint32]$expectedInputTick, [string]$text) {
  if ([string]::IsNullOrEmpty($text) -or $text.Length -gt 500 -or
    -not (Test-VisualOwnedKeyboardTarget $lock $composerBounds $expectedInputTick)) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  if (-not [Win32WechatMomentsVisualAction]::AtomicKeyboardUnicodeText($text)) {
    return @{ ok = $false; reason = "moments_comment_keyboard_input_blocked"; inputMayHaveBeenIssued = $true }
  }
  Start-Sleep -Milliseconds 140
  [uint32]$nextInputTick = [Win32WechatMomentsVisualAction]::GetLastInputTick()
  if (-not (Test-VisualOwnedKeyboardTarget $lock $composerBounds $nextInputTick)) {
    return @{
      ok = $false
      reason = "moments_comment_editor_changed"
      inputMayHaveBeenIssued = $true
      inputTick = $nextInputTick
    }
  }
  return @{ ok = $true; inputTick = $nextInputTick; inputMayHaveBeenIssued = $true }
}

function Invoke-VisualOwnedKeyboardBackspace($lock, $composerBounds, [uint32]$expectedInputTick) {
  if (-not (Test-VisualOwnedKeyboardTarget $lock $composerBounds $expectedInputTick)) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  if (-not [Win32WechatMomentsVisualAction]::AtomicKeyboardBackspace()) {
    return @{ ok = $false; reason = "moments_comment_keyboard_clear_failed" }
  }
  Start-Sleep -Milliseconds 120
  [uint32]$nextInputTick = [Win32WechatMomentsVisualAction]::GetLastInputTick()
  # WeChat may briefly transfer foreground/focus when the editor becomes empty.
  # The following visual frames still lock the exact window, composer, post anchor
  # and input tick; the dismiss click also fails closed unless that window is active.
  return @{ ok = $true; inputTick = $nextInputTick }
}

function Get-VisualEpochMs {
  $epoch = [DateTime]::SpecifyKind([DateTime]"1970-01-01T00:00:00", [DateTimeKind]::Utc)
  return [int64](([DateTime]::UtcNow - $epoch).TotalMilliseconds)
}

function Invoke-VisualOwnedRightClick([int]$screenX, [int]$screenY, $lock, [int64]$deadlineMs, [uint32]$expectedInputTick) {
  if ($expectedInputTick -eq [uint32]::MaxValue -or
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick -or
    -not (Test-VisualDeadline $deadlineMs)) { return $false }
  $point = New-Object Win32WechatMomentsVisualAction+POINT
  $point.X = $screenX
  $point.Y = $screenY
  $hit = [Win32WechatMomentsVisualAction]::WindowFromPoint($point)
  if (-not (Test-VisualOwnedHit $hit $screenX $screenY $lock) -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick -or
    -not [Win32WechatMomentsVisualAction]::SetCursorPos($screenX, $screenY)) { return $false }
  Start-Sleep -Milliseconds 30
  $actualPoint = New-Object Win32WechatMomentsVisualAction+POINT
  if (-not [Win32WechatMomentsVisualAction]::GetCursorPos([ref]$actualPoint) -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick -or
    $actualPoint.X -ne $screenX -or $actualPoint.Y -ne $screenY) { return $false }
  $confirmedHit = [Win32WechatMomentsVisualAction]::WindowFromPoint($actualPoint)
  if (-not (Test-VisualOwnedHit $confirmedHit $actualPoint.X $actualPoint.Y $lock) -or
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick -or
    -not (Test-VisualDeadline $deadlineMs)) { return $false }
  return [Win32WechatMomentsVisualAction]::AtomicMouseClick($screenX, $screenY, $true)
}

function Get-VisualProcessWindows([int]$expectedPid) {
  $windows = New-Object System.Collections.Generic.List[object]
  $callback = [Win32WechatMomentsVisualAction+EnumWindowsProc]{
    param([IntPtr]$handle, [IntPtr]$lParam)
    [uint32]$windowPid = 0
    [void][Win32WechatMomentsVisualAction]::GetWindowThreadProcessId($handle, [ref]$windowPid)
    if ([int]$windowPid -ne $expectedPid -or -not [Win32WechatMomentsVisualAction]::IsWindowVisible($handle) -or
      [Win32WechatMomentsVisualAction]::IsIconic($handle)) { return $true }
    $rect = New-Object Win32WechatMomentsVisualAction+RECT
    if (-not [Win32WechatMomentsVisualAction]::GetWindowRect($handle, [ref]$rect) -or
      $rect.Right -le $rect.Left -or $rect.Bottom -le $rect.Top) { return $true }
    $classText = New-Object System.Text.StringBuilder 128
    $titleText = New-Object System.Text.StringBuilder 128
    [void][Win32WechatMomentsVisualAction]::GetClassName($handle, $classText, $classText.Capacity)
    [void][Win32WechatMomentsVisualAction]::GetWindowText($handle, $titleText, $titleText.Capacity)
    [void]$windows.Add(@{
      hWnd = $handle
      hWndText = [string]$handle.ToInt64()
      pid = [int]$windowPid
      className = $classText.ToString()
      title = $titleText.ToString().Trim()
      owner = [Win32WechatMomentsVisualAction]::GetWindow($handle, 4)
      bounds = @{
        left = [double]$rect.Left
        top = [double]$rect.Top
        width = [double]($rect.Right - $rect.Left)
        height = [double]($rect.Bottom - $rect.Top)
      }
    })
    return $true
  }
  [void][Win32WechatMomentsVisualAction]::EnumWindows($callback, [IntPtr]::Zero)
  return @($windows.ToArray())
}

function Get-VisualSafeReadbackPopup($lock, $beforeHandles, [int]$anchorX, [int]$anchorY, [int64]$deadlineMs) {
  $lastCandidates = @()
  $lastSignature = ""
  $stableCount = 0
  $ownerVerified = $false
  for ($attempt = 0; $attempt -lt 14; $attempt++) {
    if (-not (Test-VisualDeadline $deadlineMs)) {
      return @{ ok = $false; reason = "moments_comment_readback_popup_timeout"; candidates = $lastCandidates; ownerVerified = $ownerVerified; stable = $false; placementAnchored = $false }
    }
    $after = @(Get-VisualProcessWindows $lock.pid)
    $newWindows = @($after | Where-Object { $beforeHandles -notcontains [string]$_.hWndText })
    $lastCandidates = $newWindows
    if ($newWindows.Count -gt 1) {
      return @{ ok = $false; reason = "moments_comment_readback_popup_ambiguous"; popupCount = $newWindows.Count; candidates = $newWindows }
    }
    if ($newWindows.Count -eq 1) {
      $popup = $newWindows[0]
      if ([int]$popup.pid -ne [int]$lock.pid -or
        [string]$popup.className -cne "Qt51514QWindowToolSaveBits" -or
        [string]$popup.title -cne "Weixin" -or
        $popup.owner -ne $lock.hWnd) {
        return @{ ok = $false; reason = "moments_comment_readback_popup_not_owned"; popup = $popup; candidates = $newWindows; ownerVerified = $false; stable = $false; placementAnchored = $false }
      }
      $ownerVerified = $true
      $signature = [string]$popup.hWndText + ":" + [string]$popup.bounds.left + ":" +
        [string]$popup.bounds.top + ":" + [string]$popup.bounds.width + ":" + [string]$popup.bounds.height
      if ($signature -ceq $lastSignature) { $stableCount++ }
      else { $lastSignature = $signature; $stableCount = 1 }
      if ($stableCount -ge 2) {
        $placement = Get-VisualReadbackPopupPlacement $popup.bounds $lock $anchorX $anchorY
        if (-not $placement.ok) {
          return @{ ok = $false; reason = $placement.reason; popup = $popup; candidates = $newWindows; ownerVerified = $true; stable = $true; placementAnchored = $false }
        }
        return @{ ok = $true; popup = $popup; candidates = $newWindows; ownerVerified = $true; stable = $true; placementAnchored = $true }
      }
    } else {
      $lastSignature = ""
      $stableCount = 0
    }
    Start-Sleep -Milliseconds 35
  }
  return @{ ok = $false; reason = "moments_comment_readback_popup_missing"; popupCount = $lastCandidates.Count; candidates = $lastCandidates; ownerVerified = $ownerVerified; stable = $false; placementAnchored = $false }
}

function Get-VisualScreenFrame($bounds) {
  if (-not (Test-VisualBounds $bounds 20 20)) { return @{ ok = $false; reason = "moments_comment_readback_popup_invalid" } }
  $width = [int][Math]::Round([double]$bounds.width)
  $height = [int][Math]::Round([double]$bounds.height)
  $bitmap = $null
  $graphics = $null
  try {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen([int]$bounds.left, [int]$bounds.top, 0, 0, [System.Drawing.Size]::new($width, $height), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $lockRect = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
    $bitmapData = $bitmap.LockBits($lockRect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $stride = [Math]::Abs([int]$bitmapData.Stride)
      $bytes = New-Object byte[] ($stride * $height)
      [System.Runtime.InteropServices.Marshal]::Copy($bitmapData.Scan0, $bytes, 0, $bytes.Length)
    } finally {
      $bitmap.UnlockBits($bitmapData)
    }
    return @{ ok = $true; bitmap = $bitmap; bytes = $bytes; stride = $stride; width = $width; height = $height; screenLeft = [int]$bounds.left; screenTop = [int]$bounds.top }
  } catch {
    if ($bitmap) { $bitmap.Dispose() }
    return @{ ok = $false; reason = "moments_comment_readback_popup_capture_failed" }
  } finally {
    if ($graphics) { $graphics.Dispose() }
  }
}

function Get-VisualExactCommentMenuObservation($frame) {
  $region = @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
  $raw = Get-MomentsOcrObservation $frame $region
  $scaled = Get-MomentsScaledOcrObservation $frame $region 4
  if (-not $raw.ok -or -not $scaled.ok) {
    return @{ ok = $false; reason = "moments_comment_readback_menu_ocr_failed" }
  }
  $entries = @{}
  foreach ($label in @("复制", "搜一搜", "删除")) {
    $rawMatches = @($raw.lines | Where-Object { [string]$_.text -ceq $label })
    $scaledMatches = @($scaled.lines | Where-Object { [string]$_.text -ceq $label })
    if ($rawMatches.Count -ne 1 -or $scaledMatches.Count -ne 1 -or
      -not (Test-VisualBounds $rawMatches[0].bounds 2 2) -or
      -not (Test-VisualBounds $scaledMatches[0].bounds 2 2) -or
      -not (Test-VisualBoundsNear $rawMatches[0].bounds $scaledMatches[0].bounds 4.0)) {
      return @{ ok = $false; reason = "moments_comment_readback_menu_labels_ambiguous" }
    }
    $entries[$label] = $scaledMatches[0]
  }
  $copy = $entries["复制"]
  $search = $entries["搜一搜"]
  $delete = $entries["删除"]
  $copyCenterY = [double]$copy.bounds.top + ([double]$copy.bounds.height / 2.0)
  $searchCenterY = [double]$search.bounds.top + ([double]$search.bounds.height / 2.0)
  $deleteCenterY = [double]$delete.bounds.top + ([double]$delete.bounds.height / 2.0)
  if ($copyCenterY -ge ([double]$frame.height * 0.34) -or
    $searchCenterY -le $copyCenterY -or $deleteCenterY -le $searchCenterY -or
    $deleteCenterY -le ([double]$frame.height * 0.58) -or
    [Math]::Abs([double]$copy.bounds.left - [double]$search.bounds.left) -gt 12.0 -or
    [Math]::Abs([double]$copy.bounds.left - [double]$delete.bounds.left) -gt 12.0) {
    return @{ ok = $false; reason = "moments_comment_readback_menu_geometry_invalid" }
  }
  return @{ ok = $true; copy = $copy; search = $search; delete = $delete }
}

function Get-VisualExactCopyEntry($popup) {
  $firstFrame = Get-VisualScreenFrame $popup.bounds
  if (-not $firstFrame.ok) { return $firstFrame }
  try {
    $firstMenu = Get-VisualExactCommentMenuObservation $firstFrame
    if (-not $firstMenu.ok) { return $firstMenu }
    $firstBounds = $firstMenu.copy.bounds
    $firstHash = Get-MomentsPixelHash $firstFrame $firstBounds
    $firstPopupHash = Get-MomentsPixelHash $firstFrame @{ left = 0.0; top = 0.0; width = [double]$firstFrame.width; height = [double]$firstFrame.height }
  } finally {
    Close-MomentsVisualFrame $firstFrame
  }
  Start-Sleep -Milliseconds 90
  $secondFrame = Get-VisualScreenFrame $popup.bounds
  if (-not $secondFrame.ok) { return $secondFrame }
  try {
    $secondMenu = Get-VisualExactCommentMenuObservation $secondFrame
    if (-not $secondMenu.ok -or
      -not (Test-VisualBoundsNear $secondMenu.copy.bounds $firstMenu.copy.bounds 3.0) -or
      -not (Test-VisualBoundsNear $secondMenu.search.bounds $firstMenu.search.bounds 3.0) -or
      -not (Test-VisualBoundsNear $secondMenu.delete.bounds $firstMenu.delete.bounds 3.0)) {
      return @{ ok = $false; reason = "moments_comment_readback_copy_entry_changed" }
    }
    $secondHash = Get-MomentsPixelHash $secondFrame $secondMenu.copy.bounds
    $secondPopupHash = Get-MomentsPixelHash $secondFrame @{ left = 0.0; top = 0.0; width = [double]$secondFrame.width; height = [double]$secondFrame.height }
    if (-not $firstHash -or -not $secondHash -or $secondHash -cne $firstHash -or
      -not $firstPopupHash -or -not $secondPopupHash -or $secondPopupHash -cne $firstPopupHash) {
      return @{ ok = $false; reason = "moments_comment_readback_copy_entry_changed" }
    }
    return @{ ok = $true; bounds = $secondMenu.copy.bounds; pixelHash = $secondHash }
  } finally {
    Close-MomentsVisualFrame $secondFrame
  }
}

function Test-VisualReadbackPopupSnapshot($popup, $lock) {
  if ($popup -eq $null -or -not [Win32WechatMomentsVisualAction]::IsWindowVisible($popup.hWnd) -or
    [Win32WechatMomentsVisualAction]::IsIconic($popup.hWnd)) { return $false }
  $windows = @(Get-VisualProcessWindows $lock.pid)
  $windowMatches = @($windows | Where-Object { [string]$_.hWndText -ceq [string]$popup.hWndText })
  if ($windowMatches.Count -ne 1) { return $false }
  $current = $windowMatches[0]
  return [string]$current.className -ceq "Qt51514QWindowToolSaveBits" -and
    [string]$current.title -ceq "Weixin" -and $current.owner -eq $lock.hWnd -and
    (Test-VisualBoundsNear $current.bounds $popup.bounds 0.1)
}

function Test-VisualOwnedPopupCopyTarget([int]$screenX, [int]$screenY, $expectedCopyBounds, $popup, $lock, [int64]$deadlineMs) {
  if (-not (Test-VisualDeadline $deadlineMs) -or -not (Test-VisualReadbackPopupSnapshot $popup $lock) -or
    -not (Test-VisualBounds $expectedCopyBounds 2 2)) { return $false }
  $frame = Get-VisualScreenFrame $popup.bounds
  if (-not $frame.ok) { return $false }
  try {
    $freshMenu = Get-VisualExactCommentMenuObservation $frame
    if (-not $freshMenu.ok -or -not (Test-VisualBoundsNear $freshMenu.copy.bounds $expectedCopyBounds 3.0)) {
      return $false
    }
    $localX = [double]$screenX - [double]$popup.bounds.left
    $localY = [double]$screenY - [double]$popup.bounds.top
    return $localX -ge [double]$freshMenu.copy.bounds.left -and
      $localX -le ([double]$freshMenu.copy.bounds.left + [double]$freshMenu.copy.bounds.width) -and
      $localY -ge [double]$freshMenu.copy.bounds.top -and
      $localY -le ([double]$freshMenu.copy.bounds.top + [double]$freshMenu.copy.bounds.height)
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Invoke-VisualOwnedPopupClick([int]$screenX, [int]$screenY, $expectedCopyBounds, $popup, $lock, [int64]$deadlineMs, [uint32]$expectedClipboardSequence, [string]$expectedClipboardText) {
  $foreground = [Win32WechatMomentsVisualAction]::GetForegroundWindow()
  if (@($lock.hWnd, $popup.hWnd) -notcontains $foreground -or -not (Test-VisualDeadline $deadlineMs) -or
    -not (Test-VisualReadbackPopupSnapshot $popup $lock) -or
    -not (Test-VisualBounds $expectedCopyBounds 2 2)) { return $false }
  $point = New-Object Win32WechatMomentsVisualAction+POINT
  $point.X = $screenX
  $point.Y = $screenY
  $hit = [Win32WechatMomentsVisualAction]::WindowFromPoint($point)
  $hitRoot = [Win32WechatMomentsVisualAction]::GetAncestor($hit, 2)
  if ($hit -eq [IntPtr]::Zero -or $hitRoot -ne $popup.hWnd -or
    -not [Win32WechatMomentsVisualAction]::SetCursorPos($screenX, $screenY)) { return $false }
  Start-Sleep -Milliseconds 30
  $actualPoint = New-Object Win32WechatMomentsVisualAction+POINT
  if (-not [Win32WechatMomentsVisualAction]::GetCursorPos([ref]$actualPoint) -or
    $actualPoint.X -ne $screenX -or $actualPoint.Y -ne $screenY) { return $false }
  $confirmedHit = [Win32WechatMomentsVisualAction]::WindowFromPoint($actualPoint)
  if ([Win32WechatMomentsVisualAction]::GetAncestor($confirmedHit, 2) -ne $popup.hWnd -or
    -not (Test-VisualReadbackPopupSnapshot $popup $lock) -or -not (Test-VisualDeadline $deadlineMs)) { return $false }

  $finalPoint = New-Object Win32WechatMomentsVisualAction+POINT
  if (-not [Win32WechatMomentsVisualAction]::GetCursorPos([ref]$finalPoint) -or
    $finalPoint.X -ne $screenX -or $finalPoint.Y -ne $screenY -or
    @($lock.hWnd, $popup.hWnd) -notcontains [Win32WechatMomentsVisualAction]::GetForegroundWindow()) { return $false }
  $finalHit = [Win32WechatMomentsVisualAction]::WindowFromPoint($finalPoint)
  if ([Win32WechatMomentsVisualAction]::GetAncestor($finalHit, 2) -ne $popup.hWnd -or
    -not (Test-VisualReadbackPopupSnapshot $popup $lock) -or -not (Test-VisualDeadline $deadlineMs) -or
    -not [Win32WechatMomentsVisualAction]::ClipboardTextMatches($expectedClipboardSequence, $false, $expectedClipboardText)) { return $false }
  return [Win32WechatMomentsVisualAction]::AtomicMouseClick($screenX, $screenY, $false)
}

function Test-VisualReadbackPopupCleanupCandidate($popup, $lock, [int]$anchorX, [int]$anchorY) {
  if ($popup -eq $null -or -not [Win32WechatMomentsVisualAction]::IsWindowVisible($popup.hWnd) -or
    [Win32WechatMomentsVisualAction]::IsIconic($popup.hWnd)) { return $false }
  $placement = Get-VisualReadbackPopupPlacement $popup.bounds $lock $anchorX $anchorY
  return [int]$popup.pid -eq [int]$lock.pid -and
    [string]$popup.className -ceq "Qt51514QWindowToolSaveBits" -and
    [string]$popup.title -ceq "Weixin" -and $popup.owner -eq $lock.hWnd -and
    $placement.ok -and
    (Test-VisualReadbackPopupSnapshot $popup $lock)
}

function Close-VisualReadbackPopups($beforeHandles, $popupCandidates, $lock, [int]$anchorX, [int]$anchorY) {
  try {
    if ($lock -eq $null -or -not [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd)) { return $false }
    $currentWindows = @(Get-VisualProcessWindows $lock.pid)
    $currentPopups = @($currentWindows | Where-Object { $beforeHandles -notcontains [string]$_.hWndText })
    if ($currentPopups.Count -eq 0) { return $true }
    $knownCandidateHandles = @($popupCandidates | ForEach-Object { [string]$_.hWndText })
    if ($knownCandidateHandles.Count -gt 0) {
      foreach ($candidate in $currentPopups) {
        if ($knownCandidateHandles -notcontains [string]$candidate.hWndText) { return $false }
      }
    }
    foreach ($candidate in $currentPopups) {
      if (-not (Test-VisualReadbackPopupCleanupCandidate $candidate $lock $anchorX $anchorY)) { return $false }
    }
    $foreground = [Win32WechatMomentsVisualAction]::GetForegroundWindow()
    $allowedForeground = @($lock.hWnd) + @($currentPopups | ForEach-Object { $_.hWnd })
    if ($allowedForeground -notcontains $foreground) { return $false }

    $width = [double]($lock.windowRect.Right - $lock.windowRect.Left)
    $height = [double]($lock.windowRect.Bottom - $lock.windowRect.Top)
    $neutralX = [int][Math]::Round([double]$lock.windowRect.Left + ($width * 0.5))
    $neutralY = [int][Math]::Round([double]$lock.windowRect.Top + [Math]::Max(8.0, [Math]::Min($height * 0.025, 24.0)))
    $neutralPoint = New-Object Win32WechatMomentsVisualAction+POINT
    $neutralPoint.X = $neutralX
    $neutralPoint.Y = $neutralY
    $neutralHit = [Win32WechatMomentsVisualAction]::WindowFromPoint($neutralPoint)
    if ([Win32WechatMomentsVisualAction]::GetAncestor($neutralHit, 2) -ne $lock.hWnd -or
      -not [Win32WechatMomentsVisualAction]::SetCursorPos($neutralX, $neutralY)) { return $false }
    Start-Sleep -Milliseconds 25
    $actualNeutralPoint = New-Object Win32WechatMomentsVisualAction+POINT
    if (-not [Win32WechatMomentsVisualAction]::GetCursorPos([ref]$actualNeutralPoint) -or
      $actualNeutralPoint.X -ne $neutralX -or $actualNeutralPoint.Y -ne $neutralY) { return $false }
    $actualNeutralHit = [Win32WechatMomentsVisualAction]::WindowFromPoint($actualNeutralPoint)
    if ([Win32WechatMomentsVisualAction]::GetAncestor($actualNeutralHit, 2) -ne $lock.hWnd) { return $false }
    foreach ($candidate in $currentPopups) {
      if (-not (Test-VisualReadbackPopupCleanupCandidate $candidate $lock $anchorX $anchorY)) { return $false }
    }
    if (-not [Win32WechatMomentsVisualAction]::AtomicMouseClick($neutralX, $neutralY, $false)) { return $false }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      Start-Sleep -Milliseconds 35
      $remainingWindows = @(Get-VisualProcessWindows $lock.pid)
      $remainingPopups = @($remainingWindows | Where-Object { $beforeHandles -notcontains [string]$_.hWndText })
      if ($remainingPopups.Count -eq 0 -and [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd)) { return $true }
    }
  } catch {}
  return $false
}

function Restore-VisualClipboard([bool]$originalEmpty, [string]$originalText, [bool]$expectedOwnedEmpty, [uint32]$expectedOwnedSequence, [string]$expectedOwnedText) {
  $ownedEmpty = $expectedOwnedEmpty
  [uint32]$ownedSequence = $expectedOwnedSequence
  $ownedText = $expectedOwnedText
  $cleanupFailed = $false
  $stateAnomaly = $false
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    [uint32]$restoredSequence = 0
    $replaceCleanupSucceeded = $false
    $restoreStatus = [Win32WechatMomentsVisualAction]::AtomicReplaceTextClipboard(
      $ownedSequence,
      $ownedEmpty,
      $ownedText,
      $originalEmpty,
      $originalText,
      [ref]$restoredSequence,
      [ref]$replaceCleanupSucceeded
    )
    if (-not $replaceCleanupSucceeded) { $cleanupFailed = $true }
    if ($restoreStatus -eq 1 -or $restoreStatus -eq 3) {
      if ($restoreStatus -eq 3) { $stateAnomaly = $true }
      $restoredMatches = $false
      if ([Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
        $restoredSequence,
        $originalEmpty,
        $originalText,
        [ref]$restoredMatches
      )) {
        return $restoredMatches -and -not $cleanupFailed -and -not $stateAnomaly
      }
      $ownedEmpty = $originalEmpty
      $ownedSequence = $restoredSequence
      $ownedText = $originalText
      Start-Sleep -Milliseconds 35
      continue
    }
    if ($restoreStatus -eq 2) {
      $ownedSequence = $restoredSequence
      Start-Sleep -Milliseconds 20
      continue
    }
    if ($restoreStatus -eq -1) {
      $ownedEmpty = $true
      $ownedSequence = $restoredSequence
      $ownedText = ""
      Start-Sleep -Milliseconds 20
      continue
    }
    if ($restoreStatus -lt -1) { return $false }
    $currentSequence = [Win32WechatMomentsVisualAction]::GetClipboardSequenceNumber()
    $originalMatches = $false
    $originalReadable = [Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
      $currentSequence,
      $originalEmpty,
      $originalText,
      [ref]$originalMatches
    )
    if ($originalReadable -and $originalMatches) { return -not $cleanupFailed -and -not $stateAnomaly }
    $ownedMatches = $false
    $ownedReadable = [Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
      $currentSequence,
      $ownedEmpty,
      $ownedText,
      [ref]$ownedMatches
    )
    if ($ownedReadable -and $ownedMatches) {
      $ownedSequence = $currentSequence
      Start-Sleep -Milliseconds 35
      continue
    }
    if ($currentSequence -ne $ownedSequence) { return $false }
    if ($ownedReadable -and -not $ownedMatches) { return $false }
    Start-Sleep -Milliseconds 35
  }
  return $false
}

function Move-VisualCursorToNeutral($lock) {
  if ($lock -eq $null -or $lock.windowRect -eq $null) { return }
  $width = [double]($lock.windowRect.Right - $lock.windowRect.Left)
  $height = [double]($lock.windowRect.Bottom - $lock.windowRect.Top)
  $x = [int][Math]::Round([double]$lock.windowRect.Left + ($width * 0.5))
  $y = [int][Math]::Round([double]$lock.windowRect.Top + [Math]::Max(8.0, [Math]::Min($height * 0.025, 24.0)))
  [void][Win32WechatMomentsVisualAction]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 60
}

function Invoke-VisualNeutralTitleBarClick($lock, [uint32]$expectedInputTick = [uint32]::MaxValue) {
  try {
    if ($lock -eq $null -or $lock.windowRect -eq $null -or
      -not [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd) -or
      [Win32WechatMomentsVisualAction]::IsIconic($lock.hWnd) -or
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
      ($expectedInputTick -ne [uint32]::MaxValue -and
        [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick)) { return $false }

    $currentRect = New-Object Win32WechatMomentsVisualAction+RECT
    [uint32]$currentPid = 0
    $currentTitle = New-Object System.Text.StringBuilder 128
    if (-not [Win32WechatMomentsVisualAction]::GetWindowRect($lock.hWnd, [ref]$currentRect) -or
      [Win32WechatMomentsVisualAction]::GetWindowThreadProcessId($lock.hWnd, [ref]$currentPid) -eq 0 -or
      [int]$currentPid -ne [int]$lock.pid -or
      [Win32WechatMomentsVisualAction]::GetWindowText($lock.hWnd, $currentTitle, $currentTitle.Capacity) -le 0 -or
      $currentTitle.ToString().Trim() -cne "朋友圈" -or
      $currentRect.Left -ne $lock.windowRect.Left -or $currentRect.Top -ne $lock.windowRect.Top -or
      $currentRect.Right -ne $lock.windowRect.Right -or $currentRect.Bottom -ne $lock.windowRect.Bottom) { return $false }
    $width = [double]($currentRect.Right - $currentRect.Left)
    $height = [double]($currentRect.Bottom - $currentRect.Top)
    $neutralX = [int][Math]::Round([double]$currentRect.Left + ($width * 0.5))
    $neutralY = [int][Math]::Round([double]$currentRect.Top + [Math]::Max(8.0, [Math]::Min($height * 0.025, 24.0)))
    if ($width -lt 300.0 -or $height -lt 300.0 -or
      $neutralX -lt ([double]$currentRect.Left + ($width * 0.35)) -or
      $neutralX -gt ([double]$currentRect.Left + ($width * 0.65))) { return $false }
    $neutralPoint = New-Object Win32WechatMomentsVisualAction+POINT
    $neutralPoint.X = $neutralX
    $neutralPoint.Y = $neutralY
    $neutralHit = [Win32WechatMomentsVisualAction]::WindowFromPoint($neutralPoint)
    if ([Win32WechatMomentsVisualAction]::GetAncestor($neutralHit, 2) -ne $lock.hWnd -or
      -not [Win32WechatMomentsVisualAction]::SetCursorPos($neutralX, $neutralY)) { return $false }
    Start-Sleep -Milliseconds 25

    $actualNeutralPoint = New-Object Win32WechatMomentsVisualAction+POINT
    if (-not [Win32WechatMomentsVisualAction]::GetCursorPos([ref]$actualNeutralPoint) -or
      $actualNeutralPoint.X -ne $neutralX -or $actualNeutralPoint.Y -ne $neutralY) { return $false }
    $actualNeutralHit = [Win32WechatMomentsVisualAction]::WindowFromPoint($actualNeutralPoint)
    $confirmedRect = New-Object Win32WechatMomentsVisualAction+RECT
    if ([Win32WechatMomentsVisualAction]::GetAncestor($actualNeutralHit, 2) -ne $lock.hWnd -or
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
      -not [Win32WechatMomentsVisualAction]::GetWindowRect($lock.hWnd, [ref]$confirmedRect) -or
      $confirmedRect.Left -ne $currentRect.Left -or $confirmedRect.Top -ne $currentRect.Top -or
      $confirmedRect.Right -ne $currentRect.Right -or $confirmedRect.Bottom -ne $currentRect.Bottom -or
      ($expectedInputTick -ne [uint32]::MaxValue -and
        [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) -or
      -not [Win32WechatMomentsVisualAction]::AtomicMouseClick($neutralX, $neutralY, $false)) { return $false }
    Start-Sleep -Milliseconds 140
    return [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd) -and
      -not [Win32WechatMomentsVisualAction]::IsIconic($lock.hWnd)
  } catch {}
  return $false
}

function Close-VisualMenu($lock = $null) {
  if (-not $script:visualMenuOpen) { return $true }
  if (-not (Invoke-VisualNeutralTitleBarClick $lock)) { return $false }
  $script:visualMenuOpen = $false
  Move-VisualCursorToNeutral $lock
  return $true
}

function Get-VisualMenuRegion($frame, $menu) {
  $regionWidth = [Math]::Max(190.0, [Math]::Min([double]$frame.width * 0.46, 300.0))
  $rightGap = [Math]::Max(16.0, [Math]::Min([double]$frame.width * 0.04, 28.0))
  $halfHeight = [Math]::Max(28.0, [Math]::Min([double]$frame.height * 0.024, 34.0))
  $left = [Math]::Max(0.0, [double]$menu.centerX - $regionWidth)
  $right = [Math]::Min([double]$frame.width, [double]$menu.centerX - $rightGap)
  $top = [Math]::Max(0.0, [double]$menu.centerY - $halfHeight)
  $bottom = [Math]::Min([double]$frame.height, [double]$menu.centerY + $halfHeight)
  return @{ left = $left; top = $top; width = $right - $left; height = $bottom - $top }
}

function Resolve-VisualOpenMenuHorizontalSegment(
  [object[]]$segments,
  [double]$frameWidth,
  [double]$menuCenterX,
  [string]$requestedAction
) {
  $segmentCount = @($segments).Count
  $strictMatches = @($segments | Where-Object {
    $width = [double]$_.right - [double]$_.left + 1.0
    $width -ge [Math]::Max(150.0, $frameWidth * 0.30) -and
      $width -le [Math]::Min(330.0, $frameWidth * 0.62) -and
      [double]$_.left -lt ($menuCenterX - 120.0) -and
      [double]$_.right -ge ($menuCenterX - 72.0) -and
      [double]$_.right -le ($menuCenterX - 8.0)
  })
  $diagnostics = @{
    requestedAction = [string]$requestedAction
    segmentCount = $segmentCount
    strictCandidateCount = $strictMatches.Count
    fallbackCandidateCount = 0
  }
  if ($strictMatches.Count -eq 1) {
    return @{ ok = $true; segment = $strictMatches[0]; geometryFallback = $false; diagnostics = $diagnostics }
  }
  if ($requestedAction -cne "comment") {
    return @{
      ok = $false
      reason = "moments_menu_surface_ambiguous"
      candidateCount = $strictMatches.Count
      diagnostics = $diagnostics
    }
  }

  # Comment-only mode already owns the unique three-dot anchor. Some DPI/theme
  # combinations render the popup narrower than the strict like-state detector.
  # Accept one nearby dark horizontal surface, then use its right-hand cell.
  $fallbackMatches = @($segments | Where-Object {
    $width = [double]$_.right - [double]$_.left + 1.0
    $width -ge [Math]::Max(110.0, $frameWidth * 0.22) -and
      $width -le [Math]::Min(360.0, $frameWidth * 0.70) -and
      [double]$_.left -lt ($menuCenterX - 80.0) -and
      [double]$_.right -ge ($menuCenterX - 110.0) -and
      [double]$_.right -le ($menuCenterX + 4.0)
  })
  $diagnostics.fallbackCandidateCount = $fallbackMatches.Count
  if ($fallbackMatches.Count -ne 1) {
    return @{
      ok = $false
      reason = "moments_menu_surface_ambiguous"
      candidateCount = $fallbackMatches.Count
      diagnostics = $diagnostics
    }
  }
  return @{ ok = $true; segment = $fallbackMatches[0]; geometryFallback = $true; diagnostics = $diagnostics }
}

function Get-VisualOpenMenuBounds($frame, $menu, [string]$requestedAction = "") {
  $scanY = [int][Math]::Round([double]$menu.centerY)
  $scanLeft = [int][Math]::Max(0, [Math]::Floor([double]$menu.centerX - [Math]::Min(340.0, [double]$frame.width * 0.64)))
  $scanRight = [int][Math]::Min($frame.width - 1, [Math]::Ceiling([double]$menu.centerX - 10.0))
  $segments = New-Object System.Collections.Generic.List[object]
  $runLeft = -1
  $lastDark = -1
  for ($x = $scanLeft; $x -le $scanRight; $x++) {
    if (-not (Test-MomentsDarkNeutralPixel (Get-MomentsPixel $frame $x $scanY))) { continue }
    if ($runLeft -lt 0 -or ($x - $lastDark) -gt [Math]::Max(18.0, [double]$frame.width * 0.05)) {
      if ($runLeft -ge 0) { [void]$segments.Add(@{ left = $runLeft; right = $lastDark }) }
      $runLeft = $x
    }
    $lastDark = $x
  }
  if ($runLeft -ge 0) { [void]$segments.Add(@{ left = $runLeft; right = $lastDark }) }
  $segmentResolution = Resolve-VisualOpenMenuHorizontalSegment (@($segments.ToArray())) ([double]$frame.width) ([double]$menu.centerX) $requestedAction
  $diagnostics = @{
    requestedAction = [string]$requestedAction
    segmentCount = [int]$segmentResolution.diagnostics.segmentCount
    strictCandidateCount = [int]$segmentResolution.diagnostics.strictCandidateCount
    fallbackCandidateCount = [int]$segmentResolution.diagnostics.fallbackCandidateCount
  }
  if (-not $segmentResolution.ok) {
    return @{
      ok = $false
      reason = [string]$segmentResolution.reason
      candidateCount = [int]$segmentResolution.candidateCount
      diagnostics = $diagnostics
    }
  }
  $left = [int]$segmentResolution.segment.left
  $right = [int]$segmentResolution.segment.right + 1
  $sampleX = [int][Math]::Min($right - 2, $left + [Math]::Max(6.0, ($right - $left) * 0.06))
  $top = $scanY
  while ($top -gt 0 -and (Test-MomentsDarkNeutralPixel (Get-MomentsPixel $frame $sampleX ($top - 1)))) { $top -= 1 }
  $bottom = $scanY + 1
  while ($bottom -lt $frame.height -and (Test-MomentsDarkNeutralPixel (Get-MomentsPixel $frame $sampleX $bottom))) { $bottom += 1 }
  $bounds = @{ left = [double]$left; top = [double]$top; width = [double]($right - $left); height = [double]($bottom - $top) }
  $minimumSurfaceWidth = $(if ($segmentResolution.geometryFallback) { 110 } else { 149 })
  if (-not (Test-VisualBounds $bounds $minimumSurfaceWidth 31) -or [double]$bounds.height -gt 82.0 -or
    [double]$menu.centerY -lt [double]$bounds.top -or
    [double]$menu.centerY -gt ([double]$bounds.top + [double]$bounds.height)) {
    return @{ ok = $false; reason = "moments_menu_surface_ambiguous"; bounds = $bounds; diagnostics = $diagnostics }
  }
  return @{
    ok = $true
    bounds = $bounds
    geometryFallback = [bool]$segmentResolution.geometryFallback
    diagnostics = $diagnostics
  }
}

function Get-VisualMenuTextEntry($ocr, $region, $frame, $allowedTexts) {
  if ($ocr -eq $null -or -not $ocr.ok) { return $null }
  $text = [Text.RegularExpressions.Regex]::Replace((Normalize-VisualText ([string]$ocr.text)), "\s+", "")
  if ($allowedTexts -notcontains $text) { return $null }
  $words = @($ocr.words)
  if ($words.Count -eq 0) { return $null }
  $left = [double]::PositiveInfinity
  $top = [double]::PositiveInfinity
  $right = [double]::NegativeInfinity
  $bottom = [double]::NegativeInfinity
  foreach ($word in $words) {
    $left = [Math]::Min($left, [double]$word.bounds.left)
    $top = [Math]::Min($top, [double]$word.bounds.top)
    $right = [Math]::Max($right, [double]$word.bounds.left + [double]$word.bounds.width)
    $bottom = [Math]::Max($bottom, [double]$word.bounds.top + [double]$word.bounds.height)
  }
  $bounds = @{
    left = [double]$region.left + $left
    top = [double]$region.top + $top
    width = $right - $left
    height = $bottom - $top
  }
  $frameBounds = @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
  if (-not (Test-VisualBoundsInside $bounds $frameBounds)) { return $null }
  return @{
    text = $text
    bounds = $bounds
    centerX = [double]$bounds.left + ([double]$bounds.width / 2.0)
    centerY = [double]$bounds.top + ([double]$bounds.height / 2.0)
  }
}

function Get-VisualMenuLabelSignature($frame, $region) {
  $left = [int][Math]::Max(0, [Math]::Floor([double]$region.left))
  $top = [int][Math]::Max(0, [Math]::Floor([double]$region.top))
  $right = [int][Math]::Min($frame.width, [Math]::Ceiling([double]$region.left + [double]$region.width))
  $bottom = [int][Math]::Min($frame.height, [Math]::Ceiling([double]$region.top + [double]$region.height))
  $minimumX = [int]::MaxValue
  $minimumY = [int]::MaxValue
  $maximumX = [int]::MinValue
  $maximumY = [int]::MinValue
  $pixelCount = 0
  for ($y = $top; $y -lt $bottom; $y++) {
    for ($x = $left; $x -lt $right; $x++) {
      $pixel = Get-MomentsPixel $frame $x $y
      if ($pixel -eq $null) { continue }
      $maximum = [Math]::Max($pixel.r, [Math]::Max($pixel.g, $pixel.b))
      $minimum = [Math]::Min($pixel.r, [Math]::Min($pixel.g, $pixel.b))
      if ($minimum -lt 138 -or ($maximum - $minimum) -gt 72) { continue }
      $pixelCount += 1
      $minimumX = [Math]::Min($minimumX, $x)
      $minimumY = [Math]::Min($minimumY, $y)
      $maximumX = [Math]::Max($maximumX, $x)
      $maximumY = [Math]::Max($maximumY, $y)
    }
  }
  if ($pixelCount -lt 24 -or $maximumX -lt $minimumX -or $maximumY -lt $minimumY) {
    return @{ ok = $false; reason = "moments_menu_label_not_found" }
  }
  $bounds = @{
    left = [double]$minimumX
    top = [double]$minimumY
    width = [double]($maximumX - $minimumX + 1)
    height = [double]($maximumY - $minimumY + 1)
  }
  if (-not (Test-VisualBounds $bounds 7 9)) { return @{ ok = $false; reason = "moments_menu_label_not_found" } }
  return @{
    ok = $true
    pixelCount = $pixelCount
    bounds = $bounds
    horizontalEdgeClear = ($minimumX -gt $left -and $maximumX -lt ($right - 1))
    centerX = [double]$bounds.left + ([double]$bounds.width / 2.0)
    centerY = [double]$bounds.top + ([double]$bounds.height / 2.0)
  }
}

function Get-VisualMenuTargetedOcrRegion($frame, $signature, $sourceRegion) {
  if ($signature -eq $null -or -not $signature.ok) { return $null }
  $paddingX = [Math]::Max(7.0, [Math]::Ceiling([double]$signature.bounds.width * 0.45))
  $paddingY = [Math]::Max(5.0, [Math]::Ceiling([double]$signature.bounds.height * 0.55))
  $sourceLeft = [Math]::Max(0.0, [double]$sourceRegion.left)
  $sourceTop = [Math]::Max(0.0, [double]$sourceRegion.top)
  $sourceRight = [Math]::Min([double]$frame.width, [double]$sourceRegion.left + [double]$sourceRegion.width)
  $sourceBottom = [Math]::Min([double]$frame.height, [double]$sourceRegion.top + [double]$sourceRegion.height)
  $left = [Math]::Max($sourceLeft, [double]$signature.bounds.left - $paddingX)
  $top = [Math]::Max($sourceTop, [double]$signature.bounds.top - $paddingY)
  $right = [Math]::Min($sourceRight, [double]$signature.bounds.left + [double]$signature.bounds.width + $paddingX)
  $bottom = [Math]::Min($sourceBottom, [double]$signature.bounds.top + [double]$signature.bounds.height + $paddingY)
  $region = @{
    left = $left
    top = $top
    width = $right - $left
    height = $bottom - $top
    targetedLike = $true
  }
  if (-not (Test-VisualBounds $region 10 10)) { return $null }
  return $region
}

function Resolve-VisualLikeMenuState($likeEntry, $likeSignature, $commentSignature, [string]$ocrMode = "ocr") {
  $widthRatio = 0.0
  $heightRatio = 0.0
  if ($likeSignature.ok -and $commentSignature.ok) {
    $widthRatio = [double]$likeSignature.bounds.width / [double]$commentSignature.bounds.width
    $heightRatio = [double]$likeSignature.bounds.height / [double]$commentSignature.bounds.height
  }
  if ($likeEntry -ne $null) {
    $targetedLikeProofOk = $ocrMode -cne "targeted_ocr" -or
      [string]$likeEntry.text -cne "赞" -or
      ($likeSignature.ok -and $commentSignature.ok -and
        [bool]$likeSignature.horizontalEdgeClear -and
        [bool]$commentSignature.horizontalEdgeClear -and
        $widthRatio -ge 0.32 -and $widthRatio -le 0.68 -and
        $heightRatio -ge 0.76 -and $heightRatio -le 1.24)
    if (-not $targetedLikeProofOk) {
      return @{
        entry = $null
        mode = "ambiguous"
        widthRatio = $widthRatio
        heightRatio = $heightRatio
      }
    }
    return @{
      entry = $likeEntry
      mode = $(if ($ocrMode -ceq "targeted_ocr") { "targeted_ocr" } else { "ocr" })
      widthRatio = $widthRatio
      heightRatio = $heightRatio
    }
  }
  if ($likeSignature.ok -and $commentSignature.ok -and
    [bool]$likeSignature.horizontalEdgeClear -and
    [bool]$commentSignature.horizontalEdgeClear -and
    $heightRatio -ge 0.76 -and $heightRatio -le 1.24) {
    $visualState = ""
    # A wider two-character label can safely prove the no-op "取消" state.
    # A single visible glyph must still be read as "赞" by OCR before clicking,
    # because a partially obscured "取消" label could otherwise be mistaken for it.
    if ($widthRatio -ge 0.78 -and $widthRatio -le 1.42) { $visualState = "取消" }
    if ($visualState) {
      return @{
        entry = @{
          text = $visualState
          bounds = $likeSignature.bounds
          centerX = $likeSignature.centerX
          centerY = $likeSignature.centerY
        }
        mode = "visual_signature"
        widthRatio = $widthRatio
        heightRatio = $heightRatio
      }
    }
  }
  return @{
    entry = $null
    mode = "ambiguous"
    widthRatio = $widthRatio
    heightRatio = $heightRatio
  }
}

function Read-OpenVisualMenuOnce($lock, $menu, [string]$requestedAction) {
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false $false
  if (-not $frame.ok) { return @{ ok = $false; reason = $frame.reason } }
  try {
    $allowedLike = @("赞", "取消", "取消赞")
    $surface = Get-VisualOpenMenuBounds $frame $menu $requestedAction
    if (-not $surface.ok) { return $surface }
    $cellWidth = [double]$surface.bounds.width / 2.0
    $likeRegion = @{
      left = [double]$surface.bounds.left + ($cellWidth * 0.52)
      top = [double]$surface.bounds.top
      width = $cellWidth * 0.43
      height = [double]$surface.bounds.height
    }
    $commentRegion = @{
      left = [double]$surface.bounds.left + $cellWidth + ($cellWidth * 0.47)
      top = [double]$surface.bounds.top
      width = $cellWidth * 0.48
      height = [double]$surface.bounds.height
    }
    $likeOcr = Get-MomentsHighContrastOcrObservation $frame $likeRegion 4
    $commentOcr = Get-MomentsHighContrastOcrObservation $frame $commentRegion 4
    $likeEntry = Get-VisualMenuTextEntry $likeOcr $likeRegion $frame $allowedLike
    $commentEntry = Get-VisualMenuTextEntry $commentOcr $commentRegion $frame @("评论")
    $likeScaledOcr = Get-MomentsScaledOcrObservation $frame $likeRegion 4
    $commentScaledOcr = Get-MomentsScaledOcrObservation $frame $commentRegion 4
    if ($likeEntry -eq $null) { $likeEntry = Get-VisualMenuTextEntry $likeScaledOcr $likeRegion $frame $allowedLike }
    if ($commentEntry -eq $null) { $commentEntry = Get-VisualMenuTextEntry $commentScaledOcr $commentRegion $frame @("评论") }
    $likeBaseOcrMatched = ($likeEntry -ne $null)
    $commentOcrMatched = ($commentEntry -ne $null)
    $likeSignature = Get-VisualMenuLabelSignature $frame $likeRegion
    $commentSignature = Get-VisualMenuLabelSignature $frame $commentRegion
    $targetedLikeOcrAttempted = $false
    $targetedLikeOcrMatched = $false
    $targetedLikeRegion = $null
    if ($requestedAction -ne "comment" -and $likeEntry -eq $null -and $likeSignature.ok) {
      $targetedLikeRegion = Get-VisualMenuTargetedOcrRegion $frame $likeSignature $likeRegion
      if ($targetedLikeRegion -ne $null) {
        $targetedLikeOcrAttempted = $true
        $targetedLikeOcr = Get-MomentsHighContrastOcrObservation $frame $targetedLikeRegion 5
        $likeEntry = Get-VisualMenuTextEntry $targetedLikeOcr $targetedLikeRegion $frame $allowedLike
        if ($likeEntry -eq $null) {
          $targetedLikeScaledOcr = Get-MomentsScaledOcrObservation $frame $targetedLikeRegion 4
          $likeEntry = Get-VisualMenuTextEntry $targetedLikeScaledOcr $targetedLikeRegion $frame $allowedLike
        }
        $targetedLikeOcrMatched = ($likeEntry -ne $null)
      }
    }
    $likeOcrMatched = ($likeEntry -ne $null)
    $likeResolution = Resolve-VisualLikeMenuState $likeEntry $likeSignature $commentSignature $(if ($targetedLikeOcrMatched) { "targeted_ocr" } else { "ocr" })
    $likeEntry = $likeResolution.entry
    $widthRatio = [double]$likeResolution.widthRatio
    $heightRatio = [double]$likeResolution.heightRatio
    $menuDiagnostics = @{
      segmentCount = [int]$surface.diagnostics.segmentCount
      strictCandidateCount = [int]$surface.diagnostics.strictCandidateCount
      fallbackCandidateCount = [int]$surface.diagnostics.fallbackCandidateCount
      likeOcrMatched = [bool]$likeOcrMatched
      likeBaseOcrMatched = [bool]$likeBaseOcrMatched
      targetedLikeOcrAttempted = [bool]$targetedLikeOcrAttempted
      targetedLikeOcrMatched = [bool]$targetedLikeOcrMatched
      commentOcrMatched = [bool]$commentOcrMatched
      likeSignatureOk = [bool]$likeSignature.ok
      commentSignatureOk = [bool]$commentSignature.ok
      likeSignatureEdgeClear = [bool]$likeSignature.horizontalEdgeClear
      commentSignatureEdgeClear = [bool]$commentSignature.horizontalEdgeClear
      likeResolutionMode = [string]$likeResolution.mode
      widthRatio = $widthRatio
      heightRatio = $heightRatio
      surface = $surface.bounds
      likeRegion = $likeRegion
      targetedLikeRegion = $targetedLikeRegion
      commentRegion = $commentRegion
    }
    if ($requestedAction -ceq "comment" -and $commentEntry -eq $null) {
      $commentEntry = @{
        text = "评论"
        bounds = @{
          left = [double]$surface.bounds.left + $cellWidth
          top = [double]$surface.bounds.top
          width = $cellWidth
          height = [double]$surface.bounds.height
        }
        centerX = [double]$surface.bounds.left + ($cellWidth * 1.5)
        centerY = [double]$surface.bounds.top + ([double]$surface.bounds.height / 2.0)
        geometryFallback = $true
      }
    }
    $requestedEntryMissing = ($requestedAction -ceq "comment" -and $commentEntry -eq $null) -or
      ($requestedAction -ne "comment" -and $likeEntry -eq $null)
    if ($requestedEntryMissing) {
      return @{
        ok = $false
        reason = "moments_menu_ambiguous"
        diagnostics = $menuDiagnostics
      }
    }
    return @{
      ok = $true
      like = $likeEntry
      comment = $commentEntry
      menuState = $(if ($likeEntry -ne $null) { [string]$likeEntry.text } else { "unknown" })
      menuSurface = $surface.bounds
      diagnostics = $menuDiagnostics
    }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Read-OpenVisualMenu($lock, $menu, [string]$requestedAction) {
  $first = Read-OpenVisualMenuOnce $lock $menu $requestedAction
  $firstReason = $(if ($first.ok) { "" } else { [string]$first.reason })
  if ($first.ok -or [string]$first.reason -notin @("moments_menu_surface_ambiguous", "moments_menu_ambiguous")) {
    $first.diagnostics = @{
      menuReadRetryCount = 0
      firstReason = $firstReason
      secondReason = ""
      requestedAction = [string]$requestedAction
      firstSegmentCount = [int]$first.diagnostics.segmentCount
      secondSegmentCount = 0
      firstStrictCandidateCount = [int]$first.diagnostics.strictCandidateCount
      secondStrictCandidateCount = 0
      firstFallbackCandidateCount = [int]$first.diagnostics.fallbackCandidateCount
      secondFallbackCandidateCount = 0
      firstLikeOcrMatched = [bool]$first.diagnostics.likeOcrMatched
      firstLikeBaseOcrMatched = [bool]$first.diagnostics.likeBaseOcrMatched
      firstTargetedLikeOcrAttempted = [bool]$first.diagnostics.targetedLikeOcrAttempted
      firstTargetedLikeOcrMatched = [bool]$first.diagnostics.targetedLikeOcrMatched
      firstCommentOcrMatched = [bool]$first.diagnostics.commentOcrMatched
      firstLikeSignatureOk = [bool]$first.diagnostics.likeSignatureOk
      firstCommentSignatureOk = [bool]$first.diagnostics.commentSignatureOk
      firstLikeSignatureEdgeClear = [bool]$first.diagnostics.likeSignatureEdgeClear
      firstCommentSignatureEdgeClear = [bool]$first.diagnostics.commentSignatureEdgeClear
      firstLikeResolutionMode = [string]$first.diagnostics.likeResolutionMode
      firstWidthRatio = [double]$first.diagnostics.widthRatio
      firstHeightRatio = [double]$first.diagnostics.heightRatio
      secondLikeOcrMatched = $false
      secondLikeBaseOcrMatched = $false
      secondTargetedLikeOcrAttempted = $false
      secondTargetedLikeOcrMatched = $false
      secondCommentOcrMatched = $false
      secondLikeSignatureOk = $false
      secondCommentSignatureOk = $false
      secondLikeSignatureEdgeClear = $false
      secondCommentSignatureEdgeClear = $false
      secondLikeResolutionMode = ""
      secondWidthRatio = 0.0
      secondHeightRatio = 0.0
    }
    return $first
  }

  Start-Sleep -Milliseconds 160
  $second = Read-OpenVisualMenuOnce $lock $menu $requestedAction
  $second.diagnostics = @{
    menuReadRetryCount = 1
    firstReason = $firstReason
    secondReason = $(if ($second.ok) { "" } else { [string]$second.reason })
    requestedAction = [string]$requestedAction
    firstSegmentCount = [int]$first.diagnostics.segmentCount
    secondSegmentCount = [int]$second.diagnostics.segmentCount
    firstStrictCandidateCount = [int]$first.diagnostics.strictCandidateCount
    secondStrictCandidateCount = [int]$second.diagnostics.strictCandidateCount
    firstFallbackCandidateCount = [int]$first.diagnostics.fallbackCandidateCount
    secondFallbackCandidateCount = [int]$second.diagnostics.fallbackCandidateCount
    firstLikeOcrMatched = [bool]$first.diagnostics.likeOcrMatched
    firstLikeBaseOcrMatched = [bool]$first.diagnostics.likeBaseOcrMatched
    firstTargetedLikeOcrAttempted = [bool]$first.diagnostics.targetedLikeOcrAttempted
    firstTargetedLikeOcrMatched = [bool]$first.diagnostics.targetedLikeOcrMatched
    firstCommentOcrMatched = [bool]$first.diagnostics.commentOcrMatched
    firstLikeSignatureOk = [bool]$first.diagnostics.likeSignatureOk
    firstCommentSignatureOk = [bool]$first.diagnostics.commentSignatureOk
    firstLikeSignatureEdgeClear = [bool]$first.diagnostics.likeSignatureEdgeClear
    firstCommentSignatureEdgeClear = [bool]$first.diagnostics.commentSignatureEdgeClear
    firstLikeResolutionMode = [string]$first.diagnostics.likeResolutionMode
    firstWidthRatio = [double]$first.diagnostics.widthRatio
    firstHeightRatio = [double]$first.diagnostics.heightRatio
    secondLikeOcrMatched = [bool]$second.diagnostics.likeOcrMatched
    secondLikeBaseOcrMatched = [bool]$second.diagnostics.likeBaseOcrMatched
    secondTargetedLikeOcrAttempted = [bool]$second.diagnostics.targetedLikeOcrAttempted
    secondTargetedLikeOcrMatched = [bool]$second.diagnostics.targetedLikeOcrMatched
    secondCommentOcrMatched = [bool]$second.diagnostics.commentOcrMatched
    secondLikeSignatureOk = [bool]$second.diagnostics.likeSignatureOk
    secondCommentSignatureOk = [bool]$second.diagnostics.commentSignatureOk
    secondLikeSignatureEdgeClear = [bool]$second.diagnostics.likeSignatureEdgeClear
    secondCommentSignatureEdgeClear = [bool]$second.diagnostics.commentSignatureEdgeClear
    secondLikeResolutionMode = [string]$second.diagnostics.likeResolutionMode
    secondWidthRatio = [double]$second.diagnostics.widthRatio
    secondHeightRatio = [double]$second.diagnostics.heightRatio
  }
  return $second
}

function Open-LockedVisualMenu($lock, $context) {
  $current = Get-CurrentLockedVisualPost $lock $context $true
  if (-not $current.ok) {
    Close-MomentsVisualFrame $current.frame
    return @{ ok = $false; reason = $current.reason; diagnostics = $current.diagnostics }
  }
  $fresh = Get-FreshVisualMenuAnchor $lock $current.expectedMenuBounds $current.menuHash $false
  Close-MomentsVisualFrame $current.frame
  if (-not $fresh.ok) {
    Close-MomentsVisualFrame $fresh.frame
    return @{ ok = $false; reason = $fresh.reason; diagnostics = $fresh.diagnostics }
  }
  $menu = $fresh.menu
  Close-MomentsVisualFrame $fresh.frame
  $screenX = [int][Math]::Round([double]$context.expectedWindow.left + [double]$menu.centerX)
  $screenY = [int][Math]::Round([double]$context.expectedWindow.top + [double]$menu.centerY)
  if (-not (Invoke-VisualOwnedClick $screenX $screenY $lock ([int64]$context.deadlineMs) $false $true)) {
    return @{ ok = $false; reason = $(if (Test-VisualDeadline ([int64]$context.deadlineMs)) { "moments_menu_click_blocked" } else { "moments_dry_run_expired" }) }
  }
  $script:visualMenuOpen = $true
  Start-Sleep -Milliseconds 240
  $read = Read-OpenVisualMenu $lock $menu ([string]$context.requestedAction)
  if (-not $read.ok) {
    if (-not (Close-VisualMenu $lock)) {
      $read.cleanupReason = "moments_menu_close_blocked"
    }
    return $read
  }
  return @{
    ok = $true
    lock = $lock
    menu = $menu
    menuState = $read.menuState
    like = $read.like
    comment = $read.comment
    menuSurface = $read.menuSurface
    diagnostics = $read.diagnostics
    avatarHash = $current.avatarHash
    postBounds = $current.post.bounds
    expectedAvatarBounds = $current.expectedAvatarBounds
    expectedMenuBounds = $current.expectedMenuBounds
  }
}

function Close-And-VerifyUnchanged($lock, $context) {
  if (-not (Close-VisualMenu $lock)) {
    return @{ ok = $false; reason = "moments_menu_close_blocked" }
  }
  $closed = Get-CurrentLockedVisualPost $lock $context $false
  $ok = $closed.ok
  $reason = $closed.reason
  Close-MomentsVisualFrame $closed.frame
  if (-not $ok) { return @{ ok = $false; reason = $(if ($reason) { $reason } else { "moments_menu_close_unverified" }) } }
  return @{ ok = $true }
}

function Get-PostActionMenuAnchor($lock, $expectedMenuBounds, $expectedAvatarBounds, [string]$expectedAvatarHash) {
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
  if (-not $frame.ok) { return @{ ok = $false; reason = $frame.reason } }
  try {
    $avatarHash = Get-MomentsPixelHash $frame $expectedAvatarBounds
    if (-not $avatarHash -or $avatarHash -cne $expectedAvatarHash) {
      return @{ ok = $false; reason = "moments_post_anchor_changed" }
    }
    $menus = @(Find-MomentsMenuDots $frame)
    $resolution = Resolve-VisualMenuAnchor $menus $expectedMenuBounds 2.5
    if (-not $resolution.ok) {
      return @{ ok = $false; reason = $resolution.reason; diagnostics = $resolution.diagnostics }
    }
    return @{ ok = $true; menu = $resolution.menu; diagnostics = $resolution.diagnostics }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Test-VisualWechatGreenPixel($pixel) {
  return $pixel -ne $null -and $pixel.g -ge 130 -and
    $pixel.g -ge ($pixel.r + 45) -and $pixel.g -ge ($pixel.b + 20)
}

function Get-VisualCommentComposer($frame, $menu) {
  $scanLeft = [int][Math]::Max(0, [Math]::Floor([double]$menu.centerX - ([double]$frame.width * 0.80)))
  $scanRight = [int][Math]::Min($frame.width - 1, [Math]::Ceiling([double]$menu.centerX + ([double]$frame.width * 0.055)))
  $scanTop = [int][Math]::Max(0, [Math]::Floor([double]$menu.centerY + 6.0))
  # A reaction row can push the composer below the former 19%-of-window cap.
  # Scan the remaining visible feed, while component isolation below prevents
  # unrelated reaction pixels from being merged with the composer border.
  $scanBottom = [int][Math]::Max($scanTop, $frame.height - 12)
  $scanWidth = $scanRight - $scanLeft + 1
  $scanHeight = $scanBottom - $scanTop + 1
  if ($scanWidth -lt 1 -or $scanHeight -lt 1) {
    return @{ ok = $false; reason = "moments_comment_composer_not_found" }
  }
  $mask = New-Object bool[] ($scanWidth * $scanHeight)
  $pixelCount = 0
  for ($localY = 0; $localY -lt $scanHeight; $localY++) {
    $y = $scanTop + $localY
    for ($localX = 0; $localX -lt $scanWidth; $localX++) {
      $x = $scanLeft + $localX
      if (-not (Test-VisualWechatGreenPixel (Get-MomentsPixel $frame $x $y))) { continue }
      $mask[($localY * $scanWidth) + $localX] = $true
      $pixelCount += 1
    }
  }
  if ($pixelCount -lt 180) {
    return @{ ok = $false; reason = "moments_comment_composer_not_found" }
  }
  # Reactions added after a successful like live in the same scan band as the
  # comment composer. Keep their green pixels isolated instead of merging all
  # pixels into one global box. Every connected component must still pass the
  # original composer geometry and four-edge proof, and exactly one may pass.
  $seen = New-Object bool[] $mask.Length
  $validCandidates = New-Object System.Collections.Generic.List[object]
  $componentCount = 0
  $potentialCandidateCount = 0
  for ($seedY = 0; $seedY -lt $scanHeight; $seedY++) {
    for ($seedX = 0; $seedX -lt $scanWidth; $seedX++) {
      $seedIndex = ($seedY * $scanWidth) + $seedX
      if (-not $mask[$seedIndex] -or $seen[$seedIndex]) { continue }
      $componentCount += 1
      $queue = New-Object System.Collections.Generic.Queue[int]
      $queue.Enqueue($seedIndex)
      $seen[$seedIndex] = $true
      $minimumX = $seedX
      $minimumY = $seedY
      $maximumX = $seedX
      $maximumY = $seedY
      $componentPixelCount = 0
      while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $currentY = [int][Math]::Floor($current / $scanWidth)
        $currentX = $current - ($currentY * $scanWidth)
        $minimumX = [Math]::Min($minimumX, $currentX)
        $minimumY = [Math]::Min($minimumY, $currentY)
        $maximumX = [Math]::Max($maximumX, $currentX)
        $maximumY = [Math]::Max($maximumY, $currentY)
        $componentPixelCount += 1
        for ($deltaY = -1; $deltaY -le 1; $deltaY++) {
          for ($deltaX = -1; $deltaX -le 1; $deltaX++) {
            if ($deltaX -eq 0 -and $deltaY -eq 0) { continue }
            $nextX = $currentX + $deltaX
            $nextY = $currentY + $deltaY
            if ($nextX -lt 0 -or $nextY -lt 0 -or $nextX -ge $scanWidth -or $nextY -ge $scanHeight) { continue }
            $nextIndex = ($nextY * $scanWidth) + $nextX
            if ($mask[$nextIndex] -and -not $seen[$nextIndex]) {
              $seen[$nextIndex] = $true
              $queue.Enqueue($nextIndex)
            }
          }
        }
      }
      $bounds = @{
        left = [double]($scanLeft + $minimumX)
        top = [double]($scanTop + $minimumY)
        width = [double]($maximumX - $minimumX + 1)
        height = [double]($maximumY - $minimumY + 1)
      }
      if ([double]$bounds.width -gt ([double]$frame.width * 0.45) -and
        [double]$bounds.height -gt 40.0 -and [double]$bounds.height -le 240.0 -and
        [double]$bounds.top -gt [double]$menu.centerY) {
        $potentialCandidateCount += 1
      }
      if ($componentPixelCount -lt 180) { continue }
      if (-not (Test-VisualBounds $bounds ([double]$frame.width * 0.54) 64) -or
        [double]$bounds.width -gt ([double]$frame.width * 0.86) -or
        [double]$bounds.height -gt 205.0 -or
        [double]$bounds.top -le [double]$menu.centerY) { continue }
      $topEdge = 0
      $bottomEdge = 0
      $leftEdge = 0
      $rightEdge = 0
      $edge = 3
      for ($x = [int]$bounds.left; $x -lt [int]([double]$bounds.left + [double]$bounds.width); $x++) {
        for ($offset = 0; $offset -lt $edge; $offset++) {
          if (Test-VisualWechatGreenPixel (Get-MomentsPixel $frame $x ([int]$bounds.top + $offset))) { $topEdge += 1; break }
        }
        for ($offset = 1; $offset -le $edge; $offset++) {
          if (Test-VisualWechatGreenPixel (Get-MomentsPixel $frame $x ([int]([double]$bounds.top + [double]$bounds.height) - $offset))) { $bottomEdge += 1; break }
        }
      }
      for ($y = [int]$bounds.top; $y -lt [int]([double]$bounds.top + [double]$bounds.height); $y++) {
        for ($offset = 0; $offset -lt $edge; $offset++) {
          if (Test-VisualWechatGreenPixel (Get-MomentsPixel $frame ([int]$bounds.left + $offset) $y)) { $leftEdge += 1; break }
        }
        for ($offset = 1; $offset -le $edge; $offset++) {
          if (Test-VisualWechatGreenPixel (Get-MomentsPixel $frame ([int]([double]$bounds.left + [double]$bounds.width) - $offset) $y)) { $rightEdge += 1; break }
        }
      }
      if ($topEdge -lt ([double]$bounds.width * 0.42) -or $bottomEdge -lt ([double]$bounds.width * 0.42) -or
        $leftEdge -lt ([double]$bounds.height * 0.35) -or $rightEdge -lt ([double]$bounds.height * 0.35)) { continue }
      [void]$validCandidates.Add(@{
        bounds = $bounds
        pixelCount = $componentPixelCount
        topEdge = $topEdge
        bottomEdge = $bottomEdge
        leftEdge = $leftEdge
        rightEdge = $rightEdge
      })
    }
  }
  if ($validCandidates.Count -ne 1) {
    return @{
      ok = $false
      reason = $(if ($validCandidates.Count -eq 0 -and $potentialCandidateCount -eq 0) { "moments_comment_composer_not_found" } else { "moments_comment_composer_ambiguous" })
      componentCount = $componentCount
      potentialCandidateCount = $potentialCandidateCount
      validCandidateCount = $validCandidates.Count
    }
  }
  $composer = $validCandidates[0]
  return @{
    ok = $true
    bounds = $composer.bounds
    pixelCount = $composer.pixelCount
    componentCount = $componentCount
    potentialCandidateCount = $potentialCandidateCount
    validCandidateCount = 1
  }
}

function Get-VisualSendButton($frame, $composer, [bool]$includeOcr = $true) {
  if (-not $composer.ok) { return @{ ok = $false; reason = "moments_comment_composer_not_found" } }
  $bounds = $composer.bounds
  $scanLeft = [int][Math]::Max(0, [Math]::Floor([double]$bounds.left + ([double]$bounds.width * 0.58)))
  $scanRight = [int][Math]::Ceiling([double]$bounds.left + [double]$bounds.width - 1.0)
  $scanTop = [int][Math]::Max(0, [Math]::Floor([double]$bounds.top + ([double]$bounds.height * 0.38)))
  $scanBottom = [int][Math]::Ceiling([double]$bounds.top + [double]$bounds.height - 1.0)
  $scanWidth = $scanRight - $scanLeft + 1
  $scanHeight = $scanBottom - $scanTop + 1
  if ($scanWidth -lt 1 -or $scanHeight -lt 1) {
    return @{ ok = $false; reason = "moments_comment_send_button_not_found"; candidateCount = 0 }
  }
  $mask = New-Object bool[] ($scanWidth * $scanHeight)
  $pixelCount = 0
  for ($localY = 0; $localY -lt $scanHeight; $localY++) {
    $y = $scanTop + $localY
    for ($localX = 0; $localX -lt $scanWidth; $localX++) {
      $x = $scanLeft + $localX
      if (-not (Test-VisualWechatGreenPixel (Get-MomentsPixel $frame $x $y))) { continue }
      $mask[($localY * $scanWidth) + $localX] = $true
      $pixelCount += 1
    }
  }
  if ($pixelCount -lt 80) {
    return @{ ok = $false; reason = "moments_comment_send_button_not_found"; candidateCount = 0; componentCount = 0 }
  }
  $seen = New-Object bool[] $mask.Length
  $validCandidates = New-Object System.Collections.Generic.List[object]
  $componentCount = 0
  $potentialCandidateCount = 0
  $borderRejectedCount = 0
  $borderInset = 3.0
  for ($seedY = 0; $seedY -lt $scanHeight; $seedY++) {
    for ($seedX = 0; $seedX -lt $scanWidth; $seedX++) {
      $seedIndex = ($seedY * $scanWidth) + $seedX
      if (-not $mask[$seedIndex] -or $seen[$seedIndex]) { continue }
      $componentCount += 1
      $queue = New-Object System.Collections.Generic.Queue[int]
      $queue.Enqueue($seedIndex)
      $seen[$seedIndex] = $true
      $minimumX = $seedX
      $minimumY = $seedY
      $maximumX = $seedX
      $maximumY = $seedY
      $componentPixelCount = 0
      while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $currentY = [int][Math]::Floor($current / $scanWidth)
        $currentX = $current - ($currentY * $scanWidth)
        $minimumX = [Math]::Min($minimumX, $currentX)
        $minimumY = [Math]::Min($minimumY, $currentY)
        $maximumX = [Math]::Max($maximumX, $currentX)
        $maximumY = [Math]::Max($maximumY, $currentY)
        $componentPixelCount += 1
        for ($deltaY = -1; $deltaY -le 1; $deltaY++) {
          for ($deltaX = -1; $deltaX -le 1; $deltaX++) {
            if ($deltaX -eq 0 -and $deltaY -eq 0) { continue }
            $nextX = $currentX + $deltaX
            $nextY = $currentY + $deltaY
            if ($nextX -lt 0 -or $nextY -lt 0 -or $nextX -ge $scanWidth -or $nextY -ge $scanHeight) { continue }
            $nextIndex = ($nextY * $scanWidth) + $nextX
            if ($mask[$nextIndex] -and -not $seen[$nextIndex]) {
              $seen[$nextIndex] = $true
              $queue.Enqueue($nextIndex)
            }
          }
        }
      }
      $componentBounds = @{
        left = [double]($scanLeft + $minimumX)
        top = [double]($scanTop + $minimumY)
        width = [double]($maximumX - $minimumX + 1)
        height = [double]($maximumY - $minimumY + 1)
      }
      $componentRight = [double]$componentBounds.left + [double]$componentBounds.width
      $componentBottom = [double]$componentBounds.top + [double]$componentBounds.height
      $composerRight = [double]$bounds.left + [double]$bounds.width
      $composerBottom = [double]$bounds.top + [double]$bounds.height
      $isComposerBorder = [double]$componentBounds.width -ge ([double]$bounds.width * 0.75) -and
        [double]$componentBounds.height -ge ([double]$bounds.height * 0.70)
      $touchesComposerBorder = $isComposerBorder -or
        [double]$componentBounds.left -le ([double]$bounds.left + $borderInset) -or
        [double]$componentBounds.top -le ([double]$bounds.top + $borderInset) -or
        $componentRight -ge ($composerRight - $borderInset) -or
        $componentBottom -ge ($composerBottom - $borderInset)
      if ($touchesComposerBorder) {
        $borderRejectedCount += 1
        continue
      }
      if ($componentPixelCount -ge 80) { $potentialCandidateCount += 1 }
      $area = [Math]::Max(1.0, [double]$componentBounds.width * [double]$componentBounds.height)
      $fillRatio = [double]$componentPixelCount / $area
      $centerX = [double]$componentBounds.left + ([double]$componentBounds.width / 2.0)
      $centerY = [double]$componentBounds.top + ([double]$componentBounds.height / 2.0)
      if ($componentPixelCount -lt 180 -or
        -not (Test-VisualBounds $componentBounds 44 18) -or
        [double]$componentBounds.width -gt 180.0 -or
        [double]$componentBounds.height -gt 72.0 -or
        $fillRatio -lt 0.50 -or
        $centerX -lt ([double]$bounds.left + ([double]$bounds.width * 0.58)) -or
        $centerY -lt ([double]$bounds.top + ([double]$bounds.height * 0.38)) -or
        -not (Test-VisualBoundsInside $componentBounds $bounds)) { continue }
      [void]$validCandidates.Add(@{
        bounds = $componentBounds
        centerX = $centerX
        centerY = $centerY
        pixelCount = $componentPixelCount
        fillRatio = $fillRatio
      })
    }
  }
  if ($validCandidates.Count -ne 1) {
    return @{
      ok = $false
      reason = $(if ($validCandidates.Count -eq 0) { "moments_comment_send_button_not_found" } else { "moments_comment_send_button_ambiguous" })
      candidateCount = $validCandidates.Count
      componentCount = $componentCount
      potentialCandidateCount = $potentialCandidateCount
      borderRejectedCount = $borderRejectedCount
    }
  }
  $button = $validCandidates[0]
  $buttonBounds = $button.bounds
  $ocrRegion = @{
    left = [Math]::Max([double]$bounds.left, [double]$buttonBounds.left - 4.0)
    top = [Math]::Max([double]$bounds.top, [double]$buttonBounds.top - 4.0)
    width = [double]$buttonBounds.width + 8.0
    height = [double]$buttonBounds.height + 8.0
  }
  $text = ""
  if ($includeOcr) {
    $ocr = Get-MomentsHighContrastOcrObservation $frame $ocrRegion 4
    $text = $(if ($ocr.ok) { [Text.RegularExpressions.Regex]::Replace((Normalize-VisualText ([string]$ocr.text)), "\s+", "") } else { "" })
  }
  $sendLabel = ([string]([char]0x53D1) + [string]([char]0x9001))
  return @{
    ok = $true
    bounds = $buttonBounds
    centerX = $button.centerX
    centerY = $button.centerY
    pixelCount = $button.pixelCount
    fillRatio = $button.fillRatio
    candidateCount = 1
    componentCount = $componentCount
    potentialCandidateCount = $potentialCandidateCount
    borderRejectedCount = $borderRejectedCount
    ocrText = $text
    ocrAttempted = $includeOcr
    labelVerified = $text -ceq $sendLabel
  }
}

function Get-VisualCommentTextRegion($frame, $postBounds, $menu, $nextPostTop = $null) {
  $left = [Math]::Max(0.0, [double]$postBounds.left + ([double]$postBounds.width * 0.10))
  $top = [Math]::Max(0.0, [double]$menu.bounds.top + [double]$menu.bounds.height + 4.0)
  $right = [Math]::Min([double]$frame.width, [double]$postBounds.left + [double]$postBounds.width)
  $fallbackBottom = [Math]::Min(
    [double]$frame.height,
    [double]$postBounds.top + [double]$postBounds.height
  )
  $hasCompleteBoundary = $nextPostTop -ne $null -and
    [double]$nextPostTop -gt ($top + 12.0) -and
    [double]$nextPostTop -le [double]$frame.height
  $bottom = $(if ($hasCompleteBoundary) {
    [Math]::Min([double]$frame.height, [double]$nextPostTop - 4.0)
  } else {
    $fallbackBottom
  })
  return @{
    left = $left
    top = $top
    width = $right - $left
    height = $bottom - $top
    complete = [bool]$hasCompleteBoundary
  }
}

function Get-VisualNormalizedOcrCount([string]$haystack, [string]$needle) {
  $compactHaystack = [Text.RegularExpressions.Regex]::Replace((Normalize-VisualText $haystack), "\s+", "")
  $compactNeedle = [Text.RegularExpressions.Regex]::Replace((Normalize-VisualText $needle), "\s+", "")
  if (-not $compactHaystack -or -not $compactNeedle) { return 0 }
  $count = 0
  $offset = 0
  while ($offset -lt $compactHaystack.Length) {
    $index = $compactHaystack.IndexOf($compactNeedle, $offset, [StringComparison]::Ordinal)
    if ($index -lt 0) { break }
    $count += 1
    $offset = $index + $compactNeedle.Length
  }
  return $count
}

function Get-VisualCompactLocatorText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  return [Text.RegularExpressions.Regex]::Replace($value.Normalize([Text.NormalizationForm]::FormKC), "\s+", "")
}

function Get-VisualLongestCommonSubstringLength([string]$left, [string]$right) {
  if (-not $left -or -not $right) { return 0 }
  $previous = New-Object int[] ($right.Length + 1)
  $best = 0
  for ($leftIndex = 1; $leftIndex -le $left.Length; $leftIndex++) {
    $current = New-Object int[] ($right.Length + 1)
    for ($rightIndex = 1; $rightIndex -le $right.Length; $rightIndex++) {
      if ($left[$leftIndex - 1] -ceq $right[$rightIndex - 1]) {
        $current[$rightIndex] = $previous[$rightIndex - 1] + 1
        if ($current[$rightIndex] -gt $best) { $best = $current[$rightIndex] }
      }
    }
    $previous = $current
  }
  return $best
}

function Get-VisualCommentLineMatch([string]$expectedText, [string]$lineText, [string]$matchMode) {
  $expected = Get-VisualCompactLocatorText $expectedText
  $line = Get-VisualCompactLocatorText $lineText
  if (-not $expected -or -not $line -or @("exact", "fuzzy") -notcontains $matchMode) {
    return @{ ok = $false; exactMatch = $false; common = 0; score = 0.0 }
  }
  $common = Get-VisualLongestCommonSubstringLength $expected $line
  $denominator = [Math]::Max(1, [Math]::Min($expected.Length, $line.Length))
  $score = [double]$common / [double]$denominator
  # FormKC normalizes the full-width author separator to ':'. Compare the
  # complete body after the first separator so body prefixes cannot be treated
  # as part of the author.
  $separatorIndex = $line.IndexOf(":", [StringComparison]::Ordinal)
  $exactMatch = $line -ceq $expected -or
    ($separatorIndex -gt 0 -and $line.Substring($separatorIndex + 1) -ceq $expected)
  if ($matchMode -ceq "exact") {
    return @{ ok = $exactMatch; exactMatch = $exactMatch; common = $common; score = $score }
  }
  $minimumCommon = [Math]::Min(4, $expected.Length)
  $minimumScore = $(if ($expected.Length -lt 4) { 1.0 } else { 0.30 })
  return @{
    ok = $common -ge $minimumCommon -and $score -ge $minimumScore
    exactMatch = $exactMatch
    common = $common
    score = $score
  }
}

function Test-VisualLocatorBoundsSame($left, $right) {
  if (-not (Test-VisualBounds $left 2 2) -or -not (Test-VisualBounds $right 2 2)) { return $false }
  $leftCenterX = [double]$left.left + ([double]$left.width / 2.0)
  $leftCenterY = [double]$left.top + ([double]$left.height / 2.0)
  $rightCenterX = [double]$right.left + ([double]$right.width / 2.0)
  $rightCenterY = [double]$right.top + ([double]$right.height / 2.0)
  return [Math]::Abs($leftCenterX - $rightCenterX) -le 12.0 -and
    [Math]::Abs($leftCenterY - $rightCenterY) -le 10.0
}

function Find-VisualCommentCandidate(
  $frame,
  $postBounds,
  $menu,
  [string]$commentText,
  [string]$matchMode = "fuzzy",
  $nextPostTop = $null
) {
  $expected = Get-VisualCompactLocatorText $commentText
  if (-not $expected) { return @{ ok = $false; reason = "moments_comment_missing" } }
  if (@("exact", "fuzzy") -notcontains $matchMode) {
    return @{ ok = $false; reason = "moments_comment_match_mode_invalid"; candidateCount = 0 }
  }
  $region = Get-VisualCommentTextRegion $frame $postBounds $menu $nextPostTop
  if (-not (Test-VisualBounds $region 20 12)) {
    return @{
      ok = $false
      reason = "moments_comment_candidate_region_invalid"
      candidateCount = 0
      regionComplete = [bool]$region.complete
    }
  }
  $regionPixelHash = Get-MomentsPixelHash $frame $region
  if (-not $regionPixelHash) {
    return @{
      ok = $false
      reason = "moments_comment_candidate_hash_failed"
      candidateCount = 0
      regionComplete = [bool]$region.complete
      regionBounds = $region
    }
  }
  $observations = @(
    (Get-MomentsOcrObservation $frame $region),
    (Get-MomentsScaledOcrObservation $frame $region 3),
    (Get-MomentsHighContrastOcrObservation $frame $region 4)
  )
  $usable = @($observations | Where-Object { $_ -and $_.ok })
  if ($usable.Count -eq 0) {
    return @{
      ok = $false
      reason = "moments_comment_candidate_ocr_unavailable"
      candidateCount = 0
      normalizedTextCount = 0
      regionComplete = [bool]$region.complete
      regionBounds = $region
      regionPixelHash = $regionPixelHash
    }
  }
  [int]$normalizedTextCount = 0
  foreach ($observation in $usable) {
    $normalizedTextCount = [Math]::Max(
      $normalizedTextCount,
      (Get-VisualNormalizedOcrCount ([string]$observation.text) $commentText)
    )
  }
  $candidates = New-Object System.Collections.Generic.List[object]
  $fuzzyCandidates = New-Object System.Collections.Generic.List[object]
  foreach ($observation in $usable) {
    foreach ($line in @($observation.lines)) {
      $lineText = Get-VisualCompactLocatorText ([string]$line.text)
      if (-not $lineText -or -not (Test-VisualBounds $line.bounds 2 2)) { continue }
      $match = Get-VisualCommentLineMatch $expected $lineText $matchMode
      if ($matchMode -ceq "exact" -and -not $match.ok) {
        $fuzzyMatch = Get-VisualCommentLineMatch $expected $lineText "fuzzy"
        if ($fuzzyMatch.ok) {
          [void]$fuzzyCandidates.Add(@{
            score = [double]$fuzzyMatch.score
            common = [int]$fuzzyMatch.common
            bounds = @{
              left = [double]$region.left + [double]$line.bounds.left
              top = [double]$region.top + [double]$line.bounds.top
              width = [double]$line.bounds.width
              height = [double]$line.bounds.height
            }
          })
        }
      }
      if (-not $match.ok) { continue }
      [void]$candidates.Add(@{
        score = [double]$match.score
        common = [int]$match.common
        exactMatch = [bool]$match.exactMatch
        bounds = @{
          left = [double]$region.left + [double]$line.bounds.left
          top = [double]$region.top + [double]$line.bounds.top
          width = [double]$line.bounds.width
          height = [double]$line.bounds.height
        }
      })
    }
  }
  if ($candidates.Count -eq 0) {
    return @{
      ok = $false
      reason = "moments_comment_candidate_not_found"
      candidateCount = 0
      normalizedTextCount = $normalizedTextCount
      fuzzyCandidateCount = $fuzzyCandidates.Count
      regionComplete = [bool]$region.complete
      regionBounds = $region
      regionPixelHash = $regionPixelHash
    }
  }
  $ordered = @($candidates.ToArray() | Sort-Object -Property @{ Expression = { [double]$_.score }; Descending = $true }, @{ Expression = { [int]$_.common }; Descending = $true })
  $best = $ordered[0]
  $minimumCompetitiveScore = $(if ($matchMode -ceq "exact") { 1.0 } elseif ($expected.Length -lt 4) { 1.0 } else { 0.30 })
  $competitive = @($ordered | Where-Object { [double]$_.score -ge [Math]::Max($minimumCompetitiveScore, [double]$best.score - 0.08) })
  $locations = New-Object System.Collections.Generic.List[object]
  foreach ($candidate in $competitive) {
    $same = @($locations.ToArray() | Where-Object { Test-VisualLocatorBoundsSame $_.bounds $candidate.bounds })
    if ($same.Count -eq 0) { [void]$locations.Add($candidate) }
  }
  if ($locations.Count -ne 1) {
    return @{
      ok = $false
      reason = "moments_comment_candidate_ambiguous"
      candidateCount = $locations.Count
      normalizedTextCount = $normalizedTextCount
      fuzzyCandidateCount = $fuzzyCandidates.Count
      regionComplete = [bool]$region.complete
      regionBounds = $region
      regionPixelHash = $regionPixelHash
    }
  }
  $bounds = $locations[0].bounds
  if (-not (Test-VisualBoundsInside $bounds @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height })) {
    return @{
      ok = $false
      reason = "moments_comment_candidate_outside_window"
      candidateCount = 1
      normalizedTextCount = $normalizedTextCount
      fuzzyCandidateCount = $fuzzyCandidates.Count
      regionComplete = [bool]$region.complete
      regionBounds = $region
      regionPixelHash = $regionPixelHash
    }
  }
  $pixelHash = Get-MomentsPixelHash $frame $bounds
  if (-not $pixelHash) {
    return @{ ok = $false; reason = "moments_comment_candidate_hash_failed"; candidateCount = 1; normalizedTextCount = $normalizedTextCount }
  }
  return @{
    ok = $true
    candidateCount = 1
    normalizedTextCount = $normalizedTextCount
    fuzzyCandidateCount = $fuzzyCandidates.Count
    bounds = $bounds
    pixelHash = $pixelHash
    score = [double]$locations[0].score
    common = [int]$locations[0].common
    exactMatch = [bool]$locations[0].exactMatch
    matchMode = $matchMode
    regionComplete = [bool]$region.complete
    regionBounds = $region
    regionPixelHash = $regionPixelHash
  }
}

function Resolve-VisualCommentOccurrence($first, $second) {
  $regionStable = [bool]$first.regionComplete -and
    [bool]$second.regionComplete -and
    (Test-VisualBoundsNear $first.regionBounds $second.regionBounds 2.0) -and
    -not [string]::IsNullOrWhiteSpace([string]$first.regionPixelHash) -and
    [string]$first.regionPixelHash -ceq [string]$second.regionPixelHash
  $singleLineStable = $regionStable -and
    $first.ok -and
    $second.ok -and
    [bool]$first.exactMatch -and
    [bool]$second.exactMatch -and
    (Test-VisualLocatorBoundsSame $first.bounds $second.bounds)
  if ($singleLineStable) {
    return @{
      ok = $true
      commentOccurrence = "present"
      verificationMode = "two_frame_exact_comment_line"
    }
  }

  $firstAbsent = -not $first.ok -and
    [string]$first.reason -ceq "moments_comment_candidate_not_found" -and
    [int]$first.candidateCount -eq 0 -and
    [int]$first.normalizedTextCount -eq 0 -and
    [int]$first.fuzzyCandidateCount -eq 0
  $secondAbsent = -not $second.ok -and
    [string]$second.reason -ceq "moments_comment_candidate_not_found" -and
    [int]$second.candidateCount -eq 0 -and
    [int]$second.normalizedTextCount -eq 0 -and
    [int]$second.fuzzyCandidateCount -eq 0
  if ($regionStable -and $firstAbsent -and $secondAbsent) {
    return @{
      ok = $true
      commentOccurrence = "absent"
      verificationMode = "two_frame_complete_comment_region_absence"
    }
  }
  return @{
    ok = $false
    commentOccurrence = "unresolved"
    verificationMode = "two_frame_exact_comment_region"
  }
}

function Get-VisualTextSha256([string]$value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))
    return [BitConverter]::ToString($digest).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Test-VisualCommentReadbackSeed($seed, $context, $lock) {
  if ($seed -eq $null -or [int]$seed.version -ne 1 -or
    [string]$seed.observationId -cne [string]$context.observationId -or
    [string]$seed.attemptKey -cne [string]$context.attemptKey -or
    [string]$seed.postFingerprint -cne [string]$context.postFingerprint -or
    [string]$seed.commentTextSha256 -cne (Get-VisualTextSha256 ([string]$context.commentText)) -or
    [string]$seed.candidatePixelHash -notmatch '^[0-9a-f]{64}$' -or
    [string]$seed.avatarHash -notmatch '^[0-9a-f]{64}$' -or
    [int64]$seed.expectedInputTick -lt 0 -or
    [int64]$seed.expectedInputTick -ge [uint32]::MaxValue) { return $false }
  $windowBounds = @{ left = 0.0; top = 0.0; width = [double]$context.expectedWindow.width; height = [double]$context.expectedWindow.height }
  $postBounds = ConvertTo-RelativeVisualBounds $context.postSnapshot.bounds $context.expectedWindow
  $menuBounds = ConvertTo-RelativeVisualBounds $context.postSnapshot.menu_bounds $context.expectedWindow
  if (-not (Test-VisualBounds $seed.candidateBounds 4 4) -or -not (Test-VisualBoundsInside $seed.candidateBounds $windowBounds) -or
    [double]$seed.candidateBounds.left -lt ([double]$postBounds.left - 2.0) -or
    ([double]$seed.candidateBounds.left + [double]$seed.candidateBounds.width) -gt ([double]$postBounds.left + [double]$postBounds.width + 2.0) -or
    [double]$seed.candidateBounds.top -lt ([double]$menuBounds.top + [double]$menuBounds.height - 2.0) -or
    -not (Test-VisualBoundsNear $seed.menuBounds $menuBounds 3.0)) { return $false }
  $createdAtMs = [int64]$seed.createdAtMs
  return $createdAtMs -gt 0 -and $createdAtMs -le [int64]$context.deadlineMs -and
    $createdAtMs -le ((Get-VisualEpochMs) + 5000) -and [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd)
}

function Test-VisualReadbackCandidateFrame($frame, $seed, $context) {
  $candidateHash = Get-MomentsPixelHash $frame $seed.candidateBounds
  $avatarBounds = ConvertTo-RelativeVisualBounds $context.postSnapshot.avatar_bounds $context.expectedWindow
  $avatarHash = Get-MomentsPixelHash $frame $avatarBounds
  $menus = @(Find-MomentsMenuDots $frame)
  $menuResolution = Resolve-VisualMenuAnchor $menus $seed.menuBounds 3.0
  return @{
    ok = $candidateHash -and $candidateHash -ceq [string]$seed.candidatePixelHash -and
      $avatarHash -and $avatarHash -ceq [string]$seed.avatarHash -and $menuResolution.ok
    candidateHash = $candidateHash
    avatarHash = $avatarHash
    menuCount = [int]$menuResolution.diagnostics.distinctCandidateCount
    menuDiagnostics = $menuResolution.diagnostics
  }
}

function Invoke-VisualCommentReadback($lock, $context) {
  $proof = @{
    commentCandidateUnique = $false
    commentBoundsInsideLockedWindow = $false
    popupDirectOwnerVerified = $false
    popupStable = $false
    popupPlacementAnchored = $false
    copyMenuItemUnique = $false
    copyMenuItemExact = $false
    copyMenuBoundsInsidePopup = $false
    clipboardSentinelInstalled = $false
    clipboardSequenceChanged = $false
    clipboardOwnedByLockedProcess = $false
    clipboardOrdinalMatched = $false
    clipboardRestored = $false
    popupClosed = $false
  }
  $reason = ""
  $originalClipboardEmpty = $false
  $originalClipboardText = ""
  $clipboardCaptured = $false
  [uint32]$clipboardSequenceAtCapture = 0
  $clipboardOwnedEmpty = $false
  [uint32]$clipboardOwnedSequence = 0
  $clipboardOwnedText = ""
  $clipboardMutated = $false
  $popup = $null
  $popupCandidates = @()
  $beforeHandles = @()
  $rightClickIssued = $false
  $candidateX = 0
  $candidateY = 0
  try {
    $seed = $context.readbackSeed
    if (-not (Test-VisualCommentReadbackSeed $seed $context $lock)) { throw "moments_comment_readback_seed_invalid" }
    $windowBounds = @{ left = 0.0; top = 0.0; width = [double]$context.expectedWindow.width; height = [double]$context.expectedWindow.height }
    $proof.commentBoundsInsideLockedWindow = Test-VisualBoundsInside $seed.candidateBounds $windowBounds
    if (-not $proof.commentBoundsInsideLockedWindow) { throw "moments_comment_readback_candidate_outside_window" }

    $firstFrame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
    if (-not $firstFrame.ok) { throw $firstFrame.reason }
    try { $firstCandidate = Test-VisualReadbackCandidateFrame $firstFrame $seed $context }
    finally { Close-MomentsVisualFrame $firstFrame }
    if (-not $firstCandidate.ok) { throw "moments_comment_readback_candidate_changed" }
    Start-Sleep -Milliseconds 150
    $secondFrame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
    if (-not $secondFrame.ok) { throw $secondFrame.reason }
    try { $secondCandidate = Test-VisualReadbackCandidateFrame $secondFrame $seed $context }
    finally { Close-MomentsVisualFrame $secondFrame }
    if (-not $secondCandidate.ok -or [string]$secondCandidate.candidateHash -cne [string]$firstCandidate.candidateHash) {
      throw "moments_comment_readback_candidate_changed"
    }
    $proof.commentCandidateUnique = $true

    [uint32]$capturedClipboardSequence = 0
    if (-not [Win32WechatMomentsVisualAction]::TryCaptureTextClipboard(
      [ref]$capturedClipboardSequence,
      [ref]$originalClipboardEmpty,
      [ref]$originalClipboardText
    )) { throw "moments_comment_readback_clipboard_backup_unsupported" }
    $clipboardSequenceAtCapture = $capturedClipboardSequence
    $clipboardCaptured = $true
    $beforeWindows = @(Get-VisualProcessWindows $lock.pid)
    $beforeHandles = @($beforeWindows | ForEach-Object { [string]$_.hWndText })

    $candidateX = [int][Math]::Round([double]$context.expectedWindow.left + [double]$seed.candidateBounds.left + ([double]$seed.candidateBounds.width * 0.62))
    $candidateY = [int][Math]::Round([double]$context.expectedWindow.top + [double]$seed.candidateBounds.top + ([double]$seed.candidateBounds.height * 0.50))
    if (-not (Invoke-VisualOwnedRightClick $candidateX $candidateY $lock ([int64]$context.deadlineMs) ([uint32]$seed.expectedInputTick))) {
      throw "moments_comment_readback_right_click_blocked"
    }
    $rightClickIssued = $true
    $popupResult = Get-VisualSafeReadbackPopup $lock $beforeHandles $candidateX $candidateY ([int64]$context.deadlineMs)
    $popupCandidates = @($popupResult.candidates)
    $popup = $popupResult.popup
    $proof.popupDirectOwnerVerified = $popupResult.ownerVerified -eq $true
    $proof.popupStable = $popupResult.stable -eq $true
    $proof.popupPlacementAnchored = $popupResult.placementAnchored -eq $true
    if (-not $popupResult.ok) { throw $popupResult.reason }
    $placement = Get-VisualReadbackPopupPlacement $popup.bounds $lock $candidateX $candidateY
    $proof.popupPlacementAnchored = $placement.ok
    if (-not $placement.ok) { throw $placement.reason }

    $copyEntry = Get-VisualExactCopyEntry $popup
    if (-not $copyEntry.ok) { throw $copyEntry.reason }
    $proof.copyMenuItemUnique = $true
    $proof.copyMenuItemExact = $true
    $popupLocalBounds = @{ left = 0.0; top = 0.0; width = [double]$popup.bounds.width; height = [double]$popup.bounds.height }
    $proof.copyMenuBoundsInsidePopup = Test-VisualBoundsInside $copyEntry.bounds $popupLocalBounds
    if (-not $proof.copyMenuBoundsInsidePopup) { throw "moments_comment_readback_copy_entry_outside_popup" }
    $copyX = [int][Math]::Round([double]$popup.bounds.left + [double]$copyEntry.bounds.left + ([double]$copyEntry.bounds.width / 2.0))
    $copyY = [int][Math]::Round([double]$popup.bounds.top + [double]$copyEntry.bounds.top + ([double]$copyEntry.bounds.height / 2.0))
    if (-not (Test-VisualOwnedPopupCopyTarget $copyX $copyY $copyEntry.bounds $popup $lock ([int64]$context.deadlineMs)) -or
      -not (Test-VisualDeadlineMargin ([int64]$context.deadlineMs) 3000)) {
      throw "moments_comment_readback_copy_click_blocked"
    }

    $sentinel = "xiaoxi-comment-readback-sentinel-" + [Guid]::NewGuid().ToString("N")
    [uint32]$sentinelSequence = 0
    $sentinelCleanupSucceeded = $false
    $sentinelStatus = [Win32WechatMomentsVisualAction]::AtomicReplaceTextClipboard(
      $clipboardSequenceAtCapture,
      $originalClipboardEmpty,
      $originalClipboardText,
      $false,
      $sentinel,
      [ref]$sentinelSequence,
      [ref]$sentinelCleanupSucceeded
    )
    if ($sentinelStatus -eq 1 -or $sentinelStatus -eq 3) {
      $clipboardMutated = $true
      $clipboardOwnedEmpty = $false
      $clipboardOwnedSequence = $sentinelSequence
      $clipboardOwnedText = $sentinel
    } elseif ($sentinelStatus -eq 2) {
      $clipboardMutated = $true
      $clipboardOwnedEmpty = $originalClipboardEmpty
      $clipboardOwnedSequence = $sentinelSequence
      $clipboardOwnedText = $originalClipboardText
    } elseif ($sentinelStatus -eq -1) {
      $clipboardMutated = $true
      $clipboardOwnedEmpty = $true
      $clipboardOwnedSequence = $sentinelSequence
      $clipboardOwnedText = ""
    } elseif ($sentinelStatus -lt -1) { $clipboardMutated = $true }
    if ($sentinelStatus -ne 1 -or -not $sentinelCleanupSucceeded) { throw "moments_comment_readback_clipboard_sentinel_failed" }
    $proof.clipboardSentinelInstalled = [Win32WechatMomentsVisualAction]::ClipboardTextMatches($sentinelSequence, $false, $sentinel)
    if (-not $proof.clipboardSentinelInstalled) { throw "moments_comment_readback_clipboard_sentinel_failed" }
    $beforeSequence = $clipboardOwnedSequence
    if (-not (Invoke-VisualOwnedPopupClick $copyX $copyY $copyEntry.bounds $popup $lock ([int64]$context.deadlineMs) $sentinelSequence $sentinel)) {
      throw "moments_comment_readback_copy_click_blocked"
    }
    [uint32]$copiedSequence = 0
    for ($attempt = 0; $attempt -lt 14; $attempt++) {
      Start-Sleep -Milliseconds 35
      $currentSequence = [Win32WechatMomentsVisualAction]::GetClipboardSequenceNumber()
      if ($currentSequence -ne $beforeSequence) {
        $proof.clipboardSequenceChanged = $true
        $copiedSequence = $currentSequence
        break
      }
    }
    if (-not $proof.clipboardSequenceChanged) { throw "moments_comment_readback_clipboard_unchanged" }
    Start-Sleep -Milliseconds 35
    [uint32]$capturedCopiedSequence = 0
    $copied = ""
    [uint32]$clipboardOwnerPid = 0
    [int64]$clipboardOwnerHwnd = 0
    $copiedClipboardCaptured = $false
    for ($captureAttempt = 0; $captureAttempt -lt 6; $captureAttempt++) {
      if ([Win32WechatMomentsVisualAction]::GetClipboardSequenceNumber() -ne $copiedSequence) { break }
      if ([Win32WechatMomentsVisualAction]::TryCaptureCopiedTextClipboard(
        [ref]$capturedCopiedSequence,
        [ref]$copied,
        [ref]$clipboardOwnerPid,
        [ref]$clipboardOwnerHwnd
      ) -and $capturedCopiedSequence -eq $copiedSequence) {
        $copiedClipboardCaptured = $true
        break
      }
      Start-Sleep -Milliseconds 35
    }
    if (-not $copiedClipboardCaptured) {
      throw "moments_comment_readback_clipboard_changed_externally"
    }
    if ([int]$clipboardOwnerPid -ne [int]$lock.pid) {
      throw "moments_comment_readback_clipboard_owner_invalid"
    }
    $clipboardOwnedEmpty = $false
    $clipboardOwnedSequence = $capturedCopiedSequence
    $clipboardOwnedText = $copied
    if (-not [Win32WechatMomentsVisualAction]::ClipboardOwnerMatchesLockedProcess(
      $clipboardOwnerHwnd, $lock.hWnd, [uint32]$lock.pid
    )) {
      throw "moments_comment_readback_clipboard_owner_invalid"
    }
    $proof.clipboardOwnedByLockedProcess = $true
    $proof.clipboardOrdinalMatched = [String]::Equals(
      $copied,
      [string]$context.commentText,
      [StringComparison]::Ordinal
    )
    if (-not $proof.clipboardOrdinalMatched) { throw "moments_comment_readback_text_mismatch" }
  } catch {
    $candidateReason = [string]$_.Exception.Message
    $reason = $(if ($candidateReason -match '^moments_[a-z0-9_:-]{1,96}$') { $candidateReason } else { "moments_comment_readback_failed" })
  } finally {
    if ($rightClickIssued) { $proof.popupClosed = Close-VisualReadbackPopups $beforeHandles $popupCandidates $lock $candidateX $candidateY }
    if ($clipboardCaptured -and -not $clipboardMutated) { $proof.clipboardRestored = $true }
    elseif ($clipboardMutated) { $proof.clipboardRestored = Restore-VisualClipboard $originalClipboardEmpty $originalClipboardText $clipboardOwnedEmpty $clipboardOwnedSequence $clipboardOwnedText }
  }
  $allProof = @($proof.GetEnumerator() | Where-Object { $_.Value -ne $true }).Count -eq 0
  if (-not $reason -and -not $allProof) { $reason = "moments_comment_readback_cleanup_failed" }
  if ($reason -or -not $allProof) {
    return @{ ok = $false; status = "readback_blocked"; reason = $reason; actionAttempted = $false; proof = $proof }
  }
  return @{
    ok = $true
    status = "readback_verified"
    actionAttempted = $false
    commentStatus = "verified"
    verificationMode = "unique_copy_menu_clipboard_sequence_ordinal_v2"
    proof = $proof
  }
}

function Get-VisualCommentEditorAdapter($lock, $composerBounds, [string]$expectedRuntimeId = "", $expectedElementBounds = $null) {
  if ($lock -eq $null -or $lock.root -eq $null -or -not (Test-VisualBounds $composerBounds 40 18) -or
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd) {
    return @{ ok = $false; reason = "moments_comment_editor_targeting_unsupported" }
  }
  $absoluteComposer = @{
    left = [double]$lock.windowRect.Left + [double]$composerBounds.left
    top = [double]$lock.windowRect.Top + [double]$composerBounds.top
    width = [double]$composerBounds.width
    height = [double]$composerBounds.height
  }
  $expandedComposer = @{
    left = [double]$absoluteComposer.left - 3.0
    top = [double]$absoluteComposer.top - 3.0
    width = [double]$absoluteComposer.width + 6.0
    height = [double]$absoluteComposer.height + 6.0
  }
  $candidates = New-Object System.Collections.Generic.List[object]
  $seenRuntimeIds = @{}
  $elementsToInspect = New-Object System.Collections.Generic.List[object]
  try {
    $elements = $lock.root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($element in $elements) { $elementsToInspect.Add($element) }
  } catch {}
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused -ne $null) {
      $current = $focused
      for ($depth = 0; $depth -lt 4 -and $current -ne $null; $depth++) {
        $elementsToInspect.Add($current)
        $current = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($current)
      }
    }
  } catch {}
  foreach ($horizontalRatio in @(0.18, 0.50, 0.82)) {
    try {
      $point = [System.Windows.Point]::new(
        [double]$absoluteComposer.left + ([double]$absoluteComposer.width * [double]$horizontalRatio),
        [double]$absoluteComposer.top + ([double]$absoluteComposer.height * 0.27)
      )
      $hit = [System.Windows.Automation.AutomationElement]::FromPoint($point)
      if ($hit -eq $null) { continue }
      $current = $hit
      for ($depth = 0; $depth -lt 4 -and $current -ne $null; $depth++) {
        $elementsToInspect.Add($current)
        $current = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($current)
      }
    } catch {}
  }
  try {
    foreach ($element in $elementsToInspect) {
      try {
        $current = $element.Current
        if ([int]$current.ProcessId -ne [int]$lock.pid -or -not $current.IsEnabled -or $current.IsOffscreen) { continue }
        $controlType = [string]$current.ControlType.ProgrammaticName
        $rect = $current.BoundingRectangle
        $bounds = @{ left = [double]$rect.X; top = [double]$rect.Y; width = [double]$rect.Width; height = [double]$rect.Height }
        if (-not (Test-VisualBounds $bounds 20 12) -or -not (Test-VisualBoundsInside $bounds $expandedComposer)) { continue }
        if ($expectedElementBounds -ne $null -and -not (Test-VisualBoundsNear $bounds $expectedElementBounds 1.5)) { continue }
        $runtimeId = (@($element.GetRuntimeId()) | ForEach-Object { [string][int]$_ }) -join "."
        if ([string]::IsNullOrWhiteSpace($runtimeId) -or
          (-not [string]::IsNullOrWhiteSpace($expectedRuntimeId) -and $runtimeId -cne $expectedRuntimeId) -or
          $seenRuntimeIds.ContainsKey($runtimeId)) { continue }

        $valuePattern = $null
        $valueUsable = $false
        $valueRaw = $null
        if (@("ControlType.Edit", "ControlType.Document") -contains $controlType -and
          $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
          $valueRaw = $valuePattern.Current.Value
          $valueUsable = $null -ne $valueRaw -and -not $valuePattern.Current.IsReadOnly
        }
        if (-not $valueUsable) { continue }
        $adapterType = "uia_value_pattern"
        $pattern = $valuePattern
        $raw = $valueRaw
        if ($null -eq $raw) { continue }
        $seenRuntimeIds[$runtimeId] = $true
        $candidates.Add(@{
          element = $element
          pattern = $pattern
          adapterType = $adapterType
          runtimeId = $runtimeId
          bounds = $bounds
          controlType = $controlType
          value = [string]$raw
        })
      } catch {}
    }
  } catch {
    return @{ ok = $false; reason = "moments_comment_editor_targeting_unsupported" }
  }
  if ($candidates.Count -eq 0) { return @{ ok = $false; reason = "moments_comment_editor_targeting_unsupported" } }
  if ($candidates.Count -ne 1) { return @{ ok = $false; reason = "moments_comment_editor_ambiguous" } }
  $candidate = $candidates[0]
  return @{
    ok = $true
    element = $candidate.element
    pattern = $candidate.pattern
    adapterType = $candidate.adapterType
    runtimeId = $candidate.runtimeId
    bounds = $candidate.bounds
    controlType = $candidate.controlType
    value = $candidate.value
  }
}

function Set-VisualCommentEditorAdapterValue($adapter, [string]$newValue) {
  if ($adapter -eq $null -or -not $adapter.ok -or $adapter.pattern -eq $null) { return $false }
  try {
    $adapter.pattern.SetValue($newValue)
    return $true
  } catch {
    return $false
  }
}

function Get-VisualCommentDraftTargeted($lock, $composerBounds, [uint32]$expectedInputTick) {
  if ($expectedInputTick -eq [uint32]::MaxValue -or
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  $adapter = Get-VisualCommentEditorAdapter $lock $composerBounds
  if (-not $adapter.ok) { return @{ ok = $false; reason = [string]$adapter.reason } }
  if ([Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  $value = $adapter.value
  if ($null -eq $value) { return @{ ok = $false; reason = "moments_comment_draft_state_unknown" } }
  return @{
    ok = $true
    empty = ([string]$value).Length -eq 0
    text = [string]$value
    inputTick = $expectedInputTick
    editorRuntimeId = [string]$adapter.runtimeId
    editorBounds = $adapter.bounds
    editorAdapter = [string]$adapter.adapterType
  }
}

function Set-VisualCommentTextTargeted($lock, $composerBounds, [string]$commentText, [string]$editorRuntimeId, $editorBounds, [uint32]$expectedInputTick) {
  if (-not $commentText -or [string]::IsNullOrWhiteSpace($editorRuntimeId) -or
    $expectedInputTick -eq [uint32]::MaxValue -or
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) {
    return @{ ok = $false; reason = "moments_comment_editor_changed"; editorRuntimeId = $editorRuntimeId; valueSetAttempted = $false }
  }
  $adapter = Get-VisualCommentEditorAdapter $lock $composerBounds $editorRuntimeId $editorBounds
  if (-not $adapter.ok) {
    return @{ ok = $false; reason = [string]$adapter.reason; editorRuntimeId = $editorRuntimeId; valueSetAttempted = $false }
  }
  if (-not [String]::Equals([string]$adapter.value, "", [StringComparison]::Ordinal)) {
    return @{ ok = $false; reason = "moments_comment_preexisting_draft"; editorRuntimeId = $editorRuntimeId; valueSetAttempted = $false }
  }
  if ([Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) {
    return @{ ok = $false; reason = "moments_comment_editor_changed"; editorRuntimeId = $editorRuntimeId; valueSetAttempted = $false }
  }
  if (-not (Set-VisualCommentEditorAdapterValue $adapter $commentText)) {
    return @{ ok = $false; reason = "moments_comment_editor_targeting_unsupported"; editorRuntimeId = $editorRuntimeId; valueSetAttempted = $true }
  }
  Start-Sleep -Milliseconds 120
  $confirmed = Get-VisualCommentEditorAdapter $lock $composerBounds $editorRuntimeId $editorBounds
  $inputUnchanged = [Win32WechatMomentsVisualAction]::GetForegroundWindow() -eq $lock.hWnd -and
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -eq $expectedInputTick
  if (-not $confirmed.ok -or -not $inputUnchanged -or
    -not [String]::Equals([string]$confirmed.value, $commentText, [StringComparison]::Ordinal)) {
    return @{ ok = $false; reason = "moments_comment_roundtrip_mismatch"; editorRuntimeId = $editorRuntimeId; valueSetAttempted = $true }
  }
  return @{
    ok = $true
    editorRuntimeId = $editorRuntimeId
    editorBounds = $editorBounds
    editorAdapter = [string]$confirmed.adapterType
    valueSetAttempted = $true
  }
}

function Clear-VisualCommentTextTargetedIfExact($lock, $composerBounds, [string]$expectedText, [string]$editorRuntimeId, $editorBounds, [uint32]$expectedInputTick) {
  if (-not $expectedText -or [string]::IsNullOrWhiteSpace($editorRuntimeId) -or
    $expectedInputTick -eq [uint32]::MaxValue -or
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) { return $false }
  $adapter = Get-VisualCommentEditorAdapter $lock $composerBounds $editorRuntimeId $editorBounds
  if (-not $adapter.ok -or
    -not [String]::Equals([string]$adapter.value, $expectedText, [StringComparison]::Ordinal)) { return $false }
  if ([Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) { return $false }
  if (-not (Set-VisualCommentEditorAdapterValue $adapter "")) { return $false }
  Start-Sleep -Milliseconds 100
  if ([Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) { return $false }
  $confirmed = Get-VisualCommentEditorAdapter $lock $composerBounds $editorRuntimeId $editorBounds
  return $confirmed.ok -and [String]::Equals([string]$confirmed.value, "", [StringComparison]::Ordinal)
}




function Dismiss-VisualCommentComposer($lock, $menu, [uint32]$expectedInputTick) {
  if ($menu -eq $null -or $expectedInputTick -eq [uint32]::MaxValue -or
    -not (Invoke-VisualNeutralTitleBarClick $lock $expectedInputTick)) { return $false }
  try {
    $missingFrames = 0
    for ($attempt = 0; $attempt -lt 7; $attempt++) {
      $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
      if (-not $frame.ok) {
        Close-MomentsVisualFrame $frame
        return $false
      }
      try {
        $composer = Get-VisualCommentComposer $frame $menu
        if (-not $composer.ok -and [string]$composer.reason -ceq "moments_comment_composer_not_found") {
          $missingFrames += 1
          if ($missingFrames -ge 2) { return $true }
        } else {
          $missingFrames = 0
        }
      } finally {
        Close-MomentsVisualFrame $frame
      }
      Start-Sleep -Milliseconds 120
    }
    return $false
  } finally {
    Move-VisualCursorToNeutral $lock
  }
}

function Get-LockedVisualCommentState($lock, $menu, $expectedComposerBounds, $expectedAvatarBounds, [string]$expectedAvatarHash) {
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
  if (-not $frame.ok) {
    Close-MomentsVisualFrame $frame
    return @{ ok = $false; reason = $frame.reason }
  }
  try {
    $composer = Get-VisualCommentComposer $frame $menu
    $send = Get-VisualSendButton $frame $composer
    $avatarHash = Get-MomentsPixelHash $frame $expectedAvatarBounds
    if (-not $composer.ok -or -not (Test-VisualBoundsNear $composer.bounds $expectedComposerBounds 4.0) -or
      -not $avatarHash -or $avatarHash -cne $expectedAvatarHash) {
      return @{
        ok = $false
        reason = $(if (-not $composer.ok) { $composer.reason } else { "moments_post_anchor_changed" })
        composer = $composer
        send = $send
        avatarHash = $avatarHash
      }
    }
    return @{ ok = $true; composer = $composer; send = $send; avatarHash = $avatarHash }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Get-LockedVisualCommentSendState($lock, $menu) {
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
  if (-not $frame.ok) {
    Close-MomentsVisualFrame $frame
    return @{ ok = $false; reason = [string]$frame.reason }
  }
  try {
    $composer = Get-VisualCommentComposer $frame $menu
    if (-not $composer.ok) {
      return @{ ok = $false; reason = [string]$composer.reason; composer = $composer }
    }
    $send = Get-VisualSendButton $frame $composer
    if (-not $send.ok -or -not (Test-VisualBoundsInside $send.bounds $composer.bounds)) {
      return @{
        ok = $false
        reason = $(if (-not $send.ok) { [string]$send.reason } else { "moments_comment_send_button_ambiguous" })
        composer = $composer
        send = $send
      }
    }
    return @{ ok = $true; composer = $composer; send = $send }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Test-VisualSelectedCommentDraftEmpty($state) {
  return $state.ok -and -not $state.send.ok -and
    [string]$state.send.reason -ceq "moments_comment_send_button_not_found"
}

function Get-VisualInputTick {
  return [uint32][Win32WechatMomentsVisualAction]::GetLastInputTick()
}

function Test-VisualLockedForeground($lock) {
  return $lock -ne $null -and $lock.hWnd -ne [IntPtr]::Zero -and
    [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd) -and
    -not [Win32WechatMomentsVisualAction]::IsIconic($lock.hWnd) -and
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -eq $lock.hWnd
}

function Read-VisualBlankCommentFrame($lock, $menu, $expectedAvatarBounds) {
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
  if (-not $frame.ok) {
    Close-MomentsVisualFrame $frame
    return @{ ok = $false; reason = [string]$frame.reason }
  }
  try {
    $composer = Get-VisualCommentComposer $frame $menu
    return @{
      ok = $true
      composer = $composer
      send = Get-VisualSendButton $frame $composer
      avatarHash = Get-MomentsPixelHash $frame $expectedAvatarBounds
    }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Get-VisualStableBlankCommentCheckpoint(
  $lock,
  $menu,
  $expectedComposerBounds,
  $expectedAvatarBounds,
  [string]$expectedAvatarHash
) {
  [uint32]$retryBaselineTick = [uint32]::MaxValue
  $blankCheckpointRetryCount = 0
  $retryReason = ""
  for ($pass = 0; $pass -lt 2; $pass++) {
    [uint32]$startedTick = Get-VisualInputTick
    if ($startedTick -eq [uint32]::MaxValue -or
      ($pass -gt 0 -and $startedTick -ne $retryBaselineTick)) {
      return @{
        ok = $false
        reason = "moments_external_input_detected"
        safeToDismiss = $false
        diagnostics = @{
          blankCheckpointRetryCount = $blankCheckpointRetryCount
          retryReason = $retryReason
          checkpointPass = $pass
          startedInputTick = $startedTick
          finishedInputTick = [uint32]::MaxValue
          inputTickStable = $false
        }
      }
    }
    if (-not (Test-VisualLockedForeground $lock)) {
      return @{
        ok = $false
        reason = "moments_window_not_foreground"
        safeToDismiss = $false
        diagnostics = @{
          blankCheckpointRetryCount = $blankCheckpointRetryCount
          retryReason = $retryReason
          checkpointPass = $pass
          startedInputTick = $startedTick
          finishedInputTick = $startedTick
          inputTickStable = $true
        }
      }
    }

    Start-Sleep -Milliseconds 140
    $stableState = Read-VisualBlankCommentFrame $lock $menu $expectedAvatarBounds
    if (-not $stableState.ok) {
      return @{
        ok = $false
        reason = [string]$stableState.reason
        safeToDismiss = $false
        diagnostics = @{
          blankCheckpointRetryCount = $blankCheckpointRetryCount
          retryReason = $retryReason
          checkpointPass = $pass
          startedInputTick = $startedTick
          finishedInputTick = (Get-VisualInputTick)
          inputTickStable = $false
          stableComposerOk = $false
          stableComposerReason = [string]$stableState.reason
        }
      }
    }
    Start-Sleep -Milliseconds 260
    $settledState = Read-VisualBlankCommentFrame $lock $menu $expectedAvatarBounds
    if (-not $settledState.ok) {
      return @{
        ok = $false
        reason = [string]$settledState.reason
        safeToDismiss = $false
        diagnostics = @{
          blankCheckpointRetryCount = $blankCheckpointRetryCount
          retryReason = $retryReason
          checkpointPass = $pass
          startedInputTick = $startedTick
          finishedInputTick = (Get-VisualInputTick)
          inputTickStable = $false
          stableComposerOk = [bool]$stableState.composer.ok
          stableComposerReason = [string]$stableState.composer.reason
          settledComposerOk = $false
          settledComposerReason = [string]$settledState.reason
          stableSendOk = [bool]$stableState.send.ok
          stableSendReason = [string]$stableState.send.reason
          stableSendCandidateCount = [int]$stableState.send.candidateCount
        }
      }
    }
    [uint32]$finishedTick = Get-VisualInputTick
    $diagnostics = @{
      blankCheckpointRetryCount = $blankCheckpointRetryCount
      retryReason = $retryReason
      checkpointPass = $pass
      startedInputTick = $startedTick
      finishedInputTick = $finishedTick
      inputTickStable = $finishedTick -eq $startedTick
      stableComposerOk = [bool]$stableState.composer.ok
      stableComposerReason = [string]$stableState.composer.reason
      settledComposerOk = [bool]$settledState.composer.ok
      settledComposerReason = [string]$settledState.composer.reason
      stableSendOk = [bool]$stableState.send.ok
      stableSendReason = [string]$stableState.send.reason
      settledSendOk = [bool]$settledState.send.ok
      settledSendReason = [string]$settledState.send.reason
      stableSendCandidateCount = [int]$stableState.send.candidateCount
      settledSendCandidateCount = [int]$settledState.send.candidateCount
    }

    if ($stableState.send.ok -or $settledState.send.ok) {
      return @{
        ok = $false
        reason = "moments_comment_preexisting_draft"
        inputTick = $finishedTick
        safeToDismiss = $false
        diagnostics = $diagnostics
      }
    }
    if (-not $stableState.composer.ok -or -not $settledState.composer.ok -or
      [string]$stableState.send.reason -cne "moments_comment_send_button_not_found" -or
      [string]$settledState.send.reason -cne "moments_comment_send_button_not_found") {
      if ($pass -eq 0 -and $finishedTick -eq $startedTick -and (Test-VisualLockedForeground $lock)) {
        $blankCheckpointRetryCount = 1
        $retryReason = "moments_comment_draft_state_unknown"
        $retryBaselineTick = $finishedTick
        Start-Sleep -Milliseconds 160
        continue
      }
      $diagnostics.blankCheckpointRetryCount = $blankCheckpointRetryCount
      $diagnostics.retryReason = $retryReason
      return @{
        ok = $false
        reason = "moments_comment_draft_state_unknown"
        inputTick = $finishedTick
        safeToDismiss = $false
        diagnostics = $diagnostics
      }
    }
    if (-not (Test-VisualBoundsNear $stableState.composer.bounds $expectedComposerBounds 4.0) -or
      -not (Test-VisualBoundsNear $settledState.composer.bounds $expectedComposerBounds 4.0) -or
      -not (Test-VisualBoundsNear $stableState.composer.bounds $settledState.composer.bounds 4.0)) {
      return @{
        ok = $false
        reason = "moments_comment_editor_changed"
        inputTick = $finishedTick
        safeToDismiss = $false
        diagnostics = $diagnostics
      }
    }
    if (-not $stableState.avatarHash -or $stableState.avatarHash -cne $expectedAvatarHash -or
      -not $settledState.avatarHash -or $settledState.avatarHash -cne $expectedAvatarHash) {
      return @{
        ok = $false
        reason = "moments_post_anchor_changed"
        inputTick = $finishedTick
        safeToDismiss = $false
        diagnostics = $diagnostics
      }
    }
    if ($finishedTick -eq [uint32]::MaxValue -or -not (Test-VisualLockedForeground $lock)) {
      return @{
        ok = $false
        reason = "moments_external_input_detected"
        safeToDismiss = $false
        diagnostics = $diagnostics
      }
    }
    if ($finishedTick -eq $startedTick) {
      return @{
        ok = $true
        composer = $settledState.composer
        send = $settledState.send
        inputTick = $finishedTick
        checkpointPass = $pass
        safeToDismiss = $true
        diagnostics = $diagnostics
      }
    }
    if ($pass -eq 0) {
      # GetLastInputInfo is session-wide and can surface a delayed SendInput tick.
      # Discard both frames and require one entirely fresh, passive quiet pass.
      $blankCheckpointRetryCount = 1
      $retryReason = "moments_external_input_detected"
      $retryBaselineTick = $finishedTick
      Start-Sleep -Milliseconds 160
      continue
    }
    return @{
      ok = $false
      reason = "moments_external_input_detected"
      inputTick = $finishedTick
      safeToDismiss = $false
      diagnostics = $diagnostics
    }
  }
  return @{
    ok = $false
    reason = "moments_external_input_detected"
    safeToDismiss = $false
    diagnostics = @{
      blankCheckpointRetryCount = $blankCheckpointRetryCount
      retryReason = $retryReason
      checkpointPass = 1
      inputTickStable = $false
    }
  }
}

function Wait-VisualSelectedCommentDraftEmptyPair(
  $lock,
  $menu,
  $expectedComposerBounds,
  $expectedAvatarBounds,
  [string]$expectedAvatarHash,
  [uint32]$expectedInputTick
) {
  if ($expectedInputTick -eq [uint32]::MaxValue) {
    return @{ ok = $false; reason = "moments_external_input_detected"; safeToDismiss = $false; diagnostics = @{ stage = "invalid_expected_tick" } }
  }

  # GetLastInputInfo is session-wide and may expose our Backspace tick after
  # the key helper returns. Permit one passive rebaseline only: discard every
  # frame from the changing pass, then require a wholly quiet two-frame pass.
  # No refocus, click or second Backspace is permitted here.
  [uint32]$retryBaselineTick = [uint32]::MaxValue
  $inputTickRebased = $false
  for ($pass = 0; $pass -lt 2; $pass++) {
    [uint32]$startedTick = Get-VisualInputTick
    if ($startedTick -eq [uint32]::MaxValue -or
      ($pass -gt 0 -and $startedTick -ne $retryBaselineTick)) {
      return @{ ok = $false; reason = "moments_external_input_detected"; safeToDismiss = $false; diagnostics = @{ stage = "quiet_pass_start"; pass = $pass; inputTickRebased = $inputTickRebased } }
    }
    if ($pass -eq 0 -and $startedTick -ne $expectedInputTick) {
      $inputTickRebased = $true
      Start-Sleep -Milliseconds 160
      [uint32]$quietStartTick = Get-VisualInputTick
      if ($quietStartTick -eq [uint32]::MaxValue -or $quietStartTick -ne $startedTick) {
        return @{ ok = $false; reason = "moments_external_input_detected"; safeToDismiss = $false; diagnostics = @{ stage = "initial_rebase_not_quiet"; pass = $pass; inputTickRebased = $true } }
      }
      $startedTick = $quietStartTick
    }
    if (-not (Test-VisualLockedForeground $lock)) {
      return @{ ok = $false; reason = "moments_window_not_foreground"; safeToDismiss = $false; diagnostics = @{ stage = "quiet_pass_start"; pass = $pass; inputTickRebased = $inputTickRebased } }
    }

    $firstEmptyState = Get-LockedVisualCommentState $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash
    Start-Sleep -Milliseconds 500
    $secondEmptyState = Get-LockedVisualCommentState $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash
    [uint32]$finishedTick = Get-VisualInputTick
    $firstEmpty = Test-VisualSelectedCommentDraftEmpty $firstEmptyState
    $secondEmpty = Test-VisualSelectedCommentDraftEmpty $secondEmptyState
    $diagnostics = @{
      stage = "empty_pair"
      pass = $pass
      inputTickRebased = $inputTickRebased
      firstStateOk = [bool]$firstEmptyState.ok
      firstStateReason = [string]$firstEmptyState.reason
      firstSendOk = [bool]$firstEmptyState.send.ok
      firstSendReason = [string]$firstEmptyState.send.reason
      secondStateOk = [bool]$secondEmptyState.ok
      secondStateReason = [string]$secondEmptyState.reason
      secondSendOk = [bool]$secondEmptyState.send.ok
      secondSendReason = [string]$secondEmptyState.send.reason
    }
    if (-not $firstEmptyState.ok -or -not $secondEmptyState.ok) {
      $stateReason = $(if (-not $firstEmptyState.ok) { [string]$firstEmptyState.reason } else { [string]$secondEmptyState.reason })
      return @{ ok = $false; reason = $(if ($stateReason) { $stateReason } else { "moments_comment_draft_empty_state_unverified" }); safeToDismiss = $false; diagnostics = $diagnostics }
    }
    if (-not $firstEmpty -or -not $secondEmpty) {
      return @{ ok = $false; reason = "moments_comment_draft_empty_state_unverified"; safeToDismiss = $false; diagnostics = $diagnostics }
    }
    if ($finishedTick -eq [uint32]::MaxValue -or -not (Test-VisualLockedForeground $lock)) {
      return @{ ok = $false; reason = "moments_external_input_detected"; safeToDismiss = $false; diagnostics = $diagnostics }
    }
    if ($finishedTick -eq $startedTick) {
      return @{ ok = $true; inputTick = $finishedTick; checkpointPass = $pass; inputTickRebased = $inputTickRebased; safeToDismiss = $true; diagnostics = $diagnostics }
    }
    if ($pass -eq 0 -and -not $inputTickRebased) {
      $retryBaselineTick = $finishedTick
      $inputTickRebased = $true
      Start-Sleep -Milliseconds 160
      continue
    }
    return @{ ok = $false; reason = "moments_external_input_detected"; safeToDismiss = $false; diagnostics = $diagnostics }
  }
  return @{ ok = $false; reason = "moments_external_input_detected"; safeToDismiss = $false; diagnostics = @{ stage = "quiet_pass_exhausted"; inputTickRebased = $inputTickRebased } }
}

function Dismiss-VisualProvenEmptyCommentComposer(
  $lock,
  $menu,
  $expectedComposerBounds,
  $expectedAvatarBounds,
  [string]$expectedAvatarHash,
  [uint32]$expectedInputTick
) {
  if ($menu -eq $null -or -not (Test-VisualBounds $expectedComposerBounds 40 40) -or
    -not (Test-VisualBounds $expectedAvatarBounds 12 12) -or
    [string]::IsNullOrWhiteSpace($expectedAvatarHash) -or
    $expectedInputTick -eq [uint32]::MaxValue -or
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) { return $false }

  $preFocusState = Get-LockedVisualCommentState $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash
  if (-not (Test-VisualSelectedCommentDraftEmpty $preFocusState)) { return $false }
  $focus = Focus-VisualCommentKeyboardTarget $lock $expectedComposerBounds ([int64]::MaxValue) $expectedInputTick
  if (-not $focus.ok) { return $false }
  [uint32]$focusedInputTick = [uint32]$focus.inputTick
  $focusedEmptyProof = Wait-VisualSelectedCommentDraftEmptyPair $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash $focusedInputTick
  if (-not $focusedEmptyProof.ok) { return $false }
  [uint32]$focusedEmptyInputTick = [uint32]$focusedEmptyProof.inputTick
  if ([Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $focusedEmptyInputTick -or
    -not [Win32WechatMomentsVisualAction]::AtomicKeyboardEscape()) { return $false }

  Start-Sleep -Milliseconds 120
  [uint32]$escapeInputTick = [Win32WechatMomentsVisualAction]::GetLastInputTick()
  Start-Sleep -Milliseconds 120
  [uint32]$settledEscapeInputTick = [Win32WechatMomentsVisualAction]::GetLastInputTick()
  if ($escapeInputTick -eq [uint32]::MaxValue -or $settledEscapeInputTick -eq [uint32]::MaxValue) { return $false }
  if ($settledEscapeInputTick -ne $escapeInputTick) {
    Start-Sleep -Milliseconds 160
    if ([Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $settledEscapeInputTick) { return $false }
    $escapeInputTick = $settledEscapeInputTick
  }

  $missingFrames = 0
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    if ([Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
      [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $escapeInputTick -or
      -not [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd) -or
      [Win32WechatMomentsVisualAction]::IsIconic($lock.hWnd)) { return $false }
    $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
    if (-not $frame.ok) {
      Close-MomentsVisualFrame $frame
      return $false
    }
    try {
      $remainingComposer = Get-VisualCommentComposer $frame $menu
      $remainingAvatarHash = Get-MomentsPixelHash $frame $expectedAvatarBounds
      $remainingMenus = @(Find-MomentsMenuDots $frame)
      $remainingMenuResolution = Resolve-VisualMenuAnchor $remainingMenus $menu.bounds 3.0
      if (-not $remainingAvatarHash -or $remainingAvatarHash -cne $expectedAvatarHash -or -not $remainingMenuResolution.ok) {
        return $false
      }
      if (-not $remainingComposer.ok -and [string]$remainingComposer.reason -ceq "moments_comment_composer_not_found") {
        $missingFrames += 1
        if ($missingFrames -ge 2) { return $true }
      } else {
        if (-not $remainingComposer.ok -or
          -not (Test-VisualBoundsNear $remainingComposer.bounds $expectedComposerBounds 4.0)) { return $false }
        $remainingSend = Get-VisualSendButton $frame $remainingComposer
        if ($remainingSend.ok -or [string]$remainingSend.reason -cne "moments_comment_send_button_not_found") { return $false }
        $missingFrames = 0
      }
    } finally {
      Close-MomentsVisualFrame $frame
    }
    Start-Sleep -Milliseconds 120
  }

  return Dismiss-VisualCommentComposer $lock $menu $escapeInputTick
}

function Get-VisualPostSendCommentState(
  $context,
  $opened
) {
  $stateLock = Get-LockedVisualRoot $context
  if (-not $stateLock.ok -or [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $stateLock.hWnd) {
    return @{ ok = $false; reason = $(if (-not $stateLock.ok) { [string]$stateLock.reason } else { "moments_window_not_foreground" }) }
  }
  $frame = Get-MomentsVisualFrame $stateLock.hWnd $stateLock.windowRect $stateLock.pid $false
  if (-not $frame.ok) {
    Close-MomentsVisualFrame $frame
    return @{ ok = $false; reason = [string]$frame.reason }
  }

  try {
    $composer = Get-VisualCommentComposer $frame $opened.menu
    $send = Get-VisualSendButton $frame $composer $false
    $composerClosed = -not $composer.ok -and [string]$composer.reason -ceq "moments_comment_composer_not_found"
    $sendInactive = $composer.ok -and -not $send.ok -and [string]$send.reason -ceq "moments_comment_send_button_not_found"
    $composerCompleted = $composerClosed -or $sendInactive
  } finally {
    Close-MomentsVisualFrame $frame
  }

  return @{
    ok = [bool]$composerCompleted
    reason = $(if ($composerCompleted) { "" } else { "moments_comment_composer_not_settled" })
    lock = $stateLock
    diagnostics = @{
      composerCompleted = [bool]$composerCompleted
      composerClosed = [bool]$composerClosed
      sendInactive = [bool]$sendInactive
      sendCandidateCount = [int]$send.candidateCount
    }
  }
}

function Test-VisualPostSendBudget($context, [int64]$settleDeadlineMs) {
  [int64]$nowMs = Get-VisualEpochMs
  return $settleDeadlineMs -gt 0 -and
    $nowMs -lt $settleDeadlineMs -and
    $nowMs -lt [int64]$script:visualWorkerSoftDeadlineMs -and
    (Test-VisualDeadlineMargin ([int64]$context.deadlineMs) 500)
}

function Wait-VisualPostClickInputQuiet($context, $lock) {
  if (-not (Test-VisualDeadlineMargin ([int64]$context.deadlineMs) 500)) {
    return @{ ok = $false; reason = "moments_comment_readback_seed_timeout" }
  }
  if ([Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    -not [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd) -or
    [Win32WechatMomentsVisualAction]::IsIconic($lock.hWnd)) {
    return @{ ok = $false; reason = "moments_window_not_foreground" }
  }
  return @{ ok = $true }
}

function Wait-VisualPostSendSurfaceSettled(
  $context,
  $opened,
  [int64]$settleDeadlineMs
) {
  $consecutiveFrames = 0
  $lastState = $null
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Test-VisualPostSendBudget $context $settleDeadlineMs)) { break }
    $lastState = Get-VisualPostSendCommentState $context $opened
    if (-not (Test-VisualPostSendBudget $context $settleDeadlineMs)) {
      if ($lastState.ok) {
        $deadlineConfirmation = Get-VisualPostSendCommentState $context $opened
        if ($deadlineConfirmation.ok) { return $deadlineConfirmation }
        return @{
          ok = $false
          reason = "moments_comment_readback_seed_timeout"
          diagnostics = $deadlineConfirmation.diagnostics
        }
      }
      return @{ ok = $false; reason = "moments_comment_readback_seed_timeout"; diagnostics = $lastState.diagnostics }
    }
    if ($lastState.ok) {
      $consecutiveFrames += 1
      if ($consecutiveFrames -ge 2) { return $lastState }
    } else {
      $consecutiveFrames = 0
    }
    Start-Sleep -Milliseconds 120
  }
  return @{
    ok = $false
    reason = "moments_comment_readback_surface_unsettled"
    diagnostics = $(if ($lastState) { $lastState.diagnostics } else { @{} })
  }
}

function Wait-VisualCommentReadbackSeed(
  $context,
  $opened,
  [int64]$settleDeadlineMs
) {
  $surface = Wait-VisualPostSendSurfaceSettled $context $opened $settleDeadlineMs
  if (-not $surface.ok) {
    return @{
      ok = $false
      reason = "moments_comment_readback_seed_unavailable"
      diagnostics = $surface.diagnostics
    }
  }
  return @{
    ok = $true
    stateTransitionVerified = $true
    verificationMode = "composer_closed_or_send_inactive_v1"
    normalizedOcrCountAfter = 0
    diagnostics = $surface.diagnostics
  }
}

function Set-VisualKnownClipboardText(
  [bool]$expectedEmpty,
  [uint32]$expectedSequence,
  [string]$expectedText,
  [bool]$replacementEmpty,
  [string]$replacementText
) {
  $expectedMatches = $false
  if (-not [Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
    $expectedSequence,
    $expectedEmpty,
    $expectedText,
    [ref]$expectedMatches
  ) -or -not $expectedMatches) {
    [uint32]$currentExpectedSequence = [Win32WechatMomentsVisualAction]::GetClipboardSequenceNumber()
    $currentExpectedMatches = $false
    if (-not [Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
      $currentExpectedSequence,
      $expectedEmpty,
      $expectedText,
      [ref]$currentExpectedMatches
    ) -or -not $currentExpectedMatches) {
      return @{ ok = $false; known = $false; status = 0; cleanupSucceeded = $true }
    }
    $expectedSequence = $currentExpectedSequence
  }
  [uint32]$replacementSequence = 0
  $cleanupSucceeded = $false
  $status = [Win32WechatMomentsVisualAction]::AtomicReplaceTextClipboard(
    $expectedSequence,
    $expectedEmpty,
    $expectedText,
    $replacementEmpty,
    $replacementText,
    [ref]$replacementSequence,
    [ref]$cleanupSucceeded
  )
  if ($status -eq 1 -or $status -eq 3) {
    return @{
      ok = $status -eq 1 -and $cleanupSucceeded
      known = $true
      empty = $replacementEmpty
      sequence = $replacementSequence
      text = $(if ($replacementEmpty) { "" } else { $replacementText })
      status = $status
      cleanupSucceeded = $cleanupSucceeded
    }
  }
  if ($status -eq 2) {
    return @{
      ok = $false
      known = $true
      empty = $expectedEmpty
      sequence = $replacementSequence
      text = $(if ($expectedEmpty) { "" } else { $expectedText })
      status = $status
      cleanupSucceeded = $cleanupSucceeded
    }
  }
  if ($status -eq -1) {
    return @{ ok = $false; known = $true; empty = $true; sequence = $replacementSequence; text = ""; status = $status; cleanupSucceeded = $cleanupSucceeded }
  }
  $expectedMatches = $false
  $known = [Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
    $expectedSequence,
    $expectedEmpty,
    $expectedText,
    [ref]$expectedMatches
  ) -and $expectedMatches
  return @{
    ok = $false
    known = $known
    empty = $expectedEmpty
    sequence = $expectedSequence
    text = $(if ($expectedEmpty) { "" } else { $expectedText })
    status = $status
    cleanupSucceeded = $cleanupSucceeded
  }
}

function Get-VisualClipboardAfterCopyFailure(
  $lock,
  [uint32]$sentinelSequence,
  [string]$sentinel,
  [string]$commentText
) {
  [uint32]$currentSequence = [Win32WechatMomentsVisualAction]::GetClipboardSequenceNumber()
  $sentinelMatches = $false
  if ([Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
    $currentSequence,
    $false,
    $sentinel,
    [ref]$sentinelMatches
  ) -and $sentinelMatches) {
    return @{ known = $true; empty = $false; sequence = $currentSequence; text = $sentinel }
  }

  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    [uint32]$copiedSequence = 0
    $copiedEmpty = $false
    $copiedText = ""
    [uint32]$ownerPid = 0
    [int64]$ownerHandle = 0
    if ([Win32WechatMomentsVisualAction]::TryCaptureCopiedTextClipboardState(
      [ref]$copiedSequence,
      [ref]$copiedEmpty,
      [ref]$copiedText,
      [ref]$ownerPid,
      [ref]$ownerHandle
    ) -and $copiedSequence -ne $sentinelSequence -and -not $copiedEmpty -and
      [int]$ownerPid -eq [int]$lock.pid -and
      [Win32WechatMomentsVisualAction]::ClipboardOwnerMatchesLockedProcess($ownerHandle, $lock.hWnd, [uint32]$lock.pid) -and
      [String]::Equals($copiedText, $commentText, [StringComparison]::Ordinal)) {
      return @{ known = $true; empty = $false; sequence = $copiedSequence; text = $copiedText }
    }
    Start-Sleep -Milliseconds 35
  }
  return @{ known = $false }
}

function Invoke-VisualCommentUnicodeDraftForSend(
  $lock,
  $menu,
  $expectedComposerBounds,
  [string]$commentText,
  [int64]$deadlineMs,
  [uint32]$expectedInputTick,
  [int]$normalizedOcrCountBefore
) {
  if (-not $commentText -or $commentText.Length -gt 500 -or
    -not (Test-VisualDeadline $deadlineMs)) {
    return @{ ok = $false; status = "blocked"; reason = "moments_dry_run_expired"; actionAttempted = $false }
  }
  $focus = Focus-VisualCommentKeyboardTarget $lock $expectedComposerBounds $deadlineMs $expectedInputTick
  if (-not $focus.ok) {
    return @{ ok = $false; status = "blocked"; reason = [string]$focus.reason; actionAttempted = $false }
  }
  [uint32]$inputTick = [uint32]$focus.inputTick
  $typed = Invoke-VisualOwnedUnicodeText $lock $expectedComposerBounds $inputTick $commentText
  if (-not $typed.ok) {
    return @{
      ok = $false
      status = "blocked"
      reason = [string]$typed.reason
      actionAttempted = $false
      inputTick = [uint32]$typed.inputTick
    }
  }
  [uint32]$inputTick = [uint32]$typed.inputTick
  Start-Sleep -Milliseconds 120
  $readyState = Get-LockedVisualCommentSendState $lock $menu
  if (-not $readyState.ok -or
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd) {
    return @{
      ok = $false
      status = "blocked"
      reason = $(if (-not $readyState.ok -and [string]$readyState.reason) { [string]$readyState.reason } else { "moments_window_not_foreground" })
      actionAttempted = $false
      inputTick = $inputTick
    }
  }
  return @{
    ok = $true
    status = "comment_draft_ready_for_send"
    actionAttempted = $false
    commentStatus = "draft_ready_for_send"
    verificationMode = "unicode_sendinput_and_unique_enabled_button_transition"
    normalizedOcrCountBefore = $normalizedOcrCountBefore
    sendBounds = $readyState.send.bounds
    inputTick = $inputTick
    clipboardRestored = $true
    draftRetainedForSend = $true
  }
}

function Invoke-VisualCommentCheckClipboardRoundTrip(
  $lock,
  $menu,
  $expectedComposerBounds,
  $expectedAvatarBounds,
  [string]$expectedAvatarHash,
  [string]$commentText,
  [int64]$deadlineMs,
  [uint32]$expectedInputTick,
  [int]$normalizedOcrCountBefore,
  [bool]$retainExactDraftForSend = $false
) {
  $failureReason = ""
  $draftMayExist = $false
  $unknownDraftPresent = $false
  $exactDraftProven = $false
  $draftCleared = $false
  $emptyStateCandidate = $false
  $draftCleanupReason = ""
  $draftCleanupDiagnostics = @{}
  $composerClosed = $false
  $clipboardCaptured = $false
  $clipboardChanged = $false
  $clipboardStateKnown = $false
  $clipboardRestored = $false
  $draftRetainedForSend = $false
  $sendBounds = $null
  [uint32]$inputTick = $expectedInputTick
  [uint32]$originalClipboardSequence = 0
  $originalClipboardEmpty = $false
  $originalClipboardText = ""
  [uint32]$ownedClipboardSequence = 0
  $ownedClipboardEmpty = $false
  $ownedClipboardText = ""

  try {
    if (-not $commentText -or $commentText.Length -gt 500 -or
      -not (Test-VisualDeadline $deadlineMs)) {
      throw [System.InvalidOperationException]::new("moments_dry_run_expired")
    }

    $focus = Focus-VisualCommentKeyboardTarget $lock $expectedComposerBounds $deadlineMs $inputTick
    if (-not $focus.ok) { throw [System.InvalidOperationException]::new([string]$focus.reason) }
    [uint32]$inputTick = [uint32]$focus.inputTick

    $focusedState = Get-LockedVisualCommentState $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash
    if (-not $focusedState.ok) { throw [System.InvalidOperationException]::new([string]$focusedState.reason) }
    if ($focusedState.send.ok) {
      $unknownDraftPresent = $true
      throw [System.InvalidOperationException]::new("moments_comment_preexisting_draft")
    }
    if ([string]$focusedState.send.reason -cne "moments_comment_send_button_not_found" -or
      [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $inputTick) {
      throw [System.InvalidOperationException]::new("moments_comment_draft_state_unknown")
    }

    if (-not [Win32WechatMomentsVisualAction]::TryCaptureTextClipboard(
      [ref]$originalClipboardSequence,
      [ref]$originalClipboardEmpty,
      [ref]$originalClipboardText
    )) {
      throw [System.InvalidOperationException]::new("moments_comment_clipboard_backup_unsupported")
    }
    $clipboardCaptured = $true
    $clipboardStateKnown = $true
    $clipboardRestored = $true
    $ownedClipboardSequence = $originalClipboardSequence
    $ownedClipboardEmpty = $originalClipboardEmpty
    $ownedClipboardText = $originalClipboardText

    $installedText = Set-VisualKnownClipboardText $ownedClipboardEmpty $ownedClipboardSequence $ownedClipboardText $false $commentText
    if ($installedText.known) {
      $ownedClipboardSequence = [uint32]$installedText.sequence
      $ownedClipboardEmpty = [bool]$installedText.empty
      $ownedClipboardText = [string]$installedText.text
      $clipboardStateKnown = $true
      $clipboardChanged = $ownedClipboardSequence -ne $originalClipboardSequence -or
        $ownedClipboardEmpty -ne $originalClipboardEmpty -or
        -not [String]::Equals($ownedClipboardText, $originalClipboardText, [StringComparison]::Ordinal)
      if ($clipboardChanged) { $clipboardRestored = $false }
    } else {
      $clipboardStateKnown = $false
      $clipboardChanged = $true
      $clipboardRestored = $false
    }
    if (-not $installedText.ok) { throw [System.InvalidOperationException]::new("moments_comment_clipboard_replace_failed") }

    $paste = Invoke-VisualOwnedKeyboardChord $lock $expectedComposerBounds $inputTick ([uint16]0x56) $true $ownedClipboardSequence $false $commentText
    $draftMayExist = $true
    if (-not $paste.ok) { throw [System.InvalidOperationException]::new([string]$paste.reason) }
    [uint32]$inputTick = [uint32]$paste.inputTick
    $ownedClipboardSequence = [uint32]$paste.clipboardSequence

    $sentinel = "xiaoxi-comment-check-sentinel-" + [guid]::NewGuid().ToString("N")
    $installedSentinel = Set-VisualKnownClipboardText $ownedClipboardEmpty $ownedClipboardSequence $ownedClipboardText $false $sentinel
    if ($installedSentinel.known) {
      $ownedClipboardSequence = [uint32]$installedSentinel.sequence
      $ownedClipboardEmpty = [bool]$installedSentinel.empty
      $ownedClipboardText = [string]$installedSentinel.text
      $clipboardStateKnown = $true
      $clipboardChanged = $true
      $clipboardRestored = $false
    } else {
      $clipboardStateKnown = $false
      $clipboardChanged = $true
      $clipboardRestored = $false
    }
    if (-not $installedSentinel.ok) { throw [System.InvalidOperationException]::new("moments_comment_clipboard_replace_failed") }
    [uint32]$sentinelSequence = $ownedClipboardSequence

    $selectAll = Invoke-VisualOwnedKeyboardChord $lock $expectedComposerBounds $inputTick ([uint16]0x41) $true $sentinelSequence $false $sentinel
    if (-not $selectAll.ok) { throw [System.InvalidOperationException]::new([string]$selectAll.reason) }
    [uint32]$inputTick = [uint32]$selectAll.inputTick
    $ownedClipboardSequence = [uint32]$selectAll.clipboardSequence
    $sentinelSequence = $ownedClipboardSequence
    $copy = Invoke-VisualOwnedKeyboardChord $lock $expectedComposerBounds $inputTick ([uint16]0x43) $true $sentinelSequence $false $sentinel
    if (-not $copy.ok) {
      if ($copy.inputMayHaveBeenIssued) {
        $copyFailureClipboard = Get-VisualClipboardAfterCopyFailure $lock ([uint32]$copy.clipboardSequence) $sentinel $commentText
        if ($copyFailureClipboard.known) {
          $ownedClipboardSequence = [uint32]$copyFailureClipboard.sequence
          $ownedClipboardEmpty = [bool]$copyFailureClipboard.empty
          $ownedClipboardText = [string]$copyFailureClipboard.text
          $clipboardStateKnown = $true
        } else {
          $clipboardStateKnown = $false
        }
      }
      throw [System.InvalidOperationException]::new([string]$copy.reason)
    }
    [uint32]$inputTick = [uint32]$copy.inputTick
    $ownedClipboardSequence = [uint32]$copy.clipboardSequence
    $sentinelSequence = $ownedClipboardSequence

    [uint32]$copiedSequence = 0
    $copiedEmpty = $false
    $copiedText = ""
    [uint32]$clipboardOwnerPid = 0
    [int64]$clipboardOwnerHandle = 0
    $copiedCaptured = $false
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
      if ([Win32WechatMomentsVisualAction]::TryCaptureCopiedTextClipboardState(
        [ref]$copiedSequence,
        [ref]$copiedEmpty,
        [ref]$copiedText,
        [ref]$clipboardOwnerPid,
        [ref]$clipboardOwnerHandle
      )) {
        $copiedCaptured = $true
        break
      }
      Start-Sleep -Milliseconds 35
    }
    if (-not $copiedCaptured) {
      [uint32]$fallbackSequence = 0
      $fallbackEmpty = $false
      $fallbackText = ""
      if ([Win32WechatMomentsVisualAction]::TryCaptureTextClipboard(
        [ref]$fallbackSequence,
        [ref]$fallbackEmpty,
        [ref]$fallbackText
      )) {
        $ownedClipboardSequence = $fallbackSequence
        $ownedClipboardEmpty = $fallbackEmpty
        $ownedClipboardText = $fallbackText
        $clipboardStateKnown = $true
      } else {
        $clipboardStateKnown = $false
      }
      throw [System.InvalidOperationException]::new("moments_comment_clipboard_readback_failed")
    }
    $ownedClipboardSequence = $copiedSequence
    $ownedClipboardEmpty = $copiedEmpty
    $ownedClipboardText = $copiedText
    $clipboardStateKnown = $true
    $clipboardChanged = $true
    $clipboardRestored = $false
    if ($copiedSequence -eq $sentinelSequence -or $copiedEmpty -or
      [int]$clipboardOwnerPid -ne [int]$lock.pid -or
      -not [Win32WechatMomentsVisualAction]::ClipboardOwnerMatchesLockedProcess($clipboardOwnerHandle, $lock.hWnd, [uint32]$lock.pid) -or
      -not [String]::Equals($copiedText, $commentText, [StringComparison]::Ordinal)) {
      throw [System.InvalidOperationException]::new("moments_comment_roundtrip_mismatch")
    }
    $exactDraftProven = $true

    if ([Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $inputTick) {
      throw [System.InvalidOperationException]::new("moments_external_input_detected")
    }

    if (-not $retainExactDraftForSend) {
      # Ctrl+A/C proved, byte-for-byte, that the exact owned draft is still fully
      # selected. Clear it immediately, before clipboard restoration or any
      # ready/send probing can give focus or selection time to drift.
      $clear = Invoke-VisualOwnedKeyboardBackspace $lock $expectedComposerBounds $inputTick
      if (-not $clear.ok) {
        $draftCleanupReason = [string]$clear.reason
        throw [System.InvalidOperationException]::new($draftCleanupReason)
      }
      [uint32]$inputTick = [uint32]$clear.inputTick
      $emptyProof = Wait-VisualSelectedCommentDraftEmptyPair $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash $inputTick
      if (-not $emptyProof.ok) {
        $draftCleanupReason = $(if ($emptyProof.reason) { [string]$emptyProof.reason } else { "moments_comment_draft_empty_state_unverified" })
        $draftCleanupDiagnostics = $emptyProof.diagnostics
        throw [System.InvalidOperationException]::new($draftCleanupReason)
      }
      [uint32]$inputTick = [uint32]$emptyProof.inputTick
      $emptyStateCandidate = $true
      $draftCleared = $true
      $draftMayExist = $false
      $composerClosed = Dismiss-VisualProvenEmptyCommentComposer $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash $inputTick
      if (-not $composerClosed) {
        $draftCleanupReason = "moments_comment_composer_dismiss_unverified"
        throw [System.InvalidOperationException]::new($draftCleanupReason)
      }
    }

    $clipboardRestoreSucceeded = Restore-VisualClipboard $originalClipboardEmpty $originalClipboardText $ownedClipboardEmpty $ownedClipboardSequence $ownedClipboardText
    if (-not $clipboardRestoreSucceeded) {
      [uint32]$currentClipboardSequence = [Win32WechatMomentsVisualAction]::GetClipboardSequenceNumber()
      $originalClipboardMatches = $false
      $clipboardRestoreSucceeded = [Win32WechatMomentsVisualAction]::TryClipboardTextMatches(
        $currentClipboardSequence,
        $originalClipboardEmpty,
        $originalClipboardText,
        [ref]$originalClipboardMatches
      ) -and $originalClipboardMatches
    }
    if (-not $clipboardRestoreSucceeded) {
      throw [System.InvalidOperationException]::new("moments_comment_clipboard_restore_failed")
    }
    $clipboardRestored = $true
    $clipboardChanged = $false

    if ($retainExactDraftForSend) {
      $readyState = Get-LockedVisualCommentSendState $lock $menu
      if (-not $readyState.ok -or -not $readyState.send.ok -or
        -not (Test-VisualBoundsInside $readyState.send.bounds $readyState.composer.bounds)) {
        throw [System.InvalidOperationException]::new("moments_comment_send_button_ambiguous")
      }
      $sendBounds = $readyState.send.bounds
      if (-not (Test-VisualBounds $sendBounds 44 18) -or
        [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd) {
        throw [System.InvalidOperationException]::new("moments_comment_editor_changed")
      }
      $draftRetainedForSend = $true
    }
  } catch {
    $failureReason = [string]$_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($failureReason)) { $failureReason = "moments_comment_draft_check_failed" }
  } finally {
    if ($clipboardCaptured -and $clipboardChanged -and -not $clipboardRestored) {
      if ($clipboardStateKnown -and
        (Restore-VisualClipboard $originalClipboardEmpty $originalClipboardText $ownedClipboardEmpty $ownedClipboardSequence $ownedClipboardText)) {
        $clipboardRestored = $true
        $clipboardChanged = $false
      }
    }

    if ($retainExactDraftForSend -and -not $draftRetainedForSend -and $draftMayExist -and $exactDraftProven) {
      # Preserve the real-comment failure cleanup. comment_check already made its
      # single immediate clear attempt and must not retry after a failed re-proof.
      $clear = Invoke-VisualOwnedKeyboardBackspace $lock $expectedComposerBounds $inputTick
      if ($clear.ok) {
        [uint32]$inputTick = [uint32]$clear.inputTick
        $emptyProof = Wait-VisualSelectedCommentDraftEmptyPair $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash $inputTick
        if ($emptyProof.ok) {
          [uint32]$inputTick = [uint32]$emptyProof.inputTick
          $emptyStateCandidate = $true
        } else {
          $draftCleanupReason = $(if ($emptyProof.reason) { [string]$emptyProof.reason } else { "moments_comment_draft_empty_state_unverified" })
          $draftCleanupDiagnostics = $emptyProof.diagnostics
        }
      } else {
        $draftCleanupReason = [string]$clear.reason
        if ($clear.inputTick) { [uint32]$inputTick = [uint32]$clear.inputTick }
      }
    }

    if (-not $draftRetainedForSend -and $draftMayExist -and -not $exactDraftProven) {
      $possibleEmpty = Get-LockedVisualCommentState $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash
      Start-Sleep -Milliseconds 120
      $stablePossibleEmpty = Get-LockedVisualCommentState $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash
      if ($possibleEmpty.ok -and $stablePossibleEmpty.ok -and
        -not $possibleEmpty.send.ok -and [string]$possibleEmpty.send.reason -ceq "moments_comment_send_button_not_found" -and
        -not $stablePossibleEmpty.send.ok -and [string]$stablePossibleEmpty.send.reason -ceq "moments_comment_send_button_not_found" -and
        [Win32WechatMomentsVisualAction]::GetLastInputTick() -eq $inputTick) {
        $draftMayExist = $false
      }
    }

    if (($retainExactDraftForSend -or -not $exactDraftProven) -and
      -not $draftRetainedForSend -and $emptyStateCandidate -and -not $unknownDraftPresent) {
      $composerClosed = Dismiss-VisualProvenEmptyCommentComposer $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash $inputTick
      if ($composerClosed) {
        $draftCleared = $true
        $draftMayExist = $false
      } elseif (-not $draftCleanupReason) {
        $draftCleanupReason = "moments_comment_composer_dismiss_unverified"
      }
    } elseif (($retainExactDraftForSend -or -not $exactDraftProven) -and
      -not $draftRetainedForSend -and -not $draftMayExist -and -not $unknownDraftPresent) {
      $composerClosed = Dismiss-VisualProvenEmptyCommentComposer $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash $inputTick
      if (-not $composerClosed -and -not $draftCleanupReason) {
        $draftCleanupReason = "moments_comment_draft_close_unverified"
      }
    }
  }

  if ($draftRetainedForSend) {
    if ($failureReason -or -not $draftMayExist -or $unknownDraftPresent -or -not $exactDraftProven -or
      -not $clipboardRestored -or $clipboardChanged -or -not (Test-VisualBounds $sendBounds 44 18)) {
      return @{
        ok = $false
        status = "blocked"
        reason = "moments_comment_draft_ready_proof_invalid"
        primaryReason = $(if ($failureReason) { $failureReason } else { "moments_comment_draft_ready_proof_invalid" })
        cleanupReason = $draftCleanupReason
        actionAttempted = $false
      }
    }
    return @{
      ok = $true
      status = "comment_draft_ready_for_send"
      actionAttempted = $false
      commentStatus = "draft_ready_for_send"
      verificationMode = "visual_clipboard_ordinal_roundtrip_and_unique_enabled_button_transition"
      normalizedOcrCountBefore = $normalizedOcrCountBefore
      sendBounds = $sendBounds
      inputTick = $inputTick
      clipboardRestored = $clipboardRestored
      draftRetainedForSend = $true
    }
  }

  $primaryFailureReason = $failureReason
  if ($draftMayExist -or $unknownDraftPresent -or ($exactDraftProven -and -not $draftCleared) -or -not $composerClosed) {
    if (-not $draftCleanupReason) { $draftCleanupReason = "moments_comment_draft_close_unverified" }
    if (-not $failureReason) { $failureReason = $draftCleanupReason }
  } elseif ($clipboardCaptured -and (-not $clipboardRestored -or $clipboardChanged)) {
    $failureReason = "moments_comment_clipboard_restore_failed"
  }
  if ($failureReason) {
    return @{
      ok = $false
      status = "blocked"
      reason = $(if ($primaryFailureReason) { $primaryFailureReason } else { $failureReason })
      primaryReason = $(if ($primaryFailureReason) { $primaryFailureReason } else { $failureReason })
      cleanupReason = $draftCleanupReason
      actionAttempted = $false
      diagnostics = $draftCleanupDiagnostics
    }
  }
  return @{
    ok = $true
    status = "comment_draft_verified"
    actionAttempted = $false
    commentStatus = "draft_verified"
    verificationMode = "visual_clipboard_ordinal_roundtrip_and_unique_enabled_button_transition"
    normalizedOcrCountBefore = $normalizedOcrCountBefore
    sendBounds = $sendBounds
    clipboardRestored = $clipboardRestored
    draftCleared = $draftCleared
    composerClosed = $composerClosed
  }
}

function Clear-And-CloseVisualSelectedCommentDraft(
  $lock,
  $menu,
  $expectedComposerBounds,
  $expectedAvatarBounds,
  [string]$expectedAvatarHash,
  [uint32]$expectedInputTick
) {
  if ($expectedInputTick -eq [uint32]::MaxValue -or
    [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
    [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) { return $false }
  $clear = Invoke-VisualOwnedKeyboardBackspace $lock $expectedComposerBounds $expectedInputTick
  if (-not $clear.ok) { return $false }
  [uint32]$clearedInputTick = [uint32]$clear.inputTick
  $emptyProof = Wait-VisualSelectedCommentDraftEmptyPair $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash $clearedInputTick
  if (-not $emptyProof.ok) { return $false }
  return Dismiss-VisualProvenEmptyCommentComposer $lock $menu $expectedComposerBounds $expectedAvatarBounds $expectedAvatarHash ([uint32]$emptyProof.inputTick)
}

function Dismiss-VisualExactEmptyCommentComposer(
  $lock,
  $menu,
  $expectedComposerBounds,
  [string]$editorRuntimeId,
  $editorBounds,
  [uint32]$expectedInputTick
) {
  try {
    if ($lock -eq $null -or $lock.windowRect -eq $null -or $menu -eq $null -or
      [string]::IsNullOrWhiteSpace($editorRuntimeId) -or
      -not (Test-VisualBounds $expectedComposerBounds 40 40) -or
      $expectedInputTick -eq [uint32]::MaxValue -or
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
      [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick -or
      -not [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd) -or
      [Win32WechatMomentsVisualAction]::IsIconic($lock.hWnd)) { return $false }

    $currentRect = New-Object Win32WechatMomentsVisualAction+RECT
    [uint32]$currentPid = 0
    if (-not [Win32WechatMomentsVisualAction]::GetWindowRect($lock.hWnd, [ref]$currentRect) -or
      [Win32WechatMomentsVisualAction]::GetWindowThreadProcessId($lock.hWnd, [ref]$currentPid) -eq 0 -or
      [int]$currentPid -ne [int]$lock.pid -or
      $currentRect.Left -ne $lock.windowRect.Left -or $currentRect.Top -ne $lock.windowRect.Top -or
      $currentRect.Right -ne $lock.windowRect.Right -or $currentRect.Bottom -ne $lock.windowRect.Bottom) { return $false }

    # Escape is permitted only after both the visual empty state and the exact
    # UIA editor/runtime identity have been re-proved. It can never submit text.
    $emptyFrame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
    if (-not $emptyFrame.ok) {
      Close-MomentsVisualFrame $emptyFrame
      return $false
    }
    try {
      $emptyComposer = Get-VisualCommentComposer $emptyFrame $menu
      $emptySend = Get-VisualSendButton $emptyFrame $emptyComposer
      if (-not $emptyComposer.ok -or
        -not (Test-VisualBoundsNear $emptyComposer.bounds $expectedComposerBounds 4.0) -or
        $emptySend.ok -or [string]$emptySend.reason -cne "moments_comment_send_button_not_found") { return $false }
    } finally {
      Close-MomentsVisualFrame $emptyFrame
    }
    $exactEmptyEditor = Get-VisualCommentEditorAdapter $lock $expectedComposerBounds $editorRuntimeId $editorBounds
    if (-not $exactEmptyEditor.ok -or
      -not [String]::Equals([string]$exactEmptyEditor.value, "", [StringComparison]::Ordinal) -or
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
      [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick) { return $false }
    try {
      $exactEmptyEditor.element.SetFocus()
    } catch {
      return $false
    }
    Start-Sleep -Milliseconds 80
    $focusedEditor = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focusedEditor -eq $null -or [int]$focusedEditor.Current.ProcessId -ne [int]$lock.pid) { return $false }
    $focusedRuntimeId = (@($focusedEditor.GetRuntimeId()) | ForEach-Object { [string][int]$_ }) -join "."
    $focusedEmptyEditor = Get-VisualCommentEditorAdapter $lock $expectedComposerBounds $editorRuntimeId $editorBounds
    if ($focusedRuntimeId -cne $editorRuntimeId -or -not $focusedEmptyEditor.ok -or
      -not [String]::Equals([string]$focusedEmptyEditor.value, "", [StringComparison]::Ordinal) -or
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
      [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $expectedInputTick -or
      -not [Win32WechatMomentsVisualAction]::AtomicKeyboardEscape()) { return $false }

    Start-Sleep -Milliseconds 120
    [uint32]$escapeInputTick = [Win32WechatMomentsVisualAction]::GetLastInputTick()
    if ($escapeInputTick -eq [uint32]::MaxValue) { return $false }
    $missingFrames = 0
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
      if ([Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
        [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $escapeInputTick -or
        -not [Win32WechatMomentsVisualAction]::IsWindowVisible($lock.hWnd) -or
        [Win32WechatMomentsVisualAction]::IsIconic($lock.hWnd)) { return $false }
      $closedFrame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
      if (-not $closedFrame.ok) {
        Close-MomentsVisualFrame $closedFrame
        return $false
      }
      try {
        $remainingComposer = Get-VisualCommentComposer $closedFrame $menu
        if (-not $remainingComposer.ok -and
          [string]$remainingComposer.reason -ceq "moments_comment_composer_not_found") {
          $missingFrames += 1
          if ($missingFrames -ge 2) { return $true }
        } else {
          $missingFrames = 0
          if (-not $remainingComposer.ok -or
            -not (Test-VisualBoundsNear $remainingComposer.bounds $expectedComposerBounds 4.0)) { return $false }
        }
      } finally {
        Close-MomentsVisualFrame $closedFrame
      }
      Start-Sleep -Milliseconds 120
    }

    # Some WeChat builds ignore Escape. The already guarded neutral title-bar
    # click remains a fallback, using the input tick owned by this Escape.
    return Dismiss-VisualCommentComposer $lock $menu $escapeInputTick
  } catch {}
  return $false
}

function Clear-And-CloseVisualCommentDraft($lock, $menu, $expectedComposerBounds, [string]$expectedText, [string]$editorRuntimeId, $editorBounds) {
  try {
    if (-not $expectedText -or [string]::IsNullOrWhiteSpace($editorRuntimeId) -or
      -not (Test-VisualBounds $expectedComposerBounds 40 40)) { return $false }
    $frame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
    if (-not $frame.ok) {
      Close-MomentsVisualFrame $frame
      return $false
    }
    try {
      $composer = Get-VisualCommentComposer $frame $menu
      if (-not $composer.ok -or -not (Test-VisualBoundsNear $composer.bounds $expectedComposerBounds 4.0)) { return $false }
    } finally {
      Close-MomentsVisualFrame $frame
    }

    [uint32]$cleanupInputTick = [Win32WechatMomentsVisualAction]::GetLastInputTick()
    if ($cleanupInputTick -eq [uint32]::MaxValue -or
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
      -not (Clear-VisualCommentTextTargetedIfExact $lock $composer.bounds $expectedText $editorRuntimeId $editorBounds $cleanupInputTick)) { return $false }
    Start-Sleep -Milliseconds 160

    $clearedFrame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
    if (-not $clearedFrame.ok) {
      Close-MomentsVisualFrame $clearedFrame
      return $false
    }
    try {
      $clearedComposer = Get-VisualCommentComposer $clearedFrame $menu
      $clearedSend = Get-VisualSendButton $clearedFrame $clearedComposer
      if (-not $clearedComposer.ok -or -not (Test-VisualBoundsNear $clearedComposer.bounds $composer.bounds 4.0) -or
        $clearedSend.ok -or [string]$clearedSend.reason -cne "moments_comment_send_button_not_found") { return $false }
    } finally {
      Close-MomentsVisualFrame $clearedFrame
    }
    $finalEmptyEditor = Get-VisualCommentEditorAdapter $lock $composer.bounds $editorRuntimeId $editorBounds
    if (-not $finalEmptyEditor.ok -or
      -not [String]::Equals([string]$finalEmptyEditor.value, "", [StringComparison]::Ordinal) -or
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd -or
      [Win32WechatMomentsVisualAction]::GetLastInputTick() -ne $cleanupInputTick) { return $false }
    return Dismiss-VisualExactEmptyCommentComposer $lock $menu $composer.bounds $editorRuntimeId $editorBounds $cleanupInputTick
  } catch {}
  return $false
}

$script:visualWorkerSoftDeadlineMs = (Get-VisualEpochMs) + 45000
$script:visualPostSendSettleMs = 6000
$context = Get-VisualContext
if ($context -eq $null -or [string]$context.observationId -notmatch '^[0-9a-f]{64}$' -or
  [string]$context.postSnapshot.observation_id -cne [string]$context.observationId -or
  [string]$context.postSnapshot.source -cne "visual:windows_media_ocr" -or
  [string]$context.postSnapshot.ocr_provider -cne "windows_media_ocr" -or
  [string]$context.postSnapshot.ocr_language -cne "zh-Hans-CN" -or
  [string]::IsNullOrWhiteSpace([string]$context.postSnapshot.identity_text)) {
  Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_visual_target_lock_invalid"; actionAttempted = $false }
}
if (-not (Test-VisualDeadline ([int64]$context.deadlineMs))) {
  Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_dry_run_expired"; actionAttempted = $false }
}

try {
  $lock = Get-LockedVisualRoot $context
  if (-not $lock.ok) { Write-VisualResult @{ ok = $false; status = "blocked"; reason = $lock.reason; actionAttempted = $false } }
  if ([string]$env:XIAOXI_MOMENTS_VISUAL_ACTION -ceq "comment_readback") {
    $readback = Invoke-VisualCommentReadback $lock $context
    Write-VisualResult $readback
  }
  if ([string]$env:XIAOXI_MOMENTS_VISUAL_ACTION -ceq "comment_occurrence_check") {
    [string]$occurrenceCommentText = [string]$context.commentText
    if (-not $occurrenceCommentText -or $occurrenceCommentText.Length -gt 500) {
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_comment_missing"; actionAttempted = $false }
    }
    Set-VisualActionStage "comment_occurrence_check_started"
    $firstOccurrencePost = Get-CurrentLockedVisualPost $lock $context $true
    if (-not $firstOccurrencePost.ok) {
      if ($firstOccurrencePost.frame) { Close-MomentsVisualFrame $firstOccurrencePost.frame }
      Write-VisualResult @{
        ok = $false
        status = "blocked"
        reason = "moments_comment_occurrence_unresolved"
        actionAttempted = $false
        diagnostics = @{
          firstReason = [string]$firstOccurrencePost.reason
          secondReason = ""
        }
      }
    }
    try {
      $firstOccurrenceCandidate = Find-VisualCommentCandidate $firstOccurrencePost.frame $firstOccurrencePost.post.bounds $firstOccurrencePost.menu $occurrenceCommentText "exact" $firstOccurrencePost.nextPostTop
    } finally {
      Close-MomentsVisualFrame $firstOccurrencePost.frame
    }

    Start-Sleep -Milliseconds 160
    $secondOccurrencePost = Get-CurrentLockedVisualPost $lock $context $true
    if (-not $secondOccurrencePost.ok) {
      if ($secondOccurrencePost.frame) { Close-MomentsVisualFrame $secondOccurrencePost.frame }
      Write-VisualResult @{
        ok = $false
        status = "blocked"
        reason = "moments_comment_occurrence_unresolved"
        actionAttempted = $false
        diagnostics = @{
          firstReason = [string]$firstOccurrenceCandidate.reason
          secondReason = [string]$secondOccurrencePost.reason
        }
      }
    }
    try {
      $secondOccurrenceCandidate = Find-VisualCommentCandidate $secondOccurrencePost.frame $secondOccurrencePost.post.bounds $secondOccurrencePost.menu $occurrenceCommentText "exact" $secondOccurrencePost.nextPostTop
    } finally {
      Close-MomentsVisualFrame $secondOccurrencePost.frame
    }

    $occurrenceResolution = Resolve-VisualCommentOccurrence $firstOccurrenceCandidate $secondOccurrenceCandidate
    if ($occurrenceResolution.ok -and [string]$occurrenceResolution.commentOccurrence -ceq "present") {
      Set-VisualActionStage "comment_occurrence_present"
      Write-VisualResult @{
        ok = $true
        status = "present"
        commentOccurrence = "present"
        actionAttempted = $false
        verificationMode = [string]$occurrenceResolution.verificationMode
        diagnostics = @{
          firstBounds = $firstOccurrenceCandidate.bounds
          secondBounds = $secondOccurrenceCandidate.bounds
          normalizedTextCount = [Math]::Min(
            [int]$firstOccurrenceCandidate.normalizedTextCount,
            [int]$secondOccurrenceCandidate.normalizedTextCount
          )
        }
      }
    }

    if ($occurrenceResolution.ok -and [string]$occurrenceResolution.commentOccurrence -ceq "absent") {
      Set-VisualActionStage "comment_occurrence_absent"
      Write-VisualResult @{
        ok = $true
        status = "absent"
        commentOccurrence = "absent"
        actionAttempted = $false
        verificationMode = [string]$occurrenceResolution.verificationMode
        diagnostics = @{
          firstNormalizedTextCount = [int]$firstOccurrenceCandidate.normalizedTextCount
          secondNormalizedTextCount = [int]$secondOccurrenceCandidate.normalizedTextCount
        }
      }
    }

    Write-VisualResult @{
      ok = $false
      status = "blocked"
      reason = "moments_comment_occurrence_unresolved"
      actionAttempted = $false
      verificationMode = "two_frame_exact_comment_region"
      diagnostics = @{
        firstReason = [string]$firstOccurrenceCandidate.reason
        firstCandidateCount = [int]$firstOccurrenceCandidate.candidateCount
        firstRegionComplete = [bool]$firstOccurrenceCandidate.regionComplete
        secondReason = [string]$secondOccurrenceCandidate.reason
        secondCandidateCount = [int]$secondOccurrenceCandidate.candidateCount
        secondRegionComplete = [bool]$secondOccurrenceCandidate.regionComplete
      }
    }
  }
  [string]$commentText = ""
  [int]$normalizedOcrCountBefore = 0
  if (@("comment", "comment_check") -contains [string]$env:XIAOXI_MOMENTS_VISUAL_ACTION) {
    $commentText = [string]$context.commentText
    if (-not $commentText -or $commentText.Length -gt 500) {
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_comment_missing"; actionAttempted = $false }
    }
    $beforePost = Get-CurrentLockedVisualPost $lock $context $true
    if (-not $beforePost.ok) {
      if ($beforePost.frame) { Close-MomentsVisualFrame $beforePost.frame }
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = $beforePost.reason; actionAttempted = $false; diagnostics = $beforePost.diagnostics }
    }
    try {
      $beforeCandidate = Find-VisualCommentCandidate $beforePost.frame $beforePost.post.bounds $beforePost.menu $commentText "exact"
      $normalizedOcrCountBefore = [int]$beforeCandidate.normalizedTextCount
    } finally {
      Close-MomentsVisualFrame $beforePost.frame
    }
    if ($beforeCandidate.ok -or [int]$beforeCandidate.candidateCount -gt 0 -or $normalizedOcrCountBefore -gt 0) {
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_comment_duplicate"; actionAttempted = $false; normalizedOcrCountBefore = $normalizedOcrCountBefore }
    }
    if ([string]$beforeCandidate.reason -eq "moments_comment_candidate_ocr_unavailable" -or
      [string]$beforeCandidate.reason -eq "moments_comment_candidate_region_invalid") {
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_comment_duplicate_visual_state_unknown"; actionAttempted = $false }
    }
    Set-VisualActionStage "post_checked"
  }
  $opened = Open-LockedVisualMenu $lock $context
  if (-not $opened.ok) {
    Write-VisualResult @{
      ok = $false
      status = "blocked"
      reason = $opened.reason
      primaryReason = $opened.reason
      cleanupReason = $opened.cleanupReason
      actionAttempted = $false
      diagnostics = $opened.diagnostics
    }
  }
  if (@("comment", "comment_check") -contains [string]$env:XIAOXI_MOMENTS_VISUAL_ACTION) {
    Set-VisualActionStage "menu_opened"
  }

  if ([string]$env:XIAOXI_MOMENTS_VISUAL_ACTION -ceq "inspect") {
    $closed = Close-And-VerifyUnchanged $lock $context
    if (-not $closed.ok) { Write-VisualResult @{ ok = $false; status = "blocked"; reason = $closed.reason; actionAttempted = $false } }
    Write-VisualResult @{
      ok = $true
      status = "menu_verified"
      actionAttempted = $false
      menuState = $opened.menuState
      menu = @{ likeLabel = $opened.menuState; commentLabel = "评论" }
    }
  }

  if ([string]$env:XIAOXI_MOMENTS_VISUAL_ACTION -ceq "like") {
    if (@("取消", "取消赞") -contains [string]$opened.menuState) {
      $closed = Close-And-VerifyUnchanged $lock $context
      if (-not $closed.ok) { Write-VisualResult @{ ok = $false; status = "blocked"; reason = $closed.reason; actionAttempted = $false } }
      Write-VisualResult @{ ok = $true; status = "already_liked_verified"; actionAttempted = $false; menuState = $opened.menuState }
    }
    if ([string]$opened.menuState -cne "赞") {
      [void](Close-VisualMenu $lock)
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_like_state_unknown"; actionAttempted = $false }
    }
    $freshMenu = Read-OpenVisualMenu $lock $opened.menu "like"
    if (-not $freshMenu.ok -or [string]$freshMenu.menuState -cne "赞" -or
      -not (Test-VisualBoundsNear $freshMenu.like.bounds $opened.like.bounds 3.0)) {
      [void](Close-VisualMenu $lock)
      Write-VisualResult @{
        ok = $false
        status = "blocked"
        reason = "moments_menu_changed"
        actionAttempted = $false
        diagnostics = $freshMenu.diagnostics
      }
    }
    $likeX = [int][Math]::Round([double]$context.expectedWindow.left + [double]$freshMenu.like.centerX)
    $likeY = [int][Math]::Round([double]$context.expectedWindow.top + [double]$freshMenu.like.centerY)
    if (-not (Invoke-VisualOwnedClick $likeX $likeY $lock ([int64]$context.deadlineMs) $true $true $freshMenu.menuSurface)) {
      $reason = if (Test-VisualDeadline ([int64]$context.deadlineMs)) { "moments_like_click_blocked" } else { "moments_dry_run_expired" }
      [void](Close-VisualMenu $lock)
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = $reason; actionAttempted = $script:visualActionAttempted }
    }
    $script:visualMenuOpen = $false
    Start-Sleep -Milliseconds 380
    $afterLock = Get-LockedVisualRoot $context
    if (-not $afterLock.ok) {
      Write-VisualResult @{ ok = $false; status = "outcome_unknown"; reason = $afterLock.reason; actionAttempted = $true }
    }
    $afterAnchor = Get-PostActionMenuAnchor $afterLock $opened.expectedMenuBounds $opened.expectedAvatarBounds $opened.avatarHash
    if (-not $afterAnchor.ok) {
      Write-VisualResult @{ ok = $false; status = "outcome_unknown"; reason = $afterAnchor.reason; actionAttempted = $true }
    }
    $verifyX = [int][Math]::Round([double]$context.expectedWindow.left + [double]$afterAnchor.menu.centerX)
    $verifyY = [int][Math]::Round([double]$context.expectedWindow.top + [double]$afterAnchor.menu.centerY)
    if (-not (Invoke-VisualOwnedClick $verifyX $verifyY $afterLock ([int64]$context.deadlineMs) $false $false)) {
      Write-VisualResult @{ ok = $false; status = "outcome_unknown"; reason = "moments_like_verification_menu_blocked"; actionAttempted = $true }
    }
    $script:visualMenuOpen = $true
    Start-Sleep -Milliseconds 240
    $afterMenu = Read-OpenVisualMenu $afterLock $afterAnchor.menu "like"
    if (-not $afterMenu.ok -or @("取消", "取消赞") -notcontains [string]$afterMenu.menuState) {
      [void](Close-VisualMenu $afterLock)
      Write-VisualResult @{
        ok = $false
        status = "outcome_unknown"
        reason = "moments_like_verification_failed"
        actionAttempted = $true
        diagnostics = $afterMenu.diagnostics
      }
    }
    if (-not (Close-VisualMenu $afterLock)) {
      Write-VisualResult @{ ok = $false; status = "outcome_unknown"; reason = "moments_menu_close_blocked"; actionAttempted = $true }
    }
    Write-VisualResult @{
      ok = $true
      status = "verified"
      actionAttempted = $true
      menuState = $afterMenu.menuState
      verificationMode = "visual_menu_state_transition_and_static_anchor"
    }
  }

  if (@("comment", "comment_check") -contains [string]$env:XIAOXI_MOMENTS_VISUAL_ACTION) {
    $commentX = [int][Math]::Round([double]$context.expectedWindow.left + [double]$opened.comment.centerX)
    $commentY = [int][Math]::Round([double]$context.expectedWindow.top + [double]$opened.comment.centerY)
    $commentClick = Invoke-VisualOwnedClickDetailed $commentX $commentY $lock ([int64]$context.deadlineMs) $false $true $opened.menuSurface
    if (-not $commentClick.ok) {
      [void](Close-VisualMenu $lock)
      Write-VisualResult @{
        ok = $false
        status = "blocked"
        reason = "moments_comment_open_blocked"
        actionAttempted = $false
        diagnostics = $commentClick.diagnostics
      }
    }
    $script:visualMenuOpen = $false
    Set-VisualActionStage "comment_entry_clicked"
    Start-Sleep -Milliseconds 280
    $composerFrame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
    if (-not $composerFrame.ok) {
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = $composerFrame.reason; actionAttempted = $false }
    }
    try {
      $composer = Get-VisualCommentComposer $composerFrame $opened.menu
      $composerAvatarHash = Get-MomentsPixelHash $composerFrame $opened.expectedAvatarBounds
      $sendBefore = Get-VisualSendButton $composerFrame $composer
    } finally {
      Close-MomentsVisualFrame $composerFrame
    }
    if (-not $composer.ok) {
      Write-VisualResult @{
        ok = $false
        status = "blocked"
        reason = [string]$composer.reason
        actionAttempted = $false
        diagnostics = @{
          sendCandidateCount = [int]$sendBefore.candidateCount
        }
      }
    }
    # Opening the native comment composer can legitimately move the post body
    # through the old avatar sample rectangle and hide the post's three-dot menu.
    # The composer was opened by the already-locked menu click, so its geometry is
    # the stable continuation proof; rebase only the passive pixel guard.
    if ($composerAvatarHash) { $opened.avatarHash = $composerAvatarHash }
    if ($sendBefore.ok) {
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_comment_preexisting_draft"; actionAttempted = $false }
    }
    Set-VisualActionStage "composer_opened"
    $blankCheckpoint = Get-VisualStableBlankCommentCheckpoint $lock $opened.menu $composer.bounds $opened.expectedAvatarBounds $opened.avatarHash
    if (-not $blankCheckpoint.ok) {
      $cleanupReason = ""
      if ($blankCheckpoint.safeToDismiss -eq $true -and
        [uint32]$blankCheckpoint.inputTick -ne [uint32]::MaxValue -and
        -not (Dismiss-VisualProvenEmptyCommentComposer $lock $opened.menu $composer.bounds $opened.expectedAvatarBounds $opened.avatarHash ([uint32]$blankCheckpoint.inputTick))) {
        $cleanupReason = "moments_comment_draft_close_unverified"
      }
      Write-VisualResult @{
        ok = $false
        status = "blocked"
        reason = [string]$blankCheckpoint.reason
        primaryReason = [string]$blankCheckpoint.reason
        cleanupReason = $cleanupReason
        actionAttempted = $false
        diagnostics = $blankCheckpoint.diagnostics
      }
    }
    $composer = $blankCheckpoint.composer
    $sendBefore = $blankCheckpoint.send
    [uint32]$emptyCheckFinishedTick = [uint32]$blankCheckpoint.inputTick
    $visualClipboardSend = $false
    $editorRuntimeId = ""
    $editorBounds = $null
    [uint32]$commentInputTick = [uint32]::MaxValue
    $sendButton = $null
    $draftProbe = Get-VisualCommentDraftTargeted $lock $composer.bounds $emptyCheckFinishedTick
    if (-not $draftProbe.ok) {
      if ([string]$draftProbe.reason -ceq "moments_comment_editor_targeting_unsupported" -and
        @("comment", "comment_check") -contains [string]$env:XIAOXI_MOMENTS_VISUAL_ACTION) {
        $retainExactDraftForSend = [string]$env:XIAOXI_MOMENTS_VISUAL_ACTION -ceq "comment"
        [uint32]$clipboardProbeSequence = 0
        $clipboardProbeEmpty = $false
        $clipboardProbeText = ""
        $clipboardCanRoundTrip = [Win32WechatMomentsVisualAction]::TryCaptureTextClipboard(
          [ref]$clipboardProbeSequence,
          [ref]$clipboardProbeEmpty,
          [ref]$clipboardProbeText
        )
        if ($retainExactDraftForSend -and -not $clipboardCanRoundTrip) {
          $clipboardRoundTrip = Invoke-VisualCommentUnicodeDraftForSend $lock $opened.menu $composer.bounds $commentText ([int64]$context.deadlineMs) $emptyCheckFinishedTick $normalizedOcrCountBefore
        } else {
          $clipboardRoundTrip = Invoke-VisualCommentCheckClipboardRoundTrip $lock $opened.menu $composer.bounds $opened.expectedAvatarBounds $opened.avatarHash $commentText ([int64]$context.deadlineMs) $emptyCheckFinishedTick $normalizedOcrCountBefore $retainExactDraftForSend
        }
        if (-not $clipboardRoundTrip.ok) { Write-VisualResult $clipboardRoundTrip }
        if (-not $retainExactDraftForSend) { Write-VisualResult $clipboardRoundTrip }
        $supportedDraftVerification = @(
          "visual_clipboard_ordinal_roundtrip_and_unique_enabled_button_transition",
          "unicode_sendinput_and_unique_enabled_button_transition"
        ) -contains [string]$clipboardRoundTrip.verificationMode
        if ([string]$clipboardRoundTrip.status -cne "comment_draft_ready_for_send" -or
          $clipboardRoundTrip.actionAttempted -ne $false -or
          [string]$clipboardRoundTrip.commentStatus -cne "draft_ready_for_send" -or
          -not $supportedDraftVerification -or
          $clipboardRoundTrip.clipboardRestored -ne $true -or $clipboardRoundTrip.draftRetainedForSend -ne $true -or
          -not (Test-VisualBounds $clipboardRoundTrip.sendBounds 44 18) -or
          [uint32]$clipboardRoundTrip.inputTick -eq [uint32]::MaxValue) {
          $cleanupReason = ""
          if ([uint32]$clipboardRoundTrip.inputTick -eq [uint32]::MaxValue -or
            -not (Clear-And-CloseVisualSelectedCommentDraft $lock $opened.menu $composer.bounds $opened.expectedAvatarBounds $opened.avatarHash ([uint32]$clipboardRoundTrip.inputTick))) {
            $cleanupReason = "moments_comment_draft_close_unverified"
          }
          Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_ready_proof_invalid"; primaryReason = "moments_comment_draft_ready_proof_invalid"; cleanupReason = $cleanupReason; actionAttempted = $false }
        }
        Set-VisualActionStage "draft_written"
        $preSendLock = Get-LockedVisualRoot $context
        $preSendState = $(if ($preSendLock.ok) {
          Get-LockedVisualCommentSendState $preSendLock $opened.menu
        } else { @{ ok = $false; reason = [string]$preSendLock.reason } })
        $preSendProofOk = $preSendLock.ok -and $preSendState.ok -and $preSendState.send.ok -and
          (Test-VisualBoundsInside $preSendState.send.bounds $preSendState.composer.bounds) -and
          [Win32WechatMomentsVisualAction]::GetForegroundWindow() -eq $preSendLock.hWnd
        if (-not $preSendProofOk) {
          $cleanupReason = ""
          if (-not (Clear-And-CloseVisualSelectedCommentDraft $lock $opened.menu $composer.bounds $opened.expectedAvatarBounds $opened.avatarHash ([uint32]$clipboardRoundTrip.inputTick))) {
            $cleanupReason = "moments_comment_draft_close_unverified"
          }
          Write-VisualResult @{
            ok = $false
            status = "blocked"
            reason = "moments_comment_editor_changed"
            primaryReason = "moments_comment_editor_changed"
            cleanupReason = $cleanupReason
            actionAttempted = $false
            diagnostics = @{
              preSendLockOk = [bool]$preSendLock.ok
              preSendStateOk = [bool]$preSendState.ok
              sendButtonOk = [bool]$preSendState.send.ok
              sendInsideComposer = [bool]($preSendState.ok -and (Test-VisualBoundsInside $preSendState.send.bounds $preSendState.composer.bounds))
              foregroundOk = [bool]($preSendLock.ok -and [Win32WechatMomentsVisualAction]::GetForegroundWindow() -eq $preSendLock.hWnd)
            }
          }
        }
        $lock = $preSendLock
        $visualClipboardSend = $true
        [uint32]$commentInputTick = [uint32]$clipboardRoundTrip.inputTick
        $sendButton = $preSendState.send
        Set-VisualActionStage "send_button_located"
      } else {
        $cleanupReason = ""
        if (-not (Dismiss-VisualProvenEmptyCommentComposer $lock $opened.menu $composer.bounds $opened.expectedAvatarBounds $opened.avatarHash $emptyCheckFinishedTick)) {
          $cleanupReason = "moments_comment_draft_close_unverified"
        }
        Write-VisualResult @{ ok = $false; status = "blocked"; reason = [string]$draftProbe.reason; primaryReason = [string]$draftProbe.reason; cleanupReason = $cleanupReason; actionAttempted = $false }
      }
    }
    if (-not $visualClipboardSend) {
    if (-not $draftProbe.empty) {
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_comment_preexisting_draft"; actionAttempted = $false }
    }
    $editorRuntimeId = [string]$draftProbe.editorRuntimeId
    $editorBounds = $draftProbe.editorBounds
    [uint32]$commentInputTick = [uint32]$draftProbe.inputTick
    $roundTrip = Set-VisualCommentTextTargeted $lock $composer.bounds $commentText $editorRuntimeId $editorBounds $commentInputTick
    if (-not $roundTrip.ok) {
      $cleanupReason = ""
      if ($roundTrip.valueSetAttempted -and
        -not (Clear-And-CloseVisualCommentDraft $lock $opened.menu $composer.bounds $commentText $editorRuntimeId $editorBounds)) {
        $cleanupReason = "moments_comment_draft_close_unverified"
      }
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = $roundTrip.reason; primaryReason = $roundTrip.reason; cleanupReason = $cleanupReason; actionAttempted = $false }
    }
    Set-VisualActionStage "draft_written"
    Start-Sleep -Milliseconds 180
    $readyFrame = Get-MomentsVisualFrame $lock.hWnd $lock.windowRect $lock.pid $false
    if (-not $readyFrame.ok) {
      $cleanupReason = ""
      if (-not (Clear-And-CloseVisualCommentDraft $lock $opened.menu $composer.bounds $commentText $editorRuntimeId $editorBounds)) {
        $cleanupReason = "moments_comment_draft_close_unverified"
      }
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = $readyFrame.reason; primaryReason = $readyFrame.reason; cleanupReason = $cleanupReason; actionAttempted = $false }
    }
    try {
      $readyComposer = Get-VisualCommentComposer $readyFrame $opened.menu
      $sendButton = Get-VisualSendButton $readyFrame $readyComposer
    } finally {
      Close-MomentsVisualFrame $readyFrame
    }
    if (-not $readyComposer.ok -or -not $sendButton.ok -or
      -not (Test-VisualBoundsInside $sendButton.bounds $readyComposer.bounds)) {
      $primaryReason = $(if (-not $readyComposer.ok) { [string]$readyComposer.reason } else { "moments_comment_send_button_ambiguous" })
      $cleanupReason = ""
      if (-not (Clear-And-CloseVisualCommentDraft $lock $opened.menu $composer.bounds $commentText $editorRuntimeId $editorBounds)) {
        $cleanupReason = "moments_comment_draft_close_unverified"
      }
      Write-VisualResult @{
        ok = $false
        status = "blocked"
        reason = $primaryReason
        primaryReason = $primaryReason
        cleanupReason = $cleanupReason
        actionAttempted = $false
        diagnostics = @{
          sendOcrText = [string]$sendButton.ocrText
          sendBounds = $sendButton.bounds
          composerBounds = $readyComposer.bounds
          sendInsideComposer = [bool]($readyComposer.ok -and $sendButton.ok -and (Test-VisualBoundsInside $sendButton.bounds $readyComposer.bounds))
        }
      }
    }
    Set-VisualActionStage "send_button_located"
    if ([string]$env:XIAOXI_MOMENTS_VISUAL_ACTION -ceq "comment_check") {
      if (-not (Clear-And-CloseVisualCommentDraft $lock $opened.menu $composer.bounds $commentText $editorRuntimeId $editorBounds)) {
        Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
      }
      Write-VisualResult @{
        ok = $true
        status = "comment_draft_verified"
        actionAttempted = $false
        commentStatus = "draft_verified"
        verificationMode = "targeted_uia_value_roundtrip_and_unique_enabled_button_transition"
        normalizedOcrCountBefore = $normalizedOcrCountBefore
        sendBounds = $sendButton.bounds
      }
    }
    $finalEditor = Get-VisualCommentEditorAdapter $lock $composer.bounds $editorRuntimeId $editorBounds
    if (-not $finalEditor.ok -or
      -not [String]::Equals([string]$finalEditor.value, $commentText, [StringComparison]::Ordinal) -or
      [Win32WechatMomentsVisualAction]::GetForegroundWindow() -ne $lock.hWnd) {
      $cleanupReason = ""
      if (-not (Clear-And-CloseVisualCommentDraft $lock $opened.menu $composer.bounds $commentText $editorRuntimeId $editorBounds)) {
        $cleanupReason = "moments_comment_draft_close_unverified"
      }
      Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_comment_editor_changed"; primaryReason = "moments_comment_editor_changed"; cleanupReason = $cleanupReason; actionAttempted = $false }
    }
    }
    $sendX = [int][Math]::Round([double]$context.expectedWindow.left + [double]$sendButton.centerX)
    $sendY = [int][Math]::Round([double]$context.expectedWindow.top + [double]$sendButton.centerY)
    if (-not (Invoke-VisualOwnedClick $sendX $sendY $lock ([int64]$context.deadlineMs) $true $true $null ([uint32]::MaxValue) { Write-VisualCommentSendMarker $context })) {
      $cleanupReason = ""
      if ($visualClipboardSend) {
        if (-not $script:visualActionAttempted -and
          -not (Clear-And-CloseVisualSelectedCommentDraft $lock $opened.menu $composer.bounds $opened.expectedAvatarBounds $opened.avatarHash $commentInputTick)) {
          $cleanupReason = "moments_comment_draft_close_unverified"
        }
      } elseif (-not $script:visualActionAttempted -and
        -not (Clear-And-CloseVisualCommentDraft $lock $opened.menu $composer.bounds $commentText $editorRuntimeId $editorBounds)) {
        $cleanupReason = "moments_comment_draft_close_unverified"
      }
      $sendFailureReason = $(if ($script:visualActionAttempted) {
        "moments_comment_outcome_unknown"
      } elseif (-not [string]::IsNullOrWhiteSpace($script:visualIrreversibleMarkerReason)) {
        $script:visualIrreversibleMarkerReason
      } else {
        "moments_comment_send_blocked"
      })
      Write-VisualResult @{
        ok = $false
        status = $(if ($script:visualActionAttempted) { "outcome_unknown" } else { "blocked" })
        reason = $sendFailureReason
        primaryReason = $sendFailureReason
        cleanupReason = $cleanupReason
        actionAttempted = $script:visualActionAttempted
      }
    }
    Set-VisualActionStage "send_clicked"
    $postClickQuiet = Wait-VisualPostClickInputQuiet $context $lock
    if (-not $postClickQuiet.ok) {
      Write-VisualResult @{
        ok = $false
        status = "outcome_unknown"
        reason = [string]$postClickQuiet.reason
        actionAttempted = $true
        normalizedOcrCountBefore = $normalizedOcrCountBefore
      }
    }
    [int64]$nowAfterClickMs = Get-VisualEpochMs
    [int64]$settleDeadlineMs = [Math]::Min(
      $nowAfterClickMs + $script:visualPostSendSettleMs,
      [Math]::Min([int64]$script:visualWorkerSoftDeadlineMs, ([int64]$context.deadlineMs - 500))
    )
    if ($settleDeadlineMs -le $nowAfterClickMs) {
      Write-VisualResult @{
        ok = $false
        status = "outcome_unknown"
        reason = "moments_comment_readback_seed_timeout"
        actionAttempted = $true
        normalizedOcrCountBefore = $normalizedOcrCountBefore
      }
    }
    $seedResult = Wait-VisualCommentReadbackSeed $context $opened $settleDeadlineMs
    if (-not $seedResult.ok) {
      Write-VisualResult @{
        ok = $false
        status = "outcome_unknown"
        reason = $(if ([string]$seedResult.reason -ceq "moments_external_input_detected") { "moments_external_input_detected" } else { "moments_comment_readback_seed_unavailable" })
        actionAttempted = $true
        normalizedOcrCountBefore = $normalizedOcrCountBefore
        diagnostics = $seedResult.diagnostics
      }
    }
    if ($seedResult.stateTransitionVerified -eq $true) {
      Set-VisualActionStage "send_verified"
      Write-VisualResult @{
        ok = $true
        status = "visible_verified"
        actionAttempted = $true
        commentStatus = "verified"
        commentVerified = $true
        verificationMode = [string]$seedResult.verificationMode
        verificationLevel = "state_transition"
        normalizedOcrCountBefore = $normalizedOcrCountBefore
        normalizedOcrCountAfter = 0
        diagnostics = $seedResult.diagnostics
      }
    }
  }

  [void](Close-VisualMenu $lock)
  Write-VisualResult @{ ok = $false; status = "blocked"; reason = "moments_visual_action_invalid"; actionAttempted = $false }
} catch {
  [void](Close-VisualMenu $lock)
  Write-VisualResult @{
    ok = $false
    status = $(if ($script:visualActionAttempted) { "outcome_unknown" } else { "blocked" })
    reason = $(if ($script:visualActionAttempted) { "moments_visual_action_failed_after_click" } else { "moments_visual_action_failed" })
    actionAttempted = $script:visualActionAttempted
  }
}
`;

function blocked(reason) {
  return {
    ok: false,
    status: "blocked",
    reason,
    actionAttempted: false
  };
}

function runVisualAction(action, context = {}) {
  if (!validVisualContext(context)) return blocked("moments_visual_target_lock_invalid");
  if (Date.now() > Number(context.deadlineMs)) return blocked("moments_dry_run_expired");
  if (
    action === "comment"
    && !validCommentSendMarkerPath(context.sendMarkerPath, context.postFingerprint)
  ) return blocked("moments_comment_send_marker_invalid");
  const payload = {
    observationId: String(context.observationId),
    deadlineMs: Number(context.deadlineMs),
    expectedWindow: context.expectedWindow,
    postSnapshot: context.postSnapshot,
    attemptKey: String(context.attemptKey ?? ""),
    postFingerprint: String(context.postFingerprint ?? ""),
    requestedAction: String(context.action ?? action),
    commentText: exactCommentText(context.commentText),
    commentTextSha256: String(context.commentTextSha256 ?? ""),
    sendMarkerPath: String(context.sendMarkerPath ?? ""),
    readbackSeed: context.readbackSeed ?? null
  };
  const timeoutCapMs = VISUAL_ACTION_TIMEOUT_CAP_MS[action] ?? 20_000;
  const remainingMs = Number(context.deadlineMs) - Date.now();
  const timeoutMs = Math.min(timeoutCapMs, Math.max(1_000, remainingMs + 2_500));
  const env = {
    XIAOXI_MOMENTS_VISUAL_ACTION: action,
    XIAOXI_MOMENTS_VISUAL_CONTEXT_BASE64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
  };
  if (
    action === "comment"
    || action === "comment_readback"
    || action === "comment_occurrence_check"
  ) {
    return runPowerShellAsync(MOMENTS_VISUAL_ACTION_POWERSHELL, env, {
      ensure: false,
      sta: true,
      timeout: false,
      diagnostics: true
    });
  }
  return runPowerShell(MOMENTS_VISUAL_ACTION_POWERSHELL, env, {
    ensure: false,
    sta: true,
    timeout: timeoutMs,
    diagnostics: true
  });
}

function inspectMenu(context = {}) {
  const result = runVisualAction("inspect", context);
  if (!result?.ok) return result;
  return {
    ...result,
    observationId: String(context.observationId ?? ""),
    menuState: String(result.menuState ?? result.menu?.likeLabel ?? "")
  };
}

function like(context = {}) {
  const result = runVisualAction("like", context);
  if (!result?.ok) return result;
  return {
    ...result,
    observationId: String(context.observationId ?? ""),
    menuState: String(result.menuState ?? "")
  };
}

function comment(context = {}) {
  const commentText = exactCommentText(context.commentText);
  if (!commentText || commentText.length > 500) return blocked("moments_comment_missing");
  const normalizeResult = (result) => {
    if (!result?.ok) return result;
    return {
      ...result,
      observationId: String(context.observationId ?? ""),
      commentText
    };
  };
  const result = runVisualAction("comment", context);
  return typeof result?.then === "function" ? result.then(normalizeResult) : normalizeResult(result);
}

function commentReadback(context = {}) {
  const commentText = exactCommentText(context.commentText);
  if (!commentText || commentText.length > 500) return blocked("moments_comment_missing");
  if (!validCommentReadbackSeed(context.readbackSeed, context)) {
    return blocked("moments_comment_readback_seed_invalid");
  }
  const normalizeResult = (result) => {
    if (!result?.ok) return result;
    return {
      ok: true,
      status: String(result.status ?? ""),
      actionAttempted: false,
      commentVerified: result.commentStatus === "verified",
      observationId: String(context.observationId ?? ""),
      commentText,
      verificationMode: String(result.verificationMode ?? ""),
      proof: result.proof
    };
  };
  const result = runVisualAction("comment_readback", context);
  return typeof result?.then === "function" ? result.then(normalizeResult) : normalizeResult(result);
}

function commentOccurrenceCheck(context = {}) {
  const commentText = exactCommentText(context.commentText);
  if (!commentText || commentText.length > 500) return blocked("moments_comment_missing");
  const normalizeResult = (result) => ({
    ...result,
    observationId: String(context.observationId ?? ""),
    commentText,
    actionAttempted: false,
    realActionAttempted: false,
    commentOccurrence: String(result?.commentOccurrence ?? "")
  });
  const result = runVisualAction("comment_occurrence_check", context);
  return typeof result?.then === "function" ? result.then(normalizeResult) : normalizeResult(result);
}

function inspectCommentDraft(context = {}) {
  const commentText = exactCommentText(context.commentText);
  if (!commentText || commentText.length > 500) return blocked("moments_comment_missing");
  const result = runVisualAction("comment_check", context);
  return {
    ...result,
    observationId: String(context.observationId ?? ""),
    commentText
  };
}

module.exports = {
  MOMENTS_VISUAL_POST_RELOCK_TOLERANCE_PX,
  MOMENTS_VISUAL_ACTION_POWERSHELL,
  comment,
  commentOccurrenceCheck,
  commentReadback,
  inspectCommentDraft,
  inspectMenu,
  like
};
