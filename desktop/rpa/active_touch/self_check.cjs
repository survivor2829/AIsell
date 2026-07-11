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
  loadState,
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
const { sendReal, setRealSendArm, verifyMessageBubble, verifyRealSendSession } = require("./state_machine.dev.cjs");
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

  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_internal", name: "测试客户", wxid: "wxid_internal", wechatId: "internal-test-001", wechatAccountId: "internal-account", allowed: true }]), "utf8");
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
  assert.equal(searchQuery, "internal-test-001");
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
  assert.equal(setRealSendArm(dir, true).blocked_reason, "real_send_session_not_verified");
  saveState(dir, { ...loadState(dir), wechat_account_id: "" });
  assert.equal(verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "", accountVerified: false })).blocked_reason, "wechat_account_not_verified");
  assert.equal(verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "other-account", accountVerified: true })).blocked_reason, "wechat_account_changed");
  assert.equal(verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true })).ok, true);
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(setRealSendArm(dir, true).state.real_send_armed, true);
  assert.equal(sendReal(dir, { message: "hello" }).blocked_reason, "real_send_explicit_allow_missing");
  assert.equal(verifyMessageBubble(dir, () => ({ ok: true })).blocked_reason, "real_send_not_clicked");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true })).ok, true);
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(setRealSendArm(dir, true).state.real_send_armed, true);
  assert.equal(sendReal(dir, { message: "hello", allowRealSend: true }).blocked_reason, "real_send_final_confirmation_missing");
  send(dir, { dryRun: true, message: "hello" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  let legacySendCalls = 0;
  const legacyBubbleResult = sendReal(
    dir,
    { message: "hello", allowRealSend: true, userConfirmed: true },
    () => { legacySendCalls += 1; return { ok: true }; },
    () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true }),
    () => ({ ok: true })
  );
  assert.equal(legacyBubbleResult.blocked_reason, "message_snapshot_unavailable");
  assert.equal(legacySendCalls, 0);
  send(dir, { dryRun: true, message: "hello" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  const bubblePhases = [];
  const sent = sendReal(
    dir,
    { message: "hello", allowRealSend: true, userConfirmed: true },
    () => {
      assert.equal(loadState(dir).real_send_status, "prepared");
      assert.deepEqual(loadState(dir).message_bubble_snapshot_before, { lastMessageId: "before-1" });
      return { ok: true, title: "测试客户 - 微信" };
    },
    () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true }),
    (message, context) => {
      bubblePhases.push(context.phase);
      if (context.phase === "before") return { ok: true, snapshot: { lastMessageId: "before-1" } };
      assert.equal(message, "hello");
      assert.deepEqual(context.beforeSnapshot, { lastMessageId: "before-1" });
      return { ok: true, title: "测试客户 - 微信", messageText: "hello", exactMatch: true, outgoing: true, isLatest: true, isNew: true };
    }
  );
  assert.deepEqual(bubblePhases, ["before", "after"]);
  assert.equal(sent.state.real_send_status, "sent_verified");
  assert.equal(setRealSendArm(dir, true).blocked_reason, "real_send_already_attempted");
  assert.equal(setRealSendArm(dir, false).state.real_send_status, "sent_verified");
  clearCustomer(dir);
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_unknown", name: "未知结果客户", wxid: "wxid_unknown", wechatId: "internal-test-002", wechatAccountId: "internal-account", allowed: true }]), "utf8");
  selectCustomer(dir, "wxid_unknown");
  verifyConversation(dir, "未知结果客户");
  inputMessageDryRun(dir, "second", () => ({ ok: true }));
  send(dir, { dryRun: true, message: "second" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 12, hWnd: "23", processName: "Weixin", title: "未知结果客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  assert.equal(sendReal(
    dir,
    { message: "second", allowRealSend: true, userConfirmed: true },
    () => ({ ok: true }),
    () => ({ ok: true, pid: 12, hWnd: "23", processName: "Weixin", title: "未知结果客户", accountId: "internal-account", accountVerified: true }),
    (_message, context) => context.phase === "before"
      ? { ok: true, snapshot: { lastMessageId: "history-1" } }
      : { ok: true, messageText: "second", exactMatch: true, outgoing: true, isLatest: true, isNew: false }
  ).state.real_send_status, "outcome_unknown");
  assert.equal(setRealSendArm(dir, false).state.real_send_status, "outcome_unknown");
  assert.equal(verifyMessageBubble(dir, () => ({ ok: true, messageText: "second!", exactMatch: true, outgoing: true, isLatest: true, isNew: true })).state.real_send_status, "outcome_unknown");
  assert.equal(setRealSendArm(dir, true).blocked_reason, "real_send_already_attempted");
  const unknownAttemptKey = loadState(dir).real_send_attempt_key;
  const clearedUnknown = clearCustomer(dir);
  assert.equal(clearedUnknown.state.real_send_attempts[unknownAttemptKey], "outcome_unknown");
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_window", name: "窗口变化客户", wxid: "wxid_window", wechatId: "internal-test-005", wechatAccountId: "internal-account", allowed: true }]), "utf8");
  selectCustomer(dir, "wxid_window");
  verifyConversation(dir, "窗口变化客户");
  inputMessageDryRun(dir, "window", () => ({ ok: true }));
  send(dir, { dryRun: true, message: "window" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 13, hWnd: "24", processName: "Weixin", title: "窗口变化客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  assert.equal(sendReal(dir, { message: "window", allowRealSend: true, userConfirmed: true }, () => ({ ok: true }), () => ({ ok: true, pid: 14, hWnd: "25", processName: "Weixin", title: "窗口变化客户", accountId: "internal-account", accountVerified: true })).blocked_reason, "real_send_session_changed");
  clearCustomer(dir);
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_exception", name: "验证异常客户", wechatId: "internal-test-006", wechatAccountId: "internal-account", allowed: true }]), "utf8");
  selectCustomer(dir, "wxid_exception");
  verifyConversation(dir, "验证异常客户");
  inputMessageDryRun(dir, "exception", () => ({ ok: true }));
  send(dir, { dryRun: true, message: "exception" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 15, hWnd: "26", processName: "Weixin", title: "验证异常客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  assert.equal(sendReal(
    dir,
    { message: "exception", allowRealSend: true, userConfirmed: true },
    () => ({ ok: true }),
    () => ({ ok: true, pid: 15, hWnd: "26", processName: "Weixin", title: "验证异常客户", accountId: "internal-account", accountVerified: true }),
    (_message, context) => {
      if (context.phase === "before") return { ok: true, snapshot: { lastMessageId: "before-exception" } };
      throw new Error("bubble verifier failed");
    }
  ).state.real_send_status, "outcome_unknown");
  clearCustomer(dir);
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([
    { id: "dup-a", name: "同名客户", wechatId: "internal-test-003", wechatAccountId: "internal-account", allowed: true },
    { id: "dup-b", name: "同名客户", wechatId: "internal-test-004", wechatAccountId: "internal-account", allowed: true }
  ]), "utf8");
  selectCustomer(dir, "dup-a");
  verifyConversation(dir, "同名客户");
  inputMessageDryRun(dir, "duplicate", () => ({ ok: true }));
  send(dir, { dryRun: true, message: "duplicate" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 13, hWnd: "24", processName: "Weixin", title: "同名客户", accountId: "internal-account", accountVerified: true }));
  assert.equal(setRealSendArm(dir, true).blocked_reason, "contact_name_not_unique");
  saveState(dir, { ...loadState(dir), real_send_armed: false, real_send_status: "prepared", real_send_attempts: { crash_attempt: "prepared" } });
  assert.equal(setRealSendArm(dir, true).blocked_reason, "real_send_already_attempted");
  assert.equal(setRealSendArm(dir, false).state.real_send_armed, false);
  const cleared = clearCustomer(dir);
  assert.equal(cleared.state.calibrated, true);
  assert.equal(cleared.state.real_send_attempts.crash_attempt, "prepared");
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
  const developmentDriverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.dev.cjs"), "utf8");
  assert.equal(driverSource.includes("clickWechatSendButton"), false);
  assert.equal(driverSource.includes("SEND_MESSAGE_SCRIPT"), false);
  assert.equal(driverSource.includes("XIAOXI_SEND_KEY"), false);
  assert.equal(driverSource.includes("verifyWechatMessageBubble"), false);
  assert.match(developmentDriverSource, /function clickWechatSendButton/);
  assert.match(developmentDriverSource, /context\.phase === "after" \? "after" : "before"/);
  assert.match(developmentDriverSource, /beforeSnapshot/);
  assert.match(developmentDriverSource, /exactMatch/);
  assert.match(developmentDriverSource, /outgoing/);
  assert.match(developmentDriverSource, /isLatest/);
  assert.match(developmentDriverSource, /isNew/);
  assert.match(developmentDriverSource, /function detectActiveWechatAccount/);
  assert.match(developmentDriverSource, /\*\.db-wal/);
  assert.match(developmentDriverSource, /\$outgoingExact\.Count -gt \$beforeExactCount/);
  assert.ok(driverSource.includes('$processNames = @("Weixin", "WeChat")'));
  assert.equal(driverSource.includes("WXWork"), false);
  assert.equal(driverSource.includes("WeChatAppEx"), false);
  assert.doesNotMatch(driverSource, /\$pf86\\\\Tencent\\\\WeChat\\\\WeChat\.exe",\s*\n\s*\)\)/);
  assert.match(driverSource, /const SIMPLE_ENSURE_WECHAT_WINDOW_SCRIPT/);
  assert.match(driverSource, /Buffer\.from\(SIMPLE_ENSURE_WECHAT_WINDOW_SCRIPT/);
  assert.equal(driverSource.includes("if (!ensureResult.ok) return ensureResult;"), false);
  assert.match(driverSource, /if \(Test-VisiblePersonalWechat\) \{ \[void\]\(Focus-PersonalWechatMainWindowByAutomation\) \}/);
  assert.equal(driverSource.includes("XIAOXI_EXPECTED_ACCOUNT"), false);
  const taskIpcSource = fs.readFileSync(path.join(__dirname, "../../src/main/touch-task-ipc.cjs"), "utf8");
  assert.match(taskIpcSource, /function shouldSkipBlockedContact\([^)]*\)[\s\S]*contact_unavailable/);
  const developmentPreloadSource = fs.readFileSync(path.join(__dirname, "../../src/main/preload.dev.cjs"), "utf8");
  assert.match(developmentPreloadSource, /active-touch:dev-select-customer/);
  assert.match(developmentPreloadSource, /active-touch:dev-calibrate/);
  assert.match(developmentPreloadSource, /active-touch:dev-click-search-result/);
  assert.match(developmentPreloadSource, /active-touch:dev-input-message/);
  assert.match(developmentPreloadSource, /active-touch:dev-send-dry-run/);
  assert.match(developmentPreloadSource, /active-touch:send-selected-contact/);
  assert.equal(developmentPreloadSource.includes("active-touch:send-real"), false);
  assert.equal(developmentPreloadSource.includes("sendReal:"), false);
  assert.equal(developmentPreloadSource.includes("real-send-hold"), false);
  const developmentCliSource = fs.readFileSync(path.join(__dirname, "active_touch_cli.dev.cjs"), "utf8");
  assert.equal(developmentCliSource.includes('args.includes("--real")'), false);
  assert.equal(developmentCliSource.includes("--user-confirmed"), false);
  const developmentIpcSource = fs.readFileSync(path.join(__dirname, "../../src/main/active-touch-dev-ipc.cjs"), "utf8");
  assert.match(developmentIpcSource, /clickToken/);
  assert.match(developmentIpcSource, /select-customer[\s\S]*calibrate[\s\S]*click-search-result-dry-run[\s\S]*verify-real-send-session[\s\S]*input-message-dry-run[\s\S]*send[\s\S]*dry-run/);
  assert.match(developmentIpcSource, /setRealSendArm\(runtimeDataDir, true\)[\s\S]*sendReal\(runtimeDataDir/);
  assert.equal(developmentIpcSource.includes("real-send-hold"), false);
  const developmentUiSource = fs.readFileSync(path.join(__dirname, "../../src/renderer/DevelopmentAcceptance.tsx"), "utf8");
  assert.match(developmentUiSource, /sendSelectedContact/);
  assert.match(developmentUiSource, /data-xiaoxi-real-send/);
  assert.match(developmentUiSource, /replaceAll\("\{称呼\}"/);
  assert.match(developmentUiSource, /setStatus\("开发执行器未连接"\)/);
  assert.match(developmentUiSource, /<Send size=\{17\} \/>直接发送<\/button>/);
  assert.equal(developmentUiSource.includes("按住3秒"), false);
  assert.equal(developmentUiSource.includes("beginRealSendHold"), false);
  assert.equal(fs.existsSync(path.join(__dirname, "../../src/main/real-send-hold.dev.cjs")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "../../src/main/real-send-hold.self_check.cjs")), false);
  assert.match(driverSource, /\$proc\.MainWindowHandle -eq \$hWnd/);
  assert.match(driverSource, /\$title -eq "微信"/);

  saveState(dir, { ...loadState(dir), self_check_marker: true });
  assert.equal(fs.readdirSync(dir).some((name) => name.includes("state.json.tmp")), false);
  fs.writeFileSync(path.join(dir, "state.json"), "{", "utf8");
  assert.throws(() => loadState(dir));

  console.log("active-touch self-check passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
