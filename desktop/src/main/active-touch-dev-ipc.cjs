const { ipcMain } = require("electron");
const { runActiveTouchDev } = require("./active-touch-ipc.cjs");
const { executeVerifiedContactSend, setRealSendArm } = require("../../rpa/active_touch/state_machine.dev.cjs");

let realSendInFlight = false;
let runtimeDataDir = "";
let getMainWindow = () => null;
const consumedClickTokens = new Set();

function registerActiveTouchDevIpc(options = {}) {
  runtimeDataDir = String(options.dataDir ?? "");
  getMainWindow = typeof options.getMainWindow === "function" ? options.getMainWindow : () => null;
  ipcMain.handle("active-touch:dev-calibrate", () => runActiveTouchDev(["calibrate"]));
  ipcMain.handle("active-touch:dev-select-customer", (_event, payload = {}) =>
    runActiveTouchDev(["select-customer", "--id", String(payload.id ?? "")])
  );
  ipcMain.handle("active-touch:dev-click-search-result", () => runActiveTouchDev(["click-search-result-dry-run"]));
  ipcMain.handle("active-touch:dev-input-message", (_event, payload = {}) =>
    runActiveTouchDev(["input-message-dry-run", "--message", String(payload.message ?? "")])
  );
  ipcMain.handle("active-touch:dev-send-dry-run", (_event, payload = {}) =>
    runActiveTouchDev(["send", "--dry-run", "--message", String(payload.message ?? "")])
  );
  ipcMain.handle("active-touch:send-selected-contact", async (event, payload = {}) => {
    const mainWindow = getMainWindow();
    const clickToken = String(payload.clickToken ?? "");
    if (!clickToken || consumedClickTokens.has(clickToken) || !mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !mainWindow.isFocused()) {
      return { ok: false, action: "send", blocked_reason: "trusted_user_click_required", error: "已阻断：请在测试版窗口本人点击发送" };
    }
    consumedClickTokens.add(clickToken);
    if (consumedClickTokens.size > 100) consumedClickTokens.delete(consumedClickTokens.values().next().value);
    if (realSendInFlight) return { ok: false, action: "send", blocked_reason: "real_send_in_flight", error: "已阻断：真实发送正在确认中" };
    const contactId = String(payload.contactId ?? "").trim();
    const message = String(payload.message ?? "").trim();
    if (!contactId || !message) return { ok: false, action: "send", blocked_reason: "contact_or_message_missing", error: "已阻断：请选择联系人并填写发送文案" };
    realSendInFlight = true;
    try {
      return await executeVerifiedContactSend({
        baseDir: runtimeDataDir,
        contactId,
        message,
        authorized: true,
        runStep: (command, args = []) => runActiveTouchDev([command, ...args])
      });
    } catch (error) {
      setRealSendArm(runtimeDataDir, false);
      return { ok: false, action: "send", blocked_reason: "real_send_failed", error: error instanceof Error ? error.message : "真实发送执行失败" };
    } finally {
      realSendInFlight = false;
    }
  });
  ipcMain.handle("active-touch:set-real-send-arm", (_event, payload = {}) =>
    runActiveTouchDev(["set-real-send-arm", payload.enabled ? "--on" : "--off"])
  );
  ipcMain.handle("active-touch:fail-conversation", () => runActiveTouchDev(["fail-conversation"]));
  ipcMain.handle("active-touch:verify-real-send-session", () => runActiveTouchDev(["verify-real-send-session"]));
}

function disarmRealSend(dataDir) {
  return setRealSendArm(dataDir, false);
}

module.exports = { disarmRealSend, registerActiveTouchDevIpc };
