const assert = require("node:assert/strict");
const { createWechatAutoReplyDriver } = require("./wechat_auto_reply_driver.cjs");

const calls = [];
const driver = createWechatAutoReplyDriver((script, env, options) => {
  calls.push({ script, env, options });
  return { ok: true, conversation: "张总", message: "你好", runtimeId: "message-1" };
});

assert.deepEqual(driver.scanWechatIncoming([" 张总 ", "李经理", "张总"]).conversation, "张总");
assert.deepEqual(JSON.parse(calls[0].env.XIAOXI_ALLOWED_NAMES), ["张总", "李经理"]);
assert.equal(calls[0].env.XIAOXI_AUTO_REPLY_MODE, "scan");
assert.equal(calls[0].options.ensure, false);
assert.equal(calls[0].script.includes("session_item_$name"), true, "current WeChat session items must match by exact automation id");
assert.equal(calls[0].script.includes("\\[[1-9][0-9]*条\\]"), true, "current WeChat unread count must be recognized from the session item name");
assert.equal(calls[0].script.includes("selection.Select(); Start-Sleep -Milliseconds 400; return $true"), false, "selection hints must not bypass the click fallback");
assert.equal(calls[0].script.includes("chat_message_list.qt_scrollarea_viewport.chat_bubble_item_view"), true, "current WeChat message bubbles must be accepted by exact automation id");
assert.equal(calls[0].script.includes("function Get-SessionPreview"), true, "the unread session preview must prove which bubble is incoming");
assert.equal(calls[0].script.includes("unread_preview_mismatch"), true, "preview and latest bubble mismatch must fail closed");
assert.equal(calls[0].script.includes("$bubbleCandidates.Count -gt 0"), true, "exact message bubbles must take priority over legacy text nodes");

assert.equal(driver.verifyWechatIncoming({ conversation: "张总", message: "你好", runtimeId: "42.81.7", pid: 81, hWnd: 91 }).ok, true);
assert.equal(calls[1].env.XIAOXI_AUTO_REPLY_MODE, "verify");
assert.equal(calls[1].env.XIAOXI_EXPECTED_CONVERSATION, "张总");
assert.equal(calls[1].env.XIAOXI_EXPECTED_MESSAGE, "你好");
assert.equal(calls[1].env.XIAOXI_EXPECTED_RUNTIME_ID, "42.81.7");
assert.equal(calls[1].env.XIAOXI_EXPECTED_PID, "81");
assert.equal(calls[1].env.XIAOXI_EXPECTED_HWND, "91");
assert.equal(driver.verifyWechatIncoming({ conversation: "", message: "" }).reason, "incoming_message_missing");
assert.equal(driver.verifyWechatIncoming({ conversation: "张总", message: "你好" }).reason, "incoming_identity_missing");

console.log("wechat auto-reply driver self-check passed");
