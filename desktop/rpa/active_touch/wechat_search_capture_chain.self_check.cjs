const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
const captures = () => new Set(fs.readdirSync(os.tmpdir()).filter((name) => /^xiaoxi-search-capture-[a-f0-9]{32}\.png$/u.test(name)));
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
  const before = captures();
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
    assert.deepEqual([...captures()].filter((name) => !before.has(name)), [], `${kind}: no search screenshot may remain in TEMP`);
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
    for (const name of captures()) if (!before.has(name)) fs.unlinkSync(path.join(os.tmpdir(), name));
  }
}

async function run() {
  await runScenario("normal");
  await runScenario("pause");
  await runScenario("exception");
  await runScenario("save_exception");
  const oldName = `xiaoxi-search-capture-${require("node:crypto").randomBytes(16).toString("hex")}.png`;
  const old = path.join(os.tmpdir(), oldName);
  const similar = path.join(os.tmpdir(), `xiaoxi-search-capture-${oldName.slice(22)}.txt`);
  fs.writeFileSync(old, png);
  fs.writeFileSync(similar, png);
  fs.utimesSync(old, new Date(Date.now() - 48 * 60 * 60 * 1000), new Date(Date.now() - 48 * 60 * 60 * 1000));
  try {
    await runScenario("pause");
    assert.equal(fs.existsSync(old), false, "a workflow step must sweep stale owned captures");
    assert.equal(fs.existsSync(similar), true, "the sweep must not touch similar names");
  } finally {
    for (const file of [old, similar]) { try { fs.unlinkSync(file); } catch {} }
  }
  console.log("search capture chain passed: CLI flag, passport bytes, pause, save/log exceptions and stale cleanup");
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
