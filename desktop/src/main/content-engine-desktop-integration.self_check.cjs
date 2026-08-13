const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createContentEngineApi } = require("./preload-api.cjs");

const desktopDir = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(desktopDir, relativePath), "utf8");
}

function assertPreloadContract() {
  const calls = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke: (channel, payload) => {
      calls.push({ channel, payload });
      return Promise.resolve({ ok: true });
    },
    on: (channel, handler) => listeners.set(channel, handler),
    removeListener: (channel, handler) => {
      if (listeners.get(channel) === handler) listeners.delete(channel);
    }
  };
  const api = createContentEngineApi(ipcRenderer);
  assert.deepEqual(Object.keys(api).sort(), [
    "exportPackages",
    "finished",
    "library",
    "mix",
    "onUpdate",
    "publishQueue",
    "restart",
    "settings",
    "status",
    "tasks"
  ]);
  assert.deepEqual(Object.keys(api.library).sort(), [
    "archive",
    "chooseFiles",
    "chooseFolder",
    "list",
    "probe",
    "probePending",
    "reveal",
    "updateRights"
  ]);
  assert.deepEqual(Object.keys(api.tasks).sort(), [
    "cancel",
    "list",
    "pause",
    "resume"
  ]);
  assert.deepEqual(Object.keys(api.finished).sort(), [
    "chooseAndRegister",
    "list",
    "open",
    "reveal"
  ]);
  assert.deepEqual(Object.keys(api.settings).sort(), [
    "chooseCacheDirectory",
    "status",
    "updateCacheLimit"
  ]);
  assert.deepEqual(Object.keys(api.mix).sort(), [
    "calculateCombinations", "createProject", "generateCandidates", "getProject",
    "listCandidates", "listProjects", "reviewCandidate", "updateProject"
  ]);
  assert.deepEqual(Object.keys(api.publishQueue).sort(), ["list", "update"]);
  assert.deepEqual(Object.keys(api.exportPackages).sort(), ["list", "open", "render", "reveal"]);

  api.status();
  api.restart();
  api.library.list({ includeArchived: true, limit: 25, path: "C:\\bad" });
  api.library.chooseFiles({ paths: ["C:\\bad"] });
  api.library.chooseFolder({ recursive: false, path: "C:\\bad" });
  api.library.probe({ assetId: "asset_one", path: "C:\\bad" });
  api.library.probePending({ path: "C:\\bad" });
  api.library.updateRights({
    assetId: "asset_one",
    rightsStatus: "licensed",
    path: "C:\\bad"
  });
  api.library.archive({ assetId: "asset_one", deleteOriginal: true });
  api.library.reveal({ assetId: "asset_one", path: "C:\\bad" });
  api.tasks.list({ status: "paused", limit: 10 });
  api.tasks.pause({ taskId: "task_one", status: "completed" });
  api.tasks.resume({ taskId: "task_one", status: "completed" });
  api.tasks.cancel({ taskId: "task_one", status: "completed" });
  api.finished.list({ limit: 5 });
  api.finished.chooseAndRegister({
    title: "成片",
    taskId: "task_one",
    outputPath: "C:\\bad"
  });
  api.finished.open({ finishedVideoId: "finished_one", path: "C:\\bad" });
  api.finished.reveal({ finishedVideoId: "finished_one", path: "C:\\bad" });
  api.settings.status();
  api.settings.chooseCacheDirectory({ path: "C:\\bad" });
  api.settings.updateCacheLimit({ limitGb: 100, path: "C:\\bad" });
  api.mix.createProject({ name: "Launch", slots: [{ name: "Intro", required: true, assetIds: ["asset_one"], path: "C:\\bad" }], constraints: { allowRepeatedAssets: false } });
  api.mix.updateProject({ projectId: "mix_project_one", name: "Launch 2", path: "C:\\bad" });
  api.mix.getProject({ projectId: "mix_project_one", path: "C:\\bad" });
  api.mix.listProjects({ limit: 12, path: "C:\\bad" });
  api.mix.calculateCombinations({ projectId: "mix_project_one", path: "C:\\bad" });
  api.mix.generateCandidates({ projectId: "mix_project_one", limit: 3, seed: "seven", path: "C:\\bad" });
  api.mix.listCandidates({ projectId: "mix_project_one", reviewStatus: "pending", limit: 4, path: "C:\\bad" });
  api.mix.reviewCandidate({ candidateId: "mix_candidate_one", reviewStatus: "approved", reviewNote: "ready", path: "C:\\bad" });
  api.publishQueue.list({ status: "queued", limit: 8, directory: "C:\\bad" });
  api.publishQueue.update({ queueItemId: "publish_queue_one", status: "processing", errorMessage: "retry", path: "C:\\bad" });
  api.exportPackages.render({ candidateId: "mix_candidate_one", platforms: ["wechat", "douyin"], path: "C:\\bad" });
  api.exportPackages.list({ candidateId: "mix_candidate_one", limit: 9, path: "C:\\bad" });
  api.exportPackages.open({ packageId: "export_package_one", path: "C:\\bad" });
  api.exportPackages.reveal({ packageId: "export_package_one", path: "C:\\bad" });

  assert.deepEqual(calls, [
    { channel: "content-engine:status", payload: undefined },
    { channel: "content-engine:restart", payload: undefined },
    {
      channel: "content-engine:list-assets",
      payload: { includeArchived: true, limit: 25 }
    },
    { channel: "content-engine:choose-files", payload: undefined },
    {
      channel: "content-engine:choose-folder",
      payload: { recursive: false }
    },
    {
      channel: "content-engine:probe-asset",
      payload: { assetId: "asset_one" }
    },
    {
      channel: "content-engine:probe-pending",
      payload: { limit: 10 }
    },
    {
      channel: "content-engine:update-asset-rights",
      payload: { assetId: "asset_one", rightsStatus: "licensed" }
    },
    {
      channel: "content-engine:archive-asset",
      payload: { assetId: "asset_one" }
    },
    {
      channel: "content-engine:reveal-asset",
      payload: { assetId: "asset_one" }
    },
    {
      channel: "content-engine:list-tasks",
      payload: { status: "paused", limit: 10 }
    },
    {
      channel: "content-engine:pause-task",
      payload: { taskId: "task_one" }
    },
    {
      channel: "content-engine:resume-task",
      payload: { taskId: "task_one" }
    },
    {
      channel: "content-engine:cancel-task",
      payload: { taskId: "task_one" }
    },
    {
      channel: "content-engine:list-finished",
      payload: { limit: 5 }
    },
    {
      channel: "content-engine:choose-and-register-finished",
      payload: { title: "成片", taskId: "task_one" }
    },
    {
      channel: "content-engine:open-finished",
      payload: { finishedVideoId: "finished_one" }
    },
    {
      channel: "content-engine:reveal-finished",
      payload: { finishedVideoId: "finished_one" }
    },
    { channel: "content-engine:settings-status", payload: undefined },
    {
      channel: "content-engine:choose-cache-directory",
      payload: undefined
    },
    {
      channel: "content-engine:update-cache-limit",
      payload: { limitGb: 100 }
    },
    {
      channel: "content-engine:create-mix-project",
      payload: { name: "Launch", slots: [{ name: "Intro", required: true, assetIds: ["asset_one"] }], constraints: { allowRepeatedAssets: false } }
    },
    {
      channel: "content-engine:update-mix-project",
      payload: { projectId: "mix_project_one", name: "Launch 2" }
    },
    {
      channel: "content-engine:get-mix-project",
      payload: { projectId: "mix_project_one" }
    },
    {
      channel: "content-engine:list-mix-projects",
      payload: { limit: 12 }
    },
    {
      channel: "content-engine:calculate-mix-combinations",
      payload: { projectId: "mix_project_one" }
    },
    {
      channel: "content-engine:generate-mix-candidates",
      payload: { projectId: "mix_project_one", limit: 3, seed: "seven" }
    },
    {
      channel: "content-engine:list-mix-candidates",
      payload: { projectId: "mix_project_one", reviewStatus: "pending", limit: 4 }
    },
    {
      channel: "content-engine:review-mix-candidate",
      payload: { candidateId: "mix_candidate_one", reviewStatus: "approved", reviewNote: "ready" }
    },
    {
      channel: "content-engine:list-publish-queue",
      payload: { status: "queued", limit: 8 }
    },
    {
      channel: "content-engine:update-publish-queue-item",
      payload: { queueItemId: "publish_queue_one", status: "processing", errorMessage: "retry" }
    },
    {
      channel: "content-engine:render-mix-candidate",
      payload: { candidateId: "mix_candidate_one", platforms: ["wechat", "douyin"] }
    },
    {
      channel: "content-engine:list-export-packages",
      payload: { candidateId: "mix_candidate_one", limit: 9 }
    },
    {
      channel: "content-engine:open-export-package",
      payload: { packageId: "export_package_one" }
    },
    {
      channel: "content-engine:reveal-export-package",
      payload: { packageId: "export_package_one" }
    }
  ]);
  assert.equal(JSON.stringify(calls).includes("C:\\bad"), false);

  const updates = [];
  const unsubscribe = api.onUpdate((payload) => updates.push(payload));
  listeners.get("content-engine:update")({}, { state: "ready" });
  assert.deepEqual(updates, [{ state: "ready" }]);
  unsubscribe();
  assert.equal(listeners.has("content-engine:update"), false);
}

function assertPreloadExposure() {
  for (const filename of ["src/main/preload.cjs", "src/main/preload.dev.cjs"]) {
    const source = read(filename);
    assert.match(
      source,
      /exposeInMainWorld\("xiaoxiContent", apis\.content\)/,
      `${filename} must expose the same content bridge`
    );
  }
}

function assertRendererWorkflow() {
  const source = read("src/renderer/ContentFoundationPage.tsx");
  const importStart = source.indexOf("const importMedia = async");
  const importEnd = source.indexOf("const archiveAsset = async", importStart);
  assert.notEqual(importStart, -1);
  assert.notEqual(importEnd, -1);
  const importFlow = source.slice(importStart, importEnd);
  assert.equal(
    importFlow.includes("probePending"),
    false,
    "successful import must refresh without waiting for media probing"
  );
  const formatterStart = source.indexOf("function formatMediaDetails");
  const formatterEnd = source.indexOf("const TASK_STATUS_LABELS", formatterStart);
  const formatter = source.slice(formatterStart, formatterEnd);
  assert.equal(formatter.includes("PROBE_ERROR_LABELS[item.probeErrorCode"), true);
  assert.equal(
    formatter.includes('if (item.probeStatus === "unavailable") return "原文件不可用"'),
    false
  );
  assert.equal(source.includes('"consented"'), false);
  assert.match(source, /版权\/使用权状态/);
}

function assertMainLifecycle() {
  const source = read("src/main/main.cjs");
  assert.match(source, /createContentEngineSidecar/);
  assert.match(source, /registerContentEngineIpc/);
  const ipcSource = read("src/main/content-engine-ipc.cjs");
  assert.equal(ipcSource.includes("const MEDIA_FILTERS"), false);
  assert.equal(ipcSource.includes("const VIDEO_FILTERS"), false);
  assert.match(source, /XIAOXI_CONTENT_ENGINE_SIDECAR/);
  const runtimeResolver = source.match(/function contentEngineRuntimePath\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.equal(
    runtimeResolver.indexOf("app.isPackaged") < runtimeResolver.indexOf("XIAOXI_CONTENT_ENGINE_SIDECAR"),
    true,
    "packaged builds must ignore the development runtime environment override"
  );
  assert.match(
    source,
    /process\.resourcesPath[\s\S]*?"content-engine"[\s\S]*?"content-engine-worker\.exe"/
  );
  assert.match(
    source,
    /resolveDefaultDevelopmentSidecarRuntime\("content-engine"\)/
  );
  const runtimeGateSource = read("src/main/development-sidecar-runtime.cjs");
  assert.match(
    runtimeGateSource,
    /"content-engine-runtime", "content-engine-worker\.exe"/
  );
  assert.match(
    source,
    /app\.getPath\("userData"\)[\s\S]*?"content-engine"/
  );
  assert.match(
    source,
    /contentEngineController\.start\(\)\.catch\(\(\) => undefined\)/,
    "metadata worker must start in a controlled, non-blocking way"
  );
  const createCall = source.match(
    /contentEngineController = createContentEngineSidecar\(\{([\s\S]*?)\n    \}\);/
  )?.[1] || "";
  assert.equal(
    createCall.includes("coordinator"),
    false,
    "content processing must not share the WeChat runtime coordinator"
  );
  assert.match(source, /contentEngineController\?\.dispose\(\)/);
  assert.match(source, /Promise\.allSettled\(\[/);
  assert.match(source, /cleanupTimeout/);
  assert.match(source, /contentEngineIpcRegistration\?\.dispose\(\)/);
}

assertPreloadContract();
assertPreloadExposure();
assertRendererWorkflow();
assertMainLifecycle();

console.log("content-engine desktop integration self-check passed");
