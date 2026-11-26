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
  assert.deepEqual(seen, [["测试客户一", true, true], ["测试客户二", true, true], ["测试客户三", true, true], ["测试客户五", true, false]],
    "a wrong person on the confirm is not retried; unknown is never retried; a friend sharing a synced name is flagged not unique");
  assert.deepEqual(waits, []);
  assert.deepEqual(failures.map((failure) => [failure.reason, failure.retrying]), [["powershell_timeout", false], ["confirm_text_mismatch", false], ["crashed", false]],
    "every miss is reported (no names) for the failure report");
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
  assert.deepEqual([tries, recovered.deleted], [2, 1], "a step WeChat was not ready for gets one more try");
  // Deleted although the card's 微信号 could not be confirmed (name unique): reported as degraded with how it was read.
  const degradedLog = [];
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {}, onFailure: (item) => degradedLog.push(item),
    deleteContact: async () => ({ ok: true, deleted: true, idCheck: { id_check_state: "degraded_unread", id_label_kind: "inline", shown_length: 5, stored_length: 5 } }) });
  assert.deepEqual(degradedLog.map((item) => [item.reason, item.degraded, item.id_check.id_label_kind]), [["contact_cleanup_id_check_degraded", true, "inline"]]);
  tries = 0;
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {},
    deleteContact: async () => { tries += 1; return { ok: false, stage: "open", reason: "search_result_not_found" }; } });
  assert.equal(tries, 1, "a search WeChat answers with no such person is not repeated");
  tries = 0;
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {},
    deleteContact: async () => { tries += 1; return { ok: false, stage: "window", reason: "wechat_version_unsupported" }; } });
  assert.equal(tries, 1, "an unsupported WeChat is not searched again");
  // WeChat's chat window cannot be found at all (b070e34b, 2026-11-26: 36 people skipped one by one, nothing
  // deleted): the run stops at the first person and every later one carries the same reason.
  tries = 0;
  const halted = await cleanup.deleteInWechat(plan.wanted, { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {},
    deleteContact: async () => { tries += 1; return { ok: false, stage: "open", reason: "wechat_main_window_not_found" }; } });
  assert.equal(tries, 2, "one person, one more try, then the run stops");
  assert.equal(halted.halted, "wechat_main_window_not_found");
  assert.equal(halted.failed, plan.wanted.length, "the rest are marked with the same reason, not tried");
  const haltedStatus = cleanup.list().entries.filter((entry) => plan.wanted.some((item) => item.key === entry.key)).map((entry) => entry.wechatDelete?.reason);
  assert.ok(haltedStatus.every((reason) => reason === "wechat_main_window_not_found"));
  tries = 0;
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => { cleanup.stopWechatDelete(); },
    deleteContact: async () => { tries += 1; return { ok: false, stage: "open", reason: "search_result_identity_unverified" }; } });
  assert.equal(tries, 1, "停止 pressed during the wait before another try: no further attempt");
  tries = 0;
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {},
    deleteContact: async () => { tries += 1; return { ok: false, stage: "menu", reason: "wechat_external_input_detected" }; } });
  assert.equal(tries, 1, "someone using the mouse is not fought for it");
  // 1.3.76: a reading step the vision model already looked at is not read again; without that look (UIA path, no
  // model) WeChat may just have been slow and the one retry stays.
  tries = 0;
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {},
    deleteContact: async () => { tries += 1; return { ok: false, stage: "member", reason: "chat_member_not_found", eyes: ["member:vision_not_found"] }; } });
  assert.equal(tries, 1, "the model looked at the member step: not repeated");
  tries = 0;
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {},
    deleteContact: async () => { tries += 1; return { ok: false, stage: "confirm", reason: "confirm_dialog_not_shown", eyes: ["member:found"] }; } });
  assert.equal(tries, 2, "the model looked at another step, not the confirm: one more try");
  tries = 0;
  await cleanup.deleteInWechat([plan.wanted[0]], { currentAccount: "当前号", verifyLiveAccount: live, coordinator, wait: async () => {},
    deleteContact: async () => { tries += 1; return { ok: false, stage: "confirm", reason: "confirm_dialog_not_shown" }; } });
  assert.equal(tries, 2, "a slow confirm on the UIA path keeps its retry");

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
  const openConversation = undefined; // (the chat is opened by the script's own search step now)
  const calls = [];
  const runner = (answers) => async (_script, env) => {
    calls.push({ phase: env.XIAOXI_DELETE_PHASE, id: env.XIAOXI_DELETE_WECHAT_ID, query: env.XIAOXI_DELETE_QUERY });
    return env.XIAOXI_DELETE_PHASE === "open" && !("open" in answers) ? { ok: true, opened: true } : answers[env.XIAOXI_DELETE_PHASE];
  };
  const ready = { ok: true, stage: "confirm", ready: true };
  assert.equal((await deleteWechatContact(contact, { confirm: true, focus, openConversation, runner: runner({ prepare: ready, commit: { ok: true, deleted: true, stage: "done" } }) })).deleted, true);
  assert.deepEqual(calls.map((call) => call.phase), ["open", "prepare", "commit"], "删除 is pressed only in a last call, after the confirm was reached");
  assert.equal(calls[0].query, "test_alias", "the chat is opened by searching the 微信号 first");
  // 微信号 gives no single result: the name is searched the same way (click the exact row, never Enter); neither: stop.
  calls.length = 0;
  const byName = await deleteWechatContact(contact, { confirm: true, focus, runner: async (script, env) => { calls.push(env.XIAOXI_DELETE_QUERY || env.XIAOXI_DELETE_PHASE);
    if (env.XIAOXI_DELETE_PHASE === "open") return env.XIAOXI_DELETE_QUERY === "测试客户" ? { ok: true, opened: true } : { ok: false, stage: "open", reason: "search_result_not_found", result_count: 0 };
    return env.XIAOXI_DELETE_PHASE === "prepare" ? ready : { ok: true, deleted: true }; } });
  assert.deepEqual([byName.deleted, calls], [true, ["test_alias", "测试客户", "prepare", "commit"]]);
  // Someone at the mouse during the 微信号 search: the name search does not take the mouse back.
  calls.length = 0;
  const touched = await deleteWechatContact(contact, { confirm: true, focus, runner: async (_s, env) => { calls.push(env.XIAOXI_DELETE_QUERY || env.XIAOXI_DELETE_PHASE);
    return { ok: false, stage: "open", reason: "wechat_external_input_detected" }; } });
  assert.deepEqual([touched.reason, calls], ["wechat_external_input_detected", ["test_alias"]]);
  // 停止 pressed during the 微信号 search: no name search.
  let stopNow = false;
  calls.length = 0;
  const halted = await deleteWechatContact(contact, { confirm: true, focus, stopped: () => stopNow, runner: async (_s, env) => { calls.push(env.XIAOXI_DELETE_QUERY); stopNow = true;
    return { ok: false, stage: "open", reason: "search_result_not_found" }; } });
  assert.deepEqual([halted.reason, calls], ["stopped_by_user", ["test_alias"]]);
  const nowhere = await deleteWechatContact(contact, { confirm: true, focus, runner: runner({ open: { ok: false, stage: "open", reason: "search_result_not_found", result_count: 0 } }) });
  assert.deepEqual([nowhere.stage, nowhere.reason, nowhere.resultCount], ["open", "search_result_not_found", 0]);
  calls.length = 0;
  for (const commit of [{ ok: false, reason: "powershell_timeout" }, { ok: false, reason: "powershell_output_invalid" }, undefined]) {
    const result = await deleteWechatContact(contact, { confirm: true, focus, openConversation, runner: runner({ prepare: ready, commit }) });
    assert.equal(result.outcomeUnknown, true, `after the press, ${commit?.reason || "no answer"} is unknown`);
  }
  const throwing = await deleteWechatContact(contact, { confirm: true, focus, openConversation, runner: async (_s, env) => { if (env.XIAOXI_DELETE_PHASE === "commit") throw new Error("crash"); return env.XIAOXI_DELETE_PHASE === "open" ? { ok: true, opened: true } : ready; } });
  assert.equal(throwing.outcomeUnknown, true);
  const notPressed = await deleteWechatContact(contact, { confirm: true, focus, openConversation, runner: runner({ prepare: ready, commit: { ok: false, stage: "commit", reason: "confirm_dialog_gone", notClicked: true } }) });
  assert.deepEqual([notPressed.outcomeUnknown, notPressed.reason], [false, "confirm_dialog_gone"]);
  calls.length = 0;
  const look = await deleteWechatContact(contact, { confirm: false, focus, openConversation, runner: runner({ prepare: { ok: false, stage: "confirm", reason: "dry_run_stopped_before_delete", dryRun: true } }) });
  assert.deepEqual([look.dryRun, calls.map((call) => call.phase)], [true, ["open", "prepare"]], "a look-only run never reaches the commit call");
  // No usable 微信号: refused unless the name is known to be unique.
  assert.equal((await deleteWechatContact({ name: "测试客户" }, { confirm: true, focus, openConversation, runner: runner({}) })).reason, "contact_name_not_unique");
  // Not WeChat 4: nothing is opened.
  calls.length = 0;
  const old = await deleteWechatContact(contact, { confirm: true, focus: async () => ({ ok: true, processName: "WeChat", windowClass: "WeChatMainWndForPC" }), runner: runner({}) });
  assert.deepEqual([old.reason, calls.length], ["wechat_version_unsupported", 0]);
  // The search result is read by UI Automation and clicked; nothing is pressed with Enter.
  assert.ok(DELETE_SCRIPT.includes("mmui::SearchContentCellView"));
  assert.doesNotMatch(DELETE_SCRIPT, /keybd_event\(0x0D/u, "no Enter key");
  // Keys only into the box named 搜索 while it has the focus (never the chat input with a draft).
  assert.ok(!DELETE_SCRIPT.includes('"Edit" $null "mmui::XValidatorTextEdit"'), "no fallback to another edit box");
  assert.ok(DELETE_SCRIPT.includes("if (-not $searchBox -or -not $searchBox.Current.HasKeyboardFocus) { return }"));
  // The 微信号 patterns keep their backslashes (String.raw): a backslash-s is whitespace, not the letter s.
  const slash = String.fromCharCode(92);
  assert.ok(DELETE_SCRIPT.includes("'^" + slash + "s*微信号" + slash + "s*[:：]?'") && DELETE_SCRIPT.includes("[" + slash + "s" + slash + "u200b-" + slash + "u200f" + slash + "ufeff]"));
  // A 微信号 read on the card that differs always stops; only an unreadable one may go on (unique name).
  assert.ok(DELETE_SCRIPT.includes('elseif ($shownId) { "mismatch" } elseif ($uniqueName) { "degraded_unread" } else { "unread" }'));

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

// 1.3.76: what the screen script cannot find goes to the vision model; labels and names are read the way the field
// showed they must be (b070e34b: "钱总一添加" in one OCR line; an emoji in a name never read).
async function checkVisualEyes(person, focus) {
  const fs = require("node:fs"), path = require("node:path");
  const { pickDeleteStep } = require("./wechat-vision-check.cjs");
  const { deleteWechatContact } = require("../../rpa/active_touch/wechat_delete_contact.cjs");
  const box = (l, t, r, b) => [l, t, r, b];
  // member: one avatar, not a group; the 添加 box never counts.
  assert.deepEqual(pickDeleteStep({ items: [{ role: "avatar", box: box(100, 100, 200, 200) }, { role: "add_button", box: box(300, 100, 400, 200) }] }, { kind: "member" }).points.main, { x: 0.15, y: 0.15 });
  assert.equal(pickDeleteStep({ items: [{ role: "avatar", box: box(0, 0, 10, 10) }, { role: "avatar", box: box(20, 0, 30, 10) }] }, { kind: "member" }).ok, false, "two avatars: a group or unclear");
  assert.equal(pickDeleteStep({ group: true, items: [{ role: "avatar", box: box(0, 0, 10, 10) }] }, { kind: "member" }).group, true);
  assert.equal(pickDeleteStep({ items: [{ role: "avatar", box: box(0, 0, 1200, 10) }] }, { kind: "member" }).ok, false, "a box off the picture");
  // menu: exactly 删除联系人.
  assert.equal(pickDeleteStep({ items: [{ role: "text", text: "删除联系人", box: box(0, 0, 100, 50) }] }, { kind: "menu_item" }).ok, true);
  assert.equal(pickDeleteStep({ items: [{ role: "text", text: "删除聊天记录", box: box(0, 0, 100, 50) }] }, { kind: "menu_item" }).ok, false);
  // confirm: names this person by letters (the flower dropped), read surely, one 删除 button.
  const dialog = (question, extra = {}) => ({ items: [{ role: "text", text: question, box: box(0, 0, 900, 200) },
    { role: "button", text: "取消", box: box(100, 700, 400, 900) }, { role: "button", text: "删除", box: box(600, 700, 900, 900) }], ...extra });
  assert.deepEqual(pickDeleteStep(dialog("删除联系人“测试🌸客户”"), { kind: "confirm", name: "测试🌸客户" }).points, { delete: { x: 0.75, y: 0.8 }, cancel: { x: 0.25, y: 0.8 } });
  assert.equal(pickDeleteStep(dialog("删除联系人“另一个人”"), { kind: "confirm", name: "测试🌸客户" }).reason, "vision_confirm_other");
  assert.equal(pickDeleteStep(dialog("删除联系人“测试客户”", { unsure: true }), { kind: "confirm", name: "测试🌸客户" }).ok, false);
  assert.equal(pickDeleteStep(dialog("删除联系人“🌸”"), { kind: "confirm", name: "🌸" }).ok, false, "no letters to compare: never by text");

  // The folder handshake: the script asks, the app answers once per request with the picked point, then cleans up.
  let folderSeen = "";
  const asked = [], ais = [];
  const eyes = { ready: () => true, deleteStep: async ({ kind, name }) => { asked.push([kind, name]); return { ok: true, points: { main: { x: 0.5, y: 0.25 } } }; } };
  const result = await deleteWechatContact(person, { confirm: false, uniqueName: true, focus, visualOnly: true, eyes, onAi: (kind) => ais.push(kind),
    opener: async () => ({ ok: true }), titleCheck: async () => ({ ok: true }),
    runner: async (_script, env) => {
      folderSeen = env.XIAOXI_VDEL_ASK_DIR;
      fs.writeFileSync(path.join(folderSeen, "prepare-member-1.png"), "png");
      fs.writeFileSync(path.join(folderSeen, "prepare-member-1.req.json"), JSON.stringify({ id: "prepare-member-1", kind: "member", file: path.join(folderSeen, "prepare-member-1.png") }));
      const answerFile = path.join(folderSeen, "prepare-member-1.res.json");
      for (let i = 0; i < 100 && !fs.existsSync(answerFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(JSON.parse(fs.readFileSync(answerFile, "utf8")).points.main, { x: 0.5, y: 0.25 });
      return { ok: false, stage: "confirm", reason: "dry_run_stopped_before_delete", dryRun: true, eyes: ["member:found"] };
    } });
  assert.deepEqual(asked, [["member", person.remark]]);
  assert.deepEqual(ais, ["member"]);
  assert.deepEqual(result.eyes, ["member:found"]);
  assert.ok(folderSeen && !fs.existsSync(folderSeen), "the picture folder is removed after the person");
  // Without the model (not signed in, gateway down) no folder is handed over: the screen reading alone, as before.
  let noFolder = "unset";
  await deleteWechatContact(person, { confirm: false, uniqueName: true, focus, visualOnly: true, eyes: { ready: () => false, deleteStep: async () => ({}) },
    opener: async () => ({ ok: true }), titleCheck: async () => ({ ok: true }), runner: async (_s, env) => { noFolder = env.XIAOXI_VDEL_ASK_DIR; return { ok: false, stage: "member", reason: "chat_member_not_found" }; } });
  assert.equal(noFolder, undefined);

  const { VISUAL_DELETE_SCRIPT: script } = require("../../rpa/active_touch/wechat_delete_contact_visual.cjs");
  assert.ok(script.includes("Find-Label @($lines | Where-Object { $_.top -lt $panel.top }) '添加' 26"), "添加 found inside a line");
  assert.ok(!script.includes("$_.text -eq '添加'") && !script.includes("$_.text -eq '删除联系人' }"), "no whole-line label comparison left");
  for (const kind of ["member", "card_more", "menu_item", "confirm"]) assert.ok(script.includes(`Ask-Eyes "${kind}"`), `AI fallback for ${kind}`);
  assert.ok(script.includes("if (-not $h -or $h -eq $mainHwnd) { return $dialog }"), "the model never looks for 删除 on the chat window itself");
  assert.ok(script.includes('if ([string]$answer.reason -eq "stopped")'), "停止 while the model looks stops at once");
  // Someone at the computer is read from the input events (a low-level hook, as touch's search), our own presses carry
  // the marker, and 微信输入法's injected VK_NONAME is no key; the last-input time decides only without the hook.
  assert.ok(script.includes("[XiaoxiDeleteInputGuard]::Start()") && script.includes("mouse_event(2, 0, 0, 0, [XiaoxiDeleteInputGuard]::Marker)")
    && script.includes("mouse_event(4, 0, 0, 0, [XiaoxiDeleteInputGuard]::Marker)"), "our presses are marked for the input guard");
  assert.ok(script.includes("if (injected && vk == 0xFC)"), "an injected VK_NONAME is counted, not taken for a person");
  assert.ok(!script.includes("UIntPtr]::Zero)") || !/mouse_event\([24], 0, 0, 0, \[UIntPtr\]::Zero\)/u.test(script), "no unmarked press left");
  // 1.3.78 (b070e34b, 1.3.77: the chat window was raised over the card and confirm, which then could not be read and
  // whose 删除 was pressed on the chat window): only the window meant is raised, never the chat window over an open
  // card or confirm, and a press needs that very window under the point.
  assert.ok(script.includes("elseif (-not $popups.Count) { Raise-Window $mainHwnd"), "the chat window is raised only when no card, menu or confirm is open");
  assert.ok(script.includes("if ($at -ne $h -and $ours -notcontains $at)"), "our own menu or confirm over the card is not cover");
  assert.ok(script.includes("Read-Confirm -Still"), "the check after the press moves nothing");
  assert.ok(script.includes("if (-not (& $onTarget))"), "a press needs the window meant under the point");
  for (const read of ["Uncover $card", "Uncover $menuWindow", "if (-not $Still) { Uncover $h }"]) assert.ok(script.includes(read), `uncovered before reading: ${read.trim()}`);
  checkLabelReading(script);
  checkVisualTypeCompiles(script);
  await checkCoreUniqueName();
}

// Two friends whose names differ only by an emoji are the same name to the card check, so neither counts as unique.
async function checkCoreUniqueName() {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-core-unique-"));
  try {
    const row = (wxid, name) => ({ id: `w-${wxid}`, name, remark: name, wxid, wechatId: `wxid_${wxid}`, wechatAccountId: "当前号" });
    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([row("a1", "测试🌸客户"), row("a2", "测试客户"), row("a3", "测试客户乙")]));
    const registry = createUnreachableRegistry(dir);
    registry.record(row("a1", "测试🌸客户"), "deleted");
    registry.record(row("a3", "测试客户乙"), "deleted");
    const cleanup = createTouchCleanup(dir);
    const wanted = [{ accountId: "当前号", key: "a1" }, { accountId: "当前号", key: "a3" }];
    cleanup.remove(wanted);
    const seen = [];
    await cleanup.deleteInWechat(cleanup.planWechatDelete(wanted, { currentAccount: "当前号" }).wanted, { currentAccount: "当前号", verifyLiveAccount: async () => ({ ok: true }),
      coordinator: { acquire: () => ({ ok: true, lock: { owner: "o" } }), release() {} }, wait: async () => {},
      deleteContact: async (contact, options) => { seen.push([contact.name, options.uniqueName]); return { ok: true, deleted: true }; } });
    assert.deepEqual(seen, [["测试🌸客户", false], ["测试客户乙", true]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The C# inside the script is compiled for real: the PowerShell parse check cannot see it (a second POINT once broke
// every run with "visual_script_failed" while every parse check passed).
function checkVisualTypeCompiles(script) {
  const { spawnSync } = require("node:child_process");
  const start = script.indexOf('if (-not ("XiaoxiVisualDelete" -as [type]))');
  const open = script.indexOf('-TypeDefinition @"', start) + '-TypeDefinition @"'.length, close = script.indexOf('"@', open);
  assert.ok(start >= 0 && open > start && close > open, "the XiaoxiVisualDelete type is found");
  // Double-quoted, as the script itself passes it (PowerShell expands $ there).
  const code = `$code = @"${script.slice(open, close)}"@\ntry { Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $code; "compiled" } catch { "failed: " + $_.Exception.Message }`;
  // Encoded: a here-string piped through stdin is not run as one statement.
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 90000 });
  assert.equal(String(run.stdout).trim().split(/\r?\n/u).pop(), "compiled", String(run.stdout).slice(0, 400));
}

// Find-Label and Core run in PowerShell on lines shaped as Windows' OCR gives them (no screen, no OCR).
function checkLabelReading(script) {
  const { spawnSync } = require("node:child_process");
  const pick = (start, end) => { const i = script.indexOf(start), j = script.indexOf(end, i); assert.ok(i >= 0 && j > i, start); return script.slice(i, j); };
  const code = [pick("function Fold", "$plainName ="), pick("function Core", "$coreName ="), pick("function Find-Label", "# AI 看图"),
    // "钱总一添加" as one line of single-character words, 10 px each from x = 100.
    "$words = @(); $i = 0; foreach ($c in '钱总一添加'.ToCharArray()) { $words += @{ t = [string]$c; l = 100 + 10 * $i; r = 110 + 10 * $i; top = 50; b = 62 }; $i++ }",
    "$lines = @(@{ text = '钱总一添加'; words = $words }, @{ text = '取消删除'; words = @(@{ t = '取消删除'; l = 0; r = 80; top = 90; b = 100 }) })",
    "$a = Find-Label $lines '添加' 12; $d = Find-Label $lines '删除' 6; $n = Find-Label $lines '添加' 3",
    "@{ add = $a.x; del = $d.x; short = [bool]$n; core = (Core '测试🌸客户[呲牙]') } | ConvertTo-Json -Compress"].join("\n");
  // Encoded and UTF-8 out: piped through stdin, the Chinese text was garbled on the CI runner (another code page).
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${code}`, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  const answer = JSON.parse(String(run.stdout).trim().split(/\r?\n/u).pop());
  assert.equal(answer.add, 140, "添加 at its own characters, not the line's middle");
  assert.equal(answer.del, 60, "删除 inside one word 取消删除");
  assert.equal(answer.short, false, "a line longer than maxLine is not a label");
  assert.equal(answer.core, "测试客户");
}

// A WeChat with no UI Automation tree (b070e34b, 2026-11-26) is deleted by looking at the screen: the chat opened
// with touch's search and its title checked, then prepare and commit of the visual script. Synthetic person only.
(async () => {
  const { deleteWechatContact } = require("../../rpa/active_touch/wechat_delete_contact.cjs");
  const person = { name: "测试客户甲", remark: "测试客户甲", wechatId: "test_id_01" };
  const focus = async () => ({ ok: true, pid: 11, hWnd: 22, processName: "Weixin" });
  const run = async ({ open = { ok: true }, title = { ok: true }, prepare = { ok: true, ready: true, id_check: { id_check_state: "matched" } }, commit = { ok: true, deleted: true }, uia = null, options = {} } = {}) => {
    const calls = [];
    const runner = async (script, env) => {
      if (!env.XIAOXI_VDEL_PHASE) { calls.push("uia:" + env.XIAOXI_DELETE_PHASE); return uia; }
      calls.push("visual:" + env.XIAOXI_VDEL_PHASE);
      return env.XIAOXI_VDEL_PHASE === "prepare" ? prepare : commit;
    };
    const result = await deleteWechatContact(person, { confirm: true, uniqueName: true, focus, runner, opener: async (query, context) => { calls.push("open:" + context.searchQueryType); return open; },
      titleCheck: async () => { calls.push("title"); return title; }, ...options });
    return { result, calls };
  };
  const forced = await run({ options: { visualOnly: true } });
  assert.deepEqual(forced.calls, ["open:wechat_id", "title", "visual:prepare", "visual:commit"]);
  // The windows already open before prepare reach commit, which never takes, closes or counts them.
  let baselineSeen = null;
  await deleteWechatContact(person, { confirm: true, uniqueName: true, focus, visualOnly: true, opener: async () => ({ ok: true }), titleCheck: async () => ({ ok: true }),
    runner: async (_s, env) => { if (env.XIAOXI_VDEL_PHASE === "commit") baselineSeen = env.XIAOXI_VDEL_BASELINE; return env.XIAOXI_VDEL_PHASE === "prepare" ? { ok: true, ready: true, baseline: "101,202" } : { ok: true, deleted: true }; } });
  assert.equal(baselineSeen, "101,202");
  // No other window open before prepare: the empty list is still handed in (else commit would take the confirm as old).
  let flag = null;
  await deleteWechatContact(person, { confirm: true, uniqueName: true, focus, visualOnly: true, opener: async () => ({ ok: true }), titleCheck: async () => ({ ok: true }),
    runner: async (_s, env) => { if (env.XIAOXI_VDEL_PHASE === "commit") flag = [env.XIAOXI_VDEL_HAS_BASELINE, env.XIAOXI_VDEL_BASELINE]; return env.XIAOXI_VDEL_PHASE === "prepare" ? { ok: true, ready: true, baseline: "" } : { ok: true, deleted: true }; } });
  assert.deepEqual(flag, ["1", ""]);
  const { VISUAL_DELETE_SCRIPT: script } = require("../../rpa/active_touch/wechat_delete_contact_visual.cjs");
  assert.match(script, /XIAOXI_VDEL_HAS_BASELINE -eq "1"/u, "commit tells an empty list from none");
  // An unconfirmed 微信号 then the name: the same rule as touch (no first-row guess).
  const searches = [];
  await deleteWechatContact(person, { confirm: false, uniqueName: true, focus, visualOnly: true, titleCheck: async () => ({ ok: false }), runner: async () => ({ ok: false, reason: "x" }),
    opener: async (query, context) => { searches.push([context.searchQueryType, context.searchFallbackReason]); return searches.length === 1 ? { ok: false, reason: "search_result_identity_unverified" } : { ok: false, reason: "y" }; } });
  assert.deepEqual(searches, [["wechat_id", ""], ["name_fallback", "wechat_id_unverified"]]);
  assert.equal(forced.result.deleted, true); assert.equal(forced.result.visual, true); assert.equal(forced.result.idCheck.id_check_state, "matched");
  const fallback = await run({ uia: { ok: false, stage: "open", reason: "search_box_not_found" }, options: { visualOnly: false } });
  assert.deepEqual(fallback.calls, ["uia:open", "open:wechat_id", "title", "visual:prepare", "visual:commit"], "no UIA tree: the screen is read instead");
  // A title that could not be read: the card's 微信号 alone decides (the script requires an exact match).
  const unread = await run({ title: { ok: false }, options: { visualOnly: true } });
  assert.deepEqual(unread.calls, ["open:wechat_id", "title", "visual:prepare", "visual:commit"]);
  let required = "";
  await deleteWechatContact(person, { confirm: true, uniqueName: true, focus, visualOnly: true, opener: async () => ({ ok: true }), titleCheck: async () => ({ ok: false }),
    runner: async (_s, env) => { required = env.XIAOXI_DELETE_REQUIRE_ID; return { ok: false, stage: "profile", reason: "chat_title_mismatch" }; } });
  assert.equal(required, "1", "the card must show exactly this 微信号");
  const noId = await deleteWechatContact({ name: "测试客户乙", remark: "测试客户乙" }, { confirm: true, uniqueName: true, focus, visualOnly: true, opener: async () => ({ ok: true }),
    titleCheck: async () => ({ ok: false }), runner: async () => { throw new Error("must not run"); } });
  assert.equal(noId.reason, "chat_title_mismatch", "no title and no 微信号: stop before anything");
  const dry = await run({ prepare: { ok: false, stage: "confirm", reason: "dry_run_stopped_before_delete", dryRun: true }, options: { visualOnly: true, confirm: false } });
  assert.deepEqual([dry.result.deleted, dry.calls.includes("visual:commit")], [false, false], "a look-only run never presses 删除");
  const silent = await run({ commit: null, options: { visualOnly: true } });
  assert.deepEqual([silent.result.deleted, silent.result.outcomeUnknown], [false, true], "after the press, no clear answer is unknown, never retried");
  const gone = await run({ commit: { ok: false, stage: "commit", reason: "confirm_dialog_gone", notClicked: true }, options: { visualOnly: true } });
  assert.deepEqual([gone.result.deleted, gone.result.outcomeUnknown], [false, false], "a confirm gone before the press: not deleted, can be tried again");
  const { VISUAL_DELETE_SCRIPT } = require("../../rpa/active_touch/wechat_delete_contact_visual.cjs");
  assert.ok(!/SendWait\("\{ESC\}"\)|keybd_event\(0x1B/u.test(VISUAL_DELETE_SCRIPT), "never Esc on the visual path: it hides WeChat 4");
  assert.ok(VISUAL_DELETE_SCRIPT.includes("visual_point_invalid") && VISUAL_DELETE_SCRIPT.includes("OwnerAt"), "a press only on a real point inside WeChat");
  await checkVisualEyes(person, focus);
  console.log("visual delete routing self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
