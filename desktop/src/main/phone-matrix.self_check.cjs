const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPhoneMatrix, findAdb, parseDevices, parseBattery, parseSize } = require("./phone-matrix.cjs");

// 手机矩阵 part 1 (user project of 2026-10-30): reading the hub's phones through ADB.
assert.deepEqual(parseDevices(`List of devices attached
A7JC9X2922W03486       device usb:1-1 product:KOZ-AL40 model:KOZ_AL40 device:HWKOZ transport_id:4
ABXL6R1601009700       unauthorized usb:1-2 transport_id:7

`), [
  { serial: "A7JC9X2922W03486", state: "device", model: "KOZ AL40", transport: "4", usb: "1-1" },
  { serial: "ABXL6R1601009700", state: "unauthorized", model: "", transport: "7", usb: "1-2" }
]);
assert.deepEqual(parseBattery("Current Battery Service state:\n  AC powered: false\n  status: 2\n  level: 30\n"), { battery: 30, charging: true });
assert.deepEqual(parseSize("Physical size: 1080x2340\nOverride size: 720x1560"), { width: 720, height: 1560 });
assert.equal(findAdb({ env: { XIAOXI_ADB_PATH: "C:\\x\\adb.exe" }, resourcesPath: "" }, (file) => file === "C:\\x\\adb.exe"), "C:\\x\\adb.exe");
assert.equal(findAdb({ env: {}, resourcesPath: "" }, () => false), "");

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-matrix-"));
  let list = "List of devices attached\nP1 device model:Mi_10 transport_id:1\nP2 unauthorized transport_id:2\n";
  const shell = { "getprop ro.product.brand; getprop ro.product.model; getprop ro.build.version.release": "Xiaomi\nMi 10\n13\n", "dumpsys battery": "  level: 76\n  status: 3\n", "wm size": "Physical size: 1080x2340" };
  const calls = [];
  const run = async (_file, args) => { calls.push(args.join(" ")); return args[0] === "devices" ? list : shell[args[3]] ?? ""; };
  const updates = [];
  const make = () => createPhoneMatrix({ dataDir, adbPath: "adb.exe", run, isLaixiRunning: () => false, onChange: (state) => updates.push(state), setTimer: () => null, clearTimer: () => {} });
  let matrix = make();
  await matrix.poll();
  let state = matrix.snapshot();
  assert.equal(state.devices.length, 2);
  const [p1, p2] = state.devices;
  assert.deepEqual({ number: p1.number, name: p1.name, model: p1.model, android: p1.android, battery: p1.battery, charging: p1.charging, screen: p1.screen },
    { number: 1, name: "Mi 10", model: "Mi 10", android: "13", battery: 76, charging: false, screen: { width: 1080, height: 2340 } });
  assert.equal(p2.state, "unauthorized"); assert.equal(p2.number, null, "没授权的手机还不编号");
  assert.ok(!calls.some((call) => call.startsWith("-s P2")), "没授权的手机不去读详情");
  // 授权后自动编号，名字、编号、分组、备注都能改，保存在本机，重开还在。
  list = "List of devices attached\nP1 device model:Mi_10 transport_id:1\nP2 device model:Redmi_9 transport_id:2\n";
  await matrix.poll();
  assert.equal(matrix.snapshot().devices.find((d) => d.serial === "P2").number, 2);
  matrix.update("P2", { name: "抖音 2 号", number: 12, group: "抖音组", note: "主号" });
  assert.throws(() => matrix.update("P2", { number: 0 }), { code: "PHONE_NUMBER_INVALID" });
  assert.throws(() => matrix.update("NOPE", { name: "x" }), { code: "PHONE_NOT_FOUND" });
  matrix = make();
  state = matrix.snapshot();
  const p2Saved = state.devices.find((d) => d.serial === "P2");
  assert.deepEqual([p2Saved.name, p2Saved.number, p2Saved.group, p2Saved.note, p2Saved.state], ["抖音 2 号", 12, "抖音组", "主号", "disconnected"]);
  assert.deepEqual(state.groups, ["抖音组"]);
  // 拔掉的手机才能移除。
  list = "List of devices attached\nP1 device transport_id:1\n";
  await matrix.poll();
  assert.throws(() => matrix.forget("P1"), { code: "PHONE_STILL_CONNECTED" });
  assert.equal(matrix.forget("P2").devices.some((d) => d.serial === "P2"), false);
  // 没有 ADB、来喜在运行：都告诉用户。
  const none = createPhoneMatrix({ dataDir, adbPath: "", run, isLaixiRunning: () => true, setTimer: () => null, clearTimer: () => {} });
  await none.poll();
  assert.equal(none.snapshot().adb, false); assert.match(none.snapshot().error, /ADB/); assert.equal(none.snapshot().laixiRunning, true);
  console.log("phone matrix self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
