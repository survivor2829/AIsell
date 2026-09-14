const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { openWechatSearchResult } = require("./wechat_window_driver.cjs");

// Replay the generated PowerShell OCR processing, not preclassified resolver fixtures.
// No window lookup, screenshot, keyboard input, or real click runs in this check.
if (process.platform === "win32") {
  for (const networkText of ["搜 一 搜 sams_01", "搜 一 搜 sam_01"]) {
    let clicks = 0;
    const result = openWechatSearchResult("sams_01", {
      pid: 11,
      hWnd: "22",
      searchIdentity: { expectedName: "测试客户" },
      runner(script) {
        const initialization = script.split(/\r?\n/u).filter((line) =>
          line.startsWith("$compactQuery =") || line.startsWith("$networkSearchPattern =")
        ).join("\n");
        const start = script.indexOf("      foreach ($line in $ocrResult.Lines)");
        const end = script.indexOf("      $ocrOk = $true", start);
        assert.equal(initialization.split("\n").length, 2);
        assert.ok(start >= 0 && end > start, "production OCR processing must be replayed");
        const fixture = Buffer.from(JSON.stringify({ Lines: [
          { Text: "微信号：sams_01", Words: [{ BoundingRect: { X: 34, Y: 78, Width: 180, Height: 24 } }] },
          { Text: networkText, Words: [{ BoundingRect: { X: 30, Y: 152, Width: 190, Height: 26 } }] }
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
        return { ok: true, pid: 11, hWnd: "22", inputLeaseTick: 101, ...observation };
      },
      clickRunner() {
        clicks += 1;
        return { ok: true, exactSearchOpened: true };
      }
    });
    if (networkText === "搜 一 搜 sams_01") {
      assert.equal(result.ok, true, "spaced OCR text must retain a valid network-search boundary");
      assert.equal(result.searchResultMode, "exact_wechat_id_visual");
      assert.equal(clicks, 1);
    } else {
      assert.equal(result.reason, "search_result_identity_unverified", "a different ID must not become a valid boundary");
      assert.equal(clicks, 0);
    }
  }
  console.log("search observation PowerShell replay passed (spaced OCR; wrong ID rejected; no real input)");
} else {
  console.log("search observation PowerShell replay skipped: Windows required");
}
