function registerFeedbackIpc({ ipcMain, controller, admin, getMainWindow }) {
  for (const [name, action] of Object.entries({ status: () => controller.status(), publicList: (value) => controller.publicList(value), withdraw: (value) => controller.withdraw(String(value || "")),
    adminAvailable: () => admin?.available() || { available: false }, adminList: (value) => admin.list(value), adminUpdate: (value) => admin.update(value), submit: (value) => controller.submit(value),
    refresh: () => controller.refresh(), retry: (value) => controller.retry(String(value || "")), saveDraft: (value) => controller.saveDraft(value) })) {
    ipcMain.handle(`feedback:${name}`, async (event, value) => {
      const window = getMainWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("feedback_sender_invalid");
      try { return { ok: true, data: await action(value) }; }
      catch (error) { return { ok: false, error: error?.code === "feedback_secure_storage"
        ? "Windows 安全存储暂不可用，草稿已保留，请在原 Windows 账户下重新打开软件。"
        : name.startsWith("admin") ? "管理员连接失败或保存未完成，请刷新后重试。" : error?.code === "feedback_validation" ? error.message : "暂时无法保存反馈，请稍后重试。" }; }
    });
  }
  return controller.onUpdate((state) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send("feedback:update", state);
  });
}
module.exports = { registerFeedbackIpc };
