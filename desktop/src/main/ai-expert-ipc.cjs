function publicError(error) {
  const suppliedCode = String(error?.code || "");
  const code = suppliedCode || "AI_EXPERT_FAILED";
  const known = Boolean(suppliedCode) && (code === "AUTO_REPLY_RUNNING" || code.startsWith("AI_EXPERT_"));
  return {
    ok: false,
    code,
    error: known ? String(error?.message || "AI专家话术文件操作失败") : "AI专家话术文件操作失败"
  };
}

function registerAiExpertIpc(options = {}) {
  const ipcMain = options.ipcMain || require("electron").ipcMain;
  const dialog = options.dialog || require("electron").dialog;
  const store = options.store;
  const isAutoReplyRunning = options.isAutoReplyRunning || (() => false);

  function assertMutable() {
    if (isAutoReplyRunning()) {
      const error = new Error("自动回复运行中，请先暂停再替换或删除话术文件");
      error.code = "AUTO_REPLY_RUNNING";
      throw error;
    }
  }

  ipcMain.handle("ai-expert:status", () => {
    try { return { ok: true, data: store.status() }; } catch (error) { return publicError(error); }
  });
  ipcMain.handle("ai-expert:choose-and-import", async () => {
    try {
      assertMutable();
      const result = await dialog.showOpenDialog({
        title: "选择自动回复话术文件",
        properties: ["openFile"],
        filters: [{ name: "话术文件", extensions: ["txt", "md", "docx"] }]
      });
      if (result.canceled || !result.filePaths?.[0]) return { ok: true, data: store.status() };
      assertMutable();
      return { ok: true, data: await store.importFile(result.filePaths[0], { beforeCommit: assertMutable }) };
    } catch (error) {
      return publicError(error);
    }
  });
  ipcMain.handle("ai-expert:remove", () => {
    try {
      assertMutable();
      return { ok: true, data: store.remove() };
    } catch (error) {
      return publicError(error);
    }
  });
}

module.exports = { registerAiExpertIpc };
