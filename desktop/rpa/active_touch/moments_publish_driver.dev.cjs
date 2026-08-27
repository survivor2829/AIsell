const fs = require("node:fs");
const path = require("node:path");
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const {
  MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL
} = require("./moments_surface_evidence.dev.cjs");

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ATTEMPT_ID_PATTERN = /^[a-f0-9-]{16,64}$/u;
const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png"]);
const VIDEO_EXTENSIONS = new Set([".mov", ".mp4"]);
const PUBLISH_MARKER_DIRECTORY = "publish_markers";
const MOMENTS_PUBLISH_FILE_DIALOG_TITLE_PREFIXES = Object.freeze(["打开", "选择文件", "Open"]);
const MOMENTS_PUBLISH_CAMERA_PROFILE = Object.freeze({
  name: "wechat_moments_render_pane_camera_glyph",
  standaloneLogicalRight: 24,
  standaloneLogicalTop: 24,
  integratedLogicalRight: 32,
  integratedLogicalTop: 56,
  logicalRadiusX: 17,
  logicalRadiusY: 13,
  logicalHeaderHeight: 80
});
const PUBLISH_VISIBLE_ANCHOR_CHARACTERS = 24;
const PUBLISH_POSTVERIFY_TIMEOUT_MS = 12_000;
const PUBLISH_POSTVERIFY_INTERVAL_MS = 500;

function verificationToken(content) {
  const normalized = String(content ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return [...normalized].slice(0, PUBLISH_VISIBLE_ANCHOR_CHARACTERS).join("");
}

function verificationContent(content) {
  return String(content ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function validMarkerPath(markerPath, fingerprint, attemptId) {
  const value = String(markerPath ?? "");
  const expectedName = `${fingerprint}.${attemptId}.json`;
  return path.isAbsolute(value)
    && SHA256_PATTERN.test(String(fingerprint ?? ""))
    && ATTEMPT_ID_PATTERN.test(String(attemptId ?? ""))
    && path.basename(value) === expectedName
    && path.basename(path.dirname(value)) === PUBLISH_MARKER_DIRECTORY;
}

function blocked(reason) {
  return {
    ok: false,
    status: "blocked",
    reason,
    actionAttempted: false,
    verified: false
  };
}

function mediaKindForExtension(extension) {
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return "";
}

function validateMediaContract(context, mediaPaths) {
  const manifest = Array.isArray(context.mediaManifest) ? context.mediaManifest : [];
  const mediaCount = Number(context.mediaCount);
  const mediaKind = String(context.mediaKind ?? "");
  if (!Number.isInteger(mediaCount) || mediaCount !== manifest.length || mediaCount !== mediaPaths.length
    || mediaCount < 1 || mediaCount > 9 || !["image", "video"].includes(mediaKind)) {
    return { ok: false };
  }
  const normalized = [];
  const seenPaths = new Set();
  for (let index = 0; index < manifest.length; index += 1) {
    const item = manifest[index] ?? {};
    const file = String(item.path ?? "");
    const sha256 = String(item.sha256 ?? "").toLowerCase();
    const ext = String(item.ext ?? "").toLowerCase();
    const size = Number(item.size);
    const kind = mediaKindForExtension(ext);
    const expectedName = `${String(index + 1).padStart(2, "0")}-${sha256.slice(0, 12)}${ext}`;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return { ok: false };
    }
    const pathKey = process.platform === "win32" ? file.toLowerCase() : file;
    if (!path.isAbsolute(file) || file !== mediaPaths[index] || !SHA256_PATTERN.test(sha256)
      || !Number.isSafeInteger(size) || size < 1 || !kind || kind !== mediaKind
      || path.extname(file).toLowerCase() !== ext || path.basename(file).toLowerCase() !== expectedName
      || !stat.isFile() || stat.size !== size || seenPaths.has(pathKey)) {
      return { ok: false };
    }
    seenPaths.add(pathKey);
    normalized.push({ path: file, sha256, size, ext });
  }
  if ((mediaKind === "video" && mediaCount !== 1) || (mediaKind === "image" && mediaCount > 9)) {
    return { ok: false };
  }
  return { ok: true, manifest: normalized, mediaCount, mediaKind };
}

const MOMENTS_PUBLISH_POWERSHELL = String.raw`
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatMomentsPublish {
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
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog, int controlId);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

  public static uint GetLastInputTick() {
    LASTINPUTINFO info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)), dwTime = 0 };
    return GetLastInputInfo(ref info) ? info.dwTime : UInt32.MaxValue;
  }

  public static bool AtomicMouseClick(int screenX, int screenY) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    if (width <= 1 || height <= 1 || screenX < left || screenY < top || screenX >= left + width || screenY >= top + height) return false;
    int dx = (int)Math.Round((screenX - left) * 65535.0 / (width - 1));
    int dy = (int)Math.Round((screenY - top) * 65535.0 / (height - 1));
    uint common = 0x0001u | 0x4000u | 0x8000u;
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 0;
    inputs[0].mouseInput = new MOUSEINPUT { dx = dx, dy = dy, mouseData = 0, dwFlags = common | 0x0002u, time = 0, extraInfo = UIntPtr.Zero };
    inputs[1].type = 0;
    inputs[1].mouseInput = new MOUSEINPUT { dx = dx, dy = dy, mouseData = 0, dwFlags = common | 0x0004u, time = 0, extraInfo = UIntPtr.Zero };
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 2;
  }

  public static bool AtomicMouseWheel(int delta) {
    INPUT input = new INPUT();
    input.type = 0;
    input.mouseInput = new MOUSEINPUT { dx = 0, dy = 0, mouseData = unchecked((uint)delta), dwFlags = 0x0800u, time = 0, extraInfo = UIntPtr.Zero };
    return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static bool AtomicKeyChord(ushort modifier, ushort key) {
    INPUT[] inputs = new INPUT[4];
    inputs[0].type = 1;
    inputs[0].keyboardInput = new KEYBDINPUT { virtualKey = modifier, scanCode = 0, flags = 0, time = 0, extraInfo = UIntPtr.Zero };
    inputs[1].type = 1;
    inputs[1].keyboardInput = new KEYBDINPUT { virtualKey = key, scanCode = 0, flags = 0, time = 0, extraInfo = UIntPtr.Zero };
    inputs[2].type = 1;
    inputs[2].keyboardInput = new KEYBDINPUT { virtualKey = key, scanCode = 0, flags = 0x0002u, time = 0, extraInfo = UIntPtr.Zero };
    inputs[3].type = 1;
    inputs[3].keyboardInput = new KEYBDINPUT { virtualKey = modifier, scanCode = 0, flags = 0x0002u, time = 0, extraInfo = UIntPtr.Zero };
    return SendInput(4, inputs, Marshal.SizeOf(typeof(INPUT))) == 4;
  }

  public static bool AtomicVirtualKey(ushort key) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 1;
    inputs[0].keyboardInput = new KEYBDINPUT { virtualKey = key, scanCode = 0, flags = 0, time = 0, extraInfo = UIntPtr.Zero };
    inputs[1].type = 1;
    inputs[1].keyboardInput = new KEYBDINPUT { virtualKey = key, scanCode = 0, flags = 0x0002u, time = 0, extraInfo = UIntPtr.Zero };
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 2;
  }

  public static bool AtomicUnicodeText(string text) {
    if (IntPtr.Size != 8 || String.IsNullOrEmpty(text) || text.Length > 2000) return false;
    INPUT[] inputs = new INPUT[text.Length * 2];
    for (int index = 0; index < text.Length; index++) {
      ushort codeUnit = text[index];
      inputs[index * 2].type = 1;
      inputs[index * 2].keyboardInput = new KEYBDINPUT { virtualKey = 0, scanCode = codeUnit, flags = 0x0004u, time = 0, extraInfo = UIntPtr.Zero };
      inputs[index * 2 + 1].type = 1;
      inputs[index * 2 + 1].keyboardInput = new KEYBDINPUT { virtualKey = 0, scanCode = codeUnit, flags = 0x0004u | 0x0002u, time = 0, extraInfo = UIntPtr.Zero };
    }
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == inputs.Length;
  }
}
"@

${MOMENTS_VISUAL_READONLY_POWERSHELL}
${MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL}

$script:publishActionAttempted = $false
$script:publishStage = "initialized"

function Write-PublishResult($payload) {
  $payload.stage = $script:publishStage
  $payload.actionAttempted = [bool]$script:publishActionAttempted
  $payload | ConvertTo-Json -Compress -Depth 8
  exit
}

function Normalize-PublishText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  $normalized = $value.Normalize([Text.NormalizationForm]::FormKC)
  return [Text.RegularExpressions.Regex]::Replace($normalized, "[^\p{L}\p{N}]", "")
}

function Normalize-PublishExactContent([string]$value) {
  if ($null -eq $value) { return "" }
  $crlf = ([string][char]13) + ([string][char]10)
  return $value.Replace($crlf, [string][char]10).Replace([string][char]13, [string][char]10).Trim()
}

function Get-PublishFileSha256([string]$filePath) {
  $stream = $null
  $sha = $null
  try {
    $stream = [IO.File]::Open($filePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    return ([BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-", "").ToLowerInvariant())
  } catch {
    return ""
  } finally {
    if ($sha -ne $null) { $sha.Dispose() }
    if ($stream -ne $null) { $stream.Dispose() }
  }
}

function Get-PublishMediaKind([string]$extension) {
  $value = ([string]$extension).ToLowerInvariant()
  if (@(".jpeg", ".jpg", ".png") -contains $value) { return "image" }
  if (@(".mov", ".mp4") -contains $value) { return "video" }
  return ""
}

function Test-PublishMediaManifest($context) {
  $paths = @($context.mediaPaths | ForEach-Object { [string]$_ })
  $manifest = @($context.mediaManifest)
  [int]$declaredCount = 0
  if (-not [int]::TryParse([string]$context.mediaCount, [ref]$declaredCount) -or
    $declaredCount -lt 1 -or $declaredCount -gt 9 -or
    $paths.Count -ne $declaredCount -or $manifest.Count -ne $declaredCount) {
    return @{ ok = $false; reason = "moments_publish_media_manifest_invalid" }
  }
  $declaredKind = ([string]$context.mediaKind).ToLowerInvariant()
  if (@("image", "video") -notcontains $declaredKind -or ($declaredKind -ceq "video" -and $declaredCount -ne 1)) {
    return @{ ok = $false; reason = "moments_publish_media_manifest_invalid" }
  }
  $seenPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $seenNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $items = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $declaredCount; $index++) {
    $item = $manifest[$index]
    $filePath = [string]$item.path
    $expectedHash = ([string]$item.sha256).ToLowerInvariant()
    $expectedExtension = ([string]$item.ext).ToLowerInvariant()
    [int64]$expectedSize = 0
    if (-not [IO.Path]::IsPathRooted($filePath) -or $filePath -cne $paths[$index] -or
      $expectedHash -notmatch "^[a-f0-9]{64}$" -or
      -not [int64]::TryParse([string]$item.size, [ref]$expectedSize) -or $expectedSize -lt 1 -or
      (Get-PublishMediaKind $expectedExtension) -cne $declaredKind) {
      return @{ ok = $false; reason = "moments_publish_media_manifest_invalid" }
    }
    $expectedName = ([string]($index + 1)).PadLeft(2, "0") + "-" + $expectedHash.Substring(0, 12) + $expectedExtension
    try { $file = [IO.FileInfo]::new($filePath) } catch { return @{ ok = $false; reason = "moments_publish_media_changed" } }
    if (-not $file.Exists -or [int64]$file.Length -ne $expectedSize -or
      ([string]$file.Extension).ToLowerInvariant() -cne $expectedExtension -or
      ([string]$file.Name).ToLowerInvariant() -cne $expectedName -or
      -not $seenPaths.Add($file.FullName) -or -not $seenNames.Add($file.Name)) {
      return @{ ok = $false; reason = "moments_publish_media_changed" }
    }
    $actualHash = Get-PublishFileSha256 $file.FullName
    if (-not $actualHash -or $actualHash -cne $expectedHash) {
      return @{ ok = $false; reason = "moments_publish_media_changed" }
    }
    [void]$items.Add(@{
      path = $file.FullName
      name = $file.Name
      sha256 = $actualHash
      size = [int64]$file.Length
      ext = $expectedExtension
      kind = $declaredKind
    })
  }
  return @{
    ok = $true
    items = @($items.ToArray())
    paths = @($items.ToArray() | ForEach-Object { [string]$_.path })
    names = @($items.ToArray() | ForEach-Object { [string]$_.name })
    count = $declaredCount
    kind = $declaredKind
  }
}

function Get-PublishWindowLock($context) {
  [int64]$handleValue = 0
  [int]$expectedPid = 0
  [int]$expectedX = 0
  [int]$expectedY = 0
  [int]$expectedWidth = 0
  [int]$expectedHeight = 0
  [uint32]$expectedDpi = 0
  if (-not [int64]::TryParse([string]$context.expectedHWnd, [ref]$handleValue) -or $handleValue -eq 0 -or
    -not [int]::TryParse([string]$context.expectedPid, [ref]$expectedPid) -or $expectedPid -le 0 -or
    -not [int]::TryParse([string]$context.expectedX, [ref]$expectedX) -or
    -not [int]::TryParse([string]$context.expectedY, [ref]$expectedY) -or
    -not [int]::TryParse([string]$context.expectedWidth, [ref]$expectedWidth) -or $expectedWidth -lt 300 -or
    -not [int]::TryParse([string]$context.expectedHeight, [ref]$expectedHeight) -or $expectedHeight -lt 300 -or
    -not [uint32]::TryParse([string]$context.expectedDpi, [ref]$expectedDpi) -or $expectedDpi -lt 72 -or $expectedDpi -gt 480) {
    return @{ ok = $false; reason = "moments_publish_window_identity_invalid" }
  }
  $hWnd = [IntPtr]$handleValue
  if (-not [Win32WechatMomentsPublish]::IsWindow($hWnd) -or
    -not [Win32WechatMomentsPublish]::IsWindowVisible($hWnd) -or
    [Win32WechatMomentsPublish]::IsIconic($hWnd)) {
    return @{ ok = $false; reason = "moments_window_not_found" }
  }
  [uint32]$actualPid = 0
  if ([Win32WechatMomentsPublish]::GetWindowThreadProcessId($hWnd, [ref]$actualPid) -eq 0 -or [int]$actualPid -ne $expectedPid) {
    return @{ ok = $false; reason = "moments_publish_window_identity_mismatch" }
  }
  $process = Get-Process -Id $actualPid -ErrorAction SilentlyContinue
  if (-not $process -or @("Weixin", "WeChat") -notcontains $process.ProcessName) {
    return @{ ok = $false; reason = "moments_publish_process_identity_mismatch" }
  }
  $titleText = New-Object System.Text.StringBuilder 128
  [void][Win32WechatMomentsPublish]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
  $classText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatMomentsPublish]::GetClassName($hWnd, $classText, $classText.Capacity)
  $title = $titleText.ToString().Trim()
  $className = $classText.ToString().Trim()
  $expectedTitle = [string]$context.expectedTitle
  $expectedClassName = [string]$context.expectedClassName
  $surfaceMode = [string]$context.expectedSurfaceMode
  if ($title -cne $expectedTitle -or $className -cne $expectedClassName -or
    @("standalone", "integrated") -notcontains $surfaceMode) {
    return @{ ok = $false; reason = "moments_publish_window_identity_mismatch" }
  }
  $rect = New-Object Win32WechatMomentsPublish+RECT
  if (-not [Win32WechatMomentsPublish]::GetWindowRect($hWnd, [ref]$rect) -or
    ($rect.Right - $rect.Left) -lt 300 -or ($rect.Bottom - $rect.Top) -lt 300) {
    return @{ ok = $false; reason = "moments_publish_window_geometry_invalid" }
  }
  if ([Math]::Abs($rect.Left - $expectedX) -gt 3 -or [Math]::Abs($rect.Top - $expectedY) -gt 3 -or
      [Math]::Abs(($rect.Right - $rect.Left) - $expectedWidth) -gt 3 -or
      [Math]::Abs(($rect.Bottom - $rect.Top) - $expectedHeight) -gt 3) {
    return @{ ok = $false; reason = "moments_publish_window_geometry_changed" }
  }
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $hWnd) {
    return @{ ok = $false; reason = "moments_window_not_foreground" }
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)
  if ($root -eq $null) { return @{ ok = $false; reason = "moments_publish_uia_root_missing" } }
  $renderPane = Get-MomentsRenderPaneEvidence $root $expectedPid
  if (-not $renderPane.ok) { return @{ ok = $false; reason = [string]$renderPane.reason } }
  [uint32]$dpi = 96
  try {
    $value = [Win32WechatMomentsPublish]::GetDpiForWindow($hWnd)
    if ($value -ge 72 -and $value -le 480) { $dpi = $value }
  } catch {}
  if ($dpi -ne $expectedDpi) { return @{ ok = $false; reason = "moments_publish_window_dpi_changed" } }
  return @{
    ok = $true
    hWnd = $hWnd
    pid = $expectedPid
    rect = $rect
    root = $root
    renderPane = $renderPane.pane
    dpi = $dpi
    scale = [double]$dpi / 96.0
    className = $className
    title = $title
    surfaceMode = $surfaceMode
  }
}

function Get-PublishComposerWindowLock($context, $mainLock) {
  if (-not $mainLock.ok -or $mainLock.hWnd -eq [IntPtr]::Zero) {
    return @{ ok = $false; reason = "moments_publish_composer_owner_missing" }
  }
  [int]$expectedPid = [int]$mainLock.pid
  $expectedOwner = [IntPtr]$mainLock.hWnd
  $expectedClassName = [string]$mainLock.className
  $expectedTitle = ([string][char]0x670b) + ([string][char]0x53cb) + ([string][char]0x5708)
  $composerCandidates = New-Object System.Collections.Generic.List[object]
  $callback = [Win32WechatMomentsPublish+EnumWindowsProc]{
    param([IntPtr]$candidateHWnd, [IntPtr]$unused)
    if (-not [Win32WechatMomentsPublish]::IsWindowVisible($candidateHWnd) -or
      [Win32WechatMomentsPublish]::IsIconic($candidateHWnd) -or
      [Win32WechatMomentsPublish]::GetWindow($candidateHWnd, 4) -ne $expectedOwner) { return $true }
    [uint32]$candidatePid = 0
    if ([Win32WechatMomentsPublish]::GetWindowThreadProcessId($candidateHWnd, [ref]$candidatePid) -eq 0 -or
      [int]$candidatePid -ne $expectedPid) { return $true }
    $titleText = New-Object System.Text.StringBuilder 128
    [void][Win32WechatMomentsPublish]::GetWindowText($candidateHWnd, $titleText, $titleText.Capacity)
    $classText = New-Object System.Text.StringBuilder 256
    [void][Win32WechatMomentsPublish]::GetClassName($candidateHWnd, $classText, $classText.Capacity)
    if ($titleText.ToString().Trim() -cne $expectedTitle -or
      $classText.ToString().Trim() -cne $expectedClassName) { return $true }
    $candidateRect = New-Object Win32WechatMomentsPublish+RECT
    if (-not [Win32WechatMomentsPublish]::GetWindowRect($candidateHWnd, [ref]$candidateRect) -or
      ($candidateRect.Right - $candidateRect.Left) -lt 360 -or
      ($candidateRect.Bottom - $candidateRect.Top) -lt 420) { return $true }
    [void]$composerCandidates.Add(@{ hWnd = $candidateHWnd; rect = $candidateRect })
    return $true
  }
  [void][Win32WechatMomentsPublish]::EnumWindows($callback, [IntPtr]::Zero)
  if ($composerCandidates.Count -ne 1) {
    return @{ ok = $false; reason = $(if ($composerCandidates.Count -gt 1) { "moments_publish_composer_ambiguous" } else { "moments_publish_composer_not_found" }) }
  }
  $candidate = $composerCandidates[0]
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne [IntPtr]$candidate.hWnd) {
    return @{ ok = $false; reason = "moments_publish_composer_not_foreground" }
  }
  [uint32]$dpi = 96
  try {
    $value = [Win32WechatMomentsPublish]::GetDpiForWindow([IntPtr]$candidate.hWnd)
    if ($value -ge 72 -and $value -le 480) { $dpi = $value }
  } catch {}
  return @{
    ok = $true
    hWnd = [IntPtr]$candidate.hWnd
    ownerHWnd = $expectedOwner
    pid = $expectedPid
    rect = $candidate.rect
    dpi = $dpi
    scale = [double]$dpi / 96.0
    className = $expectedClassName
    title = $expectedTitle
    surfaceMode = "composer"
  }
}

function Wait-PublishComposerWindowLock($context, $mainLock) {
  $last = @{ ok = $false; reason = "moments_publish_composer_not_found" }
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $last = Get-PublishComposerWindowLock $context $mainLock
    if ($last.ok) {
      return $last
    }
    if (@(
      "moments_publish_composer_not_found",
      "moments_publish_composer_not_foreground"
    ) -notcontains [string]$last.reason) {
      return $last
    }
    if ($attempt -lt 29) {
      Start-Sleep -Milliseconds 200
    }
  }
  return $last
}

function Test-PublishOwnedPoint([int]$screenX, [int]$screenY, $lock) {
  if ($screenX -lt $lock.rect.Left -or $screenX -ge $lock.rect.Right -or
    $screenY -lt $lock.rect.Top -or $screenY -ge $lock.rect.Bottom) { return $false }
  $point = New-Object Win32WechatMomentsPublish+POINT
  $point.X = $screenX
  $point.Y = $screenY
  $hit = [Win32WechatMomentsPublish]::WindowFromPoint($point)
  if ($hit -eq [IntPtr]::Zero -or [Win32WechatMomentsPublish]::GetAncestor($hit, 2) -ne $lock.hWnd) { return $false }
  [uint32]$hitPid = 0
  return [Win32WechatMomentsPublish]::GetWindowThreadProcessId($hit, [ref]$hitPid) -ne 0 -and [int]$hitPid -eq [int]$lock.pid
}

function Invoke-PublishOwnedClick(
  [int]$screenX,
  [int]$screenY,
  $lock,
  [bool]$irreversible,
  [uint32]$expectedInputTick = [uint32]::MaxValue,
  [scriptblock]$beforeIrreversibleClick = $null,
  [scriptblock]$afterMarkerValidation = $null
) {
  if ($expectedInputTick -ne [uint32]::MaxValue -and [Win32WechatMomentsPublish]::GetLastInputTick() -ne $expectedInputTick) {
    return @{ ok = $false; reason = "moments_publish_external_input_detected" }
  }
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd -or
    -not (Test-PublishOwnedPoint $screenX $screenY $lock)) {
    return @{ ok = $false; reason = "moments_publish_click_target_changed" }
  }
  if (-not [Win32WechatMomentsPublish]::SetCursorPos($screenX, $screenY)) {
    return @{ ok = $false; reason = "moments_publish_cursor_move_failed" }
  }
  Start-Sleep -Milliseconds 25
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd -or
    -not (Test-PublishOwnedPoint $screenX $screenY $lock) -or
    ($expectedInputTick -ne [uint32]::MaxValue -and [Win32WechatMomentsPublish]::GetLastInputTick() -ne $expectedInputTick)) {
    return @{ ok = $false; reason = "moments_publish_click_target_changed" }
  }
  if ($irreversible -and $beforeIrreversibleClick -ne $null) {
    try {
      if (-not (& $beforeIrreversibleClick)) { return @{ ok = $false; reason = "moments_publish_marker_failed" } }
    } catch {
      return @{ ok = $false; reason = "moments_publish_marker_failed" }
    }
  }
  if ($irreversible) {
    Start-Sleep -Milliseconds 15
    if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd -or
      -not (Test-PublishOwnedPoint $screenX $screenY $lock) -or
      ($expectedInputTick -ne [uint32]::MaxValue -and [Win32WechatMomentsPublish]::GetLastInputTick() -ne $expectedInputTick)) {
      return @{ ok = $false; reason = "moments_publish_marker_written_target_changed" }
    }
    if ($afterMarkerValidation -ne $null) {
      try {
        $postMarkerValidation = & $afterMarkerValidation
        if ($postMarkerValidation -eq $null -or -not [bool]$postMarkerValidation.ok) {
          return @{ ok = $false; reason = "moments_publish_marker_written_target_changed" }
        }
        [uint32]$postMarkerInputTick = [uint32]$postMarkerValidation.inputTick
        if ($postMarkerInputTick -eq [uint32]::MaxValue) {
          return @{ ok = $false; reason = "moments_publish_marker_written_target_changed" }
        }
        $expectedInputTick = [uint32]$postMarkerValidation.inputTick
      } catch {
        return @{ ok = $false; reason = "moments_publish_marker_written_target_changed" }
      }
    }
    if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd -or
      -not (Test-PublishOwnedPoint $screenX $screenY $lock) -or
      ($expectedInputTick -ne [uint32]::MaxValue -and [Win32WechatMomentsPublish]::GetLastInputTick() -ne $expectedInputTick)) {
      return @{ ok = $false; reason = "moments_publish_marker_written_target_changed" }
    }
  }
  if ($irreversible) { $script:publishActionAttempted = $true }
  if (-not [Win32WechatMomentsPublish]::AtomicMouseClick($screenX, $screenY)) {
    return @{ ok = $false; reason = "moments_publish_click_injection_failed" }
  }
  Start-Sleep -Milliseconds 15
  [uint32]$inputTick = [Win32WechatMomentsPublish]::GetLastInputTick()
  if ($inputTick -eq [uint32]::MaxValue) {
    return @{ ok = $false; reason = "moments_publish_input_tick_unavailable" }
  }
  return @{ ok = $true; inputTick = $inputTick }
}

function Get-PublishVisualButtonCandidates($frame) {
  $candidates = New-Object System.Collections.Generic.List[object]
  if ($frame -eq $null -or -not [bool]$frame.ok -or
    [int]$frame.width -lt 300 -or [int]$frame.height -lt 300) {
    return @()
  }

  [int]$sampleStep = 2
  [int]$scanTop = [Math]::Max(0, [Math]::Floor([double]$frame.height * 0.80))
  [int]$minimumColumnGreen = [Math]::Max(6, [Math]::Round([double]$frame.height * 0.01))
  $activeColumns = New-Object System.Collections.Generic.List[object]
  for ($x = 0; $x -lt [int]$frame.width; $x += $sampleStep) {
    [int]$greenCount = 0
    [int]$minimumY = [int]$frame.height
    [int]$maximumY = -1
    for ($y = $scanTop; $y -lt [int]$frame.height; $y += $sampleStep) {
      if (-not (Test-MomentsSelectedGreenFramePixel $frame $x $y)) { continue }
      $greenCount += 1
      $minimumY = [Math]::Min($minimumY, $y)
      $maximumY = [Math]::Max($maximumY, $y)
    }
    if ($greenCount -ge $minimumColumnGreen) {
      [void]$activeColumns.Add(@{ x = $x; greenCount = $greenCount; minimumY = $minimumY; maximumY = $maximumY })
    }
  }
  if ($activeColumns.Count -eq 0) { return @() }

  $groups = New-Object System.Collections.Generic.List[object]
  $current = New-Object System.Collections.Generic.List[object]
  foreach ($column in $activeColumns) {
    if ($current.Count -gt 0 -and
      ([int]$column.x - [int]$current[$current.Count - 1].x) -gt ($sampleStep * 3)) {
      [void]$groups.Add(@($current.ToArray()))
      $current = New-Object System.Collections.Generic.List[object]
    }
    [void]$current.Add($column)
  }
  if ($current.Count -gt 0) { [void]$groups.Add(@($current.ToArray())) }

  foreach ($groupObject in $groups) {
    $group = @($groupObject)
    if ($group.Count -eq 0) { continue }
    [int]$left = [int]$group[0].x
    [int]$right = [Math]::Min([int]$frame.width, [int]$group[$group.Count - 1].x + $sampleStep)
    [int]$top = [int]$frame.height
    [int]$bottom = -1
    foreach ($column in $group) {
      $top = [Math]::Min($top, [int]$column.minimumY)
      $bottom = [Math]::Max($bottom, [int]$column.maximumY + $sampleStep)
    }
    [int]$width = $right - $left
    [int]$height = $bottom - $top
    if ($width -lt [Math]::Max(52, [Math]::Round([double]$frame.width * 0.12)) -or
      $width -gt [Math]::Round([double]$frame.width * 0.55) -or
      $height -lt [Math]::Max(20, [Math]::Round([double]$frame.height * 0.03)) -or
      $height -gt [Math]::Round([double]$frame.height * 0.14)) { continue }
    [double]$aspectRatio = [double]$width / [double]$height
    if ($aspectRatio -lt 1.8 -or $aspectRatio -gt 7.0) { continue }

    [int]$greenSamples = 0
    [int]$totalSamples = 0
    for ($sampleY = $top; $sampleY -lt $bottom; $sampleY += $sampleStep) {
      for ($sampleX = $left; $sampleX -lt $right; $sampleX += $sampleStep) {
        if (Test-MomentsSelectedGreenFramePixel $frame $sampleX $sampleY) {
          $greenSamples += 1
        }
        $totalSamples += 1
      }
    }
    [double]$greenRatio = $(if ($totalSamples -gt 0) {
      [double]$greenSamples / [double]$totalSamples
    } else { 0.0 })
    if ($greenRatio -lt 0.50) { continue }
    [void]$candidates.Add(@{
      x = [int][Math]::Round([double]$left + ([double]$width / 2.0))
      y = [int][Math]::Round([double]$top + ([double]$height / 2.0))
      bounds = @{ left = $left; top = $top; width = $width; height = $height }
      mode = "visual_green_action"
      greenRatio = [Math]::Round($greenRatio, 3)
    })
  }
  return @($candidates.ToArray())
}

function Get-PublishFullObservation(
  $lock,
  [bool]$requireOwnership = $true,
  [bool]$includePosts = $false,
  [bool]$includePublishButtonCandidates = $false
) {
  [uint32]$evidenceInputTick = [Win32WechatMomentsPublish]::GetLastInputTick()
  if ($evidenceInputTick -eq [uint32]::MaxValue) {
    return @{ ok = $false; reason = "moments_publish_input_tick_unavailable" }
  }
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.rect $lock.pid $false $requireOwnership
  if (-not $frame.ok) { return @{ ok = $false; reason = [string]$frame.reason } }
  try {
    $rect = @{ left = 0; top = 0; width = $frame.width; height = $frame.height }
    $ocr = Get-MomentsOcrObservation $frame $rect
    if (-not $ocr.ok) { return @{ ok = $false; reason = [string]$ocr.reason } }
    $publishButtonVisualCandidates = @()
    $viewportCompact = ""
    $viewportHash = ""
    if ($includePublishButtonCandidates -and [string]$lock.surfaceMode -ceq "composer") {
      $publishButtonVisualCandidates = @(Get-PublishVisualButtonCandidates $frame)
    }
    $posts = @()
    if ($includePosts) {
      $paneBounds = $lock.renderPane.bounds
      $relativePaneBounds = @{
        left = [double]$paneBounds.left - [double]$lock.rect.Left
        top = [double]$paneBounds.top - [double]$lock.rect.Top
        width = [double]$paneBounds.width
        height = [double]$paneBounds.height
      }
      $surfaceProof = @{ ok = $true }
      if ([string]$lock.surfaceMode -ceq "integrated") {
        $surfaceScanBounds = @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
        $surfaceProof = Test-IntegratedMomentsSurface $frame $surfaceScanBounds ([double]$lock.scale)
        if (-not $surfaceProof.ok) { return @{ ok = $false; reason = [string]$surfaceProof.reason } }
      }
      $visualViewport = Get-MomentsVisualViewportBounds $relativePaneBounds $surfaceProof ([string]$lock.surfaceMode)
      if (-not $visualViewport.ok) { return @{ ok = $false; reason = [string]$visualViewport.reason } }
      $read = Get-MomentsVisualPostCandidates $frame $visualViewport.bounds
      $posts = @($read.posts)
      $viewportLines = @($ocr.lines | Where-Object {
        $lineCenterX = [double]$_.bounds.left + ([double]$_.bounds.width / 2.0)
        $lineCenterY = [double]$_.bounds.top + ([double]$_.bounds.height / 2.0)
        $lineCenterX -ge [double]$visualViewport.bounds.left -and
          $lineCenterX -le ([double]$visualViewport.bounds.left + [double]$visualViewport.bounds.width) -and
          $lineCenterY -ge [double]$visualViewport.bounds.top -and
          $lineCenterY -le ([double]$visualViewport.bounds.top + [double]$visualViewport.bounds.height)
      } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
      $viewportCompact = Normalize-PublishText ([string]::Join(" ", @($viewportLines | ForEach-Object { [string]$_.compact })))
      $viewportHash = Get-MomentsPixelHash $frame $visualViewport.bounds
    }
    return @{
      ok = $true
      ocr = $ocr
      compact = Normalize-PublishText ([string]$ocr.text)
      pixelHash = Get-MomentsPixelHash $frame $rect
      viewportCompact = $viewportCompact
      viewportHash = $viewportHash
      posts = $posts
      publishButtonVisualCandidates = @($publishButtonVisualCandidates)
      width = $frame.width
      height = $frame.height
      inputTick = [uint32]$evidenceInputTick
    }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Get-PublishButtonObservation($lock) {
  [uint32]$evidenceInputTick = [Win32WechatMomentsPublish]::GetLastInputTick()
  if ($evidenceInputTick -eq [uint32]::MaxValue) {
    return @{ ok = $false; reason = "moments_publish_input_tick_unavailable" }
  }
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.rect $lock.pid $false $true
  if (-not $frame.ok) { return @{ ok = $false; reason = [string]$frame.reason } }
  try {
    $publishButtonVisualCandidates = @(Get-PublishVisualButtonCandidates $frame)
    $ocrLines = @()
    [string]$ocrMode = "skipped_visual_unique"
    [int]$buttonRegionTop = [Math]::Max(0, [Math]::Floor([double]$frame.height * 0.80))
    $buttonRegion = @{
      left = 0
      top = $buttonRegionTop
      width = [int]$frame.width
      height = [int]$frame.height - $buttonRegionTop
    }
    if ($publishButtonVisualCandidates.Count -ne 1) {
      $scopedOcr = Get-MomentsOcrObservation $frame $buttonRegion
      if (-not $scopedOcr.ok) { return @{ ok = $false; reason = [string]$scopedOcr.reason } }
      $shiftedLines = New-Object System.Collections.Generic.List[object]
      foreach ($line in @($scopedOcr.lines)) {
        $bounds = $line.bounds
        [void]$shiftedLines.Add(@{
          text = [string]$line.text
          compact = [string]$line.compact
          bounds = @{
            left = [double]$bounds.left + [double]$buttonRegion.left
            top = [double]$bounds.top + [double]$buttonRegion.top
            width = [double]$bounds.width
            height = [double]$bounds.height
          }
        })
      }
      $ocrLines = @($shiftedLines.ToArray())
      $ocrMode = "scoped_bottom_action_band"
    }
    [int]$ocrExactCount = @($ocrLines | Where-Object {
      (Normalize-PublishText ([string]$_.compact)) -ceq "发表"
    }).Count
    return @{
      ok = $true
      ocr = @{ lines = @($ocrLines) }
      publishButtonVisualCandidates = @($publishButtonVisualCandidates)
      width = [int]$frame.width
      height = [int]$frame.height
      inputTick = [uint32]$evidenceInputTick
      searchEvidence = @{
        frameWidth = [int]$frame.width
        frameHeight = [int]$frame.height
        scanTop = [int][Math]::Floor([double]$frame.height * 0.80)
        visualCount = [int]$publishButtonVisualCandidates.Count
        ocrExactCount = $ocrExactCount
        ocrMode = $ocrMode
        visualCandidates = @($publishButtonVisualCandidates | ForEach-Object {
          @{
            bounds = $_.bounds
            mode = [string]$_.mode
            greenRatio = [double]$_.greenRatio
          }
        })
      }
    }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Get-PublishButtonSearchSample($observation, [string]$phase, [int]$attempt) {
  $evidence = $observation.searchEvidence
  return @{
    phase = $phase
    attempt = $attempt
    frameWidth = [int]$evidence.frameWidth
    frameHeight = [int]$evidence.frameHeight
    scanTop = [int]$evidence.scanTop
    visualCount = [int]$evidence.visualCount
    ocrExactCount = [int]$evidence.ocrExactCount
    ocrMode = [string]$evidence.ocrMode
    visualCandidates = @($evidence.visualCandidates)
  }
}

function Test-PublishMomentsSurface($lock) {
  if ([string]$lock.surfaceMode -ceq "standalone") { return @{ ok = $true; mode = "standalone_title" } }
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.rect $lock.pid $false $true
  if (-not $frame.ok) { return @{ ok = $false; reason = [string]$frame.reason } }
  try {
    $paneBounds = $lock.renderPane.bounds
    $surfaceScanBounds = @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
    $proof = Test-IntegratedMomentsSurface $frame $surfaceScanBounds ([double]$lock.scale)
    if (-not $proof.ok) {
      $reason = $(if ([string]$proof.reason -ceq "moments_integrated_surface_not_proven") {
        "moments_publish_integrated_surface_not_proven"
      } else { [string]$proof.reason })
      return @{ ok = $false; reason = $reason }
    }
    return @{ ok = $true; mode = "integrated_selected_sidebar_ocr_and_green_band" }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Find-PublishVisualCameraTarget($frame, $lock, $paneBounds) {
  $paneLeft = [double]$paneBounds.left - [double]$lock.rect.Left
  $paneTop = [double]$paneBounds.top - [double]$lock.rect.Top
  $integrated = [string]$lock.surfaceMode -ceq "integrated"
  $logicalRight = $(if ($integrated) {
    ${MOMENTS_PUBLISH_CAMERA_PROFILE.integratedLogicalRight}.0
  } else {
    ${MOMENTS_PUBLISH_CAMERA_PROFILE.standaloneLogicalRight}.0
  })
  $logicalTop = $(if ($integrated) {
    ${MOMENTS_PUBLISH_CAMERA_PROFILE.integratedLogicalTop}.0
  } else {
    ${MOMENTS_PUBLISH_CAMERA_PROFILE.standaloneLogicalTop}.0
  })
  $centerX = [int][Math]::Round(
    $paneLeft + [double]$paneBounds.width - ($logicalRight * $lock.scale)
  )
  $centerY = [int][Math]::Round($paneTop + ($logicalTop * $lock.scale))
  $radiusX = [int][Math]::Max(12, [Math]::Round(${MOMENTS_PUBLISH_CAMERA_PROFILE.logicalRadiusX} * $lock.scale))
  $radiusY = [int][Math]::Max(10, [Math]::Round(${MOMENTS_PUBLISH_CAMERA_PROFILE.logicalRadiusY} * $lock.scale))
  $dark = 0
  $darkX = 0L
  $darkY = 0L
  $darkQuadrants = @(0, 0, 0, 0)
  $light = 0
  $lightX = 0L
  $lightY = 0L
  $lightQuadrants = @(0, 0, 0, 0)
  $total = 0
  for ($y = $centerY - $radiusY; $y -le $centerY + $radiusY; $y++) {
    for ($x = $centerX - $radiusX; $x -le $centerX + $radiusX; $x++) {
      $pixel = Get-MomentsPixel $frame $x $y
      if ($pixel -eq $null) { continue }
      $total += 1
      $maximum = [Math]::Max($pixel.r, [Math]::Max($pixel.g, $pixel.b))
      $minimum = [Math]::Min($pixel.r, [Math]::Min($pixel.g, $pixel.b))
      $spread = $maximum - $minimum
      $quadrant = $(if ($y -lt $centerY) { 0 } else { 2 }) + $(if ($x -lt $centerX) { 0 } else { 1 })
      if ($maximum -le 185 -and $minimum -ge 18 -and $spread -le 65) {
        $dark += 1
        $darkX += $x
        $darkY += $y
        $darkQuadrants[$quadrant] += 1
      }
      if ($minimum -ge 190 -and $spread -le 65) {
        $light += 1
        $lightX += $x
        $lightY += $y
        $lightQuadrants[$quadrant] += 1
      }
    }
  }
  $darkRatio = $(if ($total -gt 0) { [double]$dark / [double]$total } else { 0.0 })
  $lightRatio = $(if ($total -gt 0) { [double]$light / [double]$total } else { 0.0 })
  $darkOk = $dark -ge 18 -and $darkRatio -ge 0.018 -and $darkRatio -le 0.38 -and
    @($darkQuadrants | Where-Object { $_ -ge 2 }).Count -ge 3
  $lightOk = $light -ge 18 -and $lightRatio -ge 0.018 -and $lightRatio -le 0.38 -and
    @($lightQuadrants | Where-Object { $_ -ge 2 }).Count -ge 3
  if ($darkOk -eq $lightOk) {
    return @{ ok = $false; reason = "moments_publish_camera_not_found" }
  }
  $count = $(if ($darkOk) { $dark } else { $light })
  $sumX = $(if ($darkOk) { $darkX } else { $lightX })
  $sumY = $(if ($darkOk) { $darkY } else { $lightY })
  return @{
    ok = $true
    target = @{
      x = [int]$lock.rect.Left + [int][Math]::Round([double]$sumX / [double]$count)
      y = [int]$lock.rect.Top + [int][Math]::Round([double]$sumY / [double]$count)
      mode = "${MOMENTS_PUBLISH_CAMERA_PROFILE.name}_$([string]$lock.surfaceMode)_$(if ($darkOk) { 'dark' } else { 'light' })"
    }
  }
}

function Find-PublishCameraTarget($lock) {
  [uint32]$evidenceInputTick = [Win32WechatMomentsPublish]::GetLastInputTick()
  if ($evidenceInputTick -eq [uint32]::MaxValue) {
    return @{ ok = $false; reason = "moments_publish_input_tick_unavailable" }
  }
  $uiaMatches = New-Object System.Collections.Generic.List[object]
  $paneBounds = $lock.renderPane.bounds
  $all = $lock.root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($element in $all) {
    try {
      if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
      $bounds = $element.Current.BoundingRectangle
      $relativeLeft = [double]$bounds.Left - [double]$paneBounds.left
      $relativeTop = [double]$bounds.Top - [double]$paneBounds.top
      if ($relativeLeft -lt 0 -or $relativeTop -lt 0 -or
        $relativeLeft -lt ([double]$paneBounds.width - (100.0 * $lock.scale)) -or
        $relativeTop -gt (${MOMENTS_PUBLISH_CAMERA_PROFILE.logicalHeaderHeight}.0 * $lock.scale)) { continue }
      $name = ([string]$element.Current.Name).Trim()
      if ($name -match "(相机|拍照|发表|发布)") {
        [void]$uiaMatches.Add(@{
          x = [int][Math]::Round($bounds.Left + ($bounds.Width / 2.0))
          y = [int][Math]::Round($bounds.Top + ($bounds.Height / 2.0))
          mode = "uia_named_camera_button"
        })
      }
    } catch {}
  }
  if ($uiaMatches.Count -eq 1) {
    return @{ ok = $true; target = $uiaMatches[0]; inputTick = [uint32]$evidenceInputTick }
  }
  if ($uiaMatches.Count -gt 1) { return @{ ok = $false; reason = "moments_publish_camera_ambiguous" } }

  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.rect $lock.pid $false $true
  if (-not $frame.ok) { return @{ ok = $false; reason = [string]$frame.reason } }
  try {
    $visual = Find-PublishVisualCameraTarget $frame $lock $paneBounds
    if ($visual.ok) { $visual.inputTick = [uint32]$evidenceInputTick }
    return $visual
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Test-PublishFileDialogLease($dialog) {
  [IntPtr]$hWnd = [IntPtr]$dialog.hWnd
  if (-not [Win32WechatMomentsPublish]::IsWindow($hWnd) -or
    -not [Win32WechatMomentsPublish]::IsWindowVisible($hWnd)) {
    return @{ ok = $false; reason = "moments_publish_file_dialog_identity_changed" }
  }
  [uint32]$candidatePid = 0
  if ([Win32WechatMomentsPublish]::GetWindowThreadProcessId($hWnd, [ref]$candidatePid) -eq 0 -or
    [int]$candidatePid -ne [int]$dialog.pid) {
    return @{ ok = $false; reason = "moments_publish_file_dialog_identity_changed" }
  }
  $classText = New-Object System.Text.StringBuilder 128
  [void][Win32WechatMomentsPublish]::GetClassName($hWnd, $classText, $classText.Capacity)
  $titleText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatMomentsPublish]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
  if ($classText.ToString() -cne [string]$dialog.className -or
    $titleText.ToString().Trim() -cne [string]$dialog.title -or
    [Win32WechatMomentsPublish]::GetWindow($hWnd, 4) -ne [IntPtr]$dialog.owner) {
    return @{ ok = $false; reason = "moments_publish_file_dialog_identity_changed" }
  }
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $hWnd) {
    return @{ ok = $false; reason = "moments_publish_file_dialog_not_foreground" }
  }
  return @{ ok = $true }
}

function Get-PublishFileDialog($lock) {
  [int]$expectedPid = [int]$lock.pid
  [IntPtr]$expectedOwner = [IntPtr]$lock.hWnd
  $dialogCandidates = New-Object System.Collections.Generic.List[object]
  $callback = [Win32WechatMomentsPublish+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [Win32WechatMomentsPublish]::IsWindowVisible($hWnd)) { return $true }
    [uint32]$candidatePid = 0
    [void][Win32WechatMomentsPublish]::GetWindowThreadProcessId($hWnd, [ref]$candidatePid)
    if ([int]$candidatePid -ne $expectedPid) { return $true }
    $classText = New-Object System.Text.StringBuilder 128
    [void][Win32WechatMomentsPublish]::GetClassName($hWnd, $classText, $classText.Capacity)
    if ($classText.ToString() -cne "#32770") { return $true }
    if ([Win32WechatMomentsPublish]::GetWindow($hWnd, 4) -ne $expectedOwner) { return $true }
    $titleText = New-Object System.Text.StringBuilder 256
    [void][Win32WechatMomentsPublish]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
    if ($titleText.ToString().Trim() -notmatch "^(${MOMENTS_PUBLISH_FILE_DIALOG_TITLE_PREFIXES.join("|")})") { return $true }
    [void]$dialogCandidates.Add(@{
      hWnd = $hWnd
      pid = [int]$candidatePid
      owner = $expectedOwner
      className = $classText.ToString()
      title = $titleText.ToString().Trim()
    })
    return $true
  }
  [void][Win32WechatMomentsPublish]::EnumWindows($callback, [IntPtr]::Zero)
  if ($dialogCandidates.Count -eq 1) {
    $lease = Test-PublishFileDialogLease $dialogCandidates[0]
    if (-not $lease.ok) { return $lease }
    return @{ ok = $true; dialog = $dialogCandidates[0] }
  }
  if ($dialogCandidates.Count -gt 1) { return @{ ok = $false; reason = "moments_publish_file_dialog_ambiguous" } }
  return @{ ok = $false; reason = "moments_publish_file_dialog_missing" }
}

function Get-PublishOpenButton($root, [IntPtr]$dialogHandle) {
  # IDOK is Windows' primary action for a common #32770 file dialog.
  # Binding the native child avoids duplicate accessibility wrappers for "Open".
  $buttonHandle = [Win32WechatMomentsPublish]::GetDlgItem($dialogHandle, 1)
  if ($buttonHandle -eq [IntPtr]::Zero -or
    -not [Win32WechatMomentsPublish]::IsWindow($buttonHandle) -or
    -not [Win32WechatMomentsPublish]::IsChild($dialogHandle, $buttonHandle) -or
    -not [Win32WechatMomentsPublish]::IsWindowVisible($buttonHandle) -or
    -not [Win32WechatMomentsPublish]::IsWindowEnabled($buttonHandle) -or
    [Win32WechatMomentsPublish]::GetDlgCtrlID($buttonHandle) -ne 1) {
    return @{ ok = $false; reason = "moments_publish_open_button_missing" }
  }
  $classText = New-Object System.Text.StringBuilder 64
  [void][Win32WechatMomentsPublish]::GetClassName($buttonHandle, $classText, $classText.Capacity)
  $titleText = New-Object System.Text.StringBuilder 128
  [void][Win32WechatMomentsPublish]::GetWindowText($buttonHandle, $titleText, $titleText.Capacity)
  if ($classText.ToString() -cne "Button" -or
    $titleText.ToString().Trim() -notmatch "^(打开|Open)(?:\s*\([^)]+\))?$") {
    return @{ ok = $false; reason = "moments_publish_open_button_identity_mismatch" }
  }
  $button = [System.Windows.Automation.AutomationElement]::FromHandle($buttonHandle)
  if ($button -eq $null -or $button.Current.BoundingRectangle.IsEmpty) {
    return @{ ok = $false; reason = "moments_publish_open_button_uia_missing" }
  }
  return @{ ok = $true; target = @{ button = $button; handle = $buttonHandle } }
}

function Set-PublishDialogFiles($dialog, $mediaPaths) {
  $lease = Test-PublishFileDialogLease $dialog
  if (-not $lease.ok) { return $lease }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$dialog.hWnd)
  if ($root -eq $null) { return @{ ok = $false; reason = "moments_publish_file_dialog_uia_missing" } }
  $openResult = Get-PublishOpenButton $root ([IntPtr]$dialog.hWnd)
  if (-not $openResult.ok) { return $openResult }
  $values = @($mediaPaths | ForEach-Object { [string]$_ })
  $fileValue = $(if ($values.Count -eq 1) { $values[0] } else { [string]::Join(" ", @($values | ForEach-Object { '"' + $_ + '"' })) })
  $lease = Test-PublishFileDialogLease $dialog
  if (-not $lease.ok) { return $lease }
  # The native dialog exposes File name as Alt+N in both the Chinese and English
  # layouts used here. Focus it, replace any existing value, type the exact staged
  # path, and confirm. This mirrors the proven dt-ai-helper flow without touching
  # the user's clipboard or depending on the dialog's private descendant tree.
  if (-not [Win32WechatMomentsPublish]::AtomicKeyChord(0x12, 0x4E)) {
    return @{ ok = $false; reason = "moments_publish_file_name_focus_failed" }
  }
  Start-Sleep -Milliseconds 120
  $lease = Test-PublishFileDialogLease $dialog
  if (-not $lease.ok) { return $lease }
  if (-not [Win32WechatMomentsPublish]::AtomicKeyChord(0x11, 0x41) -or
    -not [Win32WechatMomentsPublish]::AtomicUnicodeText($fileValue)) {
    return @{ ok = $false; reason = "moments_publish_file_name_set_failed" }
  }
  Start-Sleep -Milliseconds 120
  $lease = Test-PublishFileDialogLease $dialog
  if (-not $lease.ok) { return $lease }
  if (-not [Win32WechatMomentsPublish]::AtomicVirtualKey(0x0D)) {
    return @{ ok = $false; reason = "moments_publish_open_button_failed" }
  }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 100
    if (-not [Win32WechatMomentsPublish]::IsWindow([IntPtr]$dialog.hWnd) -or
      -not [Win32WechatMomentsPublish]::IsWindowVisible([IntPtr]$dialog.hWnd)) {
      return @{ ok = $true }
    }
  }
  return @{ ok = $false; reason = "moments_publish_file_dialog_did_not_close" }
}

function Wait-PublishMediaProcessing($lock) {
  $clearFrames = 0
  for ($attempt = 0; $attempt -lt 18; $attempt++) {
    Start-Sleep -Milliseconds 700
    $observation = Get-PublishFullObservation $lock $true
    if (-not $observation.ok) { return $observation }
    $text = [string]$observation.ocr.text
    $errorLines = @($observation.ocr.lines | Where-Object {
      ([string]$_.compact) -match "^(文件过大|格式不支持|上传失败|处理失败|无法打开)$"
    })
    if ($errorLines.Count -gt 0) { return @{ ok = $false; reason = "moments_publish_media_rejected" } }
    if ($text -match "正在处理") {
      $clearFrames = 0
      continue
    }
    $clearFrames += 1
    if ($clearFrames -ge 2) { return @{ ok = $true } }
  }
  return @{ ok = $false; reason = "moments_publish_processing_timeout" }
}

function Get-PublishAccessibilityMetadata([System.Windows.Automation.AutomationElement]$element) {
  try {
    return @(
      [string]$element.Current.Name,
      [string]$element.Current.AutomationId,
      [string]$element.Current.HelpText,
      [string]$element.Current.ItemStatus,
      [string]$element.Current.ItemType
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
  } catch {
    return @()
  }
}

function Test-PublishComposerMediaEvidence(
  $lock,
  $manifestProof
) {
  if ([string]$lock.surfaceMode -ceq "composer") {
    if (-not $manifestProof.ok) {
      return @{ ok = $false; reason = "moments_publish_media_visual_missing" }
    }
    $frame = Get-MomentsVisualFrame $lock.hWnd $lock.rect $lock.pid $false $true
    if (-not $frame.ok) { return @{ ok = $false; reason = [string]$frame.reason } }
    try {
      $mediaBounds = @{
        left = [double]$frame.width * 0.055
        top = [double]$frame.height * 0.245
        width = [double]$frame.width * 0.62
        height = [double]$frame.height * 0.255
      }
      $evidenceKey = Get-MomentsPixelHash $frame $mediaBounds
      if (-not $evidenceKey) {
        return @{ ok = $false; reason = "moments_publish_media_visual_changed" }
      }
      return @{
        ok = $true
        evidenceKey = $evidenceKey
        count = [int]$manifestProof.count
        kind = [string]$manifestProof.kind
        proofMode = "visual_presence_only"
      }
    } finally {
      Close-MomentsVisualFrame $frame
    }
  }
  if (-not $manifestProof.ok -or $lock.renderPane.element -eq $null) {
    return @{ ok = $false; reason = "moments_publish_media_accessibility_missing" }
  }
  $evidence = Get-PublishBoundMediaEvidence $lock $manifestProof $lock.renderPane.bounds
  if ($evidence.ok) { $evidence.proofMode = "uia_one_to_one" }
  return $evidence
}

function Test-PublishExactContent([string]$actual, [string]$expected) {
  return [string]::Equals(
    (Normalize-PublishExactContent $actual),
    (Normalize-PublishExactContent $expected),
    [StringComparison]::Ordinal
  )
}

function Get-PublishClipboardUnicodeSnapshot {
  try {
    $value = $(if ([Windows.Forms.Clipboard]::ContainsText([Windows.Forms.TextDataFormat]::UnicodeText)) {
      [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
    } else { "" })
    return @{ ok = $true; value = [string]$value }
  } catch {
    return @{ ok = $false; reason = "moments_publish_clipboard_readback_failed" }
  }
}

function Wait-PublishClipboardSelection([string]$probe, [bool]$requireNonEmpty) {
  $observedReadableClipboard = $false
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    $snapshot = Get-PublishClipboardUnicodeSnapshot
    if ($snapshot.ok) {
      $observedReadableClipboard = $true
      $value = [string]$snapshot.value
      if (-not [string]::Equals($value, $probe, [StringComparison]::Ordinal)) {
        $normalized = Normalize-PublishExactContent $value
        if (-not $requireNonEmpty -or -not [string]::IsNullOrEmpty($normalized)) {
          return @{ ok = $true; value = $normalized }
        }
      }
    }
    Start-Sleep -Milliseconds 40
  }
  if (-not $requireNonEmpty -and $observedReadableClipboard) {
    return @{ ok = $true; value = "" }
  }
  return @{ ok = $false; reason = "moments_publish_clipboard_readback_failed" }
}

function Get-PublishSelectedContent($lock, [bool]$requireNonEmpty = $false) {
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd) {
    return @{ ok = $false; reason = "moments_publish_composer_not_foreground" }
  }
  $backup = $null
  $backupCaptured = $false
  $clipboardReady = $false
  $readback = @{ ok = $false; reason = "moments_publish_clipboard_readback_failed" }
  $restoreOk = $false
  $probe = "__XIAOXI_MOMENTS_SELECTION_" + [Guid]::NewGuid().ToString("N")
  try {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      try {
        $backup = [Windows.Forms.Clipboard]::GetDataObject()
        $backupCaptured = $true
        break
      } catch {
        Start-Sleep -Milliseconds 30
      }
    }
    if ($backupCaptured) {
      for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
          [Windows.Forms.Clipboard]::SetText($probe, [Windows.Forms.TextDataFormat]::UnicodeText)
          $clipboardReady = $true
          break
        } catch {
          Start-Sleep -Milliseconds 30
        }
      }
    }
    if ($clipboardReady -and
      [Win32WechatMomentsPublish]::GetForegroundWindow() -eq $lock.hWnd -and
      [Win32WechatMomentsPublish]::AtomicKeyChord(0x11, 0x43)) {
      $readback = Wait-PublishClipboardSelection $probe $requireNonEmpty
    }
  } finally {
    if ($backupCaptured) {
      for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
          if ($backup -eq $null) {
            [Windows.Forms.Clipboard]::Clear()
          } else {
            [Windows.Forms.Clipboard]::SetDataObject($backup, $true)
          }
          $restoreOk = $true
          break
        } catch {
          Start-Sleep -Milliseconds 30
        }
      }
    }
  }
  if (-not $restoreOk) { return @{ ok = $false; reason = "moments_publish_clipboard_restore_failed" } }
  if (-not $readback.ok) { return $readback }
  return @{ ok = $true; value = Normalize-PublishExactContent ([string]$readback.value) }
}

function Set-PublishComposerContentFromClipboard($lock, [string]$expectedContent) {
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd) {
    return @{ ok = $false; reason = "moments_publish_composer_not_foreground" }
  }
  $backup = $null
  $backupCaptured = $false
  $clipboardReady = $false
  $pasteAttempted = $false
  $restoreOk = $false
  try {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      try {
        $backup = [Windows.Forms.Clipboard]::GetDataObject()
        $backupCaptured = $true
        break
      } catch {
        Start-Sleep -Milliseconds 30
      }
    }
    if ($backupCaptured) {
      for ($attempt = 0; $attempt -lt 8; $attempt++) {
        try {
          [Windows.Forms.Clipboard]::SetText($expectedContent, [Windows.Forms.TextDataFormat]::UnicodeText)
          $clipboardValue = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
          if (Test-PublishExactContent ([string]$clipboardValue) $expectedContent) {
            $clipboardReady = $true
            break
          }
        } catch {
        }
        Start-Sleep -Milliseconds 30
      }
    }
    if ($clipboardReady -and [Win32WechatMomentsPublish]::GetForegroundWindow() -eq $lock.hWnd) {
      try {
        [Windows.Forms.SendKeys]::SendWait("^v")
        $pasteAttempted = [Win32WechatMomentsPublish]::GetForegroundWindow() -eq $lock.hWnd
      } catch {
        $pasteAttempted = $false
      }
      if ($pasteAttempted) { Start-Sleep -Milliseconds 150 }
    }
  } finally {
    if ($backupCaptured) {
      for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
          if ($backup -eq $null) {
            [Windows.Forms.Clipboard]::Clear()
          } else {
            [Windows.Forms.Clipboard]::SetDataObject($backup, $true)
          }
          $restoreOk = $true
          break
        } catch {
          Start-Sleep -Milliseconds 30
        }
      }
    }
  }
  if (-not $restoreOk) { return @{ ok = $false; reason = "moments_publish_clipboard_restore_failed" } }
  if (-not $clipboardReady -or -not $pasteAttempted) {
    return @{ ok = $false; reason = "moments_publish_content_input_failed" }
  }
  return @{ ok = $true }
}

function Set-PublishComposerContent($lock, [string]$expectedContent, [string]$token) {
  if ([string]$lock.surfaceMode -cne "composer" -or [string]::IsNullOrWhiteSpace($expectedContent)) {
    return @{ ok = $false; reason = "moments_publish_editor_not_writable" }
  }
  $before = Get-PublishFullObservation $lock $true
  if (-not $before.ok) { return $before }
  if (([string]$before.compact).IndexOf($token, [StringComparison]::Ordinal) -ge 0) {
    return @{ ok = $false; reason = "moments_publish_editor_not_empty" }
  }
  $editorX = [int]$lock.rect.Left + [int][Math]::Round(([double]$lock.rect.Right - [double]$lock.rect.Left) * 0.10)
  $editorY = [int]$lock.rect.Top + [int][Math]::Round(([double]$lock.rect.Bottom - [double]$lock.rect.Top) * 0.085)
  [uint32]$inputTick = [uint32]$before.inputTick
  $focusClick = Invoke-PublishOwnedClick $editorX $editorY $lock $false $inputTick
  if (-not $focusClick.ok) { return $focusClick }
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd -or
    -not [Win32WechatMomentsPublish]::AtomicKeyChord(0x11, 0x41)) {
    return @{ ok = $false; reason = "moments_publish_content_input_failed" }
  }
  Start-Sleep -Milliseconds 25
  $existingContent = Get-PublishSelectedContent $lock
  if (-not $existingContent.ok) { return $existingContent }
  if ([string]$existingContent.value -and
    -not (Test-PublishExactContent ([string]$existingContent.value) $expectedContent)) {
    return @{ ok = $false; reason = "moments_publish_editor_not_empty" }
  }
  if (-not (Test-PublishExactContent ([string]$existingContent.value) $expectedContent)) {
    $pasteResult = Set-PublishComposerContentFromClipboard $lock $expectedContent
    if (-not $pasteResult.ok) { return $pasteResult }
  }
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd -or
    -not [Win32WechatMomentsPublish]::AtomicKeyChord(0x11, 0x41)) {
    return @{ ok = $false; reason = "moments_publish_content_readback_mismatch" }
  }
  Start-Sleep -Milliseconds 25
  $exactReadback = Get-PublishSelectedContent $lock $true
  if (-not $exactReadback.ok) { return $exactReadback }
  if (-not (Test-PublishExactContent ([string]$exactReadback.value) $expectedContent)) {
    return @{ ok = $false; reason = "moments_publish_content_readback_mismatch" }
  }
  [void][Win32WechatMomentsPublish]::AtomicVirtualKey(0x27)
  Start-Sleep -Milliseconds 230
  return @{ ok = $true; runtimeId = "composer:" + [string]$lock.hWnd.ToInt64() }
}

function Test-PublishComposerContentFinal($lock, [string]$expectedContent) {
  if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd -or
    -not [Win32WechatMomentsPublish]::AtomicKeyChord(0x11, 0x41)) {
    return @{ ok = $false; reason = "moments_publish_content_readback_mismatch" }
  }
  Start-Sleep -Milliseconds 25
  $readback = Get-PublishSelectedContent $lock $true
  if (-not $readback.ok) { return $readback }
  if (-not (Test-PublishExactContent ([string]$readback.value) $expectedContent)) {
    return @{ ok = $false; reason = "moments_publish_content_readback_mismatch" }
  }
  [void][Win32WechatMomentsPublish]::AtomicVirtualKey(0x27)
  return @{ ok = $true }
}

function Get-PublishBoundMediaEvidence(
  $lock,
  $manifestProof,
  $containerBounds,
  [string]$expectedEvidenceKey = "",
  [bool]$allowStableOffscreenEvidence = $false
) {
  if (-not $manifestProof.ok -or $lock.renderPane.element -eq $null -or
    -not (Test-MomentsVisualBoundsInside $containerBounds $lock.renderPane.bounds)) {
    return @{ ok = $false; reason = "moments_publish_media_accessibility_missing" }
  }
  try {
    $elements = $lock.renderPane.element.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
  } catch {
    return @{ ok = $false; reason = "moments_publish_media_accessibility_missing" }
  }
  $expectedNames = @($manifestProof.names | ForEach-Object { ([string]$_).ToLowerInvariant() })
  $expectedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $expectedNames) { [void]$expectedSet.Add($name) }
  $discoveredSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $runtimeIdByName = @{}
  $nameByRuntimeId = @{}
  $stagedNamePattern = [Text.RegularExpressions.Regex]::new(
    "(?i)(?<![a-z0-9])\d{2}-[a-f0-9]{12}\.(?:jpeg|jpg|png|mov|mp4)(?![a-z0-9])"
  )
  $allowedTypes = @("ControlType.Image", "ControlType.ListItem", "ControlType.Button", "ControlType.Custom")
  for ($index = 0; $index -lt $elements.Count; $index++) {
    $element = $elements.Item($index)
    try {
      if ([int]$element.Current.ProcessId -ne [int]$lock.pid -or -not $element.Current.IsEnabled -or
        ($element.Current.IsOffscreen -and -not $allowStableOffscreenEvidence)) { continue }
      $controlType = [string]$element.Current.ControlType.ProgrammaticName
      if ($allowedTypes -notcontains $controlType) { continue }
      $bounds = $element.Current.BoundingRectangle
      $absoluteBounds = @{
        left = [double]$bounds.Left
        top = [double]$bounds.Top
        width = [double]$bounds.Width
        height = [double]$bounds.Height
      }
      if ($bounds.Width -le 0 -or $bounds.Height -le 0 -or
        (-not $allowStableOffscreenEvidence -and
          -not (Test-MomentsVisualBoundsInside $absoluteBounds $containerBounds))) { continue }
      $children = $element.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      if ($children.Count -ne 0) { continue }
    } catch { continue }
    $runtimeId = Get-MomentsVisualRuntimeId $element
    if (-not $runtimeId) { continue }
    $metadataText = [string]::Join(" ", @(Get-PublishAccessibilityMetadata $element))
    $matchedExpectedNames = @($expectedNames | Where-Object {
      $metadataText.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    $stagedNames = @($stagedNamePattern.Matches($metadataText) | ForEach-Object {
      ([string]$_.Value).ToLowerInvariant()
    } | Select-Object -Unique)
    foreach ($stagedName in $stagedNames) {
      if (-not $expectedSet.Contains($stagedName)) {
        return @{ ok = $false; reason = "moments_publish_media_accessibility_count_mismatch" }
      }
    }
    if ($matchedExpectedNames.Count -eq 0) { continue }
    if ($matchedExpectedNames.Count -ne 1 -or $stagedNames.Count -ne 1) {
      return @{ ok = $false; reason = "moments_publish_media_accessibility_aggregate" }
    }
    $matchedName = [string]$matchedExpectedNames[0]
    if ($runtimeIdByName.ContainsKey($matchedName) -or $nameByRuntimeId.ContainsKey($runtimeId)) {
      return @{ ok = $false; reason = "moments_publish_media_accessibility_not_one_to_one" }
    }
    $runtimeIdByName[$matchedName] = $runtimeId
    $nameByRuntimeId[$runtimeId] = $matchedName
    [void]$discoveredSet.Add($matchedName)
  }
  if ($discoveredSet.Count -ne $expectedSet.Count -or $runtimeIdByName.Count -ne $expectedSet.Count) {
    return @{ ok = $false; reason = "moments_publish_media_accessibility_count_mismatch" }
  }
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($name in @($expectedNames | Sort-Object)) {
    if (-not $discoveredSet.Contains($name) -or -not $runtimeIdByName.ContainsKey($name)) {
      return @{ ok = $false; reason = "moments_publish_media_accessibility_missing" }
    }
    [void]$parts.Add($name + "=" + [string]$runtimeIdByName[$name])
  }
  $evidenceKey = [string]::Join("|", $parts.ToArray())
  if ($expectedEvidenceKey -and $evidenceKey -cne $expectedEvidenceKey) {
    return @{ ok = $false; reason = "moments_publish_media_accessibility_changed" }
  }
  return @{
    ok = $true
    evidenceKey = $evidenceKey
    count = $expectedSet.Count
    kind = [string]$manifestProof.kind
  }
}

function Get-PublishFocusedTarget($lock) {
  try {
    $renderDescendants = $lock.renderPane.element.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $candidates = New-Object System.Collections.Generic.List[object]
    $paneBounds = $lock.renderPane.bounds
    for ($index = 0; $index -lt $renderDescendants.Count; $index++) {
      $element = $renderDescendants.Item($index)
      try {
        if ([int]$element.Current.ProcessId -ne [int]$lock.pid -or
          [string]$element.Current.ControlType.ProgrammaticName -cne "ControlType.Edit" -or
          -not $element.Current.IsEnabled -or -not $element.Current.IsKeyboardFocusable -or
          $element.Current.IsOffscreen) { continue }
        $valuePattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($valuePattern -eq $null -or $valuePattern.Current.IsReadOnly) { continue }
        $runtimeId = Get-MomentsVisualRuntimeId $element
        if (-not $runtimeId) { continue }
        $bounds = $element.Current.BoundingRectangle
        $absoluteBounds = @{
          left = [double]$bounds.Left
          top = [double]$bounds.Top
          width = [double]$bounds.Width
          height = [double]$bounds.Height
        }
        if ($bounds.Width -lt ([double]$paneBounds.width * 0.45) -or
          $bounds.Height -lt ([double]$paneBounds.height * 0.06) -or
          -not (Test-MomentsVisualBoundsInside $absoluteBounds $paneBounds)) { continue }
        [void]$candidates.Add(@{
          element = $element
          runtimeId = $runtimeId
          controlType = "ControlType.Edit"
          accessMode = "writable_value_pattern"
          valuePattern = $valuePattern
          bounds = $absoluteBounds
          value = Normalize-PublishExactContent ([string]$valuePattern.Current.Value)
        })
      } catch { continue }
    }
    if ($candidates.Count -ne 1) {
      return @{ ok = $false; reason = $(if ($candidates.Count -gt 1) { "moments_publish_editor_ambiguous" } else { "moments_publish_editor_not_writable" }) }
    }
    $candidate = $candidates[0]
    if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd) {
      return @{ ok = $false; reason = "moments_publish_editor_focus_missing" }
    }
    if (-not $candidate.element.Current.HasKeyboardFocus) {
      $candidate.element.SetFocus()
      Start-Sleep -Milliseconds 25
    }
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused -eq $null -or
      (Get-MomentsVisualRuntimeId $focused) -cne [string]$candidate.runtimeId -or
      [Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd) {
      return @{ ok = $false; reason = "moments_publish_editor_focus_missing" }
    }
    return @{
      ok = $true
      element = $candidate.element
      runtimeId = [string]$candidate.runtimeId
      controlType = [string]$candidate.controlType
      accessMode = [string]$candidate.accessMode
      valuePattern = $candidate.valuePattern
      bounds = $candidate.bounds
      value = [string]$candidate.value
    }
  } catch {
    return @{ ok = $false; reason = "moments_publish_editor_focus_missing" }
  }
}

function Get-PublishEditorObservation($lock, $expectedEditor) {
  $currentEditor = Get-PublishFocusedTarget $lock
  if (-not $currentEditor.ok -or [string]$currentEditor.runtimeId -cne [string]$expectedEditor.runtimeId -or
    [string]$currentEditor.controlType -cne [string]$expectedEditor.controlType -or
    [string]$currentEditor.accessMode -cne [string]$expectedEditor.accessMode) {
    return @{ ok = $false; reason = "moments_publish_editor_identity_changed" }
  }
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.rect $lock.pid $false $true
  if (-not $frame.ok) { return @{ ok = $false; reason = [string]$frame.reason } }
  try {
    $editorBounds = $currentEditor.bounds
    $relativeBounds = @{
      left = [double]$editorBounds.left - [double]$lock.rect.Left
      top = [double]$editorBounds.top - [double]$lock.rect.Top
      width = [double]$editorBounds.width
      height = [double]$editorBounds.height
    }
    $ocr = Get-MomentsOcrObservation $frame $relativeBounds
    if (-not $ocr.ok) { return @{ ok = $false; reason = [string]$ocr.reason } }
    return @{
      ok = $true
      compact = Normalize-PublishText ([string]$ocr.text)
      value = Normalize-PublishExactContent ([string]$currentEditor.valuePattern.Current.Value)
      editor = $currentEditor
    }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Test-PublishComposerAbsent($lock, [string]$editorRuntimeId) {
  if ($editorRuntimeId -match "^composer:(\d+)$") {
    [int64]$composerHandle = 0
    if (-not [int64]::TryParse([string]$Matches[1], [ref]$composerHandle) -or $composerHandle -eq 0) { return $false }
    return -not [Win32WechatMomentsPublish]::IsWindow([IntPtr]$composerHandle) -or
      -not [Win32WechatMomentsPublish]::IsWindowVisible([IntPtr]$composerHandle)
  }
  if (-not $editorRuntimeId -or $lock.renderPane.element -eq $null) { return $false }
  try {
    $elements = $lock.renderPane.element.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    for ($index = 0; $index -lt $elements.Count; $index++) {
      if ((Get-MomentsVisualRuntimeId $elements.Item($index)) -ceq $editorRuntimeId) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

function Find-PublishButton($observation) {
  $ocrMatches = New-Object System.Collections.Generic.List[object]
  foreach ($line in $observation.ocr.lines) {
    $compact = Normalize-PublishText ([string]$line.compact)
    $bounds = $line.bounds
    if ($compact -cne "发表" -or
      [double]$bounds.left -lt 0 -or
      [double]$bounds.top -lt ([double]$observation.height * 0.80) -or
      ([double]$bounds.left + [double]$bounds.width) -gt [double]$observation.width -or
      ([double]$bounds.top + [double]$bounds.height) -gt [double]$observation.height -or
      [double]$bounds.width -gt 150 -or [double]$bounds.height -gt 70) { continue }
    [void]$ocrMatches.Add(@{
      x = [int][Math]::Round([double]$bounds.left + ([double]$bounds.width / 2.0))
      y = [int][Math]::Round([double]$bounds.top + ([double]$bounds.height / 2.0))
      bounds = $bounds
      mode = "ocr_exact_label"
    })
  }
  $visualMatches = @($observation.publishButtonVisualCandidates | Where-Object { $_ -ne $null })
  if ($ocrMatches.Count -gt 1 -or $visualMatches.Count -gt 1) {
    return @{ ok = $false; reason = "moments_publish_button_ambiguous" }
  }
  if ($visualMatches.Count -eq 1 -and $ocrMatches.Count -eq 1) {
    $visualBounds = $visualMatches[0].bounds
    [double]$labelX = [double]$ocrMatches[0].x
    [double]$labelY = [double]$ocrMatches[0].y
    $labelInsideVisual = $labelX -ge [double]$visualBounds.left -and
      $labelX -le ([double]$visualBounds.left + [double]$visualBounds.width) -and
      $labelY -ge [double]$visualBounds.top -and
      $labelY -le ([double]$visualBounds.top + [double]$visualBounds.height)
    if (-not $labelInsideVisual) {
      return @{ ok = $false; reason = "moments_publish_button_ambiguous" }
    }
    return @{ ok = $true; target = $visualMatches[0] }
  }
  if ($visualMatches.Count -eq 1) { return @{ ok = $true; target = $visualMatches[0] } }
  if ($ocrMatches.Count -eq 1) { return @{ ok = $true; target = $ocrMatches[0] } }
  return @{ ok = $false; reason = "moments_publish_button_not_found" }
}

function Test-PublishButtonRebound($expectedTarget, $currentTarget) {
  if ($expectedTarget -eq $null -or $currentTarget -eq $null -or
    $expectedTarget.bounds -eq $null -or $currentTarget.bounds -eq $null) { return $false }
  $expected = $expectedTarget.bounds
  $current = $currentTarget.bounds
  if ([double]$expected.width -le 0 -or [double]$expected.height -le 0 -or
    [double]$current.width -le 0 -or [double]$current.height -le 0) { return $false }
  [double]$expectedCenterX = [double]$expectedTarget.x
  [double]$expectedCenterY = [double]$expectedTarget.y
  [double]$currentCenterX = [double]$currentTarget.x
  [double]$currentCenterY = [double]$currentTarget.y
  $expectedContainsCurrent = $currentCenterX -ge [double]$expected.left -and
    $currentCenterX -le ([double]$expected.left + [double]$expected.width) -and
    $currentCenterY -ge [double]$expected.top -and
    $currentCenterY -le ([double]$expected.top + [double]$expected.height)
  $currentContainsExpected = $expectedCenterX -ge [double]$current.left -and
    $expectedCenterX -le ([double]$current.left + [double]$current.width) -and
    $expectedCenterY -ge [double]$current.top -and
    $expectedCenterY -le ([double]$current.top + [double]$current.height)
  return $expectedContainsCurrent -and $currentContainsExpected
}

function Write-PublishMarker($context) {
  $markerPath = [string]$context.markerPath
  $fingerprint = [string]$context.fingerprint
  $attemptId = [string]$context.attemptId
  if ($fingerprint -notmatch "^[a-f0-9]{64}$" -or $attemptId -notmatch "^[a-f0-9-]{16,64}$") { return $false }
  $expectedName = $fingerprint + "." + $attemptId + ".json"
  if (-not [IO.Path]::IsPathRooted($markerPath) -or
    [IO.Path]::GetFileName($markerPath) -cne $expectedName -or
    [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($markerPath)) -cne "${PUBLISH_MARKER_DIRECTORY}" -or
    [IO.File]::Exists($markerPath)) { return $false }
  $temporaryPath = $markerPath + "." + [Guid]::NewGuid().ToString("N") + ".tmp"
  $stream = $null
  try {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($markerPath)) | Out-Null
    $payload = @{
      version = 1
      fingerprint = $fingerprint
      attempt_id = $attemptId
      action = "moments_publish"
      action_attempted = $true
      clicked_at = [DateTimeOffset]::UtcNow.ToString("o")
      expected_pid = [int]$context.expectedPid
      expected_hwnd = [string]$context.expectedHWnd
    } | ConvertTo-Json -Compress
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($payload + [Environment]::NewLine)
    $stream = [IO.FileStream]::new(
      $temporaryPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None,
      4096,
      [IO.FileOptions]::WriteThrough
    )
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    [IO.File]::Move($temporaryPath, $markerPath)
    return [IO.File]::Exists($markerPath)
  } catch {
    return $false
  } finally {
    if ($stream -ne $null) { try { $stream.Dispose() } catch {} }
    if ([IO.File]::Exists($temporaryPath)) { try { [IO.File]::Delete($temporaryPath) } catch {} }
  }
}

function Get-PublishPostCandidateKey($post) {
  $identity = Normalize-PublishText ([string]$post.identityText)
  $avatarHash = ([string]$post.avatarHash).ToLowerInvariant()
  if (-not $identity -or $avatarHash -notmatch "^[a-f0-9]{64}$") { return "" }
  $geometry = @(
    [Math]::Round([double]$post.bounds.left, 1),
    [Math]::Round([double]$post.bounds.top, 1),
    [Math]::Round([double]$post.bounds.width, 1),
    [Math]::Round([double]$post.bounds.height, 1),
    [Math]::Round([double]$post.menuBounds.left, 1),
    [Math]::Round([double]$post.menuBounds.top, 1)
  ) -join ","
  return $avatarHash + "|" + $identity + "|" + $geometry
}

function Test-PublishClientAccepted(
  $observation,
  $lock,
  [string]$editorRuntimeId,
  [string]$baselineHash
) {
  if (-not $observation.ok -or -not $observation.pixelHash -or $observation.pixelHash -ceq $baselineHash) {
    return @{ ok = $false; reason = "moments_publish_feed_unchanged" }
  }
  if (-not (Test-PublishComposerAbsent $lock $editorRuntimeId)) {
    return @{ ok = $false; reason = "moments_publish_composer_still_present" }
  }
  $surface = Test-PublishMomentsSurface $lock
  if (-not $surface.ok) {
    return @{ ok = $false; reason = [string]$surface.reason }
  }
  $visibleText = [string]$observation.ocr.text
  if ($visibleText -match "上传失败|发布失败|发送失败|网络异常|网络错误|请重试") {
    return @{ ok = $false; reason = "moments_publish_client_rejected" }
  }
  if ($visibleText -match "正在处理") {
    return @{ ok = $false; reason = "moments_publish_client_processing" }
  }
  return @{
    ok = $true
    verificationMode = "client_accepted_composer_closed_feed_changed"
  }
}

function Test-PublishVerified(
  $observation,
  $lock,
  [string]$editorRuntimeId,
  [string]$expectedVisibleAnchor,
  $manifestProof,
  $preclickMediaEvidence,
  [string]$baselineHash
) {
  if (-not $observation.ok -or -not $observation.pixelHash -or $observation.pixelHash -ceq $baselineHash) {
    return @{ ok = $false; reason = "moments_publish_feed_unchanged" }
  }
  if (-not $manifestProof.ok -or [int]$manifestProof.count -lt 1 -or
    @("image", "video") -notcontains [string]$manifestProof.kind) {
    return @{ ok = $false; reason = "moments_publish_manifest_not_proven" }
  }
  $preclickMediaProofMode = [string]$preclickMediaEvidence.proofMode
  if (@("uia_one_to_one", "visual_presence_only") -notcontains $preclickMediaProofMode) {
    return @{ ok = $false; reason = "moments_publish_post_media_not_proven" }
  }
  if ($preclickMediaProofMode -ceq "visual_presence_only" -and
    [string]$preclickMediaEvidence.evidenceKey -notmatch "^[a-f0-9]{64}$") {
    return @{ ok = $false; reason = "moments_publish_post_media_not_proven" }
  }
  if (-not (Test-PublishComposerAbsent $lock $editorRuntimeId)) {
    return @{ ok = $false; reason = "moments_publish_composer_still_present" }
  }
  $matching = New-Object System.Collections.Generic.List[object]
  foreach ($post in @($observation.posts)) {
    if ([bool]$post.partialVisible) { continue }
    $identityCompact = Normalize-PublishText ([string]$post.identityText)
    if (-not $expectedVisibleAnchor -or
      $identityCompact.IndexOf($expectedVisibleAnchor, [StringComparison]::Ordinal) -lt 0 -or
      [string]$post.regionHash -notmatch "^[a-f0-9]{64}$") { continue }
    $freshLines = @($post.ocrLines | Where-Object {
      (Normalize-PublishText ([string]$_.compact)) -ceq "刚刚"
    })
    if ($freshLines.Count -lt 1) { continue }
    $candidateKey = Get-PublishPostCandidateKey $post
    if (-not $candidateKey) { continue }
    [void]$matching.Add(@{
      key = $candidateKey + "|manifest:" + [string]$manifestProof.kind + ":" + [string]$manifestProof.count
      post = $post
      verificationMode = "unique_fresh_post_candidate"
    })
  }
  if ($matching.Count -gt 1) {
    return @{ ok = $false; reason = "moments_publish_post_ambiguous" }
  }
  if ($matching.Count -eq 0 -and $preclickMediaProofMode -ceq "visual_presence_only") {
    $visibleReceipt = Normalize-PublishText ([string]$observation.viewportCompact)
    $firstAnchor = $visibleReceipt.IndexOf($expectedVisibleAnchor, [StringComparison]::Ordinal)
    $lastAnchor = $visibleReceipt.LastIndexOf($expectedVisibleAnchor, [StringComparison]::Ordinal)
    if ($firstAnchor -lt 0 -or $firstAnchor -ne $lastAnchor -or
      [string]$observation.viewportHash -notmatch "^[a-f0-9]{64}$") {
      return @{ ok = $false; reason = "moments_publish_post_not_found" }
    }
    return @{
      ok = $true
      candidateKey = "visible-receipt|" + $expectedVisibleAnchor + "|manifest:" + [string]$manifestProof.kind + ":" + [string]$manifestProof.count
      verificationMode = "unique_visible_anchor_receipt"
    }
  }
  if ($matching.Count -ne 1) {
    return @{ ok = $false; reason = "moments_publish_post_not_found" }
  }
  return @{
    ok = $true
    candidateKey = [string]$matching[0].key
    verificationMode = [string]$matching[0].verificationMode
  }
}

try {
  $contextJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:XIAOXI_MOMENTS_PUBLISH_CONTEXT_BASE64))
  $context = $contextJson | ConvertFrom-Json
  $token = Normalize-PublishText ([string]$context.verificationToken)
  $expectedContent = Normalize-PublishExactContent ([string]$context.content)
  $expectedContentCompact = Normalize-PublishText ([string]$context.verificationContent)
  $mediaPaths = @($context.mediaPaths | ForEach-Object { [string]$_ })
  if ($token.Length -lt 6 -or $expectedContentCompact.Length -lt 6 -or
    $expectedContentCompact -cne (Normalize-PublishText $expectedContent) -or
    $mediaPaths.Count -lt 1 -or $mediaPaths.Count -gt 9) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = "moments_publish_context_invalid"; verified = $false }
  }
  $manifestProof = Test-PublishMediaManifest $context
  if (-not $manifestProof.ok) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = $manifestProof.reason; verified = $false }
  }
  $mediaPaths = @($manifestProof.paths)

  $lock = Get-PublishWindowLock $context
  if (-not $lock.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $lock.reason; verified = $false } }
  $mainLock = $lock
  $script:publishStage = "baseline_observation"
  $surface = Test-PublishMomentsSurface $lock
  if (-not $surface.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $surface.reason; verified = $false } }
  $baseline = Get-PublishFullObservation $lock $true
  if (-not $baseline.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $baseline.reason; verified = $false } }
  if (([string]$baseline.compact).IndexOf($token, [StringComparison]::Ordinal) -ge 0) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = "moments_publish_verification_token_not_unique"; verified = $false }
  }

  $script:publishStage = "camera_targeting"
  $camera = Find-PublishCameraTarget $lock
  if (-not $camera.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $camera.reason; verified = $false } }
  [uint32]$cameraInputTick = [uint32]$camera.inputTick
  if ($cameraInputTick -eq [uint32]::MaxValue) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = "moments_publish_input_tick_unavailable"; verified = $false }
  }
  $cameraClick = Invoke-PublishOwnedClick $camera.target.x $camera.target.y $lock $false $cameraInputTick
  if (-not $cameraClick.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $cameraClick.reason; verified = $false } }

  $script:publishStage = "file_dialog"
  $fileDialog = $null
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 200
    $candidate = Get-PublishFileDialog $lock
    if ($candidate.ok) { $fileDialog = $candidate.dialog; break }
    if ($candidate.reason -ne "moments_publish_file_dialog_missing") {
      Write-PublishResult @{ ok = $false; status = "blocked"; reason = $candidate.reason; verified = $false }
    }
  }
  if ($fileDialog -eq $null) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = "moments_publish_file_dialog_missing"; verified = $false } }
  $fileSelection = Set-PublishDialogFiles $fileDialog $mediaPaths
  if (-not $fileSelection.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $fileSelection.reason; verified = $false } }
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (-not [Win32WechatMomentsPublish]::IsWindow([IntPtr]$fileDialog.hWnd) -or
      -not [Win32WechatMomentsPublish]::IsWindowVisible([IntPtr]$fileDialog.hWnd)) { break }
    $dialogLease = Test-PublishFileDialogLease $fileDialog
    if (-not $dialogLease.ok) {
      Write-PublishResult @{ ok = $false; status = "blocked"; reason = $dialogLease.reason; verified = $false }
    }
    Start-Sleep -Milliseconds 200
  }
  if ([Win32WechatMomentsPublish]::IsWindow([IntPtr]$fileDialog.hWnd) -and
    [Win32WechatMomentsPublish]::IsWindowVisible([IntPtr]$fileDialog.hWnd)) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = "moments_publish_file_dialog_did_not_close"; verified = $false }
  }

  $lock = Wait-PublishComposerWindowLock $context $mainLock
  if (-not $lock.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $lock.reason; verified = $false } }
  $script:publishStage = "media_processing"
  $processed = Wait-PublishMediaProcessing $lock
  if (-not $processed.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $processed.reason; verified = $false } }
  $mediaEvidence = Test-PublishComposerMediaEvidence $lock $manifestProof
  if (-not $mediaEvidence.ok) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = $mediaEvidence.reason; verified = $false }
  }

  $script:publishStage = "content_input"
  $focusedTarget = Set-PublishComposerContent $lock $expectedContent $token
  if (-not $focusedTarget.ok) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = $focusedTarget.reason; verified = $false }
  }
  $script:publishStage = "prepublish_verification"
  $publishButton = $null
  $publishButtonSearch = New-Object System.Collections.Generic.List[object]
  [int]$maximumPublishButtonScrolls = 12
  for ($observationAttempt = 0; $observationAttempt -le $maximumPublishButtonScrolls; $observationAttempt++) {
    $lock = Get-PublishComposerWindowLock $context $mainLock
    if (-not $lock.ok) {
      Write-PublishResult @{ ok = $false; status = "blocked"; reason = $lock.reason; verified = $false }
    }
    $observation = Get-PublishButtonObservation $lock
    if (-not $observation.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $observation.reason; verified = $false } }
    [void]$publishButtonSearch.Add((Get-PublishButtonSearchSample $observation "scroll" $observationAttempt))
    $buttonResult = Find-PublishButton $observation
    if ($buttonResult.ok) { $publishButton = $buttonResult.target; break }
    if ($buttonResult.reason -eq "moments_publish_button_ambiguous") {
      Write-PublishResult @{
        ok = $false
        status = "blocked"
        reason = $buttonResult.reason
        verified = $false
        publishButtonSearch = @($publishButtonSearch.ToArray())
      }
    }
    if ($observationAttempt -eq $maximumPublishButtonScrolls) { break }
    $wheelX = [int][Math]::Round(($lock.rect.Left + $lock.rect.Right) / 2.0)
    $wheelY = [int][Math]::Round(($lock.rect.Top + $lock.rect.Bottom) / 2.0)
    if ([Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd -or
      -not (Test-PublishOwnedPoint $wheelX $wheelY $lock) -or
      -not [Win32WechatMomentsPublish]::SetCursorPos($wheelX, $wheelY) -or
      [Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd -or
      -not (Test-PublishOwnedPoint $wheelX $wheelY $lock) -or
      -not [Win32WechatMomentsPublish]::AtomicMouseWheel(-600)) {
      Write-PublishResult @{ ok = $false; status = "blocked"; reason = "moments_publish_scroll_failed"; verified = $false }
    }
    Start-Sleep -Milliseconds 1000
  }
  if ($publishButton -eq $null) {
    for ($settleAttempt = 0; $settleAttempt -lt 3 -and $publishButton -eq $null; $settleAttempt++) {
      Start-Sleep -Milliseconds 400
      $lock = Get-PublishComposerWindowLock $context $mainLock
      if (-not $lock.ok) {
        Write-PublishResult @{ ok = $false; status = "blocked"; reason = $lock.reason; verified = $false }
      }
      $observation = Get-PublishButtonObservation $lock
      if (-not $observation.ok) {
        Write-PublishResult @{ ok = $false; status = "blocked"; reason = $observation.reason; verified = $false }
      }
      [void]$publishButtonSearch.Add((Get-PublishButtonSearchSample $observation "settle" $settleAttempt))
      $buttonResult = Find-PublishButton $observation
      if ($buttonResult.ok) { $publishButton = $buttonResult.target; break }
      if ($buttonResult.reason -eq "moments_publish_button_ambiguous") {
        Write-PublishResult @{
          ok = $false
          status = "blocked"
          reason = $buttonResult.reason
          verified = $false
          publishButtonSearch = @($publishButtonSearch.ToArray())
        }
      }
    }
  }
  if ($publishButton -eq $null) {
    Write-PublishResult @{
      ok = $false
      status = "blocked"
      reason = "moments_publish_button_not_found"
      verified = $false
      publishButtonSearch = @($publishButtonSearch.ToArray())
    }
  }

  $lock = Get-PublishComposerWindowLock $context $mainLock
  if (-not $lock.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $lock.reason; verified = $false } }
  $finalManifestProof = Test-PublishMediaManifest $context
  if (-not $finalManifestProof.ok) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = $finalManifestProof.reason; verified = $false }
  }
  $finalContentProof = Test-PublishComposerContentFinal $lock $expectedContent
  if (-not $finalContentProof.ok) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = $finalContentProof.reason; verified = $false }
  }
  $freshObservation = Get-PublishButtonObservation $lock
  if (-not $freshObservation.ok) { Write-PublishResult @{ ok = $false; status = "blocked"; reason = $freshObservation.reason; verified = $false } }
  $freshButton = Find-PublishButton $freshObservation
  if (-not $freshButton.ok) {
    [void]$publishButtonSearch.Add((Get-PublishButtonSearchSample $freshObservation "final_rebind" 0))
    Write-PublishResult @{
      ok = $false
      status = "blocked"
      reason = $freshButton.reason
      verified = $false
      publishButtonSearch = @($publishButtonSearch.ToArray())
    }
  }
  $publishScreenX = [int]$lock.rect.Left + [int]$freshButton.target.x
  $publishScreenY = [int]$lock.rect.Top + [int]$freshButton.target.y
  [uint32]$publishClickInputTick = [uint32]$freshObservation.inputTick
  if ($publishClickInputTick -eq [uint32]::MaxValue) {
    Write-PublishResult @{ ok = $false; status = "blocked"; reason = "moments_publish_input_tick_unavailable"; verified = $false }
  }

  $script:publishStage = "publish_click"
  $publishClick = Invoke-PublishOwnedClick $publishScreenX $publishScreenY $lock $true $publishClickInputTick {
    Write-PublishMarker $context
  } {
    $postMarkerObservation = Get-PublishButtonObservation $lock
    if (-not $postMarkerObservation.ok) { return $false }
    $postMarkerButton = Find-PublishButton $postMarkerObservation
    if (-not $postMarkerButton.ok) { return $false }
    $postMarkerScreenX = [int]$lock.rect.Left + [int]$postMarkerButton.target.x
    $postMarkerScreenY = [int]$lock.rect.Top + [int]$postMarkerButton.target.y
    return @{
      ok = Test-PublishButtonRebound $freshButton.target $postMarkerButton.target
      inputTick = [uint32]$postMarkerObservation.inputTick
    }
  }
  if (-not $publishClick.ok) {
    $clickOutcomeUnknown = $script:publishActionAttempted -or
      [IO.File]::Exists([string]$context.markerPath)
    Write-PublishResult @{
      ok = $false
      status = $(if ($clickOutcomeUnknown) { "outcome_unknown" } else { "blocked" })
      reason = $publishClick.reason
      verified = $false
    }
  }

  $script:publishStage = "postpublish_verification"
  $verificationTimeoutMs = ${PUBLISH_POSTVERIFY_TIMEOUT_MS}
  $verificationIntervalMs = ${PUBLISH_POSTVERIFY_INTERVAL_MS}
  $verificationStopwatch = [Diagnostics.Stopwatch]::StartNew()
  $verificationAttempts = 0
  $lastVerificationReason = ""
  while ($verificationStopwatch.ElapsedMilliseconds -lt $verificationTimeoutMs) {
    $remainingMs = $verificationTimeoutMs - [int]$verificationStopwatch.ElapsedMilliseconds
    if ($remainingMs -le 0) { break }
    Start-Sleep -Milliseconds ([Math]::Min($verificationIntervalMs, $remainingMs))
    $verificationAttempts++
    $currentLock = Get-PublishWindowLock $context
    if (-not $currentLock.ok) {
      $lastVerificationReason = [string]$currentLock.reason
      if (-not $lastVerificationReason) { $lastVerificationReason = "moments_publish_window_lock_failed" }
      continue
    }
    $after = Get-PublishFullObservation $currentLock $true $true
    if (-not $after.ok) {
      $lastVerificationReason = [string]$after.reason
      if (-not $lastVerificationReason) { $lastVerificationReason = "moments_publish_observation_failed" }
      continue
    }
    $verified = Test-PublishVerified $after $currentLock ([string]$focusedTarget.runtimeId) $expectedContentCompact $finalManifestProof $mediaEvidence ([string]$baseline.pixelHash)
    if ($verified.ok) {
      $verificationStopwatch.Stop()
      Write-PublishResult @{
        ok = $true
        status = "verified"
        reason = "moments_publish_verified"
        verified = $true
        verificationMode = [string]$verified.verificationMode
        verificationCandidateKey = [string]$verified.candidateKey
        verificationAttempts = [int]$verificationAttempts
        verificationElapsedMs = [int]$verificationStopwatch.ElapsedMilliseconds
        lastVerificationReason = [string]$lastVerificationReason
      }
    }
    $lastVerificationReason = [string]$verified.reason
    if (-not $lastVerificationReason) { $lastVerificationReason = "moments_publish_verification_failed" }
  }
  $verificationStopwatch.Stop()
  if (-not $lastVerificationReason) { $lastVerificationReason = "moments_publish_verification_timed_out" }
  Write-PublishResult @{
    ok = $false
    status = "outcome_unknown"
    reason = "moments_publish_outcome_unknown"
    verified = $false
    verificationAttempts = [int]$verificationAttempts
    verificationElapsedMs = [int]$verificationStopwatch.ElapsedMilliseconds
    lastVerificationReason = [string]$lastVerificationReason
  }
} catch {
  $exceptionType = ""
  if ($_.Exception -ne $null) {
    $exceptionType = [string]$_.Exception.GetType().FullName
  }
  Write-PublishResult @{
    ok = $false
    status = $(if ($script:publishActionAttempted) { "outcome_unknown" } else { "blocked" })
    reason = $(if ($script:publishActionAttempted) { "moments_publish_failed_after_click" } else { "moments_publish_driver_failed" })
    verified = $false
    failureKind = "powershell_exception"
    exceptionCategory = ([string]$_.CategoryInfo.Category)
    exceptionType = $exceptionType
  }
}
`;

async function runMomentsPublish(context = {}) {
  const content = String(context.content ?? "").replace(/\r\n?/gu, "\n").trim();
  const mediaPaths = Array.isArray(context.mediaPaths) ? context.mediaPaths.map((value) => String(value)) : [];
  const fingerprint = String(context.fingerprint ?? "");
  const attemptId = String(context.attemptId ?? "");
  const markerPath = String(context.markerPath ?? "");
  const expectedPid = Number(context.expectedWindow?.pid ?? context.expectedPid);
  const expectedHWnd = String(context.expectedWindow?.hWnd ?? context.expectedHWnd ?? "");
  const expectedTitle = String(context.expectedWindow?.title ?? context.expectedTitle ?? "");
  const expectedClassName = String(context.expectedWindow?.className ?? context.expectedClassName ?? "");
  const expectedSurfaceMode = String(context.expectedWindow?.surfaceMode ?? context.expectedSurfaceMode ?? "");
  const expectedX = Number(context.expectedWindow?.x ?? context.expectedX);
  const expectedY = Number(context.expectedWindow?.y ?? context.expectedY);
  const expectedWidth = Number(context.expectedWindow?.width ?? context.expectedWidth);
  const expectedHeight = Number(context.expectedWindow?.height ?? context.expectedHeight);
  const expectedDpi = Number(context.expectedWindow?.dpi ?? context.expectedDpi);
  const token = verificationToken(content);
  const verificationText = verificationContent(content);
  if (!Number.isInteger(expectedPid) || expectedPid <= 0 || !/^\d+$/u.test(expectedHWnd)) {
    return blocked("moments_publish_window_identity_invalid");
  }
  const windowProfileValid = expectedClassName.length > 0
    && expectedClassName.length <= 256
    && (
      (expectedSurfaceMode === "standalone" && expectedTitle === "朋友圈")
      || (expectedSurfaceMode === "integrated" && expectedTitle === "微信")
    );
  if (!windowProfileValid) return blocked("moments_publish_window_identity_invalid");
  if (!Number.isInteger(expectedX) || !Number.isInteger(expectedY)
    || !Number.isInteger(expectedWidth) || expectedWidth < 300
    || !Number.isInteger(expectedHeight) || expectedHeight < 300
    || !Number.isInteger(expectedDpi) || expectedDpi < 72 || expectedDpi > 480) {
    return blocked("moments_publish_window_identity_invalid");
  }
  if (content.length > 2000 || token.length < 6 || verificationText.length < 6) {
    return blocked("moments_publish_content_not_verifiable");
  }
  const mediaContract = validateMediaContract(context, mediaPaths);
  if (!mediaContract.ok) return blocked("moments_publish_media_manifest_invalid");
  if (!validMarkerPath(markerPath, fingerprint, attemptId)) return blocked("moments_publish_marker_path_invalid");

  const payload = {
    expectedPid,
    expectedHWnd,
    expectedTitle,
    expectedClassName,
    expectedSurfaceMode,
    expectedX,
    expectedY,
    expectedWidth,
    expectedHeight,
    expectedDpi,
    content,
    verificationToken: token,
    verificationContent: verificationText,
    mediaPaths,
    mediaManifest: mediaContract.manifest,
    mediaCount: mediaContract.mediaCount,
    mediaKind: mediaContract.mediaKind,
    fingerprint,
    attemptId,
    markerPath
  };
  return runPowerShellAsync(
    MOMENTS_PUBLISH_POWERSHELL,
    {
      XIAOXI_MOMENTS_PUBLISH_CONTEXT_BASE64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
    },
    {
      ensure: false,
      sta: true,
      timeout: 150_000,
      diagnostics: false,
      signal: context.signal
    }
  );
}

module.exports = {
  MOMENTS_PUBLISH_CAMERA_PROFILE,
  MOMENTS_PUBLISH_FILE_DIALOG_TITLE_PREFIXES,
  MOMENTS_PUBLISH_POWERSHELL,
  PUBLISH_MARKER_DIRECTORY,
  runMomentsPublish,
  validMarkerPath,
  verificationToken
};
