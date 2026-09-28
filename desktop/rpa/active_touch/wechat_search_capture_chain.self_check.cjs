const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-capture-chain-temp-"));
const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
process.env.TEMP = sandbox;
process.env.TMP = sandbox;
assert.equal(path.resolve(os.tmpdir()), path.resolve(sandbox), "capture checks require an isolated TEMP");

const driverPath = require.resolve("./wechat_window_driver.cjs");
const driver = require(driverPath);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9caRcAAAAASUVORK5CYII=", "base64");
const observation = {
  uiaCandidates: [], visualCandidates: [
    { text: "甲乙", left: 100, top: 140, right: 180, bottom: 160, x: 140, y: 150 },
    { text: "甲乙丙", left: 100, top: 168, right: 180, bottom: 188, x: 140, y: 178 }
  ], webSearchCandidates: [], webSearchTop: null,
  cropBounds: { left: 0, top: 0, right: 400, bottom: 400 }, captureSource: "formula_crop", ocrOk: true, webSearchVisible: false
};
const captures = () => fs.readdirSync(sandbox).filter((name) => /^xiaoxi-search-capture-[a-f0-9]{32}\.png$/u.test(name));
let onSearch = () => {};
let captureFlags = [];
require.cache[driverPath].exports = { ...driver,
  openWechatSearchResult: (query, context) => driver.openWechatSearchResult(query, {
    ...context,
    runner: () => {
      captureFlags.push(context.captureSearchFailure === true);
      onSearch();
      return { ok: true, pid: 81, hWnd: "91", processName: "Weixin", inputLeaseTick: 101,
        searchCapturePng: png.toString("base64"), searchResultObservation: observation };
    }
  })
};
const cli = require("./active_touch_cli.cjs");
const { executeVerifiedContactSend } = require("./state_machine.dev.cjs");
const { createTouchWorkflow } = require("../../src/main/touch-workflow.cjs");

async function runScenario(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-capture-chain-"));
  const contact = { id: "target", name: "甲乙", wechatId: "wxid_fixture", wechatAccountId: "account", allowed: true };
  const failures = [];
  let clock = Date.now();
  let enabled = true;
  let searches = 0;
  const originalRename = fs.renameSync;
  captureFlags = [];
  onSearch = () => {
    searches += 1;
    if (kind === "pause") enabled = false;
    if (kind === "exception") {
      const original = fs.appendFileSync;
      fs.appendFileSync = (...args) => {
        fs.appendFileSync = original;
        throw Object.assign(new Error("ENOSPC injected"), { code: "ENOSPC" });
      };
    }
    if (kind === "save_exception") fs.renameSync = () => {
      throw Object.assign(new Error("ENOSPC save injected"), { code: "ENOSPC" });
    };
  };
  try {
    fs.writeFileSync(path.join(root, "contacts.json"), JSON.stringify([contact]));
    const workflow = createTouchWorkflow({ dataDir: root, readContacts: () => [contact], now: () => new Date(clock),
      coordinator: { acquire: () => ({ ok: true, lock: { owner: "fixture" } }), release() {}, update: () => ({ ok: true }) },
      passport: { bindTrace() {}, recordEvent() {}, recordFailure: (_module, _id, failure) => failures.push(failure), writeRunBill() {} },
      execute: (options) => executeVerifiedContactSend({ ...options,
        windowPreflight: async () => ({ ok: true, normalized: true, layoutMode: "stable_target", focused: true,
          pid: 81, hWnd: "91", processName: "Weixin" }),
        sessionDriver: async () => ({ ok: false, reason: "atomic_conversation_changed" }),
        sendDriver: async () => { throw new Error("unexpected send"); }
      }),
      runStep: async (argv, options) => {
        try { return cli.main(["node", "cli", ...argv, "--data-dir", options.dataDir]); }
        catch (error) {
          fs.renameSync = originalRename;
          return { ok: false, action: argv[0], blocked_reason: "executor_no_result", error: error.message };
        }
      }
    });
    const record = { id: `capture-${kind}`, payload: workflow.prepareWorkflowTask({ script: "您好", contactIds: [contact.id] }) };
    let result;
    for (let attempt = 0; attempt < (kind === "normal" ? 5 : 1); attempt += 1) {
      clock += 60 * 60 * 1000;
      result = await workflow.runWorkflowStep(record, { isEnabled: () => enabled });
      if (["completed", "needs_attention"].includes(result.status) || !enabled) break;
    }
    assert.ok(searches > 0, `${kind}: the real CLI must reach the search driver`);
    assert.ok(captureFlags.every(Boolean), `${kind}: the workflow flag must survive CLI and state_machine`);
    assert.deepEqual(captures(), [], `${kind}: no search screenshot may remain in isolated TEMP`);
    if (kind === "normal") {
      assert.equal(failures.some((failure) => failure.stage === "search_identity"
        && Buffer.isBuffer(failure.screenshotBytes) && failure.screenshotBytes.equals(png)), true,
      "the executor must return its capture path and the workflow must attach the OCR bytes");
    }
    if (kind === "pause") assert.equal(enabled, false);
    if (["exception", "save_exception"].includes(kind)) assert.equal(result.reasonCode, "executor_no_result");
  } finally {
    onSearch = () => {};
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function checkFallbackBlockException() {
  const { selectCustomer, clickSearchResultDryRun } = require("./state_machine.cjs");
  const root = fs.mkdtempSync(path.join(sandbox, "fallback-block-"));
  const contact = { id: "target", name: "甲乙", wechatId: "wxid_fixture", allowed: true };
  const first = path.join(sandbox, `xiaoxi-search-capture-${crypto.randomBytes(16).toString("hex")}.png`);
  const second = path.join(sandbox, `xiaoxi-search-capture-${crypto.randomBytes(16).toString("hex")}.png`);
  const originalAppend = fs.appendFileSync;
  let searches = 0;
  try {
    fs.writeFileSync(path.join(root, "contacts.json"), JSON.stringify([contact]));
    selectCustomer(root, contact.id);
    assert.throws(() => clickSearchResultDryRun(root, (query) => {
      searches += 1;
      const capture = searches === 1 ? first : second;
      fs.writeFileSync(capture, png);
      if (searches === 2) fs.appendFileSync = () => { throw new Error("block log failed"); };
      return { ok: false, reason: searches === 1 ? "exact_search_result_not_found" : "search_result_identity_unverified",
        diagnostics: { search_capture_file: capture } };
    }, undefined, undefined, { captureSearchFailure: true }), /block log failed/u);
    assert.equal(searches, 2, "the exception must follow the WeChat ID to name fallback");
    assert.equal(fs.existsSync(first), false, "the first search capture must be discarded before fallback");
    assert.equal(fs.existsSync(second), false, "finally must discard the fallback capture");
  } finally {
    fs.appendFileSync = originalAppend;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run() {
  await runScenario("normal");
  await runScenario("pause");
  await runScenario("exception");
  await runScenario("save_exception");
  checkFallbackBlockException();
  const { cleanupStaleSearchCaptures } = driver;
  const hour = 60 * 60 * 1000;
  const sweepNow = Date.now();
  const hex = () => crypto.randomBytes(16).toString("hex");
  const own = () => `xiaoxi-search-capture-${hex()}.png`;
  const fixture = (name, ageHours) => {
    const file = path.join(sandbox, name);
    fs.writeFileSync(file, png);
    fs.utimesSync(file, new Date(sweepNow - ageHours * hour), new Date(sweepNow - ageHours * hour));
    return file;
  };
  const old = fixture(own(), 48);
  const recent = fixture(own(), 23.99);
  const future = fixture(own(), -1);
  const nearMissHex = hex();
  const nearMisses = [
    `xiaoxi-search-capture-${nearMissHex.toUpperCase()}.png`,
    `xiaoxi-search-capture-${nearMissHex.slice(1)}.png`,
    `xiaoxi-search-capture-${nearMissHex}0.png`,
    `xiaoxi-search-capture-${nearMissHex}.PNG`,
    `xiaoxi-search-capture-${nearMissHex}.png.tmp`,
    `xiaoxi-search-capture-${nearMissHex}.jpg`,
    `other-xiaoxi-search-capture-${nearMissHex}.png`
  ].map((name) => fixture(name, 48));
  const nested = path.join(sandbox, "nested");
  fs.mkdirSync(nested);
  const nestedCapture = path.join(nested, own());
  fs.writeFileSync(nestedCapture, png);
  fs.utimesSync(nestedCapture, new Date(sweepNow - 48 * hour), new Date(sweepNow - 48 * hour));
  const linkTarget = path.join(nested, "target.png");
  fs.writeFileSync(linkTarget, png);
  fs.utimesSync(linkTarget, new Date(sweepNow - 48 * hour), new Date(sweepNow - 48 * hour));
  const link = path.join(sandbox, own());
  fs.symlinkSync(linkTarget, link, "file");
  try {
    cleanupStaleSearchCaptures(sweepNow);
    assert.equal(fs.existsSync(old), false, "a workflow step must sweep stale owned captures");
    for (const file of [recent, future, nestedCapture, linkTarget, link, ...nearMisses]) {
      assert.equal(fs.existsSync(file), true, `the sweep must preserve ${path.basename(file)}`);
    }
    const secondsOld = fixture(own(), 90 / 3600);
    cleanupStaleSearchCaptures(sweepNow);
    assert.equal(fs.existsSync(secondsOld), true, "24h threshold must use milliseconds, not seconds");
  } finally {
    fs.rmSync(link, { force: true });
  }
  console.log("search capture chain passed: CLI flag, passport bytes, pause, fallback/save/log exceptions and sandboxed stale cleanup");
}

if (require.main === module) {
  let chainFinished = false;
  const cleanup = () => {
    if (originalTemp === undefined) delete process.env.TEMP; else process.env.TEMP = originalTemp;
    if (originalTmp === undefined) delete process.env.TMP; else process.env.TMP = originalTmp;
    fs.rmSync(sandbox, { recursive: true, force: true });
  };
  run().then(() => { chainFinished = true; }).catch((error) => { console.error(error); process.exitCode = 1; }).finally(cleanup);
  process.on("beforeExit", () => {
    if (!chainFinished) cleanup();
    if (process.exitCode !== 1) assert.equal(chainFinished, true, "capture chain must finish before process exit");
  });
}
module.exports = { run };
