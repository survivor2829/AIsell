const assert = require("node:assert/strict");
const { WECHAT_CHAT_EDGE_POWERSHELL } = require("./wechat_chat_edge.cjs");
const driver = require("./wechat_window_driver.dev.cjs");
const fs = require("node:fs");
const path = require("node:path");

// The chat-header fingerprint stops where WeChat's chat ends when its 搜一搜 side panel is open
// (8a275cd0, c19d34bf: the band reached into the changing panel → atomic_conversation_changed).
assert.match(WECHAT_CHAT_EDGE_POWERSHELL, /GetAncestor\(hit, 2\) != main\) return x;/u, "a window that is not part of WeChat's main window leaves the band as it was");
assert.match(WECHAT_CHAT_EDGE_POWERSHELL, /if \(pid == wechatPid\) return cx == x \? x : cx - 2;/u, "inside WeChat's own surface the band ends");
const source = fs.readFileSync(path.join(__dirname, "wechat_window_driver.dev.cjs"), "utf8");
assert.equal((source.match(/\$captureRight = \[XiaoxiChatEdge\]::Right\(/gu) || []).length, 4, "both header fingerprints (send observation and conversation observation) use it, in the fixed band and at an AI-read title");
assert.equal(/\$captureRight = \[int\]\([^)]*Width \* 0\.78\)\)/u.test(source), false, "no fixed 78% band is left");
assert.ok(driver.WECHAT_SEND_OBSERVATION_SCRIPT.includes("XiaoxiChatEdge"), "the picture send and the text send get it through the shared observation");
console.log("wechat chat edge self-check passed: the header fingerprint stops at WeChat's own chat");
