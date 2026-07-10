const { clickWechatSendButton, verifyWechatMessageBubble } = require("./wechat_window_driver.cjs");
const { appendLog, block, blockMessageBubble, blockSendGate, loadState, output, saveState } = require("./state_machine.cjs");

function setRealSendArm(baseDir = __dirname, enabled = false) {
  const state = loadState(baseDir);
  if (!enabled) {
    const nextState = { ...state, real_send_armed: false, real_send_enabled: false, real_send_status: "not_sent", real_send_reason: "", last_result: "real_send_disarmed", blocked_reason: "" };
    saveState(baseDir, nextState);
    return output(true, "set-real-send-arm", nextState, { baseDir });
  }
  if (state.send_gate_status !== "dry_run_passed") {
    return block(baseDir, "真发开关 dry-run", { ...state, real_send_armed: false, real_send_enabled: false, real_send_status: "blocked", real_send_reason: "send_gate_not_passed" }, "send_gate_not_passed", "已阻断：发送门禁 dry-run 未通过");
  }
  const nextState = { ...state, real_send_armed: true, real_send_enabled: false, real_send_clicked: false, real_send_status: "armed", real_send_reason: "", last_result: "real_send_armed_dry_run", blocked_reason: "" };
  saveState(baseDir, nextState);
  return output(true, "set-real-send-arm", nextState, { baseDir });
}

function sendReal(baseDir = __dirname, options = {}, sendDriver = clickWechatSendButton) {
  const state = loadState(baseDir);
  const message = String(options.message ?? state.message_draft ?? "").trim();
  if (!state.real_send_armed) return blockSendGate(baseDir, state, "real_send_not_armed", "已阻断：单人真发开关未武装");
  if (options.allowRealSend !== true) return blockSendGate(baseDir, state, "real_send_explicit_allow_missing", "已阻断：缺少显式真发允许参数");
  if (!state.calibrated || !state.target_selected || !state.conversation_verified || !state.message_input_done || !message || String(state.message_draft ?? "").trim() !== message) {
    return blockSendGate(baseDir, state, "real_send_gate_failed", "已阻断：真实发送前置检查未通过");
  }
  const sendResult = sendDriver(options.sendKey ?? "{ENTER}");
  if (!sendResult.ok) return blockSendGate(baseDir, state, "real_send_failed", "已阻断：发送按键执行失败");
  const nextState = { ...state, dry_run: false, real_send_armed: false, real_send_enabled: false, real_send_clicked: true, real_send_status: "clicked", real_send_reason: "", post_send_verified: false, post_send_status: "pending", post_send_reason: "", message_bubble_verified: false, message_bubble_status: "pending", message_bubble_reason: "", located_window_title: sendResult.title ?? state.located_window_title, last_result: "real_send_clicked", blocked_reason: "" };
  saveState(baseDir, nextState);
  appendLog(baseDir, "真实发送", "已点击发送键，等待消息气泡验证");
  return output(true, "send", nextState, { baseDir });
}

function failConversation(baseDir = __dirname) {
  const state = { ...loadState(baseDir), conversation_verified: false, send_gate_status: "blocked", send_gate_reason: "conversation_mismatch", real_send_armed: false, real_send_enabled: false, real_send_clicked: false, real_send_status: "blocked", real_send_reason: "conversation_mismatch", post_send_verified: false, post_send_status: "blocked", post_send_reason: "conversation_mismatch", message_bubble_verified: false, message_bubble_status: "blocked", message_bubble_reason: "conversation_mismatch", last_result: "blocked", blocked_reason: "conversation_mismatch" };
  saveState(baseDir, state);
  return output(false, "fail-conversation", state, { baseDir, blocked_reason: "conversation_mismatch" });
}

function verifyMessageBubble(baseDir = __dirname, verifier = verifyWechatMessageBubble) {
  const state = loadState(baseDir);
  const message = String(state.message_draft ?? "").trim();
  if (!state.real_send_clicked) return blockMessageBubble(baseDir, state, "real_send_not_clicked", "已阻断：尚未执行真实发送点击");
  if (!message) return blockMessageBubble(baseDir, state, "empty_message", "已阻断：待验证消息为空");
  const verifyResult = verifier(message);
  if (!verifyResult.ok) return blockMessageBubble(baseDir, state, "message_bubble_not_found", "已阻断：未在当前会话读取到消息气泡");
  const nextState = { ...state, message_bubble_verified: true, message_bubble_status: "verified", message_bubble_reason: "", post_send_verified: true, post_send_status: "bubble_verified", post_send_reason: "", located_window_title: verifyResult.title ?? state.located_window_title, last_result: "message_bubble_verified", blocked_reason: "" };
  saveState(baseDir, nextState);
  return output(true, "verify-message-bubble", nextState, { baseDir });
}

module.exports = { failConversation, sendReal, setRealSendArm, verifyMessageBubble };
