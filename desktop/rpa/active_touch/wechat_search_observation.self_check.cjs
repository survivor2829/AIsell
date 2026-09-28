const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { openWechatSearchResult, openWechatSearchResultAsync, discardSearchCapture, runPowerShell } = require("./wechat_window_driver.cjs");
const { searchObservationEvidence } = require("./wechat_search_result_resolver.cjs");

{
  const fs = require("node:fs");
  const path = require("node:path");
  for (const cli of ["active_touch_cli.cjs", "active_touch_cli.dev.cjs"]) {
    assert.match(fs.readFileSync(path.join(__dirname, cli), "utf8"), /captureSearchFailure: args\.includes\("--capture-search-failure"\)/u,
      `${cli} must require the workflow's explicit screenshot request`);
  }
  assert.match(fs.readFileSync(path.join(__dirname, "../../src/main/touch-workflow.cjs"), "utf8"),
    /command === "click-search-result-dry-run" \? \["--capture-search-failure"\]/u,
    "only the passport-owning workflow may request a transient search screenshot");
}

{
  const observation = { captureSource: "formula_crop", cropBounds: { left: 0, top: 0, right: 100, bottom: 100 },
    visualCandidates: [{ text: "甲乙", left: 10, top: 20, right: 30, bottom: 30 },
      { text: "甲乙丙", left: 10, top: 40, right: 40, bottom: 60 }] };
  const evidence = searchObservationEvidence(observation, { query: "甲乙", queryType: "name" });
  assert.equal(evidence.capture_source, "formula_fallback");
  assert.equal(evidence.bottom_gap, 40, "bottom gap uses the bottom edge of the last OCR row");
  assert.deepEqual(evidence.ocr_boxes.map((box) => box.equals_query), [true, false]);
  assert.equal(evidence.ocr_boxes[0].first_class, "han");
  assert.equal(evidence.ocr_boxes[0].char_count, 2);
  const otherNames = searchObservationEvidence({ ...observation, visualCandidates: [
    { ...observation.visualCandidates[0], text: "丁戊" }, { ...observation.visualCandidates[1], text: "丁戊己" }
  ] }, { query: "丁戊", queryType: "name" });
  assert.equal(evidence.candidate_set_hash, otherNames.candidate_set_hash,
    "candidate fingerprint must depend on shape rather than raw contact text");
}

async function checkWrongConversationTitleGate() {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { selectCustomer, calibrate, clickSearchResultDryRun, loadState, saveState } = require("./state_machine.cjs");
  const { executeVerifiedContactSend } = require("./state_machine.dev.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-t10b-title-"));
  let clicks = 0;
  let sends = 0;
  const expected = "甲乙";
  const opened = "甲乙丙";
  const driverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.dev.cjs"), "utf8");
  const scriptStart = driverSource.indexOf("const OBSERVE_CONVERSATION_SCRIPT = `");
  const scriptEnd = driverSource.indexOf("`;", scriptStart);
  assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "the production send-path verifier must be replayable");
  const observationScript = driverSource.slice(scriptStart, scriptEnd);
  let titleLoop = observationScript.slice(observationScript.indexOf("function Get-ObservedElementText"), observationScript.indexOf('$titleToken = ""'));
  titleLoop = titleLoop.replace("[System.Windows.Automation.AutomationElement]$element", "$element")
    .replace("[System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition", "1, 2");
  function replayProductionObservation(expectedName, elements) {
    const fixture = Buffer.from(JSON.stringify({ expected: expectedName, elements }), "utf8").toString("base64");
    const replay = `$ErrorActionPreference='Stop'\n$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8\nAdd-Type -AssemblyName UIAutomationClient\n`
      + `$fixture=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')))\n`
      + `$expectedConversation=[string]$fixture.expected; $windowRect=[pscustomobject]@{Left=0.0;Top=0.0;Right=1000.0;Bottom=700.0;Width=1000.0;Height=700.0}\n`
      + `$script:items=@(foreach($e in $fixture.elements){ $o=[pscustomobject]@{Current=[pscustomobject]@{Name=[string]$e.name;IsOffscreen=$false;BoundingRectangle=[pscustomobject]@{Left=[double]$e.left;Top=[double]$e.top}}}; $o | Add-Member ScriptMethod GetCurrentPattern { param($p) return $null }; $o })\n`
      + `$all=[pscustomobject]@{Count=$script:items.Count}; $all | Add-Member ScriptMethod Item { param($i) return $script:items[$i] }\n`
      + `$root=[pscustomobject]@{}; $root | Add-Member ScriptMethod FindAll { param($a,$b) return $all }\n`
      + titleLoop + `\n@{titleVisible=$titleVisible} | ConvertTo-Json -Compress`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(replay, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout.trim().replace(/^\uFEFF/u, "")).titleVisible;
  }
  const header = (name) => ({ name, left: 400, top: 60 });
  assert.equal(replayProductionObservation(expected, [header(expected)]), true, "the send-path observer must accept the exact header");
  assert.equal(replayProductionObservation("Abc", [header("abc")]), false,
    "the send-path observer must reject a Latin title with different letter case");
  const wrongHeaders = [
    [header(opened)],
    [header(opened), { name: expected, left: 120, top: 80 }],
    [header(opened), { name: expected, left: 500, top: 300 }]
  ];
  for (const elements of wrongHeaders) assert.equal(replayProductionObservation(expected, elements), false,
    "a longer active title must be rejected even when the session list or chat body contains the expected name");
  const mismatchedTitle = { ok: false, reason: "atomic_conversation_changed", title: "" };
  try {
    fs.writeFileSync(path.join(root, "contacts.json"), JSON.stringify([
      { id: "target", name: expected, wechatId: "wxid_fixture", wechatAccountId: "account", allowed: true }
    ]));
    const observation = {
      uiaCandidates: [], visualCandidates: [
        { text: "联系人", left: 40, top: 100, right: 90, bottom: 120, x: 65, y: 110 },
        { text: expected, left: 100, top: 140, right: 180, bottom: 160, x: 140, y: 150 },
        { text: opened, left: 100, top: 168, right: 180, bottom: 188, x: 140, y: 178 }
      ],
      webSearchCandidates: [{ text: "搜索网络结果", left: 62, top: 245, right: 150, bottom: 265, x: 106, y: 255,
        words: [..."搜索网络结果"].map((text, index) => ({ text, left: 62 + index * 12, right: 74 + index * 12 })) }],
      webSearchTop: 245, cropBounds: { left: 0, top: 0, right: 400, bottom: 400 },
      popupBounds: { left: 0, top: 0, right: 400, bottom: 400 }, popupDpi: 96,
      popupCandidateCount: 1, captureSource: "popup", ocrOk: true, webSearchVisible: true
    };
    let activeElements = wrongHeaders[0];
    let openedTitle = opened;
    const sendOptions = { baseDir: root, contactsDir: root,
      contactId: "target", message: "test", authorized: true,
      windowPreflight: async () => ({ ok: true, normalized: true, layoutMode: "stable_target",
        focused: true, pid: 81, hWnd: "91", processName: "Weixin" }),
      runStep(command, args) {
        if (command === "select-customer") return selectCustomer(root, "target");
        if (command === "calibrate") return calibrate(root);
        if (command === "click-search-result-dry-run") {
          return clickSearchResultDryRun(root, (query, context) => openWechatSearchResult(query, {
            ...context,
            runner: () => ({ ok: true, title: openedTitle, processName: "Weixin", pid: 81, hWnd: "91",
              inputLeaseTick: 101, searchResultObservation: query === "wxid_fixture"
                ? { uiaCandidates: [], visualCandidates: [], webSearchCandidates: observation.webSearchCandidates,
                  webSearchTop: 245, cropBounds: observation.cropBounds, captureSource: "formula_crop", ocrOk: true, webSearchVisible: true }
                : observation }),
            clickRunner: () => { clicks += 1; return { ok: true, exactSearchOpened: true }; }
          }), undefined, undefined, { pid: 81, hWnd: "91" });
        }
        if (command === "input-message-dry-run") {
          return require("./state_machine.cjs").inputMessageDryRun(root, "test", () => ({ ok: true,
            draftVerified: true, draftPoint: { xRatio: 0.5, yRatio: 0.5 } }));
        }
        if (command === "send") return require("./state_machine.cjs").send(root, { dryRun: true, message: "test" });
        throw new Error(`unexpected step ${command}`);
      },
      sessionDriver: async (name) => replayProductionObservation(name, activeElements)
        ? { ok: true, title: name, pid: 81, hWnd: "91", processName: "Weixin",
          accountVerified: true, accountId: "account", conversationToken: "conversation:v2:81:91:title:fixture",
          verificationMode: "conversation_title" }
        : mismatchedTitle,
      bubbleVerifier: async () => ({ ok: true, snapshot: [] }),
      sendDriver: async () => { sends += 1; return { ok: false, sendAttempted: false }; }
    };
    const result = await executeVerifiedContactSend(sendOptions);
    assert.equal(clicks, 1, `the ambiguous local surface must reach the click path: ${JSON.stringify(result)}`);
    assert.equal(loadState(root).conversation_title, opened, "the opened conversation must be the longer name");
    assert.equal(loadState(root).search_evidence.resolver_mode, "unique_local_surface_visual");
    const evidence = JSON.stringify(loadState(root).search_evidence);
    for (const line of [expected, opened, "搜索网络结果"]) {
      assert.equal(evidence.includes(line), false, "persisted evidence must omit the query and every OCR line");
      assert.equal(evidence.includes(require("node:crypto").createHash("sha256").update(line).digest("hex")), false,
        "persisted evidence must omit hashes of raw OCR lines");
    }
    assert.equal(loadState(root).search_evidence.ocr_observation.ocr_boxes.length, 4);
    assert.equal(result.ok, false, "the pre-send title gate must reject the longer name");
    assert.equal(sends, 0, "a wrong conversation must never reach the send driver");
    for (const elements of wrongHeaders.slice(1)) {
      activeElements = elements;
      const blocked = await executeVerifiedContactSend(sendOptions);
      assert.equal(blocked.ok, false, "session list and chat text cannot authorize a longer active title");
      assert.equal(sends, 0, "each wrong-title variant must stop before send");
    }
    activeElements = [header(expected)];
    openedTitle = expected;
    const accepted = await executeVerifiedContactSend(sendOptions);
    assert.equal(clicks, 4, "the exact-title control must traverse the same click and send path");
    assert.equal(sends, 1, `an exact active title must reach sendDriver: ${JSON.stringify(accepted)}`);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9caRcAAAAASUVORK5CYII=", "base64");
    const rejected = openWechatSearchResult(expected, { pid: 81, hWnd: "91", captureSearchFailure: true,
      searchIdentity: { expectedName: expected },
      runner: () => ({ ok: true, searchCapturePng: png.toString("base64"),
        searchResultObservation: { ...observation, webSearchCandidates: [], webSearchTop: null,
          popupBounds: null, popupDpi: null, captureSource: "formula_crop" } })
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.searchEvidence.capture_source, "formula_fallback");
    assert.equal(Object.prototype.hasOwnProperty.call(rejected, "searchCapturePng"), false,
      "capture bytes must not enter the ordinary result");
    const capture = rejected.diagnostics.search_capture_file;
    assert.deepEqual(fs.readFileSync(capture), png, "the detached capture must be the OCR bitmap bytes");
    fs.unlinkSync(capture);
    const noCapture = openWechatSearchResult(expected, { pid: 81, hWnd: "91",
      searchIdentity: { expectedName: expected },
      runner: () => ({ ok: true, searchCapturePng: png.toString("base64"),
        searchResultObservation: { ...observation, webSearchCandidates: [], webSearchTop: null } })
    });
    assert.equal(noCapture.diagnostics.search_capture_file, undefined,
      "default search callers, including auto reply and development IPC, must not write a transient screenshot");
    const noCaptureAsync = await openWechatSearchResultAsync(expected, { pid: 81, hWnd: "91",
      searchIdentity: { expectedName: expected },
      runner: async () => ({ ok: true, searchCapturePng: png.toString("base64"),
        searchResultObservation: { ...observation, webSearchCandidates: [], webSearchTop: null } })
    });
    assert.equal(noCaptureAsync.diagnostics.search_capture_file, undefined);
    const captureNames = () => new Set(fs.readdirSync(os.tmpdir()).filter((name) => /^xiaoxi-search-capture-[a-f0-9]{32}\.png$/u.test(name)));
    const beforeSelected = captureNames();
    try {
      const selectedWithCapture = openWechatSearchResult(expected, { pid: 81, hWnd: "91", captureSearchFailure: true,
        searchIdentity: { expectedName: expected },
        runner: () => ({ ok: true, pid: 81, hWnd: "91", inputLeaseTick: 101,
          searchCapturePng: png.toString("base64"), searchResultObservation: observation }),
        clickRunner: () => ({ ok: true, exactSearchOpened: true })
      });
      assert.equal(selectedWithCapture.ok, true);
      assert.equal(selectedWithCapture.diagnostics?.search_capture_file, undefined,
        "a selected contact must not create a transient screenshot");
      assert.deepEqual([...captureNames()].filter((name) => !beforeSelected.has(name)), [],
        "selected resolutions must not leave a PNG in the temp directory");
    } finally {
      for (const name of captureNames()) if (!beforeSelected.has(name)) fs.unlinkSync(path.join(os.tmpdir(), name));
    }
    const first = path.join(os.tmpdir(), `xiaoxi-search-capture-${require("node:crypto").randomBytes(16).toString("hex")}.png`);
    const second = path.join(os.tmpdir(), `xiaoxi-search-capture-${require("node:crypto").randomBytes(16).toString("hex")}.png`);
    fs.writeFileSync(first, png); fs.writeFileSync(second, png);
    try {
      const state = loadState(root);
      saveState(root, { ...state, target_selected: true,
        selected_customer: { ...state.selected_customer, wechatId: "wxid_fixture" } });
      let calls = 0;
      const fallback = clickSearchResultDryRun(root, () => ({ ok: false,
        reason: "exact_search_result_not_found", diagnostics: { search_capture_file: ++calls === 1 ? first : second } }));
      assert.equal(calls, 2, "WeChat ID not found must fall back to a name search");
      assert.equal(fs.existsSync(first), false, "the superseded ID-search screenshot must be removed before fallback");
      assert.equal(fallback.diagnostics.search_capture_file, second);
      discardSearchCapture(fallback);
      assert.equal(fs.existsSync(second), false, "the final screenshot owner must remove its capture");
    } finally { for (const file of [first, second]) { try { fs.unlinkSync(file); } catch {} } }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Replay the generated PowerShell OCR processing, not preclassified resolver fixtures.
// No window lookup, screenshot, keyboard input, or real click runs in this check.
if (process.platform === "win32") {
  const largeOutput = runPowerShell('$data="A" * 1600000; @{ok=$true; data=$data} | ConvertTo-Json -Compress', {}, { ensure: false });
  assert.equal(largeOutput.ok, true, "a large OCR screenshot must not exhaust the PowerShell stdout buffer");
  assert.equal(largeOutput.data.length, 1600000);
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

  const popupStartInObservation = productionSearchScript.indexOf("      $popup = Find-SearchPopup");
  const bitmapStart = productionSearchScript.indexOf("      $bitmap = [System.Drawing.Bitmap]::new", popupStartInObservation);
  const screenCopy = productionSearchScript.indexOf("$graphics.CopyFromScreen", bitmapStart);
  const captureSave = productionSearchScript.indexOf("$bitmap.Save($captureStream", screenCopy);
  const ocrRecognize = productionSearchScript.indexOf("$engine.RecognizeAsync($software)", captureSave);
  assert.ok(screenCopy > bitmapStart && captureSave > screenCopy && ocrRecognize > captureSave,
    "the passport image must be copied from the same bitmap before OCR");
  const ocrLoopStart = productionSearchScript.indexOf("      foreach ($line in $ocrResult.Lines)", bitmapStart);
  const observationEnd = productionSearchScript.indexOf("\n  exit", ocrLoopStart);
  assert.ok(popupStartInObservation > 0 && bitmapStart > popupStartInObservation
    && ocrLoopStart > bitmapStart && observationEnd > ocrLoopStart,
  "the production popup, OCR and output path must be replayed together");
  const replayBody = productionSearchScript.slice(popupStartInObservation, bitmapStart)
    + "      $ocrResult = ConvertFrom-Json $fixtureJson\n"
    + productionSearchScript.slice(ocrLoopStart, observationEnd);
  const characterWords = (value, x, y) => [...value].map((character, index) => ({
    Text: character, BoundingRect: { X: x + index * 30, Y: y, Width: 30, Height: 42 }
  }));
  const fixtureJson = JSON.stringify({ Lines: [{ Text: "微信号：offline123", Words: characterWords("微信号：offline123", 150, 90) }] });
  for (const found of [true, false]) {
    const replay = `$ErrorActionPreference='Stop'\n$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8\n`
      + `$query='offline123'; $ocrScale=3; $script:inputLeaseTick=1; $script:searchPopupCandidateCount=0\n`
      + `$matched=@{title='offline';focused=$true;processName='Weixin';pid=11;hWnd=22;x=200;y=100;width=800;height=600}\n`
      + `$uiaCandidates=New-Object System.Collections.Generic.List[object]\n$visualCandidates=New-Object System.Collections.Generic.List[object]\n`
      + `$webSearchCandidates=New-Object System.Collections.Generic.List[object]\n$webSearchTop=$null;$webSearchVisible=$false;$ocrOk=$false\n`
      + `$cropBounds=$null;$popupBounds=$null;$popupDpi=$null;$captureSource='formula_crop'\n`
      + `$compactQuery='offline123';$networkSearchPattern=@('搜索网络结果','搜一搜')\n`
      + `$fixtureJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fixtureJson, "utf8").toString("base64")}'))\n`
      + `function Assert-ExactSearchForeground {}\n`
      + `function Find-SearchPopup { $script:searchPopupCandidateCount=${found ? 1 : 0}; ${found
        ? "return @{left=300;top=200;right=700;bottom=550;dpi=120}" : "return $null"} }\n`
      + `if ($true) { if ($uiaCandidates.Count -eq 0) { try {\n${replayBody}\n}\n`;
    const replayed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(replay, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(replayed.status, 0, replayed.stderr || replayed.error?.message);
    const observation = JSON.parse(replayed.stdout.trim().replace(/^\uFEFF/u, "")).searchResultObservation;
    assert.equal(observation.captureSource, found ? "popup" : "formula_crop");
    assert.deepEqual(observation.popupBounds, found ? { left: 300, top: 200, right: 700, bottom: 550 } : null);
    assert.equal(observation.popupDpi, found ? 120 : null);
    assert.equal(observation.popupCandidateCount, found ? 1 : 0);
    assert.equal(observation.visualCandidates[0].words[0].left, found ? 350 : 308,
      "production OCR word coordinates must use the chosen popup or formula crop origin");
    assert.equal(observation.ocrOk, true);
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
  [DllImport("user32.dll", EntryPoint="GetDpiForWindow")] private static extern uint NativeDpi(IntPtr hWnd);
  [DllImport("user32.dll", EntryPoint="GetWindowThreadProcessId")] private static extern uint NativePid(IntPtr hWnd, ref uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern ushort RegisterClass(ref WNDCLASS value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr CreateWindowEx(uint ex, string cls, string title,
    uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr DefWindowProc(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  private static readonly WindowProc Procedure = DefWindowProc;
  public static IntPtr ForeignWindow;
  public static IntPtr MainWindow, PopupWindow;
  public static uint MainDpiOverride=96, PopupDpiOverride=144;
  public static uint GetDpiForWindow(IntPtr hWnd) {
    if(hWnd==MainWindow) return MainDpiOverride;
    if(hWnd==PopupWindow) return PopupDpiOverride;
    return NativeDpi(hWnd);
  }
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
[Win32WechatWindowSearch]::MainWindow=$main
[Win32WechatWindowSearch]::PopupWindow=$valid
$one=Find-SearchPopup; $oneCount=$script:searchPopupCandidateCount
[Win32WechatWindowSearch]::PopupDpiOverride=0
[Win32WechatWindowSearch]::MainDpiOverride=120
$lowDpi=Find-SearchPopup
[Win32WechatWindowSearch]::PopupDpiOverride=144
[Win32WechatWindowSearch]::MainDpiOverride=96
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
$edgeCounts=@{}
foreach($spec in @(
  @{name='class';cls='STATIC';x=230;y=210;w=300;h=250;visible=$true},
  @{name='hidden';cls='QtTestQWindowToolSaveBits';x=230;y=210;w=300;h=250;visible=$false},
  @{name='width';cls='QtTestQWindowToolSaveBits';x=230;y=210;w=119;h=250;visible=$true},
  @{name='height';cls='QtTestQWindowToolSaveBits';x=230;y=210;w=300;h=99;visible=$true},
  @{name='left_before';cls='QtTestQWindowToolSaveBits';x=199;y=210;w=300;h=250;visible=$true},
  @{name='left_after';cls='QtTestQWindowToolSaveBits';x=441;y=210;w=300;h=250;visible=$true},
  @{name='right_after';cls='QtTestQWindowToolSaveBits';x=250;y=210;w=751;h=250;visible=$true},
  @{name='top_before';cls='QtTestQWindowToolSaveBits';x=230;y=139;w=300;h=250;visible=$true},
  @{name='top_after';cls='QtTestQWindowToolSaveBits';x=230;y=341;w=300;h=250;visible=$true},
  @{name='bottom_after';cls='QtTestQWindowToolSaveBits';x=230;y=300;w=300;h=401;visible=$true}
)) {
  $edge=[Win32WechatWindowSearch]::Create($spec.cls,$spec.x,$spec.y,$spec.w,$spec.h,$spec.visible)
  $choice=Find-SearchPopup
  $edgeCounts[$spec.name]=@{ count=$script:searchPopupCandidateCount; kept=($choice -ne $null -and [int64]$choice.hWnd -eq $valid.ToInt64()) }
  [void][Win32WechatWindowSearch]::DestroyWindow($edge)
}
@{ one=($one -ne $null); oneCount=$oneCount; multiple=($multiple -eq $null); multipleCount=$multipleCount;
  foreign=($foreignChoice -ne $null); foreignCount=$foreignCount;
  filtered=($filtered -ne $null); filteredCount=$filteredCount; dpi=[int]$filtered.dpi;
  mainDpi=[int][Win32WechatWindowSearch]::GetDpiForWindow($main); lowDpi=[int]$lowDpi.dpi;
  nativeDpi=[int][Win32WechatWindowSearch]::GetDpiForWindow($valid); edges=$edgeCounts } | ConvertTo-Json -Compress -Depth 5
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
  assert.equal(popupChecks.dpi, popupChecks.nativeDpi, "popup DPI must come from the chosen window");
  assert.equal(popupChecks.mainDpi, 96);
  assert.equal(popupChecks.dpi, 144, "different popup and main-window DPI must use the popup");
  assert.equal(popupChecks.lowDpi, 120, "low popup DPI must fall back to the main-window DPI");
  for (const [name, observed] of Object.entries(popupChecks.edges)) {
    assert.deepEqual(observed, { count: 1, kept: true }, `${name} must not add another eligible popup`);
  }

  console.log("search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)");
} else {
  console.log("search observation PowerShell replay skipped: Windows required");
}
let observationFinished = false;
checkWrongConversationTitleGate().then(async () => {
  console.log("search title send gate passed: longer title sends=0, exact title sends=1");
  const chain = spawnSync(process.execPath, [require("node:path").join(__dirname, "wechat_search_capture_chain.self_check.cjs")],
    { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(chain.status, 0, chain.stderr || chain.error?.message);
  assert.match(chain.stdout, /search capture chain passed:/u,
    "the chain subprocess must finish its assertions before observation passes");
  process.stdout.write(chain.stdout);
  observationFinished = true;
})
  .catch((error) => { console.error(error); process.exitCode = 1; });
process.on("beforeExit", () => {
  if (process.exitCode !== 1) assert.equal(observationFinished, true, "search observation chain must finish before process exit");
});
