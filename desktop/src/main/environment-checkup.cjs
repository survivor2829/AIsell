// 体检 (user decisions 2026-10-30): once per computer, in the background, the app checks what every
// feature depends on. The customer sees nothing (the button and window were taken out); a result with
// anything not ok goes out as one failure capsule (module "checkup"), so support knows which computer
// lacks what when its user says something does not work.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { writeJsonAtomic } = require("./atomic-file.cjs");

// WeChat versions this app has been run against end to end (PROJECT_STATUS: 4.1.13, 4.1.15).
const VERIFIED_WECHAT = /^4\.1\./;
const GB = 1024 ** 3;

// Reads the running WeChat (or its install) and whether a main window is showing, without touching it.
const WECHAT_PROBE = String.raw`
$ErrorActionPreference = "SilentlyContinue"
$procs = @(Get-Process -Name Weixin, WeChat | Where-Object { $_.Path })
$path = if ($procs.Count) { $procs[0].Path } else { $null }
if (-not $path) {
  $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  $candidates = @("$env:ProgramFiles\Tencent\Weixin\Weixin.exe", "$pf86\Tencent\Weixin\Weixin.exe",
    "$env:LOCALAPPDATA\Tencent\Weixin\Weixin.exe", "$env:ProgramFiles\Tencent\WeChat\WeChat.exe", "$pf86\Tencent\WeChat\WeChat.exe")
  foreach ($key in @("HKCU:\Software\Tencent\Weixin", "HKCU:\Software\Tencent\WeChat")) {
    $dir = (Get-ItemProperty $key).InstallPath
    if ($dir) { $candidates += (Join-Path $dir "Weixin.exe"); $candidates += (Join-Path $dir "WeChat.exe") }
  }
  $path = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
$version = if ($path) { (Get-Item $path).VersionInfo.ProductVersion } else { "" }
$window = @($procs | Where-Object { $_.MainWindowTitle -in @("微信", "WeChat", "Weixin") }).Count -gt 0
[Console]::OutputEncoding = [Text.Encoding]::UTF8
@{ installed = [bool]$path; running = $procs.Count -gt 0; window = $window; version = [string]$version } | ConvertTo-Json -Compress
`;

function probeWechat() {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WECHAT_PROBE],
      { windowsHide: true, timeout: 15000, encoding: "utf8" }, (error, stdout) => {
        try { resolve(JSON.parse(String(stdout).trim())); } catch { resolve({ error: error?.code || "probe_failed" }); }
      });
  });
}

const item = (id, label, status, detail, fix = "") => ({ id, label, status, detail, fix });

function wechatItem(wechat) {
  const label = "微信";
  if (!wechat || wechat.error) return item("wechat", label, "warn", "没能读出微信的状态。", "确认微信已安装并打开，再点「重新检查」。");
  if (!wechat.installed) return item("wechat", label, "fail", "这台电脑上没有找到微信。", "安装 Windows 版微信 4.1，登录后再点「重新检查」。");
  const version = String(wechat.version || "");
  if (version && !VERIFIED_WECHAT.test(version)) {
    return item("wechat", label, "warn", `微信版本 ${version} 还没有在本软件上验证过，触达、自动回复、朋友圈可能出错。`, "建议换成微信 4.1 版本。");
  }
  if (!wechat.running) return item("wechat", label, "warn", `已安装微信 ${version}，但现在没有打开。`, "打开微信并扫码登录。");
  if (!wechat.window) return item("wechat", label, "warn", `微信 ${version} 在运行，但主窗口没有显示（可能还没登录或被最小化到托盘）。`, "登录微信，并把微信主窗口打开。");
  return item("wechat", label, "ok", `微信 ${version} 已登录并打开。`);
}

function displayItem(display) {
  const label = "屏幕";
  if (!display) return item("display", label, "warn", "没能读出屏幕信息。");
  const scale = Math.round(Number(display.scaleFactor || 1) * 100);
  const width = Number(display.workAreaSize?.width || display.size?.width || 0), height = Number(display.workAreaSize?.height || display.size?.height || 0);
  const detail = `缩放 ${scale}%，可用区域 ${width}×${height}。`;
  if (width < 1280 || height < 700) return item("display", label, "warn", detail + "屏幕可用区域偏小，微信窗口可能放不下。", "把显示缩放调小（如 100% 或 125%），或换更大的屏幕。");
  if (![100, 125, 150].includes(scale)) return item("display", label, "warn", detail + "这个缩放比例还没有验证过，微信自动操作可能点不准。", "在 Windows 设置 → 显示 里把缩放改成 100%、125% 或 150%。");
  return item("display", label, "ok", detail);
}

function aiItem(gateway) {
  const label = "AI 服务";
  if (!gateway || gateway.enabled === false) return item("ai", label, "warn", "这个版本没有连接统一 AI 服务。");
  if (!gateway.ready) return item("ai", label, "fail", "AI 服务没连上，文案、评论、称呼识别、视频制作都会失败。", "确认已登录软件、网络通畅，然后重启软件。");
  if (gateway.capabilities && gateway.capabilities.deepseek === false) return item("ai", label, "fail", "账号没有开通文案 AI。", "联系管理员开通。");
  return item("ai", label, "ok", "AI 服务已连接。");
}

function diskItem(freeBytes) {
  const label = "磁盘空间";
  if (!Number.isFinite(freeBytes)) return item("disk", label, "warn", "没能读出剩余空间。");
  const detail = `软件所在磁盘剩余 ${(freeBytes / GB).toFixed(1)} GB。`;
  if (freeBytes < 2 * GB) return item("disk", label, "fail", detail + "空间不够，视频制作和更新会失败。", "清理磁盘，至少留出 10 GB。");
  if (freeBytes < 10 * GB) return item("disk", label, "warn", detail + "空间偏少，做视频时可能不够。", "清理磁盘，建议留出 10 GB 以上。");
  return item("disk", label, "ok", detail);
}

function createEnvironmentCheckup({ rootDir, logger, getDisplay = () => null, gatewayStatus = () => null, findBrowser = () => "",
  wechat = probeWechat, freeBytes = (dir) => { const stat = fs.statfsSync(path.parse(path.resolve(dir)).root); return stat.bavail * stat.bsize; },
  totalMemory = os.totalmem, release = os.release, now = Date.now }) {
  const file = path.join(rootDir, "checkup", "last.json");
  const last = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
  let running = null;

  async function check() {
    const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
    const memoryGb = Number(totalMemory()) / GB;
    const major = Number(String(release()).split(".")[0]);
    const items = [
      wechatItem(await safe(wechat, { error: "probe_failed" })),
      displayItem(await safe(getDisplay, null)),
      aiItem(await safe(gatewayStatus, null)),
      (await safe(findBrowser, "")) ? item("browser", "Chrome 浏览器", "ok", "已找到 Chrome 或 Edge。")
        : item("browser", "Chrome 浏览器", "warn", "没有找到 Chrome 或 Edge，养号和一键分发用不了。", "安装 Google Chrome。"),
      diskItem(await safe(() => freeBytes(rootDir), NaN)),
      memoryGb >= 4 ? item("memory", "内存", "ok", `内存 ${memoryGb.toFixed(0)} GB。`)
        : item("memory", "内存", "warn", `内存 ${memoryGb.toFixed(1)} GB，做视频和同时跑多个任务时可能很慢。`, "建议 8 GB 以上内存。"),
      major >= 10 ? item("system", "Windows 系统", "ok", `Windows ${major === 10 ? "10/11" : major}（${release()}）。`)
        : item("system", "Windows 系统", "fail", `系统版本 ${release()} 太旧。`, "请使用 Windows 10 或 11。")
    ];
    const result = { at: new Date(now()).toISOString(), items, problems: items.filter((entry) => entry.status !== "ok").length };
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeJsonAtomic(file, result); } catch { /* The result is still shown. */ }
    const worst = items.find((entry) => entry.status === "fail") || items.find((entry) => entry.status === "warn");
    if (worst) {
      try {
        logger?.event?.("checkup", "checkup_problems", { items: items.map(({ id, status, detail }) => ({ id, status, detail })) },
          { level: "error", code: `checkup_${worst.id}_${worst.status}` });
      } catch { /* Reporting never changes the result. */ }
    }
    return result;
  }

  return {
    last,
    run: () => (running ||= check().finally(() => { running = null; }))
  };
}

module.exports = { createEnvironmentCheckup, wechatItem, displayItem, aiItem, diskItem, VERIFIED_WECHAT };
