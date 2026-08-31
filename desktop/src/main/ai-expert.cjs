const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-file.cjs");

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".docx"]);
const AI_EXPERT_KINDS = Object.freeze(["expert_rules", "business_knowledge"]);
const KIND_TO_FIELD = Object.freeze({
  expert_rules: "expertRules",
  business_knowledge: "businessKnowledge"
});

class AiExpertError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function emptySlotStatus() {
  return { configured: false, fileName: "", importedAt: "" };
}

function assertAiExpertKind(value) {
  const kind = String(value || "");
  if (!Object.hasOwn(KIND_TO_FIELD, kind)) {
    throw new AiExpertError("AI_EXPERT_KIND", "请选择要管理的专家资料类型");
  }
  return kind;
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

  function storedDocument(value) {
    if (!value || typeof value.text !== "string" || !value.text) return null;
    return {
      fileName: String(value.fileName || ""),
      importedAt: String(value.importedAt || ""),
      text: value.text
    };
  }

  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (value?.version === 1 && typeof value.text === "string") {
        return {
          version: 1,
          expertRules: storedDocument(value),
          businessKnowledge: null
        };
      }
      if (value?.version === 2) {
        return {
          version: 2,
          expertRules: storedDocument(value.expertRules),
          businessKnowledge: storedDocument(value.businessKnowledge)
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  function slotStatus(value) {
    if (!value) return emptySlotStatus();
    return {
      configured: true,
      fileName: String(value.fileName || ""),
      importedAt: String(value.importedAt || "")
    };
  }

  function statusFrom(value) {
    const expertRules = slotStatus(value?.expertRules);
    const businessKnowledge = slotStatus(value?.businessKnowledge);
    return {
      expertRules,
      businessKnowledge,
      ready: expertRules.configured && businessKnowledge.configured
    };
  }

  function status() {
    return statusFrom(load());
  }

  function read() {
    const value = load();
    const publicStatus = statusFrom(value);
    return {
      expertRules: {
        ...publicStatus.expertRules,
        text: String(value?.expertRules?.text || "")
      },
      businessKnowledge: {
        ...publicStatus.businessKnowledge,
        text: String(value?.businessKnowledge?.text || "")
      },
      ready: publicStatus.ready
    };
  }

  function persist(value) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeJsonAtomic(stateFile, {
      version: 2,
      expertRules: value?.expertRules || null,
      businessKnowledge: value?.businessKnowledge || null
    }, { trailingNewline: false });
  }

  async function importFile(kindValue, filePath, options = {}) {
    const kind = assertAiExpertKind(kindValue);
    const field = KIND_TO_FIELD[kind];
    const source = path.resolve(String(filePath || ""));
    const extension = path.extname(source).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new AiExpertError("AI_EXPERT_FILE_TYPE", "仅支持 .txt、.md 和 .docx 专家资料");
    }
    let fileStat;
    try {
      fileStat = fs.statSync(source);
    } catch {
      throw new AiExpertError("AI_EXPERT_FILE_MISSING", "选择的专家资料不存在或无法读取");
    }
    if (!fileStat.isFile()) throw new AiExpertError("AI_EXPERT_FILE_MISSING", "请选择一个专家资料文件");
    if (fileStat.size > MAX_FILE_BYTES) throw new AiExpertError("AI_EXPERT_FILE_TOO_LARGE", "单份专家资料不能超过 5MB");

    let rawText;
    if (extension === ".docx") {
      const mammoth = mammothImpl || require("mammoth");
      const result = await mammoth.extractRawText({ path: source });
      rawText = result?.value;
    } else {
      rawText = fs.readFileSync(source, "utf8");
    }
    const text = normalizeExpertText(rawText);
    if (!text) throw new AiExpertError("AI_EXPERT_EMPTY", "专家资料没有可用文字");
    if (text.length > MAX_TEXT_CHARS) {
      throw new AiExpertError("AI_EXPERT_TEXT_TOO_LONG", "两份专家资料的文字合计不能超过 5 万字符");
    }
    options.beforeCommit?.();

    const current = load() || { version: 2, expertRules: null, businessKnowledge: null };
    const otherField = field === "expertRules" ? "businessKnowledge" : "expertRules";
    if (text.length + String(current[otherField]?.text || "").length > MAX_TEXT_CHARS) {
      throw new AiExpertError("AI_EXPERT_TEXT_TOO_LONG", "两份专家资料的文字合计不能超过 5 万字符");
    }
    const next = {
      version: 2,
      expertRules: current.expertRules,
      businessKnowledge: current.businessKnowledge,
      [field]: {
        fileName: path.basename(source),
        importedAt: now().toISOString(),
        text
      }
    };
    persist(next);
    return statusFrom(next);
  }

  function remove(kindValue) {
    const kind = assertAiExpertKind(kindValue);
    const field = KIND_TO_FIELD[kind];
    const current = load() || { version: 2, expertRules: null, businessKnowledge: null };
    const next = {
      version: 2,
      expertRules: current.expertRules,
      businessKnowledge: current.businessKnowledge,
      [field]: null
    };
    persist(next);
    return statusFrom(next);
  }

  return { importFile, read, remove, status };
}

module.exports = {
  AI_EXPERT_KINDS,
  AiExpertError,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  assertAiExpertKind,
  createAiExpertStore,
  normalizeExpertText
};
