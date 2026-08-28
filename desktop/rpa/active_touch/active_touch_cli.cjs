#!/usr/bin/env node

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
  send,
  loadState,
  saveState,
  status,
  verifyConversation,
  verifySendResultDryRun,
  verifyWindowTitle
} = require("./state_machine.cjs");
const { loadTaskState } = require("./touch_task_state.cjs");
const { absoluteDataDirError } = require("./active_touch_data_dir.cjs");

const STATEFUL_COMMANDS = new Set([
  "status",
  "calibrate",
  "focus-wechat-window",
  "clear-customer",
  "select-customer",
  "verify-conversation",
  "locate-conversation",
  "open-conversation-dry-run",
  "search-conversation-dry-run",
  "click-search-result-dry-run",
  "input-message-dry-run",
  "queue-dry-run",
  "verify-send-result-dry-run",
  "verify-window-title",
  "send"
]);

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return "";
  return args[index + 1];
}

function optionalValueAfter(args, flag) {
  return args.includes(flag) ? valueAfter(args, flag) : undefined;
}

function taskContext(args) {
  return {
    taskId: valueAfter(args, "--task-id"),
    contactId: valueAfter(args, "--contact-id"),
    currentIndex: Number(valueAfter(args, "--current-index"))
  };
}

function contextError(command, code, error) {
  return { ok: false, action: command, blocked_reason: code, error, logs: [] };
}

function validateTaskContext(command, baseDir, args) {
  const context = taskContext(args);
  if (!context.taskId || !context.contactId || !Number.isInteger(context.currentIndex) || context.currentIndex < 0) {
    return { error: contextError(command, "task_context_missing", "任务执行命令缺少 taskId、contactId 或 currentIndex") };
  }
  const task = loadTaskState(baseDir);
  const current = task.results?.[context.currentIndex];
  if (
    task.integrity_error ||
    task.id !== context.taskId ||
    task.status !== "running" ||
    task.current_index !== context.currentIndex ||
    !current ||
    String(current.id) !== context.contactId
  ) {
    return { error: contextError(command, "task_context_mismatch", "任务当前联系人已变化，已阻断执行器") };
  }
  return { context };
}

function selectedContactMatches(baseDir, context) {
  const state = loadState(baseDir);
  const saved = state.task_context;
  return (
    saved &&
    saved.task_id === context.taskId &&
    saved.contact_id === context.contactId &&
    saved.current_index === context.currentIndex &&
    String(state.selected_customer?.id ?? "") === context.contactId
  );
}

function requiresSelectedContact(command) {
  return new Set([
    "verify-conversation",
    "locate-conversation",
    "open-conversation-dry-run",
    "search-conversation-dry-run",
    "click-search-result-dry-run",
    "input-message-dry-run",
    "send",
    "verify-send-result-dry-run",
    "verify-window-title"
  ]).has(command);
}

function saveTaskContext(baseDir, context, result) {
  const nextState = {
    ...loadState(baseDir),
    task_context: {
      task_id: context.taskId,
      contact_id: context.contactId,
      current_index: context.currentIndex
    }
  };
  saveState(baseDir, nextState);
  return { ...result, state: nextState };
}

function execute(command, baseDir, args) {
  if (command === "status") return status(baseDir);
  if (command === "calibrate") return calibrate(baseDir);
  if (command === "focus-wechat-window") return focusWechatWindowDryRun(baseDir);
  if (command === "clear-customer") return clearCustomer(baseDir);
  if (command === "select-customer") return selectCustomer(baseDir, valueAfter(args, "--id"));
  if (command === "verify-conversation") return verifyConversation(baseDir, valueAfter(args, "--title"));
  if (command === "locate-conversation") return locateConversation(baseDir);
  if (command === "open-conversation-dry-run") return openConversationDryRun(baseDir);
  if (command === "search-conversation-dry-run") return searchConversationDryRun(baseDir);
  if (command === "click-search-result-dry-run") {
    return clickSearchResultDryRun(baseDir, undefined, undefined, undefined, {
      pid: optionalValueAfter(args, "--expected-pid"),
      hWnd: optionalValueAfter(args, "--expected-hwnd"),
      minIdleMs: optionalValueAfter(args, "--min-idle-ms")
    });
  }
  if (command === "input-message-dry-run") return inputMessageDryRun(baseDir, valueAfter(args, "--message"));
  if (command === "queue-dry-run") return queueDryRun(baseDir, valueAfter(args, "--ids").split(",").filter(Boolean), valueAfter(args, "--message"));
  if (command === "verify-send-result-dry-run") return verifySendResultDryRun(baseDir);
  if (command === "verify-window-title") return verifyWindowTitle(baseDir);
  if (command === "send" && args.includes("--real")) return { ok: false, action: command, error: "真实发送实验模块未包含", logs: [] };
  if (command === "send") return send(baseDir, { dryRun: true, message: optionalValueAfter(args, "--message"), target: optionalValueAfter(args, "--target") });
  return { ok: false, action: command, error: `Unknown command: ${command}`, logs: [] };
}

function main(argv) {
  const [command = "status", ...args] = argv.slice(2);
  if (!STATEFUL_COMMANDS.has(command)) {
    return { ok: false, action: command, error: `Unknown command: ${command}`, logs: [] };
  }
  const baseDir = optionalValueAfter(args, "--data-dir");
  const dataDirError = absoluteDataDirError(command, baseDir);
  if (dataDirError) return dataDirError;

  if (command === "status") return execute(command, baseDir, args);
  const validated = validateTaskContext(command, baseDir, args);
  if (validated.error) return validated.error;
  if (requiresSelectedContact(command) && !selectedContactMatches(baseDir, validated.context)) {
    return contextError(command, "executor_contact_mismatch", "执行器联系人与任务当前联系人不一致，已阻断草稿操作");
  }
  const result = execute(command, baseDir, args);
  if (!result.ok) return result;
  return saveTaskContext(baseDir, validated.context, result);
}

if (require.main === module) {
  const result = main(process.argv);
  const { baseDir, ...publicResult } = result;
  console.log(JSON.stringify(publicResult));
  process.exit(result.error ? 1 : 0);
}

module.exports = { main, validateTaskContext };
