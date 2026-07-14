const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAiExpertStore } = require("./ai-expert.cjs");
const { registerAiExpertIpc } = require("./ai-expert-ipc.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-ai-expert-"));

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code);
}

async function main() {
  const textFile = path.join(root, "话术.txt");
  const markdownFile = path.join(root, "业务资料.md");
  const docxFile = path.join(root, "成交手册.docx");
  const emptyFile = path.join(root, "空文件.txt");
  const longFile = path.join(root, "过长.md");
  const largeFile = path.join(root, "超大.txt");
  const pdfFile = path.join(root, "拒绝.pdf");
  fs.writeFileSync(textFile, "\ufeff业务信息：设备短租。\r\n\r\n意向判定：客户询价。", "utf8");
  fs.writeFileSync(markdownFile, "# 回复原则\n先读上下文，再简短回答。", "utf8");
  fs.writeFileSync(docxFile, "fake-docx", "utf8");
  fs.writeFileSync(emptyFile, "  \r\n", "utf8");
  fs.writeFileSync(longFile, "字".repeat(50_001), "utf8");
  fs.writeFileSync(largeFile, Buffer.alloc(5 * 1024 * 1024 + 1));
  fs.writeFileSync(pdfFile, "%PDF", "utf8");

  const extracted = [];
  const store = createAiExpertStore({
    rootDir: path.join(root, "runtime"),
    now: () => new Date("2026-07-14T10:00:00+08:00"),
    mammothImpl: {
      extractRawText: async (options) => {
        extracted.push(options);
        return { value: "业务信息：设备租赁。\n无法回答：我帮您确认一下。" };
      }
    }
  });
  assert.deepEqual(store.status(), { configured: false, fileName: "", extension: "", importedAt: "" });

  let status = await store.importFile(textFile);
  assert.equal(status.configured, true);
  assert.equal(status.fileName, "话术.txt");
  assert.equal(status.extension, ".txt");
  assert.match(store.read().text, /^业务信息/);
  assert.doesNotMatch(store.read().text, /\r|\ufeff/);

  status = await store.importFile(markdownFile);
  assert.equal(status.fileName, "业务资料.md");
  assert.match(store.read().text, /回复原则/);

  status = await store.importFile(docxFile);
  assert.equal(status.fileName, "成交手册.docx");
  assert.equal(extracted.length, 1);
  assert.deepEqual(extracted[0], { path: docxFile });
  assert.match(store.read().text, /无法回答/);
  assert.equal(fs.readdirSync(path.join(root, "runtime")).some((name) => name.endsWith(".tmp")), false);

  const beforeAtomicFailure = store.read();
  const renameSync = fs.renameSync;
  fs.renameSync = () => { throw new Error("simulated atomic replace failure"); };
  try {
    await assert.rejects(() => store.importFile(markdownFile), /simulated atomic replace failure/);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.equal(store.read().text, beforeAtomicFailure.text);
  assert.equal(fs.readdirSync(path.join(root, "runtime")).some((name) => name.endsWith(".tmp")), false, "failed atomic replacement must clean its temporary file");

  await expectCode(() => store.importFile(emptyFile), "AI_EXPERT_EMPTY");
  await expectCode(() => store.importFile(longFile), "AI_EXPERT_TEXT_TOO_LONG");
  await expectCode(() => store.importFile(largeFile), "AI_EXPERT_FILE_TOO_LARGE");
  await expectCode(() => store.importFile(pdfFile), "AI_EXPERT_FILE_TYPE");
  assert.equal(store.status().fileName, "成交手册.docx", "failed imports must not replace the current expert file");
  assert.deepEqual(store.remove(), { configured: false, fileName: "", extension: "", importedAt: "" });

  const mammothFixture = path.join(path.dirname(require.resolve("mammoth/package.json")), "test", "test-data", "single-paragraph.docx");
  const actualStore = createAiExpertStore({ rootDir: path.join(root, "runtime-real-docx") });
  assert.equal((await actualStore.importFile(mammothFixture)).configured, true);
  assert.ok(actualStore.read().text.length > 0, "official mammoth.extractRawText must extract a real .docx fixture");

  const handlers = new Map();
  let running = true;
  registerAiExpertIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [textFile] }) },
    store,
    isAutoReplyRunning: () => running
  });
  assert.deepEqual([...handlers.keys()].sort(), ["ai-expert:choose-and-import", "ai-expert:remove", "ai-expert:status"]);
  assert.equal((await handlers.get("ai-expert:choose-and-import")()).code, "AUTO_REPLY_RUNNING");
  assert.equal((await handlers.get("ai-expert:remove")()).code, "AUTO_REPLY_RUNNING");
  running = false;
  const imported = await handlers.get("ai-expert:choose-and-import")();
  assert.equal(imported.ok, true);
  assert.equal(imported.data.fileName, "话术.txt");
  assert.equal("path" in imported.data, false, "renderer must not receive an absolute local path");
  assert.equal((await handlers.get("ai-expert:remove")()).data.configured, false);

  const sanitizedHandlers = new Map();
  registerAiExpertIpc({
    ipcMain: { handle: (channel, handler) => sanitizedHandlers.set(channel, handler) },
    store: { status: () => { throw new Error(`EACCES: ${textFile}`); } }
  });
  const sanitized = await sanitizedHandlers.get("ai-expert:status")();
  assert.equal(sanitized.error, "AI专家话术文件操作失败");
  assert.equal(sanitized.error.includes(root), false, "unexpected file errors must not expose absolute paths to the renderer");

  const raceHandlers = new Map();
  let startedWhileChoosing = false;
  registerAiExpertIpc({
    ipcMain: { handle: (channel, handler) => raceHandlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => {
      startedWhileChoosing = true;
      return { canceled: false, filePaths: [textFile] };
    } },
    store,
    isAutoReplyRunning: () => startedWhileChoosing
  });
  assert.equal((await raceHandlers.get("ai-expert:choose-and-import")()).code, "AUTO_REPLY_RUNNING", "starting auto reply while the file chooser is open must cancel replacement");

  const extractionRaceHandlers = new Map();
  let startedDuringExtraction = false;
  const extractionRaceStore = createAiExpertStore({
    rootDir: path.join(root, "runtime-extraction-race"),
    mammothImpl: { extractRawText: async () => {
      startedDuringExtraction = true;
      return { value: "不应在运行中提交的话术" };
    } }
  });
  registerAiExpertIpc({
    ipcMain: { handle: (channel, handler) => extractionRaceHandlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [docxFile] }) },
    store: extractionRaceStore,
    isAutoReplyRunning: () => startedDuringExtraction
  });
  assert.equal((await extractionRaceHandlers.get("ai-expert:choose-and-import")()).code, "AUTO_REPLY_RUNNING", "starting auto reply during DOCX extraction must cancel the atomic commit");
  assert.equal(extractionRaceStore.status().configured, false);
  console.log("ai-expert self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
