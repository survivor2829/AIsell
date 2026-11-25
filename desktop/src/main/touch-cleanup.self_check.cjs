// Clearing blocked/deleted contacts out of the contact list (user 2026-11-25): only confirmed people leave,
// a later sync does not bring them back, and a removed one can be put back.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTouchCleanup } = require("./touch-cleanup.cjs");
const { createUnreachableRegistry } = require("./touch-unreachable.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "touch-cleanup-"));
try {
  const dir = path.join(root, "active_touch");
  fs.mkdirSync(dir, { recursive: true });
  const row = (wxid, name, account = "测试号") => ({ id: `c-${wxid}`, name, remark: name, wxid, wechatAccountId: account });
  const contacts = [row("wx_a", "张三"), row("wx_b", "李四"), row("wx_c", "王五"), row("wx_d", "赵六"), row("wx_b", "李四", "另一个号")];
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts));
  const registry = createUnreachableRegistry(dir);
  registry.record(contacts[0], "blocked");
  registry.record(contacts[1], "deleted");
  registry.record(contacts[2], "deleted");
  const cleanup = createTouchCleanup(dir);
  const listed = cleanup.list();
  assert.equal(listed.pending, 3);
  assert.deepEqual(listed.entries.map((entry) => entry.name).sort(), ["张三", "李四", "王五"]);
  assert.throws(() => cleanup.remove([]), /勾选/u, "nothing chosen, nothing removed");

  // The customer unticks 王五 (the notice may be wrong) and removes the other two.
  const after = cleanup.remove([{ accountId: "测试号", key: "wx_a" }, { accountId: "测试号", key: "wx_b" }]);
  assert.equal(after.removedNow, 2);
  assert.equal(after.pending, 1);
  const names = () => JSON.parse(fs.readFileSync(path.join(dir, "contacts.json"), "utf8")).map((contact) => `${contact.name}@${contact.wechatAccountId}`);
  assert.deepEqual(names(), ["王五@测试号", "赵六@测试号", "李四@另一个号"], "only the confirmed people of that account leave the list");
  assert.equal(cleanup.remove([{ accountId: "测试号", key: "wx_a" }]).removedNow, 0, "removing twice changes nothing");
  assert.equal(registry.kindOf(contacts[0]), "blocked", "a removed contact is still skipped by touch");

  // A later sync writes WeChat's full list again (a one-way deleted friend is still in it): the removed stay out.
  assert.deepEqual(registry.withoutRemoved(contacts).map((contact) => contact.name), ["王五", "赵六", "李四"]);
  const sync = fs.readFileSync(path.join(__dirname, "../../rpa/contact_sync/contact_sync_cli.cjs"), "utf8");
  assert.equal((sync.match(/withoutRemovedContacts\(baseDir, options, normalizeContacts\(/gu) || []).length, 2, "both sync paths filter the removed");

  // Put one back: it returns to the list, keeps being skipped until released, and can be listed again.
  const restored = cleanup.restore({ accountId: "测试号", key: "wx_b" });
  assert.equal(restored.restored, true);
  assert.ok(names().includes("李四@测试号"));
  assert.equal(registry.isRemoved(contacts[1]), false);
  assert.equal(restored.pending, 2);
  assert.equal(cleanup.restore({ accountId: "测试号", key: "wx_b" }).restored, false, "restoring twice adds nothing");
  assert.equal(names().filter((name) => name === "李四@测试号").length, 1);

  // A contacts file wrapped as { contacts: [...] } keeps its shape.
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify({ version: 1, contacts: [row("wx_c", "王五")] }));
  cleanup.remove([{ accountId: "测试号", key: "wx_c" }]);
  const wrapped = JSON.parse(fs.readFileSync(path.join(dir, "contacts.json"), "utf8"));
  assert.equal(wrapped.version, 1);
  assert.deepEqual(wrapped.contacts, []);
  console.log("touch cleanup self-check passed: confirmed people leave the list, other accounts untouched, sync keeps them out, restore puts one back");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
