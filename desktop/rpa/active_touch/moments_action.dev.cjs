const crypto = require("node:crypto");
const {
  MAX_MOMENTS_COMMENT_LENGTH,
  momentsPostFingerprint
} = require("./moments_dry_run.dev.cjs");
const { loadState, saveState } = require("./state_machine.cjs");
const {
  COMMENT_READBACK_VERIFICATION_MODE,
  sanitizeCommentReadbackProof,
  validCommentReadbackProof
} = require("./moments_comment_readback_proof.dev.cjs");

const OBSERVATION_ID_PATTERN = /^[0-9a-f]{64}$/u;
const MOMENTS_DRY_RUN_TTL_MS = 300_000;
const MENU_STATES = Object.freeze(["赞", "取消", "取消赞"]);
const LIKED_MENU_STATES = Object.freeze(["取消", "取消赞"]);
const UIA_COMMENT_VERIFICATION_MODE = "exact_comment_count_increment_and_editor_completion";
const VISUAL_COMMENT_VERIFICATION_MODE = "unique_exact_ocr_candidate_and_stable_post_v1";
const VISUAL_COMMENT_VERIFICATION_LEVEL = "visible_exact";
const ENHANCED_COMMENT_VERIFICATION_LEVEL = "clipboard_exact";
const COMMENT_DRAFT_CHECK_VERIFICATION_MODE = "targeted_uia_value_roundtrip_and_unique_enabled_button_transition";
const VISUAL_COMMENT_DRAFT_CHECK_VERIFICATION_MODE = "visual_clipboard_ordinal_roundtrip_and_unique_enabled_button_transition";
const COMMENT_DRAFT_CHECK_VERIFICATION_MODES = new Set([
  COMMENT_DRAFT_CHECK_VERIFICATION_MODE,
  VISUAL_COMMENT_DRAFT_CHECK_VERIFICATION_MODE
]);
const NON_RETRYABLE_ATTEMPT_STATUSES = new Set([
  "prepared",
  "clicked",
  "verified",
  "outcome_unknown"
]);

function timestamp() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function createMomentsAttemptKey({ postFingerprint, action, commentText = "" } = {}) {
  return sha256(JSON.stringify({
    version: 1,
    postFingerprint: String(postFingerprint ?? ""),
    action: String(action ?? ""),
    commentText: String(commentText ?? "")
  }));
}

function preparedSnapshotIsFresh(preparedAtMs) {
  const ageMs = Date.now() - preparedAtMs;
  return Number.isFinite(preparedAtMs) && ageMs >= 0 && ageMs <= MOMENTS_DRY_RUN_TTL_MS;
}

function actionState(state) {
  const current = state?.moments_test_action ?? {};
  return {
    version: 1,
    ...current,
    attempts: { ...(current.attempts ?? {}) }
  };
}

function withActionState(state, patch = {}) {
  const current = actionState(state);
  return {
    ...state,
    moments_test_action: {
      ...current,
      ...patch,
      attempts: patch.attempts ?? current.attempts,
      updated_at: timestamp()
    }
  };
}

function safeDriverReason(result) {
  const reason = String(result?.reason ?? "").trim();
  return /^[a-z0-9][a-z0-9_:-]{0,99}$/u.test(reason) ? reason : "";
}

const VISUAL_READBACK_CANDIDATE_REASONS = new Set([
  "moments_comment_candidate_not_requested",
  "moments_comment_candidate_region_invalid",
  "moments_comment_candidate_ocr_unavailable",
  "moments_comment_candidate_not_found",
  "moments_comment_candidate_ambiguous",
  "moments_comment_candidate_outside_window",
  "moments_comment_candidate_hash_failed"
]);

function sanitizeVisualCommentReadbackDiagnostics(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const sanitized = {};
  for (const [source, target] of [
    ["composerCompleted", "composer_completed"],
    ["anchorStable", "anchor_stable"],
    ["menuStable", "menu_stable"],
    ["candidateHashStable", "candidate_hash_stable"],
    ["candidateExactMatch", "candidate_exact_match"],
    ["candidateStable", "candidate_stable"]
  ]) {
    if (typeof raw[source] === "boolean") sanitized[target] = raw[source];
  }
  for (const [source, target] of [
    ["menuMatchCount", "menu_match_count"],
    ["candidateCount", "candidate_count"]
  ]) {
    if (Number.isSafeInteger(raw[source]) && raw[source] >= 0 && raw[source] <= 100) {
      sanitized[target] = raw[source];
    }
  }
  if (VISUAL_READBACK_CANDIDATE_REASONS.has(raw.candidateReason)) {
    sanitized.candidate_reason = raw.candidateReason;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function blockedResult(action, reason, extras = {}) {
  return {
    ok: false,
    action,
    status: "blocked",
    blocked_reason: reason,
    real_action_attempted: false,
    ...extras
  };
}

function persistBlocked(baseDir, state, action, observationId, reason, extras = {}) {
  if (state) {
    try {
      saveState(baseDir, withActionState(state, {
        action,
        status: "blocked",
        observation_id: observationId,
        blocked_reason: reason,
        real_action_attempted: false,
        menu_state: undefined,
        no_op: undefined,
        attempt_key: undefined,
        previous_attempt_key: undefined,
        candidate_attempt_key: undefined,
        previous_status: undefined,
        ...extras
      }));
    } catch {
      return blockedResult(action, "moments_action_state_persist_failed", extras);
    }
  }
  return blockedResult(action, reason, extras);
}

function validBounds(bounds, minimumWidth = 0, minimumHeight = 0) {
  const values = [bounds?.left, bounds?.top, bounds?.width, bounds?.height].map(Number);
  return values.every(Number.isFinite) && values[2] > minimumWidth && values[3] > minimumHeight;
}

function validStrictBounds(bounds, minimumWidth = 0, minimumHeight = 0) {
  return bounds !== null
    && typeof bounds === "object"
    && [bounds.left, bounds.top, bounds.width, bounds.height].every((value) => typeof value === "number" && Number.isFinite(value))
    && bounds.width > minimumWidth
    && bounds.height > minimumHeight;
}

function boundsWithin(inner, outer) {
  return validStrictBounds(inner)
    && validStrictBounds(outer)
    && inner.left >= outer.left
    && inner.top >= outer.top
    && inner.left + inner.width <= outer.left + outer.width
    && inner.top + inner.height <= outer.top + outer.height;
}

function lockedWindowIdentityKind(window) {
  const commonRoot = window?.title === "朋友圈"
    && ["Weixin", "WeChat"].includes(window?.processName)
    && window?.rootName === "朋友圈"
    && window?.rootControlType === "ControlType.Window"
    && Number(window?.rootProcessId) === Number(window?.pid);
  if (!commonRoot) return "";

  const uiaFeed = window?.feedAutomationId === "sns_list"
    && window?.feedCount === 1
    && Boolean(String(window?.feedRuntimeId ?? "").trim());
  if (uiaFeed && window.identityMode === "automation_id" && window.automationId === "SNSWindow") return "uia";
  if (uiaFeed && window.identityMode === "structural_sns_feed" && window.automationId === "") return "uia";

  const visualWindowBounds = {
    left: window?.left,
    top: window?.top,
    width: window?.width,
    height: window?.height
  };
  const visualIdentity = window?.identityMode === "visual_mmui_render"
    && window?.automationId === ""
    && Number.isInteger(window?.pid)
    && window.pid > 0
    && typeof window?.hWnd === "string"
    && window.rootProcessId === window.pid
    && window?.feedAutomationId === ""
    && window?.feedRuntimeId === ""
    && window?.feedCount === 0
    && window?.renderPaneName === "MMUIRenderSubWindowHW"
    && typeof window?.renderPaneAutomationId === "string"
    && window?.renderPaneControlType === "ControlType.Pane"
    && window?.renderPaneProcessId === window.pid
    && typeof window?.renderPaneRuntimeId === "string"
    && Boolean(window.renderPaneRuntimeId.trim())
    && validStrictBounds(visualWindowBounds, 299, 299)
    && boundsWithin(window?.renderPaneBounds, visualWindowBounds);
  return visualIdentity ? "visual" : "";
}

function validLockedWindowIdentity(window) {
  return Boolean(lockedWindowIdentityKind(window));
}

function expectedObservationId(window, snapshot) {
  if (window?.identityMode === "visual_mmui_render" && snapshot?.source === "visual:windows_media_ocr") {
    const payload = JSON.stringify({
      version: 5,
      pid: Number(window.pid),
      hWnd: String(window.hWnd),
      windowBounds: {
        left: Number(window.left),
        top: Number(window.top),
        width: Number(window.width),
        height: Number(window.height)
      },
      windowAutomationId: String(window.automationId ?? ""),
      windowIdentityMode: String(window.identityMode ?? ""),
      windowRootName: String(window.rootName ?? ""),
      windowRootControlType: String(window.rootControlType ?? ""),
      windowRootProcessId: Number(window.rootProcessId),
      windowFeedAutomationId: String(window.feedAutomationId ?? ""),
      windowFeedRuntimeId: String(window.feedRuntimeId ?? ""),
      windowFeedCount: Number(window.feedCount),
      windowRenderPaneName: String(window.renderPaneName ?? ""),
      windowRenderPaneAutomationId: String(window.renderPaneAutomationId ?? ""),
      windowRenderPaneControlType: String(window.renderPaneControlType ?? ""),
      windowRenderPaneProcessId: Number(window.renderPaneProcessId),
      windowRenderPaneRuntimeId: String(window.renderPaneRuntimeId ?? ""),
      windowRenderPaneBounds: {
        left: Number(window.renderPaneBounds?.left),
        top: Number(window.renderPaneBounds?.top),
        width: Number(window.renderPaneBounds?.width),
        height: Number(window.renderPaneBounds?.height)
      },
      source: String(snapshot.source ?? ""),
      identityScope: String(snapshot.identity_scope ?? ""),
      structureVerified: snapshot.structure_verified === true,
      ocrProvider: String(snapshot.ocr_provider ?? ""),
      ocrLanguage: String(snapshot.ocr_language ?? ""),
      regionHash: String(snapshot.region_hash ?? ""),
      avatarHash: String(snapshot.avatar_hash ?? ""),
      layoutHash: String(snapshot.layout_hash ?? ""),
      label: String(snapshot.label ?? ""),
      identityText: String(snapshot.identity_text ?? ""),
      postFingerprint: String(snapshot.post_fingerprint ?? ""),
      bounds: {
        left: Number(snapshot.bounds?.left),
        top: Number(snapshot.bounds?.top),
        width: Number(snapshot.bounds?.width),
        height: Number(snapshot.bounds?.height)
      },
      menuBounds: {
        left: Number(snapshot.menu_bounds?.left),
        top: Number(snapshot.menu_bounds?.top),
        width: Number(snapshot.menu_bounds?.width),
        height: Number(snapshot.menu_bounds?.height)
      },
      avatarBounds: {
        left: Number(snapshot.avatar_bounds?.left),
        top: Number(snapshot.avatar_bounds?.top),
        width: Number(snapshot.avatar_bounds?.width),
        height: Number(snapshot.avatar_bounds?.height)
      }
    });
    return sha256(payload);
  }

  const payload = JSON.stringify({
    version: 2,
    pid: Number(window.pid),
    hWnd: String(window.hWnd),
    windowBounds: {
      left: Number(window.left),
      top: Number(window.top),
      width: Number(window.width),
      height: Number(window.height)
    },
    windowAutomationId: String(window.automationId ?? ""),
    windowIdentityMode: String(window.identityMode ?? ""),
    windowRootName: String(window.rootName ?? ""),
    windowRootControlType: String(window.rootControlType ?? ""),
    windowRootProcessId: Number(window.rootProcessId),
    windowFeedAutomationId: String(window.feedAutomationId ?? ""),
    windowFeedRuntimeId: String(window.feedRuntimeId ?? ""),
    windowFeedCount: Number(window.feedCount),
    runtimeId: String(snapshot.runtime_id ?? ""),
    automationId: String(snapshot.automation_id ?? ""),
    feedDepth: Number(snapshot.feed_depth),
    label: String(snapshot.label ?? ""),
    postFingerprint: String(snapshot.post_fingerprint ?? ""),
    bounds: {
      left: Number(snapshot.bounds?.left),
      top: Number(snapshot.bounds?.top),
      width: Number(snapshot.bounds?.width),
      height: Number(snapshot.bounds?.height)
    }
  });
  return sha256(payload);
}

function loadLockedContext(baseDir, suppliedObservationId) {
  let state;
  try {
    state = loadState(baseDir);
  } catch {
    return { ok: false, reason: "moments_action_state_unreadable" };
  }

  const observationId = String(suppliedObservationId ?? "").trim();
  const dryRun = state.moments_dry_run;
  const snapshot = dryRun?.post_snapshot;
  const window = dryRun?.window;
  if (dryRun?.status !== "prepared" || !snapshot || !window) {
    return { ok: false, state, observationId, reason: "moments_dry_run_not_prepared" };
  }
  const preparedAtMs = Date.parse(String(dryRun.prepared_at ?? ""));
  if (!preparedSnapshotIsFresh(preparedAtMs)) {
    return { ok: false, state, observationId, reason: "moments_dry_run_expired" };
  }
  if (!OBSERVATION_ID_PATTERN.test(observationId)) {
    return { ok: false, state, observationId, reason: "moments_observation_id_invalid" };
  }
  if (observationId !== snapshot.observation_id) {
    return { ok: false, state, observationId, reason: "moments_observation_id_mismatch" };
  }

  const identityKind = lockedWindowIdentityKind(window);
  const windowValid = validLockedWindowIdentity(window)
    && Number.isInteger(Number(window.pid))
    && Number(window.pid) > 0
    && /^[1-9]\d*$/u.test(String(window.hWnd ?? ""))
    && validBounds(window, 299, 299);
  const uiaSnapshotValid = snapshot.source === "uia:sns_list"
    && snapshot.identity_scope === "window_session_only"
    && snapshot.structure_verified === true
    && Boolean(String(snapshot.runtime_id ?? "").trim())
    && Number.isInteger(Number(snapshot.feed_depth))
    && Number(snapshot.feed_depth) >= 1
    && Number(snapshot.feed_depth) <= 16
    && Boolean(String(snapshot.label ?? ""))
    && String(snapshot.label).length <= 2000
    && OBSERVATION_ID_PATTERN.test(String(snapshot.post_fingerprint ?? ""))
    && momentsPostFingerprint(snapshot.label) === snapshot.post_fingerprint
    && validBounds(snapshot.bounds);
  const visualWindowBounds = {
    left: window?.left,
    top: window?.top,
    width: window?.width,
    height: window?.height
  };
  const visualSnapshotValid = snapshot.source === "visual:windows_media_ocr"
    && snapshot.identity_scope === "window_session_only"
    && snapshot.structure_verified === true
    && snapshot.ocr_provider === "windows_media_ocr"
    && snapshot.ocr_language === "zh-Hans-CN"
    && typeof snapshot.region_hash === "string"
    && OBSERVATION_ID_PATTERN.test(snapshot.region_hash)
    && typeof snapshot.avatar_hash === "string"
    && OBSERVATION_ID_PATTERN.test(snapshot.avatar_hash)
    && typeof snapshot.layout_hash === "string"
    && OBSERVATION_ID_PATTERN.test(snapshot.layout_hash)
    && typeof snapshot.label === "string"
    && Boolean(snapshot.label.trim())
    && snapshot.label.length <= 2000
    && typeof snapshot.identity_text === "string"
    && Boolean(snapshot.identity_text.trim())
    && snapshot.identity_text.length <= 2000
    && typeof snapshot.post_fingerprint === "string"
    && OBSERVATION_ID_PATTERN.test(snapshot.post_fingerprint)
    && momentsPostFingerprint(snapshot.identity_text) === snapshot.post_fingerprint
    && boundsWithin(snapshot.bounds, visualWindowBounds)
    && boundsWithin(snapshot.menu_bounds, visualWindowBounds)
    && boundsWithin(snapshot.avatar_bounds, visualWindowBounds);
  const snapshotValid = identityKind === "uia"
    ? uiaSnapshotValid
    : identityKind === "visual" && visualSnapshotValid;
  if (!windowValid || !snapshotValid || expectedObservationId(window, snapshot) !== observationId) {
    return { ok: false, state, observationId, reason: "moments_observation_snapshot_invalid" };
  }

  return {
    ok: true,
    state,
    dryRun,
    observationId,
    postFingerprint: snapshot.post_fingerprint,
    preparedAtMs,
    expectedWindow: JSON.parse(JSON.stringify(window)),
    postSnapshot: JSON.parse(JSON.stringify(snapshot))
  };
}

function resolveDriver(injectedDriver, context) {
  if (injectedDriver && typeof injectedDriver === "object") return injectedDriver;
  // The real driver is test-edition-only and is intentionally loaded only when an action reaches it.
  if (
    context?.expectedWindow?.identityMode === "visual_mmui_render"
    && context?.postSnapshot?.source === "visual:windows_media_ocr"
  ) {
    return require("./moments_visual_action_driver.dev.cjs");
  }
  return require("./moments_action_driver.dev.cjs");
}

function driverContext(context, action, phase, attemptKey = "", commentText = "") {
  return {
    action,
    phase,
    expectedWindow: context.expectedWindow,
    postSnapshot: context.postSnapshot,
    observationId: context.observationId,
    postFingerprint: context.postFingerprint,
    deadlineMs: context.preparedAtMs + MOMENTS_DRY_RUN_TTL_MS,
    attemptKey,
    commentText
  };
}

function requiresVisualCommentVerification(context) {
  return context?.expectedWindow?.identityMode === "visual_mmui_render"
    && context?.postSnapshot?.source === "visual:windows_media_ocr";
}

function validVisualCommentSendResult(result, context, attemptKey, commentText) {
  return result?.ok === true
    && result.status === "visible_verified"
    && result.actionAttempted === true
    && result.observationId === context.observationId
    && result.commentText === commentText
    && result.readbackSeed?.attemptKey === attemptKey
    && result.readbackSeed !== null
    && typeof result.readbackSeed === "object";
}

function validVisualCommentCandidateResult(result, context, attemptKey, commentText) {
  const seed = result?.readbackSeed;
  const diagnostics = result?.diagnostics;
  const expectedWindow = context?.expectedWindow;
  const candidateBounds = seed?.candidateBounds;
  const finiteBounds = (bounds) => bounds !== null
    && typeof bounds === "object"
    && ["left", "top", "width", "height"].every((key) => Number.isFinite(bounds[key]))
    && bounds.width >= 2
    && bounds.height >= 2;
  const candidateInsideWindow = finiteBounds(candidateBounds)
    && Number.isFinite(expectedWindow?.width)
    && Number.isFinite(expectedWindow?.height)
    && candidateBounds.left >= 0
    && candidateBounds.top >= 0
    && candidateBounds.left + candidateBounds.width <= expectedWindow.width
    && candidateBounds.top + candidateBounds.height <= expectedWindow.height;
  return validVisualCommentSendResult(result, context, attemptKey, commentText)
    && result.commentVerified === true
    && result.verificationMode === VISUAL_COMMENT_VERIFICATION_MODE
    && result.verificationLevel === VISUAL_COMMENT_VERIFICATION_LEVEL
    && result.normalizedOcrCountBefore === 0
    && result.normalizedOcrCountAfter === 1
    && seed.version === 1
    && seed.observationId === context.observationId
    && seed.attemptKey === attemptKey
    && seed.postFingerprint === context.postFingerprint
    && seed.commentTextSha256 === sha256(commentText)
    && /^[0-9a-f]{64}$/u.test(String(seed.candidatePixelHash ?? ""))
    && /^[0-9a-f]{64}$/u.test(String(seed.avatarHash ?? ""))
    && candidateInsideWindow
    && diagnostics !== null
    && typeof diagnostics === "object"
    && diagnostics.composerCompleted === true
    && diagnostics.anchorStable === true
    && diagnostics.menuStable === true
    && diagnostics.menuMatchCount === 1
    && diagnostics.candidateCount === 1
    && diagnostics.candidateExactMatch === true
    && diagnostics.candidateHashStable === true
    && diagnostics.candidateStable === true;
}

async function readbackVisualComment(driver, context, attemptKey, commentText, sendResult) {
  if (!validVisualCommentSendResult(sendResult, context, attemptKey, commentText)) {
    return { ok: false, reason: "moments_comment_readback_seed_invalid" };
  }
  if (typeof driver?.commentReadback !== "function") {
    return { ok: false, reason: "moments_comment_readback_driver_unavailable" };
  }
  let result;
  try {
    result = await Promise.resolve(driver.commentReadback({
      ...driverContext(context, "comment", "readback", attemptKey, commentText),
      readbackSeed: sendResult.readbackSeed
    }));
  } catch {
    return { ok: false, reason: "moments_comment_readback_driver_failed" };
  }
  const sanitized = sanitizeCommentReadbackProof(result);
  if (!validCommentReadbackProof(sanitized, {
    observationId: context.observationId,
    commentText
  })) {
    return {
      ok: false,
      reason: safeDriverReason(result) || "moments_comment_readback_proof_invalid",
      proof: sanitized?.proof
    };
  }
  return { ok: true, result: sanitized };
}

function validMenuProof(result, observationId) {
  return result?.ok === true
    && result.observationId === observationId
    && MENU_STATES.includes(result.menuState);
}

async function inspectWithDriver(driver, context, action, attemptKey = "", commentText = "") {
  if (typeof driver?.inspectMenu !== "function") {
    return { ok: false, reason: "moments_menu_driver_unavailable" };
  }
  let result;
  try {
    result = await Promise.resolve(driver.inspectMenu(driverContext(
      context,
      action,
      "before",
      attemptKey,
      commentText
    )));
  } catch {
    return { ok: false, reason: "moments_menu_driver_failed" };
  }
  if (!validMenuProof(result, context.observationId)) {
    return {
      ok: false,
      reason: safeDriverReason(result) || "moments_menu_proof_invalid"
    };
  }
  return { ok: true, menuState: result.menuState };
}

async function inspectCommentDraftWithDriver(driver, context, commentText) {
  if (typeof driver?.inspectCommentDraft !== "function") {
    return { ok: false, reason: "moments_comment_editor_targeting_unsupported" };
  }
  let result;
  try {
    result = await Promise.resolve(driver.inspectCommentDraft(driverContext(
      context,
      "comment",
      "draft_check",
      "",
      commentText
    )));
  } catch {
    return { ok: false, reason: "moments_comment_draft_check_failed" };
  }
  if (
    result?.ok !== true
    || result.status !== "comment_draft_verified"
    || result.actionAttempted !== false
    || result.commentStatus !== "draft_verified"
    || result.observationId !== context.observationId
    || result.commentText !== commentText
    || !COMMENT_DRAFT_CHECK_VERIFICATION_MODES.has(result.verificationMode)
  ) {
    return {
      ok: false,
      reason: safeDriverReason(result) || "moments_comment_draft_proof_invalid"
    };
  }
  return { ok: true, verificationMode: result.verificationMode };
}

async function inspectMomentsMenu(options = {}) {
  const baseDir = options.baseDir || __dirname;
  const action = "moments-menu-inspect";
  const context = loadLockedContext(baseDir, options.observationId ?? options.observation_id);
  if (!context.ok) {
    return persistBlocked(baseDir, context.state, action, context.observationId, context.reason);
  }

  let driver;
  try {
    driver = resolveDriver(options.driver, context);
  } catch {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_menu_driver_unavailable");
  }

  let commentText = "";
  if (context.dryRun.comment_enabled === true) {
    commentText = String(context.dryRun.comment_text ?? "");
    if (!commentText || commentText.length > MAX_MOMENTS_COMMENT_LENGTH) {
      return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_missing");
    }
    if (typeof driver?.inspectCommentDraft !== "function") {
      return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_editor_targeting_unsupported");
    }
  }

  const inspected = await inspectWithDriver(driver, context, "inspect");
  if (!inspected.ok) {
    return persistBlocked(baseDir, context.state, action, context.observationId, inspected.reason);
  }

  let commentDraftCheck = null;
  if (context.dryRun.comment_enabled === true) {
    commentDraftCheck = await inspectCommentDraftWithDriver(driver, context, commentText);
    if (!commentDraftCheck.ok) {
      return persistBlocked(baseDir, context.state, action, context.observationId, commentDraftCheck.reason, {
        menu_state: inspected.menuState
      });
    }
  }
  const commentSendSupported = context.dryRun.comment_enabled === true
    && (options.driver ? typeof driver?.comment === "function" : requiresVisualCommentVerification(context));

  const nextState = withActionState(context.state, {
    action,
    status: "verified",
    observation_id: context.observationId,
    menu_state: inspected.menuState,
    no_op: undefined,
    real_action_attempted: false,
    attempt_key: undefined,
    previous_attempt_key: undefined,
    candidate_attempt_key: undefined,
    previous_status: undefined,
    blocked_reason: "",
    last_menu_inspection: {
      observation_id: context.observationId,
      menu_state: inspected.menuState,
      comment_draft_verified: commentDraftCheck?.ok === true,
      comment_draft_verification_mode: commentDraftCheck?.verificationMode ?? "",
      comment_send_supported: commentSendSupported,
      verified_at: timestamp()
    }
  });
  try {
    saveState(baseDir, nextState);
  } catch {
    return blockedResult(action, "moments_action_state_persist_failed");
  }
  return {
    ok: true,
    action,
    status: "verified",
    observation_id: context.observationId,
    menu_state: inspected.menuState,
    comment_draft_verified: commentDraftCheck?.ok === true,
    comment_draft_verification_mode: commentDraftCheck?.verificationMode ?? "",
    comment_send_supported: commentSendSupported,
    real_action_attempted: false
  };
}

function existingAttempt(context, attemptKey) {
  const attempt = actionState(context.state).attempts[attemptKey];
  return attempt && NON_RETRYABLE_ATTEMPT_STATUSES.has(attempt.status) ? attempt : null;
}

function existingExactCommentAttempt(context, commentText) {
  const attempts = Object.entries(actionState(context.state).attempts).reverse();
  for (const [attemptKey, attempt] of attempts) {
    if (
      attempt?.action === "moments-comment"
      && attempt.post_fingerprint === context.postFingerprint
      && attempt.comment_text === commentText
      && NON_RETRYABLE_ATTEMPT_STATUSES.has(attempt.status)
    ) return { attemptKey, attempt };
  }
  return null;
}

function duplicateAttemptResult(baseDir, context, action, attemptKey, attempt) {
  return persistBlocked(
    baseDir,
    context.state,
    action,
    context.observationId,
    "moments_attempt_already_recorded",
    { attempt_key: attemptKey, previous_status: attempt.status }
  );
}

function duplicateCommentTextResult(baseDir, context, action, candidateAttemptKey, previous) {
  return persistBlocked(
    baseDir,
    context.state,
    action,
    context.observationId,
    "moments_comment_text_already_attempted",
    {
      attempt_key: previous.attemptKey,
      previous_attempt_key: previous.attemptKey,
      candidate_attempt_key: candidateAttemptKey,
      previous_status: previous.attempt.status
    }
  );
}

function persistAttempt(baseDir, state, details, status, resultPatch = {}) {
  const current = actionState(state);
  const previous = current.attempts[details.attemptKey] ?? {};
  const statusTime = `${status}_at`;
  const attempt = {
    ...previous,
    action: details.action,
    observation_id: details.observationId,
    post_fingerprint: details.postFingerprint,
    comment_text: details.commentText,
    status,
    [statusTime]: timestamp(),
    ...resultPatch
  };
  const nextState = withActionState(state, {
    action: details.action,
    status,
    observation_id: details.observationId,
    attempt_key: details.attemptKey,
    previous_attempt_key: undefined,
    candidate_attempt_key: undefined,
    previous_status: undefined,
    menu_state: status === "prepared"
      ? (resultPatch.menu_state ?? resultPatch.menu_state_before ?? attempt.menu_state_before)
      : resultPatch.menu_state,
    no_op: Object.prototype.hasOwnProperty.call(resultPatch, "no_op")
      ? resultPatch.no_op
      : undefined,
    real_action_attempted: Object.prototype.hasOwnProperty.call(resultPatch, "real_action_attempted")
      ? resultPatch.real_action_attempted
      : undefined,
    blocked_reason: status === "outcome_unknown" ? (resultPatch.reason || "moments_action_outcome_unknown") : "",
    attempts: { ...current.attempts, [details.attemptKey]: attempt }
  });
  saveState(baseDir, nextState);
  return nextState;
}

function outcomeUnknownResult(action, details, driverResult, attempted) {
  return {
    ok: false,
    action,
    status: "outcome_unknown",
    blocked_reason: `${action}_outcome_unknown`,
    driver_reason: safeDriverReason(driverResult) || undefined,
    observation_id: details.observationId,
    attempt_key: details.attemptKey,
    real_action_attempted: attempted
  };
}

function persistenceBlockedResult(action, details) {
  return blockedResult(action, "moments_action_state_persist_failed", {
    observation_id: details.observationId,
    attempt_key: details.attemptKey
  });
}

async function executeMomentsLike(options = {}) {
  const baseDir = options.baseDir || __dirname;
  const action = "moments-like";
  const context = loadLockedContext(baseDir, options.observationId ?? options.observation_id);
  if (!context.ok) return persistBlocked(baseDir, context.state, action, context.observationId, context.reason);
  if (context.dryRun.like_enabled !== true) {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_like_not_in_dry_run");
  }

  const attemptKey = createMomentsAttemptKey({ postFingerprint: context.postFingerprint, action: "like" });
  const details = {
    action,
    observationId: context.observationId,
    postFingerprint: context.postFingerprint,
    attemptKey,
    commentText: ""
  };
  const previous = existingAttempt(context, attemptKey);
  if (previous) return duplicateAttemptResult(baseDir, context, action, attemptKey, previous);

  let driver;
  try {
    driver = resolveDriver(options.driver, context);
  } catch {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_like_driver_unavailable", { attempt_key: attemptKey });
  }
  if (typeof driver.like !== "function") {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_like_driver_unavailable", { attempt_key: attemptKey });
  }
  const inspected = await inspectWithDriver(driver, context, "like", attemptKey);
  if (!inspected.ok) {
    return persistBlocked(baseDir, context.state, action, context.observationId, inspected.reason, { attempt_key: attemptKey });
  }
  if (!preparedSnapshotIsFresh(context.preparedAtMs)) {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_dry_run_expired", { attempt_key: attemptKey });
  }

  if (LIKED_MENU_STATES.includes(inspected.menuState)) {
    try {
      persistAttempt(baseDir, context.state, details, "verified", {
        menu_state: inspected.menuState,
        no_op: true,
        real_action_attempted: false
      });
    } catch {
      return persistenceBlockedResult(action, details);
    }
    return {
      ok: true,
      action,
      status: "verified",
      observation_id: context.observationId,
      attempt_key: attemptKey,
      menu_state: inspected.menuState,
      no_op: true,
      real_action_attempted: false
    };
  }

  try {
    persistAttempt(baseDir, context.state, details, "prepared", {
      menu_state_before: "赞",
      real_action_attempted: false
    });
  } catch {
    return persistenceBlockedResult(action, details);
  }

  let result;
  try {
    result = await Promise.resolve(driver.like(driverContext(context, "like", "execute", attemptKey)));
  } catch {
    try {
      persistAttempt(baseDir, loadState(baseDir), details, "outcome_unknown", {
        reason: "moments_like_driver_failed",
        real_action_attempted: null
      });
    } catch {}
    return outcomeUnknownResult(action, details, { reason: "moments_like_driver_failed" }, null);
  }

  const attempted = typeof result?.actionAttempted === "boolean" ? result.actionAttempted : null;
  let persistedState = loadState(baseDir);
  if (attempted === true) {
    try {
      persistedState = persistAttempt(baseDir, persistedState, details, "clicked", {
        real_action_attempted: true
      });
    } catch {
      return outcomeUnknownResult(action, details, { reason: "moments_action_state_persist_failed" }, true);
    }
  }
  if (result?.ok === false && attempted === false) {
    const reason = safeDriverReason(result) || "moments_like_blocked_before_click";
    try {
      persistAttempt(baseDir, persistedState, details, "prepared", {
        reason,
        real_action_attempted: false
      });
    } catch {
      return persistenceBlockedResult(action, details);
    }
    return blockedResult(action, reason, {
      observation_id: context.observationId,
      attempt_key: attemptKey,
      previous_status: "prepared",
      retry_locked: true
    });
  }
  const verified = result?.ok === true
    && result.observationId === context.observationId
    && LIKED_MENU_STATES.includes(result.menuState)
    && (attempted === true || attempted === false);
  if (!verified) {
    try {
      persistAttempt(baseDir, persistedState, details, "outcome_unknown", {
        reason: safeDriverReason(result) || "moments_like_proof_invalid",
        real_action_attempted: attempted
      });
    } catch {}
    return outcomeUnknownResult(action, details, result, attempted);
  }

  const noOp = attempted === false;
  try {
    persistAttempt(baseDir, persistedState, details, "verified", {
      menu_state: result.menuState,
      no_op: noOp,
      real_action_attempted: attempted
    });
  } catch {
    return outcomeUnknownResult(action, details, { reason: "moments_action_state_persist_failed" }, attempted);
  }
  return {
    ok: true,
    action,
    status: "verified",
    observation_id: context.observationId,
    attempt_key: attemptKey,
    menu_state: result.menuState,
    no_op: noOp,
    real_action_attempted: attempted
  };
}

async function executeMomentsComment(options = {}) {
  const baseDir = options.baseDir || __dirname;
  const action = "moments-comment";
  const context = loadLockedContext(baseDir, options.observationId ?? options.observation_id);
  if (!context.ok) return persistBlocked(baseDir, context.state, action, context.observationId, context.reason);

  const commentText = String(options.commentText ?? "");
  if (!commentText) {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_exact_text_required");
  }
  if (commentText.length > MAX_MOMENTS_COMMENT_LENGTH) {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_too_long");
  }
  if (context.dryRun.comment_enabled !== true || context.dryRun.comment_text !== commentText) {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_not_in_dry_run");
  }
  if (!options.driver && !requiresVisualCommentVerification(context)) {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_send_targeting_unsupported");
  }

  const attemptKey = createMomentsAttemptKey({
    postFingerprint: context.postFingerprint,
    action: "comment",
    commentText
  });
  const details = {
    action,
    observationId: context.observationId,
    postFingerprint: context.postFingerprint,
    attemptKey,
    commentText
  };
  const previousExactComment = existingExactCommentAttempt(context, commentText);
  if (previousExactComment) {
    return duplicateCommentTextResult(baseDir, context, action, attemptKey, previousExactComment);
  }
  const previous = existingAttempt(context, attemptKey);
  if (previous) return duplicateAttemptResult(baseDir, context, action, attemptKey, previous);

  let driver;
  try {
    driver = resolveDriver(options.driver, context);
  } catch {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_driver_unavailable", { attempt_key: attemptKey });
  }
  if (typeof driver.comment !== "function") {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_driver_unavailable", { attempt_key: attemptKey });
  }
  const inspected = await inspectWithDriver(driver, context, "comment", attemptKey, commentText);
  if (!inspected.ok) {
    return persistBlocked(baseDir, context.state, action, context.observationId, inspected.reason, { attempt_key: attemptKey });
  }
  if (!preparedSnapshotIsFresh(context.preparedAtMs)) {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_dry_run_expired", { attempt_key: attemptKey });
  }

  try {
    persistAttempt(baseDir, context.state, details, "prepared", {
      menu_state_before: inspected.menuState,
      real_action_attempted: false
    });
  } catch {
    return persistenceBlockedResult(action, details);
  }

  let result;
  try {
    result = await Promise.resolve(driver.comment(driverContext(
      context,
      "comment",
      "execute",
      attemptKey,
      commentText
    )));
  } catch {
    try {
      persistAttempt(baseDir, loadState(baseDir), details, "outcome_unknown", {
        reason: "moments_comment_driver_failed",
        real_action_attempted: null
      });
    } catch {}
    return outcomeUnknownResult(action, details, { reason: "moments_comment_driver_failed" }, null);
  }

  const attempted = typeof result?.actionAttempted === "boolean" ? result.actionAttempted : null;
  let persistedState = loadState(baseDir);
  if (attempted === true) {
    try {
      persistedState = persistAttempt(baseDir, persistedState, details, "clicked", {
        real_action_attempted: true
      });
    } catch {
      return outcomeUnknownResult(action, details, { reason: "moments_action_state_persist_failed" }, true);
    }
  }
  if (result?.ok === false && attempted === false) {
    const reason = safeDriverReason(result) || "moments_comment_blocked_before_send";
    try {
      persistAttempt(baseDir, persistedState, details, "prepared", {
        reason,
        real_action_attempted: false
      });
    } catch {
      return persistenceBlockedResult(action, details);
    }
    return blockedResult(action, reason, {
      observation_id: context.observationId,
      attempt_key: attemptKey,
      previous_status: "prepared",
      retry_locked: true
    });
  }
  const visualVerificationRequired = requiresVisualCommentVerification(context);
  const readbackDiagnostics = visualVerificationRequired
    ? sanitizeVisualCommentReadbackDiagnostics(result?.diagnostics)
    : undefined;
  let readback = null;
  let verified = false;
  let verificationMode = "";
  let verificationLevel = "";
  if (visualVerificationRequired && attempted === true) {
    verified = validVisualCommentCandidateResult(result, context, attemptKey, commentText);
    if (verified) {
      verificationMode = VISUAL_COMMENT_VERIFICATION_MODE;
      verificationLevel = VISUAL_COMMENT_VERIFICATION_LEVEL;
      if (options.enhancedReadback === true) {
        readback = await readbackVisualComment(driver, context, attemptKey, commentText, result);
        if (readback.ok === true) {
          verificationMode = COMMENT_READBACK_VERIFICATION_MODE;
          verificationLevel = ENHANCED_COMMENT_VERIFICATION_LEVEL;
        }
      }
    }
  } else if (!visualVerificationRequired) {
    verified = result?.ok === true
      && attempted === true
      && result.observationId === context.observationId
      && result.commentVerified === true
      && result.commentText === commentText
      && result.verificationMode === UIA_COMMENT_VERIFICATION_MODE;
    if (verified) {
      verificationMode = UIA_COMMENT_VERIFICATION_MODE;
      verificationLevel = "uia_exact";
    }
  }
  if (!verified) {
    const verificationFailure = readback ?? result;
    const verificationReason = safeDriverReason(verificationFailure) || "moments_comment_proof_invalid";
    try {
      persistAttempt(baseDir, persistedState, details, "outcome_unknown", {
        reason: verificationReason,
        real_action_attempted: attempted,
        readback_checked_at: undefined,
        readback_proof: readback?.proof,
        readback_diagnostics: readbackDiagnostics
      });
    } catch {}
    return outcomeUnknownResult(action, details, { reason: verificationReason }, attempted);
  }

  try {
    persistAttempt(baseDir, persistedState, details, "verified", {
      comment_text_verified: commentText,
      real_action_attempted: true,
      verification_mode: verificationMode,
      verification_level: verificationLevel,
      visible_candidate_proof: readbackDiagnostics,
      readback_checked_at: readback ? timestamp() : undefined,
      readback_enhancement_status: readback
        ? (readback.ok === true ? "verified" : "failed")
        : "not_requested",
      readback_enhancement_reason: readback?.ok === false ? readback.reason : undefined,
      readback_proof: readback?.ok === true ? readback.result?.proof : undefined
    });
  } catch {
    return outcomeUnknownResult(action, details, { reason: "moments_action_state_persist_failed" }, true);
  }
  return {
    ok: true,
    action,
    status: "verified",
    observation_id: context.observationId,
    attempt_key: attemptKey,
    comment_text: commentText,
    verification_mode: verificationMode,
    verification_level: verificationLevel,
    readback_enhancement_status: readback
      ? (readback.ok === true ? "verified" : "failed")
      : "not_requested",
    real_action_attempted: true
  };
}

module.exports = {
  MENU_STATES,
  MOMENTS_DRY_RUN_TTL_MS,
  NON_RETRYABLE_ATTEMPT_STATUSES,
  UIA_COMMENT_VERIFICATION_MODE,
  VISUAL_COMMENT_VERIFICATION_LEVEL,
  VISUAL_COMMENT_VERIFICATION_MODE,
  createMomentsAttemptKey,
  executeMomentsComment,
  executeMomentsLike,
  inspectMomentsMenu
};
