const { spawn } = require("node:child_process");

const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XiaoxiTaskPassportCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w,out uint p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w,out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
}
"@
[void][XiaoxiTaskPassportCapture]::SetThreadDpiAwarenessContext([IntPtr](-4))
$hwnd=if($requestedHwnd -ne [IntPtr]::Zero) { $requestedHwnd } else { [XiaoxiTaskPassportCapture]::GetForegroundWindow() }
[uint32]$processId=0
[void][XiaoxiTaskPassportCapture]::GetWindowThreadProcessId($hwnd,[ref]$processId)
$process=(Get-Process -Id $processId -ErrorAction Stop)
if($process.ProcessName -notin @('WeChat','Weixin')) { throw 'foreground_not_wechat' }
$rect=New-Object XiaoxiTaskPassportCapture+RECT
if(-not [XiaoxiTaskPassportCapture]::GetWindowRect($hwnd,[ref]$rect)) { throw 'window_rect_unavailable' }
$width=$rect.R-$rect.L; $height=$rect.B-$rect.T
if($width -lt 32 -or $height -lt 32 -or $width -gt 4096 -or $height -gt 4096) { throw 'window_size_unsupported' }
$bitmap=New-Object Drawing.Bitmap($width,$height)
$graphics=[Drawing.Graphics]::FromImage($bitmap)
$stream=New-Object IO.MemoryStream
try {
 $dc=$graphics.GetHdc()
 try { if(-not [XiaoxiTaskPassportCapture]::PrintWindow($hwnd,$dc,2)) { throw 'print_window_failed' } }
 finally { $graphics.ReleaseHdc($dc) }
 $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
 [Convert]::ToBase64String($stream.ToArray())
} finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
`;

function captureWechatScreenshot(options = {}) {
  const candidate = Number(options.windowHandle);
  const windowHandle = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 0;
  const command = `$requestedHwnd=[IntPtr]${windowHandle}\r\n${SCRIPT}`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    let bytes = 0;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("task_passport_screenshot_timeout"));
    }, 8_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 12 * 1024 * 1024) {
        child.kill();
        reject(new Error("task_passport_screenshot_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error("task_passport_screenshot_failed"));
        return;
      }
      const content = Buffer.from(Buffer.concat(chunks).toString("utf8").trim(), "base64");
      if (!content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
        reject(new Error("task_passport_screenshot_invalid"));
        return;
      }
      resolve(content);
    });
  });
}

module.exports = { captureWechatScreenshot };
