const fs = require("node:fs");
const path = require("node:path");

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".docx"]);

class AiExpertError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function emptyStatus() {
  return { configured: false, fileName: "", extension: "", importedAt: "" };
}

function normalizeExpertText(value) {
  return String(value || "")
    .replace(/^\ufeff/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\0/g, "")
    .trim();
}

function createAiExpertStore({ rootDir, now = () => new Date(), mammothImpl } = {}) {
  const stateFile = path.join(String(rootDir || ""), "ai-expert.json");

  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return value?.version === 1 && typeof value.text === "string" ? value : null;
    } catch {
      return null;
    }
  }

  function statusFrom(value) {
    if (!value) return emptyStatus();
    return {
      configured: true,
      fileName: String(value.fileName || ""),
      extension: String(value.extension || ""),
      importedAt: String(value.importedAt || "")
    };
  }

  function status() {
    return statusFrom(load());
  }

  function read() {
    const value = load();
    return value ? { ...statusFrom(value), text: value.text } : { ...emptyStatus(), text: "" };
  }

  async function importFile(filePath, options = {}) {
    const source = path.resolve(String(filePath || ""));
    const extension = path.extname(source).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new AiExpertError("AI_EXPERT_FILE_TYPE", "仅支持 .txt、.md 和 .docx 话术文件");
    }
    let fileStat;
    try {
      fileStat = fs.statSync(source);
    } catch {
      throw new AiExpertError("AI_EXPERT_FILE_MISSING", "选择的话术文件不存在或无法读取");
    }
    if (!fileStat.isFile()) throw new AiExpertError("AI_EXPERT_FILE_MISSING", "请选择一个话术文件");
    if (fileStat.size > MAX_FILE_BYTES) throw new AiExpertError("AI_EXPERT_FILE_TOO_LARGE", "话术文件不能超过 5MB");

    let rawText;
    if (extension === ".docx") {
      const mammoth = mammothImpl || require("mammoth");
      const result = await mammoth.extractRawText({ path: source });
      rawText = result?.value;
    } else {
      rawText = fs.readFileSync(source, "utf8");
    }
    const text = normalizeExpertText(rawText);
    if (!text) throw new AiExpertError("AI_EXPERT_EMPTY", "话术文件没有可用文字");
    if (text.length > MAX_TEXT_CHARS) throw new AiExpertError("AI_EXPERT_TEXT_TOO_LONG", "规范化后的话术文字不能超过 5 万字符");
    options.beforeCommit?.();

    const value = {
      version: 1,
      fileName: path.basename(source),
      extension,
      importedAt: now().toISOString(),
      text
    };
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), "utf8");
      fs.renameSync(temporary, stateFile);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    return statusFrom(value);
  }

  function remove() {
    fs.rmSync(stateFile, { force: true });
    return emptyStatus();
  }

  return { importFile, read, remove, status };
}

module.exports = {
  AiExpertError,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  createAiExpertStore,
  normalizeExpertText
};
