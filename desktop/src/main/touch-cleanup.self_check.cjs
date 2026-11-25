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
  const row = (wxid, name, account = "当前号", wechatId = `id_${wxid}`) => ({ id: `w-${wxid}`, name, remark: name, wxid, wechatId, wechatAccountId: account });
  const people = [row("p1", "测试客户一"), row("p2", "测试客户二"), row("p3", "测试客户三"), row("p4", "测试客户四", "别的号"), row("p5", "测试客户五")];
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([...people, row("p9", "测试客户五")]));
  const registry = createUnreachableRegistry(dir);
  for (const person of people) registry.record(person, "deleted");
  const cleanup = createTouchCleanup(dir);
  const all = people.map((person) => ({ accountId: person.wechatAccountId, key: person.wxid }));
  cleanup.remove(all);
  // Planned before anything starts: another account's friend is skipped and says why.
  const plan = cleanup.planWechatDelete(all, { currentAccount: "当前号" });
  assert.deepEqual(plan.wanted.map((entry) => entry.key), ["p1", "p2", "p3", "p5"]);
  assert.deepEqual(plan.skipped, [{ accountId: "别的号", key: "p4", reason: "wechat_account_mismatch" }]);
  const live = async () => ({ ok: true });
  assert.equal((await cleanup.deleteInWechat(plan.wanted, { deleteContact: async () => ({}), currentAccount: "当前号" })).reason, "wechat_delete_unavailable", "no live account check, no delete");
  const lockLog = [];
  const coordinator = { acquire: (value) => { lockLog.push(["acquire", value.phase]); return { ok: true, lock: { owner: "o1" } }; }, release: (owner) => lockLog.push(["release", owner]) };
  const seen = [], failures = [], waits = [];
  const outcomes = { 测试客户一: { ok: true, deleted: true, stage: "done" }, 测试客户二: { ok: false, outcomeUnknown: true, stage: "commit", reason: "powershell_timeout" },
    测试客户三: { ok: false, stage: "confirm", reason: "confirm_text_mismatch" } };
  const done = await cleanup.deleteInWechat(plan.wanted, { coordinator, currentAccount: "当前号", verifyLiveAccount: live,
    onFailure: (failure) => failures.push(failure), wait: async (ms) => { waits.push(ms); },
    deleteContact: async (contact, options) => {
      seen.push([contact.name, options.confirm, options.uniqueName]);
      if (contact.name === "测试客户五") throw new Error("crashed");
      return outcomes[contact.name];
    } });
  assert.deepEqual(seen, [["测试客户一", true, true], ["测试客户二", true, true], ["测试客户三", true, true], ["测试客户三", true, true], ["测试客户三", true, true], ["测试客户五", true, false]],
    "stopped before 删除 is searched again up to 3 times; unknown is never retried; a friend sharing a synced name is flagged not unique");
  assert.deepEqual(waits, [2500, 2500]);
  assert.deepEqual(failures.map((failure) => [failure.reason, failure.retrying]), [["powershell_timeout", false], ["confirm_text_mismatch", true],
    ["confirm_text_mismatch", true], ["confirm_text_mismatch", false], ["crashed", false]], "every miss is reported (no names) for the failure report");
  assert.ok(failures.every((failure) => !JSON.stringify(failure).includes("测试客户")));
  assert.deepEqual([done.deleted, done.unknown, done.failed], [1, 2, 1]);
  const status = Object.fromEntries(cleanup.list().entries.map((entry) => [entry.name, entry.wechatDelete]));
  assert.equal(status.测试客户二.status, "unknown", "a timeout after 删除 is unknown, never retried");
  assert.equal(status.测试客户五.status, "unknown", "a crash is never reported as not deleted");
  assert.deepEqual([status.测试客户三.status, status.测试客户三.reason], ["failed", "confirm_text_mismatch"]);
  assert.deepEqual([status.测试客户四.status, status.测试客户四.reason], ["failed", "wechat_account_mismatch"]);
  assert.deepEqual(lockLog, [["acquire", "touch:delete-contact"], ["release", "o1"]], "the WeChat lock is held for the run and released");
  assert.equal(cleanup.list().wechatRunning, false);

  // A search that misses once and then finds the person deletes them; a permanent reason is not retried.
  const flaky = [{ ok: false, stage: "open", reason: "search_result_identity_unverified" }, { ok: true, deleted: true, stage: "done" }];
  let tries = 0;
  const recovered = await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {},
    deleteContact: async () => flaky[tries++] });
  assert.deepEqual([tries, recovered.deleted], [2, 1]);
  tries = 0;
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {},
    deleteContact: async () => { tries += 1; return { ok: false, stage: "window", reason: "wechat_version_unsupported" }; } });
  assert.equal(tries, 1, "an unsupported WeChat is not searched again");

  // Busy WeChat, a switched account, or an account that cannot be checked: nothing is pressed.
  let pressed = 0;
  const press = async () => { pressed += 1; return {}; };
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator: { acquire: () => ({ ok: false, error: "wechat_operation_busy" }), release() {} }, deleteContact: press });
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: async () => ({ ok: false, reason: "wechat_account_changed" }), coordinator, deleteContact: press });
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: async () => { throw new Error("no"); }, coordinator, deleteContact: press });
  assert.equal(pressed, 0);
  assert.equal(cleanup.list().entries.find((entry) => entry.key === "p1").wechatDelete.reason, "wechat_account_unverified");

  // 停止 between people: the one in hand finishes, the rest are left alone.
  let stopNow;
  const stopped = await cleanup.deleteInWechat(plan.wanted.slice(0, 3), { currentAccount: "当前号", verifyLiveAccount: live, coordinator,
    deleteContact: async () => { stopNow = cleanup.stopWechatDelete(); return { ok: true, deleted: true }; } });
  assert.equal(stopNow.stopping, true);
  assert.deepEqual([stopped.deleted, stopped.failed], [1, 2]);
  assert.equal(cleanup.list().entries.find((entry) => entry.key === "p3").wechatDelete.reason, "stopped_by_user");

  await checkDeleteModule();
}

// The WeChat steps themselves (rpa/active_touch/wechat_delete_contact.cjs), with WeChat faked.
async function checkDeleteModule() {
  const { deleteWechatContact, DELETE_SCRIPT } = require("../../rpa/active_touch/wechat_delete_contact.cjs");
  const contact = { name: "测试客户", remark: "测试客户", wechatId: "test_alias" };
  const focus = async () => ({ ok: true, pid: 1, hWnd: 2, processName: "Weixin", windowClass: "Qt51514QWindowIcon" });
  const openConversation = async () => ({ ok: true });
  const calls = [];
  const runner = (answers) => async (_script, env) => { calls.push({ phase: env.XIAOXI_DELETE_PHASE, id: env.XIAOXI_DELETE_WECHAT_ID }); return answers[env.XIAOXI_DELETE_PHASE]; };
  const ready = { ok: true, stage: "confirm", ready: true };
  assert.equal((await deleteWechatContact(contact, { confirm: true, focus, openConversation, runner: runner({ prepare: ready, commit: { ok: true, deleted: true, stage: "done" } }) })).deleted, true);
  assert.deepEqual(calls.map((call) => call.phase), ["prepare", "commit"], "删除 is pressed only in a second call, after the confirm was reached");
  for (const commit of [{ ok: false, reason: "powershell_timeout" }, { ok: false, reason: "powershell_output_invalid" }, undefined]) {
    const result = await deleteWechatContact(contact, { confirm: true, focus, openConversation, runner: runner({ prepare: ready, commit }) });
    assert.equal(result.outcomeUnknown, true, `after the press, ${commit?.reason || "no answer"} is unknown`);
  }
  const throwing = await deleteWechatContact(contact, { confirm: true, focus, openConversation, runner: async (_s, env) => { if (env.XIAOXI_DELETE_PHASE === "commit") throw new Error("crash"); return ready; } });
  assert.equal(throwing.outcomeUnknown, true);
  const notPressed = await deleteWechatContact(contact, { confirm: true, focus, openConversation, runner: runner({ prepare: ready, commit: { ok: false, stage: "commit", reason: "confirm_dialog_gone", notClicked: true } }) });
  assert.deepEqual([notPressed.outcomeUnknown, notPressed.reason], [false, "confirm_dialog_gone"]);
  calls.length = 0;
  const look = await deleteWechatContact(contact, { confirm: false, focus, openConversation, runner: runner({ prepare: { ok: false, stage: "confirm", reason: "dry_run_stopped_before_delete", dryRun: true } }) });
  assert.deepEqual([look.dryRun, calls.map((call) => call.phase)], [true, ["prepare"]], "a look-only run never reaches the commit call");
  // No usable 微信号: refused unless the name is known to be unique.
  assert.equal((await deleteWechatContact({ name: "测试客户" }, { confirm: true, focus, openConversation, runner: runner({}) })).reason, "contact_name_not_unique");
  // Not WeChat 4: nothing is opened.
  let opened = 0;
  const old = await deleteWechatContact(contact, { confirm: true, focus: async () => ({ ok: true, processName: "WeChat", windowClass: "WeChatMainWndForPC" }), openConversation: async () => { opened += 1; return { ok: true }; }, runner: runner({}) });
  assert.deepEqual([old.reason, opened], ["wechat_version_unsupported", 0]);

  // Every element is found by name and pressed at its live centre: no coordinate is written down; the identity
  // checks and the user-input stop are in place.
  assert.doesNotMatch(DELETE_SCRIPT, /SetCursorPos\(\s*\d/u, "never a fixed screen point");
  assert.ok(DELETE_SCRIPT.includes("SetCursorPos([int]($box.X + $box.Width / 2), [int]($box.Y + $box.Height / 2))"));
  for (const check of ["chat_title_mismatch", "chat_member_mismatch", "profile_wechat_id_mismatch", "confirm_text_mismatch", "dry_run_stopped_before_delete", "delete_outcome_unknown", "wechat_external_input_detected"]) {
    assert.ok(DELETE_SCRIPT.includes(check), check);
  }
  assert.ok(DELETE_SCRIPT.includes("'删除\"' + $name + '\"？'"), "the confirm text must name exactly this person");
  // Esc only while the profile card is open: one Esc too many hides WeChat to the tray (seen live 2026-11-25).
  assert.match(DELETE_SCRIPT, /if \(-not \(Get-WxWindow "mmui::ProfileUniquePop"\)\) \{ break \}\s*\[XiaoxiDel\]::keybd_event\(0x1B/u);
}
