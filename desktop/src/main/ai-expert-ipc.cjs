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
  let chatting = false;

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
  ipcMain.handle("ai-expert:read", () => {
    try { return { ok: true, data: store.read() }; } catch (error) { return publicError(error); }
  });
  ipcMain.handle("ai-expert:conversation", () => {
    try { return { ok: true, data: store.conversation() }; } catch (error) { return publicError(error); }
  });
  ipcMain.handle("ai-expert:save", (_event, payload) => {
    try { return { ok: true, data: store.save(payload || {}) }; } catch (error) { return publicError(error); }
  });
  ipcMain.handle("ai-expert:chat", async (_event, payload) => {
    if (chatting) return { ok: false, error: "正在整理上一条回答，请稍候。" };
    const message = String(payload?.message || "").trim();
    if (!message || message.length > 6000) return { ok: false, error: "请输入业务情况，每条不超过 6000 字。" };
    chatting = true;
    try {
      const current = store.conversation();
      const messages = [...current.messages, { role: "user", content: message }];
      const expertRules = typeof payload?.expertRules === "string" ? payload.expertRules : current.expertRules;
      const businessKnowledge = typeof payload?.businessKnowledge === "string" ? payload.businessKnowledge : current.businessKnowledge;
      if (expertRules.length + businessKnowledge.length > 50000) return { ok: false, error: "专家资料文字合计不能超过 5 万字符。" };
      const result = await options.deepSeekClient.expertInterview({ messages, expertRules, businessKnowledge });
      if (Number(store.conversation().revision || 0) !== Number(current.revision || 0)) {
        return { ok: false, error: "资料已更新，本轮回答未覆盖新资料，请重新发送。" };
      }
      const next = store.saveConversation({
        messages: [...messages, { role: "assistant", content: result.message }],
        expertRules: result.expertRules, businessKnowledge: result.businessKnowledge
      });
      return { ok: true, data: next };
    } catch (error) {
      return { ok: false, code: error.code || "AI_EXPERT_CHAT_FAILED", error: error.code ? error.message : "对话暂时未完成，请稍后重试。原专家资料未修改。" };
    } finally { chatting = false; }
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
