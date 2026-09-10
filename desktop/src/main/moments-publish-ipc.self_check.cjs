const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { writeJsonAtomic } = require("./atomic-file.cjs");
const {
  buildPublishFingerprint,
  countOcrCharacters,
  createMomentsPublishController,
  createTrustedClickValidator,
  normalizeContent,
  validateMediaDescriptors
} = require("./moments-publish-ipc.cjs");

function createClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 3, 10, 0, tick++));
}

function writeMedia(root, name, content) {
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  return file;
}

async function prepareDraft(controller, paths, content) {
  const chosen = await controller.chooseMedia(paths);
  assert.equal(chosen.ok, true);
  assert.equal(typeof chosen.selection.selection_id, "string");
  assert.equal(chosen.selection.selection_id.includes(path.dirname(paths[0])), false);
  const prepared = await controller.prepare({
    selectionId: chosen.selection.selection_id,
    content
  });
  assert.equal(prepared.ok, true);
  return prepared;
}

function makeCoordinator(owner = "publish-test-owner") {
  const calls = { acquire: 0, release: 0, update: 0 };
  return {
    calls,
    coordinator: {
      acquire: (request) => {
        calls.acquire += 1;
        assert.equal(request.state, "running_moments");
        assert.equal(request.phase, "moments:publish");
        return { ok: true, lock: { owner } };
      },
      update: (actualOwner) => {
        calls.update += 1;
        assert.equal(actualOwner, owner);
        return { ok: true };
      },
      release: (actualOwner) => {
        calls.release += 1;
        assert.equal(actualOwner, owner);
        return { ok: true };
      }
    }
  };
}

async function main() {
  assert.equal(normalizeContent("  abc\r\n  朋友圈 123  \r\n"), "abc\n  朋友圈 123");
  assert.equal(countOcrCharacters("空 格 A1！"), 4);
  const firstMedia = [
    { sha256: "a".repeat(64), size: 11, ext: ".jpg" },
    { sha256: "b".repeat(64), size: 22, ext: ".png" }
  ];
  const normalizedFingerprint = buildPublishFingerprint("  abc\r\n朋友圈 123  ", firstMedia);
  assert.equal(
    normalizedFingerprint,
    buildPublishFingerprint("abc\n朋友圈 123", firstMedia),
    "line-ending normalization must produce a stable fingerprint"
  );
  assert.notEqual(
    normalizedFingerprint,
    buildPublishFingerprint("abc 朋友圈 123", firstMedia),
    "internal line breaks are part of the exact content fingerprint"
  );
  assert.notEqual(
    normalizedFingerprint,
    buildPublishFingerprint("abc\n朋友圈 123", [...firstMedia].reverse()),
    "media order is part of the fingerprint"
  );
  assert.notEqual(
    normalizedFingerprint,
    buildPublishFingerprint("abc\n朋友圈 123", [
      { ...firstMedia[0], sha256: "c".repeat(64) },
      firstMedia[1]
    ]),
    "media bytes are part of the fingerprint"
  );
  assert.equal(validateMediaDescriptors(firstMedia).ok, true);
  assert.equal(validateMediaDescriptors([{ ext: ".mp4" }, { ext: ".mp4" }]).reason, "moments_publish_video_count_invalid");
  assert.equal(validateMediaDescriptors([{ ext: ".jpg" }, { ext: ".mp4" }]).reason, "moments_publish_media_mixed");
  assert.equal(validateMediaDescriptors([{ ext: ".gif" }]).reason, "moments_publish_media_type_unsupported");
  assert.equal(validateMediaDescriptors([{ ext: ".avi" }]).reason, "moments_publish_media_type_unsupported");
  assert.equal(validateMediaDescriptors(Array.from({ length: 10 }, () => ({ ext: ".jpg" }))).reason, "moments_publish_image_count_invalid");

  const webContents = {};
  let focused = true;
  const window = {
    webContents,
    isDestroyed: () => false,
    isFocused: () => focused
  };
  const trustedClick = createTrustedClickValidator(() => window);
  const trustedToken = "12345678-1234-1234-1234-123456789abc";
  assert.equal(trustedClick({ sender: webContents }, trustedToken), true);
  assert.equal(trustedClick({ sender: webContents }, trustedToken), false, "a token is one-time only");
  assert.equal(trustedClick({ sender: {} }, "22345678-1234-1234-1234-123456789abc"), false);
  focused = false;
  assert.equal(trustedClick({ sender: webContents }, "32345678-1234-1234-1234-123456789abc"), false);

  const verifiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-verified-"));
  const firstImage = writeMedia(verifiedRoot, "first-private-name.jpg", Buffer.from("first-image"));
  const secondImage = writeMedia(verifiedRoot, "second-private-name.png", Buffer.from("second-image"));
  const privateContent = "仅供自检的朋友圈正文 ABC123";
  const verifiedLock = makeCoordinator();
  let openCalls = 0;
  let driverCalls = 0;
  let verifiedStageDirectory = "";
  let verifiedMarkerPath = "";
  const verifiedController = createMomentsPublishController({
    baseDir: verifiedRoot,
    coordinator: verifiedLock.coordinator,
    now: createClock(),
    openMoments: async ({ signal, allowIntegrated, minIdleMs }) => {
      openCalls += 1;
      assert.equal(signal.aborted, false);
      assert.equal(allowIntegrated, true);
      assert.equal(minIdleMs, 0, "a trusted publish confirmation must run immediately instead of blocking on its own click");
      return {
        ok: true,
        pid: 101,
        hWnd: 202,
        title: "微信",
        className: "mmui::MainWindow",
        surfaceMode: "integrated"
      };
    },
    publishDriver: async (request) => {
      driverCalls += 1;
      assert.equal(request.content, normalizeContent(privateContent));
      verifiedStageDirectory = path.dirname(request.mediaPaths[0]);
      assert.equal(path.dirname(verifiedStageDirectory), path.join(verifiedRoot, "publish_staging"));
      assert.equal(request.mediaPaths.every((file) => path.dirname(file) === verifiedStageDirectory), true);
      assert.match(path.basename(request.mediaPaths[0]), /^01-[a-f0-9]{12}\.jpg$/u);
      assert.match(path.basename(request.mediaPaths[1]), /^02-[a-f0-9]{12}\.png$/u);
      assert.equal(fs.readFileSync(request.mediaPaths[0], "utf8"), "first-image");
      assert.equal(fs.readFileSync(request.mediaPaths[1], "utf8"), "second-image");
      assert.equal(request.mediaCount, 2);
      assert.equal(request.mediaKind, "image");
      assert.deepEqual(request.mediaManifest.map((item) => item.path), request.mediaPaths);
      assert.deepEqual(request.mediaManifest.map((item) => item.ext), [".jpg", ".png"]);
      assert.equal(request.mediaManifest.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256)), true);
      assert.equal(request.expectedWindow.pid, 101);
      assert.equal(request.expectedWindow.title, "微信");
      assert.equal(request.expectedWindow.className, "mmui::MainWindow");
      assert.equal(request.expectedWindow.surfaceMode, "integrated");
      assert.match(request.fingerprint, /^[a-f0-9]{64}$/u);
      assert.match(request.attemptId, /^[a-f0-9-]{36}$/u);
      assert.equal(request.signal.aborted, false);
      assert.equal(path.dirname(request.markerPath), path.join(verifiedRoot, "publish_markers"));
      verifiedMarkerPath = request.markerPath;
      fs.writeFileSync(request.markerPath, JSON.stringify({ actionAttempted: true }));
      return {
        ok: true,
        status: "verified",
        actionAttempted: true,
        verificationAttempts: 5,
        verificationElapsedMs: 2460,
        lastVerificationReason: "moments_publish_feed_unchanged"
      };
    }
  });
  assert.equal(verifiedController.initialize().ok, true);
  assert.equal(openCalls, 0, "initialize must not touch WeChat");
  const verifiedPrepared = await prepareDraft(
    verifiedController,
    [firstImage, secondImage],
    privateContent
  );
  assert.equal(verifiedPrepared.confirmation.content, undefined);
  assert.deepEqual(
    verifiedController.status().state.selection.files.map((item) => Object.keys(item).sort()),
    [["kind", "name", "size"], ["kind", "name", "size"]]
  );
  assert.equal(verifiedController.status().state.draft_id, verifiedPrepared.confirmation.confirmationId);
  assert.equal(verifiedController.status().state.media_kind, "image");
  const preparedDisk = fs.readFileSync(path.join(verifiedRoot, "publish-state.json"), "utf8");
  assert.equal(preparedDisk.includes(privateContent), false, "content must never be persisted");
  assert.equal(preparedDisk.includes(firstImage), false, "absolute media paths must never be persisted");
  assert.equal(preparedDisk.includes(path.dirname(firstImage)), false);
  const verified = await verifiedController.confirm({
    confirmationId: verifiedPrepared.confirmation.confirmationId
  });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.verified, true);
  assert.equal(verified.state.status, "verified");
  assert.equal(verified.state.verification_attempts, 5);
  assert.equal(verified.state.verification_elapsed_ms, 2460);
  assert.equal(verified.state.last_verification_reason, "moments_publish_feed_unchanged");
  assert.equal(openCalls, 1);
  assert.equal(driverCalls, 1);
  assert.equal(verifiedLock.calls.acquire, 1);
  assert.equal(verifiedLock.calls.release, 1);
  assert.equal(fs.existsSync(verifiedStageDirectory), false, "verified attempt staging must be removed");
  assert.equal(fs.existsSync(verifiedMarkerPath), false, "verified attempt marker must be retired");
  const verifiedDisk = fs.readFileSync(path.join(verifiedRoot, "publish-state.json"), "utf8");
  assert.equal(verifiedDisk.includes(privateContent), false);
  assert.equal(verifiedDisk.includes(firstImage), false);
  const verifiedDiskState = JSON.parse(verifiedDisk);
  assert.equal(verifiedDiskState.attempts.at(-1).verification_attempts, 5);
  assert.equal(verifiedDiskState.attempts.at(-1).verification_elapsed_ms, 2460);
  assert.equal(verifiedDiskState.attempts.at(-1).last_verification_reason, "moments_publish_feed_unchanged");

  const duplicateChosen = await verifiedController.chooseMedia([firstImage, secondImage]);
  assert.equal(duplicateChosen.ok, true);
  const duplicatePrepared = await verifiedController.prepare({
    selectionId: duplicateChosen.selection.selection_id,
    content: privateContent
  });
  assert.equal(duplicatePrepared.ok, false);
  assert.equal(duplicatePrepared.reason, "moments_publish_fingerprint_already_published");
  assert.equal(driverCalls, 1, "a verified fingerprint must never be sent again");

  const unknownRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-unknown-"));
  const unknownImage = writeMedia(unknownRoot, "unknown.jpg", Buffer.from("unknown-image"));
  const unknownLock = makeCoordinator("unknown-owner");
  let unknownDriverCalls = 0;
  let unknownStageDirectory = "";
  let unknownMarkerPath = "";
  const unknownController = createMomentsPublishController({
    baseDir: unknownRoot,
    coordinator: unknownLock.coordinator,
    now: createClock(),
    openMoments: async () => ({ ok: true, pid: 1, hWnd: 2 }),
    publishDriver: async ({ markerPath, mediaPaths }) => {
      unknownDriverCalls += 1;
      unknownStageDirectory = path.dirname(mediaPaths[0]);
      unknownMarkerPath = markerPath;
      fs.writeFileSync(markerPath, "{}");
      const error = new Error("simulated post-click failure");
      error.code = "simulated_driver_failure";
      throw error;
    }
  });
  unknownController.initialize();
  const unknownPrepared = await prepareDraft(unknownController, [unknownImage], "未知结果正文 ABC123");
  const unknown = await unknownController.confirm({
    confirmationId: unknownPrepared.confirmation.confirmationId
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.actionAttempted, true);
  assert.equal(unknown.state.status, "outcome_unknown");
  assert.equal(fs.existsSync(unknownStageDirectory), true, "unknown attempt staging must remain available until resolution");
  assert.equal(unknownLock.calls.release, 1);
  assert.equal((await unknownController.chooseMedia([unknownImage])).reason, "moments_publish_outcome_unknown_requires_resolution");
  const notPublished = unknownController.resolveUnknown({
    fingerprint: unknown.state.fingerprint,
    resolution: "not_published"
  });
  assert.equal(notPublished.ok, true);
  assert.equal(notPublished.state.status, "resolved_not_published");
  assert.equal(fs.existsSync(unknownStageDirectory), false, "manual resolution must remove attempt staging");
  assert.equal(fs.existsSync(unknownMarkerPath), false, "manual resolution must retire the durable marker");
  const retryPrepared = await prepareDraft(unknownController, [unknownImage], "未知结果正文 ABC123");
  assert.equal(retryPrepared.ok, true, "not_published resolution must allow a fresh attempt");
  const laterAttemptId = "22345678-1234-4abc-8def-1234567890ab";
  const laterMarkerName = `${unknown.state.fingerprint}.${laterAttemptId}.json`;
  fs.writeFileSync(path.join(unknownRoot, "publish_markers", laterMarkerName), "{}");
  const unknownReloadedController = createMomentsPublishController({
    baseDir: unknownRoot,
    now: createClock(),
    openMoments: async () => assert.fail("orphan recovery must not touch WeChat"),
    publishDriver: async () => assert.fail("orphan recovery must not invoke the driver")
  });
  const laterOrphan = unknownReloadedController.initialize();
  assert.equal(laterOrphan.state.status, "outcome_unknown");
  assert.equal(laterOrphan.state.last_reason, "moments_publish_orphan_marker_recovered");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(unknownRoot, "publish-state.json"), "utf8")).attempt_id,
    laterAttemptId,
    "a not_published fingerprint must not hide a later attempt's orphan marker"
  );
  assert.equal(unknownReloadedController.resolveUnknown({ resolution: "not_published" }).ok, true);

  const publishedResolutionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-resolved-published-"));
  const publishedResolutionImage = writeMedia(publishedResolutionRoot, "published.jpg", Buffer.from("published-image"));
  const publishedResolutionEvents = [];
  const publishedResolutionController = createMomentsPublishController({
    baseDir: publishedResolutionRoot,
    coordinator: makeCoordinator("resolved-owner").coordinator,
    now: createClock(),
    logger: {
      event: (domain, event, fields, options) => {
        publishedResolutionEvents.push({ domain, event, fields, options });
      }
    },
    openMoments: async () => ({ ok: true }),
    publishDriver: async () => {
      return {
        ok: false,
        reason: "moments_publish_outcome_unknown",
        actionAttempted: true,
        verificationAttempts: 18,
        verificationElapsedMs: 12024,
        lastVerificationReason: "moments_publish_post_not_found",
        verification_capture_ms: 30,
        verification_ocr_ms: 800,
        verification_candidates_ms: 5000,
        verification_post_count: 1,
        verification_anchor_present: false
      };
    }
  });
  publishedResolutionController.initialize();
  const publishedResolutionPrepared = await prepareDraft(
    publishedResolutionController,
    [publishedResolutionImage],
    "人工确认正文 ABC123"
  );
  const publishedResolutionUnknown = await publishedResolutionController.confirm({
    confirmationId: publishedResolutionPrepared.confirmation.confirmationId
  });
  assert.equal(publishedResolutionUnknown.state.outcome_unknown, true);
  assert.equal(publishedResolutionUnknown.state.verification_attempts, 18);
  assert.equal(publishedResolutionUnknown.state.verification_elapsed_ms, 12024);
  assert.equal(publishedResolutionUnknown.state.last_verification_reason, "moments_publish_post_not_found");
  const publishedResolutionUnknownEvent = publishedResolutionEvents.find(
    (entry) => entry.event === "publish.outcome_unknown"
  );
  assert.equal(publishedResolutionUnknownEvent.fields.verification_attempts, 18);
  assert.equal(publishedResolutionUnknownEvent.fields.verification_elapsed_ms, 12024);
  assert.equal(publishedResolutionUnknownEvent.fields.verification_candidates_ms, 5000);
  assert.equal(publishedResolutionUnknownEvent.fields.verification_post_count, 1);
  assert.equal(publishedResolutionUnknownEvent.fields.verification_anchor_present, false);
  assert.equal(
    publishedResolutionUnknownEvent.fields.last_verification_reason,
    "moments_publish_post_not_found"
  );
  assert.equal(publishedResolutionController.resolveUnknown({
    fingerprint: publishedResolutionUnknown.state.fingerprint,
    resolution: "published"
  }).ok, true);
  const publishedAgainChosen = await publishedResolutionController.chooseMedia([publishedResolutionImage]);
  const publishedAgain = await publishedResolutionController.prepare({
    selectionId: publishedAgainChosen.selection.selection_id,
    content: "人工确认正文 ABC123"
  });
  assert.equal(publishedAgain.reason, "moments_publish_fingerprint_already_published");

  const safeFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-safe-failure-"));
  const safeFailureImage = writeMedia(safeFailureRoot, "safe.jpg", Buffer.from("safe-image"));
  const safeFailureLock = makeCoordinator("safe-owner");
  let safeOpenCalls = 0;
  const safeFailureController = createMomentsPublishController({
    baseDir: safeFailureRoot,
    coordinator: safeFailureLock.coordinator,
    now: createClock(),
    openMoments: async ({ allowIntegrated, minIdleMs }) => {
      safeOpenCalls += 1;
      assert.equal(allowIntegrated, true);
      assert.equal(minIdleMs, 0, "safe pre-action failures remain retryable without a contradictory idle gate");
      return { ok: false, reason: "moments_window_open_timeout" };
    },
    publishDriver: async () => assert.fail("driver must not run when Moments could not be opened")
  });
  safeFailureController.initialize();
  const safePrepared = await prepareDraft(safeFailureController, [safeFailureImage], "点击前失败 ABC123");
  const safeFailure = await safeFailureController.confirm({ confirmationId: safePrepared.confirmation.confirmationId });
  assert.equal(safeFailure.ok, false);
  assert.equal(safeFailure.state.last_reason, "moments_window_open_timeout");
  assert.equal(safeFailure.state.last_stage, "moments_open");
  assert.equal(safeFailure.state.last_failure_kind, "navigation_result");
  assert.equal(safeFailure.actionAttempted, false);
  assert.equal(safeFailure.state.outcome_unknown, false);
  assert.equal(safeOpenCalls, 1, "a safe open timeout must not retry automatically");
  assert.equal(safeFailureLock.calls.release, 1);
  assert.equal(fs.readdirSync(path.join(safeFailureRoot, "publish_markers")).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(safeFailureRoot, "publish_staging")), []);
  assert.equal(safeFailure.state.draft_id, "", "a failed confirmation must be consumed");
  assert.equal(safeFailure.state.selection.media_count, 1, "a safe pre-action failure must retain valid media selection");
  const safeRetry = await safeFailureController.prepare({
    selectionId: safeFailure.state.selection.selection_id,
    content: "点击前失败 ABC123"
  });
  assert.equal(safeRetry.ok, true, "a safe failure must be retryable without selecting the same media again");
  assert.equal(safeFailureController.reset().ok, true);
  assert.equal(safeFailureController.status().state.status, "idle");

  const breadcrumbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-breadcrumb-"));
  const breadcrumbImage = writeMedia(breadcrumbRoot, "private-breadcrumb.jpg", Buffer.from("breadcrumb-image"));
  const breadcrumbContent = "breadcrumb private content ABC123";
  const sensitiveSentinel = "DO_NOT_PERSIST_PRIVATE_DRIVER_DETAIL";
  const breadcrumbEvents = [];
  const breadcrumbController = createMomentsPublishController({
    baseDir: breadcrumbRoot,
    coordinator: makeCoordinator("breadcrumb-owner").coordinator,
    now: createClock(),
    logger: {
      event: (domain, event, fields, options) => {
        breadcrumbEvents.push({ domain, event, fields, options });
      }
    },
    openMoments: async () => ({ ok: true, pid: 1, hWnd: 2 }),
    publishDriver: async () => ({
      ok: false,
      reason: "moments_publish_driver_failed",
      actionAttempted: false,
      stage: "file_dialog",
      failureKind: "powershell_exception",
      exceptionCategory: "InvalidOperation",
      exceptionType: "System.Management.Automation.MethodInvocationException",
      exceptionMessage: sensitiveSentinel,
      privatePath: breadcrumbImage,
      privateContent: breadcrumbContent,
      publishButtonSearch: [{
        phase: "settle",
        attempt: 2,
        frameWidth: 453,
        frameHeight: 703,
        scanTop: 562,
        visualCount: 1,
        ocrExactCount: 0,
        ocrMode: "skipped_visual_unique",
        visualCandidates: [{
          bounds: { left: 82, top: 624, width: 140, height: 38 },
          mode: "visual_green_action",
          greenRatio: 0.957,
          privateContent: sensitiveSentinel
        }],
        privateContent: sensitiveSentinel
      }]
    })
  });
  breadcrumbController.initialize();
  const breadcrumbPrepared = await prepareDraft(
    breadcrumbController,
    [breadcrumbImage],
    breadcrumbContent
  );
  const breadcrumbFailure = await breadcrumbController.confirm({
    confirmationId: breadcrumbPrepared.confirmation.confirmationId
  });
  assert.equal(breadcrumbFailure.ok, false);
  assert.equal(breadcrumbFailure.state.last_stage, "file_dialog");
  assert.equal(breadcrumbFailure.state.last_failure_kind, "powershell_exception");
  assert.equal(breadcrumbFailure.state.last_exception_category, "InvalidOperation");
  assert.equal(
    breadcrumbFailure.state.last_exception_type,
    "System.Management.Automation.MethodInvocationException"
  );
  const breadcrumbDiskText = fs.readFileSync(path.join(breadcrumbRoot, "publish-state.json"), "utf8");
  const breadcrumbDisk = JSON.parse(breadcrumbDiskText);
  assert.equal(breadcrumbDisk.last_stage, "file_dialog");
  assert.equal(breadcrumbDisk.attempts.at(-1).stage, "file_dialog");
  assert.equal(breadcrumbDisk.attempts.at(-1).failure_kind, "powershell_exception");
  assert.equal(
    breadcrumbDisk.attempts.at(-1).exception_type,
    "System.Management.Automation.MethodInvocationException"
  );
  const breadcrumbFailureEvent = breadcrumbEvents.find((entry) => entry.event === "publish.failed_before_action");
  assert.equal(breadcrumbFailureEvent.fields.stage, "file_dialog");
  assert.equal(breadcrumbFailureEvent.fields.failure_kind, "powershell_exception");
  assert.equal(breadcrumbFailureEvent.fields.exception_category, "InvalidOperation");
  assert.equal(
    breadcrumbFailureEvent.fields.exception_type,
    "System.Management.Automation.MethodInvocationException"
  );
  assert.deepEqual(breadcrumbFailureEvent.fields.button_search, [{
    phase: "settle",
    attempt: 2,
    frame_width: 453,
    frame_height: 703,
    scan_top: 562,
    visual_count: 1,
    ocr_exact_count: 0,
    ocr_mode: "skipped_visual_unique",
    visual_candidates: [{ left: 82, top: 624, width: 140, height: 38, green_ratio: 0.957 }]
  }]);
  for (const serialized of [breadcrumbDiskText, JSON.stringify(breadcrumbEvents)]) {
    assert.equal(serialized.includes(sensitiveSentinel), false);
    assert.equal(serialized.includes(breadcrumbImage), false);
    assert.equal(serialized.includes(breadcrumbContent), false);
  }

  const changedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-changed-"));
  const changedImage = writeMedia(changedRoot, "changed.jpg", Buffer.from("original"));
  const changedLock = makeCoordinator("changed-owner");
  let changedDriverCalls = 0;
  const changedController = createMomentsPublishController({
    baseDir: changedRoot,
    coordinator: changedLock.coordinator,
    now: createClock(),
    openMoments: async () => ({ ok: true }),
    publishDriver: async () => { changedDriverCalls += 1; return { ok: true, status: "verified" }; }
  });
  changedController.initialize();
  const changedPrepared = await prepareDraft(changedController, [changedImage], "媒体变化正文 ABC123");
  fs.writeFileSync(changedImage, "changed after prepare");
  const changed = await changedController.confirm({ confirmationId: changedPrepared.confirmation.confirmationId });
  assert.equal(changed.reason, "moments_publish_media_changed");
  assert.equal(changedDriverCalls, 0);
  assert.equal(changedLock.calls.acquire, 0);

  const persistFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-persist-failure-"));
  const persistFailureImage = writeMedia(persistFailureRoot, "persist.jpg", Buffer.from("persist-image"));
  const persistFailureLock = makeCoordinator("persist-failure-owner");
  let persistFailureOpenCalls = 0;
  let persistFailureDriverCalls = 0;
  const persistFailureController = createMomentsPublishController({
    baseDir: persistFailureRoot,
    coordinator: persistFailureLock.coordinator,
    now: createClock(),
    writeJsonAtomic: (file, value) => {
      if (value.status === "publishing") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return writeJsonAtomic(file, value);
    },
    openMoments: async () => { persistFailureOpenCalls += 1; return { ok: true }; },
    publishDriver: async () => { persistFailureDriverCalls += 1; return { ok: true, status: "verified" }; }
  });
  persistFailureController.initialize();
  const persistFailurePrepared = await prepareDraft(
    persistFailureController,
    [persistFailureImage],
    "持久化失败正文 ABC123"
  );
  const persistFailure = await persistFailureController.confirm({
    confirmationId: persistFailurePrepared.confirmation.confirmationId
  });
  assert.equal(persistFailure.ok, false);
  assert.equal(persistFailure.reason, "moments_publish_state_persist_failed");
  assert.equal(persistFailure.actionAttempted, false);
  assert.equal(persistFailure.state.status, "awaiting_confirmation");
  assert.equal(persistFailureLock.calls.acquire, 1);
  assert.equal(persistFailureLock.calls.release, 1, "a failed initial publishing persist must release the lock");
  assert.equal(persistFailureOpenCalls, 0);
  assert.equal(persistFailureDriverCalls, 0);
  assert.deepEqual(fs.readdirSync(path.join(persistFailureRoot, "publish_staging")), []);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(persistFailureRoot, "publish-state.json"), "utf8")).status,
    "awaiting_confirmation"
  );

  const restartNoMarkerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-restart-safe-"));
  const restartFingerprint = crypto.createHash("sha256").update("restart-safe").digest("hex");
  fs.writeFileSync(path.join(restartNoMarkerRoot, "publish-state.json"), JSON.stringify({
    status: "publishing",
    fingerprint: restartFingerprint,
    attempt_id: "restart-safe-attempt",
    marker_name: "restart-safe-attempt.json",
    attempts: [{
      attempt_id: "restart-safe-attempt",
      fingerprint: restartFingerprint,
      status: "publishing",
      marker_name: "restart-safe-attempt.json"
    }]
  }));
  let restartOpenCalls = 0;
  const restartNoMarkerController = createMomentsPublishController({
    baseDir: restartNoMarkerRoot,
    now: createClock(),
    openMoments: async () => { restartOpenCalls += 1; return { ok: true }; },
    publishDriver: async () => assert.fail("initialize must not invoke the driver")
  });
  const restartSafe = restartNoMarkerController.initialize();
  assert.equal(restartSafe.state.status, "outcome_unknown");
  assert.equal(restartSafe.state.action_attempted, true);
  assert.equal(restartSafe.state.outcome_unknown, true);
  assert.equal(restartSafe.state.last_reason, "moments_publish_restarted_during_publish");
  assert.equal(restartOpenCalls, 0);

  const restartMarkerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-restart-unknown-"));
  const restartMarkerDir = path.join(restartMarkerRoot, "publish_markers");
  fs.mkdirSync(restartMarkerDir, { recursive: true });
  const restartMarkerName = `${restartFingerprint}.restart-marker-attempt.json`;
  fs.writeFileSync(path.join(restartMarkerDir, restartMarkerName), "{}");
  fs.writeFileSync(path.join(restartMarkerRoot, "publish-state.json"), JSON.stringify({
    status: "publishing",
    fingerprint: restartFingerprint,
    attempt_id: "restart-marker-attempt",
    marker_name: restartMarkerName,
    attempts: [{
      attempt_id: "restart-marker-attempt",
      fingerprint: restartFingerprint,
      status: "publishing",
      marker_name: restartMarkerName
    }]
  }));
  const restartMarkerController = createMomentsPublishController({
    baseDir: restartMarkerRoot,
    now: createClock(),
    openMoments: async () => assert.fail("initialize must not touch WeChat"),
    publishDriver: async () => assert.fail("initialize must not invoke the driver")
  });
  const restartUnknown = restartMarkerController.initialize();
  assert.equal(restartUnknown.state.status, "outcome_unknown");
  assert.equal(restartUnknown.state.action_attempted, true);
  assert.equal(restartUnknown.state.outcome_unknown, true);

  const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-orphan-marker-"));
  const orphanMarkerDir = path.join(orphanRoot, "publish_markers");
  const orphanAttemptId = "12345678-1234-4abc-8def-1234567890ab";
  const orphanMarkerName = `${restartFingerprint}.${orphanAttemptId}.json`;
  fs.mkdirSync(orphanMarkerDir, { recursive: true });
  fs.writeFileSync(path.join(orphanRoot, "publish-state.json"), "{");
  fs.writeFileSync(path.join(orphanMarkerDir, orphanMarkerName), "{}");
  const orphanController = createMomentsPublishController({
    baseDir: orphanRoot,
    now: createClock(),
    openMoments: async () => assert.fail("orphan recovery must not touch WeChat"),
    publishDriver: async () => assert.fail("orphan recovery must not invoke the driver")
  });
  const orphanRecovered = orphanController.initialize();
  assert.equal(orphanRecovered.state.status, "outcome_unknown");
  assert.equal(orphanRecovered.state.last_reason, "moments_publish_orphan_marker_recovered");
  assert.equal(orphanRecovered.state.fingerprint, restartFingerprint);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(orphanRoot, "publish-state.json"), "utf8")).attempt_id,
    orphanAttemptId
  );
  assert.equal(orphanController.resolveUnknown({ resolution: "not_published" }).ok, true);
  assert.equal(fs.existsSync(path.join(orphanMarkerDir, orphanMarkerName)), false);

  const corruptPublishingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-corrupt-publishing-"));
  fs.writeFileSync(path.join(corruptPublishingRoot, "publish-state.json"), JSON.stringify({ status: "publishing" }));
  const corruptPublishingController = createMomentsPublishController({
    baseDir: corruptPublishingRoot,
    now: createClock(),
    openMoments: async () => assert.fail("corrupt publishing recovery must not touch WeChat"),
    publishDriver: async () => assert.fail("corrupt publishing recovery must not invoke the driver")
  });
  const corruptPublishing = corruptPublishingController.initialize();
  assert.equal(corruptPublishing.state.status, "outcome_unknown");
  assert.match(corruptPublishing.state.fingerprint, /^[a-f0-9]{64}$/u);
  assert.match(
    JSON.parse(fs.readFileSync(path.join(corruptPublishingRoot, "publish-state.json"), "utf8")).attempt_id,
    /^[a-f0-9-]{36}$/u
  );
  assert.equal(corruptPublishingController.resolveUnknown({ resolution: "not_published" }).ok, true);

  const restartPreparedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-restart-prepared-"));
  fs.writeFileSync(path.join(restartPreparedRoot, "publish-state.json"), JSON.stringify({
    status: "awaiting_confirmation",
    fingerprint: restartFingerprint,
    media_count: 1,
    media_type: "image",
    content_character_count: 12
  }));
  let restartPreparedOpenCalls = 0;
  const restartPreparedController = createMomentsPublishController({
    baseDir: restartPreparedRoot,
    now: createClock(),
    openMoments: async () => { restartPreparedOpenCalls += 1; return { ok: true }; },
    publishDriver: async () => assert.fail("initialize must not invoke the driver")
  });
  const expiredPrepared = restartPreparedController.initialize();
  assert.equal(expiredPrepared.state.status, "idle");
  assert.equal(expiredPrepared.state.draft_id, "");
  assert.equal(expiredPrepared.state.last_reason, "moments_publish_selection_expired");
  assert.equal(restartPreparedOpenCalls, 0);

  const disposeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-publish-dispose-"));
  const disposeImage = writeMedia(disposeRoot, "dispose.jpg", Buffer.from("dispose-image"));
  const disposeLock = makeCoordinator("dispose-owner");
  let driverStarted;
  const driverStartedPromise = new Promise((resolve) => { driverStarted = resolve; });
  let signalWasAborted = false;
  const disposeController = createMomentsPublishController({
    baseDir: disposeRoot,
    coordinator: disposeLock.coordinator,
    now: createClock(),
    openMoments: async () => ({ ok: true }),
    publishDriver: ({ signal }) => new Promise((resolve, reject) => {
      driverStarted();
      signal.addEventListener("abort", () => {
        signalWasAborted = true;
        const error = new Error("aborted by dispose");
        error.code = "moments_publish_aborted";
        reject(error);
      }, { once: true });
    })
  });
  disposeController.initialize();
  const disposePrepared = await prepareDraft(disposeController, [disposeImage], "退出中止正文 ABC123");
  const confirmPromise = disposeController.confirm({ confirmationId: disposePrepared.confirmation.confirmationId });
  assert.equal(
    disposeController.reset().reason,
    "moments_publish_already_running",
    "confirmation staging and execution must form one guarded operation"
  );
  assert.equal(
    (await disposeController.chooseMedia([disposeImage])).reason,
    "moments_publish_already_running"
  );
  await driverStartedPromise;
  await disposeController.dispose();
  const disposedResult = await confirmPromise;
  assert.equal(signalWasAborted, true);
  assert.equal(disposedResult.actionAttempted, false);
  assert.equal(disposeLock.calls.release, 1, "dispose must wait until the runtime lock is released");
  assert.deepEqual(fs.readdirSync(path.join(disposeRoot, "publish_staging")), []);
  assert.equal(disposeController.reset().reason, "moments_publish_disposed");

  for (const root of [
    verifiedRoot,
    unknownRoot,
    publishedResolutionRoot,
    safeFailureRoot,
    breadcrumbRoot,
    changedRoot,
    persistFailureRoot,
    restartNoMarkerRoot,
    restartMarkerRoot,
    orphanRoot,
    corruptPublishingRoot,
    restartPreparedRoot,
    disposeRoot
  ]) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("moments publish IPC self-check passed");
}

void main();
