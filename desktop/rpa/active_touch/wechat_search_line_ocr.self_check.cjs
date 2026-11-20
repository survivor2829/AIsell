"use strict";
// The "微信号：…" caption of a search row is read again by the chat-title reader (PP-OCRv4).
// Development machine, 100% scaling, 2026-11-20: Windows' OCR read the caption as "微信.号：×…"
// for two of six real contacts, who were then "not found" exactly like field computer 8a275cd0;
// the reader read all six exactly. This replays the production OCR loop with Windows' bad
// reading and a stand-in reader: a good reading finds the contact, a doubtful reading or no
// reader keeps Windows' reading (and so the old result).
const assert = require("node:assert/strict");
const http = require("node:http");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openWechatSearchResult } = require("./wechat_window_driver.cjs");

const QUERY = "Abc10000000001";
function productionScript() {
  let captured = "";
  openWechatSearchResult(QUERY, { pid: 11, hWnd: "22", searchIdentity: { expectedName: "测试客户" },
    runner(script) { captured = script; return { ok: false, reason: "captured" }; }, clickRunner() { return { ok: false }; } });
  assert.ok(captured.includes("function Read-SearchLineOcr"), "the search script reads captions again");
  return captured;
}
const characterWords = (value, x, y, width, height) => [...value.replace(/\s+/gu, "")].map((character, index, all) => ({
  Text: character, BoundingRect: { X: x + index * width / all.length, Y: y, Width: width / all.length, Height: height }
}));

function replay(script, env, captions = null) {
  const initialization = script.split(/\r?\n/u).filter((line) =>
    line.startsWith("$compactQuery =") || line.startsWith("$networkSearchPattern =") || line.startsWith("$ocrScale =")).join("\n");
  const start = script.indexOf("      foreach ($reading in $ocrReadings)");
  const end = script.indexOf("      $ocrOk = $true", start);
  const functions = script.slice(script.indexOf("function Test-LocalContactSection"), script.indexOf('$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")'));
  assert.ok(start >= 0 && end > start && functions.includes("function Read-SearchLineOcr"));
  // What Windows read on the development machine: a dot inside 微信号 and the first letter as ×.
  // A second contact's caption below it, read right, as in the development-machine dropdowns.
  const windowsCaption = "微信.号：×10000000001", otherCaption = "微信号：Xyz20000000002", networkText = "搜索网络结果";
  const rows = captions || [windowsCaption, otherCaption];
  const fixture = Buffer.from(JSON.stringify({ Lines: [
    ...rows.map((text, index) => ({ Text: text, Words: characterWords(text, 68, 156 + index * 128, 360, 48) })),
    { Text: networkText, Words: characterWords(networkText, 60, 420, 380, 52) }
  ] }), "utf8").toString("base64");
  const source = `
$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$query = "${QUERY}"
${initialization}
$ocrResult = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${fixture}")))
$ocrReadings = @(@{ result=$ocrResult; boundaryOnly=$false })
${functions}
$cropLeft = 58; $cropTop = 72; $cropWidth = 372; $cropHeight = 418
$bitmap = [System.Drawing.Bitmap]::new($cropWidth, $cropHeight)
$visualCandidates = New-Object System.Collections.Generic.List[object]
$webSearchCandidates = New-Object System.Collections.Generic.List[object]
$webSearchTop = $null; $webSearchVisible = $false
${script.slice(start, end)}
@{ searchResultObservation=@{
  uiaCandidates=@(); visualCandidates=$visualCandidates.ToArray()
  webSearchCandidates=$webSearchCandidates.ToArray(); webSearchTop=$webSearchTop
  webSearchVisible=$webSearchVisible; ocrOk=$true; lineOcrIdRows=[int]$script:lineOcrIdRows; lineOcrIdReplaced=[int]$script:lineOcrIdReplaced; lineOcrIdErrors=[int]$script:lineOcrIdErrors; lineOcrIdError=[string]$script:lineOcrIdError
  cropBounds=@{ left=58; top=72; right=430; bottom=490 }
} } | ConvertTo-Json -Compress -Depth 6
`;
  return new Promise((resolve, reject) => {
    // The replayed script is longer than a command line may be: run it from a file (UTF-8 with BOM for Windows PowerShell).
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-search-line-ocr-")), "replay.ps1");
    fs.writeFileSync(file, "\uFEFF" + source, "utf8");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      { encoding: "utf8", windowsHide: true, timeout: 20000, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
        if (error) return reject(new Error(stderr || error.message));
        resolve(JSON.parse(stdout.trim().replace(/^\uFEFF/u, "")));
      });
  });
}

function reader(answers, { delayMs = 0 } = {}) {
  const list = Array.isArray(answers) ? answers : [answers];
  const token = "t".repeat(40);
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ token: request.headers["x-xiaoxi-token"], type: request.headers["content-type"], png: Buffer.concat(chunks).subarray(1, 4).toString("ascii") });
      const answer = list[Math.min(requests.length - 1, list.length - 1)];
      setTimeout(() => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(answer)); }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests,
    env: { XIAOXI_LINE_OCR_URL: `http://127.0.0.1:${server.address().port}/read`, XIAOXI_LINE_OCR_TOKEN: token } })));
}

function decide(observation) {
  let clicks = 0;
  const result = openWechatSearchResult(QUERY, { pid: 11, hWnd: "22", searchIdentity: { expectedName: "测试客户" },
    runner() { return { ok: true, pid: 11, hWnd: "22", inputLeaseTick: 101, ...observation }; },
    clickRunner() { clicks += 1; return { ok: true, exactSearchOpened: true }; } });
  return { result, clicks };
}

(async () => {
  const script = productionScript();
  // A good reading of the caption: the contact is found and clicked once.
  const good = await reader([{ text: "微信号：Abc10000000001", score: 0.97 }, { text: "微信号：Xyz20000000002", score: 0.96 }]);
  try {
    const observation = await replay(script, good.env);
    assert.equal(good.requests.length, 2, "only the captions are read again, not the network label");
    assert.equal(good.requests[0].token, good.env.XIAOXI_LINE_OCR_TOKEN); assert.equal(good.requests[0].png, "PNG");
    const row = observation.searchResultObservation.visualCandidates[0];
    assert.equal(row.text, "微信号:Abc10000000001"); assert.equal(row.lineOcr, true);
    assert.equal(observation.searchResultObservation.lineOcrIdReplaced, 2);
    const { result, clicks } = decide(observation);
    assert.equal(result.searchResultMode, "exact_wechat_id_visual"); assert.equal(result.ok, true, `found with the reader's reading (${result.reason})`); assert.equal(clicks, 1);
  } finally { good.server.close(); }
  // A doubtful reading, a reading that is not a caption, or no reader: Windows' reading stays, as before.
  for (const answer of [{ text: "微信号：Abc10000000001", score: 0.5 }, { text: "清洁机器人", score: 0.99 }]) {
    const doubtful = await reader(answer);
    try {
      const observation = await replay(script, doubtful.env);
      const row = observation.searchResultObservation.visualCandidates[0];
      assert.equal(row.text, "微信.号:×10000000001"); assert.equal(row.lineOcr, undefined);
      assert.equal(observation.searchResultObservation.lineOcrIdRows, 2); assert.equal(observation.searchResultObservation.lineOcrIdReplaced, 0);
    } finally { doubtful.server.close(); }
  }
  const none = await replay(script, { XIAOXI_LINE_OCR_URL: "", XIAOXI_LINE_OCR_TOKEN: "" });
  assert.equal(none.searchResultObservation.visualCandidates[0].text, "微信.号:×10000000001");
  assert.equal(none.searchResultObservation.lineOcrIdRows, 0);
  assert.equal(decide(none).clicks, 0, "without the reader the old result stays");
  // Review of #314: a "网络查找微信号" row Windows cut to "查找微信号" is never read again (it must stay a
  // network row); a caption Windows already read as the query is not overwritten.
  const guarded = await reader({ text: "微信号：Abc10000000001", score: 0.99 });
  try {
    const network = await replay(script, guarded.env, ["查找微信号：Abc10000000001"]);
    assert.equal(guarded.requests.length, 0, "a cut network-lookup row is not read again");
    assert.equal(network.searchResultObservation.visualCandidates[0].text, "查找微信号:Abc10000000001");
    assert.equal(decide(network).clicks, 0, "the network-lookup row is never clicked as a contact");
    const exact = await replay(script, guarded.env, ["微信号：Abc10000000001", "微信号：Xyz20000000002"]);
    assert.equal(guarded.requests.length, 1, "only the caption that is not already the query is read again");
    assert.equal(exact.searchResultObservation.visualCandidates[0].text, "微信号:Abc10000000001");
    assert.equal(exact.searchResultObservation.visualCandidates[0].lineOcr, undefined);
  } finally { guarded.server.close(); }
  // A hung reader costs at most one short wait: no further calls, and the failure is in the evidence.
  const slow = await reader({ text: "微信号：Abc10000000001", score: 0.99 }, { delayMs: 4000 });
  try {
    const started = Date.now();
    const observation = await replay(script, slow.env);
    assert.ok(Date.now() - started < 9000, "the search does not wait for a hung reader");
    assert.equal(slow.requests.length, 1, "no further calls after the first failed");
    assert.equal(observation.searchResultObservation.lineOcrIdErrors, 1);
    assert.match(observation.searchResultObservation.lineOcrIdError, /^[A-Za-z]+$/u);
    assert.equal(observation.searchResultObservation.visualCandidates[0].text, "微信.号:×10000000001");
  } finally { slow.server.close(); }
  console.log("search caption reader passed: good reading finds the contact, doubtful or missing reader keeps Windows' reading, network rows and exact readings untouched, hung reader bounded");
})().catch((error) => { console.error(error); process.exit(1); });
