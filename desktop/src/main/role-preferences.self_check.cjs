const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const catalog = require("../shared/role-appearance.json");
const { createRolePreferences, registerRolePreferencesIpc, createRolePreferencesApi } = require("./role-preferences.cjs");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-preferences-check-"));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  const file = path.join(dir, "role-preferences.json");
  try {
    const controller = createRolePreferences({ rootDir: dir });
    const initial = controller.status();
    for (const [role, definition] of Object.entries(catalog)) assert.deepEqual(initial.data[role], { name: definition.name, appearanceId: "original" });
    initial.data.agent.name = "cannot mutate controller";
    assert.equal(controller.status().data.agent.name, catalog.agent.name);
    const payload = { role: "agent", name: `  ${"玺".repeat(19)}🙂  `, appearanceId: "welcome" };
    controller.onUpdate(() => { throw new Error("window closed during notification"); });
    controller.onUpdate((value) => { value.data.agent.name = "observer copy"; });
    assert.equal(controller.save(payload).data.agent.name, payload.name.trim());
    const saved = fs.readFileSync(file, "utf8");
    for (const value of [
      { ...payload, role: "__proto__" }, { ...payload, role: ["agent"] },
      { ...payload, name: " " }, { ...payload, name: "🙂".repeat(21) },
      { ...payload, name: "一\n二" }, { ...payload, name: "一\u2028二" },
      { ...payload, appearanceId: "channels" }, { ...payload, appearanceId: "unknown" }
    ]) {
      assert.equal(controller.save(value).ok, false);
      assert.equal(fs.readFileSync(file, "utf8"), saved, "Invalid input must not change persisted preferences");
    }
    assert.deepEqual(createRolePreferences({ rootDir: dir }).status(), controller.status());
    const rename = fs.renameSync;
    try {
      fs.renameSync = (source, destination) => {
        if (destination === file) throw Object.assign(new Error("fixture disk write failure"), { code: "EIO" });
        return rename(source, destination);
      };
      assert.equal(controller.save({ ...payload, name: "未保存" }).ok, false);
      assert.equal(controller.status().data.agent.name, payload.name.trim());
      assert.equal(fs.readFileSync(file, "utf8"), saved);
    } finally { fs.renameSync = rename; }
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0);

    const handlers = new Map(), mainFrame = {}, webContents = { mainFrame, send() {} };
    const window = { webContents, isDestroyed: () => false };
    const dispose = registerRolePreferencesIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, controller, getMainWindow: () => window });
    assert.throws(() => handlers.get("role-preferences:save")({ sender: {}, senderFrame: mainFrame }, payload), /sender_invalid/);
    assert.throws(() => handlers.get("role-preferences:save")({ sender: webContents, senderFrame: {} }, payload), /sender_invalid/);
    assert.equal(handlers.get("role-preferences:status")({ sender: webContents, senderFrame: mainFrame }).ok, true);
    dispose();
    const invocations = [], events = new Map();
    const api = createRolePreferencesApi({ invoke: (...args) => { invocations.push(args); }, on: (channel, listener) => events.set(channel, listener), removeListener: (channel, listener) => { assert.equal(events.get(channel), listener); events.delete(channel); } });
    api.status(); api.save(payload);
    assert.deepEqual(invocations, [["role-preferences:status"], ["role-preferences:save", payload]]);
    let notified;
    const unsubscribe = api.onUpdate((value) => { notified = value; });
    events.get("role-preferences:update")(null, controller.status());
    assert.deepEqual(notified, controller.status()); unsubscribe(); assert.equal(events.size, 0);
    console.log("role preferences: defaults, Unicode limits, role/appearance validation, atomic failure, persistence, observer isolation and IPC boundary passed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
