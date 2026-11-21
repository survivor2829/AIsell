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

// The title reader: only a sure, exact title confirms the chat.
assert.equal(vision.titleMatches({ title: "测试联系人甲", unsure: false }, "测试联系人甲").ok, true);
assert.equal(vision.titleMatches({ title: "测试联系人乙", unsure: false }, "测试联系人甲").ok, false);
assert.equal(vision.titleMatches({ title: "测试联系人甲", unsure: true }, "测试联系人甲").ok, false);
assert.equal(vision.titleMatches({ title: "", unsure: false }, "").ok, false);

// Answers: fenced JSON is read; anything else is an invalid answer, never a guess.
assert.deepEqual(vision.jsonOf("```json\n{\"rows\":[]}\n```"), { rows: [] });
assert.throws(() => vision.jsonOf("我看不清"), (e) => e.code === "vision_answer_invalid");
const prompt = vision.searchMessages({ image: "data:x", query: "q" })[0].content;
assert.match(prompt, /放大镜图标、没有头像/u); assert.match(prompt, /面板外面.*不是搜索结果/u); assert.match(prompt, /「昵称」/u);

console.log("wechat vision check self-check passed: exact, unique, in-panel contact rows only; misreadings skip, never click");
