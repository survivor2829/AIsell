const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const { writeContentEngineFontconfig } = require("../src/main/content-engine-media-tools.cjs");

const desktopDir = path.resolve(__dirname, "..");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS_URL_PATTERN = /^https:\/\/\S+$/u;
const MEDIA_TOOL_PACKAGING_FILES = Object.freeze([
  "MEDIA_TOOLS_LICENSES.md",
  "media-tools-license-record.schema.json",
  "media-tools-license-record.template.json"
]);
const MEDIA_TOOL_REQUIRED_FILTERS = Object.freeze([
  "acompressor",
  "adelay",
  "aevalsrc",
  "afftdn",
  "afade",
  "alimiter",
  "ametadata",
  "amix",
  "anull",
  "anullsrc",
  "apad",
  "aresample",
  "asetpts",
  "asplit",
  "atrim",
  "gblur",
  "color",
  "colorchannelmixer",
  "concat",
  "crop",
  "drawbox",
  "drawtext",
  "ebur128",
  "format",
  "fps",
  "highpass",
  "lowpass",
  "loudnorm",
  "overlay",
  "pad",
  "scale",
  "setpts",
  "setsar",
  "sidechaincompress",
  "sine",
  "split",
  "subtitles",
  "testsrc2",
  "volume",
  "zoompan"
]);
const MEDIA_TOOL_REQUIRED_ENCODERS = Object.freeze(["aac", "h264_mf", "mjpeg", "pcm_s16le", "rawvideo"]);
const MEDIA_TOOL_REQUIRED_MUXERS = Object.freeze(["hash", "image2", "mp4", "null", "rawvideo", "wav"]);
const MEDIA_TOOL_REQUIRED_DEMUXERS = Object.freeze(["concat"]);
const MEDIA_TOOL_REQUIRED_DECODERS = Object.freeze(["aac", "h264", "mjpeg", "pcm_s16le"]);
const MEDIA_TOOL_REQUIRED_BSFS = Object.freeze(["h264_metadata"]);

function resolveBuildPaths(root = desktopDir, { buildRoot: requestedBuildRoot = null } = {}) {
  const resolvedDesktopDir = path.resolve(root);
  const defaultBuildRoot = path.join(resolvedDesktopDir, ".build");
  const buildRoot = requestedBuildRoot ? path.resolve(requestedBuildRoot) : defaultBuildRoot;
  const sourceDir = path.join(resolvedDesktopDir, "sidecars", "content-engine");
  const outputDir = path.join(buildRoot, "content-engine-runtime");
  const sessionPrefix = `ce-${process.pid}-${Date.now()}-${process.hrtime.bigint().toString(36)}`;
  const distDir = path.join(buildRoot, `${sessionPrefix}-d`);
  return {
    desktopDir: resolvedDesktopDir,
    projectDir: path.resolve(resolvedDesktopDir, ".."),
    buildRoot,
    defaultBuildRoot,
    sourceDir,
    packageDir: path.join(sourceDir, "content_engine"),
    assetDir: path.join(sourceDir, "content_engine", "assets"),
    assetManifest: path.join(sourceDir, "content_engine", "assets", "ASSETS.json"),
    bundledFont: path.join(sourceDir, "content_engine", "assets", "fonts", "NotoSansSC-Variable.ttf"),
    entryFile: path.join(sourceDir, "worker.py"),
    outputDir,
    outputExe: path.join(outputDir, "content-engine-worker.exe"),
    manifestFile: path.join(buildRoot, "content-engine-runtime.manifest.json"),
    distDir,
    pyInstallerOutputDir: path.join(distDir, "content-engine-worker"),
    pyInstallerOutputExe: path.join(
      distDir,
      "content-engine-worker",
      "content-engine-worker.exe"
    ),
    workDir: path.join(buildRoot, `${sessionPrefix}-w`),
    specDir: path.join(buildRoot, `${sessionPrefix}-s`),
    selfCheckDataDir: path.join(buildRoot, `${sessionPrefix}-c`)
  };
}

function buildPyInstallerArgs(paths) {
  return [
    "--noconfirm",
    "--onedir",
    "--noupx",
    "--console",
    "--name",
    "content-engine-worker",
    "--paths",
    paths.sourceDir,
    "--add-data",
    `${paths.assetDir}${path.delimiter}content_engine/assets`,
    "--distpath",
    paths.distDir,
    "--workpath",
    paths.workDir,
    "--specpath",
    paths.specDir,
    paths.entryFile
  ];
}

function pythonCandidates(paths, env = process.env) {
  const codexPython = path.join(
    os.homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe"
  );
  const fromPath = spawnSync("where.exe", ["python.exe"], {
    encoding: "utf8",
    windowsHide: true
  });
  const candidates = [
    env.XIAOXI_CONTENT_ENGINE_BUILD_PYTHON,
    env.XIAOXI_BUILD_PYTHON,
    path.join(paths.defaultBuildRoot, "product-detail-venv", "Scripts", "python.exe"),
    codexPython,
    ...(fromPath.status === 0 ? fromPath.stdout.split(/\r?\n/) : [])
  ];
  return [...new Set(candidates.map((value) => String(value || "").trim()).filter(Boolean))];
}

function findBuildPython(paths, env = process.env) {
  for (const candidate of pythonCandidates(paths, env)) {
    if (!fs.existsSync(candidate)) continue;
    const check = spawnSync(
      candidate,
      ["-c", "import sys, PyInstaller; assert sys.version_info >= (3, 10)"],
      { encoding: "utf8", windowsHide: true }
    );
    if (check.status === 0) return candidate;
  }
  throw new Error(
    "Missing Python 3.10+ with PyInstaller. Set XIAOXI_CONTENT_ENGINE_BUILD_PYTHON."
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
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

function validHttpsUrl(value, label) {
  const normalized = nonEmpty(value, label);
  if (!HTTPS_URL_PATTERN.test(normalized)) throw new Error(`${label} must be an explicit HTTPS URL`);
  return normalized;
}

function normalizeRecordPath(value, label) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[a-z]:/iu.test(normalized)
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return normalized;
}

function normalizeRuntimeTarget(value, label) {
  const normalized = normalizeRecordPath(value, label);
  if (normalized.includes("/")) throw new Error(`${label} must be a filename beside FFmpeg`);
  return normalized;
}

function assertReadableFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} is missing: ${file}`);
  }
  return file;
}

function sameWindowsPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function resolveRecordFile(root, relativePath, label) {
  const normalized = normalizeRecordPath(relativePath, label);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (!target.toLowerCase().startsWith(`${resolvedRoot.toLowerCase()}${path.sep}`)) {
    throw new Error(`${label} must stay inside XIAOXI_MEDIA_TOOLS_ROOT`);
  }
  return assertReadableFile(target, label);
}

function compareMediaFileEntries(left, right) {
  return Buffer.compare(Buffer.from(left.targetPath, "utf8"), Buffer.from(right.targetPath, "utf8"));
}

function mediaToolRuntimeTreeSha256(files) {
  const digest = crypto.createHash("sha256");
  const entries = files.map((item) => ({
    file: assertReadableFile(item.file, `Media runtime file ${item.targetPath}`),
    targetPath: normalizeRuntimeTarget(item.targetPath, "Media runtime target path")
  })).sort(compareMediaFileEntries);
  for (const item of entries) {
    digest.update(`file\0${item.targetPath}\0${fs.statSync(item.file).size}\0${sha256(item.file)}\0`, "utf8");
  }
  return digest.digest("hex");
}

function validateMediaToolLicenseRecord(record) {
  assertExactKeys(record, ["schemaVersion", "useType", "tool", "runtime", "notices"], "media tools license record");
  assertExactKeys(record.tool, [
    "product",
    "version",
    "sourceUrl",
    "sourceArtifactPath",
    "sourceArtifactSha256",
    "terms",
    "termsUrl",
    "internalRedistributionBasis",
    "commercialRedistributionBasis",
    "confirmedBy",
    "confirmedDate"
  ], "media tools license record tool");
  assertExactKeys(record.runtime, ["files", "treeSha256"], "media tools license record runtime");
  if (record.schemaVersion !== 1) throw new Error("Unsupported media tools license record schemaVersion");
  if (!new Set(["internal-evaluation", "commercial-delivery"]).has(record.useType)) {
    throw new Error("Media tools license record useType is invalid");
  }
  for (const field of ["product", "version", "terms", "internalRedistributionBasis", "confirmedBy"]) {
    nonEmpty(record.tool[field], `media tools license record tool.${field}`);
  }
  validHttpsUrl(record.tool.sourceUrl, "media tools license record tool.sourceUrl");
  validHttpsUrl(record.tool.termsUrl, "media tools license record tool.termsUrl");
  normalizeRecordPath(record.tool.sourceArtifactPath, "media tools license record tool.sourceArtifactPath");
  if (!SHA256_PATTERN.test(String(record.tool.sourceArtifactSha256 || ""))) {
    throw new Error("Media tools license record tool.sourceArtifactSha256 is invalid");
  }
  validDate(record.tool.confirmedDate, "media tools license record tool.confirmedDate");
  if (record.useType === "commercial-delivery") {
    nonEmpty(record.tool.commercialRedistributionBasis, "media tools commercial redistribution basis");
  } else if (String(record.tool.commercialRedistributionBasis || "").trim()) {
    throw new Error("Internal media tools evidence must not claim a commercial redistribution basis");
  }
  if (!Array.isArray(record.runtime.files) || record.runtime.files.length < 2) {
    throw new Error("Media tools license record must declare at least FFmpeg and ffprobe runtime files");
  }
  const runtimeTargets = new Set();
  const runtimeSources = new Set();
  for (const item of record.runtime.files) {
    assertExactKeys(item, ["sourcePath", "targetPath", "sha256"], "media tools runtime file");
    const sourcePath = normalizeRecordPath(item.sourcePath, "media tools runtime sourcePath");
    const targetPath = normalizeRuntimeTarget(item.targetPath, "media tools runtime targetPath");
    if (!SHA256_PATTERN.test(String(item.sha256 || ""))) {
      throw new Error(`Media tools runtime file hash is invalid: ${targetPath}`);
    }
    if (runtimeSources.has(sourcePath.toLowerCase()) || runtimeTargets.has(targetPath.toLowerCase())) {
      throw new Error("Media tools runtime file paths must be unique");
    }
    runtimeSources.add(sourcePath.toLowerCase());
    runtimeTargets.add(targetPath.toLowerCase());
  }
  for (const required of ["ffmpeg.exe", "ffprobe.exe"]) {
    if (!runtimeTargets.has(required)) throw new Error(`Media tools runtime must declare ${required}`);
  }
  if (!SHA256_PATTERN.test(String(record.runtime.treeSha256 || ""))) {
    throw new Error("Media tools runtime treeSha256 is invalid");
  }
  if (!Array.isArray(record.notices) || record.notices.length === 0) {
    throw new Error("Media tools license record must declare at least one notice file");
  }
  const noticePaths = new Set();
  for (const item of record.notices) {
    assertExactKeys(item, ["sourcePath", "sha256"], "media tools notice");
    const sourcePath = normalizeRecordPath(item.sourcePath, "media tools notice sourcePath");
    if (!SHA256_PATTERN.test(String(item.sha256 || ""))) {
      throw new Error(`Media tools notice hash is invalid: ${sourcePath}`);
    }
    if (noticePaths.has(sourcePath.toLowerCase())) throw new Error("Media tools notice paths must be unique");
    noticePaths.add(sourcePath.toLowerCase());
  }
  return JSON.parse(JSON.stringify(record));
}

function readMediaToolLicenseRecord(recordPath) {
  const absolute = path.resolve(recordPath);
  if (!path.isAbsolute(recordPath)) throw new Error("XIAOXI_MEDIA_TOOLS_LICENSE_RECORD must be an absolute path");
  const record = validateMediaToolLicenseRecord(readJson(assertReadableFile(absolute, "Media tools license record"), "Media tools license record"));
  const canonicalText = canonicalJson(record);
  return {
    canonicalText,
    record,
    sha256: crypto.createHash("sha256").update(canonicalText, "utf8").digest("hex")
  };
}

function collectDeclaredMediaFiles(mediaToolsRoot, record) {
  return record.runtime.files.map((item) => {
    const file = resolveRecordFile(mediaToolsRoot, item.sourcePath, `Media tools runtime source ${item.sourcePath}`);
    if (sha256(file) !== item.sha256) {
      throw new Error(`Media tools runtime hash does not match the license record: ${item.sourcePath}`);
    }
    return {
      file,
      sha256: item.sha256,
      sourcePath: normalizeRecordPath(item.sourcePath, "media tools runtime sourcePath"),
      targetPath: normalizeRuntimeTarget(item.targetPath, "media tools runtime targetPath")
    };
  }).sort(compareMediaFileEntries);
}

function collectDeclaredNoticeFiles(mediaToolsRoot, record) {
  return record.notices.map((item) => {
    const sourcePath = normalizeRecordPath(item.sourcePath, "media tools notice sourcePath");
    const file = resolveRecordFile(mediaToolsRoot, sourcePath, `Media tools notice source ${sourcePath}`);
    if (sha256(file) !== item.sha256) {
      throw new Error(`Media tools notice hash does not match the license record: ${sourcePath}`);
    }
    return { file, sha256: item.sha256, sourcePath };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.sourcePath, "utf8"), Buffer.from(right.sourcePath, "utf8")));
}

function resolveMediaToolSources(env = process.env) {
  const ffmpeg = String(env.XIAOXI_FFMPEG_PATH || "").trim();
  const ffprobe = String(env.XIAOXI_FFPROBE_PATH || "").trim();
  const mediaToolsRoot = String(env.XIAOXI_MEDIA_TOOLS_ROOT || "").trim();
  const licenseRecordPath = String(env.XIAOXI_MEDIA_TOOLS_LICENSE_RECORD || "").trim();
  if (!ffmpeg && !ffprobe) {
    if (mediaToolsRoot || licenseRecordPath) {
      throw new Error("XIAOXI_MEDIA_TOOLS_ROOT and XIAOXI_MEDIA_TOOLS_LICENSE_RECORD require both media tool executable paths.");
    }
    return { available: false, source: "not_configured", ffmpeg: "", ffprobe: "" };
  }
  if (!ffmpeg || !ffprobe) {
    throw new Error("XIAOXI_FFMPEG_PATH and XIAOXI_FFPROBE_PATH must be configured together.");
  }
  if (!mediaToolsRoot || !licenseRecordPath) {
    throw new Error("Bundled media tools require XIAOXI_MEDIA_TOOLS_ROOT and XIAOXI_MEDIA_TOOLS_LICENSE_RECORD.");
  }
  if (!path.isAbsolute(mediaToolsRoot) || !fs.existsSync(mediaToolsRoot) || !fs.statSync(mediaToolsRoot).isDirectory()) {
    throw new Error(`XIAOXI_MEDIA_TOOLS_ROOT is not a directory: ${mediaToolsRoot}`);
  }
  for (const [label, candidate] of [["FFmpeg", ffmpeg], ["ffprobe", ffprobe]]) {
    if (!path.isAbsolute(candidate)) throw new Error(`${label} executable must be an absolute path: ${candidate}`);
    assertReadableFile(path.resolve(candidate), `${label} executable`);
  }
  const licenseRecord = readMediaToolLicenseRecord(licenseRecordPath);
  const root = path.resolve(mediaToolsRoot);
  const sourceArtifact = resolveRecordFile(
    root,
    licenseRecord.record.tool.sourceArtifactPath,
    "Media tools source artifact"
  );
  if (sha256(sourceArtifact) !== licenseRecord.record.tool.sourceArtifactSha256) {
    throw new Error("Media tools source artifact hash does not match the license record.");
  }
  const runtimeFiles = collectDeclaredMediaFiles(root, licenseRecord.record);
  const notices = collectDeclaredNoticeFiles(root, licenseRecord.record);
  const ffmpegEntry = runtimeFiles.find((item) => item.targetPath.toLowerCase() === "ffmpeg.exe");
  const ffprobeEntry = runtimeFiles.find((item) => item.targetPath.toLowerCase() === "ffprobe.exe");
  if (!sameWindowsPath(path.resolve(ffmpeg), ffmpegEntry.file) || !sameWindowsPath(path.resolve(ffprobe), ffprobeEntry.file)) {
    throw new Error("Configured FFmpeg/ffprobe paths must match the versioned media tools license record.");
  }
  const runtimeTreeSha256 = mediaToolRuntimeTreeSha256(runtimeFiles);
  if (runtimeTreeSha256 !== licenseRecord.record.runtime.treeSha256) {
    throw new Error("Media tools runtime tree hash does not match the license record.");
  }
  return {
    available: true,
    ffmpeg: ffmpegEntry.file,
    ffprobe: ffprobeEntry.file,
    licenseRecord,
    mediaToolsRoot: root,
    sourceArtifact,
    notices,
    runtimeFiles,
    source: "explicit"
  };
}

function isolatedMediaToolEnvironment(toolDir, inherited = process.env, fontConfig = null) {
  const systemRoot = String(inherited.SystemRoot || process.env.SystemRoot || "C:\\Windows").trim();
  if (!path.isAbsolute(systemRoot)) throw new Error("Media tools self-check requires an absolute SystemRoot.");
  const system32 = path.join(systemRoot, "System32");
  const tempDirectory = String(inherited.TEMP || os.tmpdir()).trim();
  const configuredFontConfig = String(fontConfig || "").trim();
  const resolvedFontConfig = configuredFontConfig
    ? assertReadableFile(path.resolve(configuredFontConfig), "Media tools Fontconfig configuration")
    : "";
  return {
    ComSpec: String(inherited.ComSpec || path.join(system32, "cmd.exe")),
    PATH: [toolDir, system32, systemRoot].join(path.delimiter),
    PATHEXT: String(inherited.PATHEXT || ".COM;.EXE;.BAT;.CMD"),
    SystemDrive: String(inherited.SystemDrive || path.parse(systemRoot).root),
    SystemRoot: systemRoot,
    TEMP: tempDirectory,
    TMP: String(inherited.TMP || tempDirectory),
    ...(resolvedFontConfig ? {
      FONTCONFIG_FILE: resolvedFontConfig,
      FONTCONFIG_PATH: path.dirname(resolvedFontConfig)
    } : {})
  };
}

function runMediaToolCommand(executable, args, label, { spawn = spawnSync, env = process.env, fontConfig = null } = {}) {
  const toolDir = path.dirname(path.resolve(executable));
  const result = spawn(executable, args, {
    cwd: toolDir,
    encoding: "utf8",
    env: isolatedMediaToolEnvironment(toolDir, env, fontConfig),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || "").trim()
      || String(result.stdout || "").trim()
      || `${label} failed with status ${result.status}`
    );
  }
  return `${String(result.stdout || "")}\n${String(result.stderr || "")}`;
}

function requireToolToken(output, token, label) {
  const expression = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu");
  if (!expression.test(output)) throw new Error(`${label} is missing required capability: ${token}`);
}

function ffmpegVersionToken(output, label) {
  const match = String(output || "").match(/(?:^|\r?\n)ff(?:mpeg|probe) version ([^\s]+)/iu);
  if (!match) throw new Error(`${label} is missing the media tool version token`);
  return match[1];
}

function assertRedistributableFfmpegConfiguration(output, label) {
  const normalized = String(output || "").toLowerCase();
  for (const forbidden of ["--enable-gpl", "--enable-libx264", "--enable-libx265"]) {
    if (normalized.includes(forbidden)) {
      throw new Error(`${label} is GPL-enabled and cannot be bundled in this release runtime: ${forbidden}`);
    }
  }
}

function requireToolVersion(actual, version, label) {
  const expected = nonEmpty(version, "media tools license record version");
  const normalizedActual = nonEmpty(actual, `${label} version`);
  if (normalizedActual !== expected) {
    throw new Error(`${label} does not match the media tools license record version: ${expected}`);
  }
}

function ffmpegFilterPath(file) {
  const escape = String.fromCharCode(92);
  return path.resolve(file)
    .split(path.sep).join("/")
    .replaceAll(":", `${escape}:`)
    .replaceAll("'", `${escape}'`);
}

function assertNonEmptyMediaOutput(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
    throw new Error(`${label} did not produce its expected output`);
  }
}

function parseMediaToolJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} output is not JSON: ${error.message}`);
  }
}

function resolveBundledCreativeFont(runtimeDir) {
  const candidates = [
    path.join(runtimeDir, "_internal", "content_engine", "assets", "fonts", "NotoSansSC-Variable.ttf"),
    path.join(runtimeDir, "content_engine", "assets", "fonts", "NotoSansSC-Variable.ttf")
  ];
  const font = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!font) throw new Error("Packaged media tools smoke requires the bundled NotoSansSC font.");
  return font;
}

function verifyBundledMediaTools(runtimeDir, mediaTools, { spawn = spawnSync, tempRoot = os.tmpdir(), env = process.env } = {}) {
  if (!mediaTools.available) return { status: "skipped" };
  const toolDir = path.join(runtimeDir, "media-tools");
  const declaredFiles = mediaTools.runtime?.files || mediaTools.runtimeFiles;
  const expectedTreeSha256 = mediaTools.runtime?.treeSha256 || mediaTools.licenseRecord?.record?.runtime?.treeSha256;
  if (!Array.isArray(declaredFiles) || !SHA256_PATTERN.test(String(expectedTreeSha256 || ""))) {
    throw new Error("Packaged media tools self-check is missing a declared runtime closure.");
  }
  const runtimeFiles = declaredFiles.map((item) => {
    const targetPath = item.path || item.targetPath;
    return {
      file: path.join(toolDir, targetPath),
      targetPath
    };
  });
  const runtimeTreeSha256 = mediaToolRuntimeTreeSha256(runtimeFiles);
  if (runtimeTreeSha256 !== expectedTreeSha256) {
    throw new Error("Packaged media tools runtime tree hash does not match the license record.");
  }
  const ffmpeg = path.join(toolDir, "ffmpeg.exe");
  const ffprobe = path.join(toolDir, "ffprobe.exe");
  const expectedVersion = String(mediaTools.toolVersion || "").trim();
  if (!expectedVersion) throw new Error("Packaged media tools self-check is missing the recorded tool version.");
  const ffmpegVersion = runMediaToolCommand(ffmpeg, ["-hide_banner", "-version"], "Packaged FFmpeg", { spawn, env });
  requireToolToken(ffmpegVersion, "ffmpeg", "Packaged FFmpeg version output");
  assertRedistributableFfmpegConfiguration(ffmpegVersion, "Packaged FFmpeg version output");
  requireToolVersion(
    ffmpegVersionToken(ffmpegVersion, "Packaged FFmpeg version output"),
    expectedVersion,
    "Packaged FFmpeg version output"
  );
  const ffprobeDistributionVersion = runMediaToolCommand(ffprobe, ["-hide_banner", "-version"], "Packaged ffprobe version", { spawn, env });
  assertRedistributableFfmpegConfiguration(ffprobeDistributionVersion, "Packaged ffprobe version output");
  requireToolVersion(
    ffmpegVersionToken(ffprobeDistributionVersion, "Packaged ffprobe version output"),
    expectedVersion,
    "Packaged ffprobe version output"
  );
  const ffprobeVersion = runMediaToolCommand(ffprobe, ["-v", "error", "-show_program_version", "-of", "json"], "Packaged ffprobe", { spawn, env });
  let ffprobeVersionPayload;
  try {
    ffprobeVersionPayload = JSON.parse(ffprobeVersion);
  } catch (error) {
    throw new Error(`Packaged ffprobe version output is not JSON: ${error.message}`);
  }
  if (!String(ffprobeVersionPayload?.program_version?.version || "").trim()) {
    throw new Error("Packaged ffprobe version output is missing program_version.version");
  }
  requireToolVersion(ffprobeVersionPayload.program_version.version, expectedVersion, "Packaged ffprobe version output");
  const encoders = runMediaToolCommand(ffmpeg, ["-hide_banner", "-encoders"], "Packaged FFmpeg encoders", { spawn, env });
  for (const encoder of MEDIA_TOOL_REQUIRED_ENCODERS) requireToolToken(encoders, encoder, "Packaged FFmpeg encoders");
  const muxers = runMediaToolCommand(ffmpeg, ["-hide_banner", "-muxers"], "Packaged FFmpeg muxers", { spawn, env });
  for (const muxer of MEDIA_TOOL_REQUIRED_MUXERS) requireToolToken(muxers, muxer, "Packaged FFmpeg muxers");
  const demuxers = runMediaToolCommand(ffmpeg, ["-hide_banner", "-demuxers"], "Packaged FFmpeg demuxers", { spawn, env });
  for (const demuxer of MEDIA_TOOL_REQUIRED_DEMUXERS) requireToolToken(demuxers, demuxer, "Packaged FFmpeg demuxers");
  const decoders = runMediaToolCommand(ffmpeg, ["-hide_banner", "-decoders"], "Packaged FFmpeg decoders", { spawn, env });
  for (const decoder of MEDIA_TOOL_REQUIRED_DECODERS) requireToolToken(decoders, decoder, "Packaged FFmpeg decoders");
  const filters = runMediaToolCommand(ffmpeg, ["-hide_banner", "-filters"], "Packaged FFmpeg filters", { spawn, env });
  for (const filter of MEDIA_TOOL_REQUIRED_FILTERS) requireToolToken(filters, filter, "Packaged FFmpeg filters");
  const bsfs = runMediaToolCommand(ffmpeg, ["-hide_banner", "-bsfs"], "Packaged FFmpeg bitstream filters", { spawn, env });
  for (const bsf of MEDIA_TOOL_REQUIRED_BSFS) requireToolToken(bsfs, bsf, "Packaged FFmpeg bitstream filters");

  const smokeDirectory = fs.mkdtempSync(path.join(tempRoot, "xiaoxi-media-tools-"));
  const analysisRaw = path.join(smokeDirectory, "v2-analysis.raw");
  const voiceWave = path.join(smokeDirectory, "v2-voice.wav");
  const canvasVideo = path.join(smokeDirectory, "v2-canvas.mp4");
  const metadataVideo = path.join(smokeDirectory, "v2-canvas-bt709.mp4");
  const masterWave = path.join(smokeDirectory, "v2-master.wav");
  const coverImage = path.join(smokeDirectory, "v2-cover.jpg");
  const concatList = path.join(smokeDirectory, "v2-concat.txt");
  const concatVideo = path.join(smokeDirectory, "v2-concat.mp4");
  const smokeSubtitle = path.join(smokeDirectory, "v2-smoke.srt");
  const measurementFile = path.join(smokeDirectory, "v2-meter.txt");
  try {
    fs.writeFileSync(smokeSubtitle, "1\n00:00:00,000 --> 00:00:00,120\nOK\n", "utf8");
    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi", "-i", "testsrc2=s=64x64:r=25:d=0.2",
      "-vf", "fps=25,scale=32:32,crop=32:32,format=gray",
      "-frames:v", "1",
      "-f", "rawvideo",
      analysisRaw
    ], "Packaged FFmpeg V2 analysis smoke", { spawn, env });
    assertNonEmptyMediaOutput(analysisRaw, "Packaged FFmpeg V2 analysis smoke");

    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=0.2",
      "-t", "0.2",
      "-c:a", "pcm_s16le",
      "-f", "wav",
      voiceWave
    ], "Packaged FFmpeg V2 voice smoke", { spawn, env });
    assertNonEmptyMediaOutput(voiceWave, "Packaged FFmpeg V2 voice smoke");

    const font = resolveBundledCreativeFont(runtimeDir);
    const fontConfig = writeContentEngineFontconfig({
      file: path.join(smokeDirectory, "fontconfig.conf"),
      fontDirectory: path.dirname(font),
      cacheDirectory: path.join(smokeDirectory, "fontconfig-cache")
    });
    const fontOptions = { spawn, env, fontConfig };
    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi", "-i", "testsrc2=s=64x64:r=25:d=0.2",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
      "-filter_complex",
      `[0:v]setpts=PTS-STARTPTS,split=2[bg_src][fg_src];[bg_src]scale=72:128:force_original_aspect_ratio=increase,crop=72:128:(iw-72)/2:(ih-128)/2,gblur=sigma=1:steps=1,setsar=1,fps=25[bg];[fg_src]scale=72:128:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=25[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p,setpts=PTS-STARTPTS,subtitles=filename='${ffmpegFilterPath(smokeSubtitle)}':fontsdir='${ffmpegFilterPath(path.dirname(font))}'[vout]`,
      "-map", "[vout]",
      "-map", "1:a:0",
      "-t", "0.2",
      "-c:v", "h264_mf",
      "-rate_control", "quality",
      "-quality", "80",
      "-scenario", "archive",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      canvasVideo
    ], "Packaged FFmpeg V2 canvas smoke", fontOptions);
    assertNonEmptyMediaOutput(canvasVideo, "Packaged FFmpeg V2 canvas smoke");

    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", canvasVideo,
      "-c", "copy",
      "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      metadataVideo
    ], "Packaged FFmpeg H.264 metadata smoke", { spawn, env });
    assertNonEmptyMediaOutput(metadataVideo, "Packaged FFmpeg H.264 metadata smoke");

    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", voiceWave,
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
      "-filter_complex",
      "[0:a]highpass=f=70,afftdn=nf=-28,acompressor=threshold=-18dB:ratio=2.5:attack=10:release=160:makeup=1.5,aresample=48000:async=1:first_pts=0,asetpts=PTS-STARTPTS,atrim=duration=0.2,apad=pad_dur=0.2,asplit=2[voice_mix][voice_side];[1:a]anull,asetpts=PTS-STARTPTS,loudnorm=I=-26:LRA=11:TP=-2.0,adelay=0|0,volume=-24dB,lowpass=f=1200,afade=t=in:st=0:d=0.04,afade=t=out:st=0.12:d=0.08[bgm];[bgm][voice_side]sidechaincompress=threshold=0.04:ratio=8:attack=10:release=250[ducked];[voice_mix][ducked]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-15:LRA=8:TP=-1.2,alimiter=limit=0.86:attack=5:release=50:level=false[aout]",
      "-map", "[aout]",
      "-t", "0.2",
      "-c:a", "pcm_s16le",
      "-f", "wav",
      masterWave
    ], "Packaged FFmpeg V2 master smoke", { spawn, env });
    assertNonEmptyMediaOutput(masterWave, "Packaged FFmpeg V2 master smoke");

    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", masterWave,
      "-filter:a", `ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file='${ffmpegFilterPath(measurementFile)}'`,
      "-f", "null",
      "-"
    ], "Packaged FFmpeg V2 loudness smoke", { spawn, env });

    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=72x128:r=25:d=0.2",
      "-vf", `scale=72:128,crop=72:128,drawbox=x=4:y=4:w=64:h=120:color=white@0.3:t=fill,drawtext=fontfile='${ffmpegFilterPath(font)}':text='字幕':fontcolor=white:fontsize=18:x=8:y=52`,
      "-frames:v", "1",
      "-c:v", "mjpeg",
      "-f", "image2",
      coverImage
    ], "Packaged FFmpeg V2 cover smoke", fontOptions);
    assertNonEmptyMediaOutput(coverImage, "Packaged FFmpeg V2 cover smoke");

    fs.writeFileSync(concatList, "file 'v2-canvas-bt709.mp4'\nfile 'v2-canvas-bt709.mp4'\n", "utf8");
    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatList,
      "-c", "copy",
      concatVideo
    ], "Packaged FFmpeg concat smoke", { spawn, env });
    assertNonEmptyMediaOutput(concatVideo, "Packaged FFmpeg concat smoke");

    const probeOutput = runMediaToolCommand(ffprobe, [
      "-v", "error",
      "-show_entries", "format=format_name,duration:stream=codec_type,codec_name",
      "-of", "json",
      concatVideo
    ], "Packaged ffprobe V2 concat smoke", { spawn, env });
    const probePayload = parseMediaToolJson(probeOutput, "Packaged ffprobe V2 concat smoke");
    if (!String(probePayload?.format?.format_name || "").split(",").includes("mp4")) {
      throw new Error("Packaged FFmpeg V2 concat smoke did not produce an MP4 container");
    }
    const streams = Array.isArray(probePayload?.streams) ? probePayload.streams : [];
    if (!streams.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264")) {
      throw new Error("Packaged FFmpeg V2 concat smoke is missing H.264 video");
    }
    if (!streams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac")) {
      throw new Error("Packaged FFmpeg V2 concat smoke is missing AAC audio");
    }
    const coverProbeOutput = runMediaToolCommand(ffprobe, [
      "-v", "error",
      "-show_entries", "format=format_name:stream=codec_type,codec_name",
      "-of", "json",
      coverImage
    ], "Packaged ffprobe V2 cover smoke", { spawn, env });
    const coverProbe = parseMediaToolJson(coverProbeOutput, "Packaged ffprobe V2 cover smoke");
    const coverFormatNames = String(coverProbe?.format?.format_name || "").split(",");
    if (!coverFormatNames.some((name) => ["image2", "jpeg_pipe"].includes(name))) {
      throw new Error("Packaged FFmpeg V2 cover smoke did not produce a supported JPEG image container");
    }
    if (!(Array.isArray(coverProbe?.streams) ? coverProbe.streams : []).some((stream) => stream.codec_type === "video" && stream.codec_name === "mjpeg")) {
      throw new Error("Packaged FFmpeg V2 cover smoke is missing MJPEG video");
    }
    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", coverImage,
      "-f", "null",
      "-"
    ], "Packaged FFmpeg V2 MJPEG decode smoke", { spawn, env });
    const hashOutput = runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", concatVideo,
      "-map", "0:v:0",
      "-f", "hash",
      "-"
    ], "Packaged FFmpeg V2 decode hash smoke", { spawn, env });
    if (!/SHA256=/iu.test(hashOutput)) throw new Error("Packaged FFmpeg V2 decode hash smoke did not return SHA256");
    runMediaToolCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", concatVideo,
      "-map", "0:a:0",
      "-f", "null",
      "-"
    ], "Packaged FFmpeg V2 AAC decode smoke", { spawn, env });
  } finally {
    fs.rmSync(smokeDirectory, { recursive: true, force: true });
  }
  return {
    ffprobeVersion: String(ffprobeVersionPayload.program_version.version).trim(),
    status: "passed"
  };
}

function copyMediaToolPackagingAssets(destination) {
  const sourceDir = path.join(desktopDir, "sidecars", "content-engine");
  const targetDir = path.join(destination, "licenses", "project");
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of MEDIA_TOOL_PACKAGING_FILES) {
    fs.copyFileSync(
      assertReadableFile(path.join(sourceDir, name), `Media tools packaging asset ${name}`),
      path.join(targetDir, name)
    );
  }
}

function copyMediaTools(mediaTools, runtimeDir, options = {}) {
  if (!mediaTools.available) return { ...mediaTools, bundled: false, verified: false };
  const destination = path.join(runtimeDir, "media-tools");
  fs.mkdirSync(destination, { recursive: false });
  const copiedRuntimeFiles = mediaTools.runtimeFiles.map((item) => {
    const target = path.join(destination, item.targetPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(item.file, target);
    if (sha256(target) !== item.sha256) {
      throw new Error(`Packaged media tools runtime hash mismatch: ${item.targetPath}`);
    }
    return { file: target, sha256: item.sha256, targetPath: item.targetPath };
  });
  if (mediaToolRuntimeTreeSha256(copiedRuntimeFiles) !== mediaTools.licenseRecord.record.runtime.treeSha256) {
    throw new Error("Packaged media tools runtime tree hash does not match the license record.");
  }
  const noticeDir = path.join(destination, "licenses", "third-party");
  for (const notice of mediaTools.notices) {
    const target = path.join(noticeDir, ...notice.sourcePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(notice.file, target);
    if (sha256(target) !== notice.sha256) {
      throw new Error(`Packaged media tools notice hash mismatch: ${notice.sourcePath}`);
    }
  }
  copyMediaToolPackagingAssets(destination);
  const recordTarget = path.join(destination, "licenses", "license-record.json");
  fs.writeFileSync(recordTarget, mediaTools.licenseRecord.canonicalText, { encoding: "utf8", flag: "wx" });
  if (sha256(recordTarget) !== mediaTools.licenseRecord.sha256) {
    throw new Error("Packaged media tools license record hash mismatch");
  }
  const runtime = {
    files: copiedRuntimeFiles.map((item) => ({ path: item.targetPath, sha256: item.sha256 })),
    path: "media-tools",
    treeSha256: mediaTools.licenseRecord.record.runtime.treeSha256
  };
  const selfCheck = verifyBundledMediaTools(runtimeDir, {
    available: true,
    runtime,
    toolVersion: mediaTools.licenseRecord.record.tool.version
  }, options);
  return {
    available: true,
    bundled: true,
    copiedFiles: copiedRuntimeFiles.map((item) => item.targetPath).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    licenseRecord: {
      ...mediaTools.licenseRecord.record.tool,
      sha256: mediaTools.licenseRecord.sha256,
      useType: mediaTools.licenseRecord.record.useType
    },
    noticeFiles: mediaTools.notices.map((item) => ({ path: item.sourcePath, sha256: item.sha256 })),
    runtime,
    selfCheck,
    source: mediaTools.source,
    verified: selfCheck.status === "passed"
  };
}

function runtimeSourceFiles(paths) {
  const files = [paths.entryFile];
  if (!fs.existsSync(paths.packageDir) || !fs.statSync(paths.packageDir).isDirectory()) {
    return files;
  }
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__pycache__") visit(file);
      } else if (
        entry.isFile()
        && (entry.name.endsWith(".py") || file.startsWith(`${paths.assetDir}${path.sep}`))
      ) {
        files.push(file);
      }
    }
  };
  visit(paths.packageDir);
  return files.sort((left, right) => Buffer.compare(
    Buffer.from(path.relative(paths.sourceDir, left).replaceAll("\\", "/"), "utf8"),
    Buffer.from(path.relative(paths.sourceDir, right).replaceAll("\\", "/"), "utf8")
  ));
}

function sourceTreeSha256(paths) {
  const hash = crypto.createHash("sha256");
  for (const file of runtimeSourceFiles(paths)) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Missing content-engine runtime source: ${file}`);
    }
    const relative = path.relative(paths.sourceDir, file).replaceAll("\\", "/");
    hash.update(relative, "utf8");
    hash.update("\0", "utf8");
    hash.update(fs.readFileSync(file));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function gitText(projectDir, args) {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || `git ${args.join(" ")} failed`);
  }
  return String(result.stdout || "").trim();
}

function collectSourceProvenance(paths, readGit = gitText) {
  const relativeSource = path.relative(paths.projectDir, paths.sourceDir).replaceAll("\\", "/");
  const commit = readGit(paths.projectDir, ["rev-parse", "HEAD"]);
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("Content-engine build requires a full Git source commit");
  }
  return {
    commit,
    dirty: Boolean(readGit(paths.projectDir, ["status", "--porcelain", "--untracked-files=all", "--", relativeSource])),
    treeSha256: sourceTreeSha256(paths)
  };
}

function parseProtocolOutput(stdout, label = "Content-engine runtime self-check") {
  const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.trim());
  const payloads = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} returned invalid JSON on line ${index + 1}: ${error.message}`);
    }
  });
  if (payloads.length !== 3) {
    throw new Error(`${label} must return ready, health, and shutdown JSON lines`);
  }
  const [ready, health, shutdown] = payloads;
  if (
    ready?.type !== "ready"
    || ready?.service !== "content-engine"
    || ready?.protocol_version !== 1
    || !String(ready.version || "").trim()
  ) {
    throw new Error(`${label} returned an invalid ready payload`);
  }
  if (
    health?.id !== "build-health"
    || health?.ok !== true
    || health?.result?.status !== "ok"
    || health?.result?.storage !== "sqlite"
  ) {
    throw new Error(`${label} returned an invalid health response`);
  }
  if (
    shutdown?.id !== "build-shutdown"
    || shutdown?.ok !== true
    || shutdown?.result?.status !== "stopping"
  ) {
    throw new Error(`${label} returned an invalid shutdown response`);
  }
  return { ready, health, shutdown };
}

function runRuntimeSelfCheck({
  executable,
  runtimeDir,
  dataDir,
  spawn = spawnSync,
  label = "Content-engine runtime self-check"
}) {
  if (fs.existsSync(dataDir)) {
    throw new Error(`${label} data directory must be fresh: ${dataDir}`);
  }
  const requestInput = [
    JSON.stringify({ id: "build-health", method: "health", params: {} }),
    JSON.stringify({ id: "build-shutdown", method: "shutdown", params: {} }),
    ""
  ].join("\n");
  const result = spawn(
    executable,
    ["--data-dir", dataDir],
    {
      cwd: runtimeDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1"
      },
      input: requestInput,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120000,
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || "").trim()
      || String(result.stdout || "").trim()
      || `${label} failed with status ${result.status}`
    );
  }
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error(`${label} did not initialize its fresh data directory`);
  }
  return parseProtocolOutput(result.stdout, label);
}

function mediaToolsManifestValue(mediaTools) {
  if (!mediaTools.available) {
    return {
      schemaVersion: 1,
      bundled: false,
      verified: false,
      source: "not_configured",
      runtime: null,
      licenseRecord: { present: false },
      notices: [],
      selfCheck: { status: "skipped" }
    };
  }
  if (!mediaTools.bundled || !mediaTools.verified || mediaTools.selfCheck?.status !== "passed") {
    throw new Error("Bundled media tools must pass their self-check before the runtime manifest is written.");
  }
  return {
    schemaVersion: 1,
    bundled: true,
    verified: true,
    source: mediaTools.source,
    runtime: {
      files: mediaTools.runtime.files.map((item) => ({ path: item.path, sha256: item.sha256 })),
      path: mediaTools.runtime.path,
      treeSha256: mediaTools.runtime.treeSha256
    },
    licenseRecord: {
      present: true,
      useType: mediaTools.licenseRecord.useType,
      product: mediaTools.licenseRecord.product,
      version: mediaTools.licenseRecord.version,
      sourceUrl: mediaTools.licenseRecord.sourceUrl,
      sourceArtifactPath: mediaTools.licenseRecord.sourceArtifactPath,
      sourceArtifactSha256: mediaTools.licenseRecord.sourceArtifactSha256,
      terms: mediaTools.licenseRecord.terms,
      termsUrl: mediaTools.licenseRecord.termsUrl,
      internalRedistributionBasis: mediaTools.licenseRecord.internalRedistributionBasis,
      commercialRedistributionBasis: mediaTools.licenseRecord.commercialRedistributionBasis,
      confirmedBy: mediaTools.licenseRecord.confirmedBy,
      confirmedDate: mediaTools.licenseRecord.confirmedDate,
      sha256: mediaTools.licenseRecord.sha256
    },
    notices: mediaTools.noticeFiles.map((item) => ({ path: item.path, sha256: item.sha256 })),
    selfCheck: {
      ffprobeVersion: mediaTools.selfCheck.ffprobeVersion,
      status: "passed"
    }
  };
}

function validateMediaToolsManifest(mediaTools, { artifactType = null } = {}) {
  assertExactKeys(mediaTools, [
    "schemaVersion",
    "bundled",
    "verified",
    "source",
    "runtime",
    "licenseRecord",
    "notices",
    "selfCheck"
  ], "content-engine media tools manifest");
  if (mediaTools.schemaVersion !== 1) throw new Error("Content-engine media tools manifest schema is unsupported");
  if (!mediaTools.bundled || !mediaTools.verified) {
    if (
      mediaTools.bundled !== false
      || mediaTools.verified !== false
      || mediaTools.source !== "not_configured"
      || mediaTools.runtime !== null
      || JSON.stringify(mediaTools.licenseRecord) !== JSON.stringify({ present: false })
      || !Array.isArray(mediaTools.notices)
      || mediaTools.notices.length !== 0
      || JSON.stringify(mediaTools.selfCheck) !== JSON.stringify({ status: "skipped" })
    ) {
      throw new Error("Unbundled content-engine media tools manifest is inconsistent");
    }
    return JSON.parse(JSON.stringify(mediaTools));
  }
  if (mediaTools.source !== "explicit") throw new Error("Bundled media tools source is invalid");
  assertExactKeys(mediaTools.runtime, ["files", "path", "treeSha256"], "content-engine media tools runtime");
  if (mediaTools.runtime.path !== "media-tools" || !SHA256_PATTERN.test(String(mediaTools.runtime.treeSha256 || ""))) {
    throw new Error("Bundled media tools runtime metadata is invalid");
  }
  if (!Array.isArray(mediaTools.runtime.files) || mediaTools.runtime.files.length < 2) {
    throw new Error("Bundled media tools runtime file list is incomplete");
  }
  const runtimeNames = new Set();
  for (const item of mediaTools.runtime.files) {
    assertExactKeys(item, ["path", "sha256"], "content-engine media tools runtime file");
    const name = normalizeRuntimeTarget(item.path, "content-engine media tools runtime file path");
    if (!SHA256_PATTERN.test(String(item.sha256 || ""))) {
      throw new Error(`Bundled media tools runtime file hash is invalid: ${name}`);
    }
    if (runtimeNames.has(name.toLowerCase())) throw new Error("Bundled media tools runtime file paths must be unique");
    runtimeNames.add(name.toLowerCase());
  }
  for (const required of ["ffmpeg.exe", "ffprobe.exe"]) {
    if (!runtimeNames.has(required)) throw new Error(`Bundled media tools runtime is missing ${required}`);
  }
  assertExactKeys(mediaTools.licenseRecord, [
    "present",
    "useType",
    "product",
    "version",
    "sourceUrl",
    "sourceArtifactPath",
    "sourceArtifactSha256",
    "terms",
    "termsUrl",
    "internalRedistributionBasis",
    "commercialRedistributionBasis",
    "confirmedBy",
    "confirmedDate",
    "sha256"
  ], "content-engine media tools license record summary");
  if (mediaTools.licenseRecord.present !== true || !new Set(["internal-evaluation", "commercial-delivery"]).has(mediaTools.licenseRecord.useType)) {
    throw new Error("Bundled media tools license record summary is invalid");
  }
  for (const field of ["product", "version", "terms", "internalRedistributionBasis", "confirmedBy"]) {
    nonEmpty(mediaTools.licenseRecord[field], `content-engine media tools license record ${field}`);
  }
  validHttpsUrl(mediaTools.licenseRecord.sourceUrl, "content-engine media tools license record sourceUrl");
  validHttpsUrl(mediaTools.licenseRecord.termsUrl, "content-engine media tools license record termsUrl");
  normalizeRecordPath(mediaTools.licenseRecord.sourceArtifactPath, "content-engine media tools license record sourceArtifactPath");
  validDate(mediaTools.licenseRecord.confirmedDate, "content-engine media tools license record confirmedDate");
  for (const field of ["sha256", "sourceArtifactSha256"]) {
    if (!SHA256_PATTERN.test(String(mediaTools.licenseRecord[field] || ""))) {
      throw new Error(`Content-engine media tools license record ${field} is invalid`);
    }
  }
  if (mediaTools.licenseRecord.useType === "commercial-delivery") {
    nonEmpty(mediaTools.licenseRecord.commercialRedistributionBasis, "content-engine media tools commercial redistribution basis");
  } else if (String(mediaTools.licenseRecord.commercialRedistributionBasis || "").trim()) {
    throw new Error("Internal content-engine media tools evidence must not claim a commercial redistribution basis");
  }
  if (!Array.isArray(mediaTools.notices) || mediaTools.notices.length === 0) {
    throw new Error("Bundled media tools license notices are incomplete");
  }
  const noticePaths = new Set();
  for (const item of mediaTools.notices) {
    assertExactKeys(item, ["path", "sha256"], "content-engine media tools notice");
    const noticePath = normalizeRecordPath(item.path, "content-engine media tools notice path");
    if (!SHA256_PATTERN.test(String(item.sha256 || ""))) {
      throw new Error(`Bundled media tools notice hash is invalid: ${noticePath}`);
    }
    if (noticePaths.has(noticePath.toLowerCase())) throw new Error("Bundled media tools notice paths must be unique");
    noticePaths.add(noticePath.toLowerCase());
  }
  assertExactKeys(mediaTools.selfCheck, ["ffprobeVersion", "status"], "content-engine media tools self-check");
  if (mediaTools.selfCheck.status !== "passed" || !String(mediaTools.selfCheck.ffprobeVersion || "").trim()) {
    throw new Error("Bundled media tools self-check proof is invalid");
  }
  if (artifactType === "delivery" && mediaTools.licenseRecord.useType !== "commercial-delivery") {
    throw new Error("Delivery requires a commercial media tools redistribution record");
  }
  if (!artifactType || artifactType === "internal-evaluation" || artifactType === "delivery") {
    return JSON.parse(JSON.stringify(mediaTools));
  }
  throw new Error(`Unsupported content-engine media tools artifact type: ${artifactType}`);
}

function assertMatchingMediaFileClosure(manifestEntries, recordEntries, label, normalizePath) {
  if (manifestEntries.length !== recordEntries.length) {
    throw new Error(`Packaged media tools ${label} closure does not match its license record`);
  }
  const normalizedManifest = manifestEntries.map((item) => ({
    path: normalizePath(item.path, `content-engine media tools ${label} manifest path`),
    sha256: item.sha256
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  const normalizedRecord = recordEntries.map((item) => ({
    path: normalizePath(item.path, `content-engine media tools ${label} license record path`),
    sha256: item.sha256
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  for (let index = 0; index < normalizedManifest.length; index += 1) {
    const expected = normalizedManifest[index];
    const actual = normalizedRecord[index];
    if (expected.path !== actual.path || expected.sha256 !== actual.sha256) {
      throw new Error(`Packaged media tools ${label} closure does not match its license record`);
    }
  }
}

function assertPackagedMediaToolRecordMatchesManifest(packagedRecord, manifest) {
  if (packagedRecord.useType !== manifest.licenseRecord.useType) {
    throw new Error("Packaged media tools license record does not match its manifest summary");
  }
  for (const field of [
    "product",
    "version",
    "sourceUrl",
    "sourceArtifactPath",
    "sourceArtifactSha256",
    "terms",
    "termsUrl",
    "internalRedistributionBasis",
    "commercialRedistributionBasis",
    "confirmedBy",
    "confirmedDate"
  ]) {
    if (packagedRecord.tool[field] !== manifest.licenseRecord[field]) {
      throw new Error("Packaged media tools license record does not match its manifest summary");
    }
  }
  if (packagedRecord.runtime.treeSha256 !== manifest.runtime.treeSha256) {
    throw new Error("Packaged media tools runtime closure does not match its license record");
  }
  assertMatchingMediaFileClosure(
    manifest.runtime.files,
    packagedRecord.runtime.files.map((item) => ({ path: item.targetPath, sha256: item.sha256 })),
    "runtime",
    normalizeRuntimeTarget
  );
  assertMatchingMediaFileClosure(
    manifest.notices,
    packagedRecord.notices.map((item) => ({ path: item.sourcePath, sha256: item.sha256 })),
    "notice",
    normalizeRecordPath
  );
}

function verifyBundledMediaToolFiles(runtimeDir, mediaTools) {
  const manifest = validateMediaToolsManifest(mediaTools);
  const toolDir = path.join(runtimeDir, "media-tools");
  if (!manifest.bundled) {
    if (fs.existsSync(toolDir)) throw new Error("Unbundled content-engine runtime unexpectedly contains media tools");
    return manifest;
  }
  const runtimeFiles = manifest.runtime.files.map((item) => {
    const file = assertReadableFile(path.join(toolDir, item.path), `Packaged media tools runtime ${item.path}`);
    if (sha256(file) !== item.sha256) throw new Error(`Packaged media tools runtime hash mismatch: ${item.path}`);
    return { file, targetPath: item.path };
  });
  if (mediaToolRuntimeTreeSha256(runtimeFiles) !== manifest.runtime.treeSha256) {
    throw new Error("Packaged media tools runtime tree hash mismatch");
  }
  const recordFile = assertReadableFile(path.join(toolDir, "licenses", "license-record.json"), "Packaged media tools license record");
  if (sha256(recordFile) !== manifest.licenseRecord.sha256) {
    throw new Error("Packaged media tools license record hash mismatch");
  }
  const packagedRecord = validateMediaToolLicenseRecord(readJson(recordFile, "Packaged media tools license record"));
  assertPackagedMediaToolRecordMatchesManifest(packagedRecord, manifest);
  for (const notice of manifest.notices) {
    const file = assertReadableFile(
      path.join(toolDir, "licenses", "third-party", ...notice.path.split("/")),
      `Packaged media tools notice ${notice.path}`
    );
    if (sha256(file) !== notice.sha256) throw new Error(`Packaged media tools notice hash mismatch: ${notice.path}`);
  }
  for (const name of MEDIA_TOOL_PACKAGING_FILES) {
    assertReadableFile(path.join(toolDir, "licenses", "project", name), `Packaged media tools project license asset ${name}`);
  }
  return manifest;
}

function buildManifest({
  outputDir,
  outputExe,
  version,
  source,
  builtAt,
  mediaTools = { available: false, source: "not_configured", bundled: false, verified: false }
}) {
  if (!fs.existsSync(outputExe) || !fs.statSync(outputExe).isFile()) {
    throw new Error(`Content-engine runtime executable is missing: ${outputExe}`);
  }
  if (!COMMIT_PATTERN.test(String(source?.commit || ""))) {
    throw new Error("Content-engine runtime manifest requires a full source commit");
  }
  if (!SHA256_PATTERN.test(String(source?.treeSha256 || ""))) {
    throw new Error("Content-engine runtime manifest requires a source tree hash");
  }
  const mediaToolsManifest = mediaToolsManifestValue(mediaTools);
  return {
    schemaVersion: 2,
    version,
    builtAt: builtAt || new Date().toISOString(),
    source: {
      commit: source.commit,
      dirty: Boolean(source.dirty),
      treeSha256: source.treeSha256
    },
    runtime: {
      kind: "pyinstaller-onedir",
      entry: path.basename(outputExe),
      exeSha256: sha256(outputExe),
      treeSha256: treeSha256(outputDir)
    },
    capabilities: {
      mixRender: {
        available: mediaToolsManifest.verified === true,
        bundled: mediaToolsManifest.bundled === true,
        source: mediaToolsManifest.source
      }
    },
    mediaTools: mediaToolsManifest,
    selfCheck: {
      protocolVersion: 1,
      ready: true,
      health: true,
      shutdown: true
    }
  };
}

function assertBuildInputs(paths) {
  for (const required of [
    paths.entryFile,
    paths.packageDir,
    paths.assetDir,
    paths.assetManifest,
    paths.bundledFont
  ]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing content-engine build input: ${required}`);
    }
  }
}

function assertFreshOutput(paths) {
  const existing = [paths.outputDir, paths.manifestFile].filter((target) =>
    fs.existsSync(target)
  );
  if (existing.length > 0) {
    throw new Error(
      `Refusing to overwrite existing content-engine build artifacts: ${existing.join(", ")}`
    );
  }
}

function main({ buildRoot = process.env.XIAOXI_SIDECAR_BUILD_ROOT || null } = {}) {
  const paths = resolveBuildPaths(desktopDir, { buildRoot });
  assertBuildInputs(paths);
  fs.mkdirSync(paths.buildRoot, { recursive: true });
  assertFreshOutput(paths);
  fs.mkdirSync(paths.specDir, { recursive: true });

  const sourceBefore = collectSourceProvenance(paths);
  const python = findBuildPython(paths);
  const mediaToolSources = resolveMediaToolSources(process.env);
  console.log(`Building content-engine sidecar with ${python}`);
  const result = spawnSync(
    python,
    ["-m", "PyInstaller", ...buildPyInstallerArgs(paths)],
    {
      cwd: paths.desktopDir,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1"
      },
      stdio: "inherit",
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Content-engine PyInstaller build failed with status ${result.status}`);
  }
  if (!fs.existsSync(paths.pyInstallerOutputExe)) {
    throw new Error("PyInstaller did not produce content-engine-worker.exe");
  }

  const session = runRuntimeSelfCheck({
    executable: paths.pyInstallerOutputExe,
    runtimeDir: paths.pyInstallerOutputDir,
    dataDir: paths.selfCheckDataDir
  });
  const sourceAfter = collectSourceProvenance(paths);
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    throw new Error("Content-engine source changed while the runtime was being built");
  }

  const mediaTools = copyMediaTools(mediaToolSources, paths.pyInstallerOutputDir);
  verifyBundledMediaToolFiles(paths.pyInstallerOutputDir, mediaToolsManifestValue(mediaTools));
  const manifest = buildManifest({
    outputDir: paths.pyInstallerOutputDir,
    outputExe: paths.pyInstallerOutputExe,
    version: session.ready.version,
    source: sourceBefore,
    mediaTools
  });
  fs.renameSync(paths.pyInstallerOutputDir, paths.outputDir);
  fs.writeFileSync(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  console.log(`Content-engine sidecar built and verified: ${paths.outputExe}`);
  console.log(`Manifest: ${paths.manifestFile}`);
  return manifest;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  assertBuildInputs,
  assertRedistributableFfmpegConfiguration,
  assertFreshOutput,
  buildManifest,
  buildPyInstallerArgs,
  copyMediaTools,
  collectSourceProvenance,
  findBuildPython,
  main,
  mediaToolRuntimeTreeSha256,
  mediaToolsManifestValue,
  parseProtocolOutput,
  pythonCandidates,
  readMediaToolLicenseRecord,
  resolveBuildPaths,
  resolveMediaToolSources,
  runRuntimeSelfCheck,
  runtimeSourceFiles,
  sourceTreeSha256,
  validateMediaToolLicenseRecord,
  validateMediaToolsManifest,
  verifyBundledMediaToolFiles,
  verifyBundledMediaTools
};
