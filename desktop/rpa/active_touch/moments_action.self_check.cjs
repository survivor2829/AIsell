const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  momentsPostFingerprint,
  momentsPostIdentityPrefix,
  prepareMomentsDryRun,
  stableMomentsContentSimilarity,
  stableMomentsPostIdentityText,
  stableMomentsPostLabel
} = require("./moments_dry_run.dev.cjs");
const { loadState, saveState } = require("./state_machine.cjs");
const {
  COMMENT_READBACK_REQUIRED_PROOF_KEYS,
  COMMENT_READBACK_VERIFICATION_MODE
} = require("./moments_comment_readback_proof.dev.cjs");
const {
  COMMENT_SEND_VERIFIED_STAGE,
  MOMENTS_DRY_RUN_TTL_MS,
  UIA_COMMENT_VERIFICATION_MODE,
  VISUAL_COMMENT_LOCATOR_LEVEL,
  VISUAL_COMMENT_LOCATOR_MODE,
  VISUAL_COMMENT_STATE_TRANSITION_LEVEL,
  VISUAL_COMMENT_STATE_TRANSITION_MODE,
  VISUAL_COMMENT_VERIFICATION_LEVEL,
  VISUAL_COMMENT_VERIFICATION_MODE,
  createMomentsAttemptKey,
  executeMomentsComment,
  executeMomentsLike,
  inspectMomentsMenu
} = require("./moments_action.dev.cjs");

const COMMENT_TEXT = "自动化测试，请忽略（0717-1）";
const COMMENT_DRAFT_CHECK_VERIFICATION_MODE = "targeted_uia_value_roundtrip_and_unique_enabled_button_transition";
const VISUAL_COMMENT_DRAFT_CHECK_VERIFICATION_MODE = "visual_clipboard_ordinal_roundtrip_and_unique_enabled_button_transition";
const MOMENTS_POST = {
  runtimeId: "42.7.10",
  automationId: "",
  structureVerified: true,
  feedDepth: 1,
  text: "测试账号 测试朋友圈内容 包含1张图片 刚刚",
  left: 120,
  top: 220,
  width: 480,
  height: 260
};
const MOMENTS_WINDOW = {
  ok: true,
  title: "朋友圈",
  className: "Qt51514QWindowIcon",
  automationId: "SNSWindow",
  identityMode: "automation_id",
  rootName: "朋友圈",
  rootControlType: "ControlType.Window",
  rootProcessId: 42,
  feedAutomationId: "sns_list",
  feedRuntimeId: "42.7.feed",
  feedCount: 1,
  processName: "Weixin",
  pid: 42,
  hWnd: "84",
  left: 40,
  top: 60,
  width: 900,
  height: 700,
  posts: [MOMENTS_POST]
};

const VISUAL_WINDOW = {
  ...MOMENTS_WINDOW,
  automationId: "",
  identityMode: "visual_mmui_render",
  feedAutomationId: "",
  feedRuntimeId: "",
  feedCount: 0,
  renderPaneName: "MMUIRenderSubWindowHW",
  renderPaneAutomationId: "",
  renderPaneControlType: "ControlType.Pane",
  renderPaneProcessId: 42,
  renderPaneRuntimeId: "42.9.render",
  renderPaneBounds: {
    left: 60,
    top: 80,
    width: 840,
    height: 640
  },
  posts: undefined
};

function visualObservationPayload(window, snapshot) {
  return JSON.stringify({
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
}

function visualPreparedDirectory(root, name) {
  const baseDir = path.join(root, name);
  const window = JSON.parse(JSON.stringify(VISUAL_WINDOW));
  const snapshot = {
    source: "visual:windows_media_ocr",
    identity_scope: "window_session_only",
    structure_verified: true,
    ocr_provider: "windows_media_ocr",
    ocr_language: "zh-Hans-CN",
    region_hash: "1".repeat(64),
    avatar_hash: "3".repeat(64),
    layout_hash: "2".repeat(64),
    label: MOMENTS_POST.text,
    identity_text: MOMENTS_POST.text,
    stable_anchor_text: `${MOMENTS_POST.text} stable anchor`,
    post_fingerprint: momentsPostFingerprint(MOMENTS_POST.text),
    bounds: { left: 140, top: 180, width: 620, height: 320 },
    menu_bounds: { left: 760, top: 430, width: 80, height: 40 },
    avatar_bounds: { left: 82, top: 190, width: 48, height: 48 }
  };
  snapshot.observation_id = crypto.createHash("sha256")
    .update(visualObservationPayload(window, snapshot), "utf8")
    .digest("hex");
  saveState(baseDir, {
    ...loadState(baseDir),
    moments_dry_run: {
      status: "prepared",
      prepared_at: new Date().toISOString(),
      mode: "targeted",
      like_enabled: true,
      comment_enabled: true,
      comment_text: COMMENT_TEXT,
      target_verified: true,
      window,
      post_snapshot: snapshot
    }
  });
  return {
    baseDir,
    observationId: snapshot.observation_id,
    postFingerprint: snapshot.post_fingerprint
  };
}

function setNestedValue(target, dottedPath, value) {
  const parts = dottedPath.split(".");
  const leaf = parts.pop();
  let current = target;
  for (const part of parts) current = current[part];
  current[leaf] = value;
}

function preparedDirectory(root, name, commentText = COMMENT_TEXT, momentsWindow = MOMENTS_WINDOW) {
  const baseDir = path.join(root, name);
  const result = prepareMomentsDryRun(baseDir, {
    mode: "targeted",
    likeEnabled: true,
    commentEnabled: true,
    commentText
  }, () => momentsWindow);
  assert.equal(result.ok, true);
  return {
    baseDir,
    observationId: result.post_snapshot.observation_id,
    postFingerprint: result.post_snapshot.post_fingerprint
  };
}

function writeCommentSendMarker(
  fixture,
  attemptKey,
  commentText = COMMENT_TEXT,
  sendClickedAt = "2026-07-28T12:00:00.000Z",
  overrides = {}
) {
  const snapshot = loadState(fixture.baseDir).moments_dry_run.post_snapshot;
  const postFingerprint = String(overrides.postFingerprint ?? fixture.postFingerprint);
  const markerPath = path.join(
    fixture.baseDir,
    "moments_comment_send_markers",
    `${postFingerprint}.json`
  );
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    version: 1,
    kind: "moments_comment_send_click",
    status: "click_attempted",
    attempt_key: attemptKey,
    post_fingerprint: postFingerprint,
    observation_id: String(overrides.observationId ?? fixture.observationId),
    comment_text_sha256: crypto.createHash("sha256").update(commentText, "utf8").digest("hex"),
    avatar_hash: String(overrides.avatarHash ?? snapshot.avatar_hash),
    identity_text: String(overrides.identityText ?? snapshot.identity_text),
    stable_anchor_text: String(overrides.stableAnchorText ?? snapshot.stable_anchor_text ?? ""),
    send_clicked_at: sendClickedAt
  }), "utf8");
  return markerPath;
}

function updateVisualFixtureIdentity(fixture, {
  identityText,
  stableAnchorText,
  avatarHash,
  commentText = COMMENT_TEXT,
  label = identityText
}) {
  const state = loadState(fixture.baseDir);
  const snapshot = state.moments_dry_run.post_snapshot;
  snapshot.identity_text = identityText;
  snapshot.label = label;
  snapshot.stable_anchor_text = stableAnchorText;
  snapshot.avatar_hash = avatarHash;
  snapshot.post_fingerprint = momentsPostFingerprint(identityText);
  snapshot.observation_id = crypto.createHash("sha256")
    .update(visualObservationPayload(state.moments_dry_run.window, snapshot), "utf8")
    .digest("hex");
  state.moments_dry_run.comment_text = commentText;
  saveState(fixture.baseDir, state);
  return {
    baseDir: fixture.baseDir,
    observationId: snapshot.observation_id,
    postFingerprint: snapshot.post_fingerprint
  };
}

function verifiedDriver(observationId, overrides = {}) {
  return {
    inspectMenu: () => ({ ok: true, observationId, menuState: "赞" }),
    inspectCommentDraft: (context) => ({
      ok: true,
      status: "comment_draft_verified",
      actionAttempted: false,
      commentStatus: "draft_verified",
      observationId,
      commentText: context.commentText,
      verificationMode: COMMENT_DRAFT_CHECK_VERIFICATION_MODE
    }),
    like: () => ({ ok: true, actionAttempted: true, observationId, menuState: "取消" }),
    comment: (context) => ({
      ok: true,
      actionAttempted: true,
      observationId,
      commentVerified: true,
      commentText: context.commentText,
      verificationMode: "exact_comment_count_increment_and_editor_completion"
    }),
    ...overrides
  };
}

function verifiedCommentReadback(observationId, commentText, proofOverrides = {}) {
  return {
    ok: true,
    status: "readback_verified",
    actionAttempted: false,
    commentVerified: true,
    observationId,
    commentText,
    verificationMode: COMMENT_READBACK_VERIFICATION_MODE,
    proof: {
      ...Object.fromEntries(COMMENT_READBACK_REQUIRED_PROOF_KEYS.map((key) => [key, true])),
      ...proofOverrides
    }
  };
}

function verifiedVisibleComment(fixture, context, overrides = {}) {
  const state = loadState(fixture.baseDir);
  const snapshot = state.moments_dry_run.post_snapshot;
  return {
    ok: true,
    status: "visible_verified",
    actionAttempted: true,
    realActionAttempted: true,
    observationId: fixture.observationId,
    commentText: COMMENT_TEXT,
    commentVerified: true,
    stage: "send_verified",
    sendClickedAt: new Date().toISOString(),
    verificationMode: VISUAL_COMMENT_VERIFICATION_MODE,
    verificationLevel: VISUAL_COMMENT_VERIFICATION_LEVEL,
    normalizedOcrCountBefore: 0,
    normalizedOcrCountAfter: 1,
    diagnostics: {
      composerCompleted: true,
      anchorStable: true,
      menuStable: true,
      menuMatchCount: 1,
      candidateCount: 1,
      candidateExactMatch: true,
      candidateHashStable: true,
      candidateStable: true
    },
    readbackSeed: {
      version: 1,
      observationId: fixture.observationId,
      attemptKey: context.attemptKey,
      postFingerprint: snapshot.post_fingerprint,
      commentTextSha256: crypto.createHash("sha256").update(COMMENT_TEXT, "utf8").digest("hex"),
      candidateBounds: { left: 180, top: 460, width: 260, height: 24 },
      candidatePixelHash: "4".repeat(64),
      avatarHash: snapshot.avatar_hash,
      menuBounds: { left: 720, top: 370, width: 80, height: 40 },
      expectedInputTick: 1234,
      createdAtMs: Date.now()
    },
    ...overrides
  };
}

function verifiedStateTransitionComment(fixture, context, overrides = {}) {
  return {
    ok: true,
    status: "visible_verified",
    actionAttempted: true,
    realActionAttempted: true,
    observationId: fixture.observationId,
    commentText: context.commentText,
    commentVerified: true,
    stage: "send_verified",
    sendClickedAt: new Date().toISOString(),
    verificationMode: VISUAL_COMMENT_STATE_TRANSITION_MODE,
    verificationLevel: VISUAL_COMMENT_STATE_TRANSITION_LEVEL,
    normalizedOcrCountBefore: 0,
    normalizedOcrCountAfter: 0,
    diagnostics: {
      composerCompleted: true,
      composerClosed: true,
      sendInactive: false,
      sendButtonClicked: true
    },
    ...overrides
  };
}

function locatedVisualComment(fixture, context, overrides = {}) {
  const exact = verifiedVisibleComment(fixture, context);
  return {
    ...exact,
    status: "readback_required",
    commentVerified: false,
    verificationMode: VISUAL_COMMENT_LOCATOR_MODE,
    verificationLevel: VISUAL_COMMENT_LOCATOR_LEVEL,
    diagnostics: {
      ...exact.diagnostics,
      candidateExactMatch: false,
      candidateLocatorOnly: true,
      candidateMatchMode: "fuzzy"
    },
    ...overrides
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-moments-action-"));
  try {
    assert.equal(MOMENTS_DRY_RUN_TTL_MS, 300_000);
    const key = createMomentsAttemptKey({ postFingerprint: "a".repeat(64), action: "comment", commentText: COMMENT_TEXT });
    assert.match(key, /^[0-9a-f]{64}$/u);
    assert.equal(key, createMomentsAttemptKey({ postFingerprint: "a".repeat(64), action: "comment", commentText: COMMENT_TEXT }));
    assert.notEqual(key, createMomentsAttemptKey({ postFingerprint: "a".repeat(64), action: "comment", commentText: `${COMMENT_TEXT}2` }));
    assert.notEqual(key, createMomentsAttemptKey({ postFingerprint: "a".repeat(64), action: "like" }));

    const yesterdayBodyA = "测试账号 昨天 去公园 刚刚";
    const yesterdayBodyB = "测试账号 昨天 在家工作 刚刚";
    assert.equal(stableMomentsPostLabel(yesterdayBodyA), "测试账号 昨天 去公园");
    assert.equal(stableMomentsPostLabel(yesterdayBodyB), "测试账号 昨天 在家工作");
    assert.notEqual(momentsPostFingerprint(yesterdayBodyA), momentsPostFingerprint(yesterdayBodyB), "relative-time words inside the body must not collapse different posts");
    assert.notEqual(
      momentsPostFingerprint("测试账号 昨天 去公园"),
      momentsPostFingerprint("测试账号 昨天 在家工作"),
      "an internal relative-time word must preserve distinct post bodies"
    );
    assert.equal(stableMomentsPostLabel("测试账号 昨天 去公园"), "测试账号 昨天 去公园");
    assert.equal(momentsPostIdentityPrefix("测试账号 昨天 去公园"), "测试账号 昨天 去公园");
    assert.equal(momentsPostIdentityPrefix("测试账号 稳定正文 5 秒前 点赞 评论"), "测试账号 稳定正文");
    const visualIdentityBeforeComment = "测试账号 稳定正文 5 秒前";
    const visualIdentityAfterComment = `${visualIdentityBeforeComment} 测试账号: 已有评论`;
    assert.equal(
      momentsPostFingerprint(visualIdentityBeforeComment),
      momentsPostFingerprint(visualIdentityAfterComment),
      "comments appended below the post timestamp must not change the durable post fingerprint"
    );
    const relativeTimeLabel = "测试账号 稳定正文 5 分钟前 赞 评论";
    const absoluteTimeLabel = "测试账号 稳定正文 7月15日 取消 评论";
    const datedOwnPostLabel = "测试账号 稳定正文 2026年7月15日 删除 取消赞 评论";
    assert.equal(stableMomentsPostLabel(relativeTimeLabel), "测试账号 稳定正文");
    assert.equal(stableMomentsPostLabel(absoluteTimeLabel), "测试账号 稳定正文");
    assert.equal(stableMomentsPostLabel(datedOwnPostLabel), "测试账号 稳定正文");
    assert.equal(momentsPostFingerprint(relativeTimeLabel), momentsPostFingerprint(absoluteTimeLabel), "relative and absolute timestamps must keep one post fingerprint");
    assert.equal(momentsPostFingerprint(relativeTimeLabel), momentsPostFingerprint(datedOwnPostLabel), "delete and like-state UI suffixes must not change the fingerprint");
    assert.equal(momentsPostIdentityPrefix(absoluteTimeLabel), "测试账号 稳定正文");
    assert.equal(stableMomentsPostLabel("测试账号 计划在 7月15日 去公园"), "测试账号 计划在 7月15日 去公园");

    const stableIdentity = "author stable post content 1234567890";
    assert.equal(
      stableMomentsContentSimilarity(stableIdentity, "author stable post content 123456789X"),
      true,
      "one-character OCR drift must retain the stable post identity"
    );
    assert.equal(
      stableMomentsContentSimilarity(stableIdentity, "unrelated post content 9876543210"),
      false
    );
    assert.equal(
      stableMomentsPostIdentityText(
        "short",
        "other",
        "author stable anchor content 1234567890",
        "author stable anchor content 123456789X"
      ),
      true,
      "a stable anchor must recover a post when the full OCR identity is too short"
    );

    const structuralWindow = {
      ...MOMENTS_WINDOW,
      automationId: "",
      identityMode: "structural_sns_feed"
    };
    const structuralDir = path.join(root, "structural-window-identity");
    const structuralDryRun = prepareMomentsDryRun(structuralDir, {
      mode: "targeted",
      likeEnabled: true,
      commentEnabled: true,
      commentText: COMMENT_TEXT
    }, () => structuralWindow);
    assert.equal(structuralDryRun.ok, true);
    assert.equal(structuralDryRun.window.identityMode, "structural_sns_feed");
    assert.equal(structuralDryRun.window.automationId, "");
    const structuralSnapshot = structuralDryRun.post_snapshot;
    const structuralObservationPayload = JSON.stringify({
      version: 2,
      pid: structuralDryRun.window.pid,
      hWnd: structuralDryRun.window.hWnd,
      windowBounds: {
        left: structuralDryRun.window.left,
        top: structuralDryRun.window.top,
        width: structuralDryRun.window.width,
        height: structuralDryRun.window.height
      },
      windowAutomationId: structuralDryRun.window.automationId,
      windowIdentityMode: structuralDryRun.window.identityMode,
      windowRootName: structuralDryRun.window.rootName,
      windowRootControlType: structuralDryRun.window.rootControlType,
      windowRootProcessId: structuralDryRun.window.rootProcessId,
      windowFeedAutomationId: structuralDryRun.window.feedAutomationId,
      windowFeedRuntimeId: structuralDryRun.window.feedRuntimeId,
      windowFeedCount: structuralDryRun.window.feedCount,
      runtimeId: structuralSnapshot.runtime_id,
      automationId: structuralSnapshot.automation_id,
      feedDepth: structuralSnapshot.feed_depth,
      label: structuralSnapshot.label,
      postFingerprint: structuralSnapshot.post_fingerprint,
      bounds: structuralSnapshot.bounds
    });
    assert.equal(
      structuralSnapshot.observation_id,
      crypto.createHash("sha256").update(structuralObservationPayload, "utf8").digest("hex"),
      "the observation hash must bind every structural identity field"
    );

    const invalidStructuralFields = [
      ["identityMode", "unknown"],
      ["automationId", "SNSWindow"],
      ["rootName", "其他窗口"],
      ["rootControlType", "ControlType.Pane"],
      ["rootProcessId", 99],
      ["feedAutomationId", "other_feed"],
      ["feedRuntimeId", ""],
      ["feedCount", 2],
      ["feedCount", "1"]
    ];
    for (const [field, value] of invalidStructuralFields) {
      const invalidResult = prepareMomentsDryRun(path.join(root, `invalid-structural-${field}-${String(value)}`), {
        mode: "targeted",
        likeEnabled: true,
        commentEnabled: false,
        commentText: ""
      }, () => ({ ...structuralWindow, [field]: value }));
      assert.equal(invalidResult.blocked_reason, "moments_window_identity_mismatch", `${field} must fail closed during dry-run`);
    }
    for (const [field, value] of invalidStructuralFields.slice(0, 8)) {
      const tamperDir = path.join(root, `tampered-structural-${field}`);
      const prepared = prepareMomentsDryRun(tamperDir, {
        mode: "targeted",
        likeEnabled: true,
        commentEnabled: false,
        commentText: ""
      }, () => structuralWindow);
      const tamperedState = loadState(tamperDir);
      tamperedState.moments_dry_run.window[field] = value;
      saveState(tamperDir, tamperedState);
      let driverCalls = 0;
      const tamperedResult = await inspectMomentsMenu({
        baseDir: tamperDir,
        observationId: prepared.post_snapshot.observation_id,
        driver: {
          inspectMenu: () => { driverCalls += 1; return {}; }
        }
      });
      assert.equal(tamperedResult.blocked_reason, "moments_observation_snapshot_invalid", `${field} tampering must stop before the driver`);
      assert.equal(driverCalls, 0);
    }

    const visualFixture = visualPreparedDirectory(root, "visual-observation-positive");
    let visualDriverCalls = 0;
    const visualResult = await inspectMomentsMenu({
      baseDir: visualFixture.baseDir,
      observationId: visualFixture.observationId,
      driver: verifiedDriver(visualFixture.observationId, {
        inspectMenu: () => {
          visualDriverCalls += 1;
          return { ok: true, observationId: visualFixture.observationId, menuState: "赞" };
        }
      })
    });
    assert.equal(visualResult.ok, true, "a complete visual v5 observation must reach the driver");
    assert.equal(visualDriverCalls, 1);

    const legacyObservationFixture = visualPreparedDirectory(root, "visual-observation-legacy-without-anchor");
    const legacyObservationState = loadState(legacyObservationFixture.baseDir);
    const legacyObservationSnapshot = legacyObservationState.moments_dry_run.post_snapshot;
    delete legacyObservationSnapshot.stable_anchor_text;
    legacyObservationSnapshot.observation_id = crypto.createHash("sha256")
      .update(visualObservationPayload(legacyObservationState.moments_dry_run.window, legacyObservationSnapshot), "utf8")
      .digest("hex");
    saveState(legacyObservationFixture.baseDir, legacyObservationState);
    let legacyObservationDriverCalls = 0;
    const legacyObservationResult = await inspectMomentsMenu({
      baseDir: legacyObservationFixture.baseDir,
      observationId: legacyObservationSnapshot.observation_id,
      driver: verifiedDriver(legacyObservationSnapshot.observation_id, {
        inspectMenu: () => {
          legacyObservationDriverCalls += 1;
          return { ok: true, observationId: legacyObservationSnapshot.observation_id, menuState: "\u8d5e" };
        }
      })
    });
    assert.equal(legacyObservationResult.ok, true, "a legacy visual observation without a stable anchor must remain valid");
    assert.equal(legacyObservationDriverCalls, 1);

    const invalidAvatarFixture = visualPreparedDirectory(root, "visual-observation-avatar-missing");
    const invalidAvatarState = loadState(invalidAvatarFixture.baseDir);
    const invalidAvatarSnapshot = invalidAvatarState.moments_dry_run.post_snapshot;
    invalidAvatarSnapshot.avatar_hash = "";
    invalidAvatarSnapshot.observation_id = crypto.createHash("sha256")
      .update(visualObservationPayload(invalidAvatarState.moments_dry_run.window, invalidAvatarSnapshot), "utf8")
      .digest("hex");
    saveState(invalidAvatarFixture.baseDir, invalidAvatarState);
    let invalidAvatarDriverCalls = 0;
    const invalidAvatarResult = await inspectMomentsMenu({
      baseDir: invalidAvatarFixture.baseDir,
      observationId: invalidAvatarSnapshot.observation_id,
      driver: {
        inspectMenu: () => {
          invalidAvatarDriverCalls += 1;
          return {};
        }
      }
    });
    assert.equal(invalidAvatarResult.blocked_reason, "moments_observation_snapshot_invalid");
    assert.equal(invalidAvatarDriverCalls, 0, "an invalid avatar hash must stop before the driver");

    const stableVisualIdentity = `${MOMENTS_POST.text} 10:20`;
    const visualPost = (text, identityText, regionDigit, layoutDigit, avatarDigit = "9") => ({
      text,
      identityText,
      structureVerified: true,
      regionHash: regionDigit.repeat(64),
      avatarHash: avatarDigit.repeat(64),
      layoutHash: layoutDigit.repeat(64),
      bounds: { left: 140, top: 180, width: 620, height: 320 },
      menuBounds: { left: 760, top: 430, width: 80, height: 40 },
      avatarBounds: { left: 82, top: 190, width: 48, height: 48 }
    });
    const prepareVisualIdentity = (name, post) => prepareMomentsDryRun(path.join(root, name), {
      mode: "targeted",
      likeEnabled: true,
      commentEnabled: false,
      commentText: ""
    }, () => ({ ...VISUAL_WINDOW, posts: [post] }));
    const visualAvatarMissing = prepareVisualIdentity(
      "visual-identity-avatar-missing",
      { ...visualPost(stableVisualIdentity, stableVisualIdentity, "1", "2"), avatarHash: "" }
    );
    assert.equal(visualAvatarMissing.blocked_reason, "moments_post_identity_missing");
    const visualBeforeInteraction = prepareVisualIdentity(
      "visual-identity-before-interaction",
      visualPost(`${stableVisualIdentity} 已有点赞`, stableVisualIdentity, "3", "4")
    );
    const visualAfterInteraction = prepareVisualIdentity(
      "visual-identity-after-interaction",
      visualPost(`${stableVisualIdentity} 已有点赞 新评论`, stableVisualIdentity, "5", "6")
    );
    const visualBodyChanged = prepareVisualIdentity(
      "visual-identity-body-changed",
      visualPost(`${stableVisualIdentity} 正文变化 已有点赞 新评论`, `${stableVisualIdentity} 正文变化`, "7", "8")
    );
    assert.equal(visualBeforeInteraction.ok, true);
    assert.equal(visualAfterInteraction.ok, true);
    assert.equal(visualBodyChanged.ok, true);
    assert.equal(visualBeforeInteraction.post_snapshot.avatar_hash, "9".repeat(64));
    assert.equal(visualBeforeInteraction.post_snapshot.avatar_hash, visualAfterInteraction.post_snapshot.avatar_hash);
    assert.notEqual(visualBeforeInteraction.post_snapshot.region_hash, visualAfterInteraction.post_snapshot.region_hash);
    assert.equal(visualBeforeInteraction.post_snapshot.identity_text, stableVisualIdentity);
    assert.notEqual(visualBeforeInteraction.post_snapshot.label, visualAfterInteraction.post_snapshot.label);
    assert.equal(
      visualBeforeInteraction.post_snapshot.post_fingerprint,
      visualAfterInteraction.post_snapshot.post_fingerprint,
      "interaction rows below the menu must not change the visual post fingerprint"
    );
    assert.notEqual(
      visualBeforeInteraction.post_snapshot.observation_id,
      visualAfterInteraction.post_snapshot.observation_id,
      "the full visual observation must still bind interaction-region changes"
    );
    assert.notEqual(
      visualBeforeInteraction.post_snapshot.post_fingerprint,
      visualBodyChanged.post_snapshot.post_fingerprint,
      "body text changes above the menu must change the visual post fingerprint"
    );
    const generatedVisualObservationId = visualBeforeInteraction.post_snapshot.observation_id;
    const generatedVisualDriver = verifiedDriver(generatedVisualObservationId);
    let generatedVisualDriverCalls = 0;
    const generatedVisualResult = await inspectMomentsMenu({
      baseDir: path.join(root, "visual-identity-before-interaction"),
      observationId: generatedVisualObservationId,
      driver: {
        ...generatedVisualDriver,
        inspectMenu: (...args) => {
          generatedVisualDriverCalls += 1;
          return generatedVisualDriver.inspectMenu(...args);
        }
      }
    });
    assert.equal(generatedVisualResult.ok, true, "dry-run and action must agree on the visual v5 payload");
    assert.equal(generatedVisualDriverCalls, 1);

    const visualTamperCases = [
      ["window.title", "其他窗口"],
      ["window.processName", "OtherProcess"],
      ["window.pid", 43],
      ["window.hWnd", "85"],
      ["window.left", 41],
      ["window.top", 61],
      ["window.width", 899],
      ["window.height", 699],
      ["window.automationId", "SNSWindow"],
      ["window.identityMode", "structural_sns_feed"],
      ["window.rootName", "其他窗口"],
      ["window.rootControlType", "ControlType.Pane"],
      ["window.rootProcessId", 43],
      ["window.feedAutomationId", "sns_list"],
      ["window.feedRuntimeId", "42.7.feed"],
      ["window.feedCount", 1],
      ["window.renderPaneName", "OtherRenderPane"],
      ["window.renderPaneAutomationId", "render-pane"],
      ["window.renderPaneControlType", "ControlType.Window"],
      ["window.renderPaneProcessId", 43],
      ["window.renderPaneRuntimeId", "42.9.other-render"],
      ["window.renderPaneBounds.left", 61],
      ["window.renderPaneBounds.top", 81],
      ["window.renderPaneBounds.width", 839],
      ["window.renderPaneBounds.height", 639],
      ["snapshot.source", "uia:sns_list"],
      ["snapshot.identity_scope", "post_stable"],
      ["snapshot.structure_verified", false],
      ["snapshot.ocr_provider", "other_ocr"],
      ["snapshot.ocr_language", "en-US"],
      ["snapshot.region_hash", "3".repeat(64)],
      ["snapshot.avatar_hash", "4".repeat(64)],
      ["snapshot.layout_hash", "4".repeat(64)],
      ["snapshot.label", `${MOMENTS_POST.text} changed`],
      ["snapshot.identity_text", `${MOMENTS_POST.text} changed`],
      ["snapshot.stable_anchor_text", `${MOMENTS_POST.text} changed anchor`],
      ["snapshot.post_fingerprint", "f".repeat(64)],
      ["snapshot.bounds.left", 141],
      ["snapshot.bounds.top", 181],
      ["snapshot.bounds.width", 619],
      ["snapshot.bounds.height", 319],
      ["snapshot.menu_bounds.left", 761],
      ["snapshot.menu_bounds.top", 431],
      ["snapshot.menu_bounds.width", 79],
      ["snapshot.menu_bounds.height", 39],
      ["snapshot.avatar_bounds.left", 83],
      ["snapshot.avatar_bounds.top", 191],
      ["snapshot.avatar_bounds.width", 47],
      ["snapshot.avatar_bounds.height", 47]
    ];
    for (const [index, [field, value]] of visualTamperCases.entries()) {
      const fixture = visualPreparedDirectory(root, `visual-observation-tamper-${index}`);
      const state = loadState(fixture.baseDir);
      const target = field.startsWith("window.")
        ? state.moments_dry_run.window
        : state.moments_dry_run.post_snapshot;
      setNestedValue(target, field.replace(/^(?:window|snapshot)\./u, ""), value);
      saveState(fixture.baseDir, state);
      let driverCalls = 0;
      const result = await inspectMomentsMenu({
        baseDir: fixture.baseDir,
        observationId: fixture.observationId,
        driver: {
          inspectMenu: () => {
            driverCalls += 1;
            return {};
          }
        }
      });
      assert.equal(result.blocked_reason, "moments_observation_snapshot_invalid", `${field} tampering must invalidate the visual observation`);
      assert.equal(driverCalls, 0, `${field} tampering must stop before the driver`);
    }

    const fingerprintFixture = preparedDirectory(root, "fingerprint-original");
    const movedWindow = {
      ...MOMENTS_WINDOW,
      pid: 43,
      rootProcessId: 43,
      feedRuntimeId: "43.8.feed",
      hWnd: "85",
      left: 90,
      top: 110,
      posts: [{
        ...MOMENTS_POST,
        runtimeId: "43.8.11",
        text: "测试账号 测试朋友圈内容 包含1张图片 2 分钟前 点赞 评论",
        left: 170,
        top: 290,
        width: 500,
        height: 280
      }]
    };
    const movedFingerprintFixture = preparedDirectory(root, "fingerprint-moved", COMMENT_TEXT, movedWindow);
    assert.match(fingerprintFixture.postFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(movedFingerprintFixture.postFingerprint, fingerprintFixture.postFingerprint, "window/session/runtime identity, bounds, and relative time must not change the stable post fingerprint");
    assert.notEqual(movedFingerprintFixture.observationId, fingerprintFixture.observationId, "the full observation must still bind current geometry");
    assert.equal(
      createMomentsAttemptKey({ postFingerprint: movedFingerprintFixture.postFingerprint, action: "like" }),
      createMomentsAttemptKey({ postFingerprint: fingerprintFixture.postFingerprint, action: "like" }),
      "the same post must keep one like attempt key after moving"
    );
    assert.notEqual(
      createMomentsAttemptKey({ postFingerprint: fingerprintFixture.postFingerprint, action: "comment", commentText: COMMENT_TEXT }),
      createMomentsAttemptKey({ postFingerprint: fingerprintFixture.postFingerprint, action: "comment", commentText: `${COMMENT_TEXT}2` }),
      "different exact comments must have different attempt keys"
    );

    const stableDuplicateDir = path.join(root, "stable-duplicate-after-move");
    const firstStableDryRun = prepareMomentsDryRun(stableDuplicateDir, {
      mode: "targeted",
      likeEnabled: true,
      commentEnabled: false,
      commentText: ""
    }, () => MOMENTS_WINDOW);
    const firstStableLike = await executeMomentsLike({
      baseDir: stableDuplicateDir,
      observationId: firstStableDryRun.post_snapshot.observation_id,
      driver: verifiedDriver(firstStableDryRun.post_snapshot.observation_id)
    });
    assert.equal(firstStableLike.ok, true);
    const movedStableDryRun = prepareMomentsDryRun(stableDuplicateDir, {
      mode: "targeted",
      likeEnabled: true,
      commentEnabled: false,
      commentText: ""
    }, () => movedWindow);
    let movedDuplicateDriverCalls = 0;
    const movedStableLike = await executeMomentsLike({
      baseDir: stableDuplicateDir,
      observationId: movedStableDryRun.post_snapshot.observation_id,
      driver: verifiedDriver(movedStableDryRun.post_snapshot.observation_id, {
        inspectMenu: () => { movedDuplicateDriverCalls += 1; return {}; },
        like: () => { movedDuplicateDriverCalls += 1; return {}; }
      })
    });
    assert.equal(movedStableLike.blocked_reason, "moments_attempt_already_recorded");
    assert.equal(movedDuplicateDriverCalls, 0, "moving/reopening the same post must not bypass durable like deduplication");

    const inspectFixture = preparedDirectory(root, "inspect");
    let inspectedContext;
    let inspectedDraftContext;
    const inspectResult = await inspectMomentsMenu({
      ...inspectFixture,
      driver: verifiedDriver(inspectFixture.observationId, {
        inspectMenu: (context) => {
          inspectedContext = context;
          return { ok: true, observationId: inspectFixture.observationId, menuState: "赞" };
        },
        inspectCommentDraft: (context) => {
          inspectedDraftContext = context;
          return {
            ok: true,
            status: "comment_draft_verified",
            actionAttempted: false,
            commentStatus: "draft_verified",
            observationId: inspectFixture.observationId,
            commentText: context.commentText,
            verificationMode: COMMENT_DRAFT_CHECK_VERIFICATION_MODE
          };
        }
      })
    });
    assert.equal(inspectResult.ok, true);
    assert.equal(inspectResult.status, "verified");
    assert.equal(inspectResult.menu_state, "赞");
    assert.equal(inspectResult.comment_draft_verified, true);
    assert.equal(inspectResult.comment_draft_verification_mode, COMMENT_DRAFT_CHECK_VERIFICATION_MODE);
    assert.equal(inspectResult.comment_send_supported, true);
    assert.equal(inspectResult.real_action_attempted, false);
    assert.equal(inspectedContext.expectedWindow.hWnd, "84");
    assert.equal(inspectedContext.expectedWindow.identityMode, "automation_id");
    assert.equal(inspectedContext.expectedWindow.rootProcessId, 42);
    assert.equal(inspectedContext.expectedWindow.feedAutomationId, "sns_list");
    assert.equal(inspectedContext.expectedWindow.feedRuntimeId, "42.7.feed");
    assert.equal(inspectedContext.expectedWindow.feedCount, 1);
    assert.equal(inspectedContext.postSnapshot.runtime_id, "42.7.10");
    assert.equal(inspectedContext.observationId, inspectFixture.observationId);
    assert.equal(inspectedContext.deadlineMs, Date.parse(loadState(inspectFixture.baseDir).moments_dry_run.prepared_at) + MOMENTS_DRY_RUN_TTL_MS);
    assert.equal(inspectedDraftContext.action, "comment");
    assert.equal(inspectedDraftContext.phase, "draft_check");
    assert.equal(inspectedDraftContext.attemptKey, "");
    assert.equal(inspectedDraftContext.commentText, COMMENT_TEXT);
    const persistedInspection = loadState(inspectFixture.baseDir).moments_test_action.last_menu_inspection;
    assert.equal(persistedInspection.menu_state, "赞");
    assert.equal(persistedInspection.comment_draft_verified, true);
    assert.equal(persistedInspection.comment_draft_verification_mode, COMMENT_DRAFT_CHECK_VERIFICATION_MODE);
    assert.equal(persistedInspection.comment_send_supported, true);

    const visualDraftProofFixture = preparedDirectory(root, "inspect-comment-draft-proof-visual");
    const visualDraftProof = await inspectMomentsMenu({
      ...visualDraftProofFixture,
      driver: verifiedDriver(visualDraftProofFixture.observationId, {
        inspectCommentDraft: () => ({
          ok: true,
          status: "comment_draft_verified",
          actionAttempted: false,
          commentStatus: "draft_verified",
          observationId: visualDraftProofFixture.observationId,
          commentText: COMMENT_TEXT,
          verificationMode: VISUAL_COMMENT_DRAFT_CHECK_VERIFICATION_MODE
        })
      })
    });
    assert.equal(visualDraftProof.ok, true);
    assert.equal(visualDraftProof.comment_draft_verified, true);
    assert.equal(
      visualDraftProof.comment_draft_verification_mode,
      VISUAL_COMMENT_DRAFT_CHECK_VERIFICATION_MODE
    );
    assert.equal(visualDraftProof.real_action_attempted, false);
    assert.equal(
      loadState(visualDraftProofFixture.baseDir).moments_test_action.last_menu_inspection.comment_draft_verification_mode,
      VISUAL_COMMENT_DRAFT_CHECK_VERIFICATION_MODE
    );

    const missingDraftDriverFixture = preparedDirectory(root, "inspect-comment-draft-driver-missing");
    let missingDraftMenuCalls = 0;
    const missingDraftDriver = await inspectMomentsMenu({
      ...missingDraftDriverFixture,
      driver: {
        inspectMenu: () => {
          missingDraftMenuCalls += 1;
          return { ok: true, observationId: missingDraftDriverFixture.observationId, menuState: "赞" };
        }
      }
    });
    assert.equal(missingDraftDriver.blocked_reason, "moments_comment_editor_targeting_unsupported");
    assert.equal(missingDraftDriver.real_action_attempted, false);
    assert.equal(missingDraftMenuCalls, 0, "unsupported comment draft targeting must block before opening the menu");

    const unsupportedUiaSendFixture = preparedDirectory(root, "comment-uia-send-unsupported");
    const unsupportedUiaSend = await executeMomentsComment({
      ...unsupportedUiaSendFixture,
      commentText: COMMENT_TEXT
    });
    assert.equal(unsupportedUiaSend.blocked_reason, "moments_comment_send_targeting_unsupported");
    assert.equal(unsupportedUiaSend.real_action_attempted, false);
    assert.equal(Object.keys(loadState(unsupportedUiaSendFixture.baseDir).moments_test_action?.attempts ?? {}).length, 0);

    const invalidDraftProofFixture = preparedDirectory(root, "inspect-comment-draft-proof-invalid");
    const invalidDraftProof = await inspectMomentsMenu({
      ...invalidDraftProofFixture,
      driver: verifiedDriver(invalidDraftProofFixture.observationId, {
        inspectCommentDraft: () => ({
          ok: true,
          status: "comment_draft_verified",
          actionAttempted: true,
          commentStatus: "draft_verified",
          observationId: invalidDraftProofFixture.observationId,
          commentText: COMMENT_TEXT,
          verificationMode: COMMENT_DRAFT_CHECK_VERIFICATION_MODE
        })
      })
    });
    assert.equal(invalidDraftProof.blocked_reason, "moments_comment_draft_proof_invalid");
    assert.equal(invalidDraftProof.real_action_attempted, false);

    const unknownDraftProofFixture = preparedDirectory(root, "inspect-comment-draft-proof-unknown");
    const unknownDraftProof = await inspectMomentsMenu({
      ...unknownDraftProofFixture,
      driver: verifiedDriver(unknownDraftProofFixture.observationId, {
        inspectCommentDraft: () => ({
          ok: true,
          status: "comment_draft_verified",
          actionAttempted: false,
          commentStatus: "draft_verified",
          observationId: unknownDraftProofFixture.observationId,
          commentText: COMMENT_TEXT,
          verificationMode: "unrecognized_comment_draft_proof"
        })
      })
    });
    assert.equal(unknownDraftProof.blocked_reason, "moments_comment_draft_proof_invalid");
    assert.equal(unknownDraftProof.real_action_attempted, false);

    const menuOnlyDir = path.join(root, "inspect-menu-only");
    const menuOnlyDryRun = prepareMomentsDryRun(menuOnlyDir, {
      mode: "targeted",
      likeEnabled: true,
      commentEnabled: false,
      commentText: ""
    }, () => MOMENTS_WINDOW);
    const menuOnlyInspect = await inspectMomentsMenu({
      baseDir: menuOnlyDir,
      observationId: menuOnlyDryRun.post_snapshot.observation_id,
      driver: {
        inspectMenu: () => ({ ok: true, observationId: menuOnlyDryRun.post_snapshot.observation_id, menuState: "赞" })
      }
    });
    assert.equal(menuOnlyInspect.ok, true);
    assert.equal(menuOnlyInspect.comment_draft_verified, false);

    const alternateMenuFixture = preparedDirectory(root, "inspect-cancel");
    const alternateMenu = await inspectMomentsMenu({
      ...alternateMenuFixture,
      driver: verifiedDriver(alternateMenuFixture.observationId, {
        inspectMenu: () => ({ ok: true, observationId: alternateMenuFixture.observationId, menuState: "取消赞" })
      })
    });
    assert.equal(alternateMenu.ok, true);
    assert.equal(alternateMenu.menu_state, "取消赞");

    const invalidObservation = await inspectMomentsMenu({
      baseDir: inspectFixture.baseDir,
      observationId: "not-a-hash",
      driver: verifiedDriver(inspectFixture.observationId)
    });
    assert.equal(invalidObservation.blocked_reason, "moments_observation_id_invalid");
    const mismatchedObservation = await inspectMomentsMenu({
      baseDir: inspectFixture.baseDir,
      observationId: "b".repeat(64),
      driver: verifiedDriver(inspectFixture.observationId)
    });
    assert.equal(mismatchedObservation.blocked_reason, "moments_observation_id_mismatch");

    const tamperedFixture = preparedDirectory(root, "tampered");
    const tamperedState = loadState(tamperedFixture.baseDir);
    tamperedState.moments_dry_run.post_snapshot.label = "被替换的帖子";
    saveState(tamperedFixture.baseDir, tamperedState);
    const tampered = await inspectMomentsMenu({
      ...tamperedFixture,
      driver: verifiedDriver(tamperedFixture.observationId)
    });
    assert.equal(tampered.blocked_reason, "moments_observation_snapshot_invalid");

    const tamperedFingerprintFixture = preparedDirectory(root, "tampered-fingerprint");
    const tamperedFingerprintState = loadState(tamperedFingerprintFixture.baseDir);
    tamperedFingerprintState.moments_dry_run.post_snapshot.post_fingerprint = "f".repeat(64);
    saveState(tamperedFingerprintFixture.baseDir, tamperedFingerprintState);
    const tamperedFingerprint = await inspectMomentsMenu({
      ...tamperedFingerprintFixture,
      driver: verifiedDriver(tamperedFingerprintFixture.observationId)
    });
    assert.equal(tamperedFingerprint.blocked_reason, "moments_observation_snapshot_invalid");

    const expiredFixture = preparedDirectory(root, "expired");
    const expiredState = loadState(expiredFixture.baseDir);
    expiredState.moments_dry_run.prepared_at = new Date(Date.now() - MOMENTS_DRY_RUN_TTL_MS - 1).toISOString();
    saveState(expiredFixture.baseDir, expiredState);
    let expiredDriverCalls = 0;
    const expired = await executeMomentsLike({
      ...expiredFixture,
      driver: verifiedDriver(expiredFixture.observationId, {
        inspectMenu: () => { expiredDriverCalls += 1; return {}; },
        like: () => { expiredDriverCalls += 1; return {}; }
      })
    });
    assert.equal(expired.blocked_reason, "moments_dry_run_expired");
    assert.equal(expiredDriverCalls, 0, "an expired dry-run must stop before any driver call");

    const inexactMenuFixture = preparedDirectory(root, "inexact-menu");
    let inexactActionCalls = 0;
    const inexactMenu = await executeMomentsLike({
      ...inexactMenuFixture,
      driver: verifiedDriver(inexactMenuFixture.observationId, {
        inspectMenu: () => ({ ok: true, observationId: inexactMenuFixture.observationId, menuState: " 赞" }),
        like: () => { inexactActionCalls += 1; return {}; }
      })
    });
    assert.equal(inexactMenu.blocked_reason, "moments_menu_proof_invalid");
    assert.equal(inexactActionCalls, 0);

    const commentOnlyDir = path.join(root, "comment-only");
    const commentOnlyDryRun = prepareMomentsDryRun(commentOnlyDir, {
      mode: "targeted",
      likeEnabled: false,
      commentEnabled: true,
      commentText: COMMENT_TEXT
    }, () => MOMENTS_WINDOW);
    let unplannedLikeCalls = 0;
    const unplannedLike = await executeMomentsLike({
      baseDir: commentOnlyDir,
      observationId: commentOnlyDryRun.post_snapshot.observation_id,
      driver: verifiedDriver(commentOnlyDryRun.post_snapshot.observation_id, {
        inspectMenu: () => { unplannedLikeCalls += 1; return {}; },
        like: () => { unplannedLikeCalls += 1; return {}; }
      })
    });
    assert.equal(unplannedLike.blocked_reason, "moments_like_not_in_dry_run");
    assert.equal(unplannedLikeCalls, 0);

    const inspectThrowFixture = preparedDirectory(root, "inspect-throw");
    const inspectThrow = await executeMomentsLike({
      ...inspectThrowFixture,
      driver: verifiedDriver(inspectThrowFixture.observationId, {
        inspectMenu: () => { throw new Error("inspection crashed"); }
      })
    });
    assert.equal(inspectThrow.status, "blocked");
    assert.equal(inspectThrow.blocked_reason, "moments_menu_driver_failed");
    assert.equal(inspectThrow.real_action_attempted, false);
    const inspectDiagnosticsFixture = preparedDirectory(root, "inspect-diagnostics");
    const inspectDiagnostics = await executeMomentsLike({
      ...inspectDiagnosticsFixture,
      driver: verifiedDriver(inspectDiagnosticsFixture.observationId, {
        inspectMenu: () => ({
          ok: false,
          reason: "moments_menu_ambiguous",
          cleanupReason: "moments_menu_close_blocked",
          diagnostics: {
            requestedAction: "like",
            menuReadRetryCount: 1,
            firstReason: "moments_menu_surface_ambiguous",
            secondReason: "moments_menu_ambiguous",
            firstSegmentCount: 2,
            secondSegmentCount: -1,
            firstStrictCandidateCount: 0,
            secondStrictCandidateCount: 0,
            firstFallbackCandidateCount: 2,
            secondFallbackCandidateCount: 3,
            firstLikeOcrMatched: false,
            firstLikeBaseOcrMatched: false,
            firstTargetedLikeOcrAttempted: true,
            firstTargetedLikeOcrMatched: false,
            firstCommentOcrMatched: false,
            firstLikeSignatureOk: true,
            firstCommentSignatureOk: true,
            firstLikeSignatureEdgeClear: false,
            firstCommentSignatureEdgeClear: true,
            firstLikeResolutionMode: "targeted_ocr",
            firstWidthRatio: 0.7,
            firstHeightRatio: 1,
            secondLikeOcrMatched: false,
            secondLikeBaseOcrMatched: false,
            secondTargetedLikeOcrAttempted: true,
            secondTargetedLikeOcrMatched: "false",
            secondCommentOcrMatched: true,
            secondLikeSignatureOk: false,
            secondCommentSignatureOk: true,
            secondLikeSignatureEdgeClear: false,
            secondCommentSignatureEdgeClear: true,
            secondLikeResolutionMode: "unknown_mode",
            secondWidthRatio: Number.POSITIVE_INFINITY,
            secondHeightRatio: 11,
            rawOcrText: "PRIVATE-MENU-OCR"
          }
        })
      })
    });
    assert.equal(inspectDiagnostics.blocked_reason, "moments_menu_ambiguous");
    assert.equal(inspectDiagnostics.primary_reason, "moments_menu_ambiguous");
    assert.equal(inspectDiagnostics.cleanup_reason, "moments_menu_close_blocked");
    assert.deepEqual(inspectDiagnostics.diagnostics, {
      requested_action: "like",
      menu_read_retry_count: 1,
      first_reason: "moments_menu_surface_ambiguous",
      second_reason: "moments_menu_ambiguous",
      first_segment_count: 2,
      first_strict_candidate_count: 0,
      second_strict_candidate_count: 0,
      first_fallback_candidate_count: 2,
      second_fallback_candidate_count: 3,
      first_like_ocr_matched: false,
      first_like_base_ocr_matched: false,
      first_targeted_like_ocr_attempted: true,
      first_targeted_like_ocr_matched: false,
      first_comment_ocr_matched: false,
      first_like_signature_ok: true,
      first_comment_signature_ok: true,
      first_like_signature_edge_clear: false,
      first_comment_signature_edge_clear: true,
      first_like_resolution_mode: "targeted_ocr",
      first_width_ratio: 0.7,
      first_height_ratio: 1,
      second_like_ocr_matched: false,
      second_like_base_ocr_matched: false,
      second_targeted_like_ocr_attempted: true,
      second_comment_ocr_matched: true,
      second_like_signature_ok: false,
      second_comment_signature_ok: true,
      second_like_signature_edge_clear: false,
      second_comment_signature_edge_clear: true,
    });
    assert.equal(JSON.stringify(inspectDiagnostics).includes("PRIVATE-MENU-OCR"), false);

    const alreadyLikedFixture = preparedDirectory(root, "already-liked");
    let alreadyLikedCalls = 0;
    const alreadyLiked = await executeMomentsLike({
      ...alreadyLikedFixture,
      driver: verifiedDriver(alreadyLikedFixture.observationId, {
        inspectMenu: () => ({
          ok: true,
          observationId: alreadyLikedFixture.observationId,
          menuState: "取消",
          cleanupReason: "moments_menu_close_blocked",
        }),
        like: () => { alreadyLikedCalls += 1; return {}; }
      })
    });
    assert.equal(alreadyLiked.ok, true);
    assert.equal(alreadyLiked.no_op, true);
    assert.equal(alreadyLiked.real_action_attempted, false);
    assert.equal(alreadyLiked.cleanup_reason, "moments_menu_close_blocked");
    assert.equal(alreadyLikedCalls, 0);
    const persistedAlreadyLiked = loadState(alreadyLikedFixture.baseDir).moments_test_action;
    assert.equal(persistedAlreadyLiked.attempts[alreadyLiked.attempt_key].status, "verified");
    assert.equal(persistedAlreadyLiked.real_action_attempted, false);
    assert.equal(persistedAlreadyLiked.menu_state, alreadyLiked.menu_state);
    assert.equal(persistedAlreadyLiked.no_op, true);
    assert.equal(
      persistedAlreadyLiked.attempts[alreadyLiked.attempt_key].cleanup_reason,
      "moments_menu_close_blocked",
    );
    const alreadyLikedRepeat = await executeMomentsLike({
      ...alreadyLikedFixture,
      driver: verifiedDriver(alreadyLikedFixture.observationId, {
        inspectMenu: () => { throw new Error("must not inspect a recorded attempt"); }
      })
    });
    assert.equal(alreadyLikedRepeat.blocked_reason, "moments_attempt_already_recorded");

    const likeFixture = preparedDirectory(root, "like-success");
    const likeCalls = [];
    const likeSuccess = await executeMomentsLike({
      ...likeFixture,
      driver: verifiedDriver(likeFixture.observationId, {
        inspectMenu: (context) => {
          likeCalls.push("inspect");
          assert.equal(context.phase, "before");
          return { ok: true, observationId: likeFixture.observationId, menuState: "赞" };
        },
        like: (context) => {
          likeCalls.push("like");
          const diskAttempt = loadState(likeFixture.baseDir).moments_test_action.attempts[context.attemptKey];
          assert.equal(diskAttempt.status, "prepared", "prepared must be durable before the irreversible call");
          return {
            ok: true,
            actionAttempted: true,
            observationId: likeFixture.observationId,
            menuState: "取消赞",
            cleanupReason: "moments_menu_close_blocked",
            verificationMode: "visual_menu_state_transition_and_static_anchor",
            diagnostics: {
              requestedAction: "like",
              proofPurpose: "verify_outcome",
              menuReadRetryCount: 1,
              firstRequiresStability: true,
              secondRequiresStability: true,
              outcomeObservationCount: 2,
            },
          };
        }
      })
    });
    assert.deepEqual(likeCalls, ["inspect", "like"]);
    assert.equal(likeSuccess.ok, true);
    assert.equal(likeSuccess.status, "verified");
    assert.equal(likeSuccess.real_action_attempted, true);
    assert.equal(likeSuccess.cleanup_reason, "moments_menu_close_blocked");
    assert.equal(
      likeSuccess.verification_mode,
      "visual_menu_state_transition_and_static_anchor",
    );
    const persistedLikeSuccess = loadState(likeFixture.baseDir).moments_test_action;
    assert.equal(persistedLikeSuccess.attempts[likeSuccess.attempt_key].status, "verified");
    assert.equal(persistedLikeSuccess.action, "moments-like");
    assert.equal(persistedLikeSuccess.status, "verified");
    assert.equal(persistedLikeSuccess.attempt_key, likeSuccess.attempt_key);
    assert.equal(persistedLikeSuccess.real_action_attempted, true);
    assert.equal(persistedLikeSuccess.menu_state, likeSuccess.menu_state);
    assert.equal(persistedLikeSuccess.no_op, false);
    assert.equal(
      persistedLikeSuccess.attempts[likeSuccess.attempt_key].cleanup_reason,
      "moments_menu_close_blocked",
    );
    assert.equal(
      persistedLikeSuccess.attempts[likeSuccess.attempt_key].verification_mode,
      "visual_menu_state_transition_and_static_anchor",
    );
    assert.deepEqual(
      persistedLikeSuccess.attempts[likeSuccess.attempt_key].diagnostics,
      {
        requested_action: "like",
        proof_purpose: "verify_outcome",
        menu_read_retry_count: 1,
        first_requires_stability: true,
        second_requires_stability: true,
        outcome_observation_count: 2,
      },
    );

    const inspectAfterLike = await inspectMomentsMenu({
      ...likeFixture,
      driver: verifiedDriver(likeFixture.observationId)
    });
    assert.equal(inspectAfterLike.ok, true);
    assert.notEqual(inspectAfterLike.menu_state, likeSuccess.menu_state);
    const persistedInspectAfterLike = loadState(likeFixture.baseDir).moments_test_action;
    assert.equal(persistedInspectAfterLike.action, "moments-menu-inspect");
    assert.equal(persistedInspectAfterLike.status, "verified");
    assert.equal(persistedInspectAfterLike.real_action_attempted, false);
    assert.equal(persistedInspectAfterLike.menu_state, inspectAfterLike.menu_state);
    assert.equal(persistedInspectAfterLike.no_op, undefined);
    assert.equal(persistedInspectAfterLike.attempt_key, undefined);
    assert.deepEqual(persistedInspectAfterLike.attempts, persistedLikeSuccess.attempts);

    const blockedInspectAfterLike = await inspectMomentsMenu({
      ...likeFixture,
      driver: verifiedDriver(likeFixture.observationId, {
        inspectMenu: () => { throw new Error("latest inspect has no verified menu state"); }
      })
    });
    assert.equal(blockedInspectAfterLike.blocked_reason, "moments_menu_driver_failed");
    const persistedBlockedInspectAfterLike = loadState(likeFixture.baseDir).moments_test_action;
    assert.equal(persistedBlockedInspectAfterLike.action, "moments-menu-inspect");
    assert.equal(persistedBlockedInspectAfterLike.status, "blocked");
    assert.equal(persistedBlockedInspectAfterLike.real_action_attempted, false);
    assert.equal(persistedBlockedInspectAfterLike.menu_state, undefined);
    assert.equal(persistedBlockedInspectAfterLike.no_op, undefined);
    assert.deepEqual(persistedBlockedInspectAfterLike.attempts, persistedLikeSuccess.attempts);
    const likeRepeat = await executeMomentsLike({
      ...likeFixture,
      driver: verifiedDriver(likeFixture.observationId, {
        inspectMenu: () => { throw new Error("duplicate must stop before driver"); }
      })
    });
    assert.equal(likeRepeat.blocked_reason, "moments_attempt_already_recorded");

    for (const status of ["prepared", "clicked", "verified", "outcome_unknown"]) {
      const fixture = preparedDirectory(root, `terminal-${status}`);
      const attemptKey = createMomentsAttemptKey({ postFingerprint: fixture.postFingerprint, action: "like" });
      const state = loadState(fixture.baseDir);
      state.moments_test_action = {
        version: 1,
        attempts: { [attemptKey]: { action: "moments-like", status } }
      };
      saveState(fixture.baseDir, state);
      let calls = 0;
      const result = await executeMomentsLike({
        ...fixture,
        driver: verifiedDriver(fixture.observationId, {
          inspectMenu: () => { calls += 1; return {}; },
          like: () => { calls += 1; return {}; }
        })
      });
      assert.equal(result.blocked_reason, "moments_attempt_already_recorded");
      assert.equal(result.previous_status, status);
      assert.equal(result.real_action_attempted, false);
      assert.equal(result.previous_real_action_attempted, null);
      assert.equal(calls, 0, `${status} attempts must never be retried`);
    }

    const likeThrowFixture = preparedDirectory(root, "like-throw");
    let thrownLikeCalls = 0;
    const likeThrow = await executeMomentsLike({
      ...likeThrowFixture,
      driver: verifiedDriver(likeThrowFixture.observationId, {
        like: () => { thrownLikeCalls += 1; throw new Error("click result lost"); }
      })
    });
    assert.equal(likeThrow.status, "outcome_unknown");
    assert.equal(likeThrow.real_action_attempted, null);
    assert.equal(thrownLikeCalls, 1);
    assert.equal(loadState(likeThrowFixture.baseDir).moments_test_action.attempts[likeThrow.attempt_key].status, "outcome_unknown");
    const likeThrowRepeat = await executeMomentsLike({
      ...likeThrowFixture,
      driver: verifiedDriver(likeThrowFixture.observationId, {
        like: () => { thrownLikeCalls += 1; return {}; }
      })
    });
    assert.equal(likeThrowRepeat.blocked_reason, "moments_attempt_already_recorded");
    assert.equal(likeThrowRepeat.previous_status, "outcome_unknown");
    assert.equal(likeThrowRepeat.real_action_attempted, false);
    assert.equal(likeThrowRepeat.previous_real_action_attempted, null);
    assert.equal(thrownLikeCalls, 1);

    const badLikeProofFixture = preparedDirectory(root, "like-bad-proof");
    const badLikeProof = await executeMomentsLike({
      ...badLikeProofFixture,
      driver: verifiedDriver(badLikeProofFixture.observationId, {
        like: () => ({ ok: true, actionAttempted: true, observationId: badLikeProofFixture.observationId, menuState: "赞" })
      })
    });
    assert.equal(badLikeProof.status, "outcome_unknown");
    assert.equal(badLikeProof.real_action_attempted, true);
    const likeUnknownDiagnosticsFixture = preparedDirectory(root, "like-unknown-diagnostics");
    const likeUnknownDiagnostics = await executeMomentsLike({
      ...likeUnknownDiagnosticsFixture,
      driver: verifiedDriver(likeUnknownDiagnosticsFixture.observationId, {
        like: () => ({
          ok: true,
          actionAttempted: true,
          observationId: likeUnknownDiagnosticsFixture.observationId,
          menuState: "not-liked",
          diagnostics: {
            requestedAction: "like",
            menuReadRetryCount: 1,
            firstReason: "moments_menu_ambiguous",
            rawOcrText: "PRIVATE-UNKNOWN-OCR"
          }
        })
      })
    });
    assert.equal(likeUnknownDiagnostics.status, "outcome_unknown");
    assert.deepEqual(likeUnknownDiagnostics.diagnostics, { requested_action: "like", menu_read_retry_count: 1, first_reason: "moments_menu_ambiguous" });
    assert.equal(JSON.stringify(likeUnknownDiagnostics).includes("PRIVATE-UNKNOWN-OCR"), false);
    assert.deepEqual(loadState(likeUnknownDiagnosticsFixture.baseDir).moments_test_action.attempts[likeUnknownDiagnostics.attempt_key].diagnostics, likeUnknownDiagnostics.diagnostics);

    const likeBlockedFixture = preparedDirectory(root, "like-blocked-before-click");
    const likeBlocked = await executeMomentsLike({
      ...likeBlockedFixture,
      driver: verifiedDriver(likeBlockedFixture.observationId, {
        like: () => ({
          ok: false,
          status: "blocked",
          reason: "moments_like_click_blocked",
          actionAttempted: false,
          diagnostics: {
            requestedAction: "like",
            menuReadRetryCount: 2,
            firstReason: "moments_menu_ambiguous",
            firstSegmentCount: 2,
            rawOcrText: "PRIVATE-LIKE-OCR"
          }
        })
      })
    });
    assert.equal(likeBlocked.status, "blocked");
    assert.equal(likeBlocked.blocked_reason, "moments_like_click_blocked");
    assert.equal(likeBlocked.real_action_attempted, false);
    assert.equal(likeBlocked.retry_locked, true);
    assert.deepEqual(likeBlocked.diagnostics, { requested_action: "like", menu_read_retry_count: 2, first_reason: "moments_menu_ambiguous", first_segment_count: 2 });
    assert.equal(JSON.stringify(likeBlocked).includes("PRIVATE-LIKE-OCR"), false);
    assert.deepEqual(loadState(likeBlockedFixture.baseDir).moments_test_action.attempts[likeBlocked.attempt_key].diagnostics, likeBlocked.diagnostics);
    assert.equal(loadState(likeBlockedFixture.baseDir).moments_test_action.attempts[likeBlocked.attempt_key].status, "prepared");

    const commentValidationFixture = preparedDirectory(root, "comment-validation");
    assert.equal((await executeMomentsComment({ ...commentValidationFixture, commentText: "", driver: verifiedDriver(commentValidationFixture.observationId) })).blocked_reason, "moments_comment_exact_text_required");
    assert.equal((await executeMomentsComment({ ...commentValidationFixture, commentText: "不匹配", driver: verifiedDriver(commentValidationFixture.observationId) })).blocked_reason, "moments_comment_not_in_dry_run");
    assert.equal((await executeMomentsComment({ ...commentValidationFixture, commentText: "有  两个空格", driver: verifiedDriver(commentValidationFixture.observationId) })).blocked_reason, "moments_comment_not_in_dry_run");
    assert.equal((await executeMomentsComment({ ...commentValidationFixture, commentText: "长".repeat(501), driver: verifiedDriver(commentValidationFixture.observationId) })).blocked_reason, "moments_comment_too_long");

    for (const status of ["clicked", "verified", "outcome_unknown"]) {
      const fixture = preparedDirectory(root, `comment-text-lock-${status}`);
      const previousPostFingerprint = fixture.postFingerprint;
      const previousAttemptKey = createMomentsAttemptKey({
        postFingerprint: previousPostFingerprint,
        action: "comment",
        commentText: COMMENT_TEXT
      });
      const state = loadState(fixture.baseDir);
      state.moments_test_action = {
        version: 1,
        attempt_key: "a".repeat(64),
        previous_attempt_key: "b".repeat(64),
        candidate_attempt_key: "c".repeat(64),
        previous_status: "verified",
        attempts: {
          [previousAttemptKey]: {
            action: "moments-comment",
            status,
            post_fingerprint: previousPostFingerprint,
            comment_text: COMMENT_TEXT
          }
        }
      };
      saveState(fixture.baseDir, state);
      let calls = 0;
      const result = await executeMomentsComment({
        ...fixture,
        commentText: COMMENT_TEXT,
        driver: verifiedDriver(fixture.observationId, {
          inspectMenu: () => { calls += 1; return {}; },
          comment: () => { calls += 1; return {}; }
        })
      });
      assert.equal(result.blocked_reason, "moments_comment_text_already_attempted");
      assert.equal(result.attempt_key, previousAttemptKey);
      assert.equal(result.previous_attempt_key, previousAttemptKey);
      assert.equal(result.candidate_attempt_key, previousAttemptKey);
      assert.equal(result.previous_status, status);
      assert.equal(result.real_action_attempted, false);
      assert.equal(result.previous_real_action_attempted, null);
      assert.equal(calls, 0, `${status} exact comment attempts must stop before every driver call`);
      const persistedAction = loadState(fixture.baseDir).moments_test_action;
      assert.equal(persistedAction.attempt_key, previousAttemptKey);
      assert.equal(persistedAction.previous_attempt_key, previousAttemptKey);
      assert.equal(persistedAction.candidate_attempt_key, result.candidate_attempt_key);
      assert.equal(persistedAction.previous_status, status);
      assert.equal(persistedAction.real_action_attempted, false);
      assert.equal(persistedAction.previous_real_action_attempted, null);
      assert.equal(persistedAction.attempts[result.candidate_attempt_key].status, status);
      assert.deepEqual(Object.keys(persistedAction.attempts), [previousAttemptKey]);
    }

    const knownPreClickFailureFixture = preparedDirectory(root, "comment-known-pre-click-failure");
    const knownPreClickFailureKey = createMomentsAttemptKey({
      postFingerprint: knownPreClickFailureFixture.postFingerprint,
      action: "comment",
      commentText: COMMENT_TEXT
    });
    const knownPreClickFailureState = loadState(knownPreClickFailureFixture.baseDir);
    knownPreClickFailureState.moments_test_action = {
      version: 1,
      attempts: {
        [knownPreClickFailureKey]: {
          action: "moments-comment",
          status: "prepared",
          post_fingerprint: knownPreClickFailureFixture.postFingerprint,
          comment_text: COMMENT_TEXT,
          real_action_attempted: false,
          reason: "moments_menu_changed"
        }
      }
    };
    saveState(knownPreClickFailureFixture.baseDir, knownPreClickFailureState);
    let knownPreClickFailureDriverCalls = 0;
    const knownPreClickFailureResult = await executeMomentsComment({
      ...knownPreClickFailureFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(knownPreClickFailureFixture.observationId, {
        inspectMenu: () => {
          knownPreClickFailureDriverCalls += 1;
          return { ok: true, observationId: knownPreClickFailureFixture.observationId, menuState: "赞" };
        },
        comment: () => {
          knownPreClickFailureDriverCalls += 1;
          return {
            ok: true,
            actionAttempted: true,
            observationId: knownPreClickFailureFixture.observationId,
            commentVerified: true,
            commentText: COMMENT_TEXT,
            verificationMode: "exact_comment_count_increment_and_editor_completion"
          };
        }
      })
    });
    assert.equal(knownPreClickFailureResult.ok, true, JSON.stringify(knownPreClickFailureResult));
    assert.equal(knownPreClickFailureResult.status, "verified");
    assert.equal(knownPreClickFailureDriverCalls, 2, "a proven pre-click failure must be retryable");

    const differentCommentText = `${COMMENT_TEXT}（不同文案）`;
    const differentTextFixture = preparedDirectory(root, "comment-text-lock-different", differentCommentText);
    const differentTextState = loadState(differentTextFixture.baseDir);
    const oldTextAttemptKey = createMomentsAttemptKey({
      postFingerprint: differentTextFixture.postFingerprint,
      action: "comment",
      commentText: COMMENT_TEXT
    });
    differentTextState.moments_test_action = {
      version: 1,
      attempts: {
        [oldTextAttemptKey]: {
          action: "moments-comment",
          status: "outcome_unknown",
          post_fingerprint: differentTextFixture.postFingerprint,
          comment_text: COMMENT_TEXT
        }
      }
    };
    saveState(differentTextFixture.baseDir, differentTextState);
    let differentTextDriverCalls = 0;
    const differentTextResult = await executeMomentsComment({
      ...differentTextFixture,
      commentText: differentCommentText,
      driver: verifiedDriver(differentTextFixture.observationId, {
        inspectMenu: () => {
          differentTextDriverCalls += 1;
          return { ok: true, observationId: differentTextFixture.observationId, menuState: "赞" };
        },
        comment: () => {
          differentTextDriverCalls += 1;
          return {
            ok: true,
            actionAttempted: true,
            observationId: differentTextFixture.observationId,
            commentVerified: true,
            commentText: differentCommentText,
            verificationMode: "exact_comment_count_increment_and_editor_completion"
          };
        }
      })
    });
    assert.equal(differentTextResult.blocked_reason, "moments_comment_post_already_attempted");
    assert.equal(differentTextResult.previous_attempt_key, oldTextAttemptKey);
    assert.equal(differentTextResult.previous_status, "outcome_unknown");
    assert.equal(differentTextResult.real_action_attempted, false);
    assert.equal(differentTextResult.previous_real_action_attempted, null);
    assert.equal(differentTextDriverCalls, 0, "a post with any prior comment attempt must stop before every driver call even when AI text changes");

    const commentFixture = preparedDirectory(root, "comment-success");
    const commentCalls = [];
    const commentSendClickedAt = "2026-07-28T01:02:03.000Z";
    const commentSuccess = await executeMomentsComment({
      ...commentFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(commentFixture.observationId, {
        inspectMenu: (context) => {
          commentCalls.push("inspect");
          assert.equal(context.commentText, COMMENT_TEXT);
          return { ok: true, observationId: commentFixture.observationId, menuState: "取消" };
        },
        comment: (context) => {
          commentCalls.push("comment");
          const diskAttempt = loadState(commentFixture.baseDir).moments_test_action.attempts[context.attemptKey];
          assert.equal(diskAttempt.status, "prepared", "comment must persist prepared before submit");
          assert.equal(context.commentText, COMMENT_TEXT);
          return {
            ok: true,
            actionAttempted: true,
            observationId: commentFixture.observationId,
            commentVerified: true,
            commentText: COMMENT_TEXT,
            verificationMode: "exact_comment_count_increment_and_editor_completion",
            stage: "post_send_verified",
            sendClickedAt: commentSendClickedAt,
            diagnostics: {
              composerCompleted: true,
              sendButtonLocated: true,
              sendButtonCount: 1
            }
          };
        }
      })
    });
    assert.deepEqual(commentCalls, ["inspect", "comment"]);
    assert.equal(commentSuccess.ok, true);
    assert.equal(commentSuccess.status, "verified");
    assert.equal(commentSuccess.comment_text, COMMENT_TEXT);
    assert.equal(commentSuccess.stage, "post_send_verified");
    assert.equal(commentSuccess.send_clicked_at, commentSendClickedAt);
    assert.equal(commentSuccess.verification_mode, "exact_comment_count_increment_and_editor_completion");
    assert.deepEqual(commentSuccess.diagnostics, {
      composer_completed: true,
      send_button_located: true,
      send_button_count: 1
    });
    const commentSuccessState = loadState(commentFixture.baseDir).moments_test_action;
    const commentSuccessAttempt = commentSuccessState.attempts[commentSuccess.attempt_key];
    assert.equal(commentSuccessAttempt.comment_text_verified, COMMENT_TEXT);
    assert.equal(commentSuccessAttempt.stage, "post_send_verified");
    assert.equal(commentSuccessAttempt.send_clicked_at, commentSendClickedAt);
    assert.equal(commentSuccessState.stage, "post_send_verified");
    assert.equal(commentSuccessState.send_clicked_at, commentSendClickedAt);
    const commentRepeat = await executeMomentsComment({
      ...commentFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(commentFixture.observationId, {
        inspectMenu: () => { throw new Error("duplicate comment must not reach driver"); }
      })
    });
    assert.equal(commentRepeat.blocked_reason, "moments_comment_text_already_attempted");
    assert.equal(commentRepeat.attempt_key, commentSuccess.attempt_key);
    assert.equal(commentRepeat.real_action_attempted, false);

    const visualCommentFixture = visualPreparedDirectory(root, "visual-comment-readback-success");
    const visualCommentCalls = [];
    let visualCommentMarkerPath = "";
    const visualCommentSuccess = await executeMomentsComment({
      ...visualCommentFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(visualCommentFixture.observationId, {
        inspectMenu: () => { throw new Error("visual comment must not open and close a preliminary menu"); },
        comment: (context) => {
          visualCommentCalls.push("comment");
          assert.equal(
            loadState(visualCommentFixture.baseDir).moments_test_action.attempts[context.attemptKey].status,
            "prepared"
          );
          visualCommentMarkerPath = writeCommentSendMarker(
            visualCommentFixture,
            context.attemptKey,
            context.commentText
          );
          return verifiedVisibleComment(visualCommentFixture, context);
        },
        commentReadback: () => { throw new Error("standard visible verification must not right-click"); }
      })
    });
    assert.deepEqual(visualCommentCalls, ["comment"]);
    assert.equal(visualCommentSuccess.ok, true);
    assert.equal(visualCommentSuccess.stage, COMMENT_SEND_VERIFIED_STAGE);
    assert.equal(visualCommentSuccess.verification_mode, VISUAL_COMMENT_VERIFICATION_MODE);
    assert.equal(visualCommentSuccess.verification_level, VISUAL_COMMENT_VERIFICATION_LEVEL);
    assert.equal(visualCommentSuccess.readback_enhancement_status, "not_requested");
    assert.equal(fs.existsSync(visualCommentMarkerPath), false, "verified state must replace and clear the click marker");
    const visualVerifiedAttempt = loadState(visualCommentFixture.baseDir)
      .moments_test_action.attempts[visualCommentSuccess.attempt_key];
    assert.equal(visualVerifiedAttempt.status, "verified");
    assert.equal(visualVerifiedAttempt.verification_mode, VISUAL_COMMENT_VERIFICATION_MODE);
    assert.equal(visualVerifiedAttempt.verification_level, VISUAL_COMMENT_VERIFICATION_LEVEL);
    assert.equal(visualVerifiedAttempt.visible_candidate_proof.candidate_exact_match, true);
    assert.equal(visualVerifiedAttempt.visible_candidate_proof.candidate_stable, true);
    assert.equal(visualVerifiedAttempt.readback_enhancement_status, "not_requested");

    const visualCommentRepeat = await executeMomentsComment({
      ...visualCommentFixture,
      commentText: COMMENT_TEXT,
      driver: {
        inspectMenu: () => { throw new Error("verified text must stop before inspection"); },
        comment: () => { throw new Error("verified text must never resend"); },
        commentReadback: () => { throw new Error("verified text must not reread as a resend path"); }
      }
    });
    assert.equal(visualCommentRepeat.blocked_reason, "moments_comment_text_already_attempted");

    const stateTransitionFixture = visualPreparedDirectory(root, "visual-comment-state-transition-success");
    let stateTransitionCommentCalls = 0;
    const stateTransitionSuccess = await executeMomentsComment({
      ...stateTransitionFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(stateTransitionFixture.observationId, {
        comment: (context) => {
          stateTransitionCommentCalls += 1;
          return verifiedStateTransitionComment(stateTransitionFixture, context);
        },
        commentReadback: () => {
          throw new Error("state transition verification must not depend on OCR readback");
        }
      })
    });
    assert.equal(stateTransitionCommentCalls, 1);
    assert.equal(stateTransitionSuccess.ok, true);
    assert.equal(stateTransitionSuccess.status, "verified");
    assert.equal(stateTransitionSuccess.real_action_attempted, true);
    assert.equal(stateTransitionSuccess.verification_mode, VISUAL_COMMENT_STATE_TRANSITION_MODE);
    assert.equal(stateTransitionSuccess.verification_level, VISUAL_COMMENT_STATE_TRANSITION_LEVEL);
    const stateTransitionAttempt = loadState(stateTransitionFixture.baseDir)
      .moments_test_action.attempts[stateTransitionSuccess.attempt_key];
    assert.equal(stateTransitionAttempt.status, "verified");
    assert.equal(stateTransitionAttempt.verification_mode, VISUAL_COMMENT_STATE_TRANSITION_MODE);
    assert.equal(stateTransitionAttempt.verification_level, VISUAL_COMMENT_STATE_TRANSITION_LEVEL);
    assert.equal(stateTransitionAttempt.visible_candidate_proof.composer_closed, true);
    assert.equal(stateTransitionAttempt.visible_candidate_proof.send_inactive, false);

    for (const [name, missingField] of [
      ["missing-stage", "stage"],
      ["missing-click-time", "sendClickedAt"],
      ["missing-real-action", "realActionAttempted"]
    ]) {
      const invalidTransitionFixture = visualPreparedDirectory(root, `visual-comment-state-transition-${name}`);
      const invalidTransition = await executeMomentsComment({
        ...invalidTransitionFixture,
        commentText: COMMENT_TEXT,
        driver: verifiedDriver(invalidTransitionFixture.observationId, {
          comment: (context) => verifiedStateTransitionComment(
            invalidTransitionFixture,
            context,
            { [missingField]: undefined }
          )
        })
      });
      assert.equal(invalidTransition.ok, false);
      assert.equal(invalidTransition.status, "outcome_unknown");
      assert.equal(
        loadState(invalidTransitionFixture.baseDir)
          .moments_test_action.attempts[invalidTransition.attempt_key].status,
        "outcome_unknown"
      );
    }

    const enhancedCommentFixture = visualPreparedDirectory(root, "visual-comment-enhanced-readback-success");
    let enhancedReadbackCalls = 0;
    const enhancedCommentSuccess = await executeMomentsComment({
      ...enhancedCommentFixture,
      commentText: COMMENT_TEXT,
      enhancedReadback: true,
      driver: verifiedDriver(enhancedCommentFixture.observationId, {
        comment: (context) => verifiedVisibleComment(enhancedCommentFixture, context),
        commentReadback: (context) => {
          enhancedReadbackCalls += 1;
          assert.equal(context.phase, "readback");
          assert.equal(
            loadState(enhancedCommentFixture.baseDir).moments_test_action.attempts[context.attemptKey].status,
            "clicked",
            "the irreversible click must be durable before enhanced readback begins"
          );
          return verifiedCommentReadback(enhancedCommentFixture.observationId, COMMENT_TEXT);
        }
      })
    });
    assert.equal(enhancedReadbackCalls, 1);
    assert.equal(enhancedCommentSuccess.ok, true);
    assert.equal(enhancedCommentSuccess.verification_mode, COMMENT_READBACK_VERIFICATION_MODE);
    assert.equal(enhancedCommentSuccess.verification_level, "clipboard_exact");
    assert.equal(enhancedCommentSuccess.readback_enhancement_status, "verified");
    const enhancedVerifiedAttempt = loadState(enhancedCommentFixture.baseDir)
      .moments_test_action.attempts[enhancedCommentSuccess.attempt_key];
    assert.ok(COMMENT_READBACK_REQUIRED_PROOF_KEYS.every((key) => enhancedVerifiedAttempt.readback_proof[key] === true));

    const fuzzyLocatorFixture = visualPreparedDirectory(root, "visual-comment-fuzzy-locator-readback-success");
    let fuzzyLocatorCommentCalls = 0;
    let fuzzyLocatorReadbackCalls = 0;
    const fuzzyLocatorSuccess = await executeMomentsComment({
      ...fuzzyLocatorFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(fuzzyLocatorFixture.observationId, {
        comment: (context) => {
          fuzzyLocatorCommentCalls += 1;
          return locatedVisualComment(fuzzyLocatorFixture, context);
        },
        commentReadback: (context) => {
          fuzzyLocatorReadbackCalls += 1;
          assert.equal(context.phase, "readback");
          return verifiedCommentReadback(fuzzyLocatorFixture.observationId, COMMENT_TEXT);
        }
      })
    });
    assert.equal(fuzzyLocatorCommentCalls, 1);
    assert.equal(fuzzyLocatorReadbackCalls, 1, "a fuzzy locator must automatically require exact clipboard readback");
    assert.equal(fuzzyLocatorSuccess.ok, true);
    assert.equal(fuzzyLocatorSuccess.verification_mode, COMMENT_READBACK_VERIFICATION_MODE);
    assert.equal(fuzzyLocatorSuccess.verification_level, "clipboard_exact");
    const fuzzyLocatorAttempt = loadState(fuzzyLocatorFixture.baseDir)
      .moments_test_action.attempts[fuzzyLocatorSuccess.attempt_key];
    assert.equal(fuzzyLocatorAttempt.status, "verified");
    assert.equal(fuzzyLocatorAttempt.visible_candidate_proof.candidate_exact_match, false);
    assert.equal(fuzzyLocatorAttempt.visible_candidate_proof.candidate_locator_only, true);
    assert.equal(fuzzyLocatorAttempt.visible_candidate_proof.candidate_match_mode, "fuzzy");
    assert.ok(COMMENT_READBACK_REQUIRED_PROOF_KEYS.every((key) => fuzzyLocatorAttempt.readback_proof[key] === true));

    const fuzzyMismatchFixture = visualPreparedDirectory(root, "visual-comment-fuzzy-locator-readback-mismatch");
    let fuzzyMismatchCommentCalls = 0;
    let fuzzyMismatchReadbackCalls = 0;
    const fuzzyMismatch = await executeMomentsComment({
      ...fuzzyMismatchFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(fuzzyMismatchFixture.observationId, {
        comment: (context) => {
          fuzzyMismatchCommentCalls += 1;
          return locatedVisualComment(fuzzyMismatchFixture, context);
        },
        commentReadback: () => {
          fuzzyMismatchReadbackCalls += 1;
          return {
            ok: false,
            status: "readback_blocked",
            actionAttempted: false,
            reason: "moments_comment_readback_text_mismatch",
            proof: {
              ...Object.fromEntries(COMMENT_READBACK_REQUIRED_PROOF_KEYS.map((key) => [key, true])),
              clipboardOrdinalMatched: false
            }
          };
        }
      })
    });
    assert.equal(fuzzyMismatch.status, "outcome_unknown");
    assert.equal(fuzzyMismatch.driver_reason, "moments_comment_readback_text_mismatch");
    assert.equal(fuzzyMismatchCommentCalls, 1);
    assert.equal(fuzzyMismatchReadbackCalls, 1);
    const fuzzyMismatchRepeat = await executeMomentsComment({
      ...fuzzyMismatchFixture,
      commentText: COMMENT_TEXT,
      driver: {
        inspectMenu: () => { throw new Error("an unknown fuzzy attempt must stop before inspection"); },
        comment: () => { throw new Error("an unknown fuzzy attempt must never resend"); },
        commentReadback: () => { throw new Error("a duplicate request must not perform a new readback"); }
      }
    });
    assert.equal(fuzzyMismatchRepeat.blocked_reason, "moments_comment_text_already_attempted");
    assert.equal(fuzzyMismatchRepeat.real_action_attempted, false);

    const fuzzyAmbiguousFixture = visualPreparedDirectory(root, "visual-comment-fuzzy-locator-ambiguous");
    let fuzzyAmbiguousReadbackCalls = 0;
    const fuzzyAmbiguous = await executeMomentsComment({
      ...fuzzyAmbiguousFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(fuzzyAmbiguousFixture.observationId, {
        comment: (context) => locatedVisualComment(fuzzyAmbiguousFixture, context, {
          diagnostics: {
            ...locatedVisualComment(fuzzyAmbiguousFixture, context).diagnostics,
            candidateCount: 2
          }
        }),
        commentReadback: () => {
          fuzzyAmbiguousReadbackCalls += 1;
          return verifiedCommentReadback(fuzzyAmbiguousFixture.observationId, COMMENT_TEXT);
        }
      })
    });
    assert.equal(fuzzyAmbiguous.status, "outcome_unknown");
    assert.equal(fuzzyAmbiguousReadbackCalls, 0, "an ambiguous fuzzy locator must never reach clipboard readback");

    const seedDiagnosticsFixture = visualPreparedDirectory(root, "visual-comment-seed-diagnostics");
    const privateDiagnosticMarker = "PRIVATE_VISUAL_DIAGNOSTIC_MUST_NOT_PERSIST";
    const seedSendClickedAt = "2026-07-28T02:03:04.000Z";
    const seedDiagnosticsFailure = await executeMomentsComment({
      ...seedDiagnosticsFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(seedDiagnosticsFixture.observationId, {
        comment: () => ({
          ok: false,
          status: "outcome_unknown",
          actionAttempted: true,
          reason: "moments_comment_draft_close_unverified",
          primaryReason: "moments_comment_readback_seed_unavailable",
          cleanupReason: "moments_comment_draft_close_unverified",
          stage: "send_clicked",
          sendClickedAt: seedSendClickedAt,
          verificationMode: "green_component_state_transition_v1",
          diagnostics: {
            composerCompleted: true,
            sendButtonLocated: true,
            sendButtonCount: 1,
            anchorStable: true,
            menuStable: true,
            menuMatchCount: 1,
            candidateReason: "moments_comment_candidate_ambiguous",
            candidateCount: 2,
            candidateHashStable: false,
            menuReadRetryCount: 1,
            firstReason: "moments_menu_surface_ambiguous",
            secondReason: "moments_comment_draft_state_unknown",
            requestedAction: "comment",
            firstSegmentCount: 3,
            secondSegmentCount: 2,
            firstStrictCandidateCount: 0,
            secondStrictCandidateCount: 1,
            firstFallbackCandidateCount: 2,
            secondFallbackCandidateCount: 1,
            blankCheckpointRetryCount: 1,
            retryReason: "moments_comment_draft_state_unknown",
            checkpointPass: 1,
            startedInputTick: 1234,
            finishedInputTick: 1234,
            inputTickStable: true,
            stableComposerOk: false,
            stableComposerReason: "moments_comment_composer_not_found",
            settledComposerOk: true,
            settledComposerReason: "moments_comment_composer_recovered",
            stableSendOk: false,
            stableSendReason: "moments_comment_send_button_ambiguous",
            settledSendOk: false,
            settledSendReason: "moments_comment_send_button_not_found",
            stableSendCandidateCount: 2,
            settledSendCandidateCount: 0,
            ownedClickReason: "moments_comment_open_blocked",
            ownedClickPhase: "confirmed_hit",
            pointInsideSurface: true,
            surfaceInsidePopup: true,
            surfaceInsideWindow: true,
            firstRootMatchesSecond: false,
            foregroundOk: true,
            sendOcrText: privateDiagnosticMarker,
            rawOcrText: privateDiagnosticMarker,
            firstRawOcrText: privateDiagnosticMarker,
            secondRawOcrText: privateDiagnosticMarker,
            stableRawOcrText: privateDiagnosticMarker,
            settledRawOcrText: privateDiagnosticMarker,
            stderr: privateDiagnosticMarker,
            clipboardText: privateDiagnosticMarker,
            nested: { raw: privateDiagnosticMarker }
          }
        })
      })
    });
    assert.equal(seedDiagnosticsFailure.status, "outcome_unknown");
    assert.equal(seedDiagnosticsFailure.driver_reason, "moments_comment_readback_seed_unavailable");
    assert.equal(seedDiagnosticsFailure.primary_reason, "moments_comment_readback_seed_unavailable");
    assert.equal(seedDiagnosticsFailure.cleanup_reason, "moments_comment_draft_close_unverified");
    assert.equal(seedDiagnosticsFailure.stage, "send_clicked");
    assert.equal(seedDiagnosticsFailure.send_clicked_at, seedSendClickedAt);
    assert.equal(seedDiagnosticsFailure.verification_mode, "green_component_state_transition_v1");
    assert.equal(seedDiagnosticsFailure.real_action_attempted, true);
    assert.equal(JSON.stringify(seedDiagnosticsFailure.diagnostics).includes(privateDiagnosticMarker), false);
    const seedDiagnosticsAttempt = loadState(seedDiagnosticsFixture.baseDir)
      .moments_test_action.attempts[seedDiagnosticsFailure.attempt_key];
    assert.equal(seedDiagnosticsAttempt.reason, "moments_comment_readback_seed_unavailable");
    assert.equal(seedDiagnosticsAttempt.primary_reason, "moments_comment_readback_seed_unavailable");
    assert.equal(seedDiagnosticsAttempt.cleanup_reason, "moments_comment_draft_close_unverified");
    assert.equal(seedDiagnosticsAttempt.stage, "send_clicked");
    assert.equal(seedDiagnosticsAttempt.send_clicked_at, seedSendClickedAt);
    assert.equal(seedDiagnosticsAttempt.verification_mode, "green_component_state_transition_v1");
    assert.deepEqual(seedDiagnosticsFailure.diagnostics, {
      composer_completed: true,
      send_button_located: true,
      anchor_stable: true,
      menu_stable: true,
      candidate_hash_stable: false,
      menu_match_count: 1,
      candidate_count: 2,
      send_button_count: 1,
      candidate_reason: "moments_comment_candidate_ambiguous",
      menu_read_retry_count: 1,
      first_reason: "moments_menu_surface_ambiguous",
      second_reason: "moments_comment_draft_state_unknown",
      requested_action: "comment",
      first_segment_count: 3,
      second_segment_count: 2,
      first_strict_candidate_count: 0,
      second_strict_candidate_count: 1,
      first_fallback_candidate_count: 2,
      second_fallback_candidate_count: 1,
      blank_checkpoint_retry_count: 1,
      retry_reason: "moments_comment_draft_state_unknown",
      checkpoint_pass: 1,
      started_input_tick: 1234,
      finished_input_tick: 1234,
      input_tick_stable: true,
      stable_composer_ok: false,
      stable_composer_reason: "moments_comment_composer_not_found",
      settled_composer_ok: true,
      settled_composer_reason: "moments_comment_composer_recovered",
      stable_send_ok: false,
      stable_send_reason: "moments_comment_send_button_ambiguous",
      settled_send_ok: false,
      settled_send_reason: "moments_comment_send_button_not_found",
      stable_send_candidate_count: 2,
      settled_send_candidate_count: 0,
      owned_click_reason: "moments_comment_open_blocked",
      owned_click_phase: "confirmed_hit",
      point_inside_surface: true,
      surface_inside_popup: true,
      surface_inside_window: true,
      first_root_matches_second: false,
      foreground_ok: true
    });
    assert.deepEqual(seedDiagnosticsAttempt.diagnostics, seedDiagnosticsFailure.diagnostics);
    assert.equal(seedDiagnosticsAttempt.readback_diagnostics.composer_completed, true);
    assert.equal(seedDiagnosticsAttempt.readback_diagnostics.anchor_stable, true);
    assert.equal(seedDiagnosticsAttempt.readback_diagnostics.menu_stable, true);
    assert.equal(seedDiagnosticsAttempt.readback_diagnostics.candidate_hash_stable, false);
    assert.equal(seedDiagnosticsAttempt.readback_diagnostics.menu_match_count, 1);
    assert.equal(seedDiagnosticsAttempt.readback_diagnostics.candidate_count, 2);
    assert.equal(seedDiagnosticsAttempt.readback_diagnostics.candidate_reason, "moments_comment_candidate_ambiguous");
    assert.equal(JSON.stringify(seedDiagnosticsAttempt.readback_diagnostics).includes(privateDiagnosticMarker), false);
    for (const unsafeKey of [
      "send_ocr_text",
      "raw_ocr_text",
      "first_raw_ocr_text",
      "second_raw_ocr_text",
      "stable_raw_ocr_text",
      "settled_raw_ocr_text",
      "stderr",
      "clipboard_text",
      "nested",
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(seedDiagnosticsFailure.diagnostics, unsafeKey),
        false,
        `${unsafeKey} must not escape the diagnostic allowlist`,
      );
    }

    const ambiguousVisibleFixture = visualPreparedDirectory(root, "visual-comment-ambiguous-visible-proof");
    let ambiguousReadbackCalls = 0;
    const ambiguousVisibleResult = await executeMomentsComment({
      ...ambiguousVisibleFixture,
      commentText: COMMENT_TEXT,
      enhancedReadback: true,
      driver: verifiedDriver(ambiguousVisibleFixture.observationId, {
        comment: (context) => verifiedVisibleComment(ambiguousVisibleFixture, context, {
          diagnostics: {
            ...verifiedVisibleComment(ambiguousVisibleFixture, context).diagnostics,
            candidateCount: 2
          }
        }),
        commentReadback: () => {
          ambiguousReadbackCalls += 1;
          return verifiedCommentReadback(ambiguousVisibleFixture.observationId, COMMENT_TEXT);
        }
      })
    });
    assert.equal(ambiguousVisibleResult.status, "outcome_unknown");
    assert.equal(ambiguousVisibleResult.driver_reason, "moments_comment_proof_invalid");
    assert.equal(ambiguousReadbackCalls, 0, "enhanced readback cannot upgrade an ambiguous visible candidate");
    assert.equal(
      loadState(ambiguousVisibleFixture.baseDir).moments_test_action.attempts[ambiguousVisibleResult.attempt_key].status,
      "outcome_unknown"
    );

    const unsafeReasonFixture = visualPreparedDirectory(root, "visual-comment-unsafe-seed-diagnostics");
    const unsafeReasonFailure = await executeMomentsComment({
      ...unsafeReasonFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(unsafeReasonFixture.observationId, {
        comment: () => ({
          ok: false,
          status: "outcome_unknown",
          actionAttempted: true,
          reason: "moments_comment_readback_seed_unavailable",
          diagnostics: {
            composerCompleted: false,
            candidateReason: `moments_comment_candidate_not_found:${privateDiagnosticMarker}`
          }
        })
      })
    });
    const unsafeReasonAttempt = loadState(unsafeReasonFixture.baseDir)
      .moments_test_action.attempts[unsafeReasonFailure.attempt_key];
    assert.deepEqual(unsafeReasonAttempt.readback_diagnostics, { composer_completed: false });

    for (const [name, configureDriver, expectedReason] of [
      [
        "missing-driver",
        {},
        "moments_comment_readback_driver_unavailable"
      ],
      [
        "proof-false",
        {
          commentReadback: () => verifiedCommentReadback(
            "placeholder",
            COMMENT_TEXT,
            { clipboardOrdinalMatched: false }
          )
        },
        "moments_comment_readback_proof_invalid"
      ],
      [
        "driver-throws",
        { commentReadback: () => { throw new Error("readback crashed"); } },
        "moments_comment_readback_driver_failed"
      ]
    ]) {
      const fixture = visualPreparedDirectory(root, `visual-comment-readback-${name}`);
      let submitCalls = 0;
      let readbackCalls = 0;
      const configuredReadback = configureDriver.commentReadback;
      const driver = verifiedDriver(fixture.observationId, {
        comment: (context) => {
          submitCalls += 1;
          return verifiedVisibleComment(fixture, context);
        },
        ...(configuredReadback ? {
          commentReadback: (...args) => {
            readbackCalls += 1;
            if (name === "proof-false") {
              return verifiedCommentReadback(
                fixture.observationId,
                COMMENT_TEXT,
                { clipboardOrdinalMatched: false }
              );
            }
            return configuredReadback(...args);
          }
        } : {})
      });
      const accepted = await executeMomentsComment({
        ...fixture,
        commentText: COMMENT_TEXT,
        enhancedReadback: true,
        driver
      });
      assert.equal(accepted.status, "verified", name);
      assert.equal(accepted.real_action_attempted, true, name);
      assert.equal(accepted.verification_mode, VISUAL_COMMENT_VERIFICATION_MODE, name);
      assert.equal(accepted.verification_level, VISUAL_COMMENT_VERIFICATION_LEVEL, name);
      assert.equal(accepted.readback_enhancement_status, "failed", name);
      assert.equal(submitCalls, 1, name);
      if (configuredReadback) assert.equal(readbackCalls, 1, name);
      const acceptedAttempt = loadState(fixture.baseDir).moments_test_action.attempts[accepted.attempt_key];
      assert.equal(acceptedAttempt.status, "verified", name);
      assert.equal(acceptedAttempt.readback_enhancement_status, "failed", name);
      assert.equal(acceptedAttempt.readback_enhancement_reason, expectedReason, name);

      const repeated = await executeMomentsComment({
        ...fixture,
        commentText: COMMENT_TEXT,
        driver: {
          inspectMenu: () => { throw new Error("unknown result must stop before inspection"); },
          comment: () => { submitCalls += 1; throw new Error("must never resend"); },
          commentReadback: () => { readbackCalls += 1; throw new Error("must not reread through resend"); }
        }
      });
      assert.equal(repeated.blocked_reason, "moments_comment_text_already_attempted", name);
      assert.equal(submitCalls, 1, name);
    }

    const legacyVisualFixture = visualPreparedDirectory(root, "visual-comment-legacy-ocr-proof");
    let legacyReadbackCalls = 0;
    const legacyVisualProof = await executeMomentsComment({
      ...legacyVisualFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(legacyVisualFixture.observationId, {
        comment: () => ({
          ok: true,
          status: "verified",
          actionAttempted: true,
          observationId: legacyVisualFixture.observationId,
          commentVerified: true,
          commentText: COMMENT_TEXT,
          verificationMode: "exact_clipboard_roundtrip+visual_signature_count_increment+composer_completion"
        }),
        commentReadback: () => { legacyReadbackCalls += 1; return {}; }
      })
    });
    assert.equal(legacyVisualProof.status, "outcome_unknown");
    assert.equal(legacyVisualProof.driver_reason, "moments_comment_proof_invalid");
    assert.equal(legacyReadbackCalls, 0, "legacy OCR proof must never be upgraded to exact readback");

    const badCommentProofFixture = preparedDirectory(root, "comment-bad-proof");
    const badCommentProof = await executeMomentsComment({
      ...badCommentProofFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(badCommentProofFixture.observationId, {
        comment: () => ({
          ok: true,
          actionAttempted: true,
          observationId: badCommentProofFixture.observationId,
          commentVerified: true,
          commentText: `${COMMENT_TEXT}（变化）`
        })
      })
    });
    assert.equal(badCommentProof.status, "outcome_unknown");
    assert.equal(badCommentProof.real_action_attempted, true);
    const differentPostWindow = {
      ...MOMENTS_WINDOW,
      posts: [{
        ...MOMENTS_POST,
        runtimeId: "42.7.11",
        text: "测试账号 另一条朋友圈内容 包含2张图片 刚刚"
      }]
    };
    const differentPostDryRun = prepareMomentsDryRun(badCommentProofFixture.baseDir, {
      mode: "targeted",
      likeEnabled: true,
      commentEnabled: true,
      commentText: COMMENT_TEXT
    }, () => differentPostWindow);
    assert.equal(differentPostDryRun.ok, true);
    assert.notEqual(
      differentPostDryRun.post_snapshot.post_fingerprint,
      badCommentProofFixture.postFingerprint,
      "a different post must have a different fingerprint"
    );
    let differentPostDriverCalls = 0;
    const differentPostResult = await executeMomentsComment({
      baseDir: badCommentProofFixture.baseDir,
      observationId: differentPostDryRun.post_snapshot.observation_id,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(differentPostDryRun.post_snapshot.observation_id, {
        inspectMenu: () => {
          differentPostDriverCalls += 1;
          return { ok: true, observationId: differentPostDryRun.post_snapshot.observation_id, menuState: "赞" };
        },
        comment: () => {
          differentPostDriverCalls += 1;
          return {
            ok: true,
            actionAttempted: true,
            observationId: differentPostDryRun.post_snapshot.observation_id,
            commentVerified: true,
            commentText: COMMENT_TEXT,
            verificationMode: UIA_COMMENT_VERIFICATION_MODE
          };
        }
      })
    });
    assert.equal(differentPostResult.ok, true, "the same exact comment text must be reusable on a different post");
    assert.equal(differentPostResult.status, "verified");
    assert.notEqual(differentPostResult.attempt_key, badCommentProof.attempt_key);
    assert.equal(differentPostDriverCalls, 2, "a different post must reach inspection and comment drivers");

    const commentBlockedFixture = preparedDirectory(root, "comment-blocked-before-send");
    const blockedPrivateMarker = "PRIVATE_BLOCKED_DIAGNOSTIC_MUST_NOT_PERSIST";
    const commentBlocked = await executeMomentsComment({
      ...commentBlockedFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(commentBlockedFixture.observationId, {
        comment: () => ({
          ok: false,
          status: "blocked",
          reason: "moments_comment_draft_close_unverified",
          primaryReason: "moments_comment_send_button_ambiguous",
          cleanupReason: "moments_comment_draft_close_unverified",
          stage: "draft_written",
          verificationMode: "unique_green_component_geometry_v1",
          realActionAttempted: false,
          diagnostics: {
            composerCompleted: true,
            sendButtonLocated: false,
            sendButtonCount: 2,
            sendCandidateCount: 2,
            sendButtonOk: false,
            sendInsideComposer: false,
            foregroundOk: true,
            sendBounds: { left: 640, top: 520, width: 72, height: 32 },
            sendOcrText: blockedPrivateMarker,
            commentText: blockedPrivateMarker,
            nested: { raw: blockedPrivateMarker }
          }
        })
      })
    });
    assert.equal(commentBlocked.status, "blocked");
    assert.equal(commentBlocked.blocked_reason, "moments_comment_send_button_ambiguous");
    assert.equal(commentBlocked.real_action_attempted, false);
    assert.equal(commentBlocked.retry_locked, false);
    assert.equal(commentBlocked.stage, "draft_written");
    assert.equal(commentBlocked.primary_reason, "moments_comment_send_button_ambiguous");
    assert.equal(commentBlocked.cleanup_reason, "moments_comment_draft_close_unverified");
    assert.equal(commentBlocked.verification_mode, "unique_green_component_geometry_v1");
    assert.deepEqual(commentBlocked.diagnostics, {
      composer_completed: true,
      send_button_located: false,
      send_button_ok: false,
      send_inside_composer: false,
      foreground_ok: true,
      send_button_count: 2,
      send_candidate_count: 2,
      send_bounds: { left: 640, top: 520, width: 72, height: 32 }
    });
    assert.equal(JSON.stringify(commentBlocked).includes(blockedPrivateMarker), false);
    assert.equal(Object.prototype.hasOwnProperty.call(commentBlocked, "primaryReason"), false);
    const commentBlockedState = loadState(commentBlockedFixture.baseDir).moments_test_action;
    const commentBlockedAttempt = commentBlockedState.attempts[commentBlocked.attempt_key];
    assert.equal(commentBlockedAttempt.status, "prepared");
    assert.equal(commentBlockedAttempt.reason, "moments_comment_send_button_ambiguous");
    assert.equal(commentBlockedAttempt.primary_reason, "moments_comment_send_button_ambiguous");
    assert.equal(commentBlockedAttempt.cleanup_reason, "moments_comment_draft_close_unverified");
    assert.equal(commentBlockedAttempt.stage, "draft_written");
    assert.deepEqual(commentBlockedAttempt.diagnostics, commentBlocked.diagnostics);
    assert.equal(commentBlockedState.primary_reason, "moments_comment_send_button_ambiguous");
    assert.equal(commentBlockedState.cleanup_reason, "moments_comment_draft_close_unverified");
    assert.equal(commentBlockedState.stage, "draft_written");
    assert.equal(JSON.stringify(commentBlockedState).includes(blockedPrivateMarker), false);
    const blockedLikeAfterComment = await executeMomentsLike({
      baseDir: commentBlockedFixture.baseDir,
      observationId: "f".repeat(64),
      driver: {}
    });
    assert.equal(blockedLikeAfterComment.blocked_reason, "moments_observation_id_mismatch");
    const clearedTopLevelMetadata = loadState(commentBlockedFixture.baseDir).moments_test_action;
    for (const key of [
      "stage",
      "send_clicked_at",
      "primary_reason",
      "cleanup_reason",
      "verification_mode",
      "diagnostics"
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(clearedTopLevelMetadata, key),
        false,
        `a later early block must clear stale top-level ${key}`
      );
    }

    const commentThrowFixture = preparedDirectory(root, "comment-throw");
    let thrownCommentCalls = 0;
    const commentThrow = await executeMomentsComment({
      ...commentThrowFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(commentThrowFixture.observationId, {
        comment: () => { thrownCommentCalls += 1; throw new Error("submit result lost"); }
      })
    });
    assert.equal(commentThrow.status, "blocked");
    assert.equal(commentThrow.real_action_attempted, false);
    assert.equal(commentThrow.retry_locked, false);
    assert.equal(commentThrow.stage, "driver_exception");
    assert.equal(commentThrow.primary_reason, "moments_comment_driver_failed");
    assert.equal(thrownCommentCalls, 1);
    const commentThrowRepeat = await executeMomentsComment({
      ...commentThrowFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(commentThrowFixture.observationId, {
        comment: (context) => {
          thrownCommentCalls += 1;
          return {
            ok: true,
            actionAttempted: true,
            observationId: commentThrowFixture.observationId,
            commentVerified: true,
            commentText: context.commentText,
            verificationMode: UIA_COMMENT_VERIFICATION_MODE
          };
        }
      })
    });
    assert.equal(commentThrowRepeat.status, "verified");
    assert.equal(commentThrowRepeat.attempt_key, commentThrow.attempt_key);
    assert.equal(commentThrowRepeat.real_action_attempted, true);
    assert.equal(thrownCommentCalls, 2);

    const preparedRestartFixture = preparedDirectory(root, "comment-prepared-without-marker-restart");
    const preparedRestartAttemptKey = createMomentsAttemptKey({
      postFingerprint: preparedRestartFixture.postFingerprint,
      action: "comment",
      commentText: COMMENT_TEXT
    });
    const preparedRestartState = loadState(preparedRestartFixture.baseDir);
    preparedRestartState.moments_test_action = {
      version: 1,
      attempts: {
        [preparedRestartAttemptKey]: {
          action: "moments-comment",
          observation_id: preparedRestartFixture.observationId,
          post_fingerprint: preparedRestartFixture.postFingerprint,
          comment_text: COMMENT_TEXT,
          status: "prepared",
          real_action_attempted: false
        }
      }
    };
    saveState(preparedRestartFixture.baseDir, preparedRestartState);
    let preparedRestartDriverCalls = 0;
    const preparedRestartResult = await executeMomentsComment({
      ...preparedRestartFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(preparedRestartFixture.observationId, {
        comment: (context) => {
          preparedRestartDriverCalls += 1;
          return {
            ok: true,
            actionAttempted: true,
            observationId: preparedRestartFixture.observationId,
            commentVerified: true,
            commentText: context.commentText,
            verificationMode: UIA_COMMENT_VERIFICATION_MODE
          };
        }
      })
    });
    assert.equal(preparedRestartResult.status, "verified");
    assert.equal(preparedRestartDriverCalls, 1, "prepared without a durable click marker must retry after restart");

    const markerThrowFixture = visualPreparedDirectory(root, "comment-marker-throw");
    const markerThrowClickedAt = "2026-07-28T12:34:56.000Z";
    let markerThrowCalls = 0;
    const markerThrow = await executeMomentsComment({
      ...markerThrowFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(markerThrowFixture.observationId, {
        comment: (context) => {
          markerThrowCalls += 1;
          assert.equal(path.basename(context.sendMarkerPath), `${markerThrowFixture.postFingerprint}.json`);
          assert.equal(
            context.commentTextSha256,
            crypto.createHash("sha256").update(COMMENT_TEXT, "utf8").digest("hex")
          );
          writeCommentSendMarker(
            markerThrowFixture,
            context.attemptKey,
            context.commentText,
            markerThrowClickedAt
          );
          throw new Error("driver exited after the send click");
        }
      })
    });
    assert.equal(markerThrow.status, "outcome_unknown");
    assert.equal(markerThrow.real_action_attempted, true);
    assert.equal(markerThrow.stage, "send_clicked");
    assert.equal(markerThrow.send_clicked_at, markerThrowClickedAt);
    assert.equal(markerThrow.primary_reason, "moments_comment_driver_failed_after_send_click");
    assert.equal(markerThrowCalls, 1);
    const markerThrowState = loadState(markerThrowFixture.baseDir)
      .moments_test_action.attempts[markerThrow.attempt_key];
    assert.equal(markerThrowState.status, "outcome_unknown");
    assert.equal(markerThrowState.real_action_attempted, true);
    const markerThrowRepeat = await executeMomentsComment({
      ...markerThrowFixture,
      commentText: COMMENT_TEXT,
      driver: {
        comment: () => {
          markerThrowCalls += 1;
          throw new Error("a durable marker must stop every resend");
        }
      }
    });
    assert.equal(markerThrowRepeat.status, "outcome_unknown");
    assert.equal(markerThrowRepeat.real_action_attempted, true);
    assert.equal(markerThrowRepeat.send_clicked_at, markerThrowClickedAt);
    assert.equal(markerThrowCalls, 1);

    const restartMarkerFixture = visualPreparedDirectory(root, "comment-marker-restart");
    const regeneratedCommentText = `${COMMENT_TEXT} regenerated`;
    const restartAttemptKey = createMomentsAttemptKey({
      postFingerprint: restartMarkerFixture.postFingerprint,
      action: "comment",
      commentText: COMMENT_TEXT
    });
    const restartState = loadState(restartMarkerFixture.baseDir);
    restartState.moments_dry_run.comment_text = regeneratedCommentText;
    restartState.moments_test_action = {
      version: 1,
      attempts: {
        [restartAttemptKey]: {
          action: "moments-comment",
          observation_id: restartMarkerFixture.observationId,
          post_fingerprint: restartMarkerFixture.postFingerprint,
          comment_text: COMMENT_TEXT,
          status: "prepared",
          real_action_attempted: false
        }
      }
    };
    saveState(restartMarkerFixture.baseDir, restartState);
    const restartClickedAt = "2026-07-28T13:00:00.000Z";
    writeCommentSendMarker(
      restartMarkerFixture,
      restartAttemptKey,
      COMMENT_TEXT,
      restartClickedAt
    );
    let restartDriverCalls = 0;
    const restartRecovered = await executeMomentsComment({
      ...restartMarkerFixture,
      commentText: regeneratedCommentText,
      driver: {
        comment: () => {
          restartDriverCalls += 1;
          throw new Error("restart recovery must happen before the driver");
        }
      }
    });
    assert.equal(restartRecovered.status, "outcome_unknown");
    assert.equal(restartRecovered.attempt_key, restartAttemptKey);
    assert.equal(restartRecovered.real_action_attempted, true);
    assert.equal(restartRecovered.send_clicked_at, restartClickedAt);
    assert.equal(restartDriverCalls, 0);
    assert.equal(
      loadState(restartMarkerFixture.baseDir).moments_test_action.attempts[restartAttemptKey].status,
      "outcome_unknown"
    );

    const fuzzyRestartSeed = visualPreparedDirectory(root, "comment-fuzzy-marker-restart");
    const fuzzyRestartFixture = updateVisualFixtureIdentity(fuzzyRestartSeed, {
      identityText: "author stable post content 1234567890",
      stableAnchorText: "author stable anchor content 1234567890",
      avatarHash: loadState(fuzzyRestartSeed.baseDir).moments_dry_run.post_snapshot.avatar_hash
    });
    const fuzzyOriginalState = loadState(fuzzyRestartFixture.baseDir);
    const fuzzyOriginalSnapshot = fuzzyOriginalState.moments_dry_run.post_snapshot;
    const fuzzyOriginalIdentity = fuzzyOriginalSnapshot.identity_text;
    const fuzzyOriginalAnchor = fuzzyOriginalSnapshot.stable_anchor_text;
    const fuzzyAttemptKey = createMomentsAttemptKey({
      postFingerprint: fuzzyRestartFixture.postFingerprint,
      action: "comment",
      commentText: COMMENT_TEXT
    });
    fuzzyOriginalState.moments_test_action = {
      version: 1,
      attempts: {
        [fuzzyAttemptKey]: {
          action: "moments-comment",
          observation_id: fuzzyRestartFixture.observationId,
          post_fingerprint: fuzzyRestartFixture.postFingerprint,
          post_identity_text: fuzzyOriginalIdentity,
          post_stable_anchor_text: fuzzyOriginalAnchor,
          post_avatar_hash: fuzzyOriginalSnapshot.avatar_hash,
          comment_text: COMMENT_TEXT,
          status: "prepared",
          real_action_attempted: false
        }
      }
    };
    saveState(fuzzyRestartFixture.baseDir, fuzzyOriginalState);
    const fuzzyRestartClickedAt = "2026-07-28T13:10:00.000Z";
    writeCommentSendMarker(
      fuzzyRestartFixture,
      fuzzyAttemptKey,
      COMMENT_TEXT,
      fuzzyRestartClickedAt
    );
    const fuzzyRegeneratedComment = `${COMMENT_TEXT} changed`;
    const fuzzyCurrentFixture = updateVisualFixtureIdentity(fuzzyRestartFixture, {
      identityText: `${fuzzyOriginalIdentity.slice(0, -1)}X`,
      stableAnchorText: `${fuzzyOriginalAnchor.slice(0, -1)}Y`,
      avatarHash: fuzzyOriginalSnapshot.avatar_hash,
      commentText: fuzzyRegeneratedComment
    });
    let fuzzyRestartDriverCalls = 0;
    const fuzzyRestartResult = await executeMomentsComment({
      ...fuzzyCurrentFixture,
      commentText: fuzzyRegeneratedComment,
      driver: {
        comment: () => {
          fuzzyRestartDriverCalls += 1;
          throw new Error("fuzzy marker recovery must happen before the driver");
        }
      }
    });
    assert.equal(fuzzyRestartResult.status, "outcome_unknown", JSON.stringify(fuzzyRestartResult));
    assert.equal(fuzzyRestartResult.attempt_key, fuzzyAttemptKey);
    assert.equal(fuzzyRestartResult.send_clicked_at, fuzzyRestartClickedAt);
    assert.equal(fuzzyRestartDriverCalls, 0);

    const fuzzyLedgerSeed = visualPreparedDirectory(root, "comment-fuzzy-ledger-distinct-post");
    const fuzzyLedgerFixture = updateVisualFixtureIdentity(fuzzyLedgerSeed, {
      identityText: "author stable post content 1734567890",
      stableAnchorText: "author stable anchor content 1734567890",
      avatarHash: loadState(fuzzyLedgerSeed.baseDir).moments_dry_run.post_snapshot.avatar_hash
    });
    const fuzzyLedgerState = loadState(fuzzyLedgerFixture.baseDir);
    const fuzzyLedgerSnapshot = fuzzyLedgerState.moments_dry_run.post_snapshot;
    const fuzzyLedgerAttemptKey = createMomentsAttemptKey({
      postFingerprint: fuzzyLedgerFixture.postFingerprint,
      action: "comment",
      commentText: COMMENT_TEXT
    });
    fuzzyLedgerState.moments_test_action = {
      version: 1,
      attempts: {
        [fuzzyLedgerAttemptKey]: {
          action: "moments-comment",
          observation_id: fuzzyLedgerFixture.observationId,
          post_fingerprint: fuzzyLedgerFixture.postFingerprint,
          post_identity_text: fuzzyLedgerSnapshot.identity_text,
          post_stable_anchor_text: fuzzyLedgerSnapshot.stable_anchor_text,
          post_avatar_hash: fuzzyLedgerSnapshot.avatar_hash,
          comment_text: COMMENT_TEXT,
          status: "verified",
          real_action_attempted: true
        }
      }
    };
    saveState(fuzzyLedgerFixture.baseDir, fuzzyLedgerState);
    const fuzzyLedgerNewComment = `${COMMENT_TEXT} new copy`;
    const fuzzyLedgerCurrent = updateVisualFixtureIdentity(fuzzyLedgerFixture, {
      identityText: `${fuzzyLedgerSnapshot.identity_text.slice(0, -1)}X`,
      stableAnchorText: `${fuzzyLedgerSnapshot.stable_anchor_text.slice(0, -1)}Y`,
      avatarHash: fuzzyLedgerSnapshot.avatar_hash,
      commentText: fuzzyLedgerNewComment
    });
    let fuzzyLedgerDriverCalls = 0;
    let fuzzyLedgerOccurrenceChecks = 0;
    const fuzzyLedgerResult = await executeMomentsComment({
      ...fuzzyLedgerCurrent,
      commentText: fuzzyLedgerNewComment,
      driver: verifiedDriver(fuzzyLedgerCurrent.observationId, {
        commentOccurrenceCheck: () => {
          fuzzyLedgerOccurrenceChecks += 1;
          return {
            ok: true,
            status: "absent",
            actionAttempted: false,
            commentOccurrence: "absent",
            verificationMode: "two_frame_exact_comment_region"
          };
        },
        comment: (context) => {
          fuzzyLedgerDriverCalls += 1;
          return verifiedStateTransitionComment(fuzzyLedgerCurrent, context);
        }
      })
    });
    assert.equal(fuzzyLedgerResult.status, "verified", JSON.stringify(fuzzyLedgerResult));
    assert.equal(fuzzyLedgerOccurrenceChecks, 1);
    assert.equal(fuzzyLedgerDriverCalls, 1, "a similar new post from the same author must not be swallowed by fuzzy ledger matching");

    const fuzzyVerifiedSeed = visualPreparedDirectory(root, "comment-fuzzy-verified-visible-proof");
    const fuzzyVerifiedFixture = updateVisualFixtureIdentity(fuzzyVerifiedSeed, {
      identityText: "author stable post content 1934567890",
      stableAnchorText: "author stable anchor content 1934567890",
      avatarHash: loadState(fuzzyVerifiedSeed.baseDir).moments_dry_run.post_snapshot.avatar_hash
    });
    const fuzzyVerifiedState = loadState(fuzzyVerifiedFixture.baseDir);
    const fuzzyVerifiedSnapshot = fuzzyVerifiedState.moments_dry_run.post_snapshot;
    const fuzzyVerifiedAttemptKey = createMomentsAttemptKey({
      postFingerprint: fuzzyVerifiedFixture.postFingerprint,
      action: "comment",
      commentText: COMMENT_TEXT
    });
    fuzzyVerifiedState.moments_test_action = {
      version: 1,
      attempts: {
        [fuzzyVerifiedAttemptKey]: {
          action: "moments-comment",
          observation_id: fuzzyVerifiedFixture.observationId,
          post_fingerprint: fuzzyVerifiedFixture.postFingerprint,
          post_identity_text: fuzzyVerifiedSnapshot.identity_text,
          post_stable_anchor_text: fuzzyVerifiedSnapshot.stable_anchor_text,
          post_avatar_hash: fuzzyVerifiedSnapshot.avatar_hash,
          comment_text: COMMENT_TEXT,
          status: "verified",
          real_action_attempted: true
        }
      }
    };
    saveState(fuzzyVerifiedFixture.baseDir, fuzzyVerifiedState);
    const fuzzyVerifiedNewComment = `${COMMENT_TEXT} should not send twice`;
    const fuzzyVerifiedCurrentIdentity = `${fuzzyVerifiedSnapshot.identity_text.slice(0, -1)}X`;
    const fuzzyVerifiedCurrent = updateVisualFixtureIdentity(fuzzyVerifiedFixture, {
      identityText: fuzzyVerifiedCurrentIdentity,
      stableAnchorText: `${fuzzyVerifiedSnapshot.stable_anchor_text.slice(0, -1)}Y`,
      avatarHash: fuzzyVerifiedSnapshot.avatar_hash,
      commentText: fuzzyVerifiedNewComment
    });
    let fuzzyVerifiedDriverCalls = 0;
    let fuzzyVerifiedOccurrenceChecks = 0;
    const fuzzyVerifiedResult = await executeMomentsComment({
      ...fuzzyVerifiedCurrent,
      commentText: fuzzyVerifiedNewComment,
      driver: {
        commentOccurrenceCheck: () => {
          fuzzyVerifiedOccurrenceChecks += 1;
          return {
            ok: true,
            status: "present",
            actionAttempted: false,
            commentOccurrence: "present",
            verificationMode: "two_frame_exact_comment_region"
          };
        },
        comment: () => {
          fuzzyVerifiedDriverCalls += 1;
          throw new Error("verified prior comment occurrence must prevent a second send");
        }
      }
    });
    assert.equal(fuzzyVerifiedResult.status, "blocked", JSON.stringify(fuzzyVerifiedResult));
    assert.equal(fuzzyVerifiedResult.blocked_reason, "moments_comment_post_already_attempted");
    assert.equal(fuzzyVerifiedOccurrenceChecks, 1);
    assert.equal(fuzzyVerifiedDriverCalls, 0);

    const fuzzyUnresolvedSeed = visualPreparedDirectory(root, "comment-fuzzy-occurrence-unresolved");
    const fuzzyUnresolvedFixture = updateVisualFixtureIdentity(fuzzyUnresolvedSeed, {
      identityText: "author stable post content 2034567890",
      stableAnchorText: "author stable anchor content 2034567890",
      avatarHash: loadState(fuzzyUnresolvedSeed.baseDir).moments_dry_run.post_snapshot.avatar_hash
    });
    const fuzzyUnresolvedState = loadState(fuzzyUnresolvedFixture.baseDir);
    const fuzzyUnresolvedSnapshot = fuzzyUnresolvedState.moments_dry_run.post_snapshot;
    const fuzzyUnresolvedAttemptKey = createMomentsAttemptKey({
      postFingerprint: fuzzyUnresolvedFixture.postFingerprint,
      action: "comment",
      commentText: COMMENT_TEXT
    });
    fuzzyUnresolvedState.moments_test_action = {
      version: 1,
      attempts: {
        [fuzzyUnresolvedAttemptKey]: {
          action: "moments-comment",
          observation_id: fuzzyUnresolvedFixture.observationId,
          post_fingerprint: fuzzyUnresolvedFixture.postFingerprint,
          post_identity_text: fuzzyUnresolvedSnapshot.identity_text,
          post_stable_anchor_text: fuzzyUnresolvedSnapshot.stable_anchor_text,
          post_avatar_hash: fuzzyUnresolvedSnapshot.avatar_hash,
          comment_text: COMMENT_TEXT,
          status: "verified",
          real_action_attempted: true
        }
      }
    };
    saveState(fuzzyUnresolvedFixture.baseDir, fuzzyUnresolvedState);
    const fuzzyUnresolvedNewComment = `${COMMENT_TEXT} unresolved candidate`;
    const fuzzyUnresolvedCurrent = updateVisualFixtureIdentity(fuzzyUnresolvedFixture, {
      identityText: `${fuzzyUnresolvedSnapshot.identity_text.slice(0, -1)}X`,
      stableAnchorText: `${fuzzyUnresolvedSnapshot.stable_anchor_text.slice(0, -1)}Y`,
      avatarHash: fuzzyUnresolvedSnapshot.avatar_hash,
      commentText: fuzzyUnresolvedNewComment
    });
    let fuzzyUnresolvedDriverCalls = 0;
    const fuzzyUnresolvedResult = await executeMomentsComment({
      ...fuzzyUnresolvedCurrent,
      commentText: fuzzyUnresolvedNewComment,
      driver: {
        commentOccurrenceCheck: () => ({
          ok: false,
          status: "blocked",
          reason: "moments_comment_occurrence_unresolved",
          actionAttempted: false,
          commentOccurrence: "unresolved",
          verificationMode: "two_frame_exact_comment_region"
        }),
        comment: () => {
          fuzzyUnresolvedDriverCalls += 1;
          throw new Error("an unresolved occurrence check must skip before send");
        }
      }
    });
    assert.equal(fuzzyUnresolvedResult.status, "blocked", JSON.stringify(fuzzyUnresolvedResult));
    assert.equal(fuzzyUnresolvedResult.blocked_reason, "moments_comment_occurrence_unresolved");
    assert.equal(fuzzyUnresolvedResult.real_action_attempted, false);
    assert.equal(fuzzyUnresolvedDriverCalls, 0);

    const differentAvatarSeed = visualPreparedDirectory(root, "comment-marker-different-avatar");
    const differentAvatarFixture = updateVisualFixtureIdentity(differentAvatarSeed, {
      identityText: "author stable post content 2234567890",
      stableAnchorText: "author stable anchor content 2234567890",
      avatarHash: loadState(differentAvatarSeed.baseDir).moments_dry_run.post_snapshot.avatar_hash
    });
    const differentAvatarState = loadState(differentAvatarFixture.baseDir);
    const differentAvatarSnapshot = differentAvatarState.moments_dry_run.post_snapshot;
    const differentAvatarAttemptKey = createMomentsAttemptKey({
      postFingerprint: differentAvatarFixture.postFingerprint,
      action: "comment",
      commentText: COMMENT_TEXT
    });
    differentAvatarState.moments_test_action = {
      version: 1,
      attempts: {
        [differentAvatarAttemptKey]: {
          action: "moments-comment",
          observation_id: differentAvatarFixture.observationId,
          post_fingerprint: differentAvatarFixture.postFingerprint,
          post_identity_text: differentAvatarSnapshot.identity_text,
          post_stable_anchor_text: differentAvatarSnapshot.stable_anchor_text,
          post_avatar_hash: differentAvatarSnapshot.avatar_hash,
          comment_text: COMMENT_TEXT,
          status: "outcome_unknown",
          real_action_attempted: true
        }
      }
    };
    saveState(differentAvatarFixture.baseDir, differentAvatarState);
    writeCommentSendMarker(differentAvatarFixture, differentAvatarAttemptKey);
    const differentAvatarCurrent = updateVisualFixtureIdentity(differentAvatarFixture, {
      identityText: `${differentAvatarSnapshot.identity_text.slice(0, -1)}Z`,
      stableAnchorText: differentAvatarSnapshot.stable_anchor_text,
      avatarHash: "8".repeat(64)
    });
    let differentAvatarDriverCalls = 0;
    const differentAvatarResult = await executeMomentsComment({
      ...differentAvatarCurrent,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(differentAvatarCurrent.observationId, {
        comment: () => {
          differentAvatarDriverCalls += 1;
          throw new Error("different avatar should not recover an unrelated marker");
        }
      })
    });
    assert.equal(differentAvatarResult.status, "blocked");
    assert.equal(differentAvatarDriverCalls, 1);

    const ambiguousMarkerSeed = visualPreparedDirectory(root, "comment-marker-ambiguous");
    const ambiguousMarkerFixture = updateVisualFixtureIdentity(ambiguousMarkerSeed, {
      identityText: "author stable post content 3234567890",
      stableAnchorText: "author stable anchor content 3234567890",
      avatarHash: loadState(ambiguousMarkerSeed.baseDir).moments_dry_run.post_snapshot.avatar_hash
    });
    const ambiguousState = loadState(ambiguousMarkerFixture.baseDir);
    const ambiguousSnapshot = ambiguousState.moments_dry_run.post_snapshot;
    const ambiguousBaseIdentity = ambiguousSnapshot.identity_text;
    const ambiguousBaseAnchor = ambiguousSnapshot.stable_anchor_text;
    const ambiguousAttempts = {};
    for (const [index, suffix] of ["A", "B"].entries()) {
      const identityText = `${ambiguousBaseIdentity.slice(0, -1)}${suffix}`;
      const postFingerprint = momentsPostFingerprint(identityText);
      const observationId = String(index + 4).repeat(64);
      const attemptKey = createMomentsAttemptKey({
        postFingerprint,
        action: "comment",
        commentText: COMMENT_TEXT
      });
      ambiguousAttempts[attemptKey] = {
        action: "moments-comment",
        observation_id: observationId,
        post_fingerprint: postFingerprint,
        post_identity_text: identityText,
        post_stable_anchor_text: ambiguousBaseAnchor,
        post_avatar_hash: ambiguousSnapshot.avatar_hash,
        comment_text: COMMENT_TEXT,
        status: "prepared",
        real_action_attempted: false
      };
      writeCommentSendMarker(
        ambiguousMarkerFixture,
        attemptKey,
        COMMENT_TEXT,
        `2026-07-28T13:2${index}:00.000Z`,
        {
          postFingerprint,
          observationId,
          identityText,
          stableAnchorText: ambiguousBaseAnchor,
          avatarHash: ambiguousSnapshot.avatar_hash
        }
      );
    }
    ambiguousState.moments_test_action = { version: 1, attempts: ambiguousAttempts };
    saveState(ambiguousMarkerFixture.baseDir, ambiguousState);
    let ambiguousMarkerDriverCalls = 0;
    const ambiguousMarkerResult = await executeMomentsComment({
      ...ambiguousMarkerFixture,
      commentText: COMMENT_TEXT,
      driver: {
        comment: () => {
          ambiguousMarkerDriverCalls += 1;
          throw new Error("ambiguous marker recovery must pause before the driver");
        }
      }
    });
    assert.equal(ambiguousMarkerResult.status, "outcome_unknown");
    assert.equal(ambiguousMarkerResult.primary_reason, "moments_comment_send_marker_ambiguous");
    assert.equal(ambiguousMarkerDriverCalls, 0);

    const unrelatedInvalidMarkerFixture = preparedDirectory(root, "comment-unrelated-invalid-marker");
    const unrelatedInvalidMarkerPath = path.join(
      unrelatedInvalidMarkerFixture.baseDir,
      "moments_comment_send_markers",
      `${"f".repeat(64)}.json`
    );
    assert.notEqual("f".repeat(64), unrelatedInvalidMarkerFixture.postFingerprint);
    fs.mkdirSync(path.dirname(unrelatedInvalidMarkerPath), { recursive: true });
    fs.writeFileSync(unrelatedInvalidMarkerPath, "{not-valid-json", "utf8");
    let unrelatedInvalidMarkerDriverCalls = 0;
    const unrelatedInvalidMarkerResult = await executeMomentsComment({
      ...unrelatedInvalidMarkerFixture,
      commentText: COMMENT_TEXT,
      driver: verifiedDriver(unrelatedInvalidMarkerFixture.observationId, {
        comment: (context) => {
          unrelatedInvalidMarkerDriverCalls += 1;
          return {
            ok: true,
            actionAttempted: true,
            observationId: unrelatedInvalidMarkerFixture.observationId,
            commentVerified: true,
            commentText: context.commentText,
            verificationMode: UIA_COMMENT_VERIFICATION_MODE
          };
        }
      })
    });
    assert.equal(unrelatedInvalidMarkerResult.status, "verified", JSON.stringify(unrelatedInvalidMarkerResult));
    assert.equal(unrelatedInvalidMarkerDriverCalls, 1, "an unrelated corrupt marker must not poison the current post");
    assert.equal(fs.existsSync(unrelatedInvalidMarkerPath), true, "unrelated corrupt evidence must be preserved for diagnostics");

    const invalidMarkerFixture = visualPreparedDirectory(root, "comment-marker-invalid");
    const invalidMarkerPath = path.join(
      invalidMarkerFixture.baseDir,
      "moments_comment_send_markers",
      `${invalidMarkerFixture.postFingerprint}.json`
    );
    fs.mkdirSync(path.dirname(invalidMarkerPath), { recursive: true });
    fs.writeFileSync(invalidMarkerPath, "{not-valid-json", "utf8");
    let invalidMarkerDriverCalls = 0;
    const invalidMarker = await executeMomentsComment({
      ...invalidMarkerFixture,
      commentText: COMMENT_TEXT,
      driver: {
        comment: () => {
          invalidMarkerDriverCalls += 1;
          throw new Error("an invalid durable marker must pause before the driver");
        }
      }
    });
    assert.equal(invalidMarker.status, "outcome_unknown");
    assert.equal(invalidMarker.primary_reason, "moments_comment_send_marker_invalid");
    assert.equal(invalidMarker.real_action_attempted, true);
    assert.equal(invalidMarkerDriverCalls, 0);

    const dryRunSource = fs.readFileSync(path.join(__dirname, "moments_dry_run.dev.cjs"), "utf8");
    assert.match(dryRunSource, /\$feeds = \$root\.FindAll/u);
    assert.match(dryRunSource, /\$feeds\.Count -ne 1/u);
    assert.match(dryRunSource, /\$rootProcessId -ne \[int\]\$matched\.pid/u);
    assert.match(dryRunSource, /structural_sns_feed/u);
    assert.doesNotMatch(dryRunSource, /\$feed = \$root\.FindFirst/u);

    const driverSource = fs.readFileSync(path.join(__dirname, "moments_action_driver.dev.cjs"), "utf8");
    assert.match(driverSource, /GetAncestor\(IntPtr hWnd, uint flags\)/u);
    assert.match(driverSource, /GetWindow\(IntPtr hWnd, uint command\)/u);
    assert.match(driverSource, /GetCursorPos\(out POINT point\)/u);
    assert.match(driverSource, /keybd_event\(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo\)/u);
    assert.match(driverSource, /\$hitRoot -ne \$expectedHWnd/u);
    assert.match(driverSource, /\$confirmedRoot -ne \$expectedHWnd/u);
    assert.match(driverSource, /\$target\.itemRect\.Width \* 0\.09/u);
    assert.doesNotMatch(driverSource, /\* 0\.(?:82|945)/u);
    assert.match(driverSource, /function Get-VerifiedCommentEditorFocus/u);
    assert.match(driverSource, /ControlType\]::Edit/u);
    assert.match(driverSource, /ControlType\]::Document/u);
    assert.match(driverSource, /Automation\]::RawViewCondition/u);
    assert.match(driverSource, /Automation\]::ControlViewCondition/u);
    assert.match(driverSource, /AutomationElement\]::NameProperty,\s*"发送"/u);
    assert.match(driverSource, /ControlTypeProperty,\s*\[System\.Windows\.Automation\.ControlType\]::Button/u);
    assert.match(driverSource, /\$target\.feed\.FindAll\(\[System\.Windows\.Automation\.TreeScope\]::Descendants/u);
    assert.match(driverSource, /\$entry\.name -cne "评论区"/u);
    assert.match(driverSource, /\$targetIndex \+ 1/u);
    assert.match(driverSource, /\$nextPostTop/u);
    assert.doesNotMatch(driverSource, /\$target\.item\.FindAll/u);
    assert.match(driverSource, /\(Get-ElementRawText \$element\) -cne \$commentText/u);
    assert.match(driverSource, /\$afterCount\.count -eq \(\$submitCount\.count \+ 1\)/u);
    assert.match(driverSource, /function Test-CommentEditorClearedOrClosed/u);
    assert.match(driverSource, /\$editorCompletion\.ok/u);
    assert.match(driverSource, /moments_comment_editor_not_cleared/u);
    assert.match(driverSource, /moments_comment_duplicate/u);
    assert.match(driverSource, /function Test-ActionDeadline/u);
    assert.match(driverSource, /XIAOXI_MOMENTS_IDENTITY_MODE/u);
    assert.match(driverSource, /XIAOXI_MOMENTS_ROOT_AUTOMATION_ID/u);
    assert.match(driverSource, /XIAOXI_MOMENTS_FEED_RUNTIME_ID/u);
    assert.match(driverSource, /structural_sns_feed/u);
    assert.match(driverSource, /automation_id/u);
    assert.match(driverSource, /\$feeds = \$root\.FindAll/u);
    assert.match(driverSource, /\$feeds\.Count -ne 1/u);
    assert.match(driverSource, /\(Get-RuntimeId \$feed\) -cne \$expectedFeedRuntimeId/u);
    assert.doesNotMatch(driverSource, /\$feed = \$root\.FindFirst/u);
    assert.match(driverSource, /XIAOXI_MOMENTS_DEADLINE_MS/u);
    assert.match(driverSource, /Test-ActionDeadline[\s\S]*Invoke-MenuEntry \$menu\.like/u);
    assert.match(driverSource, /Test-ActionDeadline[\s\S]*Invoke-VerifiedClick \$sendX \$sendY/u);
    assert.match(driverSource, /Invoke-MenuEntry \$menu\.like \$target \$true/u);
    assert.match(driverSource, /Invoke-VerifiedClick \$sendX \$sendY \$target\.pid \$target\.hWnd \$true/u);
    assert.match(driverSource, /if \(\$enforceDeadline -and -not \(Test-ActionDeadline\)\) \{[\s\S]{0,220}moments_dry_run_expired[\s\S]{0,120}return \$false\s+\}/u);
    assert.ok((driverSource.match(/\$script:lastVerifiedClickFailureReason/g) ?? []).length >= 5);
    assert.ok((driverSource.match(/Clear-And-CloseCommentDraft \$target/g) ?? []).length >= 6);
    assert.doesNotMatch(driverSource, /Get-VisibleFeedTexts|Find-NextPostTop|IndexOf\(\$commentText/u);
    const clickInvocations = driverSource
      .split(/\r?\n/u)
      .filter((line) => /Invoke-VerifiedClick \$/u.test(line));
    assert.ok(clickInvocations.length >= 1);
    assert.ok(clickInvocations.every((line) => /\$target\.hWnd/u.test(line)));
    assert.match(driverSource, /runPowerShell\(MOMENTS_ACTION_SCRIPT,[\s\S]*\{ ensure: false, sta: true \}\)/u);
    assert.match(driverSource, /function Get-CommentEditorProof[\s\S]*\$candidates\.Count -ne 1/u);
    assert.match(driverSource, /ControlType\.Edit[\s\S]*ControlType\.Document[\s\S]*ValuePattern[\s\S]*Current\.IsReadOnly/u);
    assert.match(driverSource, /Set-CommentEditorValueExact[\s\S]*StringComparison\]::Ordinal[\s\S]*\.SetValue\(\$newValue\)/u);
    assert.match(driverSource, /Clear-CommentEditorValueExact[\s\S]*\.SetValue\(""\)/u);
    const finiteRectSource = driverSource.match(/function Test-FinitePositiveRect[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(finiteRectSource, /\$rect -eq \$null -or \$rect\.IsEmpty/u);
    assert.match(finiteRectSource, /\$rect\.Width -le 0 -or \$rect\.Height -le 0/u);
    assert.match(finiteRectSource, /@\(\[double\]\$rect\.Left, \[double\]\$rect\.Top, \[double\]\$rect\.Width, \[double\]\$rect\.Height\)/u);
    assert.match(finiteRectSource, /\[double\]::IsNaN\(\$value\) -or \[double\]::IsInfinity\(\$value\)/u);
    const targetContextSource = driverSource.match(/function Get-TargetContext[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(targetContextSource, /GetWindowRect\(\$hWnd, \[ref\]\$windowWin32Rect\)/u);
    assert.match(targetContextSource, /\$windowWin32Width = \[double\]\(\$windowWin32Rect\.Right - \$windowWin32Rect\.Left\)/u);
    assert.match(targetContextSource, /\$windowWin32Height = \[double\]\(\$windowWin32Rect\.Bottom - \$windowWin32Rect\.Top\)/u);
    assert.match(targetContextSource, /\$windowWin32Width -lt 300 -or \$windowWin32Height -lt 300/u);
    assert.match(targetContextSource, /\$rootIsEnabled = \$root\.Current\.IsEnabled/u);
    assert.match(targetContextSource, /\$rootIsOffscreen = \$root\.Current\.IsOffscreen/u);
    assert.match(targetContextSource, /\$windowRect = \$root\.Current\.BoundingRectangle/u);
    assert.match(targetContextSource, /-not \$rootIsEnabled -or \$rootIsOffscreen/u);
    assert.match(targetContextSource, /Test-FinitePositiveRect \$windowRect/u);
    assert.match(targetContextSource, /\$windowScaleX = \[double\]\$windowRect\.Width \/ \$windowWin32Width/u);
    assert.match(targetContextSource, /\$windowScaleY = \[double\]\$windowRect\.Height \/ \$windowWin32Height/u);
    assert.match(targetContextSource, /\$windowScaleX -lt 0\.9 -or \$windowScaleX -gt 3\.0/u);
    assert.match(targetContextSource, /\$windowScaleY -lt 0\.9 -or \$windowScaleY -gt 3\.0/u);
    assert.match(targetContextSource, /\[Math\]::Abs\(\$windowScaleX - \$windowScaleY\) -gt 0\.05/u);
    assert.match(targetContextSource, /windowRect = \$windowRect/u);
    assert.match(targetContextSource, /windowWin32Rect = \$windowWin32Rect/u);
    assert.doesNotMatch(targetContextSource, /windowRect = \$windowWin32Rect/u);
    const ownerProofSource = driverSource.match(/function Test-WindowOwnedByLockedMoments[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(ownerProofSource, /GetWindowThreadProcessId\(\$cursor, \[ref\]\$cursorPid\)/u);
    assert.match(ownerProofSource, /\$cursorPid -ne \[int\]\$target\.pid/u);
    assert.match(ownerProofSource, /\$cursor -eq \$target\.hWnd/u);
    assert.match(ownerProofSource, /GetWindow\(\$cursor, 4\)/u);
    const cursorProofSource = driverSource.match(/function Test-CursorAt[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(cursorProofSource, /GetCursorPos\(\[ref\]\$cursor\)/u);
    assert.match(cursorProofSource, /\$cursor\.X -eq \$x -and \$cursor\.Y -eq \$y/u);
    const strictClickSource = driverSource.match(/function Invoke-VerifiedClick[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(strictClickSource, /GetForegroundWindow\(\) -ne \$expectedHWnd/u);
    assert.ok((strictClickSource.match(/SetCursorPos\(\$x, \$y\)/gu) ?? []).length >= 2);
    assert.match(strictClickSource, /Test-CursorAt \$x \$y/u);
    assert.match(strictClickSource, /\$finalRoot = \[Win32WechatMomentsAction\]::GetAncestor\(\[Win32WechatMomentsAction\]::WindowFromPoint\(\$point\), 2\)/u);
    assert.match(strictClickSource, /\$finalRoot -ne \$expectedHWnd -or \[Win32WechatMomentsAction\]::GetForegroundWindow\(\) -ne \$expectedHWnd/u);
    const strictMouseDownIndex = strictClickSource.indexOf("mouse_event(0x0002");
    assert.ok(strictClickSource.lastIndexOf("SetCursorPos($x, $y)", strictMouseDownIndex) < strictClickSource.lastIndexOf("$finalRoot", strictMouseDownIndex));
    assert.ok(strictClickSource.lastIndexOf("$finalRoot", strictMouseDownIndex) < strictClickSource.lastIndexOf("Test-CursorAt $x $y", strictMouseDownIndex));
    assert.ok(strictClickSource.lastIndexOf("GetForegroundWindow()", strictMouseDownIndex) < strictClickSource.lastIndexOf("Test-CursorAt $x $y", strictMouseDownIndex));
    assert.ok(strictClickSource.lastIndexOf("Test-CursorAt $x $y", strictMouseDownIndex) < strictMouseDownIndex);
    assert.match(strictClickSource, /GetForegroundWindow\(\) -ne \$expectedHWnd -or\s+-not \(Test-CursorAt \$x \$y\)\) \{ return \$false \}\s+\[Win32WechatMomentsAction\]::mouse_event\(0x0002/u);
    const setMenuAnchorSource = driverSource.match(/function Set-MomentsMenuAnchor[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(setMenuAnchorSource, /\$target -eq \$null/u);
    assert.match(setMenuAnchorSource, /\$target\.itemRect\.Width \* 0\.09/u);
    assert.match(setMenuAnchorSource, /\$target\.itemRect\.Height \* 0\.04/u);
    assert.match(setMenuAnchorSource, /\$menuX -le \$target\.feedRect\.Left -or \$menuX -ge \$target\.feedRect\.Right/u);
    assert.match(setMenuAnchorSource, /\$menuY -le \$target\.feedRect\.Top -or \$menuY -ge \$target\.feedRect\.Bottom/u);
    assert.match(setMenuAnchorSource, /\$target\["menuX"\] = \$menuX/u);
    assert.match(setMenuAnchorSource, /\$target\["menuY"\] = \$menuY/u);
    assert.match(setMenuAnchorSource, /\$target\["menuAnchorRuntimeId"\] = Get-RuntimeId \$target\.item/u);
    assert.match(setMenuAnchorSource, /IsNullOrWhiteSpace\(\[string\]\$target\.menuAnchorRuntimeId\)/u);
    assert.match(setMenuAnchorSource, /Test-MomentsMenuAnchorPoint \$target/u);
    const menuAnchorSource = driverSource.match(/function Test-MomentsMenuAnchorPoint[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(menuAnchorSource, /\$target -eq \$null/u);
    assert.match(menuAnchorSource, /\$target\.ContainsKey\("menuX"\)/u);
    assert.match(menuAnchorSource, /\$target\.ContainsKey\("menuY"\)/u);
    assert.match(menuAnchorSource, /\$target\.ContainsKey\("menuAnchorRuntimeId"\)/u);
    assert.match(menuAnchorSource, /\$target\.itemRect\.Width \* 0\.09/u);
    assert.match(menuAnchorSource, /\$target\.itemRect\.Height \* 0\.04/u);
    assert.match(menuAnchorSource, /\$xOffset = \[Math\]::Max\(24, \[Math\]::Min\(80,/u);
    assert.match(menuAnchorSource, /\$yOffset = \[Math\]::Max\(14, \[Math\]::Min\(22,/u);
    assert.match(menuAnchorSource, /\$expectedX = \[int\]\[Math\]::Round\(\$target\.itemRect\.Right - \$xOffset\)/u);
    assert.match(menuAnchorSource, /\$expectedY = \[int\]\[Math\]::Round\(\$target\.itemRect\.Bottom - \$yOffset\)/u);
    assert.match(menuAnchorSource, /\$x -ne \$expectedX -or \$y -ne \$expectedY/u);
    assert.match(menuAnchorSource, /Get-TopLevelWindowHandle \(\[Win32WechatMomentsAction\]::WindowFromPoint\(\$point\)\)/u);
    assert.match(menuAnchorSource, /\$hitRoot -ne \$target\.hWnd/u);
    assert.match(menuAnchorSource, /GetWindowThreadProcessId\(\$hitRoot, \[ref\]\$hitPid\)/u);
    assert.match(menuAnchorSource, /\$hitPid -ne \[int\]\$target\.pid/u);
    assert.match(menuAnchorSource, /AutomationElement\]::FromPoint\(\(New-Object System\.Windows\.Point\(\$x, \$y\)\)\)/u);
    assert.match(menuAnchorSource, /Automation\]::Compare\(\$element, \$target\.item\)/u);
    assert.match(menuAnchorSource, /\$processId = \[int\]\$element\.Current\.ProcessId/u);
    assert.match(menuAnchorSource, /return \$isTargetItem -and \$processId -eq \[int\]\$target\.pid/u);
    assert.match(menuAnchorSource, /\$controlType -eq \[System\.Windows\.Automation\.ControlType\]::ListItem/u);
    assert.match(menuAnchorSource, /\$isEnabled -and -not \$isOffscreen -and \(Test-FinitePositiveRect \$rect\)/u);
    assert.match(menuAnchorSource, /Get-RuntimeId \$element\) -ceq \[string\]\$target\.menuAnchorRuntimeId/u);
    assert.match(menuAnchorSource, /\[Math\]::Abs\(\$rect\.Left - \$target\.itemRect\.Left\) -le 2/u);
    assert.match(menuAnchorSource, /\[Math\]::Abs\(\$rect\.Top - \$target\.itemRect\.Top\) -le 2/u);
    assert.match(menuAnchorSource, /\[Math\]::Abs\(\$rect\.Right - \$target\.itemRect\.Right\) -le 2/u);
    assert.match(menuAnchorSource, /\[Math\]::Abs\(\$rect\.Bottom - \$target\.itemRect\.Bottom\) -le 2/u);
    assert.match(menuAnchorSource, /\$x -ge \$rect\.Left -and \$x -le \$rect\.Right -and \$y -ge \$rect\.Top -and \$y -le \$rect\.Bottom/u);
    assert.doesNotMatch(menuAnchorSource, /TreeWalker|GetParent|FindAll|GetFirstChild|GetNextSibling/u);
    const menuToggleSource = driverSource.match(/function Invoke-MomentsMenuToggleClick[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(menuToggleSource, /\$knownPopup = \[IntPtr\]::Zero/u);
    assert.match(menuToggleSource, /\$target\.ContainsKey\("menuRootHWnd"\)/u);
    assert.match(menuToggleSource, /\$foreground -ne \$target\.hWnd -and \(\$knownPopup -eq \[IntPtr\]::Zero -or \$foreground -ne \$knownPopup\)/u);
    assert.match(menuToggleSource, /\$confirmedForeground -ne \$target\.hWnd -and \(\$knownPopup -eq \[IntPtr\]::Zero -or \$confirmedForeground -ne \$knownPopup\)/u);
    assert.match(menuToggleSource, /SetCursorPos\(\$x, \$y\)/u);
    const toggleAnchorChecks = [...menuToggleSource.matchAll(/Test-MomentsMenuAnchorPoint \$target/gu)].map((match) => match.index);
    assert.equal(toggleAnchorChecks.length, 2);
    assert.ok(toggleAnchorChecks[0] < menuToggleSource.indexOf("SetCursorPos($x, $y)"));
    assert.ok(menuToggleSource.indexOf("SetCursorPos($x, $y)") < toggleAnchorChecks[1]);
    assert.ok((menuToggleSource.match(/SetCursorPos\(\$x, \$y\)/gu) ?? []).length >= 2);
    assert.match(menuToggleSource, /Test-CursorAt \$x \$y/u);
    assert.match(menuToggleSource, /\$finalRoot = Get-TopLevelWindowHandle \(\[Win32WechatMomentsAction\]::WindowFromPoint\(\$finalPoint\)\)/u);
    assert.match(menuToggleSource, /\$finalForeground = \[Win32WechatMomentsAction\]::GetForegroundWindow\(\)/u);
    assert.match(menuToggleSource, /\$finalRoot -ne \$target\.hWnd/u);
    assert.match(menuToggleSource, /\$finalForeground -ne \$target\.hWnd -and \(\$knownPopup -eq \[IntPtr\]::Zero -or \$finalForeground -ne \$knownPopup\)/u);
    const toggleMouseDownIndex = menuToggleSource.indexOf("mouse_event(0x0002");
    assert.ok(menuToggleSource.lastIndexOf("SetCursorPos($x, $y)", toggleMouseDownIndex) < menuToggleSource.lastIndexOf("$finalRoot", toggleMouseDownIndex));
    assert.ok(menuToggleSource.lastIndexOf("$finalRoot", toggleMouseDownIndex) < menuToggleSource.lastIndexOf("Test-CursorAt $x $y", toggleMouseDownIndex));
    assert.ok(menuToggleSource.lastIndexOf("$finalForeground", toggleMouseDownIndex) < menuToggleSource.lastIndexOf("Test-CursorAt $x $y", toggleMouseDownIndex));
    assert.ok(menuToggleSource.lastIndexOf("Test-CursorAt $x $y", toggleMouseDownIndex) < toggleMouseDownIndex);
    assert.match(menuToggleSource, /\$finalForeground -ne \$knownPopup\)\) -or\s+-not \(Test-CursorAt \$x \$y\)\) \{ return \$false \}\s+\[Win32WechatMomentsAction\]::mouse_event\(0x0002/u);
    assert.doesNotMatch(menuToggleSource, /Test-WindowOwnedByLockedMoments|ShowWindowAsync|SetForegroundWindow|SendKeys|Clipboard|keybd_event/u);
    const openMenuProofSource = driverSource.match(/function Get-MomentsOpenMenuProof[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(openMenuProofSource, /\$popupHWnd -eq \[IntPtr\]::Zero -or \$popupHWnd -eq \$target\.hWnd/u);
    assert.match(openMenuProofSource, /-not \[Win32WechatMomentsAction\]::IsWindowVisible\(\$popupHWnd\)/u);
    assert.match(openMenuProofSource, /Test-WindowOwnedByLockedMoments \$popupHWnd \$target/u);
    assert.match(openMenuProofSource, /Get-MenuButtonsByPoint \$target \$popupHWnd/u);
    assert.match(openMenuProofSource, /\$likeEntries\.Count -ne 1 -or \$commentEntries\.Count -ne 1/u);
    assert.match(openMenuProofSource, /\$likeEntries\[0\]\.rootHWnd -ne \$commentEntries\[0\]\.rootHWnd/u);
    assert.match(openMenuProofSource, /\$likeRect\.Left -le \(\$popupRect\.Left \+ 4\)/u);
    assert.match(openMenuProofSource, /\$commentRect\.Right -ge \(\$popupRect\.Right - 4\)/u);
    assert.match(openMenuProofSource, /\$likeRect\.Right -le \(\$commentRect\.Left \+ 4\)/u);
    assert.match(openMenuProofSource, /\$coverage -ge \(\$popupWidth \* 0\.85\)/u);
    assert.match(openMenuProofSource, /\$likeRect\.Height -ge \(\$popupHeight \* 0\.8\)/u);
    assert.match(openMenuProofSource, /\$commentRect\.Height -ge \(\$popupHeight \* 0\.8\)/u);
    assert.match(openMenuProofSource, /if \(-not \$geometryVerified\)[\s\S]*moments_menu_ambiguous/u);
    const lockedRootSource = driverSource.match(/function Test-LockedMomentsRootIdentity[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(lockedRootSource, /\$target -eq \$null/u);
    assert.match(lockedRootSource, /\$target\.ContainsKey\("hWnd"\)/u);
    assert.match(lockedRootSource, /\$target\.ContainsKey\("pid"\)/u);
    assert.match(lockedRootSource, /\$target\.ContainsKey\("root"\)/u);
    assert.match(lockedRootSource, /\[int\]\$target\.pid -le 0/u);
    assert.match(lockedRootSource, /\$target\.root -eq \$null/u);
    assert.match(lockedRootSource, /\$hWnd -eq \[IntPtr\]::Zero -or -not \[Win32WechatMomentsAction\]::IsWindowVisible\(\$hWnd\)/u);
    assert.match(lockedRootSource, /GetAncestor\(\$hWnd, 2\) -ne \$hWnd/u);
    assert.match(lockedRootSource, /\$threadId = \[Win32WechatMomentsAction\]::GetWindowThreadProcessId\(\$hWnd, \[ref\]\$currentPid\)/u);
    assert.match(lockedRootSource, /\$threadId -eq 0 -or \$currentPid -ne \[int\]\$target\.pid/u);
    assert.match(lockedRootSource, /\$titleLength = \[Win32WechatMomentsAction\]::GetWindowText\(\$hWnd, \$titleText, \$titleText\.Capacity\)/u);
    assert.match(lockedRootSource, /\$titleLength -le 0 -or \$titleText\.ToString\(\)\.Trim\(\) -cne "\u670b\u53cb\u5708"/u);
    assert.match(lockedRootSource, /GetWindowRect\(\$hWnd, \[ref\]\$win32Rect\)/u);
    assert.match(lockedRootSource, /\(\$win32Rect\.Right - \$win32Rect\.Left\) -lt 300/u);
    assert.match(lockedRootSource, /\(\$win32Rect\.Bottom - \$win32Rect\.Top\) -lt 300/u);
    assert.match(lockedRootSource, /AutomationElement\]::FromHandle\(\$hWnd\)/u);
    assert.match(lockedRootSource, /Automation\]::Compare\(\$root, \$target\.root\)/u);
    assert.match(lockedRootSource, /\$identityMode = \[string\]\$env:XIAOXI_MOMENTS_IDENTITY_MODE/u);
    assert.match(lockedRootSource, /\$automationIdMatches = \(\$identityMode -ceq "automation_id" -and \$rootAutomationId -ceq "SNSWindow"\) -or/u);
    assert.match(lockedRootSource, /\(\$identityMode -ceq "structural_sns_feed" -and \$rootAutomationId -ceq ""\)/u);
    assert.match(lockedRootSource, /\$automationIdMatches -and \$rootName -ceq "\u670b\u53cb\u5708"/u);
    assert.doesNotMatch(lockedRootSource, /@\("SNSWindow", ""\) -ccontains/u);
    assert.match(lockedRootSource, /\$rootName -ceq "\u670b\u53cb\u5708"/u);
    assert.match(lockedRootSource, /\$rootControlType -ceq "ControlType\.Window"/u);
    assert.match(lockedRootSource, /\$rootIsEnabled -and -not \$rootIsOffscreen/u);
    assert.match(lockedRootSource, /Test-FinitePositiveRect \$rootRect/u);
    assert.match(lockedRootSource, /\$rootRect\.Width -ge 300 -and \$rootRect\.Height -ge 300/u);
    const escapeDismissSource = driverSource.match(/function Invoke-MomentsMenuEscapeDismiss[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(escapeDismissSource, /\$knownPopup -eq \[IntPtr\]::Zero -or \$knownPopup -eq \$target\.hWnd/u);
    assert.match(escapeDismissSource, /-not \[Win32WechatMomentsAction\]::IsWindowVisible\(\$knownPopup\)/u);
    assert.match(escapeDismissSource, /Test-WindowOwnedByLockedMoments \$knownPopup \$target/u);
    assert.match(escapeDismissSource, /Test-LockedMomentsRootIdentity \$target/u);
    assert.match(escapeDismissSource, /\$foreground -ne \$target\.hWnd -and \$foreground -ne \$knownPopup/u);
    assert.match(escapeDismissSource, /\$confirmedForeground -ne \$target\.hWnd -and \$confirmedForeground -ne \$knownPopup/u);
    assert.ok((escapeDismissSource.match(/IsWindowVisible\(\$knownPopup\)/gu) ?? []).length >= 2);
    assert.ok((escapeDismissSource.match(/Test-WindowOwnedByLockedMoments \$knownPopup \$target/gu) ?? []).length >= 2);
    assert.ok((escapeDismissSource.match(/Test-LockedMomentsRootIdentity \$target/gu) ?? []).length >= 2);
    const escapeDown = "[Win32WechatMomentsAction]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)";
    const escapeUp = "[Win32WechatMomentsAction]::keybd_event(0x1B, 0, 0x0002, [UIntPtr]::Zero)";
    assert.ok(escapeDismissSource.indexOf(escapeDown) < escapeDismissSource.indexOf(escapeUp));
    assert.match(escapeDismissSource, /\[Win32WechatMomentsAction\]::keybd_event\(0x1B, 0, 0, \[UIntPtr\]::Zero\)\s+\[Win32WechatMomentsAction\]::keybd_event\(0x1B, 0, 0x0002, \[UIntPtr\]::Zero\)/u);
    assert.doesNotMatch(escapeDismissSource, /mouse_event|SetCursorPos|Invoke-MomentsMenuToggleClick|SendKeys|Clipboard/u);
    const closeMenuSource = driverSource.match(/function Close-MomentsMenu[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(driverSource, /\$script:lastMenuCloseFailure = ""/u);
    assert.match(closeMenuSource, /^function Close-MomentsMenu\(\$target\) \{\s+\$script:lastMenuCloseFailure = ""/u);
    for (const stage of [
      "target_missing",
      "foreground_untrusted",
      "popup_untrusted",
      "anchor_missing",
      "proof_invalid",
      "escape_blocked",
      "popup_still_visible",
      "root_identity_changed",
      "foreground_not_restored",
      "popup_remaining",
      "buttons_remaining"
    ]) {
      assert.match(closeMenuSource, new RegExp(`\\$script:lastMenuCloseFailure = "${stage}"`, "u"));
    }
    assert.match(closeMenuSource, /Test-WindowOwnedByLockedMoments \$foregroundBefore \$target/u);
    assert.match(closeMenuSource, /\$knownPopup -eq \[IntPtr\]::Zero -or \$knownPopup -eq \$target\.hWnd/u);
    assert.match(closeMenuSource, /-not \[Win32WechatMomentsAction\]::IsWindowVisible\(\$knownPopup\)/u);
    assert.match(closeMenuSource, /Get-MomentsOpenMenuProof \$target \$knownPopup/u);
    assert.match(closeMenuSource, /if \(-not \$menuProof\.ok\) \{ \$script:lastMenuCloseFailure = "proof_invalid"; return \$false \}/u);
    assert.match(closeMenuSource, /Invoke-MomentsMenuEscapeDismiss \$target \$knownPopup/u);
    assert.match(closeMenuSource, /\$script:lastMenuCloseFailure = "escape_blocked"; return \$false/u);
    assert.doesNotMatch(closeMenuSource, /Invoke-MomentsMenuToggleClick|Invoke-VerifiedClick|Invoke-VerifiedOwnedPopupClick|mouse_event|SetCursorPos/u);
    assert.ok(closeMenuSource.indexOf("IsWindowVisible($knownPopup)") < closeMenuSource.indexOf("Get-MomentsOpenMenuProof $target $knownPopup"));
    assert.ok(closeMenuSource.indexOf("Get-MomentsOpenMenuProof $target $knownPopup") < closeMenuSource.indexOf("Invoke-MomentsMenuEscapeDismiss $target $knownPopup"));
    assert.match(closeMenuSource, /\$popupHidden = \$false/u);
    assert.match(closeMenuSource, /for \(\$attempt = 0; \$attempt -lt 8; \$attempt\+\+\)/u);
    assert.match(closeMenuSource, /Start-Sleep -Milliseconds 80/u);
    assert.match(closeMenuSource, /-not \[Win32WechatMomentsAction\]::IsWindowVisible\(\$knownPopup\)\) \{ \$popupHidden = \$true; break \}/u);
    assert.match(closeMenuSource, /if \(-not \$popupHidden\) \{ \$script:lastMenuCloseFailure = "popup_still_visible"; return \$false \}/u);
    assert.match(closeMenuSource, /if \(-not \(Test-LockedMomentsRootIdentity \$target\)\) \{ \$script:lastMenuCloseFailure = "root_identity_changed"; return \$false \}/u);
    assert.doesNotMatch(closeMenuSource, /Start-Sleep -Milliseconds 140/u);
    assert.match(closeMenuSource, /GetForegroundWindow\(\) -ne \$target\.hWnd/u);
    assert.ok(closeMenuSource.indexOf("Invoke-MomentsMenuEscapeDismiss $target $knownPopup") < closeMenuSource.indexOf("GetForegroundWindow() -ne $target.hWnd"));
    assert.ok(closeMenuSource.indexOf("if (-not $popupHidden)") < closeMenuSource.indexOf("GetForegroundWindow() -ne $target.hWnd"));
    assert.ok(closeMenuSource.indexOf("if (-not $popupHidden)") < closeMenuSource.indexOf("Test-LockedMomentsRootIdentity $target"));
    assert.ok(closeMenuSource.indexOf("Test-LockedMomentsRootIdentity $target") < closeMenuSource.indexOf("GetForegroundWindow() -ne $target.hWnd"));
    assert.match(closeMenuSource, /IsWindowVisible\(\$knownPopup\)/u);
    assert.match(closeMenuSource, /Get-OwnedMomentsPopupHandlesNearMenu/u);
    assert.match(closeMenuSource, /\$remainingPopups\.Count -ne 0/u);
    assert.match(closeMenuSource, /Get-VisibleMomentsInteractionButtonCounts/u);
    assert.match(closeMenuSource, /\$counts\.likeCount -ne 0 -or \$counts\.commentCount -ne 0/u);
    assert.ok(closeMenuSource.indexOf("GetForegroundWindow() -ne $target.hWnd") < closeMenuSource.indexOf("Get-OwnedMomentsPopupHandlesNearMenu"));
    assert.ok(closeMenuSource.indexOf("Get-OwnedMomentsPopupHandlesNearMenu") < closeMenuSource.indexOf("Get-VisibleMomentsInteractionButtonCounts"));
    const closeReasonSource = driverSource.match(/function Get-MomentsMenuCloseReason[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(closeReasonSource, /IsNullOrWhiteSpace\(\[string\]\$script:lastMenuCloseFailure\)/u);
    assert.match(closeReasonSource, /return "moments_menu_close_unverified"/u);
    assert.match(closeReasonSource, /return "moments_menu_close_\$\(\$script:lastMenuCloseFailure\)"/u);
    const menuCountSource = driverSource.match(/function Get-VisibleMomentsInteractionButtonCounts[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(menuCountSource, /AutomationElement\]::FromHandle\(\[IntPtr\]\$rootHandle\)/u);
    assert.match(menuCountSource, /Test-WindowOwnedByLockedMoments \$foreground \$target/u);
    assert.doesNotMatch(menuCountSource, /\$target\.root\.FindAll/u);
    const popupEntrySource = driverSource.match(/function Test-MomentsPopupEntryPoint[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(popupEntrySource, /IsNullOrWhiteSpace\(\[string\]\$entry\.runtimeId\)/u);
    assert.match(popupEntrySource, /@\("\u8d5e", "\u53d6\u6d88", "\u53d6\u6d88\u8d5e", "\u8bc4\u8bba"\) -notcontains \[string\]\$entry\.name/u);
    assert.match(popupEntrySource, /IsWindowVisible\(\$expectedRootHWnd\)/u);
    assert.match(popupEntrySource, /Test-WindowOwnedByLockedMoments \$expectedRootHWnd \$target/u);
    assert.match(popupEntrySource, /\$x = \[int\]\[Math\]::Round\(\(\$entry\.rect\.Left \+ \$entry\.rect\.Right\) \/ 2\)/u);
    assert.match(popupEntrySource, /\$y = \[int\]\[Math\]::Round\(\(\$entry\.rect\.Top \+ \$entry\.rect\.Bottom\) \/ 2\)/u);
    assert.match(popupEntrySource, /Get-TopLevelWindowHandle \(\[Win32WechatMomentsAction\]::WindowFromPoint\(\$point\)\)/u);
    assert.match(popupEntrySource, /\$hitRoot -ne \$expectedRootHWnd/u);
    assert.match(popupEntrySource, /AutomationElement\]::FromPoint\(\(New-Object System\.Windows\.Point\(\$x, \$y\)\)\)/u);
    assert.match(popupEntrySource, /TreeWalker\]::RawViewWalker/u);
    assert.doesNotMatch(popupEntrySource, /ControlViewWalker|FindAll|GetFirstChild|GetNextSibling/u);
    assert.match(popupEntrySource, /for \(\$depth = 0; \$depth -lt 8 -and \$cursor -ne \$null; \$depth\+\+\)/u);
    assert.match(popupEntrySource, /\$processId -ne \[int\]\$target\.pid/u);
    assert.match(popupEntrySource, /\$controlType -eq \[System\.Windows\.Automation\.ControlType\]::Button/u);
    assert.match(popupEntrySource, /\$name -ceq \[string\]\$entry\.name -and \(Get-RuntimeId \$cursor\) -ceq \[string\]\$entry\.runtimeId/u);
    assert.match(popupEntrySource, /\$isEnabled -and -not \$isOffscreen -and \(Test-FinitePositiveRect \$rect\)/u);
    assert.match(popupEntrySource, /\[Math\]::Abs\(\$rect\.Left - \$entry\.rect\.Left\) -le 2/u);
    assert.match(popupEntrySource, /\[Math\]::Abs\(\$rect\.Top - \$entry\.rect\.Top\) -le 2/u);
    assert.match(popupEntrySource, /\[Math\]::Abs\(\$rect\.Right - \$entry\.rect\.Right\) -le 2/u);
    assert.match(popupEntrySource, /\[Math\]::Abs\(\$rect\.Bottom - \$entry\.rect\.Bottom\) -le 2/u);
    assert.match(popupEntrySource, /\$x -ge \$rect\.Left -and \$x -le \$rect\.Right -and \$y -ge \$rect\.Top -and \$y -le \$rect\.Bottom/u);
    const ownedPopupClickSource = driverSource.match(/function Invoke-VerifiedOwnedPopupClick[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(ownedPopupClickSource, /\$hitRoot -ne \$expectedRootHWnd/u);
    assert.match(ownedPopupClickSource, /\$foreground -ne \$target\.hWnd -and \$foreground -ne \$expectedRootHWnd/u);
    assert.match(ownedPopupClickSource, /\$confirmedForeground -ne \$target\.hWnd -and \$confirmedForeground -ne \$expectedRootHWnd/u);
    const popupEntryChecks = [...ownedPopupClickSource.matchAll(/Test-MomentsPopupEntryPoint \$entry \$target/gu)].map((match) => match.index);
    assert.equal(popupEntryChecks.length, 2);
    assert.ok(popupEntryChecks[0] < ownedPopupClickSource.indexOf("SetCursorPos($x, $y)"));
    assert.ok(ownedPopupClickSource.indexOf("SetCursorPos($x, $y)") < popupEntryChecks[1]);
    assert.ok((ownedPopupClickSource.match(/SetCursorPos\(\$x, \$y\)/gu) ?? []).length >= 2);
    assert.match(ownedPopupClickSource, /Test-CursorAt \$x \$y/u);
    assert.match(ownedPopupClickSource, /\$finalRoot = Get-TopLevelWindowHandle \(\[Win32WechatMomentsAction\]::WindowFromPoint\(\$point\)\)/u);
    assert.match(ownedPopupClickSource, /\$finalForeground = \[Win32WechatMomentsAction\]::GetForegroundWindow\(\)/u);
    assert.match(ownedPopupClickSource, /\$finalRoot -ne \$expectedRootHWnd/u);
    assert.match(ownedPopupClickSource, /\$finalForeground -ne \$target\.hWnd -and \$finalForeground -ne \$expectedRootHWnd/u);
    const popupMouseDownIndex = ownedPopupClickSource.indexOf("mouse_event(0x0002");
    assert.ok(ownedPopupClickSource.lastIndexOf("SetCursorPos($x, $y)", popupMouseDownIndex) < ownedPopupClickSource.lastIndexOf("$finalRoot", popupMouseDownIndex));
    assert.ok(ownedPopupClickSource.lastIndexOf("$finalRoot", popupMouseDownIndex) < ownedPopupClickSource.lastIndexOf("Test-CursorAt $x $y", popupMouseDownIndex));
    assert.ok(ownedPopupClickSource.lastIndexOf("$finalForeground", popupMouseDownIndex) < ownedPopupClickSource.lastIndexOf("Test-CursorAt $x $y", popupMouseDownIndex));
    assert.ok(ownedPopupClickSource.lastIndexOf("Test-CursorAt $x $y", popupMouseDownIndex) < popupMouseDownIndex);
    assert.match(ownedPopupClickSource, /\$finalForeground -ne \$expectedRootHWnd\) -or\s+-not \(Test-CursorAt \$x \$y\)\) \{ return \$false \}\s+\[Win32WechatMomentsAction\]::mouse_event\(0x0002/u);
    assert.doesNotMatch(ownedPopupClickSource, /SendKeys|Clipboard|keybd_event/u);
    const openMenuSource = driverSource.match(/function Open-MomentsMenu[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(openMenuSource, /Get-OwnedMomentsPopupHandlesNearMenu/u);
    assert.match(openMenuSource, /\$popupHandles\.Count -ne 1/u);
    assert.match(openMenuSource, /Set-MomentsMenuAnchor \$target/u);
    assert.match(openMenuSource, /Invoke-MomentsMenuToggleClick \$target/u);
    assert.ok(openMenuSource.indexOf("Set-MomentsMenuAnchor $target") < openMenuSource.indexOf("Invoke-MomentsMenuToggleClick $target"));
    assert.doesNotMatch(openMenuSource, /Invoke-VerifiedClick \$menuX \$menuY/u);
    assert.match(openMenuSource, /\$target\["menuRootHWnd"\] = \$popupHWnd/u);
    assert.match(openMenuSource, /Get-MomentsOpenMenuProof \$target \$popupHWnd/u);
    assert.match(openMenuSource, /if \(-not \$proof\.ok\)/u);
    assert.ok((openMenuSource.match(/Get-MomentsMenuCloseReason/gu) ?? []).length >= 2);
    assert.match(openMenuSource, /\$target\["menuRootHWnd"\] = \[IntPtr\]\$proof\.rootHWnd/u);
    assert.match(openMenuSource, /like = \$proof\.like/u);
    assert.match(openMenuSource, /comment = \$proof\.comment/u);
    assert.ok(openMenuSource.indexOf('$target["menuRootHWnd"] = $popupHWnd') < openMenuSource.indexOf("Get-MomentsOpenMenuProof $target $popupHWnd"));
    assert.doesNotMatch(openMenuSource, /Get-MenuButtonsByPoint|\$geometryVerified|\$likeEntries|\$commentEntries/u);
    assert.doesNotMatch(openMenuSource, /\$target\.root\.FindAll/u);
    const pointSampleSource = driverSource.match(/function Get-MenuButtonsByPoint[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(driverSource, /Add-Type -AssemblyName WindowsBase/u);
    assert.match(pointSampleSource, /GetWindowRect\(\$popupHWnd, \[ref\]\$popupWin32Rect\)/u);
    assert.match(pointSampleSource, /\$popupWin32Width -lt 120 -or \$popupWin32Width -gt 320/u);
    assert.match(pointSampleSource, /\$popupWin32Height -lt 24 -or \$popupWin32Height -gt 90/u);
    assert.match(pointSampleSource, /AutomationElement\]::FromHandle\(\$popupHWnd\)/u);
    assert.match(pointSampleSource, /\$popupProcessId = \[int\]\$popupElement\.Current\.ProcessId/u);
    assert.match(pointSampleSource, /\$popupIsEnabled = \$popupElement\.Current\.IsEnabled/u);
    assert.match(pointSampleSource, /\$popupIsOffscreen = \$popupElement\.Current\.IsOffscreen/u);
    assert.match(pointSampleSource, /\$popupRect = \$popupElement\.Current\.BoundingRectangle/u);
    assert.match(pointSampleSource, /\$popupProcessId -ne \[int\]\$target\.pid/u);
    assert.match(pointSampleSource, /-not \$popupIsEnabled -or \$popupIsOffscreen/u);
    assert.match(pointSampleSource, /Test-FinitePositiveRect \$popupRect/u);
    assert.match(pointSampleSource, /\$popupWidth = \[double\]\$popupRect\.Width/u);
    assert.match(pointSampleSource, /\$popupHeight = \[double\]\$popupRect\.Height/u);
    assert.match(pointSampleSource, /\$scaleX = \$popupWidth \/ \$popupWin32Width/u);
    assert.match(pointSampleSource, /\$scaleY = \$popupHeight \/ \$popupWin32Height/u);
    assert.match(pointSampleSource, /\$scaleX -lt 0\.9 -or \$scaleX -gt 3\.0/u);
    assert.match(pointSampleSource, /\$scaleY -lt 0\.9 -or \$scaleY -gt 3\.0/u);
    assert.match(pointSampleSource, /\[Math\]::Abs\(\$scaleX - \$scaleY\) -gt 0\.05/u);
    assert.match(pointSampleSource, /\$target\["menuPopupRect"\] = \$popupRect/u);
    assert.match(pointSampleSource, /\$popupRect\.Left \+ \(\$popupWidth \* \$xFraction\)/u);
    assert.match(pointSampleSource, /\$popupRect\.Top \+ \(\$popupHeight \* \$yFraction\)/u);
    assert.match(pointSampleSource, /AutomationElement\]::FromPoint\(\(New-Object System\.Windows\.Point\(\$x, \$y\)\)\)/u);
    assert.match(pointSampleSource, /foreach \(\$yFraction in @\(0\.5, 0\.35, 0\.65\)\)/u);
    assert.match(pointSampleSource, /foreach \(\$xFraction in @\(0\.25, 0\.75, 0\.12, 0\.38, 0\.62, 0\.88\)\)/u);
    assert.ok(pointSampleSource.indexOf("foreach ($yFraction in @(0.5, 0.35, 0.65))") < pointSampleSource.indexOf("foreach ($xFraction in @(0.25, 0.75, 0.12, 0.38, 0.62, 0.88))"));
    assert.match(pointSampleSource, /\$pointRoot -ne \$popupHWnd/u);
    assert.match(pointSampleSource, /for \(\$depth = 0; \$depth -lt 8 -and \$cursor -ne \$null; \$depth\+\+\)/u);
    assert.match(pointSampleSource, /\$walker\.GetParent\(\$cursor\)/u);
    assert.match(pointSampleSource, /@\("\u8d5e", "\u53d6\u6d88", "\u53d6\u6d88\u8d5e", "\u8bc4\u8bba"\) -contains \$name/u);
    assert.match(pointSampleSource, /\$processId = \[int\]\$cursor\.Current\.ProcessId/u);
    assert.match(pointSampleSource, /\$processId -eq \[int\]\$target\.pid/u);
    assert.match(pointSampleSource, /\$isEnabled = \$cursor\.Current\.IsEnabled/u);
    assert.match(pointSampleSource, /\$isOffscreen = \$cursor\.Current\.IsOffscreen/u);
    assert.match(pointSampleSource, /\$processId -eq \[int\]\$target\.pid -and \$isEnabled -and -not \$isOffscreen/u);
    assert.match(pointSampleSource, /\$rect\.Width -gt 0 -and \$rect\.Height -gt 0/u);
    assert.match(pointSampleSource, /\$rect\.Left -ge \(\$popupRect\.Left - 2\)/u);
    assert.match(pointSampleSource, /\$rect\.Top -ge \(\$popupRect\.Top - 2\)/u);
    assert.match(pointSampleSource, /\$rect\.Right -le \(\$popupRect\.Right \+ 2\)/u);
    assert.match(pointSampleSource, /\$rect\.Bottom -le \(\$popupRect\.Bottom \+ 2\)/u);
    assert.match(pointSampleSource, /\$runtimeId = Get-RuntimeId \$cursor/u);
    assert.match(pointSampleSource, /if \(\$runtimeId\) \{ \$buttons\[\$runtimeId\] =/u);
    assert.match(pointSampleSource, /rootHWnd = \$popupHWnd; runtimeId = \$runtimeId/u);
    assert.match(pointSampleSource, /\$sampledButtons = @\(\$buttons\.Values\)/u);
    assert.match(pointSampleSource, /\$sampledLikeCount = @\(\$sampledButtons \| Where-Object \{ @\("\u8d5e", "\u53d6\u6d88", "\u53d6\u6d88\u8d5e"\) -contains \$_\.name \}\)\.Count/u);
    assert.match(pointSampleSource, /\$sampledCommentCount = @\(\$sampledButtons \| Where-Object \{ \$_\.name -eq "\u8bc4\u8bba" \}\)\.Count/u);
    assert.match(pointSampleSource, /if \(\$sampledLikeCount -eq 1 -and \$sampledCommentCount -eq 1\) \{ return \$sampledButtons \}/u);
    const earlyReturnIndex = pointSampleSource.indexOf("return $sampledButtons");
    const fallbackReturnIndex = pointSampleSource.lastIndexOf("return @($buttons.Values)");
    assert.ok(earlyReturnIndex > pointSampleSource.indexOf("$sampledCommentCount"));
    assert.ok(earlyReturnIndex < fallbackReturnIndex);
    assert.match(pointSampleSource, /\s+return @\(\$buttons\.Values\)\s+\}$/u);
    assert.doesNotMatch(pointSampleSource, /FindAll|GetFirstChild|GetNextSibling/u);
    const closeComposerSource = driverSource.match(/function Close-CommentComposerNeutral[\s\S]*?\n\}/u)?.[0] ?? "";
    assert.match(closeComposerSource, /\$observedPopupHandles = @\{\}/u);
    assert.match(closeComposerSource, /\$anchorPoints = New-Object System\.Collections\.ArrayList/u);
    assert.match(closeComposerSource, /\$target\.ContainsKey\("menuX"\) -and \$target\.ContainsKey\("menuY"\)/u);
    assert.match(closeComposerSource, /\$anchorPoints\.Add\(@\{ x = \[int\]\$target\.menuX; y = \[int\]\$target\.menuY \}\)/u);
    assert.match(closeComposerSource, /\$observedPopupHandles\[\[string\]\[int64\]\$initialPopup\] = \$initialPopup/u);
    assert.match(closeComposerSource, /\$beforeScan = Get-CommentEditorCandidates \$target/u);
    assert.match(closeComposerSource, /if \(-not \$beforeScan\.ok\) \{ return \$false \}/u);
    assert.match(closeComposerSource, /\$beforeCandidates\.Count -gt 1/u);
    assert.match(closeComposerSource, /\$beforeCandidates\[0\]\.runtimeId -cne \$expectedRuntimeId/u);
    assert.match(closeComposerSource, /if \(\$beforeCandidates\.Count -eq 0\)/u);
    assert.match(closeComposerSource, /IsWindowVisible\(\$knownPopup\)[\s\S]*Close-MomentsMenu \$target/u);
    assert.ok(closeComposerSource.indexOf("Get-CommentEditorCandidates $target") < closeComposerSource.indexOf("Close-MomentsMenu $target"));
    assert.match(closeComposerSource, /\$lockedRuntimeId = \[string\]\$beforeCandidates\[0\]\.runtimeId/u);
    assert.match(closeComposerSource, /\$freshTarget = Get-TargetContext/u);
    assert.match(closeComposerSource, /Set-MomentsMenuAnchor \$freshTarget/u);
    assert.match(closeComposerSource, /\$anchorPoints\.Add\(@\{ x = \[int\]\$freshTarget\.menuX; y = \[int\]\$freshTarget\.menuY \}\)/u);
    assert.match(closeComposerSource, /\$freshCandidates\.Count -ne 1 -or \$freshCandidates\[0\]\.runtimeId -cne \$lockedRuntimeId/u);
    assert.match(closeComposerSource, /Invoke-MomentsMenuToggleClick \$freshTarget/u);
    assert.match(closeComposerSource, /\$menuTarget = Get-TargetContext/u);
    assert.match(closeComposerSource, /Set-MomentsMenuAnchor \$menuTarget/u);
    assert.match(closeComposerSource, /\$anchorPoints\.Add\(@\{ x = \[int\]\$menuTarget\.menuX; y = \[int\]\$menuTarget\.menuY \}\)/u);
    assert.match(closeComposerSource, /\$afterToggleScan = Get-CommentEditorCandidates \$menuTarget/u);
    assert.match(closeComposerSource, /@\(\$afterToggleScan\.candidates\)\.Count -ne 0/u);
    assert.match(closeComposerSource, /\$popupSet = @\{\}/u);
    assert.match(closeComposerSource, /foreach \(\$anchorPoint in @\(\$anchorPoints\)\)/u);
    assert.match(closeComposerSource, /Get-OwnedMomentsPopupHandlesNearMenu \$menuTarget \(\[int\]\$anchorPoint\.x\) \(\[int\]\$anchorPoint\.y\)/u);
    assert.match(closeComposerSource, /\$popupSet\[\[string\]\[int64\]\$popupHandle\] = \[IntPtr\]\$popupHandle/u);
    assert.match(closeComposerSource, /\$observedPopupHandles\[\[string\]\[int64\]\$popupHandle\] = \[IntPtr\]\$popupHandle/u);
    assert.match(closeComposerSource, /foreach \(\$observedPopup in @\(\$observedPopupHandles\.Values\)\)/u);
    assert.match(closeComposerSource, /IsWindowVisible\(\$observedHandle\)[\s\S]*Test-WindowOwnedByLockedMoments \$observedHandle \$menuTarget[\s\S]*\$popupSet\[\[string\]\[int64\]\$observedHandle\] = \$observedHandle/u);
    assert.match(closeComposerSource, /\$popupHandles = @\(\$popupSet\.Values\)/u);
    assert.match(closeComposerSource, /\$popupHandles\.Count -gt 1/u);
    assert.match(closeComposerSource, /if \(\$popupHandles\.Count -eq 1\)/u);
    assert.match(closeComposerSource, /\$menuTarget\["menuRootHWnd"\] = \[IntPtr\]\$popupHandles\[0\]/u);
    assert.match(closeComposerSource, /Get-MomentsOpenMenuProof \$menuTarget \(\[IntPtr\]\$popupHandles\[0\]\)/u);
    assert.match(closeComposerSource, /-not \$menuProof\.ok -or -not \(Close-MomentsMenu \$menuTarget\)/u);
    assert.ok(closeComposerSource.indexOf("Invoke-MomentsMenuToggleClick $freshTarget") < closeComposerSource.indexOf("$menuTarget = Get-TargetContext"));
    assert.ok(closeComposerSource.indexOf("$menuTarget = Get-TargetContext") < closeComposerSource.indexOf("Get-MomentsOpenMenuProof $menuTarget"));
    assert.ok(closeComposerSource.indexOf("Get-MomentsOpenMenuProof $menuTarget") < closeComposerSource.indexOf("Close-MomentsMenu $menuTarget"));
    assert.match(closeComposerSource, /\$afterTarget = Get-TargetContext/u);
    assert.match(closeComposerSource, /Set-MomentsMenuAnchor \$afterTarget/u);
    assert.match(closeComposerSource, /\$anchorPoints\.Add\(@\{ x = \[int\]\$afterTarget\.menuX; y = \[int\]\$afterTarget\.menuY \}\)/u);
    assert.match(closeComposerSource, /\$afterScan = Get-CommentEditorCandidates \$afterTarget/u);
    assert.match(closeComposerSource, /@\(\$afterScan\.candidates\)\.Count -ne 0/u);
    assert.match(closeComposerSource, /\$remainingPopupSet = @\{\}/u);
    assert.match(closeComposerSource, /Get-OwnedMomentsPopupHandlesNearMenu \$afterTarget \(\[int\]\$anchorPoint\.x\) \(\[int\]\$anchorPoint\.y\)/u);
    assert.match(closeComposerSource, /\$remainingPopupSet\[\[string\]\[int64\]\$popupHandle\] = \[IntPtr\]\$popupHandle/u);
    assert.match(closeComposerSource, /if \(\$remainingPopupSet\.Count -ne 0\) \{ return \$false \}/u);
    assert.match(closeComposerSource, /IsWindowVisible\(\[IntPtr\]\$observedPopup\)\) \{ return \$false \}/u);
    assert.match(closeComposerSource, /return \$true/u);
    assert.match(driverSource, /function inspectCommentDraft[\s\S]*runMomentsAction\("comment_check", context\)/u);
    assert.match(driverSource, /module\.exports = \{ comment, inspectCommentDraft, inspectMenu, like \};/u);
    const readOnlyInspectSource = driverSource.match(/if \(\$action -eq "inspect"\)[\s\S]*?if \(\$action -eq "like"\)/u)?.[0] ?? "";
    assert.match(readOnlyInspectSource, /if \(\$action -eq "comment_check"\)/u);
    assert.match(readOnlyInspectSource, /if \(-not \(Close-MomentsMenu \$target\)\)[\s\S]*reason = \(Get-MomentsMenuCloseReason\)/u);
    assert.doesNotMatch(readOnlyInspectSource, /SendKeys|Clipboard/u);
    assert.doesNotMatch(readOnlyInspectSource, /Invoke-VerifiedClick \$sendX \$sendY/u);
    const windowDriverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.cjs"), "utf8");
    assert.match(windowDriverSource, /if \(options\.sta === true\) shellArgs\.push\("-STA"\)/u);

    const panelSource = fs.readFileSync(path.join(__dirname, "../../src/renderer/MomentsDryRunPanel.tsx"), "utf8");
    assert.match(panelSource, /const \[menuVerified, setMenuVerified\] = useState\(false\)/u);
    assert.match(panelSource, /const \[commentSendSupported, setCommentSendSupported\] = useState\(false\)/u);
    assert.match(panelSource, /disabled=\{busy \|\| !observationId \|\| !menuVerified \|\| !likeEnabled\}/u);
    assert.match(panelSource, /disabled=\{busy \|\| !observationId \|\| !menuVerified \|\| !commentSendSupported \|\| !commentEnabled/u);
    assert.ok((panelSource.match(/setMenuVerified\(false\)/gu) ?? []).length >= 4, "every observation invalidation path must close the real action gate");
    assert.match(panelSource, /当前可见测试帖（不校验作者）/u);
    assert.match(panelSource, /观察锁 5 分钟内有效/u);
    assert.match(panelSource, /本次已确认未点击或发送/u);
    assert.match(panelSource, /重新预演也不会再次执行该动作/u);

    const mainSource = fs.readFileSync(path.join(__dirname, "../../src/main/main.cjs"), "utf8");
    assert.match(mainSource, /registerActiveTouchDevIpc\(\{[\s\S]*activeTouchDir: runtime\.activeTouchDir,[\s\S]*momentsDir: runtime\.momentsDir,[\s\S]*coordinator,[\s\S]*getMainWindow/u);
    assert.match(mainSource, /backgroundThrottling: false/u);
    const devIpcSource = fs.readFileSync(path.join(__dirname, "../../src/main/active-touch-dev-ipc.cjs"), "utf8");
    assert.match(devIpcSource, /runtimeCoordinator\.acquire\(\{/u);
    assert.match(devIpcSource, /runtimeCoordinator\.release\(lock\.lock\.owner\)/u);
    assert.match(devIpcSource, /dataDir: momentsDataDir/u);

    console.log("moments action self-check passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
