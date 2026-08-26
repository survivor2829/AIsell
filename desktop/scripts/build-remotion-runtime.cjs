const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");

const ARTIFACT_TYPES = Object.freeze(["development", "internal-evaluation", "delivery"]);
const REMOTION_VERSION = "4.0.512";
const REACT_VERSION = "18.3.1";
const RUNTIME_ROOT_KEYS = Object.freeze([
  "node_modules/@remotion/renderer",
  "node_modules/remotion",
  "node_modules/react",
  "node_modules/react-dom"
]);
const BUILDER_ROOT_KEYS = Object.freeze([
  "node_modules/@remotion/bundler",
  ...RUNTIME_ROOT_KEYS
]);
const PACKAGING_FILES = Object.freeze([
  "contract.cjs",
  "effect-registry.json",
  "index.ts",
  "layout-grid.json",
  "root.tsx",
  "style-packs.json",
  "types.ts",
  "video-template.tsx",
  "LICENSES.md",
  "runtime-license-record.schema.json",
  "runtime-license-record.template.json"
]);
const WORKER_CONTRACT_FILES = Object.freeze([
  "contract.cjs",
  "effect-registry.json",
  "layout-grid.json",
  "style-packs.json"
]);
const SOUND_FILES = Object.freeze(["sfx-click.wav", "sfx-pop.wav", "sfx-whoosh.wav"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const URL_PATTERN = /^https:\/\/\S+$/u;

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} is missing: ${file}`);
  }
  return file;
}

function assertDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} is missing: ${directory}`);
  }
  return directory;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function artifactTypeForEdition(edition) {
  if (edition === "test") return "internal-evaluation";
  if (edition === "delivery") return "delivery";
  throw new Error(`Unsupported portable edition: ${edition}`);
}

function readPackageState(desktopDir) {
  const root = path.resolve(desktopDir);
  const packageJsonFile = path.join(root, "package.json");
  const packageLockFile = path.join(root, "package-lock.json");
  const packageJson = readJson(packageJsonFile, "package.json");
  const packageLock = readJson(packageLockFile, "package-lock.json");
  if (packageLock.lockfileVersion !== 3 || !packageLock.packages?.[""]) {
    throw new Error("Remotion runtime requires an npm lockfileVersion 3 package map");
  }
  const exact = {
    "@remotion/renderer": REMOTION_VERSION,
    remotion: REMOTION_VERSION,
    react: REACT_VERSION,
    "react-dom": REACT_VERSION
  };
  for (const [name, version] of Object.entries(exact)) {
    if (packageJson.dependencies?.[name] !== version || packageLock.packages[""].dependencies?.[name] !== version) {
      throw new Error(`${name} must be an exact runtime dependency at ${version}`);
    }
  }
  if (
    packageJson.devDependencies?.["@remotion/bundler"] !== REMOTION_VERSION
    || packageLock.packages[""].devDependencies?.["@remotion/bundler"] !== REMOTION_VERSION
  ) {
    throw new Error(`@remotion/bundler must be pinned exactly to ${REMOTION_VERSION}`);
  }
  return {
    packageJson,
    packageJsonFile,
    packageLock,
    packageLockFile
  };
}

function packageNameFromLockKey(lockKey) {
  const marker = "node_modules/";
  const index = lockKey.lastIndexOf(marker);
  if (index < 0) throw new Error(`Invalid package-lock path: ${lockKey}`);
  return lockKey.slice(index + marker.length);
}

function compatibleWithWindowsX64(entry) {
  return (!entry.os || entry.os.includes("win32")) && (!entry.cpu || entry.cpu.includes("x64"));
}

function resolveDependencyLockKey(packages, parentKey, dependency) {
  let current = parentKey;
  while (current) {
    const nested = `${current}/node_modules/${dependency}`;
    if (packages[nested]) return nested;
    const index = current.lastIndexOf("/node_modules/");
    if (index < 0) break;
    current = current.slice(0, index);
  }
  const root = `node_modules/${dependency}`;
  return packages[root] ? root : null;
}

function resolveLockClosure(packageLock, role) {
  if (!new Set(["runtime", "builder"]).has(role)) throw new Error(`Unknown Remotion closure role: ${role}`);
  const packages = packageLock?.packages;
  if (!packages) throw new Error("package-lock packages map is missing");
  const roots = role === "runtime" ? RUNTIME_ROOT_KEYS : BUILDER_ROOT_KEYS;
  const queue = [...roots];
  const visited = new Set();
  while (queue.length) {
    const lockKey = queue.shift();
    if (visited.has(lockKey)) continue;
    const entry = packages[lockKey];
    if (!entry) throw new Error(`Pinned ${role} package is missing from package-lock: ${lockKey}`);
    if (!compatibleWithWindowsX64(entry)) continue;
    visited.add(lockKey);
    for (const dependency of Object.keys(entry.dependencies || {}).sort()) {
      const dependencyKey = resolveDependencyLockKey(packages, lockKey, dependency);
      if (!dependencyKey) throw new Error(`Locked dependency ${dependency} required by ${lockKey} is missing`);
      queue.push(dependencyKey);
    }
    for (const dependency of Object.keys(entry.optionalDependencies || {}).sort()) {
      const dependencyKey = resolveDependencyLockKey(packages, lockKey, dependency);
      if (dependencyKey && compatibleWithWindowsX64(packages[dependencyKey])) queue.push(dependencyKey);
    }
  }
  const closure = [...visited].sort().map((lockKey) => ({
    integrity: packageLock.packages[lockKey].integrity || null,
    lockPath: lockKey,
    name: packageNameFromLockKey(lockKey),
    version: String(packageLock.packages[lockKey].version || "")
  }));
  for (const item of closure) {
    if ((item.name === "remotion" || item.name.startsWith("@remotion/")) && item.version !== REMOTION_VERSION) {
      throw new Error(`Remotion package version drift: ${item.name}@${item.version}`);
    }
  }
  const expected = role === "runtime"
    ? [["@remotion/compositor-win32-x64-msvc", REMOTION_VERSION]]
    : [["@rspack/binding-win32-x64-msvc", null], ["@esbuild/win32-x64", null]];
  for (const [name, version] of expected) {
    if (!closure.some((item) => item.name === name && (!version || item.version === version))) {
      throw new Error(`${role} closure is missing the installed Windows x64 package ${name}`);
    }
  }
  return closure;
}

function nonEmpty(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function validDate(value, label) {
  const normalized = nonEmpty(value, label);
  if (!DATE_PATTERN.test(normalized) || !Number.isFinite(Date.parse(`${normalized}T00:00:00Z`))) {
    throw new Error(`${label} must be a YYYY-MM-DD date`);
  }
  return normalized;
}

function validUrl(value, label) {
  const normalized = nonEmpty(value, label);
  if (!URL_PATTERN.test(normalized)) throw new Error(`${label} must be an explicit HTTPS URL`);
  return normalized;
}

function validateLicenseRecord(record, artifactType) {
  if (!ARTIFACT_TYPES.includes(artifactType)) throw new Error(`Unsupported Remotion artifact type: ${artifactType}`);
  if (!record) {
    if (artifactType === "development") return null;
    throw new Error(`A versioned Remotion/browser license record is required for ${artifactType}`);
  }
  assertExactKeys(record, ["schemaVersion", "useType", "entity", "remotion", "browser"], "license record");
  assertExactKeys(record.entity, ["name", "type", "employeeCount", "employeeCountAsOf", "licenseBasis", "evidenceReference"], "license record entity");
  assertExactKeys(record.remotion, ["version", "usage", "confirmedBy", "confirmedDate"], "license record Remotion section");
  assertExactKeys(record.browser, ["product", "version", "source", "sourceUrl", "sha256", "terms", "termsUrl", "internalRedistributionBasis", "commercialRedistributionBasis", "confirmedBy", "confirmedDate"], "license record browser section");
  if (record.schemaVersion !== 1) throw new Error("Unsupported license record schemaVersion");
  if (!new Set(["internal-evaluation", "commercial-delivery"]).has(record.useType)) throw new Error("License record useType is invalid");
  nonEmpty(record.entity.name, "license record entity name");
  if (!new Set(["individual", "for-profit", "non-profit", "not-for-profit"]).has(record.entity.type)) {
    throw new Error("License record entity type is invalid");
  }
  if (record.entity.employeeCount !== null && (!Number.isInteger(record.entity.employeeCount) || record.entity.employeeCount < 0)) {
    throw new Error("License record employeeCount is invalid");
  }
  if (record.entity.employeeCount !== null) validDate(record.entity.employeeCountAsOf, "license record employeeCountAsOf");
  if (!new Set(["evaluation", "free-individual", "free-small-company", "free-nonprofit", "company-license"]).has(record.entity.licenseBasis)) {
    throw new Error("License record Remotion license basis is invalid");
  }
  nonEmpty(record.entity.evidenceReference, "license record evidenceReference");
  if (record.remotion.version !== REMOTION_VERSION) throw new Error(`License record must apply to Remotion ${REMOTION_VERSION}`);
  nonEmpty(record.remotion.confirmedBy, "license record Remotion confirmer");
  validDate(record.remotion.confirmedDate, "license record Remotion confirmation date");

  if (artifactType === "delivery") {
    if (record.useType !== "commercial-delivery" || record.remotion.usage !== "commercial-delivery") {
      throw new Error("Delivery requires a commercial Remotion usage confirmation");
    }
    if (record.entity.licenseBasis === "evaluation") throw new Error("Delivery cannot use the Remotion evaluation basis");
    if (record.entity.licenseBasis === "free-individual" && record.entity.type !== "individual") {
      throw new Error("The free-individual basis does not match the entity type");
    }
    if (record.entity.licenseBasis === "free-small-company" && !(
      record.entity.type === "for-profit"
      && Number.isInteger(record.entity.employeeCount)
      && record.entity.employeeCount <= 3
    )) throw new Error("The free-small-company basis requires a dated employee count of at most 3");
    if (record.entity.licenseBasis === "free-nonprofit" && !new Set(["non-profit", "not-for-profit"]).has(record.entity.type)) {
      throw new Error("The free-nonprofit basis does not match the entity type");
    }
  } else if (record.useType !== "internal-evaluation" || record.remotion.usage !== "non-commercial-internal-evaluation") {
    throw new Error("Internal evaluation requires a non-commercial evaluation record");
  }

  nonEmpty(record.browser.product, "browser product");
  nonEmpty(record.browser.version, "browser version");
  nonEmpty(record.browser.source, "browser source");
  validUrl(record.browser.sourceUrl, "browser sourceUrl");
  if (!HASH_PATTERN.test(String(record.browser.sha256 || ""))) throw new Error("Browser SHA-256 is invalid");
  nonEmpty(record.browser.terms, "browser terms");
  validUrl(record.browser.termsUrl, "browser termsUrl");
  nonEmpty(record.browser.internalRedistributionBasis, "browser internal redistribution basis");
  nonEmpty(record.browser.confirmedBy, "browser evidence confirmer");
  validDate(record.browser.confirmedDate, "browser evidence confirmation date");
  if (artifactType === "delivery") {
    nonEmpty(record.browser.commercialRedistributionBasis, "browser commercial redistribution basis");
  }
  return JSON.parse(JSON.stringify(record));
}

function licenseFiles(packageDir) {
  return fs.readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:\..*)?$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function packageTreeSha256(packageDir) {
  const root = path.resolve(packageDir);
  const digest = crypto.createHash("sha256");
  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !(current === root && entry.name === "node_modules"))
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        digest.update(`directory\0${relative}\0`);
        visit(absolute);
      } else if (entry.isFile()) {
        digest.update(`file\0${relative}\0${fs.statSync(absolute).size}\0${sha256(absolute)}\0`);
      } else {
        throw new Error(`Unsupported package tree entry: ${absolute}`);
      }
    }
  };
  visit(root);
  return digest.digest("hex");
}

function packageDetails(desktopDir, closure, packaged) {
  return closure.map((item) => {
    const packageDir = assertDirectory(path.join(desktopDir, ...item.lockPath.split("/")), `Installed package ${item.name}`);
    const packageJson = readJson(path.join(packageDir, "package.json"), `${item.name} package.json`);
    if (String(packageJson.version || "") !== item.version) {
      throw new Error(`Installed package version drift: ${item.name}`);
    }
    return {
      ...item,
      licenseDeclared: String(packageJson.license || "NOASSERTION"),
      licenseFiles: licenseFiles(packageDir).map((name) => ({ name, sha256: sha256(path.join(packageDir, name)) })),
      packaged,
      treeSha256: packageTreeSha256(packageDir)
    };
  });
}

function copyPackageWithoutNestedModules(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (candidate) => {
      const relative = path.relative(source, candidate);
      return relative === "" || relative.split(path.sep)[0] !== "node_modules";
    }
  });
}

function copyRuntimeClosure(desktopDir, outputDir, packages) {
  for (const item of packages) {
    copyPackageWithoutNestedModules(
      path.join(desktopDir, ...item.lockPath.split("/")),
      path.join(outputDir, ...item.lockPath.split("/"))
    );
  }
}

function safeLicenseDirectory(lockPath) {
  return lockPath.replaceAll("@", "_at_").replaceAll("/", "__");
}

function copyLicenseEvidence(desktopDir, outputDir, packages) {
  const licensesRoot = path.join(outputDir, "licenses", "packages");
  for (const item of packages) {
    if (!item.licenseFiles.length) continue;
    const targetDir = path.join(licensesRoot, safeLicenseDirectory(item.lockPath));
    fs.mkdirSync(targetDir, { recursive: true });
    for (const license of item.licenseFiles) {
      fs.copyFileSync(
        path.join(desktopDir, ...item.lockPath.split("/"), license.name),
        path.join(targetDir, license.name)
      );
    }
  }
}

function writeMonoPcmWav(target, durationSeconds, sampleAt) {
  const sampleRate = 48_000;
  const sampleCount = Math.round(durationSeconds * sampleRate);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.max(-1, Math.min(1, sampleAt(index / sampleRate, index)));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  fs.writeFileSync(target, buffer);
}

function generateSounds(publicDir) {
  writeMonoPcmWav(path.join(publicDir, "sfx-pop.wav"), 0.16, (time) => {
    const fade = time <= 0.07 ? 1 : Math.max(0, (0.16 - time) / 0.09);
    return Math.sin(2 * Math.PI * 980 * time) * 0.32 * fade;
  });
  writeMonoPcmWav(path.join(publicDir, "sfx-click.wav"), 0.09, (time) => {
    const fade = time <= 0.025 ? 1 : Math.max(0, (0.09 - time) / 0.065);
    return Math.sin(2 * Math.PI * 1450 * time) * 0.24 * fade;
  });
  let randomState = 0x58494f58;
  let filtered = 0;
  writeMonoPcmWav(path.join(publicDir, "sfx-whoosh.wav"), 0.42, (time) => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    const noise = (randomState / 0xffffffff) * 2 - 1;
    filtered = filtered * 0.88 + noise * 0.12;
    const fadeIn = Math.min(1, time / 0.08);
    const fadeOut = time <= 0.18 ? 1 : Math.max(0, (0.42 - time) / 0.24);
    return filtered * 0.34 * fadeIn * fadeOut;
  });
  const deterministicTimestamp = new Date("2000-01-01T00:00:00.000Z");
  for (const name of SOUND_FILES) {
    fs.utimesSync(path.join(publicDir, name), deterministicTimestamp, deterministicTimestamp);
  }
}

function hashWorkerRuntime(bundleRoot, packagingRoot, workerFile) {
  const digest = crypto.createHash("sha256");
  const effectRegistry = readJson(path.join(packagingRoot, "effect-registry.json"), "effect registry");
  digest.update("xiaoxi-remotion-worker-v1\n");
  digest.update(String(effectRegistry.version));
  const visit = (relative = "") => {
    const current = path.join(bundleRoot, relative);
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Runtime bundle contains a symbolic link: ${entry.name}`);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        digest.update(`bundle:${child}\0`);
        digest.update(fs.readFileSync(path.join(bundleRoot, child)));
      }
    }
  };
  visit();
  for (const name of WORKER_CONTRACT_FILES) {
    digest.update(`contract:${name}\0`);
    digest.update(fs.readFileSync(path.join(packagingRoot, name)));
  }
  digest.update("worker:remotion-render-worker.mjs\0");
  digest.update(fs.readFileSync(workerFile));
  return digest.digest("hex");
}

function licenseSummary(record, recordSha256) {
  if (!record) return { present: false, schemaVersion: 1, sha256: null, commercialConfirmed: false };
  return {
    browserConfirmedBy: record.browser.confirmedBy,
    browserConfirmedDate: record.browser.confirmedDate,
    commercialConfirmed: record.useType === "commercial-delivery" && record.remotion.usage === "commercial-delivery",
    entityType: record.entity.type,
    licenseBasis: record.entity.licenseBasis,
    present: true,
    remotionConfirmedBy: record.remotion.confirmedBy,
    remotionConfirmedDate: record.remotion.confirmedDate,
    schemaVersion: record.schemaVersion,
    sha256: recordSha256,
    usage: record.remotion.usage,
    useType: record.useType
  };
}

function browserSummary(artifactType, browserPath, record) {
  if (!browserPath) return { packaged: false, requiredAtRuntime: true };
  const hash = sha256(browserPath);
  if (record && hash !== record.browser.sha256) throw new Error("Browser hash does not match the license record");
  if (artifactType === "development") {
    return { packaged: false, requiredAtRuntime: true, sha256: hash, source: "explicit-local-browser" };
  }
  return {
    commercialRedistributionRecorded: Boolean(record.browser.commercialRedistributionBasis),
    confirmedBy: record.browser.confirmedBy,
    confirmedDate: record.browser.confirmedDate,
    internalRedistributionRecorded: Boolean(record.browser.internalRedistributionBasis),
    packaged: true,
    product: record.browser.product,
    sha256: hash,
    source: record.browser.source,
    sourceUrl: record.browser.sourceUrl,
    terms: record.browser.terms,
    termsUrl: record.browser.termsUrl,
    treeSha256: treeSha256(path.dirname(browserPath)),
    version: record.browser.version
  };
}

function copyBrowserRuntime(browserPath, targetRoot, browser) {
  const sourceRoot = path.dirname(assertFile(browserPath, "Explicit browser executable"));
  if (path.basename(browserPath).toLowerCase() !== "chrome.exe") throw new Error("Packaged Remotion runtime requires a Chrome chrome.exe source");
  const target = path.resolve(targetRoot);
  if (fs.existsSync(target)) throw new Error(`Browser runtime target already exists: ${target}`);
  fs.cpSync(sourceRoot, target, { recursive: true, errorOnExist: true, force: false });
  const copiedBrowser = assertFile(path.join(target, path.basename(browserPath)), "Copied browser executable");
  if (sha256(copiedBrowser) !== browser.sha256) throw new Error("Copied browser executable hash mismatch");
  if (treeSha256(target) !== browser.treeSha256) throw new Error("Copied browser runtime tree hash mismatch");
  return copiedBrowser;
}

function thirdPartyMarkdown(packages, browser) {
  const lines = [
    "# Deterministic third-party license inventory",
    "",
    "Generated from the checked-in npm lockfile and locally installed package metadata.",
    "",
    "| Package | Version | Runtime | Declared license | License files |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const item of packages) {
    lines.push(`| ${item.name} | ${item.version} | ${item.packaged ? "yes" : "build-only"} | ${item.licenseDeclared.replaceAll("|", "\\|")} | ${item.licenseFiles.map((file) => file.name).join(", ") || "none in package root"} |`);
  }
  lines.push("", "## Browser", "");
  if (!browser.packaged) lines.push("No browser binary is packaged for this artifact.");
  else lines.push(
    `- ${browser.product} ${browser.version}`,
    `- Source: ${browser.sourceUrl}`,
    `- Terms: ${browser.termsUrl}`,
    `- SHA-256: ${browser.sha256}`,
    `- Runtime tree SHA-256: ${browser.treeSha256}`
  );
  lines.push("");
  return lines.join("\n");
}

async function compositionSmoke(serveUrl, browserPath) {
  const { selectComposition } = require("@remotion/renderer");
  const composition = await selectComposition({
    serveUrl,
    id: "DynamicPackaging",
    inputProps: {
      version: 1,
      semanticPresetId: "knowledge_focus",
      styleId: "social_pop",
      effectRegistryVersion: 1,
      layoutGridVersion: 1,
      deterministicSeed: "runtime-build-smoke",
      width: 1080,
      height: 1920,
      fps: 30,
      durationMs: 1_000,
      durationInFrames: 30,
      title: "runtime smoke",
      sourceFile: "source.mp4",
      director: { version: 1, provider: "local", model: null },
      captions: [],
      events: [],
      focusRects: [],
      protectedRects: []
    },
    browserExecutable: browserPath,
    logLevel: "error"
  });
  if (composition.id !== "DynamicPackaging" || composition.width !== 1080 || composition.height !== 1920 || composition.fps !== 30) {
    throw new Error("Selected Remotion composition does not match the fixed contract");
  }
  return { compositionId: composition.id, fps: composition.fps, height: composition.height, status: "passed", width: composition.width };
}

async function buildRemotionRuntime({
  artifactType = "development",
  browserPath = null,
  desktopDir = path.resolve(__dirname, ".."),
  licenseRecordPath = null,
  outputDir = path.join(desktopDir, ".build", "remotion-runtime", artifactType),
  skipCompositionSmoke = false
} = {}) {
  if (!ARTIFACT_TYPES.includes(artifactType)) throw new Error(`Unsupported Remotion artifact type: ${artifactType}`);
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Remotion runtime builds are pinned to Windows x64");
  const root = path.resolve(desktopDir);
  const output = path.resolve(outputDir);
  const packageState = readPackageState(root);
  const rawLicenseRecord = licenseRecordPath ? readJson(assertFile(path.resolve(licenseRecordPath), "License record"), "License record") : null;
  const licenseRecord = validateLicenseRecord(rawLicenseRecord, artifactType);
  const resolvedBrowser = browserPath ? assertFile(path.resolve(browserPath), "Explicit browser executable") : null;
  if (artifactType !== "development" && !resolvedBrowser) throw new Error(`${artifactType} requires an explicit browser source executable`);
  const browser = browserSummary(artifactType, resolvedBrowser, licenseRecord);
  if (fs.existsSync(output)) {
    const existing = verifyRemotionRuntime(output, { desktopDir: root, expectedArtifactType: artifactType });
    const expectedRecordHash = licenseRecord ? sha256Text(canonicalJson(licenseRecord)) : null;
    if (
      JSON.stringify(existing.manifest.browser) !== JSON.stringify(browser)
      || existing.manifest.licenseRecord.sha256 !== expectedRecordHash
      || (!skipCompositionSmoke && resolvedBrowser && existing.manifest.compositionSmoke.status !== "passed")
    ) {
      throw new Error(`Existing Remotion runtime does not match the requested browser/license evidence: ${output}`);
    }
    return existing;
  }
  const runtimeClosure = packageDetails(root, resolveLockClosure(packageState.packageLock, "runtime"), true);
  const builderClosure = packageDetails(root, resolveLockClosure(packageState.packageLock, "builder"), false);
  const staging = `${output}.staging-${process.pid}-${Date.now()}`;
  if (fs.existsSync(staging)) throw new Error(`Remotion staging path already exists: ${staging}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    const packagingSource = path.join(root, "remotion-packaging");
    const packagingTarget = path.join(staging, "packaging-assets");
    fs.mkdirSync(packagingTarget);
    for (const name of PACKAGING_FILES) fs.copyFileSync(assertFile(path.join(packagingSource, name), `Remotion packaging ${name}`), path.join(packagingTarget, name));

    const workerSource = assertFile(path.join(root, "src", "main", "remotion-render-worker.mjs"), "Remotion worker");
    const workerTarget = path.join(staging, "remotion-render-worker.mjs");
    fs.copyFileSync(workerSource, workerTarget);
    copyRuntimeClosure(root, staging, runtimeClosure);

    const publicDir = path.join(staging, ".bundle-public");
    const bundleDir = path.join(staging, "remotion-bundle");
    fs.mkdirSync(publicDir);
    generateSounds(publicDir);
    const { bundle } = require("@remotion/bundler");
    const serveUrl = await bundle({
      entryPoint: path.join(packagingSource, "index.ts"),
      publicDir,
      outDir: bundleDir,
      enableCaching: false,
      onProgress: () => undefined,
      symlinkPublicDir: false
    });
    fs.rmSync(publicDir, { recursive: true, force: true });

    let smokeBrowser = resolvedBrowser;
    if (artifactType !== "development") {
      smokeBrowser = copyBrowserRuntime(resolvedBrowser, path.join(staging, "browser"), browser);
    }
    let smoke = { reason: "No explicit browser composition smoke was requested", status: "not-run" };
    if (!skipCompositionSmoke && smokeBrowser) smoke = await compositionSmoke(serveUrl, smokeBrowser);

    const allPackages = new Map();
    for (const item of builderClosure) allPackages.set(item.lockPath, item);
    for (const item of runtimeClosure) allPackages.set(item.lockPath, { ...item, packaged: true });
    const packageInventory = [...allPackages.values()].sort((left, right) => left.lockPath.localeCompare(right.lockPath));
    copyLicenseEvidence(root, staging, packageInventory);
    fs.mkdirSync(path.join(staging, "licenses", "project"), { recursive: true });
    for (const name of ["LICENSES.md", "runtime-license-record.schema.json", "runtime-license-record.template.json"]) {
      fs.copyFileSync(path.join(packagingSource, name), path.join(staging, "licenses", "project", name));
    }
    let recordSha256 = null;
    if (licenseRecord) {
      const recordText = canonicalJson(licenseRecord);
      const recordTarget = path.join(staging, "licenses", "license-record.json");
      fs.writeFileSync(recordTarget, recordText, "utf8");
      recordSha256 = sha256Text(recordText);
    }
    const summary = licenseSummary(licenseRecord, recordSha256);
    const sbom = {
      artifactType,
      browser,
      packages: packageInventory,
      platform: "win32",
      schemaVersion: 1,
      targetArchitecture: "x64"
    };
    const sbomText = canonicalJson(sbom);
    const sbomFile = path.join(staging, "sbom.json");
    fs.writeFileSync(sbomFile, sbomText, "utf8");
    const thirdPartyText = `${thirdPartyMarkdown(packageInventory, browser)}\n`;
    const thirdPartyFile = path.join(staging, "THIRD_PARTY_LICENSES.md");
    fs.writeFileSync(thirdPartyFile, thirdPartyText, "utf8");

    const sourceFiles = Object.fromEntries(PACKAGING_FILES.map((name) => [name, sha256(path.join(packagingTarget, name))]));
    const soundFiles = Object.fromEntries(SOUND_FILES.map((name) => [name, sha256(path.join(bundleDir, "public", name))]));
    const manifest = {
      artifactType,
      browser,
      buildClosure: builderClosure,
      bundle: { path: "remotion-bundle", sha256: treeSha256(bundleDir), sounds: soundFiles },
      compositionSmoke: smoke,
      licenseRecord: summary,
      packages: {
        bundler: packageState.packageLock.packages["node_modules/@remotion/bundler"].version,
        react: packageState.packageLock.packages["node_modules/react"].version,
        reactDom: packageState.packageLock.packages["node_modules/react-dom"].version,
        remotion: packageState.packageLock.packages["node_modules/remotion"].version,
        renderer: packageState.packageLock.packages["node_modules/@remotion/renderer"].version
      },
      packagingAssets: { path: "packaging-assets", files: sourceFiles },
      platform: "win32",
      runtimeClosure,
      runtimeHash: hashWorkerRuntime(bundleDir, packagingTarget, workerTarget),
      sbom: { path: "sbom.json", sha256: sha256Text(sbomText) },
      schemaVersion: 1,
      source: {
        packageJsonSha256: sha256(packageState.packageJsonFile),
        packageLockSha256: sha256(packageState.packageLockFile)
      },
      targetArchitecture: "x64",
      thirdPartyLicenses: { path: "THIRD_PARTY_LICENSES.md", sha256: sha256Text(thirdPartyText) },
      worker: { path: "remotion-render-worker.mjs", sha256: sha256(workerTarget) }
    };
    const manifestText = canonicalJson(manifest);
    fs.writeFileSync(path.join(staging, "runtime-manifest.json"), manifestText, "utf8");
    fs.writeFileSync(path.join(staging, "runtime-manifest.sha256"), `${sha256Text(manifestText)}  runtime-manifest.json\n`, "utf8");
    fs.renameSync(staging, output);
    return verifyRemotionRuntime(output, { desktopDir: root, expectedArtifactType: artifactType });
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function readManifestDigest(runtimeRoot) {
  const manifestFile = assertFile(path.join(runtimeRoot, "runtime-manifest.json"), "Remotion runtime manifest");
  const digestFile = assertFile(path.join(runtimeRoot, "runtime-manifest.sha256"), "Remotion runtime manifest digest");
  const expected = String(fs.readFileSync(digestFile, "utf8")).trim().split(/\s+/u)[0];
  if (!HASH_PATTERN.test(expected) || sha256(manifestFile) !== expected) throw new Error("Remotion runtime manifest hash mismatch");
  return { manifest: readJson(manifestFile, "Remotion runtime manifest"), manifestFile, manifestSha256: expected };
}

function verifyLicenseInventory(licenseRoot, sbom) {
  for (const name of ["LICENSES.md", "runtime-license-record.schema.json", "runtime-license-record.template.json"]) {
    assertFile(path.join(licenseRoot, "project", name), `Remotion project license asset ${name}`);
  }
  for (const item of sbom.packages || []) {
    for (const license of item.licenseFiles || []) {
      const file = assertFile(
        path.join(licenseRoot, "packages", safeLicenseDirectory(item.lockPath), license.name),
        `${item.name} license file ${license.name}`
      );
      if (sha256(file) !== license.sha256) throw new Error(`Third-party license hash mismatch: ${item.name}/${license.name}`);
    }
  }
}

function verifyManifestCore(manifest, expectedArtifactType) {
  if (manifest.schemaVersion !== 1 || manifest.platform !== "win32" || manifest.targetArchitecture !== "x64") {
    throw new Error("Remotion runtime manifest platform/schema is invalid");
  }
  if (!ARTIFACT_TYPES.includes(manifest.artifactType) || (expectedArtifactType && manifest.artifactType !== expectedArtifactType)) {
    throw new Error("Remotion runtime artifact type mismatch");
  }
  const versions = manifest.packages || {};
  if (versions.remotion !== REMOTION_VERSION || versions.renderer !== REMOTION_VERSION || versions.bundler !== REMOTION_VERSION || versions.react !== REACT_VERSION || versions.reactDom !== REACT_VERSION) {
    throw new Error("Remotion runtime package version drift");
  }
  if (manifest.browser?.packaged && !HASH_PATTERN.test(String(manifest.browser.treeSha256 || ""))) {
    throw new Error("Remotion runtime browser tree hash is invalid");
  }
}

function verifyCurrentRuntimeSources(manifest, desktopDir) {
  const root = path.resolve(desktopDir);
  const packageState = readPackageState(root);
  if (manifest.source.packageJsonSha256 !== sha256(packageState.packageJsonFile) || manifest.source.packageLockSha256 !== sha256(packageState.packageLockFile)) {
    throw new Error("Remotion runtime source package metadata hash drift; rebuild the runtime");
  }
  const currentWorker = assertFile(path.join(root, "src", "main", "remotion-render-worker.mjs"), "Current Remotion worker source");
  if (sha256(currentWorker) !== manifest.worker.sha256) throw new Error("Remotion worker source drift; rebuild the runtime");
  const declaredAssets = Object.keys(manifest.packagingAssets?.files || {}).sort();
  if (JSON.stringify(declaredAssets) !== JSON.stringify([...PACKAGING_FILES].sort())) {
    throw new Error("Remotion packaging source manifest is incomplete; rebuild the runtime");
  }
  for (const name of PACKAGING_FILES) {
    const source = assertFile(path.join(root, "remotion-packaging", name), `Current Remotion packaging source ${name}`);
    if (sha256(source) !== manifest.packagingAssets.files[name]) {
      throw new Error(`Remotion packaging source drift (${name}); rebuild the runtime`);
    }
  }
  return packageState;
}

function verifyRemotionRuntime(runtimeRoot, { desktopDir = path.resolve(__dirname, ".."), expectedArtifactType = null, requireCompositionSmoke = false } = {}) {
  const root = assertDirectory(path.resolve(runtimeRoot), "Remotion runtime");
  const { manifest, manifestFile, manifestSha256 } = readManifestDigest(root);
  verifyManifestCore(manifest, expectedArtifactType);
  const packageState = verifyCurrentRuntimeSources(manifest, desktopDir);
  const expectedRuntimeKeys = resolveLockClosure(packageState.packageLock, "runtime").map((item) => item.lockPath);
  if (JSON.stringify(manifest.runtimeClosure.map((item) => item.lockPath)) !== JSON.stringify(expectedRuntimeKeys)) {
    throw new Error("Remotion runtime closure drift");
  }
  const worker = assertFile(path.join(root, manifest.worker.path), "Remotion worker");
  if (sha256(worker) !== manifest.worker.sha256) throw new Error("Remotion worker hash mismatch");
  const bundle = assertDirectory(path.join(root, manifest.bundle.path), "Remotion bundle");
  if (treeSha256(bundle) !== manifest.bundle.sha256) throw new Error("Remotion bundle hash mismatch");
  const packaging = assertDirectory(path.join(root, manifest.packagingAssets.path), "Remotion packaging assets");
  for (const [name, hash] of Object.entries(manifest.packagingAssets.files || {})) {
    if (sha256(assertFile(path.join(packaging, name), `Remotion packaging ${name}`)) !== hash) throw new Error(`Remotion packaging asset hash mismatch: ${name}`);
  }
  for (const item of manifest.runtimeClosure) {
    const packageDir = assertDirectory(path.join(root, ...item.lockPath.split("/")), `Packaged Remotion dependency ${item.name}`);
    if (packageTreeSha256(packageDir) !== item.treeSha256) throw new Error(`Remotion runtime package hash mismatch: ${item.name}`);
    if (readJson(path.join(packageDir, "package.json"), `${item.name} package.json`).version !== item.version) throw new Error(`Remotion runtime package version mismatch: ${item.name}`);
  }
  if (manifest.browser.packaged) {
    const browserRoot = assertDirectory(path.join(root, "browser"), "Packaged browser runtime");
    const browser = assertFile(path.join(browserRoot, "chrome.exe"), "Packaged browser");
    if (sha256(browser) !== manifest.browser.sha256) throw new Error("Browser hash mismatch");
    if (treeSha256(browserRoot) !== manifest.browser.treeSha256) throw new Error("Browser runtime tree hash mismatch");
  } else if (fs.existsSync(path.join(root, "browser"))) throw new Error("Development runtime must not package a browser");
  if (manifest.licenseRecord.present) {
    const record = assertFile(path.join(root, "licenses", "license-record.json"), "Runtime license record");
    if (sha256(record) !== manifest.licenseRecord.sha256) throw new Error("Runtime license record hash mismatch");
  }
  const sbomFile = assertFile(path.join(root, manifest.sbom.path), "Remotion SBOM");
  if (sha256(sbomFile) !== manifest.sbom.sha256) throw new Error("Remotion SBOM hash mismatch");
  verifyLicenseInventory(assertDirectory(path.join(root, "licenses"), "Remotion license inventory"), readJson(sbomFile, "Remotion SBOM"));
  if (sha256(assertFile(path.join(root, manifest.thirdPartyLicenses.path), "Third-party license inventory")) !== manifest.thirdPartyLicenses.sha256) throw new Error("Third-party license inventory hash mismatch");
  if (hashWorkerRuntime(bundle, packaging, worker) !== manifest.runtimeHash) throw new Error("Remotion worker runtime hash mismatch");
  if (requireCompositionSmoke && manifest.compositionSmoke.status !== "passed") throw new Error("Portable Remotion runtime requires a successful composition selection smoke test");
  return { manifest, manifestFile, manifestSha256, outputDir: root };
}

function resolveRemotionRuntimeBuild(desktopDir, artifactType, { runtimeRoot = null } = {}) {
  const resolvedRuntimeRoot = runtimeRoot
    ? path.resolve(runtimeRoot)
    : path.join(path.resolve(desktopDir), ".build", "remotion-runtime");
  return verifyRemotionRuntime(path.join(resolvedRuntimeRoot, artifactType), {
    desktopDir,
    expectedArtifactType: artifactType,
    requireCompositionSmoke: true
  });
}

function copyRemotionRuntime(build, releaseTarget) {
  const manifest = build.manifest;
  if (!new Set(["internal-evaluation", "delivery"]).has(manifest.artifactType)) throw new Error("Portable releases cannot package a development Remotion runtime");
  const target = path.resolve(releaseTarget);
  const contentEngineRoot = assertDirectory(path.join(target, "resources", "content-engine"), "Portable content-engine directory");
  const packagingRoot = path.join(target, "remotion-packaging");
  const destinations = [
    path.join(contentEngineRoot, "remotion-render-worker.mjs"),
    path.join(contentEngineRoot, "remotion-bundle"),
    path.join(contentEngineRoot, "node_modules"),
    path.join(contentEngineRoot, "remotion-licenses"),
    path.join(contentEngineRoot, "remotion-runtime-manifest.json"),
    path.join(contentEngineRoot, "remotion-runtime-manifest.sha256"),
    path.join(contentEngineRoot, "remotion-sbom.json"),
    path.join(contentEngineRoot, "THIRD_PARTY_LICENSES.md"),
    packagingRoot
  ];
  if (manifest.browser.packaged) destinations.push(path.join(contentEngineRoot, "browser"));
  for (const destination of destinations) {
    if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite packaged Remotion runtime content: ${destination}`);
  }
  fs.copyFileSync(path.join(build.outputDir, manifest.worker.path), destinations[0]);
  fs.cpSync(path.join(build.outputDir, manifest.bundle.path), destinations[1], { recursive: true, errorOnExist: true, force: false });
  fs.cpSync(path.join(build.outputDir, "node_modules"), destinations[2], { recursive: true, errorOnExist: true, force: false });
  fs.cpSync(path.join(build.outputDir, "licenses"), destinations[3], { recursive: true, errorOnExist: true, force: false });
  fs.copyFileSync(path.join(build.outputDir, "runtime-manifest.json"), destinations[4]);
  fs.copyFileSync(path.join(build.outputDir, "runtime-manifest.sha256"), destinations[5]);
  fs.copyFileSync(path.join(build.outputDir, manifest.sbom.path), destinations[6]);
  fs.copyFileSync(path.join(build.outputDir, manifest.thirdPartyLicenses.path), destinations[7]);
  fs.cpSync(path.join(build.outputDir, manifest.packagingAssets.path), packagingRoot, { recursive: true, errorOnExist: true, force: false });
  if (manifest.browser.packaged) fs.cpSync(path.join(build.outputDir, "browser"), path.join(contentEngineRoot, "browser"), { recursive: true, errorOnExist: true, force: false });
  const descriptor = {
    artifactType: manifest.artifactType,
    browserSha256: manifest.browser.sha256,
    browserTreeSha256: manifest.browser.treeSha256,
    browserVersion: manifest.browser.version,
    bundleSha256: manifest.bundle.sha256,
    commercialLicenseConfirmed: manifest.licenseRecord.commercialConfirmed,
    compositionSmokeStatus: manifest.compositionSmoke.status,
    licenseRecordSha256: manifest.licenseRecord.sha256,
    manifestPath: "resources/content-engine/remotion-runtime-manifest.json",
    manifestSha256: build.manifestSha256,
    runtimeHash: manifest.runtimeHash,
    sbomSha256: manifest.sbom.sha256,
    workerSha256: manifest.worker.sha256
  };
  verifyPackagedRemotionRuntime(target, descriptor);
  return descriptor;
}

function verifyPackagedRemotionRuntime(releaseTarget, descriptor) {
  const target = path.resolve(releaseTarget);
  const contentEngineRoot = path.join(target, "resources", "content-engine");
  const manifestFile = assertFile(path.join(target, ...String(descriptor.manifestPath || "").split("/")), "Packaged Remotion manifest");
  if (sha256(manifestFile) !== descriptor.manifestSha256) throw new Error("Packaged Remotion manifest hash mismatch");
  const digestFile = assertFile(path.join(contentEngineRoot, "remotion-runtime-manifest.sha256"), "Packaged Remotion manifest digest");
  if (String(fs.readFileSync(digestFile, "utf8")).trim().split(/\s+/u)[0] !== descriptor.manifestSha256) {
    throw new Error("Packaged Remotion manifest digest mismatch");
  }
  const manifest = readJson(manifestFile, "Packaged Remotion manifest");
  verifyManifestCore(manifest, descriptor.artifactType);
  if (manifest.artifactType !== descriptor.artifactType || manifest.runtimeHash !== descriptor.runtimeHash) throw new Error("Packaged Remotion descriptor mismatch");
  const worker = assertFile(path.join(contentEngineRoot, "remotion-render-worker.mjs"), "Packaged Remotion worker");
  if (sha256(worker) !== manifest.worker.sha256 || sha256(worker) !== descriptor.workerSha256) throw new Error("Packaged Remotion worker hash mismatch");
  const bundle = assertDirectory(path.join(contentEngineRoot, "remotion-bundle"), "Packaged Remotion bundle");
  if (treeSha256(bundle) !== manifest.bundle.sha256 || manifest.bundle.sha256 !== descriptor.bundleSha256) throw new Error("Packaged Remotion bundle hash mismatch");
  const packaging = assertDirectory(path.join(target, "remotion-packaging"), "Packaged Remotion design assets");
  for (const [name, hash] of Object.entries(manifest.packagingAssets.files || {})) {
    if (sha256(assertFile(path.join(packaging, name), `Packaged Remotion asset ${name}`)) !== hash) throw new Error(`Packaged Remotion asset hash mismatch: ${name}`);
  }
  for (const item of manifest.runtimeClosure) {
    const packageDir = assertDirectory(path.join(contentEngineRoot, ...item.lockPath.split("/")), `Packaged Remotion dependency ${item.name}`);
    if (packageTreeSha256(packageDir) !== item.treeSha256) throw new Error(`Packaged Remotion dependency hash mismatch: ${item.name}`);
  }
  const browserRoot = assertDirectory(path.join(contentEngineRoot, "browser"), "Packaged Remotion browser runtime");
  const browser = assertFile(path.join(browserRoot, "chrome.exe"), "Packaged Remotion browser");
  if (sha256(browser) !== manifest.browser.sha256 || sha256(browser) !== descriptor.browserSha256) throw new Error("Packaged browser hash mismatch");
  if (!HASH_PATTERN.test(String(descriptor.browserTreeSha256 || "")) || manifest.browser.treeSha256 !== descriptor.browserTreeSha256) {
    throw new Error("Packaged browser runtime tree descriptor mismatch");
  }
  if (treeSha256(browserRoot) !== manifest.browser.treeSha256) throw new Error("Packaged browser runtime tree hash mismatch");
  const licenseRoot = assertDirectory(path.join(contentEngineRoot, "remotion-licenses"), "Packaged Remotion licenses");
  if (manifest.licenseRecord.present) {
    const record = assertFile(path.join(licenseRoot, "license-record.json"), "Packaged license record");
    if (sha256(record) !== manifest.licenseRecord.sha256 || sha256(record) !== descriptor.licenseRecordSha256) throw new Error("Packaged license record hash mismatch");
  }
  const sbom = assertFile(path.join(contentEngineRoot, "remotion-sbom.json"), "Packaged Remotion SBOM");
  if (sha256(sbom) !== manifest.sbom.sha256 || sha256(sbom) !== descriptor.sbomSha256) throw new Error("Packaged Remotion SBOM hash mismatch");
  verifyLicenseInventory(licenseRoot, readJson(sbom, "Packaged Remotion SBOM"));
  if (hashWorkerRuntime(bundle, packaging, worker) !== manifest.runtimeHash) throw new Error("Packaged Remotion runtime hash mismatch");
  if (manifest.compositionSmoke.status !== descriptor.compositionSmokeStatus) throw new Error("Packaged Remotion smoke status mismatch");
  if (manifest.artifactType === "delivery" && !manifest.licenseRecord.commercialConfirmed) throw new Error("Packaged delivery lacks a commercial Remotion license basis");
  return { manifest, manifestFile };
}

function parseArguments(argv) {
  const args = [...argv];
  const artifactType = args[0] && !args[0].startsWith("--") ? args.shift() : "development";
  const values = new Map();
  let skipCompositionSmoke = false;
  while (args.length) {
    const option = args.shift();
    if (option === "--skip-composition-smoke") {
      skipCompositionSmoke = true;
      continue;
    }
    if (!new Set(["--browser", "--license-record", "--output"]).has(option)) throw new Error(`Unknown Remotion runtime option: ${option}`);
    if (values.has(option)) throw new Error(`Duplicate Remotion runtime option: ${option}`);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    values.set(option, value);
  }
  return { artifactType, skipCompositionSmoke, values };
}

async function main(argv = process.argv.slice(2)) {
  const desktopDir = path.resolve(__dirname, "..");
  const { artifactType, skipCompositionSmoke, values } = parseArguments(argv);
  const outputDir = path.resolve(values.get("--output") || path.join(desktopDir, ".build", "remotion-runtime", artifactType));
  const result = await buildRemotionRuntime({
    artifactType,
    browserPath: values.get("--browser") || process.env.XIAOXI_REMOTION_BROWSER_SOURCE_PATH || null,
    desktopDir,
    licenseRecordPath: values.get("--license-record") || process.env.XIAOXI_REMOTION_LICENSE_RECORD || null,
    outputDir,
    skipCompositionSmoke
  });
  console.log(`${artifactType} Remotion runtime built: ${result.outputDir}`);
  console.log(`manifest sha256: ${result.manifestSha256}`);
  if (result.manifest.compositionSmoke.status !== "passed") console.log("Chromium composition selection was not verified for this build.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  ARTIFACT_TYPES,
  artifactTypeForEdition,
  buildRemotionRuntime,
  copyBrowserRuntime,
  copyRemotionRuntime,
  hashWorkerRuntime,
  readPackageState,
  resolveLockClosure,
  resolveRemotionRuntimeBuild,
  validateLicenseRecord,
  verifyCurrentRuntimeSources,
  verifyPackagedRemotionRuntime,
  verifyRemotionRuntime
};
