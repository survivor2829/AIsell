const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAiExpertStore } = require("./ai-expert.cjs");
const { registerAiExpertIpc } = require("./ai-expert-ipc.cjs");
const { createPreloadApis } = require("./preload-api.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-ai-expert-"));
const EMPTY_SLOT = { configured: false, fileName: "", importedAt: "" };

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code);
}

async function main() {
  const textFile = path.join(root, "专家规则.txt");
  const markdownFile = path.join(root, "业务资料.md");
  const docxFile = path.join(root, "成交手册.docx");
  const emptyFile = path.join(root, "空文件.txt");
  const longFile = path.join(root, "过长.md");
  const combinedRulesFile = path.join(root, "三万字规则.txt");
  const combinedKnowledgeFile = path.join(root, "两万字知识.txt");
  const combinedOverflowFile = path.join(root, "两万零一字知识.txt");
  const largeFile = path.join(root, "超大.txt");
  const pdfFile = path.join(root, "拒绝.pdf");
  fs.writeFileSync(textFile, "﻿回复原则：先直接回答。\r\n\r\n转人工：仅限成交办理。", "utf8");
  fs.writeFileSync(markdownFile, "# 业务知识\n设备短租，具体价格以资料中的范围为准。", "utf8");
  fs.writeFileSync(docxFile, "fake-docx", "utf8");
  fs.writeFileSync(emptyFile, "  \r\n", "utf8");
  fs.writeFileSync(longFile, "字".repeat(50_001), "utf8");
  fs.writeFileSync(combinedRulesFile, "规".repeat(30_000), "utf8");
  fs.writeFileSync(combinedKnowledgeFile, "知".repeat(20_000), "utf8");
  fs.writeFileSync(combinedOverflowFile, "知".repeat(20_001), "utf8");
  fs.writeFileSync(largeFile, Buffer.alloc(5 * 1024 * 1024 + 1));
  fs.writeFileSync(pdfFile, "%PDF", "utf8");

  const extracted = [];
  const runtimeDir = path.join(root, "runtime");
  const store = createAiExpertStore({
    rootDir: runtimeDir,
    now: () => new Date("2026-07-14T10:00:00+08:00"),
    mammothImpl: {
      extractRawText: async (options) => {
        extracted.push(options);
        return { value: "产品知识：设备租赁。\n售后政策：以业务资料为准。" };
      }
    }
  });
  assert.deepEqual(store.status(), {
    expertRules: EMPTY_SLOT,
    businessKnowledge: EMPTY_SLOT,
    ready: false
  });

  let status = await store.importFile("expert_rules", textFile);
  assert.equal(status.expertRules.configured, true);
  assert.equal(status.expertRules.fileName, "专家规则.txt");
  assert.equal(status.businessKnowledge.configured, false);
  assert.equal(status.ready, false);
  assert.match(store.read().expertRules.text, /^回复原则/);
  assert.doesNotMatch(store.read().expertRules.text, /\r|﻿/);
  assert.equal(store.read().businessKnowledge.text, "");

  status = await store.importFile("business_knowledge", markdownFile);
  assert.equal(status.businessKnowledge.fileName, "业务资料.md");
  assert.equal(status.ready, true);
  assert.match(store.read().businessKnowledge.text, /设备短租/);
  assert.match(store.read().expertRules.text, /先直接回答/);

  status = await store.importFile("business_knowledge", docxFile);
  assert.equal(status.businessKnowledge.fileName, "成交手册.docx");
  assert.equal(extracted.length, 1);
  assert.deepEqual(extracted[0], { path: docxFile });
  assert.match(store.read().businessKnowledge.text, /售后政策/);
  assert.match(store.read().expertRules.text, /先直接回答/, "replacing one slot must preserve the other slot");
  assert.equal(fs.readdirSync(runtimeDir).some((name) => name.endsWith(".tmp")), false);

  const publicStatus = store.status();
  assert.equal(JSON.stringify(publicStatus).includes("先直接回答"), false, "status must not expose document bodies");
  assert.equal(JSON.stringify(publicStatus).includes(root), false, "status must not expose absolute paths");

  const beforeAtomicFailure = store.read();
  const renameSync = fs.renameSync;
  fs.renameSync = () => { throw new Error("simulated atomic replace failure"); };
  try {
    await assert.rejects(
      () => store.importFile("business_knowledge", markdownFile),
      /simulated atomic replace failure/
    );
  } finally {
    fs.renameSync = renameSync;
  }
  assert.deepEqual(store.read(), beforeAtomicFailure, "failed atomic replacement must preserve both slots");
  assert.equal(fs.readdirSync(runtimeDir).some((name) => name.endsWith(".tmp")), false, "failed atomic replacement must clean its temporary file");

  await expectCode(() => store.importFile("expert_rules", emptyFile), "AI_EXPERT_EMPTY");
  await expectCode(() => store.importFile("expert_rules", longFile), "AI_EXPERT_TEXT_TOO_LONG");
  await expectCode(() => store.importFile("expert_rules", largeFile), "AI_EXPERT_FILE_TOO_LARGE");
  await expectCode(() => store.importFile("expert_rules", pdfFile), "AI_EXPERT_FILE_TYPE");
  await expectCode(() => store.importFile("unknown", textFile), "AI_EXPERT_KIND");
  assert.throws(() => store.remove("unknown"), (error) => error?.code === "AI_EXPERT_KIND");
  assert.equal(store.status().businessKnowledge.fileName, "成交手册.docx", "failed imports must not replace either slot");

  const beforeAtomicRemoveFailure = store.read();
  fs.renameSync = () => { throw new Error("simulated atomic remove failure"); };
  try {
    assert.throws(() => store.remove("business_knowledge"), /simulated atomic remove failure/);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.deepEqual(store.read(), beforeAtomicRemoveFailure, "failed atomic removal must preserve both slots");
  assert.equal(fs.readdirSync(runtimeDir).some((name) => name.endsWith(".tmp")), false);

  const boundaryStore = createAiExpertStore({ rootDir: path.join(root, "runtime-boundary") });
  await boundaryStore.importFile("expert_rules", combinedRulesFile);
  assert.equal((await boundaryStore.importFile("business_knowledge", combinedKnowledgeFile)).ready, true);
  await expectCode(
    () => boundaryStore.importFile("business_knowledge", combinedOverflowFile),
    "AI_EXPERT_TEXT_TOO_LONG"
  );
  assert.equal(boundaryStore.read().businessKnowledge.text.length, 20_000, "combined overflow must preserve the previous slot");

  assert.equal(store.remove("business_knowledge").ready, false);
  assert.equal(store.read().expertRules.configured, true);
  assert.deepEqual(store.remove("expert_rules"), {
    expertRules: EMPTY_SLOT,
    businessKnowledge: EMPTY_SLOT,
    ready: false
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDir, "ai-expert.json"), "utf8")).version, 2);

  const legacyRuntimeDir = path.join(root, "runtime-v1");
  fs.mkdirSync(legacyRuntimeDir, { recursive: true });
  const legacyValue = {
    version: 1,
    fileName: "旧专家.txt",
    extension: ".txt",
    importedAt: "2026-07-01T00:00:00.000Z",
    text: "不能丢失的旧版专家规则"
  };
  const legacyStateFile = path.join(legacyRuntimeDir, "ai-expert.json");
  fs.writeFileSync(legacyStateFile, JSON.stringify(legacyValue), "utf8");
  const legacyStore = createAiExpertStore({ rootDir: legacyRuntimeDir });
  assert.equal(legacyStore.status().expertRules.fileName, "旧专家.txt");
  assert.equal(legacyStore.status().businessKnowledge.configured, false);
  assert.equal(legacyStore.status().ready, false);
  assert.equal(legacyStore.read().expertRules.text, legacyValue.text);
  assert.equal(JSON.parse(fs.readFileSync(legacyStateFile, "utf8")).version, 1, "read-only access must not rewrite v1 state");
  fs.renameSync = () => { throw new Error("simulated migration failure"); };
  try {
    await assert.rejects(
      () => legacyStore.importFile("business_knowledge", markdownFile),
      /simulated migration failure/
    );
  } finally {
    fs.renameSync = renameSync;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyStateFile, "utf8")), legacyValue, "failed migration must leave the v1 file untouched");
  assert.equal(fs.readdirSync(legacyRuntimeDir).some((name) => name.endsWith(".tmp")), false);
  assert.equal((await legacyStore.importFile("business_knowledge", markdownFile)).ready, true);
  const migratedValue = JSON.parse(fs.readFileSync(legacyStateFile, "utf8"));
  assert.equal(migratedValue.version, 2);
  assert.equal(migratedValue.expertRules.text, legacyValue.text, "v1 text must survive the first v2 mutation");
  assert.match(migratedValue.businessKnowledge.text, /设备短租/);

  const mammothFixture = path.join(path.dirname(require.resolve("mammoth/package.json")), "test", "test-data", "single-paragraph.docx");
  const actualStore = createAiExpertStore({ rootDir: path.join(root, "runtime-real-docx") });
  assert.equal((await actualStore.importFile("business_knowledge", mammothFixture)).businessKnowledge.configured, true);
  assert.ok(actualStore.read().businessKnowledge.text.length > 0, "official mammoth.extractRawText must extract a real .docx fixture");

  const handlers = new Map();
  let running = true;
  let dialogOpenCount = 0;
  registerAiExpertIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => {
      dialogOpenCount += 1;
      return { canceled: false, filePaths: [textFile] };
    } },
    store,
    isAutoReplyRunning: () => running
  });
  assert.deepEqual([...handlers.keys()].sort(), ["ai-expert:choose-and-import", "ai-expert:remove", "ai-expert:status"]);
  assert.equal((await handlers.get("ai-expert:choose-and-import")({}, "expert_rules")).code, "AUTO_REPLY_RUNNING");
  assert.equal((await handlers.get("ai-expert:remove")({}, "expert_rules")).code, "AUTO_REPLY_RUNNING");
  running = false;
  assert.equal((await handlers.get("ai-expert:choose-and-import")({}, "invalid")).code, "AI_EXPERT_KIND");
  assert.equal(dialogOpenCount, 0, "invalid kinds and running state must be rejected before opening the chooser");
  const imported = await handlers.get("ai-expert:choose-and-import")({}, "expert_rules");
  assert.equal(imported.ok, true);
  assert.equal(imported.data.expertRules.fileName, "专家规则.txt");
  assert.equal("text" in imported.data.expertRules, false, "renderer must not receive document text");
  assert.equal(JSON.stringify(imported.data).includes(root), false, "renderer must not receive an absolute local path");
  assert.equal((await handlers.get("ai-expert:remove")({}, "expert_rules")).data.expertRules.configured, false);

  const preloadInvocations = [];
  const aiExpertApi = createPreloadApis({
    invoke: async (...args) => { preloadInvocations.push(args); return { ok: true }; },
    on: () => undefined,
    removeListener: () => undefined
  }).aiExpert;
  await aiExpertApi.status();
  await aiExpertApi.chooseAndImport("business_knowledge");
  await aiExpertApi.remove("expert_rules");
  assert.deepEqual(preloadInvocations, [
    ["ai-expert:status"],
    ["ai-expert:choose-and-import", "business_knowledge"],
    ["ai-expert:remove", "expert_rules"]
  ]);

  const sanitizedHandlers = new Map();
  registerAiExpertIpc({
    ipcMain: { handle: (channel, handler) => sanitizedHandlers.set(channel, handler) },
    store: { status: () => { throw new Error(`EACCES: ${textFile}`); } }
  });
  const sanitized = await sanitizedHandlers.get("ai-expert:status")();
  assert.equal(sanitized.error, "AI专家资料操作失败");
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
  assert.equal((await raceHandlers.get("ai-expert:choose-and-import")({}, "expert_rules")).code, "AUTO_REPLY_RUNNING", "starting auto reply while the file chooser is open must cancel replacement");

  const extractionRaceHandlers = new Map();
  let startedDuringExtraction = false;
  const extractionRaceStore = createAiExpertStore({
    rootDir: path.join(root, "runtime-extraction-race"),
    mammothImpl: { extractRawText: async () => {
      startedDuringExtraction = true;
      return { value: "不应在运行中提交的业务知识" };
    } }
  });
  registerAiExpertIpc({
    ipcMain: { handle: (channel, handler) => extractionRaceHandlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [docxFile] }) },
    store: extractionRaceStore,
    isAutoReplyRunning: () => startedDuringExtraction
  });
  assert.equal((await extractionRaceHandlers.get("ai-expert:choose-and-import")({}, "business_knowledge")).code, "AUTO_REPLY_RUNNING", "starting auto reply during DOCX extraction must cancel the atomic commit");
  assert.equal(extractionRaceStore.status().businessKnowledge.configured, false);
  console.log("ai-expert self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
