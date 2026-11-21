const assert = require("node:assert/strict");
const vision = require("./wechat-vision-check.cjs");

// Cases from the 2026-11-21 replay of 30 field dropdowns (names made up): the model reads, the code
// decides; every misreading it made had to end in "not clicked", never in a wrong click.
const row = (name, more = {}) => ({ name, wechat_id: "", group: "联系人", avatar: true, in_panel: true, x: 300, y: 250, unsure: false, ...more });
const pick = (rows, identity) => vision.pickSearchRow({ rows }, identity);
const byName = { query: "测试联系人甲", queryType: "name", expectedName: "测试联系人甲" };

assert.equal(pick([row("测试联系人甲")], byName).ok, true, "the one exact contact row is clicked");
assert.deepEqual([pick([row("测试联系人甲", { x: 250, y: 400 })], byName).x, pick([row("测试联系人甲", { x: 250, y: 400 })], byName).y], [0.25, 0.4]);
assert.equal(pick([row("测试联系人甲", { group: "最常使用" })], byName).ok, true, "最常使用 is a contact group (cfe8221b case)");
assert.equal(pick([row("测试联系人甲 ")], byName).ok, true, "spaces are not part of the comparison");
// Search suggestions under 搜索网络结果 (magnifier, no avatar) were read as 联系人 before the prompt named them.
assert.equal(pick([row("测试联系人甲", { group: "联系人", avatar: false })], byName).reason, "vision_not_local");
assert.equal(pick([row("测试联系人甲", { group: "搜索网络结果", avatar: false })], byName).reason, "vision_not_local");
// The chat list behind the panel is not a search result.
assert.equal(pick([row("测试联系人甲", { in_panel: false })], byName).reason, "vision_not_local");
// One character read differently (雪 → 霄) is simply not the person: skipped, not clicked.
assert.equal(pick([row("测试联系人乙")], byName).reason, "vision_not_found");
assert.equal(pick([row("测试联系人甲", { unsure: true })], byName).reason, "vision_not_local");
// Two same-named rows, or a contact and a group with the same name: never guess.
assert.equal(pick([row("测试联系人甲"), row("测试联系人甲", { y: 500 })], byName).reason, "vision_ambiguous");
assert.equal(pick([row("测试联系人甲"), row("测试联系人甲", { group: "群聊", y: 500 })], byName).reason, "vision_ambiguous");
assert.equal(pick([row("测试联系人甲", { x: 0, y: 0 })], byName).reason, "vision_position_invalid");
// Dev machine 2026-11-21: the person shown under 最常使用, a group whose member matched, the person's own
// 聊天记录 entry and the 搜索网络结果 echo — one person, so the 最常使用 row is clicked.
assert.equal(pick([row("测试联系人甲", { group: "最常使用", y: 120 }), row("某某培训群", { group: "群聊", y: 330 }),
  row("测试联系人甲", { group: "聊天记录", y: 560 }), row("测试联系人甲", { group: "搜索网络结果", avatar: false, y: 900 })], byName).ok, true);

// 微信号 search: the 微信号 decides, the name beside it may be misread by one character.
const byId = { query: "test_id_357", queryType: "wechat_id", expectedName: "测试联系人丙" };
assert.equal(pick([row("测试联系人丁", { wechat_id: "test_id_357" })], byId).ok, true);
// A 微信号 read one digit short, next to the real one: two rows with the searched 微信号 → skipped.
assert.equal(pick([row("甲", { wechat_id: "test_id_357" }), row("乙", { wechat_id: "test_id_357", y: 500 })], byId).reason, "vision_ambiguous");
assert.equal(pick([row("测试联系人丙", { wechat_id: "" })], byId).reason, "vision_not_found", "a 昵称 line is not a 微信号");
assert.equal(pick([row("x", { wechat_id: "Test_ID_357" })], byId).ok, false, "case counts in a 微信号");

// The title reader: only a sure, exact title, with the search cleared and no dropdown open, confirms
// the chat; where the model saw it becomes the part of the picture that must stay the same.
const seen = (more = {}) => ({ title: "测试联系人甲", title_box: [420, 300, 560, 480], search_box: "", dropdown_open: false, unsure: false, ...more });
assert.deepEqual(vision.pickTitle(seen(), "测试联系人甲"), { ok: true, read: true, box: { left: 0.42, top: 0.3, right: 0.56, bottom: 0.48 } });
assert.equal(vision.pickTitle(seen({ title: "测试联系人 甲" }), "测试联系人甲").ok, true, "spaces are not part of the comparison");
assert.equal(vision.pickTitle(seen({ title: "测试联系人乙" }), "测试联系人甲").reason, "vision_title_mismatch");
assert.equal(vision.pickTitle(seen({ title: "测试联系人甲(3)" }), "测试联系人甲").reason, "vision_title_mismatch", "a group of the same name is another chat");
assert.equal(vision.pickTitle(seen({ unsure: true }), "测试联系人甲").reason, "vision_title_unsure");
assert.equal(vision.pickTitle(seen({ title: "" }), "测试联系人甲").reason, "vision_title_empty");
// a060ad68: the query still in the box with the dropdown open while another chat stayed behind it.
assert.equal(vision.pickTitle(seen({ search_box: "测试联系人甲" }), "测试联系人甲").reason, "vision_search_still_open");
assert.equal(vision.pickTitle(seen({ dropdown_open: true }), "测试联系人甲").reason, "vision_search_still_open");
assert.equal(vision.pickTitle(seen({ search_box: "搜索" }), "测试联系人甲").ok, true, "the grey hint is an empty box");
for (const title_box of [[0, 0, 0, 0], [560, 300, 420, 480], [420, 300, 1200, 480], [420, 300, 560], null]) {
  assert.equal(vision.pickTitle(seen({ title_box }), "测试联系人甲").reason, "vision_position_invalid", JSON.stringify(title_box));
}
assert.equal(vision.pickTitle(seen({ title: "" }), "").ok, false);
const titlePrompt = vision.titleMessages({ image: "data:x" })[0].content;
assert.match(titlePrompt, /会话列表里的名字、搜索框里的字/u); assert.match(titlePrompt, /title_box/u); assert.match(titlePrompt, /dropdown_open/u);

// 微信之眼: each question goes out as the picture file our step took, and is logged without names.
(async () => {
  const events = [];
  const eyes = vision.createWechatEyes({ logger: { event: (...args) => events.push(args) }, readFile: () => Buffer.from("png"),
    vision: { ready: () => true,
      findSearchRow: async (input) => ({ ok: input.image === "data:image/png;base64,cG5n", x: 0.5, y: 0.5, rows: 3, usage: { prompt_tokens: 900 } }),
      confirmTitle: async () => { throw Object.assign(Error("x"), { code: "vision_http_502" }); } } });
  assert.equal((await eyes.searchRow({ file: "a.png", query: "q", queryType: "name", expectedName: "q" })).ok, true);
  assert.deepEqual(await eyes.chatTitle({ file: "b.png", expectedName: "q" }), { ok: false, reason: "vision_http_502" });
  assert.deepEqual(events.map(([, event, detail, meta]) => [event, detail.outcome, meta.code, detail.input_tokens]),
    [["vision_rescue", "vision_row_found", "vision_row_found", 900], ["vision_title", "vision_http_502", "vision_http_502", 0]]);
  assert.equal(JSON.stringify(events).includes("q\""), false, "no names in the log");

// Answers: fenced JSON is read; anything else is an invalid answer, never a guess.
assert.deepEqual(vision.jsonOf("```json\n{\"rows\":[]}\n```"), { rows: [] });
assert.throws(() => vision.jsonOf("我看不清"), (e) => e.code === "vision_answer_invalid");
const prompt = vision.searchMessages({ image: "data:x", query: "q" })[0].content;
assert.match(prompt, /放大镜图标、没有头像/u); assert.match(prompt, /面板外面.*不是搜索结果/u); assert.match(prompt, /「昵称」/u);

  console.log("wechat vision check self-check passed: exact, unique, in-panel contact rows only; exact sure titles with the search closed; misreadings skip, never click");
})().catch((error) => { console.error(error); process.exitCode = 1; });
