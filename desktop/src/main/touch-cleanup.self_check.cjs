// Clearing blocked/deleted contacts out of the contact list (user 2026-11-25): only confirmed people leave,
// a later sync does not bring them back, and a removed one can be put back.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTouchCleanup } = require("./touch-cleanup.cjs");
const { createUnreachableRegistry } = require("./touch-unreachable.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "touch-cleanup-"));
(async () => {
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
  await checkWechatDelete(root);
  console.log("touch cleanup self-check passed: confirmed people leave the list, other accounts untouched, sync keeps them out, restore puts one back, WeChat delete results, lock and account guards, no fixed coordinates");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch((error) => { console.error(error); process.exitCode = 1; });

// Deleting the removed contacts in WeChat too (2026-11-25).
async function checkWechatDelete(base) {
  const dir = path.join(base, "wechat");
  fs.mkdirSync(dir, { recursive: true });
  const row = (wxid, name, account = "当前号") => ({ id: `w-${wxid}`, name, remark: name, wxid, wechatId: `id_${wxid}`, wechatAccountId: account });
  const people = [row("p1", "测试客户一"), row("p2", "测试客户二"), row("p3", "测试客户三"), row("p4", "测试客户四", "别的号")];
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(people));
  const registry = createUnreachableRegistry(dir);
  for (const person of people) registry.record(person, "deleted");
  const cleanup = createTouchCleanup(dir);
  const all = people.map((person) => ({ accountId: person.wechatAccountId, key: person.wxid }));
  cleanup.remove(all);
  const lockLog = [];
  const coordinator = { acquire: (value) => { lockLog.push(["acquire", value.phase]); return { ok: true, lock: { owner: "o1" } }; }, release: (owner) => lockLog.push(["release", owner]) };
  const seen = [];
  const outcomes = { 测试客户一: { ok: true, deleted: true, stage: "done" }, 测试客户二: { ok: false, outcomeUnknown: true, stage: "verify", reason: "delete_outcome_unknown" },
    测试客户三: { ok: false, stage: "confirm", reason: "confirm_text_mismatch" } };
  const progress = [];
  const done = await cleanup.deleteInWechat(all, { coordinator, currentAccount: "当前号", onProgress: (value) => progress.push(value),
    deleteContact: async (contact, options) => { seen.push([contact.name, contact.wechatId, options.confirm]); return outcomes[contact.name]; } });
  assert.deepEqual(seen, [["测试客户一", "id_p1", true], ["测试客户二", "id_p2", true], ["测试客户三", "id_p3", true]], "the saved contact row is what is deleted; another account's friend is not");
  assert.deepEqual([done.deleted, done.unknown, done.failed], [1, 1, 2]);
  const status = Object.fromEntries(cleanup.list().entries.map((entry) => [entry.name, entry.wechatDelete]));
  assert.equal(status.测试客户一.status, "deleted");
  assert.equal(status.测试客户二.status, "unknown", "pressed 删除 but not read back: unknown, never retried");
  assert.deepEqual([status.测试客户三.status, status.测试客户三.reason], ["failed", "confirm_text_mismatch"]);
  assert.deepEqual([status.测试客户四.status, status.测试客户四.reason], ["failed", "wechat_account_mismatch"]);
  assert.deepEqual(lockLog, [["acquire", "touch:delete-contact"], ["release", "o1"]], "the WeChat lock is held for the run and released");
  assert.equal(progress.at(-1).finished, true);
  assert.equal(cleanup.list().wechatRunning, false);

  // WeChat busy (touch or replies hold the lock): nothing is pressed, each says why.
  const busyDir = path.join(base, "busy");
  fs.mkdirSync(busyDir, { recursive: true });
  fs.writeFileSync(path.join(busyDir, "contacts.json"), JSON.stringify([people[0]]));
  createUnreachableRegistry(busyDir).record(people[0], "blocked");
  const busy = createTouchCleanup(busyDir);
  busy.remove([all[0]]);
  let pressed = 0;
  await busy.deleteInWechat([all[0]], { currentAccount: "当前号", coordinator: { acquire: () => ({ ok: false, error: "wechat_operation_busy" }), release() {} },
    deleteContact: async () => { pressed += 1; return {}; } });
  assert.equal(pressed, 0);
  assert.equal(busy.list().entries[0].wechatDelete.reason, "wechat_operation_busy");
  // WeChat switched to another account: nothing is pressed either.
  const switched = createTouchCleanup(busyDir);
  await switched.deleteInWechat([all[0]], { currentAccount: "当前号", verifyLiveAccount: async () => ({ ok: false, reason: "wechat_account_changed" }),
    coordinator, deleteContact: async () => { pressed += 1; return {}; } });
  assert.equal(pressed, 0);
  assert.equal(switched.list().entries[0].wechatDelete.reason, "wechat_account_changed");
  assert.equal((await busy.deleteInWechat([{ accountId: "当前号", key: "nobody" }], { deleteContact: async () => ({}) })).reason, "nothing_to_delete", "only removed contacts can be deleted");

  // The WeChat steps find every element by name and click its live centre: no coordinate is written down, and the
  // four identity checks stay in place.
  const { DELETE_SCRIPT } = require("../../rpa/active_touch/wechat_delete_contact.cjs");
  assert.doesNotMatch(DELETE_SCRIPT, /SetCursorPos\(\s*\d/u, "never a fixed screen point");
  assert.ok(DELETE_SCRIPT.includes("SetCursorPos([int]($box.X + $box.Width / 2), [int]($box.Y + $box.Height / 2))"), "the centre of the element's current box");
  for (const check of ["chat_title_mismatch", "chat_member_mismatch", "profile_wechat_id_mismatch", "confirm_text_mismatch", "dry_run_stopped_before_delete", "delete_outcome_unknown"]) {
    assert.ok(DELETE_SCRIPT.includes(check), check);
  }
  assert.ok(DELETE_SCRIPT.includes("'删除\"' + $name + '\"？'"), "the confirm text must name exactly this person");
}
