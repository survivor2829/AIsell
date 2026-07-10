const { spawnSync } = require("node:child_process");

const SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WindowTitles {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
}
"@
$titles = New-Object System.Collections.Generic.List[string]
$callback = [Win32WindowTitles+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ([Win32WindowTitles]::IsWindowVisible($hWnd)) {
    $text = New-Object System.Text.StringBuilder 512
    [void][Win32WindowTitles]::GetWindowText($hWnd, $text, $text.Capacity)
    $title = $text.ToString().Trim()
    if ($title) { [void]$titles.Add($title) }
  }
  return $true
}
[void][Win32WindowTitles]::EnumWindows($callback, [IntPtr]::Zero)
@($titles) | ConvertTo-Json -Compress
`;

function readWindowTitles() {
  const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });

  if (result.error || result.status !== 0) return [];

  try {
    const parsed = JSON.parse(result.stdout.trim() || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { readWindowTitles };
