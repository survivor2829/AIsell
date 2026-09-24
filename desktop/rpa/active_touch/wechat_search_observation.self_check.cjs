const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { openWechatSearchResult } = require("./wechat_window_driver.cjs");

// Replay the generated PowerShell OCR processing, not preclassified resolver fixtures.
// No window lookup, screenshot, keyboard input, or real click runs in this check.
if (process.platform === "win32") {
  let productionSearchScript = "";
  for (const networkText of ["〕 搜 一 搜 sams_01", "搜 一 搜 sam_01"]) {
    let clicks = 0;
    let clickedX = 0;
    const result = openWechatSearchResult("sams_01", {
      pid: 11,
      hWnd: "22",
      searchIdentity: { expectedName: "测试客户" },
      runner(script) {
        productionSearchScript = script;
        const initialization = script.split(/\r?\n/u).filter((line) =>
          line.startsWith("$compactQuery =") || line.startsWith("$networkSearchPattern =") || line.startsWith("$ocrScale =")
        ).join("\n");
        const start = script.indexOf("      foreach ($line in $ocrResult.Lines)");
        const end = script.indexOf("      $ocrOk = $true", start);
        assert.equal(initialization.split("\n").length, 3, "production OCR must upscale small WeChat search text");
        assert.ok(start >= 0 && end > start, "production OCR processing must be replayed");
        const characterWords = (value, x, y, width, height) => [...value.replace(/\s+/gu, "")].map((character, index, all) => ({
          Text: character, BoundingRect: { X: x + index * width / all.length, Y: y,
            Width: width / all.length, Height: height }
        }));
        const fixture = Buffer.from(JSON.stringify({ Lines: [
          { Text: "微信号：sams_01", Words: characterWords("微信号：sams_01", 68, 156, 360, 48) },
          { Text: networkText, Words: characterWords(networkText, 60, 304, 380, 52) }
        ] }), "utf8").toString("base64");
        const replay = `
$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
$query = "sams_01"
${initialization}
$ocrResult = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${fixture}")))
$cropLeft = 58; $cropTop = 72
$visualCandidates = New-Object System.Collections.Generic.List[object]
$webSearchCandidates = New-Object System.Collections.Generic.List[object]
$webSearchTop = $null; $webSearchVisible = $false
${script.slice(start, end)}
@{ compactQuery=$compactQuery; searchResultObservation=@{
  uiaCandidates=@(); visualCandidates=$visualCandidates.ToArray()
  webSearchCandidates=$webSearchCandidates.ToArray(); webSearchTop=$webSearchTop
  webSearchVisible=$webSearchVisible; ocrOk=$true
  cropBounds=@{ left=58; top=72; right=430; bottom=490 }
} } | ConvertTo-Json -Compress -Depth 6
`;
        const replayed = spawnSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(replay, "utf16le").toString("base64")
        ], { encoding: "utf8", windowsHide: true, timeout: 10000 });
        assert.equal(replayed.status, 0, replayed.stderr || replayed.error?.message);
        const observation = JSON.parse(replayed.stdout.trim().replace(/^\uFEFF/u, ""));
        assert.equal(observation.compactQuery, "sams_01", "normalization must preserve the letter s");
        const words = observation.searchResultObservation.visualCandidates[0].words;
        assert.equal(words.length, [..."微信号：sams_01"].length);
        assert.equal(words[0].text, "微");
        assert.equal(words[0].left, 92);
        assert.equal(words.at(-1).right, 272, "each OCR word must use the production crop origin and scale");
        return { ok: true, pid: 11, hWnd: "22", inputLeaseTick: 101, ...observation };
      },
      clickRunner(_script, env) {
        clicks += 1;
        clickedX = Number(env.XIAOXI_SEARCH_RESULT_X);
        return { ok: true, exactSearchOpened: true };
      }
    });
    assert.equal(result.ok, true, "an exact local WeChat ID row must not depend on OCR of the lower network-search boundary");
    assert.equal(result.searchResultMode, "exact_wechat_id_visual");
    assert.equal(clicks, 1);
    assert.equal(clickedX, 182, "upscaled OCR coordinates must map back to the original screen point");
  }

  let relaxedIdentityClicks = 0;
  let searchResultClickScript = "";
  const relaxedIdentityResult = openWechatSearchResult("sams_l01", {
    pid: 11,
    hWnd: "22",
    searchIdentity: { expectedName: "测试客户" },
    runner() {
      return {
        ok: true,
        processName: "Weixin",
        pid: 11,
        hWnd: "22",
        inputLeaseTick: 101,
        searchResultObservation: {
          uiaCandidates: [],
          visualCandidates: [{ text: "微信号：sams_I01", left: 92, top: 118, right: 250, bottom: 142, x: 171, y: 130 }],
          webSearchCandidates: [{ text: "搜索网络结果", left: 88, top: 180, right: 220, bottom: 204, x: 154, y: 192 }],
          webSearchTop: 180,
          cropBounds: { left: 58, top: 72, right: 430, bottom: 490 },
          ocrOk: true,
          webSearchVisible: true
        }
      };
    },
    clickRunner(script) {
      relaxedIdentityClicks += 1;
      searchResultClickScript = script;
      return { ok: true, exactSearchOpened: true };
    }
  });
  assert.equal(relaxedIdentityResult.ok, true, "one local result must remain clickable when OCR misreads its identity text");
  assert.equal(relaxedIdentityResult.searchResultMode, "unique_local_visual");
  assert.equal(relaxedIdentityClicks, 1);

  let unreadableIdentityClicks = 0;
  const unreadableIdentityResult = openWechatSearchResult("wakeup2829", {
    pid: 11,
    hWnd: "22",
    searchIdentity: { expectedName: "A测试客户" },
    runner() {
      return {
        ok: true,
        processName: "Weixin",
        pid: 11,
        hWnd: "22",
        inputLeaseTick: 101,
        searchResultObservation: {
          uiaCandidates: [],
          visualCandidates: [
            { text: "A测试客尸", left: 92, top: 112, right: 210, bottom: 134, x: 151, y: 123 },
            { text: "微倍亏：wakcup282g", left: 92, top: 138, right: 270, bottom: 158, x: 181, y: 148 }
          ],
          webSearchCandidates: [{ text: "搜索网络结果", left: 88, top: 180, right: 220, bottom: 204, x: 154, y: 192 }],
          webSearchTop: 180,
          cropBounds: { left: 58, top: 72, right: 430, bottom: 490 },
          ocrOk: true,
          webSearchVisible: true
        }
      };
    },
    clickRunner() {
      unreadableIdentityClicks += 1;
      return { ok: true, exactSearchOpened: true };
    }
  });
  assert.equal(unreadableIdentityResult.ok, true, "one compact local result must remain clickable when all identity text is misread");
  assert.equal(unreadableIdentityResult.searchResultMode, "unique_local_surface_visual");
  assert.equal(unreadableIdentityClicks, 1);

  let liveLayoutClicks = 0;
  const liveLayoutResult = openWechatSearchResult("wakeup2829", {
    pid: 11,
    hWnd: "22",
    searchIdentity: { expectedName: "A测试客户" },
    runner() {
      return {
        ok: true,
        processName: "Weixin",
        pid: 11,
        hWnd: "22",
        inputLeaseTick: 101,
        searchResultObservation: {
          uiaCandidates: [],
          visualCandidates: [
            { text: "最 常 便 用", left: 114, top: 104, right: 173, bottom: 117, x: 144, y: 110 },
            { text: "A 测 试 客 户", left: 168, top: 146, right: 250, bottom: 164, x: 209, y: 155 },
            { text: "微 信 号 : wakeup2829", left: 169, top: 178, right: 312, bottom: 194, x: 240, y: 186 },
            { text: "群 聊", left: 114, top: 224, right: 144, bottom: 237, x: 129, y: 230 },
            { text: "包含 : A测试客户 ( 微信号 : wakeup2829 )", left: 169, top: 298, right: 426, bottom: 314, x: 297, y: 306 },
            { text: "〕 搜 索 网 络 结 果", left: 114, top: 344, right: 236, bottom: 358, x: 175, y: 350 }
          ],
          webSearchCandidates: [],
          webSearchTop: null,
          cropBounds: { left: 58, top: 85, right: 488, bottom: 505 },
          ocrOk: true,
          webSearchVisible: false
        }
      };
    },
    clickRunner() {
      liveLayoutClicks += 1;
      return { ok: true, exactSearchOpened: true };
    }
  });
  assert.equal(liveLayoutResult.ok, true, "an exact local WeChat ID row must be clicked even when unrelated search sections contain extra text");
  assert.equal(liveLayoutResult.searchResultMode, "exact_wechat_id_visual");
  assert.equal(liveLayoutClicks, 1);

  const guardStart = searchResultClickScript.indexOf("function Test-SearchResultClickTarget");
  const guardEnd = searchResultClickScript.indexOf("\n}", guardStart) + 2;
  assert.ok(guardStart >= 0 && guardEnd > guardStart, "production click guard must expose its owned-popup decision");
  const clickGuardReplay = `${searchResultClickScript.slice(guardStart, guardEnd)}
@{
  sameProcessPopup = Test-SearchResultClickTarget 33 11 11
  foreignProcess = Test-SearchResultClickTarget 33 12 11
  missingWindow = Test-SearchResultClickTarget 0 11 11
} | ConvertTo-Json -Compress
`;
  const clickGuardResult = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(clickGuardReplay, "utf16le").toString("base64")
  ], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(clickGuardResult.status, 0, clickGuardResult.stderr || clickGuardResult.error?.message);
  assert.deepEqual(JSON.parse(clickGuardResult.stdout.trim().replace(/^\uFEFF/u, "")), {
    missingWindow: false,
    sameProcessPopup: true,
    foreignProcess: false
  });

  const popupStart = productionSearchScript.indexOf("function Find-SearchPopup {");
  const popupEnd = productionSearchScript.indexOf("\n$matched = $null", popupStart);
  assert.ok(popupStart > 0 && popupEnd > popupStart, "production popup finder must be replayable");
  const popupReplay = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatWindowSearch {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr data);
  public delegate IntPtr WindowProc(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct WNDCLASS {
    public uint style; public WindowProc lpfnWndProc; public int cbClsExtra, cbWndExtra;
    public IntPtr hInstance, hIcon, hCursor, hbrBackground;
    public string lpszMenuName, lpszClassName;
  }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, ref RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int capacity);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll", EntryPoint="GetWindowThreadProcessId")] private static extern uint NativePid(IntPtr hWnd, ref uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern ushort RegisterClass(ref WNDCLASS value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr CreateWindowEx(uint ex, string cls, string title,
    uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr DefWindowProc(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  private static readonly WindowProc Procedure = DefWindowProc;
  public static IntPtr ForeignWindow;
  public static uint GetWindowThreadProcessId(IntPtr hWnd, ref uint pid) {
    uint result=NativePid(hWnd,ref pid); if(hWnd==ForeignWindow) pid+=1; return result;
  }
  static Win32WechatWindowSearch() {
    var cls=new WNDCLASS { lpfnWndProc=Procedure, lpszClassName="QtTestQWindowToolSaveBits" };
    if(RegisterClass(ref cls)==0) throw new Exception("register_popup_class_failed");
  }
  public static IntPtr Create(string cls, int x, int y, int width, int height, bool visible) {
    uint style=0x80000000u | (visible ? 0x10000000u : 0u);
    IntPtr handle=CreateWindowEx(0x08000000u, cls, "", style, x,y,width,height,
      IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    if(handle==IntPtr.Zero) throw new Exception("create_test_window_failed: "+cls);
    return handle;
  }
}
"@
${productionSearchScript.slice(popupStart, popupEnd)}
$main=[Win32WechatWindowSearch]::Create('STATIC',200,100,800,600,$true)
$matched=@{ hWnd=$main.ToInt64(); pid=$PID; x=200; y=100; width=800; height=600 }
$valid=[Win32WechatWindowSearch]::Create('QtTestQWindowToolSaveBits',220,200,300,250,$true)
$one=Find-SearchPopup; $oneCount=$script:searchPopupCandidateCount
$second=[Win32WechatWindowSearch]::Create('QtTestQWindowToolSaveBits',230,210,300,250,$true)
$multiple=Find-SearchPopup; $multipleCount=$script:searchPopupCandidateCount
[void][Win32WechatWindowSearch]::DestroyWindow($second)
$foreign=[Win32WechatWindowSearch]::Create('QtTestQWindowToolSaveBits',230,210,300,250,$true)
[Win32WechatWindowSearch]::ForeignWindow=$foreign
$foreignChoice=Find-SearchPopup; $foreignCount=$script:searchPopupCandidateCount
$hidden=[Win32WechatWindowSearch]::Create('QtTestQWindowToolSaveBits',230,210,300,250,$false)
$small=[Win32WechatWindowSearch]::Create('QtTestQWindowToolSaveBits',230,210,80,80,$true)
$above=[Win32WechatWindowSearch]::Create('QtTestQWindowToolSaveBits',230,110,300,250,$true)
$wrongClass=[Win32WechatWindowSearch]::Create('STATIC',230,210,300,250,$true)
$filtered=Find-SearchPopup; $filteredCount=$script:searchPopupCandidateCount
@{ one=($one -ne $null); oneCount=$oneCount; multiple=($multiple -eq $null); multipleCount=$multipleCount;
  foreign=($foreignChoice -ne $null); foreignCount=$foreignCount;
  filtered=($filtered -ne $null); filteredCount=$filteredCount; dpi=[int]$filtered.dpi } | ConvertTo-Json -Compress
`;
  const popupResult = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(popupReplay, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(popupResult.status, 0, popupResult.stderr || popupResult.error?.message);
  const popupChecks = JSON.parse(popupResult.stdout.trim().replace(/^\uFEFF/u, ""));
  assert.equal(popupChecks.one, true);
  assert.equal(popupChecks.oneCount, 1);
  assert.equal(popupChecks.multiple, true, "multiple eligible popups must disable popup recognition");
  assert.equal(popupChecks.multipleCount, 2);
  assert.equal(popupChecks.foreign, true);
  assert.equal(popupChecks.foreignCount, 1);
  assert.equal(popupChecks.filtered, true, "hidden, small, misplaced, or wrong-class windows must be ignored");
  assert.equal(popupChecks.filteredCount, 1);
  assert.ok(popupChecks.dpi >= 72);

  console.log("search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)");
} else {
  console.log("search observation PowerShell replay skipped: Windows required");
}
