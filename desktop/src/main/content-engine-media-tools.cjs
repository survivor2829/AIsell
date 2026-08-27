const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isAsciiPath(candidate) {
  return /^[\x20-\x7e]+$/u.test(String(candidate || ""));
}

function fontconfigPath(value) {
  return path.resolve(value).split(path.sep).join("/");
}

function escapeFontconfigXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function resolveContentEngineBundledFont(runtimePath) {
  const runtimeDirectory = path.dirname(path.resolve(runtimePath));
  const candidates = [
    path.join(runtimeDirectory, "_internal", "content_engine", "assets", "fonts", "NotoSansSC-Variable.ttf"),
    path.join(runtimeDirectory, "content_engine", "assets", "fonts", "NotoSansSC-Variable.ttf")
  ];
  const font = candidates.find(isFile);
  if (!font) {
    throw new Error("Packaged content-engine Fontconfig requires the bundled Noto font");
  }
  return font;
}

function resolveFontconfigRuntimeDirectory({ runtimePath, dataDir, temporaryDirectory = os.tmpdir() }) {
  const configuredTemporaryDirectory = String(temporaryDirectory || "").trim();
  if (!configuredTemporaryDirectory || !path.isAbsolute(configuredTemporaryDirectory)) {
    throw new Error("Packaged content-engine Fontconfig requires an absolute temporary directory");
  }
  const dataIdentity = String(dataDir || "").trim();
  if (!dataIdentity || !path.isAbsolute(dataIdentity)) {
    throw new Error("Packaged content-engine Fontconfig requires an absolute data directory");
  }
  const runtimeRoot = path.resolve(configuredTemporaryDirectory);
  const identity = crypto.createHash("sha256")
    .update(`${path.resolve(runtimePath)}\u0000${path.resolve(dataIdentity)}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  const directory = path.join(runtimeRoot, "xiaoxi-fontconfig", identity);
  if (!isAsciiPath(directory)) {
    throw new Error("Packaged content-engine Fontconfig requires an ASCII-safe temporary directory");
  }
  return directory;
}

function materializeContentEngineFont(runtimePath, fontDirectory) {
  const source = resolveContentEngineBundledFont(runtimePath);
  const destinationDirectory = path.resolve(fontDirectory);
  const destination = path.join(destinationDirectory, path.basename(source));
  fs.mkdirSync(destinationDirectory, { recursive: true });
  if (!isFile(destination) || fs.statSync(destination).size !== fs.statSync(source).size) {
    fs.copyFileSync(source, destination);
  }
  return destination;
}

function writeContentEngineFontconfig({ file, fontDirectory, cacheDirectory }) {
  const fileValue = String(file || "").trim();
  const fontValue = String(fontDirectory || "").trim();
  const cacheValue = String(cacheDirectory || "").trim();
  if (!fileValue || !fontValue || !cacheValue || !path.isAbsolute(fileValue) || !path.isAbsolute(fontValue) || !path.isAbsolute(cacheValue)) {
    throw new Error("Content-engine Fontconfig requires absolute bundled font and cache paths");
  }
  const configFile = path.resolve(fileValue);
  const fonts = path.resolve(fontValue);
  const cache = path.resolve(cacheValue);
  if (!isDirectory(fonts)) {
    throw new Error("Content-engine Fontconfig requires an existing bundled font directory");
  }
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(configFile, [
    '<?xml version="1.0"?>',
    "<fontconfig>",
    `  <dir>${escapeFontconfigXml(fontconfigPath(fonts))}</dir>`,
    `  <cachedir>${escapeFontconfigXml(fontconfigPath(cache))}</cachedir>`,
    "  <config><rescan><int>0</int></rescan></config>",
    "</fontconfig>",
    ""
  ].join("\n"), "utf8");
  return configFile;
}

function resolveContentEngineMediaToolsEnvironment({
  runtimePath,
  isPackaged,
  dataDir = "",
  temporaryDirectory = os.tmpdir()
}) {
  if (!isPackaged) return {};
  const executable = String(runtimePath || "").trim();
  if (!path.isAbsolute(executable)) {
    throw new Error("Packaged content-engine media tools require an absolute runtime path");
  }
  const toolsDirectory = path.join(path.dirname(executable), "media-tools");
  const environment = {
    XIAOXI_FFMPEG_PATH: path.join(toolsDirectory, "ffmpeg.exe"),
    XIAOXI_FFPROBE_PATH: path.join(toolsDirectory, "ffprobe.exe")
  };
  const runtimeDataDirectory = String(dataDir || "").trim();
  if (!runtimeDataDirectory) return environment;
  const fontconfigDirectory = resolveFontconfigRuntimeDirectory({
    runtimePath: executable,
    dataDir: runtimeDataDirectory,
    temporaryDirectory
  });
  const fontDirectory = path.join(fontconfigDirectory, "fonts");
  environment.XIAOXI_CREATIVE_FONT_PATH = materializeContentEngineFont(executable, fontDirectory);
  environment.FONTCONFIG_FILE = writeContentEngineFontconfig({
    file: path.join(fontconfigDirectory, "fonts.conf"),
    fontDirectory,
    cacheDirectory: path.join(fontconfigDirectory, "cache")
  });
  environment.FONTCONFIG_PATH = fontconfigDirectory;
  return environment;
}

module.exports = {
  resolveContentEngineMediaToolsEnvironment,
  writeContentEngineFontconfig
};
