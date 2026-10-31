const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPhoneDevice, createPhoneTasks, parseUi, findNode, parseFocus } = require("./phone-device.cjs");

// 手机矩阵 automation base (user plan of 2026-10-31).
const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="账号已退出登录" resource-id="" package="com.ss.android.ugc.aweme" clickable="false" enabled="true" bounds="[120,724][600,770]" />
<node index="1" text="我知道了" resource-id="com.ss.android.ugc.aweme:id/ok" content-desc="A &amp; B" clickable="true" enabled="true" bounds="[80,870][640,971]" /></hierarchy>`;
const nodes = parseUi(xml);
assert.equal(nodes.length, 2);
assert.deepEqual([nodes[1].text, nodes[1].id, nodes[1].desc, nodes[1].clickable, nodes[1].x, nodes[1].y], ["我知道了", "ok", "A & B", true, 360, 921]);
assert.equal(findNode(nodes, { text: /退出登录/ }).y, 747);
assert.equal(findNode(nodes, { text: "没有这个" }), null);
assert.equal(findNode(parseUi('<node text="看不见" bounds="[5,5][5,5]" />'), { text: "看不见" }), null, "没有大小的元素点不到");
assert.deepEqual(parseFocus("  mCurrentFocus=Window{2a5 u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}\n"), { pkg: "com.tencent.mm", activity: "com.tencent.mm.ui.LauncherUI", window: "com.tencent.mm" });
assert.equal(parseFocus("  mCurrentFocus=Window{2ca u0 StatusBar}").window, "StatusBar");
assert.equal(parseFocus("  mCurrentFocus=null").pkg, "");

(async () => {
  // A failed dump (a playing video: "could not get idle state") must not read the previous screen.
  const calls = [];
  let dumpWorks = false;
  const adb = async (args, _timeout, as) => {
    calls.push(args.slice(2).join(" "));
    const command = args.slice(2).join(" ");
    if (command.startsWith("shell uiautomator")) return dumpWorks ? "UI hierchary dumped to: /data/local/tmp/xiaoxi_ui.xml" : "ERROR: could not get idle state.";
    if (command.startsWith("exec-out cat")) return xml;
    if (command.startsWith("exec-out screencap")) return as === "buffer" ? Buffer.from("png") : "";
    if (command.includes("dumpsys window")) return "  mCurrentFocus=Window{2ca u0 StatusBar}";
    if (command.includes("monkey -p good")) return "Events injected: 1";
    if (command.includes("monkey")) return "** No activities found to run, monkey aborted.";
    return "";
  };
  const device = createPhoneDevice({ serial: "P1", adb, sleep: async () => {} });
  assert.deepEqual(await device.read(), { ok: false, nodes: [] });
  assert.ok(calls.indexOf("shell rm -f /data/local/tmp/xiaoxi_ui.xml") < calls.findIndex((call) => call.startsWith("shell uiautomator")), "读之前先删旧文件");
  assert.ok(!calls.some((call) => call.startsWith("exec-out cat")), "读失败就不去拿旧内容");
  dumpWorks = true;
  assert.equal((await device.read()).nodes.length, 2);
  assert.equal(await device.isLocked(), true);
  await device.openApp("good.app");
  await assert.rejects(device.openApp("no.app"), /没装/);
  await assert.rejects(device.paste("你好"), /没能发到手机/);
  calls.length = 0;
  assert.equal((await device.tapOn({ text: "我知道了" })).x, 360);
  assert.equal(calls.at(-1), "shell input tap 360 921");
  let clock = 0;
  const waiting = createPhoneDevice({ serial: "P1", adb, sleep: async () => { clock += 1000; }, now: () => clock });
  assert.equal(await waiting.waitFor({ text: "不会出现" }, { timeout: 3000 }), null);
  assert.equal(clock, 3000);

  // Tasks: one per phone, steps with screenshots, stop at the next phone action, errors in words.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-tasks-"));
  const seen = [];
  const tasks = createPhoneTasks({ dir, adb, paste: async () => true, onChange: (state) => seen.push(state), sleep: async () => {} });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = tasks.start("P1", "测试任务", async ({ device: phone, step }) => {
    await step("打开了", { shot: true });
    await gate;
    await phone.tap(1, 1);
    await step("这一步不该到");
  });
  assert.throws(() => tasks.start("P1", "第二个", async () => {}), /还有任务在跑/);
  assert.equal(tasks.isBusy(), true);
  await new Promise((resolve) => setImmediate(resolve));
  while (!tasks.snapshot()[0].steps.length) await new Promise((resolve) => setImmediate(resolve));
  tasks.stop("P1");
  release();
  const stopped = (await first.finished).task;
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.steps.map((item) => item.text), ["打开了"]);
  assert.ok(fs.existsSync(stopped.steps[0].image), "这一步的截图留下来了");
  assert.equal(tasks.isBusy(), false);
  const ok = await tasks.start("P1", "第二个", async () => 42).finished;
  assert.deepEqual([ok.result, ok.task.status], [42, "done"]);
  const words = (await tasks.start("P1", "第三个", async () => { throw Object.assign(new Error("C:\\secret\\path"), { code: "EPERM" }); }).finished).task;
  assert.deepEqual([words.status, words.error], ["failed", "没做成"], "系统报错不直接给用户看");
  const told = (await tasks.start("P1", "第四个", async () => { throw Object.assign(new Error("手机上没装抖音"), { code: "PHONE_APP_MISSING" }); }).finished).task;
  assert.equal(told.error, "手机上没装抖音");
  assert.ok(seen.length > 3);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("phone device self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
