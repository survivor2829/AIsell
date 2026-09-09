const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { writeJsonAtomic: defaultWriteJsonAtomic } = require("./atomic-file.cjs");
const { readWorkflowJson, workflowDirectory } = require("./moments-workflow-storage.cjs");
const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png"]);
const VIDEO_EXTENSIONS = new Set([".mov", ".mp4"]);
const MAX_IMAGE_COUNT = 9;
const MAX_CONTENT_LENGTH = 2000;
const MIN_OCR_CHARACTER_COUNT = 6;
const MAX_ATTEMPT_HISTORY = 100;
const PUBLISH_STAGES = new Set([
  "initialized",
  "moments_open",
  "baseline_observation",
  "camera_targeting",
  "file_dialog",
  "media_processing",
  "content_input",
  "prepublish_verification",
  "publish_click",
  "postpublish_verification"
]);
const PUBLISH_FAILURE_KINDS = new Set([
  "driver_result",
  "navigation_result",
  "node_exception",
  "powershell_exception"
]);

function normalizeContent(value) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .trim();
}

function countOcrCharacters(value) {
  return Array.from(normalizeContent(value).normalize("NFKC"))
    .filter((character) => /[0-9A-Za-z\u3400-\u9fff]/u.test(character))
    .length;
}

function mediaKindForExtension(extension) {
  const value = String(extension || "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(value)) return "image";
  if (VIDEO_EXTENSIONS.has(value)) return "video";
  return "";
}

function validateMediaDescriptors(media) {
  if (!Array.isArray(media) || media.length < 1) {
    return { ok: false, reason: "moments_publish_media_required" };
  }
  const kinds = media.map((item) => mediaKindForExtension(item?.ext));
  if (kinds.some((kind) => !kind)) {
    return { ok: false, reason: "moments_publish_media_type_unsupported" };
  }
  const distinctKinds = new Set(kinds);
  if (distinctKinds.size !== 1) {
    return { ok: false, reason: "moments_publish_media_mixed" };
  }
  const kind = kinds[0];
  if (kind === "image" && media.length > MAX_IMAGE_COUNT) {
    return { ok: false, reason: "moments_publish_image_count_invalid" };
  }
  if (kind === "video" && media.length !== 1) {
    return { ok: false, reason: "moments_publish_video_count_invalid" };
  }
  return { ok: true, kind };
}

function buildPublishFingerprint(content, media) {
  const normalized = normalizeContent(content);
  const canonicalMedia = (Array.isArray(media) ? media : []).map((item) => ({
    sha256: String(item?.sha256 || "").toLowerCase(),
    size: Number(item?.size || 0),
    ext: String(item?.ext || "").toLowerCase()
  }));
  return crypto.createHash("sha256").update(JSON.stringify({
    version: 1,
    content: normalized,
    media: canonicalMedia
  })).digest("hex");
}

function readJson(file, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readDurablePublishMarkers(markerDir) {
  try {
    return fs.readdirSync(markerDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const match = /^([a-f0-9]{64})\.([a-f0-9-]{16,64})\.json$/u.exec(entry.name);
        if (!match) return null;
        let modifiedAt = 0;
        try {
          modifiedAt = fs.statSync(path.join(markerDir, entry.name)).mtimeMs;
        } catch {}
        return {
          markerName: entry.name,
          fingerprint: match[1],
          attemptId: match[2],
          modifiedAt
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
  } catch {
    return [];
  }
}

function safeIso(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}T/u.test(text) ? text : "";
}

function safeFingerprint(value) {
  const text = String(value || "").toLowerCase();
  return /^[a-f0-9]{64}$/u.test(text) ? text : "";
}

function safeReason(value, fallback = "") {
  const text = String(value || "");
  return /^[a-z0-9_:-]{1,128}$/u.test(text) ? text : fallback;
}

function boundedInteger(value, minimum, maximum, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function normalizePublishButtonSearch(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).map((sample) => {
    const frameWidth = boundedInteger(sample?.frameWidth, 300, 10_000);
    const frameHeight = boundedInteger(sample?.frameHeight, 300, 10_000);
    const visualCandidates = Array.isArray(sample?.visualCandidates)
      ? sample.visualCandidates.slice(0, 4).map((candidate) => {
        const bounds = candidate?.bounds || {};
        const left = boundedInteger(bounds.left, 0, frameWidth);
        const top = boundedInteger(bounds.top, 0, frameHeight);
        const width = boundedInteger(bounds.width, 1, frameWidth);
        const height = boundedInteger(bounds.height, 1, frameHeight);
        if (left + width > frameWidth + 1 || top + height > frameHeight + 1) return null;
        const greenRatio = Number(candidate?.greenRatio);
        return {
          left,
          top,
          width,
          height,
          green_ratio: Number.isFinite(greenRatio)
            ? Math.max(0, Math.min(1, Math.round(greenRatio * 1000) / 1000))
            : 0
        };
      }).filter(Boolean)
      : [];
    const phase = ["scroll", "settle", "final_rebind"].includes(String(sample?.phase || ""))
      ? String(sample.phase)
      : "";
    const ocrMode = ["skipped_visual_unique", "scoped_bottom_action_band"].includes(String(sample?.ocrMode || ""))
      ? String(sample.ocrMode)
      : "";
    return {
      phase,
      attempt: boundedInteger(sample?.attempt, 0, 50),
      frame_width: frameWidth,
      frame_height: frameHeight,
      scan_top: boundedInteger(sample?.scanTop, 0, frameHeight),
      visual_count: boundedInteger(sample?.visualCount, 0, 20),
      ocr_exact_count: boundedInteger(sample?.ocrExactCount, 0, 20),
      ocr_mode: ocrMode,
      visual_candidates: visualCandidates
    };
  }).filter((sample) => sample.frame_width >= 300 && sample.frame_height >= 300);
}

function normalizeFailureBreadcrumb(value = {}) {
  const stage = String(value.stage || value.last_stage || "");
  const failureKind = String(value.failure_kind || value.failureKind || value.last_failure_kind || "");
  const exceptionCategory = String(
    value.exception_category || value.exceptionCategory || value.last_exception_category || ""
  );
  const exceptionType = String(value.exception_type || value.exceptionType || value.last_exception_type || "");
  return {
    stage: PUBLISH_STAGES.has(stage) ? stage : "",
    failure_kind: PUBLISH_FAILURE_KINDS.has(failureKind) ? failureKind : "",
    exception_category: /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(exceptionCategory)
      ? exceptionCategory
      : "",
    exception_type: /^[A-Za-z][A-Za-z0-9_.+]{0,159}$/u.test(exceptionType)
      ? exceptionType
      : ""
  };
}

function lastFailureBreadcrumb(value = {}) {
  const breadcrumb = normalizeFailureBreadcrumb(value);
  return {
    last_stage: breadcrumb.stage,
    last_failure_kind: breadcrumb.failure_kind,
    last_exception_category: breadcrumb.exception_category,
    last_exception_type: breadcrumb.exception_type
  };
}

function normalizeVerificationDiagnostics(value = {}) {
  return {
    verification_attempts: boundedInteger(
      value.verification_attempts ?? value.verificationAttempts,
      0,
      100
    ),
    verification_elapsed_ms: boundedInteger(
      value.verification_elapsed_ms ?? value.verificationElapsedMs,
      0,
      300_000
    ),
    last_verification_reason: safeReason(
      value.last_verification_reason ?? value.lastVerificationReason
    )
  };
}

function normalizeAttempt(value = {}) {
  return {
    attempt_id: String(value.attempt_id || "").replace(/[^a-zA-Z0-9-]/gu, "").slice(0, 80),
    workflow_task_id: String(value.workflow_task_id || "").replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 128),
    fingerprint: safeFingerprint(value.fingerprint),
    status: safeReason(value.status, "failed"),
    action_attempted: value.action_attempted === true,
    reason: safeReason(value.reason),
    marker_name: path.basename(String(value.marker_name || "")).slice(0, 120),
    started_at: safeIso(value.started_at),
    finished_at: safeIso(value.finished_at),
    resolved_at: safeIso(value.resolved_at),
    ...normalizeFailureBreadcrumb(value),
    ...normalizeVerificationDiagnostics(value)
  };
}

function normalizeFingerprintStatuses(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, entry] of Object.entries(value)) {
    const fingerprint = safeFingerprint(key);
    const status = safeReason(entry?.status);
    if (!fingerprint || !["outcome_unknown", "published", "not_published"].includes(status)) continue;
    result[fingerprint] = {
      status,
      attempt_id: String(entry?.attempt_id || "").replace(/[^a-zA-Z0-9-]/gu, "").slice(0, 80),
      updated_at: safeIso(entry?.updated_at)
    };
  }
  return result;
}

function normalizeState(value = {}) {
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.map(normalizeAttempt).filter((entry) => entry.attempt_id).slice(-MAX_ATTEMPT_HISTORY)
    : [];
  return {
    version: 1,
    status: safeReason(value.status, "idle"),
    last_reason: safeReason(value.last_reason),
    ...lastFailureBreadcrumb(value),
    ...normalizeVerificationDiagnostics(value),
    fingerprint: safeFingerprint(value.fingerprint),
    attempt_id: String(value.attempt_id || "").replace(/[^a-zA-Z0-9-]/gu, "").slice(0, 80),
    marker_name: path.basename(String(value.marker_name || "")).slice(0, 120),
    media_count: Math.max(0, Math.min(MAX_IMAGE_COUNT, Number(value.media_count || 0))),
    media_type: ["image", "video"].includes(value.media_type) ? value.media_type : "",
    content_character_count: Math.max(0, Number(value.content_character_count || 0)),
    action_attempted: value.action_attempted === true,
    outcome_unknown: value.outcome_unknown === true,
    prepared_at: safeIso(value.prepared_at),
    attempted_at: safeIso(value.attempted_at),
    verified_at: safeIso(value.verified_at),
    resolved_at: safeIso(value.resolved_at),
    updated_at: safeIso(value.updated_at),
    fingerprints: normalizeFingerprintStatuses(value.fingerprints),
    attempts
  };
}

function publicState(value = {}, selection = null, preparedDraft = null) {
  const state = normalizeState(value);
  return {
    status: state.status,
    draft_id: preparedDraft?.confirmationId || "",
    last_reason: state.last_reason,
    last_stage: state.last_stage,
    last_failure_kind: state.last_failure_kind,
    last_exception_category: state.last_exception_category,
    last_exception_type: state.last_exception_type,
    verification_attempts: state.verification_attempts,
    verification_elapsed_ms: state.verification_elapsed_ms,
    last_verification_reason: state.last_verification_reason,
    fingerprint: state.fingerprint,
    media_count: state.media_count,
    media_kind: state.media_type,
    content_character_count: state.content_character_count,
    action_attempted: state.action_attempted,
    outcome_unknown: state.outcome_unknown,
    prepared_at: state.prepared_at,
    clicked_at: state.action_attempted ? state.attempted_at : "",
    attempted_at: state.attempted_at,
    verified_at: state.verified_at,
    resolved_at: state.resolved_at,
    updated_at: state.updated_at,
    selection: selection ? {
      selection_id: selection.selectionId,
      media_count: selection.media.length,
      media_kind: selection.kind,
      files: selection.media.map((item) => ({
        name: item.name,
        size: item.size,
        kind: item.kind
      }))
    } : null
  };
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectMediaPaths(paths) {
  if (!Array.isArray(paths)) {
    return { ok: false, reason: "moments_publish_media_required" };
  }
  const preliminary = [];
  for (const file of paths) {
    const input = String(file || "");
    if (!input) return { ok: false, reason: "moments_publish_media_required" };
    let resolved;
    let stat;
    try {
      resolved = fs.realpathSync(path.resolve(input));
      stat = fs.statSync(resolved);
    } catch {
      return { ok: false, reason: "moments_publish_media_unavailable" };
    }
    if (!stat.isFile() || stat.size < 1) {
      return { ok: false, reason: "moments_publish_media_unavailable" };
    }
    const ext = path.extname(resolved).toLowerCase();
    preliminary.push({
      path: resolved,
      name: path.basename(resolved),
      size: stat.size,
      ext,
      kind: mediaKindForExtension(ext)
    });
  }
  const validated = validateMediaDescriptors(preliminary);
  if (!validated.ok) return validated;
  const media = [];
  for (const item of preliminary) {
    media.push({ ...item, sha256: await sha256File(item.path) });
  }
  return { ok: true, kind: validated.kind, media };
}

function mediaDescriptorsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.path === other.path
      && item.size === other.size
      && item.ext === other.ext
      && item.sha256 === other.sha256;
  });
}

function mediaContentDescriptorsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.size === other.size
      && item.ext === other.ext
      && item.sha256 === other.sha256;
  });
}

function stagingDirectoryFor(stagingRoot, attemptId) {
  const safeAttemptId = String(attemptId || "");
  if (!/^[a-f0-9-]{16,64}$/u.test(safeAttemptId)) return "";
  const resolvedRoot = path.resolve(stagingRoot);
  const resolved = path.resolve(resolvedRoot, safeAttemptId);
  return path.dirname(resolved) === resolvedRoot ? resolved : "";
}

function removeStagingAttempt(stagingRoot, attemptId) {
  const directory = stagingDirectoryFor(stagingRoot, attemptId);
  if (!directory) return false;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function stageMediaForAttempt(stagingRoot, attemptId, media) {
  const attemptDirectory = stagingDirectoryFor(stagingRoot, attemptId);
  if (!attemptDirectory || !Array.isArray(media) || media.length < 1) {
    return { ok: false, reason: "moments_publish_staging_failed" };
  }
  try {
    fs.mkdirSync(path.dirname(attemptDirectory), { recursive: true });
    fs.mkdirSync(attemptDirectory);
    const stagedPaths = [];
    for (let index = 0; index < media.length; index += 1) {
      const item = media[index];
      const ordinal = String(index + 1).padStart(2, "0");
      const filename = `${ordinal}-${item.sha256.slice(0, 12)}${item.ext}`;
      const destination = path.join(attemptDirectory, filename);
      fs.copyFileSync(item.path, destination, fs.constants.COPYFILE_EXCL);
      try {
        fs.chmodSync(destination, 0o444);
      } catch {}
      stagedPaths.push(destination);
    }
    const inspected = await inspectMediaPaths(stagedPaths);
    if (!inspected.ok || !mediaContentDescriptorsEqual(media, inspected.media)) {
      removeStagingAttempt(stagingRoot, attemptId);
      return { ok: false, reason: "moments_publish_media_changed" };
    }
    return { ok: true, kind: inspected.kind, media: inspected.media, directory: attemptDirectory };
  } catch {
    removeStagingAttempt(stagingRoot, attemptId);
    return { ok: false, reason: "moments_publish_staging_failed" };
  }
}

function createTrustedClickValidator(getMainWindow, options = {}) {
  const consumedTokens = new Set();
  const maxTokens = Math.max(10, Number(options.maxTokens || 100));
  return function trustedClick(event, token) {
    const window = getMainWindow();
    const value = String(token || "");
    if (
      !/^[a-zA-Z0-9-]{16,128}$/u.test(value)
      || consumedTokens.has(value)
      || !window
      || window.isDestroyed()
      || event?.sender !== window.webContents
      || !window.isFocused()
    ) return false;
    consumedTokens.add(value);
    while (consumedTokens.size > maxTokens) consumedTokens.delete(consumedTokens.values().next().value);
    return true;
  };
}

function createMomentsPublishController(options = {}) {
  const baseDir = path.resolve(String(options.baseDir || "."));
  const stateFile = path.join(baseDir, "publish-state.json");
  const markerDir = path.join(baseDir, "publish_markers");
  const stagingRoot = path.join(baseDir, "publish_staging");
  const plannedMediaRoot = path.join(baseDir, "planned_media");
  const coordinator = options.coordinator;
  const openMoments = options.openMoments || (async (openOptions) => {
    const { openWechatMoments } = require("../../rpa/active_touch/moments_navigation.dev.cjs");
    return openWechatMoments(openOptions);
  });
  const publishDriver = options.publishDriver || (async (driverOptions) => {
    const { runMomentsPublish } = require("../../rpa/active_touch/moments_publish_driver.dev.cjs");
    return runMomentsPublish(driverOptions);
  });
  const writeState = typeof options.writeJsonAtomic === "function"
    ? options.writeJsonAtomic
    : defaultWriteJsonAtomic;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const emit = typeof options.emit === "function" ? options.emit : () => undefined;
  const logger = options.logger && typeof options.logger.event === "function"
    ? options.logger
    : { event: () => undefined };
  let state = normalizeState(readJson(stateFile));
  let currentSelection = null;
  let preparedDraft = null;
  let inFlight = null;
  let confirmationTask = null;
  let activeAbortController = null;
  let disposed = false;

  function isoNow() {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  function snapshot() {
    return publicState(state, currentSelection, preparedDraft);
  }

  function persist(patch = {}) {
    state = normalizeState({ ...state, ...patch, updated_at: isoNow() });
    writeState(stateFile, state);
    emit(snapshot());
    return state;
  }

  function record(event, fields = {}, level = "info") {
    logger.event("moments", event, fields, { level });
  }

  function clearSecrets() {
    preparedDraft = null;
    currentSelection = null;
  }

  function updateAttempt(attemptId, patch) {
    const attempts = state.attempts.map((attempt) => attempt.attempt_id === attemptId
      ? normalizeAttempt({ ...attempt, ...patch })
      : attempt);
    return attempts.slice(-MAX_ATTEMPT_HISTORY);
  }

  function addFingerprintStatus(fingerprint, status, attemptId, timestamp = isoNow()) {
    return {
      ...state.fingerprints,
      [fingerprint]: { status, attempt_id: attemptId, updated_at: timestamp }
    };
  }

  function fingerprintBlockReason(fingerprint) {
    const status = state.fingerprints[fingerprint]?.status;
    if (status === "outcome_unknown") return "moments_publish_outcome_unknown_requires_resolution";
    if (status === "published") return "moments_publish_fingerprint_already_published";
    return "";
  }

  function markerPathFor(markerName) {
    const safeName = path.basename(String(markerName || ""));
    return safeName ? path.join(markerDir, safeName) : "";
  }

  function markerExists(markerName) {
    const file = markerPathFor(markerName);
    return Boolean(file && fs.existsSync(file));
  }

  function orphanMarkers() {
    const terminalStatuses = new Set([
      "outcome_unknown",
      "resolved_not_published",
      "resolved_published",
      "verified"
    ]);
    const knownTerminalAttempts = new Set(state.attempts
      .filter((attempt) => terminalStatuses.has(attempt.status))
      .map((attempt) => attempt.attempt_id));
    const terminalFingerprintStatuses = new Set(["outcome_unknown", "published"]);
    return readDurablePublishMarkers(markerDir)
      .filter((marker) => !knownTerminalAttempts.has(marker.attemptId)
        && !terminalFingerprintStatuses.has(state.fingerprints[marker.fingerprint]?.status));
  }

  function removeMarker(markerName) {
    const file = markerPathFor(markerName);
    if (!file) return false;
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async function chooseMedia(paths) {
    if (disposed) return { ok: false, reason: "moments_publish_disposed", state: snapshot() };
    if (inFlight || confirmationTask) return { ok: false, reason: "moments_publish_already_running", state: snapshot() };
    if (state.outcome_unknown) {
      return { ok: false, reason: "moments_publish_outcome_unknown_requires_resolution", state: snapshot() };
    }
    const inspected = await inspectMediaPaths(paths);
    if (!inspected.ok) return { ...inspected, state: snapshot() };
    currentSelection = {
      selectionId: crypto.randomUUID(),
      kind: inspected.kind,
      media: inspected.media
    };
    preparedDraft = null;
    persist({
      status: "media_selected",
      last_reason: "moments_publish_media_selected",
      fingerprint: "",
      attempt_id: "",
      marker_name: "",
      media_count: inspected.media.length,
      media_type: inspected.kind,
      content_character_count: 0,
      action_attempted: false,
      outcome_unknown: false,
      last_stage: "",
      last_failure_kind: "",
      last_exception_category: "",
      last_exception_type: "",
      prepared_at: "",
      attempted_at: "",
      verified_at: "",
      resolved_at: ""
    });
    return { ok: true, selection: snapshot().selection, state: snapshot() };
  }

  async function prepare(payload = {}) {
    if (disposed) return { ok: false, reason: "moments_publish_disposed", state: snapshot() };
    if (inFlight || confirmationTask) return { ok: false, reason: "moments_publish_already_running", state: snapshot() };
    if (state.outcome_unknown) {
      return { ok: false, reason: "moments_publish_outcome_unknown_requires_resolution", state: snapshot() };
    }
    if (!currentSelection || String(payload.selectionId || "") !== currentSelection.selectionId) {
      return { ok: false, reason: "moments_publish_selection_expired", state: snapshot() };
    }
    const content = normalizeContent(payload.content);
    const contentCharacterCount = countOcrCharacters(content);
    if (!content) {
      return { ok: false, reason: "moments_publish_content_required", state: snapshot() };
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return { ok: false, reason: "moments_publish_content_too_long", state: snapshot() };
    }
    if (contentCharacterCount < MIN_OCR_CHARACTER_COUNT) {
      return { ok: false, reason: "moments_publish_content_too_short", state: snapshot() };
    }
    const refreshed = await inspectMediaPaths(currentSelection.media.map((item) => item.path));
    if (!refreshed.ok || !mediaDescriptorsEqual(currentSelection.media, refreshed.media)) {
      currentSelection = null;
      preparedDraft = null;
      persist({ status: "failed", last_reason: "moments_publish_media_changed" });
      return { ok: false, reason: "moments_publish_media_changed", state: snapshot() };
    }
    const fingerprint = buildPublishFingerprint(content, refreshed.media);
    const blockedReason = fingerprintBlockReason(fingerprint);
    if (blockedReason) return { ok: false, reason: blockedReason, state: snapshot() };
    const confirmationId = crypto.randomUUID();
    preparedDraft = {
      confirmationId,
      selectionId: currentSelection.selectionId,
      content,
      media: refreshed.media,
      fingerprint
    };
    const preparedAt = isoNow();
    persist({
      status: "awaiting_confirmation",
      last_reason: "moments_publish_confirmation_required",
      fingerprint,
      media_count: refreshed.media.length,
      media_type: refreshed.kind,
      content_character_count: contentCharacterCount,
      action_attempted: false,
      outcome_unknown: false,
      prepared_at: preparedAt,
      attempted_at: "",
      verified_at: "",
      resolved_at: ""
    });
    return {
      ok: true,
      confirmation: {
        confirmationId,
        fingerprint,
        mediaCount: refreshed.media.length,
        mediaType: refreshed.kind,
        contentCharacterCount
      },
      state: snapshot()
    };
  }

  function plannedSnapshot(taskId) {
    return readWorkflowJson(path.join(workflowDirectory(plannedMediaRoot, taskId), "snapshot.json"));
  }

  async function prepareWorkflowTask(taskId, payload = {}) {
    try {
      if (disposed) return { ok: false, reason: "moments_publish_disposed" };
      const directory = workflowDirectory(plannedMediaRoot, taskId);
      const source = payload.sourceTaskId ? plannedSnapshot(payload.sourceTaskId) : plannedSnapshot(taskId);
      const content = normalizeContent(payload.content === undefined ? source?.content : payload.content);
      if (!content) return { ok: false, reason: "moments_publish_content_required" };
      if (content.length > MAX_CONTENT_LENGTH) return { ok: false, reason: "moments_publish_content_too_long" };
      if (countOcrCharacters(content) < MIN_OCR_CHARACTER_COUNT) {
        return { ok: false, reason: "moments_publish_content_too_short" };
      }
      let selectedMedia;
      if (payload.selectionId) {
        if (!currentSelection || String(payload.selectionId) !== currentSelection.selectionId) {
          return { ok: false, reason: "moments_publish_selection_expired" };
        }
        selectedMedia = currentSelection.media;
      } else {
        selectedMedia = source?.media;
      }
      if (!Array.isArray(selectedMedia) || selectedMedia.length === 0) {
        return { ok: false, reason: "moments_publish_media_required" };
      }
      const inspected = await inspectMediaPaths(selectedMedia.map((item) => item.path));
      if (!inspected.ok || !mediaDescriptorsEqual(selectedMedia, inspected.media)) {
        return { ok: false, reason: "moments_publish_media_changed" };
      }
      const fingerprint = buildPublishFingerprint(content, inspected.media);
      const blockedReason = fingerprintBlockReason(fingerprint);
      if (blockedReason) return { ok: false, reason: blockedReason };
      // Each revision owns copies. Editing or repeating a task cannot change an
      // earlier task's inputs, and user-selected originals are never removed.
      const revision = crypto.randomUUID();
      const mediaDirectory = path.join(directory, revision);
      fs.mkdirSync(mediaDirectory, { recursive: true });
      const copiedPaths = inspected.media.map((item, index) => {
        const destination = path.join(mediaDirectory, `${String(index + 1).padStart(2, "0")}${item.ext}`);
        fs.copyFileSync(item.path, destination, fs.constants.COPYFILE_EXCL);
        return destination;
      });
      const copied = await inspectMediaPaths(copiedPaths);
      if (!copied.ok || !mediaContentDescriptorsEqual(inspected.media, copied.media)) {
        return { ok: false, reason: "moments_publish_media_changed" };
      }
      const saved = {
        version: 1,
        taskId: String(taskId),
        revision,
        content,
        fingerprint,
        kind: copied.kind,
        media: copied.media.map((item, index) => ({ ...item, name: selectedMedia[index].name })),
        updatedAt: isoNow()
      };
      writeState(path.join(directory, "snapshot.json"), saved);
      return { ok: true, payload: { content, fingerprint, mediaRevision: revision, mediaCount: saved.media.length, mediaType: saved.kind } };
    } catch (error) {
      return { ok: false, reason: safeReason(error?.code, "moments_publish_snapshot_failed") };
    }
  }

  function workflowDraft(taskId) {
    try {
      const saved = plannedSnapshot(taskId);
      if (!saved) return { ok: false, reason: "moments_publish_snapshot_missing" };
      return {
        ok: true,
        content: saved.content,
        media: {
          media_kind: saved.kind,
          media_count: saved.media.length,
          files: saved.media.map(({ name, size, kind }) => ({ name, size, kind }))
        }
      };
    } catch (error) {
      return { ok: false, reason: safeReason(error?.code, "moments_publish_snapshot_missing") };
    }
  }

  function workflowOutcome(taskId) {
    const id = String(taskId || "");
    if (!id) return null;
    const attempt = state.attempts.slice().reverse().find((item) => item.workflow_task_id === id);
    if (!attempt) return null;
    if (["verified", "resolved_published"].includes(attempt.status)) {
      return { status: "completed", progress: { done: 1, total: 1 } };
    }
    if (attempt.status === "resolved_not_published") {
      return { status: "not_published", progress: { done: 0, total: 1 } };
    }
    return null;
  }

  async function runWorkflowStep(taskRecord, runOptions = {}) {
    const result = (status, error, extra = {}) => ({
      status,
      progress: { done: status === "completed" ? 1 : 0, total: 1 },
      ...(error ? { error } : {}),
      ...extra
    });
    const isEnabled = typeof runOptions.isEnabled === "function" ? runOptions.isEnabled : () => false;
    if (!isEnabled()) return result("pending");
    if (inFlight || confirmationTask) return result("pending", "wechat_operation_busy");
    const execute = async () => {
      try {
        const saved = plannedSnapshot(taskRecord.id);
        if (!saved || saved.fingerprint !== taskRecord.payload?.fingerprint
          || saved.revision !== taskRecord.payload?.mediaRevision) {
          return result("needs_attention", "moments_publish_snapshot_changed");
        }
        const completed = state.attempts.find((attempt) => attempt.workflow_task_id === String(taskRecord.id)
          && attempt.fingerprint === saved.fingerprint
          && ["verified", "resolved_published"].includes(attempt.status));
        if (completed) return result("completed", "", { result: { verified: true, attemptId: completed.attempt_id } });
        const attempted = state.attempts.find((attempt) => attempt.workflow_task_id === String(taskRecord.id)
          && ["publishing", "outcome_unknown"].includes(attempt.status));
        if (attempted) return result("needs_attention", "moments_publish_outcome_unknown_requires_resolution");
        const response = await runDraft(saved, { isCurrent: isEnabled, workflowTaskId: String(taskRecord.id) });
        if (response?.verified) {
          return result("completed", "", { result: { verified: true, attemptId: response.state?.attempt_id } });
        }
        const reason = response?.reason || "moments_publish_failed";
        const pending = ["wechat_operation_busy", "workflow_paused"].includes(reason) && response?.actionAttempted !== true;
        return result(pending ? "pending" : "needs_attention", reason, {
          result: { actionAttempted: response?.actionAttempted === true, outcomeUnknown: response?.state?.outcome_unknown === true }
        });
      } catch (error) {
        return result("needs_attention", safeReason(error?.code, "moments_publish_workflow_failed"));
      }
    };
    const task = execute();
    confirmationTask = task;
    try {
      return await task;
    } finally {
      if (confirmationTask === task) confirmationTask = null;
    }
  }

  function finishSafeFailure(attemptId, reason, rawBreadcrumb = {}) {
    const finishedAt = isoNow();
    const breadcrumb = normalizeFailureBreadcrumb(rawBreadcrumb);
    const buttonSearch = normalizePublishButtonSearch(rawBreadcrumb.publishButtonSearch);
    preparedDraft = null;
    if ([
      "moments_publish_media_changed",
      "moments_publish_media_unavailable",
      "moments_publish_media_invalid",
      "moments_publish_selection_expired"
    ].includes(String(reason || ""))) {
      currentSelection = null;
    }
    persist({
      status: "failed",
      last_reason: safeReason(reason, "moments_publish_failed_before_action"),
      ...lastFailureBreadcrumb(breadcrumb),
      action_attempted: false,
      outcome_unknown: false,
      attempts: updateAttempt(attemptId, {
        status: "failed",
        action_attempted: false,
        reason: safeReason(reason, "moments_publish_failed_before_action"),
        ...breadcrumb,
        finished_at: finishedAt
      })
    });
    record("publish.failed_before_action", {
      ...require("../shared/wechat-window-diagnostics.cjs").sanitizeWechatWindowDiagnostics(rawBreadcrumb.diagnostics),
      attempt_id: attemptId,
      fingerprint: state.fingerprint,
      reason: state.last_reason,
      ...breadcrumb,
      ...(buttonSearch.length > 0 ? { button_search: buttonSearch } : {})
    }, "warn");
    return { ok: false, reason: state.last_reason, actionAttempted: false, state: snapshot() };
  }

  function finishUnknown(attemptId, reason, rawBreadcrumb = {}) {
    const finishedAt = isoNow();
    const fingerprint = state.fingerprint;
    const breadcrumb = normalizeFailureBreadcrumb(rawBreadcrumb);
    const verification = normalizeVerificationDiagnostics(rawBreadcrumb);
    clearSecrets();
    persist({
      status: "outcome_unknown",
      last_reason: safeReason(reason, "moments_publish_outcome_unknown"),
      ...lastFailureBreadcrumb(breadcrumb),
      ...verification,
      action_attempted: true,
      outcome_unknown: true,
      fingerprints: addFingerprintStatus(fingerprint, "outcome_unknown", attemptId, finishedAt),
      attempts: updateAttempt(attemptId, {
        status: "outcome_unknown",
        action_attempted: true,
        reason: safeReason(reason, "moments_publish_outcome_unknown"),
        ...breadcrumb,
        ...verification,
        finished_at: finishedAt
      })
    });
    record("publish.outcome_unknown", {
      ...require("../shared/wechat-window-diagnostics.cjs").sanitizeWechatWindowDiagnostics(rawBreadcrumb.diagnostics),
      attempt_id: attemptId,
      fingerprint,
      reason: state.last_reason,
      ...breadcrumb,
      ...verification
    }, "warn");
    return { ok: false, reason: state.last_reason, actionAttempted: true, state: snapshot() };
  }

  function finishVerified(attemptId, rawVerification = {}) {
    const verifiedAt = isoNow();
    const fingerprint = state.fingerprint;
    const completedMarkerName = state.marker_name;
    const verification = normalizeVerificationDiagnostics(rawVerification);
    clearSecrets();
    persist({
      status: "verified",
      last_reason: "moments_publish_verified",
      last_stage: "postpublish_verification",
      last_failure_kind: "",
      last_exception_category: "",
      last_exception_type: "",
      ...verification,
      action_attempted: true,
      outcome_unknown: false,
      verified_at: verifiedAt,
      fingerprints: addFingerprintStatus(fingerprint, "published", attemptId, verifiedAt),
      attempts: updateAttempt(attemptId, {
        status: "verified",
        action_attempted: true,
        reason: "moments_publish_verified",
        stage: "postpublish_verification",
        failure_kind: "",
        exception_category: "",
        exception_type: "",
        ...verification,
        finished_at: verifiedAt
      })
    });
    record("publish.verified", { attempt_id: attemptId, fingerprint, ...verification });
    removeMarker(completedMarkerName);
    return { ok: true, verified: true, actionAttempted: true, state: snapshot() };
  }

  async function executeAttempt({ attemptId, markerName, lockOwner, signal, draft }) {
    let driverResult = null;
    try {
      coordinator?.update?.(lockOwner, "moments:publish:open");
      const opened = await openMoments({
        signal,
        allowIntegrated: true,
        // The trusted confirmation click is expected user input. Do not feed
        // that same click into the background-idle gate and block the action
        // it just authorized; the publish driver still owns the input lease.
        minIdleMs: 0
      });
      if (!opened?.ok) {
        const openBreadcrumb = {
          ...opened,
          stage: "moments_open",
          failureKind: "navigation_result"
        };
        return markerExists(markerName)
          ? finishUnknown(attemptId, opened?.reason || "moments_publish_open_outcome_unknown", openBreadcrumb)
          : finishSafeFailure(attemptId, opened?.reason || "moments_publish_open_failed", openBreadcrumb);
      }
      if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "moments_publish_aborted" });
      coordinator?.update?.(lockOwner, "moments:publish:execute");
      driverResult = await publishDriver({
        expectedWindow: opened,
        content: draft.content,
        mediaPaths: draft.media.map((item) => item.path),
        mediaManifest: draft.media.map((item) => ({
          path: item.path,
          sha256: item.sha256,
          size: item.size,
          ext: item.ext
        })),
        mediaCount: draft.media.length,
        mediaKind: draft.kind,
        markerPath: markerPathFor(markerName),
        fingerprint: draft.fingerprint,
        attemptId,
        signal
      });
      const durableMarkerWritten = markerExists(markerName);
      const actionAttempted = driverResult?.actionAttempted === true
        || driverResult?.real_action_attempted === true
        || durableMarkerWritten;
      const verified = driverResult?.ok === true
        && (driverResult?.verified === true || driverResult?.status === "verified")
        && durableMarkerWritten;
      if (verified) return finishVerified(attemptId, driverResult);
      const reason = driverResult?.reason
        || driverResult?.blocked_reason
        || (actionAttempted ? "moments_publish_outcome_unknown" : "moments_publish_failed_before_action");
      const breadcrumb = {
        ...driverResult,
        failureKind: driverResult?.failureKind || driverResult?.failure_kind || "driver_result"
      };
      return actionAttempted
        ? finishUnknown(attemptId, reason, breadcrumb)
        : finishSafeFailure(attemptId, reason, breadcrumb);
    } catch (error) {
      const actionAttempted = error?.actionAttempted === true
        || error?.real_action_attempted === true
        || driverResult?.actionAttempted === true
        || driverResult?.real_action_attempted === true
        || markerExists(markerName);
      const reason = safeReason(error?.code, signal.aborted
        ? "moments_publish_aborted"
        : "moments_publish_failed");
      const breadcrumb = {
        stage: error?.stage || driverResult?.stage,
        failureKind: error?.failureKind || driverResult?.failureKind || "node_exception",
        exceptionCategory: error?.exceptionCategory,
        exceptionType: error?.exceptionType || error?.name
      };
      return actionAttempted
        ? finishUnknown(attemptId, reason, breadcrumb)
        : finishSafeFailure(attemptId, reason, breadcrumb);
    } finally {
      try {
        coordinator?.release?.(lockOwner);
      } catch {}
    }
  }

  async function runConfirmation(payload = {}) {
    if (disposed) return { ok: false, reason: "moments_publish_disposed", state: snapshot() };
    if (inFlight) return { ok: false, reason: "moments_publish_already_running", state: snapshot() };
    if (state.outcome_unknown) {
      return { ok: false, reason: "moments_publish_outcome_unknown_requires_resolution", state: snapshot() };
    }
    if (!preparedDraft || String(payload.confirmationId || "") !== preparedDraft.confirmationId) {
      return { ok: false, reason: "moments_publish_confirmation_required", state: snapshot() };
    }
    const confirmedDraft = preparedDraft;
    return runDraft(confirmedDraft, { isCurrent: () => preparedDraft === confirmedDraft });
  }

  async function runDraft(confirmedDraft, runOptions = {}) {
    const isCurrent = runOptions.isCurrent || (() => true);
    const invalidDraftReason = runOptions.workflowTaskId ? "workflow_paused" : "moments_publish_confirmation_required";
    if (disposed) return { ok: false, reason: "moments_publish_disposed", state: snapshot() };
    if (state.outcome_unknown) {
      return { ok: false, reason: "moments_publish_outcome_unknown_requires_resolution", state: snapshot() };
    }
    const blockedReason = fingerprintBlockReason(confirmedDraft.fingerprint);
    if (blockedReason) return { ok: false, reason: blockedReason, state: snapshot() };
    const refreshed = await inspectMediaPaths(confirmedDraft.media.map((item) => item.path));
    if (disposed) return { ok: false, reason: "moments_publish_disposed", state: snapshot() };
    if (inFlight) {
      return { ok: false, reason: "moments_publish_already_running", state: snapshot() };
    }
    if (!isCurrent()) return { ok: false, reason: invalidDraftReason, state: snapshot() };
    if (!refreshed.ok || !mediaDescriptorsEqual(confirmedDraft.media, refreshed.media)) {
      clearSecrets();
      persist({ status: "failed", last_reason: "moments_publish_media_changed" });
      return { ok: false, reason: "moments_publish_media_changed", state: snapshot() };
    }
    const refreshedFingerprint = buildPublishFingerprint(confirmedDraft.content, refreshed.media);
    if (refreshedFingerprint !== confirmedDraft.fingerprint) {
      clearSecrets();
      persist({ status: "failed", last_reason: "moments_publish_draft_changed" });
      return { ok: false, reason: "moments_publish_draft_changed", state: snapshot() };
    }
    let lock;
    try {
      lock = coordinator?.acquire?.({
        state: "running_moments",
        taskId: runOptions.workflowTaskId || `moments-publish-${Date.now()}`,
        account: "unknown",
        phase: "moments:publish"
      });
    } catch {
      return { ok: false, reason: "runtime_coordinator_failed", state: snapshot() };
    }
    if (!lock?.ok || !lock.lock?.owner) {
      return { ok: false, reason: safeReason(lock?.error, "wechat_operation_busy"), state: snapshot() };
    }
    const draft = confirmedDraft;
    const attemptId = crypto.randomUUID();
    const markerName = `${draft.fingerprint}.${attemptId}.json`;
    const attemptedAt = isoNow();
    const attempt = normalizeAttempt({
      attempt_id: attemptId,
      workflow_task_id: runOptions.workflowTaskId || "",
      fingerprint: draft.fingerprint,
      status: "publishing",
      action_attempted: false,
      reason: "moments_publish_started",
      marker_name: markerName,
      started_at: attemptedAt
    });
    const stateBeforePublishing = state;
    try {
      fs.mkdirSync(markerDir, { recursive: true });
      persist({
        status: "publishing",
        last_reason: "moments_publish_started",
        fingerprint: draft.fingerprint,
        attempt_id: attemptId,
        marker_name: markerName,
        media_count: draft.media.length,
        media_type: refreshed.kind,
        content_character_count: countOcrCharacters(draft.content),
        action_attempted: false,
        outcome_unknown: false,
        last_stage: "",
        last_failure_kind: "",
        last_exception_category: "",
        last_exception_type: "",
        verification_attempts: 0,
        verification_elapsed_ms: 0,
        last_verification_reason: "",
        attempted_at: attemptedAt,
        attempts: [...state.attempts, attempt].slice(-MAX_ATTEMPT_HISTORY)
      });
    } catch {
      state = stateBeforePublishing;
      try {
        coordinator?.release?.(lock.lock.owner);
      } catch {}
      return {
        ok: false,
        reason: "moments_publish_state_persist_failed",
        actionAttempted: false,
        state: snapshot()
      };
    }
    record("publish.started", { attempt_id: attemptId, fingerprint: draft.fingerprint });
    const staged = await stageMediaForAttempt(stagingRoot, attemptId, draft.media);
    if (!staged.ok || disposed || !isCurrent()) {
      removeStagingAttempt(stagingRoot, attemptId);
      const reason = disposed
        ? "moments_publish_disposed"
        : (!isCurrent() ? invalidDraftReason : staged.reason);
      const result = finishSafeFailure(attemptId, reason);
      try {
        coordinator?.release?.(lock.lock.owner);
      } catch {}
      return result;
    }
    const stagedDraft = {
      ...draft,
      kind: staged.kind,
      media: staged.media
    };
    activeAbortController = new AbortController();
    const execution = executeAttempt({
      attemptId,
      markerName,
      lockOwner: lock.lock.owner,
      signal: activeAbortController.signal,
      draft: stagedDraft
    });
    inFlight = execution;
    try {
      const result = await execution;
      if (!result?.state?.outcome_unknown) removeStagingAttempt(stagingRoot, attemptId);
      return result;
    } finally {
      if (inFlight === execution) inFlight = null;
      activeAbortController = null;
    }
  }

  async function confirm(payload = {}) {
    if (confirmationTask) {
      return { ok: false, reason: "moments_publish_already_running", state: snapshot() };
    }
    const task = runConfirmation(payload);
    confirmationTask = task;
    try {
      return await task;
    } finally {
      if (confirmationTask === task) confirmationTask = null;
    }
  }

  function reset() {
    if (disposed) return { ok: false, reason: "moments_publish_disposed", state: snapshot() };
    if (inFlight || confirmationTask) return { ok: false, reason: "moments_publish_already_running", state: snapshot() };
    if (state.outcome_unknown) {
      return { ok: false, reason: "moments_publish_outcome_unknown_requires_resolution", state: snapshot() };
    }
    removeStagingAttempt(stagingRoot, state.attempt_id);
    clearSecrets();
    persist({
      status: "idle",
      last_reason: "",
      fingerprint: "",
      attempt_id: "",
      marker_name: "",
      media_count: 0,
      media_type: "",
      content_character_count: 0,
      action_attempted: false,
      outcome_unknown: false,
      last_stage: "",
      last_failure_kind: "",
      last_exception_category: "",
      last_exception_type: "",
      verification_attempts: 0,
      verification_elapsed_ms: 0,
      last_verification_reason: "",
      prepared_at: "",
      attempted_at: "",
      verified_at: "",
      resolved_at: ""
    });
    return { ok: true, state: snapshot() };
  }

  function resolveUnknown(payload = {}) {
    if (inFlight || confirmationTask) {
      return { ok: false, reason: "moments_publish_already_running", state: snapshot() };
    }
    const fingerprint = safeFingerprint(payload.fingerprint || state.fingerprint);
    const resolution = String(payload.resolution || "");
    if (!state.outcome_unknown || !fingerprint || fingerprint !== state.fingerprint) {
      return { ok: false, reason: "moments_publish_unknown_not_found", state: snapshot() };
    }
    if (!["published", "not_published"].includes(resolution)) {
      return { ok: false, reason: "moments_publish_resolution_invalid", state: snapshot() };
    }
    const resolvedAt = isoNow();
    const resolvedAttemptId = state.attempt_id;
    const resolvedMarkerName = state.marker_name;
    const nextFingerprintStatus = resolution === "published" ? "published" : "not_published";
    const attemptStatus = resolution === "published" ? "resolved_published" : "resolved_not_published";
    if (resolution === "not_published" && markerExists(resolvedMarkerName)
      && !removeMarker(resolvedMarkerName)) {
      return { ok: false, reason: "moments_publish_marker_retire_failed", state: snapshot() };
    }
    persist({
      status: attemptStatus,
      last_reason: `moments_publish_${attemptStatus}`,
      outcome_unknown: false,
      resolved_at: resolvedAt,
      fingerprints: addFingerprintStatus(fingerprint, nextFingerprintStatus, state.attempt_id, resolvedAt),
      attempts: updateAttempt(state.attempt_id, {
        status: attemptStatus,
        reason: `moments_publish_${attemptStatus}`,
        resolved_at: resolvedAt
      })
    });
    record("publish.resolved", {
      attempt_id: resolvedAttemptId,
      fingerprint,
      resolution
    });
    if (resolution === "published") removeMarker(resolvedMarkerName);
    removeStagingAttempt(stagingRoot, resolvedAttemptId);
    return { ok: true, state: snapshot() };
  }

  function recoverUnknown(marker, reason) {
    const recoveredAt = isoNow();
    const rawAttemptId = String(marker?.attemptId || state.attempt_id || crypto.randomUUID());
    const attemptId = rawAttemptId
      .replace(/[^a-zA-Z0-9-]/gu, "")
      .slice(0, 80);
    const fingerprint = safeFingerprint(marker?.fingerprint || state.fingerprint)
      || crypto.createHash("sha256")
        .update(`moments-publish-recovery:${attemptId}`)
        .digest("hex");
    const markerName = path.basename(String(marker?.markerName || state.marker_name || "")).slice(0, 120);
    const existingAttempt = state.attempts.find((attempt) => attempt.attempt_id === attemptId);
    const recoveredAttempt = normalizeAttempt({
      ...existingAttempt,
      attempt_id: attemptId,
      fingerprint,
      status: "outcome_unknown",
      action_attempted: true,
      reason,
      marker_name: markerName,
      started_at: existingAttempt?.started_at || recoveredAt,
      finished_at: recoveredAt
    });
    const attempts = [
      ...state.attempts.filter((attempt) => attempt.attempt_id !== attemptId),
      recoveredAttempt
    ].filter((attempt) => attempt.attempt_id).slice(-MAX_ATTEMPT_HISTORY);
    persist({
      status: "outcome_unknown",
      last_reason: reason,
      fingerprint,
      attempt_id: attemptId,
      marker_name: markerName,
      action_attempted: true,
      outcome_unknown: true,
      fingerprints: fingerprint
        ? addFingerprintStatus(fingerprint, "outcome_unknown", attemptId, recoveredAt)
        : state.fingerprints,
      attempts
    });
    clearSecrets();
    record("publish.recovered_unknown", {
      attempt_id: attemptId,
      fingerprint,
      reason
    }, "warn");
    return { ok: true, state: snapshot() };
  }

  function initialize() {
    disposed = false;
    fs.mkdirSync(markerDir, { recursive: true });
    fs.mkdirSync(stagingRoot, { recursive: true });
    if (state.status === "publishing") {
      return recoverUnknown(null, "moments_publish_restarted_during_publish");
    }
    const orphan = orphanMarkers()[0];
    if (orphan) return recoverUnknown(orphan, "moments_publish_orphan_marker_recovered");
    if (["awaiting_confirmation", "prepared", "media_selected"].includes(state.status)) {
      clearSecrets();
      persist({
        status: "idle",
        last_reason: "moments_publish_selection_expired",
        fingerprint: "",
        attempt_id: "",
        marker_name: "",
        media_count: 0,
        media_type: "",
        content_character_count: 0,
        action_attempted: false,
        outcome_unknown: false,
        last_stage: "",
        last_failure_kind: "",
        last_exception_category: "",
        last_exception_type: "",
        prepared_at: "",
        attempted_at: "",
        verified_at: "",
        resolved_at: ""
      });
      return { ok: true, state: snapshot() };
    }
    if (!state.outcome_unknown) removeStagingAttempt(stagingRoot, state.attempt_id);
    return { ok: true, state: snapshot() };
  }

  async function dispose() {
    disposed = true;
    activeAbortController?.abort();
    const running = confirmationTask || inFlight;
    if (running) {
      try {
        await running;
      } catch {}
    }
  }

  return {
    chooseMedia,
    confirm,
    dispose,
    initialize,
    markerDir,
    prepare,
    prepareWorkflowTask,
    reset,
    resolveUnknown,
    runWorkflowStep,
    stagingRoot,
    stateFile,
    workflowDraft,
    workflowOutcome,
    status: () => ({ ok: true, state: snapshot() })
  };
}

function registerMomentsPublishIpc(options = {}) {
  const electron = options.electron || require("electron");
  const ipcMain = options.ipcMain || electron.ipcMain;
  const dialog = options.dialog || electron.dialog;
  const getMainWindow = typeof options.getMainWindow === "function" ? options.getMainWindow : () => null;
  const trustedClick = createTrustedClickValidator(getMainWindow);
  const controller = createMomentsPublishController({
    ...options,
    emit: (state) => {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send("moments-publish:update", state);
    }
  });

  function rejected() {
    return {
      ok: false,
      reason: "trusted_user_click_required",
      state: controller.status().state
    };
  }

  ipcMain.handle("moments-publish:status", () => controller.status());
  ipcMain.handle("moments-publish:choose-media", async (event, payload = {}) => {
    if (!trustedClick(event, payload.clickToken)) return rejected();
    const window = getMainWindow();
    const result = await dialog.showOpenDialog(window, {
      title: "选择朋友圈图片或视频",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "图片或视频", extensions: ["jpg", "jpeg", "png", "mp4", "mov"] }
      ]
    });
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { ok: false, reason: "moments_publish_media_selection_cancelled", state: controller.status().state };
    }
    return controller.chooseMedia(result.filePaths);
  });
  ipcMain.handle("moments-publish:prepare", (event, payload = {}) => {
    if (!trustedClick(event, payload.clickToken)) return rejected();
    return controller.prepare({ selectionId: payload.selectionId, content: payload.content });
  });
  ipcMain.handle("moments-publish:confirm", (event, payload = {}) => {
    if (!trustedClick(event, payload.clickToken)) return rejected();
    return controller.confirm({ confirmationId: payload.confirmationId || payload.draftId });
  });
  ipcMain.handle("moments-publish:reset", () => controller.reset());
  ipcMain.handle("moments-publish:resolve-unknown", (event, payload = {}) => {
    if (!trustedClick(event, payload.clickToken)) return rejected();
    return controller.resolveUnknown({ fingerprint: payload.fingerprint, resolution: payload.resolution });
  });
  return controller;
}

module.exports = {
  IMAGE_EXTENSIONS,
  MAX_CONTENT_LENGTH,
  MAX_IMAGE_COUNT,
  MIN_OCR_CHARACTER_COUNT,
  VIDEO_EXTENSIONS,
  buildPublishFingerprint,
  countOcrCharacters,
  createMomentsPublishController,
  createTrustedClickValidator,
  inspectMediaPaths,
  mediaContentDescriptorsEqual,
  mediaKindForExtension,
  normalizeContent,
  publicState,
  removeStagingAttempt,
  registerMomentsPublishIpc,
  stageMediaForAttempt,
  validateMediaDescriptors
};
