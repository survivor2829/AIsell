const path = require("node:path");

function resolveContentEngineMediaToolsEnvironment({ runtimePath, isPackaged }) {
  if (!isPackaged) return {};
  const executable = String(runtimePath || "").trim();
  if (!path.isAbsolute(executable)) {
    throw new Error("Packaged content-engine media tools require an absolute runtime path");
  }
  const toolsDirectory = path.join(path.dirname(executable), "media-tools");
  return {
    XIAOXI_FFMPEG_PATH: path.join(toolsDirectory, "ffmpeg.exe"),
    XIAOXI_FFPROBE_PATH: path.join(toolsDirectory, "ffprobe.exe")
  };
}

module.exports = {
  resolveContentEngineMediaToolsEnvironment
};
