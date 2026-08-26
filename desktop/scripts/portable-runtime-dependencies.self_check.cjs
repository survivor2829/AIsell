const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ARTIFACT_TYPES,
  artifactTypeForEdition,
  buildRemotionRuntime,
  copyRemotionRuntime,
  readPackageState,
  resolveLockClosure,
  validateLicenseRecord,
  verifyCurrentRuntimeSources,
  verifyPackagedRemotionRuntime,
  verifyRemotionRuntime
} = require("./build-remotion-runtime.cjs");
const { copyRuntimePackageTree } = require("./build-portable-release.cjs");
const { treeSha256 } = require("./release-tree-hash.cjs");
const { verifyPackagedRuntime } = require("../src/main/remotion-runtime-environment.cjs");

const desktopDir = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-portable-dependencies-"));

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fixtureLicenseRecord(browserHash) {
  return {
    schemaVersion: 1,
    useType: "internal-evaluation",
    entity: {
      name: "Self-check fixture only",
      type: "individual",
      employeeCount: null,
      employeeCountAsOf: null,
      licenseBasis: "evaluation",
      evidenceReference: "self-check-fixture"
    },
    remotion: {
      version: "4.0.512",
      usage: "non-commercial-internal-evaluation",
      confirmedBy: "self-check-fixture",
      confirmedDate: "2026-08-15"
    },
    browser: {
      product: "Self-check browser fixture",
      version: "0.0.0-fixture",
      source: "generated self-check fixture",
      sourceUrl: "https://example.invalid/self-check-browser",
      sha256: browserHash,
      terms: "Self-check fixture terms only",
      termsUrl: "https://example.invalid/self-check-browser-terms",
      internalRedistributionBasis: "Self-check fixture; not a real redistribution authorization",
      commercialRedistributionBasis: "",
      confirmedBy: "self-check-fixture",
      confirmedDate: "2026-08-15"
    }
  };
}

async function main() {
  try {
    copyRuntimePackageTree("mammoth", root);
    const packagedMammoth = path.join(root, "node_modules", "mammoth");
    const mammoth = require(packagedMammoth);
    assert.equal(typeof mammoth.extractRawText, "function");
    const fixture = path.join(packagedMammoth, "test", "test-data", "single-paragraph.docx");
    const extracted = await mammoth.extractRawText({ path: fixture });
    assert.ok(extracted.value.trim(), "the copied dependency closure must extract a real DOCX");

    assert.deepEqual(ARTIFACT_TYPES, ["development", "internal-evaluation", "delivery"]);
    assert.equal(artifactTypeForEdition("test"), "internal-evaluation");
    assert.equal(artifactTypeForEdition("delivery"), "delivery");
    assert.throws(() => artifactTypeForEdition("preview"), /Unsupported portable edition/u);

    const packageState = readPackageState(desktopDir);
    assert.equal(packageState.packageJson.dependencies.remotion, "4.0.512");
    assert.equal(packageState.packageJson.dependencies["@remotion/renderer"], "4.0.512");
    assert.equal(packageState.packageJson.dependencies.react, "18.3.1");
    assert.equal(packageState.packageJson.dependencies["react-dom"], "18.3.1");
    assert.equal(packageState.packageJson.devDependencies["@remotion/bundler"], "4.0.512");

    const runtimeClosure = resolveLockClosure(packageState.packageLock, "runtime");
    const builderClosure = resolveLockClosure(packageState.packageLock, "builder");
    assert.equal(runtimeClosure.some((item) => item.name === "@remotion/compositor-win32-x64-msvc" && item.version === "4.0.512"), true);
    assert.equal(builderClosure.some((item) => item.name === "@rspack/binding-win32-x64-msvc" && item.version === "1.7.11"), true);
    assert.equal(builderClosure.some((item) => item.name === "@esbuild/win32-x64" && item.version === "0.28.1"), true);
    assert.equal(runtimeClosure.some((item) => item.name === "@remotion/compositor-linux-x64-gnu"), false);
    assert.equal(runtimeClosure.some((item) => item.name === "@remotion/bundler" || item.name === "@rspack/core" || item.name === "esbuild"), false);

    assert.throws(() => validateLicenseRecord(null, "delivery"), /license record is required/u);
    assert.throws(
      () => validateLicenseRecord(fixtureLicenseRecord("0".repeat(64)), "delivery"),
      /commercial/u
    );

    const browserSourceRoot = path.join(root, "browser-source");
    const browser = path.join(browserSourceRoot, "chrome.exe");
    fs.mkdirSync(path.join(browserSourceRoot, "locales"), { recursive: true });
    fs.writeFileSync(browser, "self-check browser fixture\n", "utf8");
    fs.writeFileSync(path.join(browserSourceRoot, "chrome.dll"), "self-check browser runtime dependency\n", "utf8");
    fs.writeFileSync(path.join(browserSourceRoot, "locales", "en-US.pak"), "self-check browser locale\n", "utf8");
    const licenseRecord = fixtureLicenseRecord(sha256(browser));
    const licenseRecordFile = path.join(root, "license-record.json");
    fs.writeFileSync(licenseRecordFile, `${JSON.stringify(licenseRecord, null, 2)}\n`, "utf8");
    const mismatchedRecordFile = path.join(root, "license-record-mismatched.json");
    fs.writeFileSync(mismatchedRecordFile, `${JSON.stringify(fixtureLicenseRecord("0".repeat(64)), null, 2)}\n`, "utf8");
    await assert.rejects(
      buildRemotionRuntime({
        artifactType: "internal-evaluation",
        browserPath: browser,
        desktopDir,
        licenseRecordPath: mismatchedRecordFile,
        outputDir: path.join(root, "must-not-build"),
        skipCompositionSmoke: true
      }),
      /Browser hash does not match/u
    );
    const runtimeOutput = path.join(root, "runtime-output");
    const build = await buildRemotionRuntime({
      artifactType: "internal-evaluation",
      browserPath: browser,
      desktopDir,
      licenseRecordPath: licenseRecordFile,
      outputDir: runtimeOutput,
      skipCompositionSmoke: true
    });
    assert.equal(build.manifest.artifactType, "internal-evaluation");
    assert.equal(build.manifest.browser.packaged, true);
    assert.equal(build.manifest.browser.sha256, sha256(browser));
    assert.equal(build.manifest.browser.treeSha256, treeSha256(browserSourceRoot));
    assert.equal(treeSha256(path.join(runtimeOutput, "browser")), build.manifest.browser.treeSha256);
    assert.equal(build.manifest.compositionSmoke.status, "not-run");
    assert.doesNotThrow(() => verifyRemotionRuntime(runtimeOutput, {
      desktopDir,
      expectedArtifactType: "internal-evaluation"
    }));
    const sourceFixture = path.join(root, "source-fixture");
    fs.mkdirSync(path.join(sourceFixture, "src", "main"), { recursive: true });
    fs.mkdirSync(path.join(sourceFixture, "remotion-packaging"), { recursive: true });
    for (const name of ["package.json", "package-lock.json"]) {
      fs.copyFileSync(path.join(desktopDir, name), path.join(sourceFixture, name));
    }
    fs.copyFileSync(
      path.join(desktopDir, "src", "main", "remotion-render-worker.mjs"),
      path.join(sourceFixture, "src", "main", "remotion-render-worker.mjs")
    );
    for (const name of Object.keys(build.manifest.packagingAssets.files)) {
      fs.copyFileSync(path.join(desktopDir, "remotion-packaging", name), path.join(sourceFixture, "remotion-packaging", name));
    }
    assert.doesNotThrow(() => verifyCurrentRuntimeSources(build.manifest, sourceFixture));
    fs.appendFileSync(path.join(sourceFixture, "remotion-packaging", "root.tsx"), "// source drift\n", "utf8");
    assert.throws(() => verifyCurrentRuntimeSources(build.manifest, sourceFixture), /source drift.*rebuild/u);
    for (const [file, pattern] of [
      [path.join(runtimeOutput, "remotion-bundle", "index.html"), /bundle hash mismatch/u],
      [path.join(runtimeOutput, "node_modules", "@remotion", "compositor-win32-x64-msvc", "remotion.exe"), /package hash mismatch/u],
      [path.join(runtimeOutput, "browser", "chrome.exe"), /Browser hash mismatch/u],
      [path.join(runtimeOutput, "browser", "locales", "en-US.pak"), /Browser runtime tree hash mismatch/u],
      [path.join(runtimeOutput, "runtime-manifest.json"), /manifest hash mismatch/u]
    ]) {
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, "tampered", "utf8");
      assert.throws(() => verifyRemotionRuntime(runtimeOutput, {
        desktopDir,
        expectedArtifactType: "internal-evaluation"
      }), pattern);
      fs.writeFileSync(file, original);
    }

    const releaseTarget = path.join(root, "portable-fixture");
    fs.mkdirSync(path.join(releaseTarget, "resources", "content-engine"), { recursive: true });
    const descriptor = copyRemotionRuntime(build, releaseTarget);
    assert.equal(descriptor.artifactType, "internal-evaluation");
    assert.equal(descriptor.browserTreeSha256, build.manifest.browser.treeSha256);
    assert.equal(treeSha256(path.join(releaseTarget, "resources", "content-engine", "browser")), descriptor.browserTreeSha256);
    assert.doesNotThrow(() => verifyPackagedRemotionRuntime(releaseTarget, descriptor));
    fs.writeFileSync(path.join(releaseTarget, "版本清单.json"), JSON.stringify({
      artifactType: "internal-evaluation",
      remotionRuntime: descriptor
    }));
    assert.doesNotThrow(() => verifyPackagedRuntime(path.join(releaseTarget, "resources")));
    const packagedBrowserDependency = path.join(releaseTarget, "resources", "content-engine", "browser", "chrome.dll");
    const originalBrowserDependency = fs.readFileSync(packagedBrowserDependency);
    fs.appendFileSync(packagedBrowserDependency, "tampered", "utf8");
    assert.throws(() => verifyPackagedRemotionRuntime(releaseTarget, descriptor), /browser runtime tree hash mismatch/u);
    assert.throws(() => verifyPackagedRuntime(path.join(releaseTarget, "resources")), /browser runtime tree hash mismatch/u);
    fs.writeFileSync(packagedBrowserDependency, originalBrowserDependency);
    const packagedWorker = path.join(releaseTarget, "resources", "content-engine", "remotion-render-worker.mjs");
    fs.appendFileSync(packagedWorker, "// tampered\n", "utf8");
    assert.throws(() => verifyPackagedRemotionRuntime(releaseTarget, descriptor), /worker hash mismatch/u);

    console.log("portable runtime dependencies self-check passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
