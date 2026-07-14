const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const handlers = new Map();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-contact-sync-ipc-"));
const dataDir = path.join(root, "contact_sync");
const parentRoot = path.join(root, "微信数据");
const validRoot = path.join(parentRoot, "xwechat_files");
const invalidRoot = path.join(root, "empty", "xwechat_files");
const autoRoot = path.join(root, "自动识别", "xwechat_files");
let dialogSelection = parentRoot;
let executorFailure = false;
let autoDetectionEmpty = false;
let autoExecutableEmpty = false;

fs.mkdirSync(validRoot, { recursive: true });
fs.mkdirSync(invalidRoot, { recursive: true });

function fakeSpawn(_command, args) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (executorFailure) {
      child.stdout.emit("data", Buffer.from(JSON.stringify({ ok: false, action: "status", error: "executor failed", contacts: [] })));
      child.emit("close", 1);
      return;
    }
    const rootIndex = args.indexOf("--wechat-root");
    const selectedRoot = rootIndex >= 0 ? args[rootIndex + 1] : autoDetectionEmpty ? "" : autoRoot;
    const acceptedRoot = selectedRoot === invalidRoot ? "" : selectedRoot === parentRoot ? validRoot : selectedRoot;
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      ok: true,
      action: "status",
      state: {
        wechat_exe_path: autoExecutableEmpty ? "" : "E:\\Program Files\\Tencent\\Weixin\\Weixin.exe",
        wechat_root: acceptedRoot
      },
      contacts: []
    })));
    child.emit("close", 0);
  });
  return child;
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getAppPath: () => root },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [dialogSelection] }) },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
    };
  }
  if (request === "node:child_process") return { spawn: fakeSpawn };
  return originalLoad.call(this, request, parent, isMain);
};

const modulePath = path.join(__dirname, "contact-sync-ipc.cjs");
delete require.cache[require.resolve(modulePath)];
const { registerContactSyncIpc } = require(modulePath);
Module._load = originalLoad;

registerContactSyncIpc({ dataDir });

(async () => {
  const chooseRoot = handlers.get("contact-sync:choose-wechat-root");
  const autoDetect = handlers.get("contact-sync:auto-detect-paths");

  const selected = await chooseRoot();
  assert.equal(selected.state.wechat_root, validRoot);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "wechat-paths.json"), "utf8")).wechatRoot, validRoot, "selecting the parent must persist its xwechat_files child");

  dialogSelection = invalidRoot;
  const rejected = await chooseRoot();
  assert.equal(rejected.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "wechat-paths.json"), "utf8")).wechatRoot, validRoot, "an invalid manual directory must not replace the last valid setting");

  executorFailure = true;
  const failedSelection = await chooseRoot();
  assert.equal(failedSelection.error, "executor failed", "manual validation must preserve executor errors");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "wechat-paths.json"), "utf8")).wechatRoot, validRoot);

  const failedAutoDetect = await autoDetect();
  assert.equal(failedAutoDetect.error, "executor failed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "wechat-paths.json"), "utf8")).wechatRoot, validRoot, "failed auto-detection must preserve the last valid setting");

  executorFailure = false;
  autoDetectionEmpty = true;
  const emptyAutoDetect = await autoDetect();
  assert.equal(emptyAutoDetect.ok, false);
  assert.match(emptyAutoDetect.error, /未自动识别到微信数据目录/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "wechat-paths.json"), "utf8")).wechatRoot, validRoot, "an empty auto-detection result must preserve the last valid setting");

  autoDetectionEmpty = false;
  autoExecutableEmpty = true;
  const detectedWithoutExecutable = await autoDetect();
  assert.equal(detectedWithoutExecutable.state.wechat_root, autoRoot);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "wechat-paths.json"), "utf8")).wechatExePath, "E:\\Program Files\\Tencent\\Weixin\\Weixin.exe", "auto-detection must not erase a previously configured executable when WeChat is closed");

  autoExecutableEmpty = false;
  const detected = await autoDetect();
  assert.equal(detected.state.wechat_root, autoRoot);
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, "wechat-paths.json"), "utf8"));
  assert.equal(settings.wechatRoot, autoRoot);
  assert.equal(settings.wechatExePath, "E:\\Program Files\\Tencent\\Weixin\\Weixin.exe");

  console.log("contact-sync IPC self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
