const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  MAX_MOMENTS_COMMENT_LENGTH,
  momentsPostFingerprint,
  stableMomentsPostIdentityText
} = require("./moments_dry_run.dev.cjs");
const { loadState, saveState } = require("./state_machine.cjs");
const { validMomentsSurfaceRoot } = require("./moments_surface_profile.dev.cjs");
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
const VISUAL_COMMENT_LOCATOR_MODE = "unique_fuzzy_ocr_locator_and_stable_post_v1";
const VISUAL_COMMENT_LOCATOR_LEVEL = "locator_only";
const VISUAL_COMMENT_STATE_TRANSITION_MODE = "composer_closed_or_send_inactive_v1";
const VISUAL_COMMENT_STATE_TRANSITION_LEVEL = "state_transition";
const COMMENT_SEND_VERIFIED_STAGE = "send_verified";
const COMMENT_SEND_MARKER_DIRECTORY = "moments_comment_send_markers";
const COMMENT_SEND_MARKER_KIND = "moments_comment_send_click";
const COMMENT_SEND_MARKER_VERIFICATION_MODE = "durable_send_click_marker_v1";
const COMMENT_SEND_MARKER_SCAN_LIMIT = 100;
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

function commentSendMarkerPath(baseDir, postFingerprint) {
  return path.join(path.resolve(baseDir), COMMENT_SEND_MARKER_DIRECTORY, `${postFingerprint}.json`);
}

function normalizedMarkerText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function parseCommentSendMarker(filePath) {
  try {
    const marker = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
    const sendClickedAt = new Date(String(marker?.send_clicked_at ?? ""));
    const postFingerprint = String(marker?.post_fingerprint ?? "");
    const identityText = normalizedMarkerText(marker?.identity_text);
    const stableAnchorText = normalizedMarkerText(marker?.stable_anchor_text);
    const avatarHash = String(marker?.avatar_hash ?? "");
    if (
      marker?.version !== 1
      || marker?.kind !== COMMENT_SEND_MARKER_KIND
      || marker?.status !== "click_attempted"
      || !OBSERVATION_ID_PATTERN.test(String(marker?.attempt_key ?? ""))
      || !OBSERVATION_ID_PATTERN.test(postFingerprint)
      || !OBSERVATION_ID_PATTERN.test(String(marker?.observation_id ?? ""))
      || !OBSERVATION_ID_PATTERN.test(String(marker?.comment_text_sha256 ?? ""))
      || !OBSERVATION_ID_PATTERN.test(avatarHash)
      || !identityText
      || identityText.length > 2000
      || stableAnchorText.length > 2000
      || path.basename(filePath) !== `${postFingerprint}.json`
      || !Number.isFinite(sendClickedAt.getTime())
    ) return null;
    return {
      attempt_key: marker.attempt_key,
      post_fingerprint: postFingerprint,
      observation_id: marker.observation_id,
      comment_text_sha256: marker.comment_text_sha256,
      avatar_hash: avatarHash,
      identity_text: identityText,
      stable_anchor_text: stableAnchorText,
      send_clicked_at: sendClickedAt.toISOString()
    };
  } catch {
    return null;
  }
}

function readCommentSendMarker(filePath, postFingerprint) {
  const marker = parseCommentSendMarker(filePath);
  return marker?.post_fingerprint === postFingerprint ? marker : null;
}

function markerAttemptIsConsistent(state, marker) {
  const attempt = actionState(state).attempts[marker?.attempt_key];
  return Boolean(
    attempt
    && attempt.action === "moments-comment"
    && attempt.post_fingerprint === marker.post_fingerprint
    && attempt.observation_id === marker.observation_id
    && sha256(String(attempt.comment_text ?? "")) === marker.comment_text_sha256
  );
}

function markerMatchesCurrentPost(marker, context) {
  const snapshot = context?.postSnapshot ?? {};
  return marker?.avatar_hash === String(snapshot.avatar_hash ?? "")
    && stableMomentsPostIdentityText(
      marker?.identity_text,
      snapshot.identity_text,
      marker?.stable_anchor_text,
      snapshot.stable_anchor_text
    );
}

function findPendingCommentSendMarker(baseDir, context) {
  const exactPath = commentSendMarkerPath(baseDir, context.postFingerprint);
  if (fs.existsSync(exactPath)) {
    const marker = readCommentSendMarker(exactPath, context.postFingerprint);
    return marker
      ? { status: "found", marker, markerPath: exactPath, matchMode: "exact" }
      : { status: "invalid", markerPath: exactPath };
  }

  const markerDirectory = path.dirname(exactPath);
  if (!fs.existsSync(markerDirectory)) return { status: "none", markerPath: exactPath };
  let files;
  try {
    files = fs.readdirSync(markerDirectory)
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort();
  } catch {
    return { status: "invalid", markerPath: markerDirectory };
  }
  if (files.length > COMMENT_SEND_MARKER_SCAN_LIMIT) {
    return { status: "ambiguous", markerPath: markerDirectory };
  }

  const matches = [];
  for (const name of files) {
    const markerPath = path.join(markerDirectory, name);
    const marker = parseCommentSendMarker(markerPath);
    if (!marker) continue;
    if (markerMatchesCurrentPost(marker, context)) {
      matches.push({ marker, markerPath });
    }
  }
  if (matches.length > 1) return { status: "ambiguous", markerPath: markerDirectory };
  if (matches.length === 1) {
    return { status: "found", ...matches[0], matchMode: "fuzzy" };
  }
  return { status: "none", markerPath: exactPath };
}

function markerRecoveryDetails(currentDetails, state, marker) {
  const markerAttempt = actionState(state).attempts[marker.attempt_key];
  return {
    ...currentDetails,
    observationId: marker.observation_id,
    attemptKey: marker.attempt_key,
    postFingerprint: marker.post_fingerprint,
    postIdentityText: String(markerAttempt?.post_identity_text ?? marker.identity_text ?? ""),
    postStableAnchorText: String(markerAttempt?.post_stable_anchor_text ?? marker.stable_anchor_text ?? ""),
    postAvatarHash: String(markerAttempt?.post_avatar_hash ?? marker.avatar_hash ?? ""),
    commentText: String(markerAttempt?.comment_text ?? "")
  };
}

function removeCommentSendMarker(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  return true;
}

function recoveredSendMarkerMetadata(marker, reason = "moments_comment_recovered_send_click_marker") {
  return {
    stage: "send_clicked",
    ...(marker?.send_clicked_at ? { send_clicked_at: marker.send_clicked_at } : {}),
    primary_reason: reason,
    verification_mode: COMMENT_SEND_MARKER_VERIFICATION_MODE,
    real_action_attempted: true
  };
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

const SAFE_DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,99}$/u;

function safeDiagnosticCode(value) {
  const code = String(value ?? "").trim();
  return SAFE_DIAGNOSTIC_CODE_PATTERN.test(code) ? code : "";
}

function safeDriverReason(result) {
  return safeDiagnosticCode(result?.primaryReason) || safeDiagnosticCode(result?.reason);
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
    ["composerClosed", "composer_closed"],
    ["sendInactive", "send_inactive"],
    ["anchorStable", "anchor_stable"],
    ["menuStable", "menu_stable"],
    ["candidateHashStable", "candidate_hash_stable"],
    ["candidateExactMatch", "candidate_exact_match"],
    ["candidateStable", "candidate_stable"],
    ["candidateLocatorOnly", "candidate_locator_only"]
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
  if (["exact", "fuzzy"].includes(raw.candidateMatchMode)) {
    sanitized.candidate_match_mode = raw.candidateMatchMode;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeDiagnosticBounds(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const bounds = {};
  for (const key of ["left", "top", "width", "height"]) {
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || Math.abs(value) > 100_000) return undefined;
    bounds[key] = value;
  }
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  return bounds;
}

function sanitizeVisualMenuDiagnostics(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const sanitized = {};
  if (["like", "comment", "inspect"].includes(raw.requestedAction)) {
    sanitized.requested_action = raw.requestedAction;
  }
  if (["authorize_action", "verify_outcome"].includes(raw.proofPurpose)) {
    sanitized.proof_purpose = raw.proofPurpose;
  }
  for (const [source, target] of [["firstReason", "first_reason"], ["secondReason", "second_reason"]]) {
    const code = safeDiagnosticCode(raw[source]);
    if (code.startsWith("moments_")) sanitized[target] = code;
  }
  for (const [source, target] of [
    ["menuReadRetryCount", "menu_read_retry_count"],
    ["firstSegmentCount", "first_segment_count"],
    ["secondSegmentCount", "second_segment_count"],
    ["firstStrictCandidateCount", "first_strict_candidate_count"],
    ["secondStrictCandidateCount", "second_strict_candidate_count"],
    ["firstFallbackCandidateCount", "first_fallback_candidate_count"],
    ["secondFallbackCandidateCount", "second_fallback_candidate_count"],
    ["outcomeObservationCount", "outcome_observation_count"]
  ]) {
    if (Number.isSafeInteger(raw[source]) && raw[source] >= 0 && raw[source] <= 1_000) {
      sanitized[target] = raw[source];
    }
  }
  for (const [source, target] of [
    ["firstLikeOcrMatched", "first_like_ocr_matched"],
    ["firstLikeBaseOcrMatched", "first_like_base_ocr_matched"],
    ["firstTargetedLikeOcrAttempted", "first_targeted_like_ocr_attempted"],
    ["firstTargetedLikeOcrMatched", "first_targeted_like_ocr_matched"],
    ["firstCommentOcrMatched", "first_comment_ocr_matched"],
    ["firstLikeSignatureOk", "first_like_signature_ok"],
    ["firstCommentSignatureOk", "first_comment_signature_ok"],
    ["firstLikeSignatureEdgeClear", "first_like_signature_edge_clear"],
    ["firstCommentSignatureEdgeClear", "first_comment_signature_edge_clear"],
    ["secondLikeOcrMatched", "second_like_ocr_matched"],
    ["secondLikeBaseOcrMatched", "second_like_base_ocr_matched"],
    ["secondTargetedLikeOcrAttempted", "second_targeted_like_ocr_attempted"],
    ["secondTargetedLikeOcrMatched", "second_targeted_like_ocr_matched"],
    ["secondCommentOcrMatched", "second_comment_ocr_matched"],
    ["secondLikeSignatureOk", "second_like_signature_ok"],
    ["secondCommentSignatureOk", "second_comment_signature_ok"],
    ["secondLikeSignatureEdgeClear", "second_like_signature_edge_clear"],
    ["secondCommentSignatureEdgeClear", "second_comment_signature_edge_clear"],
    ["firstRequiresStability", "first_requires_stability"],
    ["secondRequiresStability", "second_requires_stability"]
  ]) {
    if (typeof raw[source] === "boolean") sanitized[target] = raw[source];
  }
  for (const [source, target] of [
    ["firstLikeResolutionMode", "first_like_resolution_mode"],
    ["secondLikeResolutionMode", "second_like_resolution_mode"]
  ]) {
    if (["ocr", "targeted_ocr", "visual_signature", "ambiguous"].includes(raw[source])) {
      sanitized[target] = raw[source];
    }
  }
  for (const [source, target] of [
    ["firstWidthRatio", "first_width_ratio"],
    ["firstHeightRatio", "first_height_ratio"],
    ["secondWidthRatio", "second_width_ratio"],
    ["secondHeightRatio", "second_height_ratio"]
  ]) {
    if (Number.isFinite(raw[source]) && raw[source] >= 0 && raw[source] <= 10) {
      sanitized[target] = raw[source];
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
function sanitizeCommentDriverDiagnostics(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const sanitized = {
    ...(sanitizeVisualCommentReadbackDiagnostics(raw) ?? {})
  };
  for (const [source, target] of [
    ["firstReason", "first_reason"],
    ["secondReason", "second_reason"],
    ["requestedAction", "requested_action"],
    ["retryReason", "retry_reason"],
    ["stableComposerReason", "stable_composer_reason"],
    ["settledComposerReason", "settled_composer_reason"],
    ["stableSendReason", "stable_send_reason"],
    ["settledSendReason", "settled_send_reason"],
    ["ownedClickReason", "owned_click_reason"],
    ["ownedClickPhase", "owned_click_phase"]
  ]) {
    const code = safeDiagnosticCode(raw[source]);
    if (code) sanitized[target] = code;
  }
  for (const [source, target] of [
    ["menuOpened", "menu_opened"],
    ["commentEntryClicked", "comment_entry_clicked"],
    ["composerOpen", "composer_open"],
    ["draftWritten", "draft_written"],
    ["sendButtonLocated", "send_button_located"],
    ["sendButtonUnique", "send_button_unique"],
    ["sendButtonEnabled", "send_button_enabled"],
    ["sendButtonClicked", "send_button_clicked"],
    ["sendButtonStateChanged", "send_button_state_changed"],
    ["composerClosed", "composer_closed"],
    ["inputQuiet", "input_quiet"],
    ["inputRebased", "input_rebased"],
    ["preSendLockOk", "pre_send_lock_ok"],
    ["preSendStateOk", "pre_send_state_ok"],
    ["visualProofOk", "visual_proof_ok"],
    ["foregroundRecovered", "foreground_recovered"],
    ["sendButtonOk", "send_button_ok"],
    ["sendInsideComposer", "send_inside_composer"],
    ["foregroundOk", "foreground_ok"],
    ["inputTickStable", "input_tick_stable"],
    ["stableComposerOk", "stable_composer_ok"],
    ["settledComposerOk", "settled_composer_ok"],
    ["stableSendOk", "stable_send_ok"],
    ["settledSendOk", "settled_send_ok"],
    ["pointInsideSurface", "point_inside_surface"],
    ["surfaceInsidePopup", "surface_inside_popup"],
    ["surfaceInsideWindow", "surface_inside_window"],
    ["firstRootMatchesSecond", "first_root_matches_second"]
  ]) {
    if (typeof raw[source] === "boolean") sanitized[target] = raw[source];
  }
  for (const [source, target] of [
    ["sendButtonCount", "send_button_count"],
    ["sendCandidateCount", "send_candidate_count"],
    ["connectedComponentCount", "connected_component_count"],
    ["foregroundRetryCount", "foreground_retry_count"],
    ["menuReadRetryCount", "menu_read_retry_count"],
    ["firstSegmentCount", "first_segment_count"],
    ["secondSegmentCount", "second_segment_count"],
    ["firstStrictCandidateCount", "first_strict_candidate_count"],
    ["secondStrictCandidateCount", "second_strict_candidate_count"],
    ["firstFallbackCandidateCount", "first_fallback_candidate_count"],
    ["secondFallbackCandidateCount", "second_fallback_candidate_count"],
    ["blankCheckpointRetryCount", "blank_checkpoint_retry_count"],
    ["checkpointPass", "checkpoint_pass"],
    ["startedInputTick", "started_input_tick"],
    ["finishedInputTick", "finished_input_tick"],
    ["stableSendCandidateCount", "stable_send_candidate_count"],
    ["settledSendCandidateCount", "settled_send_candidate_count"]
  ]) {
    if (Number.isSafeInteger(raw[source]) && raw[source] >= 0 && raw[source] <= 4_294_967_295) {
      sanitized[target] = raw[source];
    }
  }
  for (const [source, target] of [
    ["composerBounds", "composer_bounds"],
    ["sendButtonBounds", "send_button_bounds"],
    ["sendBounds", "send_bounds"],
    ["candidateBounds", "candidate_bounds"]
  ]) {
    const bounds = sanitizeDiagnosticBounds(raw[source]);
    if (bounds) sanitized[target] = bounds;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function safeClickedAt(value, attempted) {
  if (attempted !== true || typeof value !== "string" || !value.trim()) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function normalizeCommentDriverMetadata(result, attempted) {
  const metadata = {
    real_action_attempted: attempted
  };
  const stage = safeDiagnosticCode(result?.stage);
  const sendClickedAt = safeClickedAt(result?.sendClickedAt, attempted);
  const primaryReason = safeDriverReason(result);
  const cleanupReason = safeDiagnosticCode(result?.cleanupReason);
  const verificationMode = safeDiagnosticCode(result?.verificationMode);
  const diagnostics = sanitizeCommentDriverDiagnostics(result?.diagnostics);
  if (stage) metadata.stage = stage;
  if (sendClickedAt) metadata.send_clicked_at = sendClickedAt;
  if (primaryReason) metadata.primary_reason = primaryReason;
  if (cleanupReason) metadata.cleanup_reason = cleanupReason;
  if (verificationMode) metadata.verification_mode = verificationMode;
  if (diagnostics) metadata.diagnostics = diagnostics;
  return metadata;
}

function commentActionAttempted(result) {
  if (typeof result?.realActionAttempted === "boolean") return result.realActionAttempted;
  return typeof result?.actionAttempted === "boolean" ? result.actionAttempted : null;
}

function metadataWithPrimaryReason(metadata, reason) {
  const primaryReason = safeDiagnosticCode(reason);
  return primaryReason ? { ...metadata, primary_reason: primaryReason } : metadata;
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
        stage: undefined,
        send_clicked_at: undefined,
        primary_reason: undefined,
        cleanup_reason: undefined,
        verification_mode: undefined,
        diagnostics: undefined,
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
  const commonRoot = validMomentsSurfaceRoot(window)
    && ["Weixin", "WeChat"].includes(window?.processName)
    && typeof window?.className === "string"
    && Boolean(window.className.trim())
    && window?.rootControlType === "ControlType.Window"
    && Number(window?.rootProcessId) === Number(window?.pid);
  if (!commonRoot) return "";

  const uiaFeed = window?.feedAutomationId === "sns_list"
    && window?.feedCount === 1
    && Boolean(String(window?.feedRuntimeId ?? "").trim());
  if (window.surfaceMode === "standalone" && uiaFeed && window.identityMode === "automation_id" && window.automationId === "SNSWindow") return "uia";
  if (window.surfaceMode === "standalone" && uiaFeed && window.identityMode === "structural_sns_feed" && window.automationId === "") return "uia";

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
  if (window?.identityMode === "visual_mmui_render"
    && ["visual:windows_media_ocr", "visual:interaction_anchor"].includes(snapshot?.source)) {
    const interactionAnchor = snapshot.source === "visual:interaction_anchor";
    const payload = JSON.stringify({
      version: interactionAnchor ? 7 : 6,
      surfaceMode: String(window.surfaceMode ?? ""),
      className: String(window.className ?? ""),
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
      ...(interactionAnchor ? { menuHash: String(snapshot.menu_hash ?? "") } : {}),
      label: String(snapshot.label ?? ""),
      identityText: String(snapshot.identity_text ?? ""),
      ...(String(snapshot.stable_anchor_text ?? "")
        ? { stableAnchorText: String(snapshot.stable_anchor_text) }
        : {}),
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
  const snapshots = Array.isArray(dryRun?.post_snapshots) && dryRun.post_snapshots.length > 0
    ? dryRun.post_snapshots
    : [dryRun?.post_snapshot].filter(Boolean);
  const primarySnapshot = dryRun?.post_snapshot;
  const snapshot = primarySnapshot?.observation_id === observationId
    ? primarySnapshot
    : snapshots.find((candidate) => candidate?.observation_id === observationId);
  const window = dryRun?.window;
  if (dryRun?.status !== "prepared" || snapshots.length === 0 || !window) {
    return { ok: false, state, observationId, reason: "moments_dry_run_not_prepared" };
  }
  const preparedAtMs = Date.parse(String(dryRun.prepared_at ?? ""));
  if (!preparedSnapshotIsFresh(preparedAtMs)) {
    return { ok: false, state, observationId, reason: "moments_dry_run_expired" };
  }
  if (!OBSERVATION_ID_PATTERN.test(observationId)) {
    return { ok: false, state, observationId, reason: "moments_observation_id_invalid" };
  }
  if (!snapshot) {
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
  const interactionAnchor = snapshot.source === "visual:interaction_anchor";
  const visualSnapshotCommonValid = ["visual:windows_media_ocr", "visual:interaction_anchor"].includes(snapshot.source)
    && snapshot.identity_scope === "window_session_only"
    && snapshot.structure_verified === true
    && (interactionAnchor
      ? snapshot.ocr_provider === "" && snapshot.ocr_language === ""
      : snapshot.ocr_provider === "windows_media_ocr" && snapshot.ocr_language === "zh-Hans-CN")
    && typeof snapshot.region_hash === "string"
    && OBSERVATION_ID_PATTERN.test(snapshot.region_hash)
    && typeof snapshot.layout_hash === "string"
    && OBSERVATION_ID_PATTERN.test(snapshot.layout_hash)
    && typeof snapshot.label === "string"
    && Boolean(snapshot.label.trim())
    && snapshot.label.length <= 2000
    && typeof snapshot.identity_text === "string"
    && Boolean(snapshot.identity_text.trim())
    && snapshot.identity_text.length <= 2000
    && (snapshot.stable_anchor_text === undefined
      || (typeof snapshot.stable_anchor_text === "string" && snapshot.stable_anchor_text.length <= 2000))
    && typeof snapshot.post_fingerprint === "string"
    && OBSERVATION_ID_PATTERN.test(snapshot.post_fingerprint)
    && momentsPostFingerprint(snapshot.identity_text) === snapshot.post_fingerprint
    && boundsWithin(window.renderPaneBounds, visualWindowBounds)
    && boundsWithin(snapshot.bounds, window.renderPaneBounds)
    && boundsWithin(snapshot.menu_bounds, window.renderPaneBounds);
  const visualSnapshotValid = visualSnapshotCommonValid && (
    (snapshot.menu_only === true
      && snapshot.avatar_hash === ""
      && typeof snapshot.menu_hash === "string"
      && OBSERVATION_ID_PATTERN.test(snapshot.menu_hash))
    || (
      snapshot.menu_only !== true
      && typeof snapshot.avatar_hash === "string"
      && OBSERVATION_ID_PATTERN.test(snapshot.avatar_hash)
      && boundsWithin(snapshot.avatar_bounds, window.renderPaneBounds)
      && (!interactionAnchor || (snapshot.interaction_only === true
        && typeof snapshot.menu_hash === "string"
        && OBSERVATION_ID_PATTERN.test(snapshot.menu_hash)))
    )
  );
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

function loadMomentsActionContext(baseDir, suppliedObservationId) {
  return loadLockedContext(baseDir, suppliedObservationId);
}

function resolveDriver(injectedDriver, context) {
  if (injectedDriver && typeof injectedDriver === "object") return injectedDriver;
  // The real driver is test-edition-only and is intentionally loaded only when an action reaches it.
  if (
    context?.expectedWindow?.identityMode === "visual_mmui_render"
    && ["visual:windows_media_ocr", "visual:interaction_anchor"].includes(context?.postSnapshot?.source)
  ) {
    return require("./moments_visual_action_driver.dev.cjs");
  }
  return require("./moments_action_driver.dev.cjs");
}

function driverContext(
  context,
  action,
  phase,
  attemptKey = "",
  commentText = "",
  sendMarkerPath = ""
) {
  return {
    action,
    phase,
    expectedWindow: context.expectedWindow,
    postSnapshot: context.postSnapshot,
    observationId: context.observationId,
    postFingerprint: context.postFingerprint,
    deadlineMs: context.preparedAtMs + MOMENTS_DRY_RUN_TTL_MS,
    attemptKey,
    commentText,
    ...(sendMarkerPath
      ? {
          sendMarkerPath,
          commentTextSha256: sha256(commentText)
        }
      : {})
  };
}

function requiresVisualCommentVerification(context) {
  return context?.expectedWindow?.identityMode === "visual_mmui_render"
    && context?.postSnapshot?.source === "visual:windows_media_ocr";
}

function validVisualCommentSeedBinding(result, context, attemptKey, commentText) {
  const seed = result?.readbackSeed;
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
  return result?.ok === true
    && result.actionAttempted === true
    && result.observationId === context.observationId
    && result.commentText === commentText
    && seed !== null
    && typeof seed === "object"
    && seed.version === 1
    && seed.observationId === context.observationId
    && seed.attemptKey === attemptKey
    && seed.postFingerprint === context.postFingerprint
    && seed.commentTextSha256 === sha256(commentText)
    && /^[0-9a-f]{64}$/u.test(String(seed.candidatePixelHash ?? ""))
    && /^[0-9a-f]{64}$/u.test(String(seed.avatarHash ?? ""))
    && candidateInsideWindow;
}

function validVisualCommentSendResult(result, context, attemptKey, commentText) {
  return result?.status === "visible_verified"
    && result.realActionAttempted === true
    && result.stage === COMMENT_SEND_VERIFIED_STAGE
    && Boolean(safeClickedAt(result.sendClickedAt, true))
    && validVisualCommentSeedBinding(result, context, attemptKey, commentText);
}

function validVisualCommentCandidateResult(result, context, attemptKey, commentText) {
  const seed = result?.readbackSeed;
  const diagnostics = result?.diagnostics;
  return validVisualCommentSendResult(result, context, attemptKey, commentText)
    && result.commentVerified === true
    && result.verificationMode === VISUAL_COMMENT_VERIFICATION_MODE
    && result.verificationLevel === VISUAL_COMMENT_VERIFICATION_LEVEL
    && result.normalizedOcrCountBefore === 0
    && result.normalizedOcrCountAfter === 1
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

function validVisualCommentStateTransitionResult(result, context, commentText) {
  const diagnostics = result?.diagnostics;
  return result?.ok === true
    && result.status === "visible_verified"
    && result.actionAttempted === true
    && result.realActionAttempted === true
    && result.stage === COMMENT_SEND_VERIFIED_STAGE
    && Boolean(safeClickedAt(result.sendClickedAt, true))
    && result.observationId === context.observationId
    && result.commentText === commentText
    && result.commentVerified === true
    && result.verificationMode === VISUAL_COMMENT_STATE_TRANSITION_MODE
    && result.verificationLevel === VISUAL_COMMENT_STATE_TRANSITION_LEVEL
    && result.normalizedOcrCountBefore === 0
    && diagnostics !== null
    && typeof diagnostics === "object"
    && diagnostics.composerCompleted === true
    && (diagnostics.composerClosed === true || diagnostics.sendInactive === true);
}

function validVisualCommentLocatorResult(result, context, attemptKey, commentText) {
  const diagnostics = result?.diagnostics;
  return result?.status === "readback_required"
    && validVisualCommentSeedBinding(result, context, attemptKey, commentText)
    && result.commentVerified === false
    && result.verificationMode === VISUAL_COMMENT_LOCATOR_MODE
    && result.verificationLevel === VISUAL_COMMENT_LOCATOR_LEVEL
    && result.normalizedOcrCountBefore === 0
    && result.normalizedOcrCountAfter === 1
    && diagnostics !== null
    && typeof diagnostics === "object"
    && diagnostics.composerCompleted === true
    && diagnostics.anchorStable === true
    && diagnostics.menuStable === true
    && diagnostics.menuMatchCount === 1
    && diagnostics.candidateCount === 1
    && diagnostics.candidateExactMatch === false
    && diagnostics.candidateHashStable === true
    && diagnostics.candidateStable === true
    && diagnostics.candidateLocatorOnly === true
    && diagnostics.candidateMatchMode === "fuzzy";
}

async function readbackVisualComment(driver, context, attemptKey, commentText, sendResult) {
  if (
    !validVisualCommentSendResult(sendResult, context, attemptKey, commentText)
    && !validVisualCommentLocatorResult(sendResult, context, attemptKey, commentText)
  ) {
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

function validMenuProof(result, observationId, action) {
  return result?.ok === true
    && result.observationId === observationId
    && (action === "comment" || MENU_STATES.includes(result.menuState));
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
  const diagnostics = sanitizeVisualMenuDiagnostics(result?.diagnostics);
  const cleanupReason = safeDiagnosticCode(result?.cleanupReason);
  if (!validMenuProof(result, context.observationId, action)) {
    return {
      ok: false,
      reason: safeDriverReason(result) || "moments_menu_proof_invalid",
      diagnostics,
      cleanupReason
    };
  }
  return { ok: true, menuState: result.menuState, diagnostics, cleanupReason };
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
    return persistBlocked(baseDir, context.state, action, context.observationId, inspected.reason, {
      primary_reason: inspected.reason,
      diagnostics: inspected.diagnostics,
      cleanup_reason: inspected.cleanupReason
    });
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

function commentAttemptBlocksRetry(attempt) {
  if (!attempt || !NON_RETRYABLE_ATTEMPT_STATUSES.has(attempt.status)) return false;
  if (attempt.status !== "prepared") return true;
  return attempt.real_action_attempted === true;
}

function commentAttemptMatchesPost(attempt, context) {
  return attempt?.post_fingerprint === context.postFingerprint;
}

function fuzzyVerifiedCommentAttempts(context) {
  if (!requiresVisualCommentVerification(context)) return [];
  const currentAvatarHash = String(context.postSnapshot?.avatar_hash ?? "");
  if (!OBSERVATION_ID_PATTERN.test(currentAvatarHash)) return [];
  const matches = [];
  for (const [attemptKey, attempt] of Object.entries(actionState(context.state).attempts).reverse()) {
    if (
      attempt?.action !== "moments-comment"
      || attempt.status !== "verified"
      || attempt.real_action_attempted !== true
      || attempt.post_fingerprint === context.postFingerprint
      || attempt.post_avatar_hash !== currentAvatarHash
      || !String(attempt.comment_text ?? "").trim()
      || !stableMomentsPostIdentityText(
        attempt.post_identity_text,
        context.postSnapshot?.identity_text,
        "",
        ""
      )
    ) continue;
    matches.push({ attemptKey, attempt });
  }
  return matches;
}

function normalizedCommentOccurrence(result) {
  const occurrence = String(result?.commentOccurrence ?? result?.comment_occurrence ?? "").trim();
  if (
    result?.ok === true
    && result?.actionAttempted !== true
    && result?.realActionAttempted !== true
    && ["present", "absent"].includes(occurrence)
  ) return occurrence;
  return "unresolved";
}

function existingExactCommentAttempt(context, commentText) {
  const attempts = Object.entries(actionState(context.state).attempts).reverse();
  for (const [attemptKey, attempt] of attempts) {
    if (
      attempt?.action === "moments-comment"
      && commentAttemptMatchesPost(attempt, context)
      && attempt.comment_text === commentText
      && commentAttemptBlocksRetry(attempt)
    ) return { attemptKey, attempt };
  }
  return null;
}

function existingCommentAttemptForPost(context) {
  const attempts = Object.entries(actionState(context.state).attempts).reverse();
  for (const [attemptKey, attempt] of attempts) {
    if (
      attempt?.action === "moments-comment"
      && commentAttemptMatchesPost(attempt, context)
      && commentAttemptBlocksRetry(attempt)
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
    {
      attempt_key: attemptKey,
      previous_status: attempt.status,
      previous_real_action_attempted: typeof attempt.real_action_attempted === "boolean"
        ? attempt.real_action_attempted
        : null
    }
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
      previous_status: previous.attempt.status,
      previous_real_action_attempted: typeof previous.attempt.real_action_attempted === "boolean"
        ? previous.attempt.real_action_attempted
        : null
    }
  );
}

function duplicateCommentPostResult(baseDir, context, action, candidateAttemptKey, previous, extras = {}) {
  return persistBlocked(
    baseDir,
    context.state,
    action,
    context.observationId,
    "moments_comment_post_already_attempted",
    {
      attempt_key: previous.attemptKey,
      previous_attempt_key: previous.attemptKey,
      candidate_attempt_key: candidateAttemptKey,
      previous_status: previous.attempt.status,
      previous_real_action_attempted: typeof previous.attempt.real_action_attempted === "boolean"
        ? previous.attempt.real_action_attempted
        : null,
      ...extras
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
    post_identity_text: details.postIdentityText,
    post_stable_anchor_text: details.postStableAnchorText,
    post_avatar_hash: details.postAvatarHash,
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
    stage: resultPatch.stage,
    send_clicked_at: resultPatch.send_clicked_at,
    primary_reason: resultPatch.primary_reason,
    cleanup_reason: resultPatch.cleanup_reason,
    verification_mode: resultPatch.verification_mode,
    diagnostics: resultPatch.diagnostics,
    blocked_reason: status === "outcome_unknown"
      ? (resultPatch.primary_reason || resultPatch.reason || "moments_action_outcome_unknown")
      : "",
    attempts: { ...current.attempts, [details.attemptKey]: attempt }
  });
  saveState(baseDir, nextState);
  return nextState;
}

function outcomeUnknownResult(action, details, metadataOrResult = {}, attempted) {
  const normalizedMetadata = Object.prototype.hasOwnProperty.call(metadataOrResult, "real_action_attempted");
  const metadata = normalizedMetadata ? metadataOrResult : { real_action_attempted: attempted };
  const driverReason = normalizedMetadata
    ? metadata.primary_reason
    : safeDriverReason(metadataOrResult);
  return {
    ok: false,
    action,
    status: "outcome_unknown",
    blocked_reason: `${action}_outcome_unknown`,
    driver_reason: driverReason || undefined,
    observation_id: details.observationId,
    attempt_key: details.attemptKey,
    ...metadata
  };
}

function persistenceBlockedResult(action, details) {
  return blockedResult(action, "moments_action_state_persist_failed", {
    observation_id: details.observationId,
    attempt_key: details.attemptKey
  });
}

async function executeMomentsExpandFullText(options = {}) {
  const baseDir = options.baseDir || __dirname;
  const action = "moments-expand-full-text";
  const context = loadLockedContext(baseDir, options.observationId ?? options.observation_id);
  if (!context.ok) return { ok: false, action, status: "blocked", reason: context.reason, real_action_attempted: false };
  let driver;
  try { driver = resolveDriver(options.driver, context); } catch {
    return { ok: false, action, status: "blocked", reason: "moments_expand_driver_unavailable", real_action_attempted: false };
  }
  if (typeof driver.expandFullText !== "function") {
    return { ok: false, action, status: "blocked", reason: "moments_expand_driver_unavailable", real_action_attempted: false };
  }
  const result = await driver.expandFullText(context);
  return {
    ...result,
    action,
    observation_id: context.observationId,
    real_action_attempted: result?.actionAttempted === true
  };
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
    return persistBlocked(baseDir, context.state, action, context.observationId, inspected.reason, {
      attempt_key: attemptKey,
      primary_reason: inspected.reason,
      diagnostics: inspected.diagnostics,
      cleanup_reason: inspected.cleanupReason
    });
  }
  if (!preparedSnapshotIsFresh(context.preparedAtMs)) {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_dry_run_expired", { attempt_key: attemptKey });
  }

  if (LIKED_MENU_STATES.includes(inspected.menuState)) {
    try {
      persistAttempt(baseDir, context.state, details, "verified", {
        menu_state: inspected.menuState,
        no_op: true,
        real_action_attempted: false,
        cleanup_reason: inspected.cleanupReason,
        diagnostics: inspected.diagnostics
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
      real_action_attempted: false,
      ...(inspected.cleanupReason ? { cleanup_reason: inspected.cleanupReason } : {}),
      ...(inspected.diagnostics ? { diagnostics: inspected.diagnostics } : {})
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
  const likeDiagnostics = sanitizeVisualMenuDiagnostics(result?.diagnostics);
  const cleanupReason = safeDiagnosticCode(result?.cleanupReason);
  const verificationMode = safeDiagnosticCode(result?.verificationMode);
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
        primary_reason: reason,
        real_action_attempted: false,
        diagnostics: likeDiagnostics,
        cleanup_reason: cleanupReason
      });
    } catch {
      return persistenceBlockedResult(action, details);
    }
    return blockedResult(action, reason, {
      observation_id: context.observationId,
      attempt_key: attemptKey,
      previous_status: "prepared",
      retry_locked: true,
      primary_reason: reason,
      ...(cleanupReason ? { cleanup_reason: cleanupReason } : {}),
      ...(likeDiagnostics ? { diagnostics: likeDiagnostics } : {})
    });
  }
  const verified = result?.ok === true
    && result.observationId === context.observationId
    && LIKED_MENU_STATES.includes(result.menuState)
    && (attempted === true || attempted === false);
  if (!verified) {
    const reason = safeDriverReason(result) || "moments_like_proof_invalid";
    try {
      persistAttempt(baseDir, persistedState, details, "outcome_unknown", {
        reason,
        primary_reason: reason,
        real_action_attempted: attempted,
        diagnostics: likeDiagnostics,
        cleanup_reason: cleanupReason,
        verification_mode: verificationMode
      });
    } catch {}
    return outcomeUnknownResult(action, details, {
      primary_reason: reason,
      real_action_attempted: attempted,
      ...(cleanupReason ? { cleanup_reason: cleanupReason } : {}),
      ...(verificationMode ? { verification_mode: verificationMode } : {}),
      ...(likeDiagnostics ? { diagnostics: likeDiagnostics } : {})
    });
  }

  const noOp = attempted === false;
  try {
    persistAttempt(baseDir, persistedState, details, "verified", {
      menu_state: result.menuState,
      no_op: noOp,
      real_action_attempted: attempted,
      cleanup_reason: cleanupReason,
      verification_mode: verificationMode,
      diagnostics: likeDiagnostics
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
    real_action_attempted: attempted,
    ...(cleanupReason ? { cleanup_reason: cleanupReason } : {}),
    ...(verificationMode ? { verification_mode: verificationMode } : {}),
    ...(likeDiagnostics ? { diagnostics: likeDiagnostics } : {})
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
    postIdentityText: String(context.postSnapshot?.identity_text ?? ""),
    postStableAnchorText: String(context.postSnapshot?.stable_anchor_text ?? ""),
    postAvatarHash: String(context.postSnapshot?.avatar_hash ?? ""),
    attemptKey,
    commentText
  };
  const sendMarkerPath = commentSendMarkerPath(baseDir, context.postFingerprint);
  const pendingMarker = findPendingCommentSendMarker(baseDir, context);
  if (pendingMarker.status === "invalid" || pendingMarker.status === "ambiguous") {
    const markerReason = pendingMarker.status === "ambiguous"
      ? "moments_comment_send_marker_ambiguous"
      : "moments_comment_send_marker_invalid";
    const invalidMarkerMetadata = recoveredSendMarkerMetadata(
      null,
      markerReason
    );
    try {
      persistAttempt(baseDir, loadState(baseDir), details, "outcome_unknown", {
        reason: invalidMarkerMetadata.primary_reason,
        ...invalidMarkerMetadata
      });
    } catch {
      return persistenceBlockedResult(action, details);
    }
    return outcomeUnknownResult(action, details, invalidMarkerMetadata);
  }
  if (pendingMarker.status === "found") {
    const currentState = loadState(baseDir);
    const recoveredMarker = pendingMarker.marker;
    if (!markerAttemptIsConsistent(currentState, recoveredMarker)) {
      const invalidMarkerMetadata = recoveredSendMarkerMetadata(
        null,
        "moments_comment_send_marker_invalid"
      );
      try {
        persistAttempt(baseDir, currentState, details, "outcome_unknown", {
          reason: invalidMarkerMetadata.primary_reason,
          ...invalidMarkerMetadata
        });
      } catch {
        return persistenceBlockedResult(action, details);
      }
      return outcomeUnknownResult(action, details, invalidMarkerMetadata);
    }
    const recoveryDetails = markerRecoveryDetails(details, currentState, recoveredMarker);
    const currentAttempt = actionState(currentState).attempts[recoveredMarker.attempt_key];
    if (currentAttempt?.status === "verified") {
      removeCommentSendMarker(pendingMarker.markerPath);
    } else {
      const recoveredMetadata = recoveredSendMarkerMetadata(recoveredMarker);
      try {
        persistAttempt(baseDir, currentState, recoveryDetails, "outcome_unknown", {
          reason: recoveredMetadata.primary_reason,
          ...recoveredMetadata
        });
      } catch {
        return persistenceBlockedResult(action, recoveryDetails);
      }
      return outcomeUnknownResult(action, recoveryDetails, recoveredMetadata);
    }
  }
  const previousExactComment = existingExactCommentAttempt(context, commentText);
  if (previousExactComment) {
    return duplicateCommentTextResult(baseDir, context, action, attemptKey, previousExactComment);
  }
  const previousPostComment = existingCommentAttemptForPost(context);
  if (previousPostComment) {
    return duplicateCommentPostResult(baseDir, context, action, attemptKey, previousPostComment);
  }
  const fuzzyPreviousComments = fuzzyVerifiedCommentAttempts(context);

  let driver;
  try {
    driver = resolveDriver(options.driver, context);
  } catch {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_driver_unavailable", { attempt_key: attemptKey });
  }
  if (fuzzyPreviousComments.length > 0) {
    if (typeof driver.commentOccurrenceCheck !== "function") {
      return persistBlocked(
        baseDir,
        context.state,
        action,
        context.observationId,
        "moments_comment_occurrence_unresolved",
        {
          attempt_key: attemptKey,
          stage: "comment_occurrence_check",
          fuzzy_candidate_count: fuzzyPreviousComments.length
        }
      );
    }
    for (const previous of fuzzyPreviousComments) {
      let occurrenceResult;
      try {
        occurrenceResult = await Promise.resolve(driver.commentOccurrenceCheck(driverContext(
          context,
          "comment_occurrence_check",
          "readback",
          previous.attemptKey,
          previous.attempt.comment_text
        )));
      } catch {
        occurrenceResult = null;
      }
      const occurrence = normalizedCommentOccurrence(occurrenceResult);
      if (occurrence === "present") {
        return duplicateCommentPostResult(
          baseDir,
          context,
          action,
          attemptKey,
          previous,
          {
            stage: "comment_occurrence_verified",
            verification_mode: safeDiagnosticCode(occurrenceResult?.verificationMode)
              || "two_frame_exact_comment_region",
            fuzzy_candidate_count: fuzzyPreviousComments.length
          }
        );
      }
      if (occurrence !== "absent") {
        return persistBlocked(
          baseDir,
          context.state,
          action,
          context.observationId,
          "moments_comment_occurrence_unresolved",
          {
            attempt_key: attemptKey,
            previous_attempt_key: previous.attemptKey,
            stage: "comment_occurrence_check",
            verification_mode: safeDiagnosticCode(occurrenceResult?.verificationMode),
            fuzzy_candidate_count: fuzzyPreviousComments.length,
            diagnostics: {
              candidate_status: safeDiagnosticCode(occurrenceResult?.status),
              candidate_reason: safeDriverReason(occurrenceResult)
            }
          }
        );
      }
    }
  }
  if (typeof driver.comment !== "function") {
    return persistBlocked(baseDir, context.state, action, context.observationId, "moments_comment_driver_unavailable", { attempt_key: attemptKey });
  }
  const visualVerificationRequired = requiresVisualCommentVerification(context);
  const inspected = visualVerificationRequired
    ? { ok: true, menuState: "unknown" }
    : await inspectWithDriver(driver, context, "comment", attemptKey, commentText);
  if (!inspected.ok) {
    return persistBlocked(baseDir, context.state, action, context.observationId, inspected.reason, {
      attempt_key: attemptKey,
      primary_reason: inspected.reason,
      diagnostics: inspected.diagnostics,
      cleanup_reason: inspected.cleanupReason
    });
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
      commentText,
      sendMarkerPath
    )));
  } catch {
    const marker = readCommentSendMarker(sendMarkerPath, context.postFingerprint);
    const markerState = marker ? loadState(baseDir) : null;
    if (
      fs.existsSync(sendMarkerPath)
      && (!marker || !markerAttemptIsConsistent(markerState, marker))
    ) {
      const invalidMarkerMetadata = recoveredSendMarkerMetadata(
        null,
        "moments_comment_send_marker_invalid"
      );
      try {
        persistAttempt(baseDir, loadState(baseDir), details, "outcome_unknown", {
          reason: invalidMarkerMetadata.primary_reason,
          ...invalidMarkerMetadata
        });
      } catch {}
      return outcomeUnknownResult(action, details, invalidMarkerMetadata);
    }
    if (marker) {
      const currentState = markerState;
      const recoveryDetails = markerRecoveryDetails(details, currentState, marker);
      const driverFailureMetadata = recoveredSendMarkerMetadata(
        marker,
        "moments_comment_driver_failed_after_send_click"
      );
      try {
        persistAttempt(baseDir, currentState, recoveryDetails, "outcome_unknown", {
          reason: driverFailureMetadata.primary_reason,
          ...driverFailureMetadata
        });
      } catch {}
      return outcomeUnknownResult(action, recoveryDetails, driverFailureMetadata);
    }
    const driverFailureMetadata = normalizeCommentDriverMetadata({
      primaryReason: "moments_comment_driver_failed",
      stage: "driver_exception"
    }, false);
    try {
      persistAttempt(baseDir, loadState(baseDir), details, "prepared", {
        reason: "moments_comment_driver_failed",
        ...driverFailureMetadata
      });
    } catch {
      return persistenceBlockedResult(action, details);
    }
    return blockedResult(action, "moments_comment_driver_failed", {
      observation_id: context.observationId,
      attempt_key: attemptKey,
      previous_status: "prepared",
      retry_locked: false,
      ...driverFailureMetadata
    });
  }

  const durableMarker = readCommentSendMarker(sendMarkerPath, context.postFingerprint);
  const durableMarkerState = durableMarker ? loadState(baseDir) : null;
  if (
    fs.existsSync(sendMarkerPath)
    && (!durableMarker || !markerAttemptIsConsistent(durableMarkerState, durableMarker))
  ) {
    const invalidMarkerMetadata = recoveredSendMarkerMetadata(
      null,
      "moments_comment_send_marker_invalid"
    );
    try {
      persistAttempt(baseDir, loadState(baseDir), details, "outcome_unknown", {
        reason: invalidMarkerMetadata.primary_reason,
        ...invalidMarkerMetadata
      });
    } catch {}
    return outcomeUnknownResult(action, details, invalidMarkerMetadata);
  }
  const currentMarker = durableMarker?.attempt_key === attemptKey
    && durableMarker.comment_text_sha256 === sha256(commentText)
    ? durableMarker
    : null;
  const attempted = currentMarker ? true : commentActionAttempted(result);
  const normalizedDriverMetadata = normalizeCommentDriverMetadata(result, attempted);
  const driverMetadata = currentMarker
    ? {
        ...normalizedDriverMetadata,
        stage: normalizedDriverMetadata.stage || "send_clicked",
        send_clicked_at: currentMarker.send_clicked_at,
        real_action_attempted: true
      }
    : normalizedDriverMetadata;
  let persistedState = loadState(baseDir);
  if (attempted === true) {
    try {
      persistedState = persistAttempt(baseDir, persistedState, details, "clicked", {
        ...driverMetadata
      });
    } catch {
      return outcomeUnknownResult(
        action,
        details,
        metadataWithPrimaryReason(driverMetadata, "moments_action_state_persist_failed")
      );
    }
  }
  if (result?.ok === false && attempted === false) {
    const reason = driverMetadata.primary_reason || "moments_comment_blocked_before_send";
    const blockedMetadata = metadataWithPrimaryReason(driverMetadata, reason);
    try {
      persistAttempt(baseDir, persistedState, details, "prepared", {
        reason,
        ...blockedMetadata
      });
    } catch {
      return persistenceBlockedResult(action, details);
    }
    return blockedResult(action, reason, {
      observation_id: context.observationId,
      attempt_key: attemptKey,
      previous_status: "prepared",
      retry_locked: false,
      ...blockedMetadata
    });
  }
  const readbackDiagnostics = visualVerificationRequired
    ? sanitizeVisualCommentReadbackDiagnostics(result?.diagnostics)
    : undefined;
  let readback = null;
  let verified = false;
  let verificationMode = "";
  let verificationLevel = "";
  if (visualVerificationRequired && attempted === true) {
    const exactCandidateVerified = validVisualCommentCandidateResult(result, context, attemptKey, commentText);
    const stateTransitionVerified = validVisualCommentStateTransitionResult(result, context, commentText);
    const locatorReady = validVisualCommentLocatorResult(result, context, attemptKey, commentText);
    verified = exactCandidateVerified || stateTransitionVerified;
    if (stateTransitionVerified) {
      verificationMode = VISUAL_COMMENT_STATE_TRANSITION_MODE;
      verificationLevel = VISUAL_COMMENT_STATE_TRANSITION_LEVEL;
    } else if (exactCandidateVerified) {
      verificationMode = VISUAL_COMMENT_VERIFICATION_MODE;
      verificationLevel = VISUAL_COMMENT_VERIFICATION_LEVEL;
    }
    if (locatorReady || (exactCandidateVerified && options.enhancedReadback === true)) {
      readback = await readbackVisualComment(driver, context, attemptKey, commentText, result);
      if (readback.ok === true) {
        verified = true;
        verificationMode = COMMENT_READBACK_VERIFICATION_MODE;
        verificationLevel = ENHANCED_COMMENT_VERIFICATION_LEVEL;
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
    const failureMetadata = metadataWithPrimaryReason(driverMetadata, verificationReason);
    try {
      persistAttempt(baseDir, persistedState, details, "outcome_unknown", {
        reason: verificationReason,
        ...failureMetadata,
        readback_checked_at: undefined,
        readback_proof: readback?.proof,
        readback_diagnostics: readbackDiagnostics
      });
    } catch {}
    return outcomeUnknownResult(action, details, failureMetadata);
  }

  const verifiedMetadata = {
    ...driverMetadata,
    stage: driverMetadata.stage,
    verification_mode: verificationMode,
    real_action_attempted: true
  };
  try {
    persistAttempt(baseDir, persistedState, details, "verified", {
      comment_text_verified: commentText,
      ...verifiedMetadata,
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
    return outcomeUnknownResult(
      action,
      details,
      metadataWithPrimaryReason(verifiedMetadata, "moments_action_state_persist_failed")
    );
  }
  removeCommentSendMarker(sendMarkerPath);
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
    ...verifiedMetadata
  };
}

module.exports = {
  COMMENT_SEND_VERIFIED_STAGE,
  MENU_STATES,
  MOMENTS_DRY_RUN_TTL_MS,
  NON_RETRYABLE_ATTEMPT_STATUSES,
  UIA_COMMENT_VERIFICATION_MODE,
  VISUAL_COMMENT_LOCATOR_LEVEL,
  VISUAL_COMMENT_LOCATOR_MODE,
  VISUAL_COMMENT_STATE_TRANSITION_LEVEL,
  VISUAL_COMMENT_STATE_TRANSITION_MODE,
  VISUAL_COMMENT_VERIFICATION_LEVEL,
  VISUAL_COMMENT_VERIFICATION_MODE,
  createMomentsAttemptKey,
  executeMomentsComment,
  executeMomentsExpandFullText,
  executeMomentsLike,
  inspectMomentsMenu,
  loadMomentsActionContext
};
