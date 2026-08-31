const { assertAiExpertKind } = require("./ai-expert.cjs");

const KIND_LABELS = Object.freeze({
  expert_rules: "专家规则",
  business_knowledge: "业务知识"
});

function publicError(error) {
  const suppliedCode = String(error?.code || "");
  const code = suppliedCode || "AI_EXPERT_FAILED";
  const known = Boolean(suppliedCode) && (code === "AUTO_REPLY_RUNNING" || code.startsWith("AI_EXPERT_"));
  return {
    ok: false,
    code,
    error: known ? String(error?.message || "AI专家资料操作失败") : "AI专家资料操作失败"
  };
}

function registerAiExpertIpc(options = {}) {
  const ipcMain = options.ipcMain || require("electron").ipcMain;
  const dialog = options.dialog || require("electron").dialog;
  const store = options.store;
  const isAutoReplyRunning = options.isAutoReplyRunning || (() => false);

  function assertMutable() {
    if (isAutoReplyRunning()) {
      const error = new Error("自动回复运行中，请先暂停再替换或删除专家资料");
      error.code = "AUTO_REPLY_RUNNING";
      throw error;
    }
  }

  ipcMain.handle("ai-expert:status", () => {
    try { return { ok: true, data: store.status() }; } catch (error) { return publicError(error); }
  });
  ipcMain.handle("ai-expert:choose-and-import", async (_event, kindValue) => {
    try {
      const kind = assertAiExpertKind(kindValue);
      assertMutable();
      const result = await dialog.showOpenDialog({
        title: `选择${KIND_LABELS[kind]}文件`,
        properties: ["openFile"],
        filters: [{ name: "专家资料", extensions: ["txt", "md", "docx"] }]
      });
      if (result.canceled || !result.filePaths?.[0]) return { ok: true, data: store.status() };
      assertMutable();
      return { ok: true, data: await store.importFile(kind, result.filePaths[0], { beforeCommit: assertMutable }) };
    } catch (error) {
      return publicError(error);
    }
  });
  ipcMain.handle("ai-expert:remove", (_event, kindValue) => {
    try {
      const kind = assertAiExpertKind(kindValue);
      assertMutable();
      return { ok: true, data: store.remove(kind) };
    } catch (error) {
      return publicError(error);
    }
  });
}

module.exports = { registerAiExpertIpc };
