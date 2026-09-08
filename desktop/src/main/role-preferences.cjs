const fs = require("node:fs");
const path = require("node:path");
const catalog = require("../shared/role-appearance.json");
const { writeJsonAtomic } = require("./atomic-file.cjs");

function defaults() {
  return Object.fromEntries(Object.entries(catalog).map(([role, definition]) => [role, { name: definition.name, appearanceId: "original" }]));
}

function validName(value) {
  if (typeof value !== "string") return "";
  const name = value.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 20 && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(name) ? name : "";
}

function createRolePreferences({ rootDir }) {
  const file = path.join(rootDir, "role-preferences.json");
  let preferences = defaults();
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const role of Object.keys(catalog)) {
      const value = saved[role];
      if (!value || typeof value.name !== "string") continue;
      const name = validName(value.name);
      if (name) preferences[role].name = name;
      if (catalog[role].appearances.some((item) => item.id === value.appearanceId)) preferences[role].appearanceId = value.appearanceId;
    }
  } catch {}
  const listeners = new Set();
  function status() { return { ok: true, data: structuredClone(preferences) }; }
  function save(payload) {
    const role = payload?.role;
    if (typeof role !== "string" || !Object.prototype.hasOwnProperty.call(catalog, role)) return { ok: false, error: "请选择有效的数字员工" };
    const name = validName(payload.name);
    if (!name) return { ok: false, error: "名字请填写 1～20 个字符，不包含换行" };
    if (!catalog[role].appearances.some((item) => item.id === payload.appearanceId)) return { ok: false, error: "请选择该员工的形象" };
    const next = { ...preferences, [role]: { name, appearanceId: payload.appearanceId } };
    try { writeJsonAtomic(file, next); } catch { return { ok: false, error: "名字与形象暂未保存，请重试" }; }
    preferences = next;
    const result = status();
    for (const listener of listeners) { try { listener(status()); } catch {} }
    return result;
  }
  return { status, save, onUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

function registerRolePreferencesIpc({ ipcMain, controller, getMainWindow }) {
  for (const [name, action] of Object.entries({ status: () => controller.status(), save: (payload) => controller.save(payload) })) {
    ipcMain.handle(`role-preferences:${name}`, (event, payload) => {
      const window = getMainWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("role_preferences_sender_invalid");
      return action(payload);
    });
  }
  return controller.onUpdate((result) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send("role-preferences:update", result);
  });
}

function createRolePreferencesApi(ipcRenderer) {
  return {
    status: () => ipcRenderer.invoke("role-preferences:status"),
    save: (payload) => ipcRenderer.invoke("role-preferences:save", payload),
    onUpdate(callback) {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on("role-preferences:update", handler);
      return () => ipcRenderer.removeListener("role-preferences:update", handler);
    }
  };
}
module.exports = { createRolePreferences, registerRolePreferencesIpc, createRolePreferencesApi };
