const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  calibrate,
  clickSearchResultDryRun,
  clearCustomer,
  focusWechatWindowDryRun,
  inputMessageDryRun,
  locateConversation,
  openConversationDryRun,
  queueDryRun,
  searchConversationDryRun,
  selectCustomer,
  saveState,
  send,
  status,
  verifyConversation,
  verifySendResultDryRun,
  verifyWindowTitle
} = require("./state_machine.cjs");
const { sendReal, setRealSendArm, verifyMessageBubble } = require("./state_machine.dev.cjs");
const {
  createTask,
  cleanupTaskCache,
  fillTouchTemplate,
  hasUnfinishedPausedTask,
  loadTaskState,
  publicTaskState,
  recoverInterruptedTask,
  saveTaskState,
  taskBackupPath
} = require("./touch_task_state.cjs");
const { main: runActiveTouchCli } = require("./active_touch_cli.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-active-touch-"));

try {
  const task = createTask(
    "{称呼}，您好",
    [
      { id: "task-1", name: "默认名", remark: "备注名", nickname: "昵称", allowed: true },
      { id: "task-2", name: "昵称客户", nickname: "昵称客户", allowed: true },
      { id: "task-3", name: "禁用客户", allowed: false }
    ],
    "2026-07-09T00:00:00.000Z"
  );
  assert.equal(task.total, 2);
  assert.equal(task.results[0].contact.source, "微信通讯录");
  assert.equal(fillTouchTemplate(task.script, task.results[0].contact), "备注名，您好");
  assert.equal(fillTouchTemplate(task.script, task.results[1].contact), "昵称客户，您好");
  task.status = "paused";
  task.results[0].status = "blocked";
  assert.equal(hasUnfinishedPausedTask(task, "{称呼}，您好"), true);
  assert.equal(hasUnfinishedPausedTask(task, "其他话术"), true);
  task.status = "running";
  task.current_index = 1;
  task.results[0].status = "processing";
  assert.equal(publicTaskState(task).task.current_contact.name, "备注名");
  assert.equal(publicTaskState(task).task.next_contact.name, "昵称客户");
  task.results[0].status = "blocked";
  task.status = "paused";
  saveTaskState(dir, task);
  assert.equal(loadTaskState(dir).total, 2);
  assert.equal(fs.existsSync(taskBackupPath(dir)), true);
  const intact = loadTaskState(dir);
  const interrupted = spawnSync(process.execPath, [
    "-e",
    "const fs=require('node:fs'); const file=process.argv[1]; const handle=fs.openSync(file,'w'); fs.writeFileSync(handle,'{\\\"status\\\":'); fs.fsyncSync(handle); fs.closeSync(handle); process.exit(99);",
    `${path.join(dir, "touch_task.json")}.tmp`
  ]);
  assert.equal(interrupted.status, 99);
  assert.equal(loadTaskState(dir).id, intact.id);
  fs.writeFileSync(path.join(dir, "touch_task.json"), "{broken", "utf8");
  const restoredFromBackup = loadTaskState(dir);
  assert.equal(restoredFromBackup.status, "paused");
  assert.equal(restoredFromBackup.recovery_notice, "restored_from_backup");
  fs.writeFileSync(path.join(dir, "touch_task.json"), "{broken", "utf8");
  fs.writeFileSync(taskBackupPath(dir), "{broken", "utf8");
  assert.equal(loadTaskState(dir).integrity_error, "task_state_corrupt");
  saveTaskState(dir, task);
  fs.writeFileSync(path.join(dir, "touch_task.json"), `\uFEFF${JSON.stringify(task)}`, "utf8");
  assert.equal(loadTaskState(dir).total, 2);
  task.status = "running";
  task.current_index = 1;
  task.results[1].status = "processing";
  saveTaskState(dir, task);
  const recoveredTask = recoverInterruptedTask(dir);
  assert.equal(recoveredTask.status, "paused");
  assert.equal(recoveredTask.results[1].status, "pending");

  const contextTask = createTask("测试", [{ id: "context-a", name: "A" }, { id: "context-b", name: "B" }]);
  saveTaskState(dir, contextTask);
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "context-a", name: "A", allowed: true }]), "utf8");
  const missingContext = runActiveTouchCli(["node", "active_touch_cli.cjs", "input-message-dry-run", "--data-dir", dir, "--message", "hello"]);
  assert.equal(missingContext.blocked_reason, "task_context_missing");
  const mismatchedContext = runActiveTouchCli([
    "node", "active_touch_cli.cjs", "input-message-dry-run", "--data-dir", dir, "--message", "hello",
    "--task-id", contextTask.id, "--contact-id", "context-b", "--current-index", "0"
  ]);
  assert.equal(mismatchedContext.blocked_reason, "task_context_mismatch");
  const selected = runActiveTouchCli([
    "node", "active_touch_cli.cjs", "select-customer", "--data-dir", dir, "--id", "context-a",
    "--task-id", contextTask.id, "--contact-id", "context-a", "--current-index", "0"
  ]);
  assert.equal(selected.ok, true);
  saveState(dir, {
    ...selected.state,
    selected_customer: { id: "context-b", name: "B" }
  });
  const executorMismatch = runActiveTouchCli([
    "node", "active_touch_cli.cjs", "input-message-dry-run", "--data-dir", dir, "--message", "hello",
    "--task-id", contextTask.id, "--contact-id", "context-a", "--current-index", "0"
  ]);
  assert.equal(executorMismatch.blocked_reason, "executor_contact_mismatch");
  clearCustomer(dir);
  fs.writeFileSync(path.join(dir, "run_logs.jsonl"), `${Array.from({ length: 2000 }, (_, index) => JSON.stringify({ index, text: "x".repeat(300) })).join("\n")}\n`, "utf8");
  assert.equal(cleanupTaskCache(dir).logTrimmed, true);
  assert.ok(fs.readFileSync(path.join(dir, "run_logs.jsonl"), "utf8").split(/\r?\n/).length <= 502);

  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "not_calibrated");
  calibrate(dir);
  assert.equal(focusWechatWindowDryRun(dir, () => ({ ok: false, reason: "wechat_focus_failed" })).blocked_reason, "wechat_focus_failed");
  assert.equal(focusWechatWindowDryRun(dir, () => ({ ok: true, title: "企业微信", processName: "WXWork" })).state.last_result, "wechat_window_focused");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "no_whitelist_customer");

  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_internal", name: "测试客户", wxid: "wxid_internal", allowed: true }]), "utf8");
  assert.equal(status(dir).contacts.length, 1);
  assert.equal(verifyConversation(dir, "测试客户").blocked_reason, "no_whitelist_customer");
  assert.equal(selectCustomer(dir, "wxid_internal").state.selected_customer.name, "测试客户");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "conversation_not_verified");
  assert.equal(inputMessageDryRun(dir, "hello", () => ({ ok: true })).blocked_reason, "conversation_not_verified");
  assert.equal(locateConversation(dir, () => ["其他窗口"]).blocked_reason, "conversation_window_not_found");
  assert.equal(locateConversation(dir, () => ["测试客户 - 企业微信"]).state.conversation_located, true);
  assert.equal(verifyWindowTitle(dir, () => ["测试客户 - 企业微信"]).state.conversation_verified, true);
  const openNoWindow = openConversationDryRun(dir, () => ({ ok: false }), () => []);
  assert.equal(openNoWindow.blocked_reason, "wechat_window_not_found");
  assert.equal(openNoWindow.state.conversation_located, false);
  assert.equal(openConversationDryRun(dir, () => ({ ok: false, reason: "wechat_focus_failed" }), () => []).blocked_reason, "wechat_focus_failed");
  assert.equal(
    openConversationDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["企业微信"]).blocked_reason,
    "customer_conversation_not_found"
  );
  assert.equal(openConversationDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["测试客户 - 企业微信"]).ok, true);
  assert.equal(searchConversationDryRun(dir, () => ({ ok: false }), () => []).blocked_reason, "wechat_window_not_found");
  let searchQuery = "";
  searchConversationDryRun(dir, (query) => {
    searchQuery = query;
    return { ok: true, title: "企业微信" };
  }, () => ["企业微信"]);
  assert.equal(searchQuery, "测试客户");
  const searchOnly = searchConversationDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["企业微信"]);
  assert.equal(searchOnly.state.search_input_done, true);
  assert.equal(searchOnly.state.conversation_verified, false);
  assert.equal(
    searchConversationDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["测试客户 - 企业微信"]).state.conversation_verified,
    true
  );
  const clickNoWindow = clickSearchResultDryRun(dir, () => ({ ok: false }), () => []);
  assert.equal(clickNoWindow.blocked_reason, "wechat_window_not_found");
  assert.equal(clickNoWindow.state.conversation_located, false);
  const clickMismatch = clickSearchResultDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["企业微信"], () => ({ ok: false }));
  assert.equal(clickMismatch.blocked_reason, "search_result_not_opened");
  assert.equal(clickMismatch.state.conversation_located, false);
  const unavailableContact = clickSearchResultDryRun(
    dir,
    () => ({ ok: true, title: "微信" }),
    () => ["微信"],
    () => ({ ok: false, reason: "contact_unavailable", title: "已停用的微信用户" })
  );
  assert.equal(unavailableContact.blocked_reason, "contact_unavailable");
  assert.equal(
    clickSearchResultDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["企业微信"], () => ({ ok: true, title: "测试客户" })).state.search_result_clicked,
    true
  );
  assert.equal(
    clickSearchResultDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["测试客户 - 企业微信"], () => ({ ok: false })).state.search_result_clicked,
    true
  );
  assert.equal(verifyConversation(dir, "其他客户").blocked_reason, "conversation_mismatch");
  assert.equal(verifyConversation(dir, "测试客户").state.conversation_verified, true);
  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "message_not_input");
  assert.equal(inputMessageDryRun(dir, "", () => ({ ok: true })).blocked_reason, "empty_message");
  assert.equal(inputMessageDryRun(dir, "hello", () => ({ ok: false })).blocked_reason, "message_input_failed");
  assert.equal(inputMessageDryRun(dir, "hello", () => ({ ok: true, draftVerified: false })).blocked_reason, "message_input_failed");
  assert.equal(inputMessageDryRun(dir, "hello", () => ({ ok: true, title: "测试客户 - 企业微信" })).state.message_input_done, true);
  assert.equal(send(dir, { dryRun: true, message: "changed" }).blocked_reason, "message_draft_changed");
  assert.equal(verifySendResultDryRun(dir, () => ["测试客户 - 企业微信"]).blocked_reason, "send_gate_not_passed");
  assert.equal(setRealSendArm(dir, true).blocked_reason, "send_gate_not_passed");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(verifySendResultDryRun(dir, () => ["其他窗口"]).blocked_reason, "post_send_conversation_mismatch");
  assert.equal(verifySendResultDryRun(dir, () => ["测试客户 - 企业微信"]).state.post_send_verified, true);
  assert.equal(sendReal(dir, { message: "hello" }).blocked_reason, "real_send_not_armed");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(setRealSendArm(dir, true).state.real_send_armed, true);
  assert.equal(sendReal(dir, { message: "hello" }).blocked_reason, "real_send_explicit_allow_missing");
  assert.equal(verifyMessageBubble(dir, () => ({ ok: true })).blocked_reason, "real_send_not_clicked");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(setRealSendArm(dir, true).state.real_send_armed, true);
  assert.equal(sendReal(dir, { message: "hello", allowRealSend: true }, () => ({ ok: false })).blocked_reason, "real_send_failed");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(setRealSendArm(dir, true).state.real_send_armed, true);
  assert.equal(sendReal(dir, { message: "hello", allowRealSend: true }, () => ({ ok: true, title: "测试客户 - 企业微信" })).state.real_send_clicked, true);
  assert.equal(verifyMessageBubble(dir, () => ({ ok: false })).blocked_reason, "message_bubble_not_found");
  assert.equal(verifyMessageBubble(dir, () => ({ ok: true, title: "测试客户 - 企业微信" })).state.message_bubble_verified, true);
  assert.equal(setRealSendArm(dir, false).state.real_send_armed, false);
  const cleared = clearCustomer(dir);
  assert.equal(cleared.state.calibrated, true);
  assert.equal(cleared.state.target_selected, false);
  assert.equal(cleared.state.selected_customer, null);
  assert.equal(cleared.state.conversation_located, false);
  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "no_whitelist_customer");

  fs.writeFileSync(
    path.join(dir, "contacts.json"),
    JSON.stringify([
      { id: "q1", name: "Queue A", allowed: true },
      { id: "q2", name: "Queue B", allowed: true },
      { id: "q3", name: "Queue C", allowed: true },
      { id: "q4", name: "Queue D", allowed: true }
    ]),
    "utf8"
  );
  assert.equal(queueDryRun(dir, [], "hello").blocked_reason, "queue_empty");
  assert.equal(queueDryRun(dir, ["q1", "q2", "q3", "q4"], "hello").blocked_reason, "queue_limit_exceeded");
  assert.equal(queueDryRun(dir, ["q1"], "").blocked_reason, "empty_message");
  assert.equal(queueDryRun(dir, ["q1", "missing"], "hello").blocked_reason, "queue_customer_not_found");
  assert.equal(
    queueDryRun(
      dir,
      ["q1"],
      "hello",
      () => ({ ok: true, title: "微信" }),
      () => ({ ok: true, title: "微信", draftVerified: false }),
      () => ["Queue A - 微信"],
      () => ({ ok: true })
    ).blocked_reason,
    "queue_message_input_failed"
  );
  const queueResult = queueDryRun(
    dir,
    ["q1", "q2"],
    "hello",
    () => ({ ok: true, title: "微信" }),
    () => ({ ok: true, title: "微信" }),
    () => ["Queue A - 微信", "Queue B - 微信"],
    () => ({ ok: true })
  );
  assert.equal(queueResult.state.queue_dry_run_passed, true);
  assert.equal(queueResult.state.queue_dry_run_count, 2);
  assert.equal(queueResult.state.queue_dry_run_results.length, 2);
  assert.equal(queueResult.state.selected_customer.name, "Queue B");
  assert.equal(queueResult.state.real_send_clicked, false);

  const driverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.cjs"), "utf8");
  assert.ok(driverSource.includes('$processNames = @("Weixin", "WeChat", "WXWork")'));
  assert.equal(driverSource.includes('$processNames = @("Weixin", "WeChat")'), false);
  assert.equal(driverSource.includes("WeChatAppEx"), false);
  const taskIpcSource = fs.readFileSync(path.join(__dirname, "../../src/main/touch-task-ipc.cjs"), "utf8");
  assert.match(taskIpcSource, /function shouldSkipBlockedContact\([^)]*\)[\s\S]*contact_unavailable/);

  console.log("active-touch self-check passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
