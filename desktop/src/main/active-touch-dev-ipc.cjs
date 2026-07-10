const { ipcMain } = require("electron");
const { runActiveTouchDev } = require("./active-touch-ipc.cjs");

function registerActiveTouchDevIpc() {
  ipcMain.handle("active-touch:send-real", (_event, payload = {}) =>
    runActiveTouchDev(["send", "--real", "--allow-real-send", "--message", String(payload.message ?? "")])
  );
  ipcMain.handle("active-touch:set-real-send-arm", (_event, payload = {}) =>
    runActiveTouchDev(["set-real-send-arm", payload.enabled ? "--on" : "--off"])
  );
  ipcMain.handle("active-touch:fail-conversation", () => runActiveTouchDev(["fail-conversation"]));
}

module.exports = { registerActiveTouchDevIpc };
