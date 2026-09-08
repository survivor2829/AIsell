const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const {
  copyProductDetailRuntime,
  createReleaseDescriptor,
  isProductDetailPythonSource,
  resolveProductDetailBuild
} = require("./product-detail-release-runtime.cjs");
const {
  copyContentEngineRuntime,
  createReleaseDescriptor: createContentEngineReleaseDescriptor,
  isContentEnginePythonSource,
  resolveContentEngineBuild
} = require("./content-engine-release-runtime.cjs");
const {
  artifactTypeForEdition,
  copyRemotionRuntime,
  resolveRemotionRuntimeBuild
} = require("./build-remotion-runtime.cjs");

const desktopDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(desktopDir, "..");
const releaseDir = path.join(projectDir, "release");
const productBrand = require("../product-brand.json");
const PRODUCT_NAME = productBrand.displayName;
const electronDir = path.join(desktopDir, "node_modules", "electron", "dist");
const nativeLibDir = path.join(desktopDir, "rpa", "contact_sync", "libs");
const helper = path.join(nativeLibDir, "xiaoxi-contact-helper.exe");
const CONTACT_HELPER_SHA256 = "cbe4e98cace5d69cc395e0af21af9bd72aa59cc2a170772ac344e169e8bd3550";
const DATABASE_DECRYPTOR_NAME = "xiaoxi-db-decrypt.exe";
const DATABASE_DECRYPTOR_SHA256 = "2e6d190f3a0f33112cd4b7baeadea9947cb70688a94f3787a6be236287dc1815";
const NATIVE_LIBRARY_SHA256 = Object.freeze({
  "wx_key.dll": "f946ef8cb2a59bc03ce0b6ae0e22ed905a57e4c8228ed6b1c2b07fd54ecb9a05",
  "msvcp140.dll": "0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9",
  "vcruntime140.dll": "d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066",
  "vcruntime140_1.dll": "1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f"
});
const runtimeFiles = new Set(["ai-expert.json", "auto-reply-state.json", "auto-reply-diagnostics.jsonl", "contacts.json", "touch_task.json", "touch_task.json.bak", "run_logs.jsonl", "state.json", "deepseek-api-key.bin"]);
const databaseFilePattern = /\.(?:db(?:-wal|-shm)?|sqlite3?)$/i;
const PORTABLE_SELF_CHECK_TIMEOUT_MS = 600_000;

function isBlockedRuntimeFile(name) {
  const lower = String(name).toLowerCase();
  return runtimeFiles.has(lower) || lower.startsWith("auto-reply-diagnostics.jsonl.") || databaseFilePattern.test(lower);
}

function isBlockedEnvironmentFile(name) {
  const lower = String(name).toLowerCase();
  return lower === ".env" || lower.startsWith(".env.");
}

function sourceAllowed(source, edition) {
  const relative = path.relative(desktopDir, source).replaceAll("\\", "/");
  const name = path.basename(source);
  const lower = name.toLowerCase();
  if (isBlockedRuntimeFile(name) || isBlockedEnvironmentFile(name) || lower.endsWith(".py") || lower.endsWith(".pyc") || lower.includes("self_check")) return false;
  if (relative.includes("/__pycache__/") || relative.includes("/libs/") || /(?:dump_data|wechat-dump|wx_key\.dll)/i.test(name)) return false;
  if (edition !== "test" && relative.startsWith("src/main/") && ["active-touch-dev-ipc.cjs", "preload.dev.cjs"].includes(name)) return false;
  if (name.endsWith(".dev.cjs")) {
    const allowed = [
      "state_machine.dev.cjs",
      "wechat_window_driver.dev.cjs",
      "active_touch_cli.dev.cjs",
      "moments_visual_probe.dev.cjs",
      "moments_navigation.dev.cjs",
      "moments_surface_profile.dev.cjs",
      "moments_surface_evidence.dev.cjs",
      "moments_publish_driver.dev.cjs",
      "moments_dry_run.dev.cjs",
      "moments_dry_run_cli.dev.cjs",
      "moments_action.dev.cjs",
      "moments_action_cli.dev.cjs",
      "moments_action_driver.dev.cjs",
      "moments_comment_readback_proof.dev.cjs",
      "moments_visual_dry_run.dev.cjs",
      "moments_visual_action_driver.dev.cjs",
      "wechat_auto_reply_visual_driver.dev.cjs",
      "wechat_auto_reply_visual_send.dev.cjs"
    ];
    if (edition === "test") allowed.push(
      "preload.dev.cjs"
    );
    return allowed.includes(name);
  }
  return true;
}

function resolveInstalledPackage(packageName, fromDir) {
  const parts = packageName.split("/");
  let current = path.resolve(fromDir);
  while (true) {
    const candidate = path.join(current, "node_modules", ...parts);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Missing runtime package: ${packageName}`);
}

function copyRuntimePackageTree(packageName, appDir, fromDir = desktopDir, copied = new Map()) {
  const source = resolveInstalledPackage(packageName, fromDir);
  const existing = copied.get(packageName);
  if (existing) {
    if (existing !== source) throw new Error(`Conflicting runtime package versions: ${packageName}`);
    return;
  }
  copied.set(packageName, source);
  const target = path.join(appDir, "node_modules", ...packageName.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  const packageJson = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  for (const dependency of Object.keys(packageJson.dependencies || {})) {
    copyRuntimePackageTree(dependency, appDir, source, copied);
  }
}

function copyAppSource(appDir, edition) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.copyFileSync(path.join(desktopDir, "package.json"), path.join(appDir, "package.json"));
  fs.copyFileSync(path.join(desktopDir, "product-brand.json"), path.join(appDir, "product-brand.json"));
  fs.copyFileSync(path.join(desktopDir, "installer-targets.json"), path.join(appDir, "installer-targets.json"));
  const rendererSource = path.join(desktopDir, edition === "test" ? "dist-development" : "dist-pilot");
  if (!fs.existsSync(path.join(rendererSource, "build-edition.json"))) throw new Error(`Missing renderer build: ${rendererSource}`);
  fs.cpSync(rendererSource, path.join(appDir, "dist"), { recursive: true });
  for (const relative of ["rpa", path.join("src", "main"), path.join("src", "shared")]) {
    const source = path.join(desktopDir, relative);
    fs.cpSync(source, path.join(appDir, relative), {
      recursive: true,
      filter: (sourcePath) => sourceAllowed(sourcePath, edition)
    });
  }
  copyRuntimePackageTree("mammoth", appDir);
  const helperTarget = path.join(appDir, "rpa", "contact_sync", "xiaoxi-contact-helper.exe");
  fs.copyFileSync(helper, helperTarget);
  if (sha256(helperTarget) !== CONTACT_HELPER_SHA256) throw new Error("Packaged contact helper hash mismatch");
  const nativeLibTarget = path.join(appDir, "rpa", "contact_sync", "libs");
  fs.mkdirSync(nativeLibTarget, { recursive: true });
  for (const [name, expectedHash] of Object.entries(NATIVE_LIBRARY_SHA256)) {
    const target = path.join(nativeLibTarget, name);
    fs.copyFileSync(path.join(nativeLibDir, name), target);
    if (sha256(target) !== expectedHash) throw new Error(`Packaged ${name} hash mismatch`);
  }
  const databaseDecryptorTarget = path.join(nativeLibTarget, DATABASE_DECRYPTOR_NAME);
  fs.copyFileSync(path.join(nativeLibDir, DATABASE_DECRYPTOR_NAME), databaseDecryptorTarget);
  if (sha256(databaseDecryptorTarget) !== DATABASE_DECRYPTOR_SHA256) throw new Error(`Packaged ${DATABASE_DECRYPTOR_NAME} hash mismatch`);
}

function gitText(args) {
  const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function scanRelease(target) {
  const blocked = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        const lower = entry.name.toLowerCase();
        const relative = path.relative(target, file).replaceAll("\\", "/");
        const blockedPythonSource = lower.endsWith(".py")
          && !isProductDetailPythonSource(relative)
          && !isContentEnginePythonSource(relative);
        if (isBlockedRuntimeFile(entry.name) || isBlockedEnvironmentFile(entry.name) || lower === "python.exe" || blockedPythonSource || lower.includes("dump_data") || lower.includes("wechat-dump") || lower.includes("dt-ai-helper")) blocked.push(file);
        if (entry.isFile() && fs.statSync(file).size <= 5 * 1024 * 1024) {
          const content = fs.readFileSync(file, "utf8");
          if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(content)) blocked.push(file);
        }
      }
    }
  };
  visit(target);
  if (blocked.length) throw new Error(`Release contains blocked files or secrets:\n${blocked.join("\n")}`);
}

function resolveSidecarBuildRoot(environment = process.env) {
  const configured = String(environment.XIAOXI_SIDECAR_BUILD_ROOT || "").trim();
  return configured ? path.resolve(configured) : null;
}

function resolveRemotionRuntimeRoot(environment = process.env) {
  const configured = String(environment.XIAOXI_REMOTION_RUNTIME_ROOT || "").trim();
  return configured ? path.resolve(configured) : null;
}

function isCommercialDeliveryReady(sourceState) {
  return sourceState?.artifactType === "delivery"
    && sourceState.remotionRuntime?.manifest?.licenseRecord?.commercialConfirmed === true
    && sourceState.contentEngineRuntime?.manifest?.mediaTools?.licenseRecord?.useType === "commercial-delivery";
}

function assertBuildPreconditions(edition, {
  environment = process.env,
  sidecarBuildRoot = resolveSidecarBuildRoot(environment),
  remotionRuntimeRoot = resolveRemotionRuntimeRoot(environment)
} = {}) {
  if (!["test", "delivery"].includes(edition)) throw new Error(`Unsupported edition: ${edition}`);
  const artifactType = artifactTypeForEdition(edition, environment);
  if (!fs.existsSync(path.join(electronDir, "electron.exe"))) throw new Error("Electron portable runtime is missing; run npm ci first");
  if (!fs.existsSync(helper) || sha256(helper) !== CONTACT_HELPER_SHA256) throw new Error("Pinned contact helper is missing or has the wrong hash");
  for (const [name, expectedHash] of Object.entries(NATIVE_LIBRARY_SHA256)) {
    const file = path.join(nativeLibDir, name);
    if (!fs.existsSync(file) || sha256(file) !== expectedHash) throw new Error(`${name} is missing or has the wrong hash`);
  }
  const databaseDecryptor = path.join(nativeLibDir, DATABASE_DECRYPTOR_NAME);
  if (!fs.existsSync(databaseDecryptor) || sha256(databaseDecryptor) !== DATABASE_DECRYPTOR_SHA256) {
    throw new Error(`${DATABASE_DECRYPTOR_NAME} is missing or has the wrong hash`);
  }

  const productDetailRuntime = resolveProductDetailBuild(desktopDir, { buildRoot: sidecarBuildRoot });
  const contentEngineRuntime = resolveContentEngineBuild(desktopDir, { buildRoot: sidecarBuildRoot });
  const remotionRuntime = resolveRemotionRuntimeBuild(desktopDir, artifactType, { runtimeRoot: remotionRuntimeRoot });

  const commit = gitText(["rev-parse", "HEAD"]);
  const dirty = Boolean(gitText(["status", "--porcelain"]));
  if (dirty) throw new Error("Refusing to build a portable release from a dirty worktree");

  const sourceState = {
    artifactType,
    commit,
    dirty,
    productDetailRuntime,
    contentEngineRuntime,
    remotionRuntime,
    sidecarBuildRoot,
    remotionRuntimeRoot
  };
  if (artifactType === "delivery" && !isCommercialDeliveryReady(sourceState)) {
    throw new Error("Delivery requires commercial Remotion and media-tools release evidence");
  }
  return sourceState;
}

function buildPortableStaging(edition, paths, sourceState) {
  const productName = edition === "test" ? `${PRODUCT_NAME}-测试版` : PRODUCT_NAME;
  const { target, zip, archiveBaseDir } = paths;
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.cpSync(electronDir, target, { recursive: true });
  const electronExe = path.join(target, "electron.exe");
  fs.renameSync(electronExe, path.join(target, `${productName}.exe`));
  // Installers consume this prepackaged executable, so stamp its icon here.
  const iconResult = spawnSync(require.resolve("electron-winstaller/vendor/rcedit.exe"), [
    path.join(target, `${productName}.exe`), "--set-icon", path.join(desktopDir, "public", "app-icon.ico")
  ], { encoding: "utf8", windowsHide: true });
  if (iconResult.status !== 0) {
    throw new Error(iconResult.error?.message || iconResult.stderr || "Failed to embed application icon");
  }
  const appDir = path.join(target, "resources", "app");
  fs.rmSync(appDir, { recursive: true, force: true });
  copyAppSource(appDir, edition);
  const packagedBuildInfoFile = path.join(appDir, "dist", "build-edition.json");
  const packagedBuildInfo = JSON.parse(fs.readFileSync(packagedBuildInfoFile, "utf8"));
  fs.writeFileSync(packagedBuildInfoFile, `${JSON.stringify({
    ...packagedBuildInfo,
    artifactType: sourceState.artifactType
  }, null, 2)}\n`, "utf8");
  copyProductDetailRuntime(sourceState.productDetailRuntime, target);
  copyContentEngineRuntime(sourceState.contentEngineRuntime, target);
  const remotionRuntime = copyRemotionRuntime(sourceState.remotionRuntime, target);

  const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
  const electronPackage = JSON.parse(fs.readFileSync(path.join(desktopDir, "node_modules", "electron", "package.json"), "utf8"));
  const rendererMarker = JSON.parse(fs.readFileSync(path.join(desktopDir, edition === "test" ? "dist-development" : "dist-pilot", "build-edition.json"), "utf8"));
  const capabilityMatrix = JSON.parse(fs.readFileSync(path.join(desktopDir, "release-capabilities.json"), "utf8"));
  const contentEngineSidecar = createContentEngineReleaseDescriptor(
    sourceState.contentEngineRuntime,
    sourceState.commit,
    sourceState.artifactType
  );
  contentEngineSidecar.treeSha256 = treeSha256(path.join(target, "resources", "content-engine"));
  const manifest = {
    product: PRODUCT_NAME,
    edition,
    artifactType: sourceState.artifactType,
    version: packageJson.version,
    buildId: String(rendererMarker.buildId || ""),
    commit: sourceState.commit,
    dirty: sourceState.dirty,
    sourceTreeSha256: treeSha256(appDir),
    architecture: process.arch,
    electron: electronPackage.version,
    contactHelperSha256: CONTACT_HELPER_SHA256,
    wxKeySha256: NATIVE_LIBRARY_SHA256["wx_key.dll"],
    databaseDecryptorSha256: DATABASE_DECRYPTOR_SHA256,
    nativeLibrarySha256: NATIVE_LIBRARY_SHA256,
    productDetailSidecar: createReleaseDescriptor(
      sourceState.productDetailRuntime,
      sourceState.commit
    ),
    contentEngineSidecar,
    remotionRuntime,
    targetWeixin: capabilityMatrix.targetWeixin,
    capabilityMatrix: capabilityMatrix.capabilities,
    releaseStage: "wechat-4.1.11.55-integrated-moments-adaptation",
    commercialReady: isCommercialDeliveryReady(sourceState),
    builtAt: new Date().toISOString(),
    signed: false
  };
  fs.writeFileSync(path.join(target, "版本清单.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(target, "版本标识.txt"), edition === "test"
    ? `${PRODUCT_NAME} 测试版 ${manifest.buildId}\n制品类型：internal-evaluation（仅限内部评估，不可包装为商业安装程序）。\n朋友圈逐帖互动已完成本机验收；每日自动计划已实现但仍待真实计时验收。\n`
    : `${PRODUCT_NAME} ${manifest.buildId}\n制品类型：${manifest.artifactType}；${manifest.commercialReady ? "其 Remotion 与浏览器许可依据见受信清单摘要。" : "内部试用覆盖升级，保留原软件身份；不代表商用就绪。"}\n当前功能验收状态以版本清单中的 capabilityMatrix 为准；朋友圈逐帖互动已进入本包，每日自动计划仍待真实计时与异机验收，本包不代表完整商品。\n`, "utf8");
  fs.writeFileSync(path.join(target, "首次使用说明.txt"), [
    `${PRODUCT_NAME} ${edition === "test" ? "测试版" : ""} ${manifest.buildId}`.trim(),
    "",
    "1. 使用安装程序可覆盖升级原软件并保留本地数据。若使用 ZIP，请完整解压到全新目录；不要手工覆盖旧目录，也不要只复制 EXE。",
    "2. 当前阶段适配 Windows 10/11 x64 和个人微信 Weixin.exe 4.1.11.55；微信与本软件请使用相同权限运行。朋友圈新版内嵌布局仍需按交付清单完成实机验收。",
    "3. 每台新电脑首次使用都要重新配置 API 密钥、导入 AI 专家话术并同步联系人；这些本地数据不会写入 ZIP。",
    "4. 同步联系人时软件会重启微信，请按提示重新登录。若路径未自动识别，可在同步联系人页手动选择 Weixin.exe 和 xwechat_files。",
    "5. 演示顺序：同步联系人 -> 导入 AI 专家并配置 API 密钥 -> 自动回复 -> 主动触达 -> 朋友圈点赞评论。",
    "6. 若助手或 DLL 被 Defender 隔离，请先核对版本清单与 ZIP 哈希，再在 Windows 安全中心查看隔离记录。",
    "",
    `界面和版本清单中的构建编号应当都是：${manifest.buildId}`
  ].join("\n") + "\n", "utf8");
  scanRelease(target);

  const archive = spawnSync("tar.exe", ["-a", "-c", "-f", zip, "-C", archiveBaseDir, productName], { encoding: "utf8", windowsHide: true });
  if (archive.status !== 0 || !fs.existsSync(zip)) throw new Error(archive.stderr || archive.stdout || "portable ZIP creation failed");
  return { target, zip, manifest };
}

function assertContained(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`) || resolvedTarget === resolvedRoot) {
    throw new Error(`Release transaction path is outside its root: ${target}`);
  }
}

function cleanupPaths(paths, label) {
  const errors = [];
  for (const target of paths) {
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      errors.push(new Error(`${label} cleanup failed for ${target}: ${error.message}`, { cause: error }));
    }
  }
  return errors;
}

function runCleanup(cleanup, paths, label) {
  try {
    const errors = cleanup(paths, label);
    return Array.isArray(errors) ? errors : [];
  } catch (error) {
    return [new Error(`${label} cleanup failed: ${error.message}`, { cause: error })];
  }
}

function combineErrors(primary, secondary, message) {
  if (!secondary.length) return primary;
  return new AggregateError([primary, ...secondary].filter(Boolean), message);
}

function publishStagedRelease({
  releaseRoot,
  canonicalTarget,
  canonicalZip,
  stagingTarget,
  stagingZip,
  transactionId
}) {
  for (const target of [canonicalTarget, canonicalZip, stagingTarget, stagingZip]) assertContained(releaseRoot, target);
  const backupTarget = path.join(releaseRoot, `.backup-target-${transactionId}`);
  const backupZip = path.join(releaseRoot, `.backup-zip-${transactionId}`);
  assertContained(releaseRoot, backupTarget);
  assertContained(releaseRoot, backupZip);
  let targetBackedUp = false;
  let zipBackedUp = false;
  let targetPublished = false;
  let zipPublished = false;

  try {
    if (fs.existsSync(canonicalTarget)) {
      fs.renameSync(canonicalTarget, backupTarget);
      targetBackedUp = true;
    }
    if (fs.existsSync(canonicalZip)) {
      fs.renameSync(canonicalZip, backupZip);
      zipBackedUp = true;
    }
    fs.renameSync(stagingTarget, canonicalTarget);
    targetPublished = true;
    fs.renameSync(stagingZip, canonicalZip);
    zipPublished = true;
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (zipPublished && fs.existsSync(canonicalZip)) fs.rmSync(canonicalZip, { force: true });
      if (zipBackedUp && fs.existsSync(backupZip)) fs.renameSync(backupZip, canonicalZip);
    } catch (rollbackError) {
      rollbackErrors.push(new Error(`ZIP rollback failed: ${rollbackError.message}`, { cause: rollbackError }));
    }
    try {
      if (targetPublished && fs.existsSync(canonicalTarget)) fs.rmSync(canonicalTarget, { recursive: true, force: true });
      if (targetBackedUp && fs.existsSync(backupTarget)) fs.renameSync(backupTarget, canonicalTarget);
    } catch (rollbackError) {
      rollbackErrors.push(new Error(`directory rollback failed: ${rollbackError.message}`, { cause: rollbackError }));
    }
    throw combineErrors(error, rollbackErrors, "Release publish failed and rollback was incomplete");
  }

  return {
    published: true,
    cleanupWarnings: [],
    retainedBackups: [
      ...(targetBackedUp ? [backupTarget] : []),
      ...(zipBackedUp ? [backupZip] : [])
    ]
  };
}

function runTransactionalRelease({
  releaseRoot,
  stagingRoot,
  stagingTarget,
  stagingZip,
  canonicalTarget,
  canonicalZip,
  transactionId,
  preflight,
  prepare,
  validate,
  cleanup = cleanupPaths
}) {
  for (const target of [stagingRoot, stagingTarget, stagingZip, canonicalTarget, canonicalZip]) assertContained(releaseRoot, target);
  const sourceState = preflight();
  let result;
  let publishResult = { published: false, cleanupWarnings: [], retainedBackups: [] };
  let primaryError = null;
  try {
    fs.mkdirSync(releaseRoot, { recursive: true });
    fs.mkdirSync(stagingRoot, { recursive: false });
    result = prepare(sourceState);
    validate(result);
    publishResult = publishStagedRelease({
      releaseRoot,
      canonicalTarget,
      canonicalZip,
      stagingTarget,
      stagingZip,
      transactionId
    });
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = runCleanup(cleanup, [stagingRoot], "release staging");
  if (primaryError) throw combineErrors(primaryError, cleanupErrors, "Release build failed and staging cleanup was incomplete");
  const cleanupWarnings = [
    ...publishResult.cleanupWarnings,
    ...cleanupErrors.map((error) => error.message)
  ];
  return {
    ...result,
    target: canonicalTarget,
    zip: canonicalZip,
    published: publishResult.published,
    cleanupWarnings,
    retainedBackups: publishResult.retainedBackups
  };
}

function runPortableSelfCheck(edition, target, zip) {
  const check = spawnSync(process.execPath, [
    path.join(__dirname, "portable-release.self_check.cjs"),
    edition,
    "--target",
    target,
    "--zip",
    zip
  ], { cwd: desktopDir, encoding: "utf8", windowsHide: true, timeout: PORTABLE_SELF_CHECK_TIMEOUT_MS });
  if (check.status !== 0) throw new Error(check.stderr || check.stdout || "portable release self-check failed");
  if (String(check.stderr || "").trim()) {
    console.warn(`portable release self-check warning:\n${String(check.stderr).trim()}`);
  }
}

function buildPortable(edition = "delivery", {
  environment = process.env,
  sidecarBuildRoot = resolveSidecarBuildRoot(environment),
  remotionRuntimeRoot = resolveRemotionRuntimeRoot(environment)
} = {}) {
  if (!["test", "delivery"].includes(edition)) throw new Error(`Unsupported edition: ${edition}`);
  const productName = edition === "test" ? `${PRODUCT_NAME}-测试版` : PRODUCT_NAME;
  const transactionId = `${process.pid}-${Date.now()}-${process.hrtime.bigint().toString(36)}`;
  const stagingRoot = path.join(releaseDir, `.staging-${edition}-${transactionId}`);
  const stagingTarget = path.join(stagingRoot, productName);
  const stagingZip = path.join(stagingRoot, `${productName}.zip`);
  const canonicalTarget = path.join(releaseDir, productName);
  const canonicalZip = path.join(releaseDir, `${productName}.zip`);
  const result = runTransactionalRelease({
    releaseRoot: releaseDir,
    stagingRoot,
    stagingTarget,
    stagingZip,
    canonicalTarget,
    canonicalZip,
    transactionId,
    preflight: () => assertBuildPreconditions(edition, { environment, sidecarBuildRoot, remotionRuntimeRoot }),
    prepare: (sourceState) => buildPortableStaging(edition, {
      target: stagingTarget,
      zip: stagingZip,
      archiveBaseDir: stagingRoot
    }, sourceState),
    validate: () => {
      scanRelease(stagingTarget);
      runPortableSelfCheck(edition, stagingTarget, stagingZip);
    }
  });
  for (const warning of result.cleanupWarnings || []) {
    console.warn(`release cleanup warning: ${warning}`);
  }
  for (const backup of result.retainedBackups || []) {
    console.warn(`release rollback artifact retained: ${backup}`);
  }
  console.log(`${edition} portable release built: ${result.zip}`);
  return result;
}

if (require.main === module) buildPortable(process.argv[2] || "delivery");

module.exports = {
  PORTABLE_SELF_CHECK_TIMEOUT_MS,
  assertBuildPreconditions,
  buildPortable,
  cleanupPaths,
  copyRuntimePackageTree,
  isCommercialDeliveryReady,
  publishStagedRelease,
  runTransactionalRelease,
  resolveRemotionRuntimeRoot,
  resolveSidecarBuildRoot,
  scanRelease,
  sourceAllowed,
  treeSha256
};
