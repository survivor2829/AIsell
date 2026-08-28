#!/usr/bin/env node

const safe = require("./state_machine.cjs");
const development = require("./state_machine.dev.cjs");
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
  "send",
  "set-real-send-arm",
  "verify-real-send-session",
  "fail-conversation",
  "verify-message-bubble"
]);

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 || index === args.length - 1 ? "" : args[index + 1];
}

function optionalValueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 || index === args.length - 1 ? undefined : args[index + 1];
}

function main(argv) {
  const [command = "status", ...args] = argv.slice(2);
  const baseDir = optionalValueAfter(args, "--data-dir");
  const dataDirError = STATEFUL_COMMANDS.has(command) ? absoluteDataDirError(command, baseDir) : null;
  if (dataDirError) return dataDirError;
  const contactsDir = optionalValueAfter(args, "--contacts-dir") || baseDir;
  if (command === "set-real-send-arm") return development.setRealSendArm(baseDir, args.includes("--on"), contactsDir);
  if (command === "verify-real-send-session") return development.verifyRealSendSession(baseDir);
  if (command === "fail-conversation") return development.failConversation(baseDir);
  if (command === "verify-message-bubble") return development.verifyMessageBubble(baseDir);
  const handlers = {
    status: () => safe.status(baseDir), calibrate: () => safe.calibrate(baseDir), "focus-wechat-window": () => safe.focusWechatWindowDryRun(baseDir), "clear-customer": () => safe.clearCustomer(baseDir), "select-customer": () => safe.selectCustomer(baseDir, valueAfter(args, "--id"), contactsDir), "verify-conversation": () => safe.verifyConversation(baseDir, valueAfter(args, "--title")), "locate-conversation": () => safe.locateConversation(baseDir), "open-conversation-dry-run": () => safe.openConversationDryRun(baseDir), "search-conversation-dry-run": () => safe.searchConversationDryRun(baseDir), "click-search-result-dry-run": () => safe.clickSearchResultDryRun(baseDir, undefined, undefined, undefined, { pid: optionalValueAfter(args, "--expected-pid"), hWnd: optionalValueAfter(args, "--expected-hwnd"), minIdleMs: optionalValueAfter(args, "--min-idle-ms") }), "input-message-dry-run": () => safe.inputMessageDryRun(baseDir, valueAfter(args, "--message")), "queue-dry-run": () => safe.queueDryRun(baseDir, valueAfter(args, "--ids").split(",").filter(Boolean), valueAfter(args, "--message")), "verify-send-result-dry-run": () => safe.verifySendResultDryRun(baseDir), "verify-window-title": () => safe.verifyWindowTitle(baseDir), send: () => safe.send(baseDir, { dryRun: true, message: args.includes("--message") ? valueAfter(args, "--message") : undefined })
  };
  return handlers[command] ? handlers[command]() : { ok: false, action: command, error: `Unknown command: ${command}`, logs: [] };
}

if (require.main === module) {
  const result = main(process.argv);
  const { baseDir, ...publicResult } = result;
  console.log(JSON.stringify(publicResult));
  process.exit(result.error ? 1 : 0);
}

module.exports = { main };
