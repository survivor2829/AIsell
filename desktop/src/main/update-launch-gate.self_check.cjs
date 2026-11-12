const assert = require("node:assert/strict");
const { createLaunchGate } = require("./update-launch-gate.cjs");
const { diskFullMessage } = require("./cloud-maintenance.cjs");

// The customer is told which drive and how much to clear: need rounded up, free space down.
assert.equal(diskFullMessage({ code: "component_disk_space_insufficient", drive: "C:\\", requiredBytes: 1.71 * 1024 ** 3, availableBytes: 0.29 * 1024 ** 3 }),
  "C盘空间不足：这次更新需要约 1.8 GB，现在只剩 0.2 GB。请清理C盘后重新打开软件，会自动更新到最新版。故障编号：disk_space_insufficient");
assert.match(diskFullMessage({ code: "ENOSPC" }), /^磁盘空间不足。请清理磁盘后/u);
// The install-time backup check (update-storage checkCopySpace) names its volume by path.
assert.match(diskFullMessage({ code: "update_disk_space_insufficient", path: "C:\\Users\\a\\AppData", requiredBytes: 3 * 1024 ** 3, availableBytes: 1 * 1024 ** 3 }), /^C盘空间不足：这次更新需要约 3\.0 GB，现在只剩 1\.0 GB/u);

// A controller whose check() walks through scripted outcomes, like cloud-maintenance does.
function fakeController(outcomes, initial = {}) {
  let view = { enabled: true, canInstall: true, updateFailure: "", stage: "idle", nextVersion: "", error: "", updateRequested: false, ...initial };
  const listeners = new Set();
  const notify = patch => { view = { ...view, ...patch }; for (const listener of [...listeners]) listener({ ...view }); };
  let checks = 0;
  return {
    get checks() { return checks; },
    status: () => ({ ...view }),
    onUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify,
    check() {
      if (view.stage === "checking" || view.updateRequested) return Promise.resolve(view);
      checks += 1;
      notify({ stage: "checking", error: "" });
      const outcome = outcomes.shift() || { stage: "current" };
      if (outcome.hang) return new Promise(() => {});
      return new Promise(resolve => setImmediate(() => { notify(outcome); resolve({ ...view }); }));
    }
  };
}

function harness(controller, { request } = {}) {
  const holds = [], phases = [], opened = [], sleeps = [], waits = [];
  const gate = createLaunchGate({
    controller,
    request: request || (async () => controller.status()),
    setHold: value => holds.push(value),
    onOpen: (reason, wait) => { opened.push(reason); waits.push(wait); },
    publish: state => phases.push(state.phase),
    checkTimeoutMs: 30,
    sleep: async ms => { sleeps.push(ms); }
  });
  return { gate, holds, phases, opened, sleeps, waits };
}

(async () => {
  // 1. 没有新版：检查完直接进入；检查期间业务保持暂停
  {
    const controller = fakeController([{ stage: "current" }]);
    const run = harness(controller);
    const result = await run.gate.start();
    assert.equal(result.phase, "open"); assert.deepEqual(run.opened, ["current"]);
    // Evidence for slow updates: how long the customer waited and how many attempts failed first.
    assert.equal(run.waits[0].attempts, 0); assert.ok(Number.isFinite(run.waits[0].elapsedMs) && run.waits[0].elapsedMs >= 0);
    assert.deepEqual(run.holds, [true, false], "business work is held until the gate opens");
  }

  // 2. 有新版：准备好就立即安装，不放行（安装后程序会重启）
  {
    const controller = fakeController([{ stage: "ready", nextVersion: "1.2.14" }]);
    let requested = 0;
    const run = harness(controller, { request: async () => { requested += 1; controller.notify({ updateRequested: true, stage: "waiting" }); return controller.status(); } });
    const pending = run.gate.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(requested, 1);
    assert.equal(run.gate.status().phase, "installing");
    assert.deepEqual(run.opened, [], "a ready update can never be skipped");
    assert.deepEqual(run.holds, [true]);
    void pending;
  }

  // 3. 下载失败、断网：自动重试，间隔逐渐拉长（最长 60 秒），直到准备好再安装
  {
    const failures = Array.from({ length: 8 }, () => ({ stage: "error", nextVersion: "1.2.14", error: "更新检查或下载失败，已保留下载进度，请稍后重试。" }));
    const controller = fakeController([...failures, { stage: "ready", nextVersion: "1.2.14" }]);
    let requested = 0;
    const run = harness(controller, { request: async () => { requested += 1; controller.notify({ updateRequested: true, stage: "waiting" }); return controller.status(); } });
    void run.gate.start();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(controller.checks, 9);
    assert.deepEqual(run.sleeps, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    assert.equal(requested, 1); assert.deepEqual(run.opened, []);
  }

  // 4. 安装助手没能启动：回到重试，不放行
  {
    const controller = fakeController([{ stage: "ready", nextVersion: "1.2.14" }, { stage: "ready", nextVersion: "1.2.14" }]);
    let requested = 0;
    const run = harness(controller, { request: async () => {
      requested += 1;
      controller.notify({ updateRequested: true, stage: "waiting" });
      if (requested === 1) setImmediate(() => controller.notify({ updateRequested: false, stage: "error", error: "安装助手未就绪" }));
      return controller.status();
    } });
    void run.gate.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(requested, 2); assert.deepEqual(run.opened, []);
  }

  // 5. 放行：连不上服务器、首次检查超时、上次更新失败已回滚、不能自动安装、新版还没准备好
  for (const [label, controller, reason] of [
    ["offline", fakeController([{ stage: "error", error: "更新检查或下载失败" }]), "offline"],
    ["slow server", fakeController([{ hang: true }]), "offline"],
    ["rolled back", fakeController([], { updateFailure: "新版上次未能完成启动，已恢复上一版本。" }), "rolled_back"],
    ["not installable", fakeController([], { canInstall: false }), "unsupported"],
    ["full package pending", fakeController([{ stage: "error", error: "新版正在准备，请稍后重试。故障编号：full_upgrade_required" }]), "not_ready"],
    ["license blocked", fakeController([{ stage: "blocked", nextVersion: "1.2.14" }]), "blocked"],
    // 程序文件被杀毒软件删除：重试永远补不回来，放行并提示重新安装，而不是无限重试
    ["base file missing", fakeController([{ stage: "error", nextVersion: "1.2.60", error: "软件程序文件不完整（缺少：d3dcompiler_47.dll）。故障编号：component_base_file_missing" }]), "base_damaged"],
    ["base file damaged", fakeController([{ stage: "error", nextVersion: "1.2.60", error: "软件程序文件不完整。故障编号：component_base_file_damaged" }]), "base_damaged"],
    // C 盘满（现场 2026-11-12）：重试腾不出空间，放行并说明要清多少
    ["disk full", fakeController([{ stage: "error", nextVersion: "1.3.0", error: diskFullMessage({ code: "component_disk_space_insufficient", drive: "C:\\", requiredBytes: 1.8 * 1024 ** 3, availableBytes: 0.3 * 1024 ** 3 }) }]), "disk_full"],
    ["disk full mid-write", fakeController([{ stage: "error", nextVersion: "1.3.0", error: diskFullMessage({ code: "ENOSPC" }) }]), "disk_full"]
  ]) {
    const run = harness(controller);
    await run.gate.start();
    assert.deepEqual(run.opened, [reason], label);
    assert.equal(run.holds.at(-1) ?? false, false, `${label}: the hold is released`);
  }
  // 下载好了、安装时备份空间不够：再检查只会回到 ready 再失败一次，直接放行并提示要清多少
  {
    const controller = fakeController([{ stage: "ready", nextVersion: "1.3.0" }, { stage: "ready", nextVersion: "1.3.0" }]);
    let requested = 0;
    const run = harness(controller, { request: async () => {
      requested += 1;
      controller.notify({ stage: "error", error: diskFullMessage({ code: "update_disk_space_insufficient", path: "C:\\x", requiredBytes: 3 * 1024 ** 3, availableBytes: 1024 ** 3 }) });
      return controller.status();
    } });
    await run.gate.start();
    assert.equal(requested, 1, "the install is not repeated");
    assert.deepEqual(run.opened, ["disk_full"]);
  }
  // 已经知道有新版之后再断网，不放行，继续重试
  {
    const controller = fakeController([{ stage: "error", nextVersion: "1.2.14", error: "x" }, { hang: true }]);
    const run = harness(controller);
    void run.gate.start();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(run.opened, [], "a known update keeps retrying even when the network drops");
  }


  // 接入：业务服务创建前就暂停；更新后的首次启动不拦（更新助手在等这一版报告健康）；
  // 闸门先于例行检查启动；朋友圈每日自动化等闸门放行后再开始；健康检查不等闸门。
  {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
    const holdAt = source.indexOf("applyUpdateHold();");
    assert.ok(holdAt > 0 && holdAt < source.indexOf("createContentEngineSidecar({"), "the hold is applied before services are created");
    assert.match(source, /launch: [^;]*!process\.argv\.includes\("--xiaoxi-updated-launch"\)/u);
    assert.ok(source.indexOf("createLaunchGate({") < source.indexOf("cloudMaintenance.start();"), "the gate owns the launch check");
    assert.match(source, /launchGateOpened\.then\(\(\) => momentsCampaignController\?\.initialize\(\)\)/u);
    assert.doesNotMatch(source, /launchGateOpened\)\.then\(\(\) => readyWindow/u, "health never waits for the gate");
    assert.match(source, /setHold: value => \{ updateHolds\.install = value; applyUpdateHold\(\); \}/u, "an install retry cannot release the launch hold");
  }
  console.log("update launch gate self-check passed: install before entry, retry with backoff, bypass only offline/rolled back/unsupported/damaged base");
})().catch(error => { console.error(error); process.exitCode = 1; });
