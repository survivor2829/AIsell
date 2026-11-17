"use strict";
// Undelivered-notice verdicts after a verified send (wechat_delivery_notice.cjs).
const assert = require("node:assert/strict");
const { detectWechatDeliveryNoticeAsync, WECHAT_DELIVERY_NOTICE_SCRIPT, mentionsNotice } = require("./wechat_delivery_notice.cjs");

async function main() {
  const window = { pid: 4242, hWnd: "9191", message: "您好，打扰一下" };
  const calls = [];
  const answer = (value) => async (script, env, options) => { calls.push({ env, options }); return value; };

  // 2026-11-17 (user decision): 被对方拒收 is a block, 朋友验证 a deletion; counted apart.
  assert.deepEqual(await detectWechatDeliveryNoticeAsync(window, answer({ ok: true, undelivered: true, kind: "blocked" })), { ok: true, undelivered: true, kind: "blocked" });
  assert.deepEqual(await detectWechatDeliveryNoticeAsync(window, answer({ ok: true, undelivered: true, kind: "deleted" })), { ok: true, undelivered: true, kind: "deleted" });
  assert.deepEqual(await detectWechatDeliveryNoticeAsync(window, answer({ ok: true, undelivered: true, kind: "other" })), { ok: true, undelivered: true },
    "an unknown kind stays the generic not-a-friend result");
  assert.deepEqual(await detectWechatDeliveryNoticeAsync(window, answer({ ok: true, undelivered: false, kind: "blocked" })), { ok: true, undelivered: false },
    "no kind without a notice");
  assert.equal(calls.at(-1).options.hosted, true, "the read-only notice check runs in the long-lived host");
  assert.equal(calls.at(-1).env.XIAOXI_EXPECTED_HWND, "9191");

  // Our own message mentioning such words proves nothing and is not read.
  const before = calls.length;
  assert.deepEqual(await detectWechatDeliveryNoticeAsync({ ...window, message: "如果被对方拒收请联系我们" }, answer({ ok: true, undelivered: true, kind: "blocked" })),
    { ok: false, reason: "delivery_notice_message_ambiguous" });
  assert.equal(calls.length, before);
  assert.equal(mentionsNotice("你还不是他朋友"), true);

  // The script decides the kind from the lowest text only, with both patterns.
  // Keys Windows OCR read right on a real screen even when it dropped or misread other characters.
  assert.match(WECHAT_DELIVERY_NOTICE_SCRIPT, /\$blocked = \[Text\.RegularExpressions\.Regex\]::IsMatch\(\$text, '拒收'\)/u);
  assert.match(WECHAT_DELIVERY_NOTICE_SCRIPT, /\$deleted = \[Text\.RegularExpressions\.Regex\]::IsMatch\(\$text, '朋友验证\|还不是\[他她\]'\)/u);
  for (const reading of ["消息已发出，但被对方拒收了。", "消息已发出，但对方拒收了。", "消息已发出，但钅芯了方拒收了。", "己发±，但对方拒收了。"]) {
    assert.equal(/拒收/u.test(reading), true, `a block read as ${reading} is still a block`);
  }
  assert.equal(mentionsNotice("请勿拒收"), true, "our own message with the key word is never read as a notice");
  assert.match(WECHAT_DELIVERY_NOTICE_SCRIPT, /kind = \$kind/u);
  console.log("delivery notice self-check passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
