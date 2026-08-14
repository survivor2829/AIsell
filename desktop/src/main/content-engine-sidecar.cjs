const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const fs = require("node:fs");
const path = require("node:path");

const MAX_READY_LINE_BYTES = 64 * 1024;
const MAX_REQUEST_LINE_BYTES = 1024 * 1024;
const MAX_RESPONSE_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const IMPORT_REQUEST_TIMEOUT_MS = 30 * 60_000;
const RENDER_REQUEST_TIMEOUT_MS = 2 * 60 * 60_000;

function createError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const capabilities = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (/^[a-z0-9_-]{1,64}$/i.test(key) && typeof enabled === "boolean") {
      capabilities[key] = enabled;
    }
  }
  return capabilities;
}

function parseReady(value) {
  if (!value || value.type !== "ready" || value.service !== "content-engine") {
    return null;
  }
  const version = String(value.version || "");
  if (version.length > 64 || (version && !/^[a-z0-9._+-]+$/i.test(version))) {
    return null;
  }
  if (value.protocol_version !== 1) return null;
  return {
    version,
    protocolVersion: 1,
    capabilities: sanitizeCapabilities(value.capabilities)
  };
}

function createContentEngineSidecar(options = {}) {
  const environment = options.env || process.env;
  const getProviderEnvironment = typeof options.getProviderEnvironment === "function"
    ? options.getProviderEnvironment
    : () => ({});
  const runtimePath = String(
    options.runtimePath
      ?? environment.XIAOXI_CONTENT_ENGINE_SIDECAR
      ?? ""
  ).trim();
  const runtimeArgs = Array.isArray(options.runtimeArgs)
    ? options.runtimeArgs.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const dataDir = String(options.dataDir || "").trim();
  const existsSync = options.existsSync || fs.existsSync;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const spawnProcess = options.spawnProcess || spawn;
  const requestTimeoutMs = Math.max(
    1,
    Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS
  );
  const importTimeoutMs = Math.max(
    requestTimeoutMs,
    Number(options.importTimeoutMs) || IMPORT_REQUEST_TIMEOUT_MS
  );
  const renderTimeoutMs = Math.max(
    requestTimeoutMs,
    Number(options.renderTimeoutMs) || RENDER_REQUEST_TIMEOUT_MS
  );
  const startupTimeoutMs = Math.max(1, Number(options.startupTimeoutMs) || 30_000);
  const stopTimeoutMs = Math.max(1, Number(options.stopTimeoutMs) || 3_000);
  const listeners = new Set();

  let currentRun = null;
  let startPromise = null;
  let stopPromise = null;
  let disposed = false;
  let snapshot = {
    state: runtimePath && existsSync(runtimePath) ? "stopped" : "unavailable",
    available: Boolean(runtimePath && existsSync(runtimePath)),
    version: "",
    protocolVersion: 0,
    capabilities: {},
    code: runtimePath && existsSync(runtimePath)
      ? ""
      : "CONTENT_ENGINE_RUNTIME_UNAVAILABLE"
  };

  function status() {
    return {
      state: snapshot.state,
      available: snapshot.available,
      version: snapshot.version,
      protocolVersion: snapshot.protocolVersion,
      capabilities: { ...snapshot.capabilities },
      code: snapshot.code
    };
  }

  function notify() {
    const update = status();
    for (const listener of listeners) {
      try {
        listener(update);
      } catch {
        // A renderer observer must not affect the local worker lifecycle.
      }
    }
  }

  function update(next) {
    snapshot = {
      ...snapshot,
      ...next,
      capabilities: next.capabilities
        ? { ...next.capabilities }
        : snapshot.capabilities
    };
    notify();
    return status();
  }

  function setTerminalState(state, code = "") {
    return update({
      state,
      available: state !== "unavailable",
      version: "",
      protocolVersion: 0,
      capabilities: {},
      code
    });
  }

  function runtimeIsAvailable() {
    return Boolean(runtimePath && existsSync(runtimePath));
  }

  function waitForClose(run, timeoutMs) {
    if (!run || run.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.closeWaiters.delete(onClose);
        resolve(false);
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      run.closeWaiters.add(onClose);
    });
  }

  function settleCloseWaiters(run) {
    const waiters = [...run.closeWaiters];
    run.closeWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  function rejectPending(run, code) {
    for (const pending of run.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(createError(code));
    }
    run.pending.clear();
  }

  function killRun(run) {
    if (!run || run.closed || run.killRequested) return;
    run.killRequested = true;
    try {
      run.child.kill("SIGTERM");
    } catch {
      // The bounded stop path handles a failed kill.
    }
  }

  function handleResponse(run, payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw createError("CONTENT_ENGINE_RESPONSE_INVALID");
    }
    const requestId = String(payload.id || "");
    const pending = run.pending.get(requestId);
    if (!pending) {
      if (run.expiredRequestIds.delete(requestId)) return;
      throw createError("CONTENT_ENGINE_RESPONSE_INVALID");
    }
    run.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (payload.ok === true) {
      pending.resolve(payload.result);
      return;
    }
    if (payload.ok !== false || !payload.error || typeof payload.error !== "object") {
      pending.reject(createError("CONTENT_ENGINE_RESPONSE_INVALID"));
      return;
    }
    const suppliedCode = String(payload.error.code || "");
    const safeCode = /^[a-z0-9_-]{1,64}$/i.test(suppliedCode)
      ? suppliedCode
      : "internal_error";
    pending.reject(createError(safeCode));
  }

  function handleStdout(run, chunk) {
    run.stdoutBuffer += run.stdoutDecoder.write(chunk);
    while (true) {
      const newlineIndex = run.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = run.stdoutBuffer.slice(0, newlineIndex).trim();
      run.stdoutBuffer = run.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      const maxLineBytes = run.ready
        ? MAX_RESPONSE_LINE_BYTES
        : MAX_READY_LINE_BYTES;
      if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
        throw createError(
          run.ready
            ? "CONTENT_ENGINE_RESPONSE_INVALID"
            : "CONTENT_ENGINE_READY_INVALID"
        );
      }
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        throw createError(
          run.ready
            ? "CONTENT_ENGINE_RESPONSE_INVALID"
            : "CONTENT_ENGINE_READY_INVALID"
        );
      }
      if (!run.ready) {
        const ready = parseReady(payload);
        if (!ready) throw createError("CONTENT_ENGINE_READY_INVALID");
        run.ready = true;
        clearTimeout(run.startupTimer);
        update({
          state: "ready",
          available: true,
          version: ready.version,
          protocolVersion: ready.protocolVersion,
          capabilities: ready.capabilities,
          code: ""
        });
        run.resolveStart(status());
        continue;
      }
      handleResponse(run, payload);
    }
    const maxBufferedBytes = run.ready
      ? MAX_RESPONSE_LINE_BYTES
      : MAX_READY_LINE_BYTES;
    if (Buffer.byteLength(run.stdoutBuffer, "utf8") > maxBufferedBytes) {
      throw createError(
        run.ready
          ? "CONTENT_ENGINE_RESPONSE_INVALID"
          : "CONTENT_ENGINE_READY_INVALID"
      );
    }
  }

  function beginStart() {
    if (disposed) return Promise.resolve(setTerminalState("stopped"));
    if (!runtimeIsAvailable()) {
      return Promise.resolve(setTerminalState(
        "unavailable",
        "CONTENT_ENGINE_RUNTIME_UNAVAILABLE"
      ));
    }
    if (snapshot.state === "ready" && currentRun && !currentRun.closed) {
      return Promise.resolve(status());
    }
    if (!dataDir || !path.isAbsolute(dataDir)) {
      return Promise.resolve(setTerminalState(
        "failed",
        "CONTENT_ENGINE_DATA_DIR_INVALID"
      ));
    }
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      return Promise.resolve(setTerminalState(
        "failed",
        "CONTENT_ENGINE_DATA_DIR_FAILED"
      ));
    }

    update({
      state: "starting",
      available: true,
      version: "",
      protocolVersion: 0,
      capabilities: {},
      code: ""
    });

    return new Promise((resolve) => {
      let child;
      try {
        const providerEnvironment = getProviderEnvironment();
        child = spawnProcess(runtimePath, [...runtimeArgs, "--data-dir", dataDir], {
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...environment,
            ...(providerEnvironment && typeof providerEnvironment === "object"
              ? providerEnvironment
              : {}),
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1"
          }
        });
      } catch {
        resolve(setTerminalState("failed", "CONTENT_ENGINE_SPAWN_FAILED"));
        return;
      }

      const run = {
        child,
        closed: false,
        closeWaiters: new Set(),
        expiredRequestIds: new Set(),
        failureCode: "",
        killRequested: false,
        pending: new Map(),
        ready: false,
        resolveStart: (result) => {
          if (run.startSettled) return;
          run.startSettled = true;
          resolve(result);
        },
        startSettled: false,
        startupTimer: null,
        stderrBytes: 0,
        stdoutBuffer: "",
        stdoutDecoder: new StringDecoder("utf8"),
        stopping: false
      };
      currentRun = run;

      function fail(code) {
        if (run.closed || run.failureCode) return;
        run.failureCode = code;
        rejectPending(run, code);
        const result = setTerminalState("failed", code);
        killRun(run);
        run.resolveStart(result);
      }

      child.stdout?.on("data", (chunk) => {
        if (run.closed) return;
        try {
          handleStdout(run, chunk);
        } catch (error) {
          fail(String(error?.code || "CONTENT_ENGINE_RESPONSE_INVALID"));
        }
      });
      child.stderr?.on("data", (chunk) => {
        run.stderrBytes = Math.min(
          MAX_RESPONSE_LINE_BYTES,
          run.stderrBytes + Buffer.byteLength(chunk)
        );
      });
      child.stdin?.once("error", () => {
        if (!run.stopping) fail("CONTENT_ENGINE_PIPE_FAILED");
      });
      child.once("error", () => {
        if (!run.stopping) fail("CONTENT_ENGINE_SPAWN_FAILED");
      });
      child.once("close", () => {
        run.closed = true;
        clearTimeout(run.startupTimer);
        settleCloseWaiters(run);
        rejectPending(
          run,
          run.stopping
            ? "CONTENT_ENGINE_STOPPED"
            : "CONTENT_ENGINE_EXITED"
        );
        if (currentRun !== run) {
          run.resolveStart(status());
          return;
        }
        currentRun = null;
        const result = run.stopping || disposed
          ? setTerminalState("stopped")
          : setTerminalState(
            "failed",
            run.failureCode || "CONTENT_ENGINE_EXITED"
          );
        run.resolveStart(result);
      });
      run.startupTimer = setTimeout(() => {
        fail("CONTENT_ENGINE_START_TIMEOUT");
      }, startupTimeoutMs);
    });
  }

  function start() {
    if (startPromise) return startPromise;
    const oldRunNeedsStop = Boolean(
      currentRun
      && !currentRun.closed
      && snapshot.state !== "ready"
    );
    const waitForStop = stopPromise
      || (oldRunNeedsStop ? stop() : Promise.resolve());
    startPromise = waitForStop
      .then(() => beginStart())
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  }

  async function ensureReady() {
    if (snapshot.state !== "ready" || !currentRun || currentRun.closed) {
      const started = await start();
      if (started.state !== "ready") {
        throw createError(started.code || "CONTENT_ENGINE_NOT_READY");
      }
    }
    return currentRun;
  }

  async function request(method, params = {}, optionsForRequest = {}) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(String(method || ""))) {
      throw createError("CONTENT_ENGINE_METHOD_INVALID");
    }
    const run = await ensureReady();
    if (!run || run.closed || (run.stopping && method !== "shutdown")) {
      throw createError("CONTENT_ENGINE_NOT_READY");
    }
    const requestId = randomUUID();
    const timeoutMs = Math.max(
      1,
      Number(optionsForRequest.timeoutMs) || requestTimeoutMs
    );
    const requestLine = `${JSON.stringify({
      id: requestId,
      method,
      params
    })}\n`;
    if (Buffer.byteLength(requestLine, "utf8") > MAX_REQUEST_LINE_BYTES) {
      throw createError("CONTENT_ENGINE_REQUEST_TOO_LARGE");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        run.pending.delete(requestId);
        run.expiredRequestIds.add(requestId);
        if (run.expiredRequestIds.size > 1_000) {
          run.expiredRequestIds.delete(run.expiredRequestIds.values().next().value);
        }
        reject(createError("CONTENT_ENGINE_REQUEST_TIMEOUT"));
      }, timeoutMs);
      run.pending.set(requestId, { reject, resolve, timer });
      try {
        run.child.stdin.write(requestLine, "utf8", (error) => {
          if (!error) return;
          const pending = run.pending.get(requestId);
          if (!pending) return;
          run.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(createError("CONTENT_ENGINE_PIPE_FAILED"));
        });
      } catch {
        const pending = run.pending.get(requestId);
        if (pending) {
          run.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(createError("CONTENT_ENGINE_PIPE_FAILED"));
        }
      }
    });
  }

  async function performStop() {
    const run = currentRun;
    if (!run || run.closed) {
      return runtimeIsAvailable()
        ? setTerminalState("stopped")
        : setTerminalState(
          "unavailable",
          "CONTENT_ENGINE_RUNTIME_UNAVAILABLE"
        );
    }
    run.stopping = true;
    clearTimeout(run.startupTimer);
    let closed = false;
    if (run.ready) {
      try {
        await request("shutdown", {}, { timeoutMs: stopTimeoutMs });
        closed = await waitForClose(run, stopTimeoutMs);
      } catch {
        closed = run.closed;
      }
    }
    if (!closed) {
      killRun(run);
      closed = await waitForClose(run, stopTimeoutMs);
    }
    if (!closed) {
      rejectPending(run, "CONTENT_ENGINE_STOPPED");
      run.closed = true;
      settleCloseWaiters(run);
      if (currentRun === run) currentRun = null;
    }
    const result = setTerminalState("stopped");
    run.resolveStart(result);
    return result;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = performStop().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function restart() {
    if (disposed) return setTerminalState("stopped");
    await stop();
    return start();
  }

  async function dispose() {
    disposed = true;
    const result = await stop();
    listeners.clear();
    return result;
  }

  function onUpdate(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    analyzeAssets: (assetIds, profile) => request("analyze_assets", {
      asset_ids: assetIds,
      profile
    }),
    archiveAsset: (assetId) => request("archive_asset", { asset_id: assetId }),
    calculateMixCombinations: (projectId) => request(
      "calculate_mix_combinations",
      { project_id: projectId }
    ),
    cancelTask: (taskId) => request("update_task", {
      task_id: taskId,
      status: "cancelled"
    }),
    createTask: (taskType, payload) => request("create_task", {
      task_type: taskType,
      payload
    }),
    createMixProject: (name, slots, constraints) => request(
      "create_mix_project",
      { name, slots, constraints }
    ),
    dispose,
    getSetting: (key, defaultValue) => request("get_setting", {
      key,
      default: defaultValue
    }),
    getMixProject: (projectId) => request("get_mix_project", {
      project_id: projectId
    }),
    generateMixCandidates: (projectId, optionsForGeneration = {}) => request(
      "generate_mix_candidates",
      {
        project_id: projectId,
        limit: optionsForGeneration.limit,
        seed: optionsForGeneration.seed
      }
    ),
    generateCourseCuts: (assetId, optionsForGeneration = {}) => request(
      "generate_course_cuts",
      {
        asset_id: assetId,
        min_duration_ms: optionsForGeneration.minDurationMs,
        max_duration_ms: optionsForGeneration.maxDurationMs,
        count: optionsForGeneration.count,
        theme: optionsForGeneration.theme,
        subtitle_font_size: optionsForGeneration.subtitleFontSize,
        subtitle_margin_bottom: optionsForGeneration.subtitleMarginBottom
      }
    ),
    generateMixBatch: (assetIds, optionsForGeneration = {}) => request(
      "generate_mix_batch",
      {
        asset_ids: assetIds,
        theme: optionsForGeneration.theme,
        target_count: optionsForGeneration.targetCount,
        voice_asset_id: optionsForGeneration.voiceAssetId
      }
    ),
    getCreativeProject: (projectId) => request("get_creative_project", {
      project_id: projectId
    }),
    importFiles: (paths) => request(
      "import_files",
      { paths },
      { timeoutMs: importTimeoutMs }
    ),
    importFolder: (folderPath, recursive) => request(
      "import_folder",
      { path: folderPath, recursive },
      { timeoutMs: importTimeoutMs }
    ),
    listAssets: (optionsForList = {}) => request("list_assets", {
      include_archived: optionsForList.includeArchived === true,
      limit: optionsForList.limit
    }),
    listFinished: (limit) => request("list_finished", { limit }),
    listGeneratedVideos: (optionsForList = {}) => request(
      "list_generated_videos",
      {
        project_id: optionsForList.projectId,
        status: optionsForList.status,
        limit: optionsForList.limit
      }
    ),
    listMediaSegments: (optionsForList = {}) => request(
      "list_media_segments",
      {
        asset_id: optionsForList.assetId,
        role: optionsForList.role,
        limit: optionsForList.limit
      }
    ),
    listMixCandidates: (optionsForList = {}) => request("list_mix_candidates", {
      project_id: optionsForList.projectId,
      review_status: optionsForList.reviewStatus,
      limit: optionsForList.limit
    }),
    listMixProjects: (limit) => request("list_mix_projects", { limit }),
    listExportPackages: (optionsForList = {}) => request("list_export_packages", {
      candidate_id: optionsForList.candidateId,
      limit: optionsForList.limit
    }),
    listPublishQueue: (optionsForList = {}) => request("list_publish_queue", {
      status: optionsForList.status,
      limit: optionsForList.limit
    }),
    listTasks: (optionsForList = {}) => request("list_tasks", {
      status: optionsForList.status,
      limit: optionsForList.limit
    }),
    onUpdate,
    pauseTask: (taskId) => request("update_task", {
      task_id: taskId,
      status: "paused"
    }),
    queueGeneratedVideos: (candidateIds, channel) => request(
      "queue_generated_videos",
      { candidate_ids: candidateIds, channel }
    ),
    regenerateVideo: (candidateId) => request("regenerate_video", {
      candidate_id: candidateId
    }),
    rejectGeneratedVideo: (candidateId) => request("reject_generated_video", {
      candidate_id: candidateId
    }),
    probeAsset: (assetId) => request("probe_asset", { asset_id: assetId }),
    probePending: (limit = 10) => request(
      "probe_pending",
      { limit },
      { timeoutMs: importTimeoutMs }
    ),
    registerFinished: (outputPath, optionsForFinished = {}) => request(
      "register_finished",
      {
        output_path: outputPath,
        title: optionsForFinished.title,
        task_id: optionsForFinished.taskId,
        metadata: optionsForFinished.metadata || {}
      }
    ),
    request,
    restart,
    resolveAssetPath: (assetId) => request("resolve_asset_path", {
      asset_id: assetId
    }),
    resolveFinishedPath: (finishedVideoId) => request(
      "resolve_finished_path",
      { finished_video_id: finishedVideoId }
    ),
    resolveGeneratedVideoPath: (candidateId, variant = "video") => request(
      "resolve_generated_video_path",
      { candidate_id: candidateId, variant }
    ),
    resolveExportPackagePath: (packageId) => request(
      "resolve_export_package_path",
      { package_id: packageId }
    ),
    renderMixCandidate: (candidateId, optionsForRender = {}) => request(
      "render_mix_candidate",
      {
        candidate_id: candidateId,
        platforms: optionsForRender.platforms,
        title: optionsForRender.title,
        description: optionsForRender.description
      },
      { timeoutMs: renderTimeoutMs }
    ),
    reviewMixCandidate: (candidateId, reviewStatus, reviewNote) => request(
      "review_mix_candidate",
      {
        candidate_id: candidateId,
        review_status: reviewStatus,
        review_note: reviewNote
      }
    ),
    resumeTask: async (taskId) => {
      const listed = await request("list_tasks", { limit: 2_000 });
      const task = Array.isArray(listed?.items)
        ? listed.items.find((item) => item?.task_id === taskId)
        : null;
      if (!task) throw createError("task_not_found");
      if (task.task_type === "asset_import") {
        await request(
          "resume_import_folder",
          { task_id: taskId, batch_size: 200 },
          { timeoutMs: importTimeoutMs }
        );
        const refreshed = await request("list_tasks", { limit: 2_000 });
        return refreshed.items.find((item) => item?.task_id === taskId);
      }
      if ([
        "creative_analysis",
        "course_generation",
        "mix_generation",
        "creative_regeneration"
      ].includes(
        task.task_type
      )) {
        return request("resume_creative_task", { task_id: taskId });
      }
      const resumeStatus = [
        "queued",
        "analyzing",
        "ready_for_review",
        "rendering"
      ].includes(
        task.resume_from_status
      )
        ? task.resume_from_status
        : "queued";
      return request("update_task", {
        task_id: taskId,
        status: resumeStatus
      });
    },
    setSetting: (key, value) => request("set_setting", { key, value }),
    updateAssetRights: (assetId, rightsStatus) => request(
      "update_asset_rights",
      { asset_id: assetId, rights_status: rightsStatus }
    ),
    updateMixProject: (projectId, changes = {}) => request(
      "update_mix_project",
      {
        project_id: projectId,
        name: changes.name,
        slots: changes.slots,
        constraints: changes.constraints
      }
    ),
    updatePublishQueueItem: (queueItemId, statusForQueue, errorMessage) => request(
      "update_publish_queue_item",
      {
        queue_item_id: queueItemId,
        status: statusForQueue,
        error_message: errorMessage
      }
    ),
    start,
    status,
    stop
  };
}

module.exports = {
  createContentEngineSidecar,
  createError,
  parseReady,
  sanitizeCapabilities
};
