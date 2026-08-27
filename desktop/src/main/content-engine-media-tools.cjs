const fs = require("node:fs");
const path = require("node:path");

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
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

function resolveContentEngineFontDirectory(runtimePath) {
  const runtimeDirectory = path.dirname(path.resolve(runtimePath));
  const candidates = [
    path.join(runtimeDirectory, "_internal", "content_engine", "assets", "fonts"),
    path.join(runtimeDirectory, "content_engine", "assets", "fonts")
  ];
  const directory = candidates.find(isDirectory);
  if (!directory) {
    throw new Error("Packaged content-engine Fontconfig requires the bundled font directory");
  }
  return directory;
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

function resolveContentEngineMediaToolsEnvironment({ runtimePath, isPackaged, dataDir = "" }) {
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
  if (!path.isAbsolute(runtimeDataDirectory)) {
    throw new Error("Packaged content-engine Fontconfig requires an absolute data directory");
  }
  const fontconfigDirectory = path.join(path.resolve(runtimeDataDirectory), "fontconfig");
  environment.FONTCONFIG_FILE = writeContentEngineFontconfig({
    file: path.join(fontconfigDirectory, "fonts.conf"),
    fontDirectory: resolveContentEngineFontDirectory(executable),
    cacheDirectory: path.join(fontconfigDirectory, "cache")
  });
  environment.FONTCONFIG_PATH = fontconfigDirectory;
  return environment;
}

module.exports = {
  resolveContentEngineMediaToolsEnvironment,
  writeContentEngineFontconfig
};
