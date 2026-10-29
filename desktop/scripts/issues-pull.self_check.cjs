const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pull, originFrame, closure } = require("./issues-pull.cjs");
const { show, find, completeness, REPLAYS } = require("./issues-show.cjs");
const { replay } = require("./issues-replay.cjs");

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("x")]);
const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002", C = "cccccccc-0000-4000-8000-000000000003";
const evidenceId = "0123456789abcdef0123456789abcdef";

function detail(id, { code = "auto_mix_music_not_audible", module = "content_engine", installId = "11111111-1111-4111-8111-111111111111", version = "1.2.22", updatedAt = 100, evidence = [], ...fields } = {}) {
  return { capsule: { schema: 1, id, module, code, source: "engine", occurrences: 2, createdAt: "2026-10-29T08:00:00.000Z", lastSeenAt: "2026-10-29T08:05:00.000Z",
    message: "背景音乐在大部分口播中听不到", traceback: 'Traceback (most recent call last):\n  File "~\\AppData\\Local\\Programs\\x\\_internal\\content_engine\\creative_render.py", line 1575, in _measure_auto_mix_window_margins\nContentEngineError',
    details: { quiet: [{ captionId: "c2", startMs: 0, endMs: 1000 }], audible: [{ captionId: "c1", startMs: 1000, endMs: 4000 }], musicOnSpanMs: 4000 },
    breadcrumbs: [{ ts: "2026-10-29T08:00:00.000Z", level: "info", module, event: "render.started" }], ...fields },
  client: { installId, version }, evidence, updatedAt, images: Object.fromEntries(evidence.map(item => [item, PNG.toString("base64")])) };
}

(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "issues-pull-"));
  let known;
  const first = { capsules: [detail(A, { evidence: [evidenceId] }), detail(B, { installId: "22222222-2222-4222-8222-222222222222", version: "1.2.21" }),
    detail(C, { code: "personal_wechat_main_window_not_found", module: "active_touch", traceback: "" })],
  feedback: [{ id: "f1", text: "还是卡在60%", status: "pending", context: { module: "content_engine", capsules: [A] }, receivedAt: 1793250000, client: { version: "1.2.22" } },
    { id: "f2", text: "朋友圈不动", status: "pending", context: { module: "active_touch" }, receivedAt: 1793250000, client: { version: "1.2.21" } }], issues: [], versions: [] };
  const result = await pull({ out, now: new Date("2026-10-29T09:00:00Z"), collect: async ({ known: value }) => { known = value; return first; } });
  assert.deepEqual(known, {}, "the first pull asks for everything");
  assert.deepEqual({ capsules: result.capsules, fresh: result.fresh, groups: result.groups }, { capsules: 3, fresh: 3, groups: 2 });
  const clusters = JSON.parse(fs.readFileSync(path.join(out, "clusters.json"), "utf8"));
  const music = clusters.find(group => group.code === "auto_mix_music_not_audible");
  assert.equal(music.installs, 2, "capsules from different computers form one root-cause group");
  assert.equal(music.occurrences, 4);
  assert.deepEqual(music.versions, ["1.2.21", "1.2.22"]);
  assert.equal(music.inLatest, true, "a failure still seen in the newest version is flagged");
  assert.deepEqual(music.feedback.map(item => item.id), ["f1"], "feedback joins the group through its capsule ids");
  assert.match(music.origins[0][0], /^content_engine\/creative_render\.py:1575 _measure_auto_mix_window_margins$/);
  assert.ok(fs.readFileSync(path.join(out, "capsules", A, `${evidenceId}.png`)).equals(PNG), "screenshots arrive as originals");
  assert.ok(!fs.readFileSync(path.join(out, "capsules", A, "capsule.json"), "utf8").includes("images"), "image data is stored once, as files");
  const text = fs.readFileSync(path.join(out, "report.md"), "utf8");
  assert.match(text, /content_engine · auto_mix_music_not_audible/);
  assert.match(text, /影响 2 台电脑/);
  assert.match(text, /未关联现场包的反馈[\s\S]*朋友圈不动/, "feedback without a capsule is still listed");
  assert.ok(fs.existsSync(path.join(out, "reports", "2026-10-29.md")));

  await pull({ out, collect: async ({ known: value }) => {
    known = value;
    return { ...first, capsules: [{ id: A, unchanged: true, updatedAt: 100 }, { id: B, unchanged: true, updatedAt: 100 }, { id: C, unchanged: true, updatedAt: 100 }] };
  } });
  assert.equal(known[A], 100, "later pulls send what is already here");
  assert.deepEqual(known[`${A}:evidence`], [evidenceId], "screenshots already here are not fetched again");
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "clusters.json"), "utf8")).reduce((sum, group) => sum + group.fresh, 0), 0, "nothing is new the second time");

  const printed = show(find(out, "aaaa"));
  assert.match(printed, /当前规则下会通过/, "a quarter of the speech without music passes today's rule");
  assert.match(printed, /本地源码 desktop\/sidecars\/content-engine\/content_engine\/creative_render\.py/, "the stack is mapped onto local source");
  assert.match(printed, /render\.started/);
  assert.equal(REPLAYS.auto_mix_music_not_audible({ quiet: [{ startMs: 0, endMs: 3000 }], audible: [{ startMs: 3000, endMs: 4000 }], musicOnSpanMs: 4000 }).verdict, "当前规则下仍会失败");
  assert.throws(() => find(out, "ffff"), /issues:pull/);
  assert.deepEqual(originFrame("Error: x\n    at run (C:\\app\\resources\\app\\src\\main\\failure-capsule.cjs:12:5)\n    at node:internal/x:1:1"),
    { file: "src/main/failure-capsule.cjs", line: 12, function: "run" });
  // A WeChat capsule with its flight record: the view lists each step and the
  // verdict names what is missing; the replay reruns the recorded recognition.
  const W = "dddddddd-0000-4000-8000-000000000004";
  const flight = [
    { ts: "2026-10-29T08:00:01.000Z", step: "moments.frame", image: "f1.jpg" },
    { ts: "2026-10-29T08:00:02.000Z", step: "moments.menu_scan", image: "f2.png", lossless: true,
      note: { fn: "Find-MomentsMenuDotsDetailed", viewport: { left: 308, top: 0, width: 804, height: 752 }, avatars: [], menus: [], counts: { components: 0 } } },
    { ts: "2026-10-29T08:00:03.000Z", step: "failure.wx5-r001", image: "f3.jpg",
      note: { reason: "moments_post_not_found", windows: [{ process: "Weixin", title: "朋友圈", width: 974, height: 998, foreground: true }], uia: { type: "Window" } } }];
  const wechat = detail(W, { module: "moments", code: "moments_post_not_found", traceback: "", updatedAt: 200, attachments: ["flight.json", "f1.jpg", "f2.png", "f3.jpg"] });
  wechat.attachments = ["flight.json", "f1.jpg", "f2.png", "f3.jpg"];
  wechat.files = { "flight.json": Buffer.from(JSON.stringify(flight)).toString("base64"), "f1.jpg": "AA==", "f2.png": PNG.toString("base64"), "f3.jpg": "AA==", "../evil.json": "AA==" };
  await pull({ out, collect: async ({ known: value }) => { known = value; return { ...first, capsules: [wechat] }; } });
  assert.ok(fs.existsSync(path.join(out, "capsules", W, "attachments", "f2.png")), "attachments are stored next to the capsule");
  assert.ok(!fs.existsSync(path.join(out, "capsules", "evil.json")), "a hostile attachment name is never written");
  assert.deepEqual(known[`${W}:attachments`], undefined);
  const wechatView = show(find(out, "dddd"));
  assert.match(wechatView, /moments\.menu_scan（可回放） Find-MomentsMenuDotsDetailed → 0 个候选/);
  assert.match(wechatView, /Weixin「朋友圈」974×998（前台），有结构树/);
  assert.match(wechatView, /证据完整/);
  const replays = [];
  const replayed = replay(find(out, "dddd"), { runPowerShell: request => { replays.push(...request); return request.map(() => ({ ok: true, output: { menus: [] } })); } });
  assert.equal(replays[0].inputs.viewport.width, 804, "the replay gets the recorded inputs");
  assert.match(replayed.verdict, /全部与现场一致/);
  assert.match(completeness({ module: "moments" }, flight.slice(0, 1), find(out, "dddd")), /证据不足：缺失败那一刻的整屏截图与窗口列表.*识别中间结果/);
  assert.match(completeness({ module: "content_engine", details: {} }, [], out), /缺引擎测量值.*Python 堆栈/);

  const capsuleOf = (installId, version) => ({ capsule: { module: "moments" }, client: { installId, version } });
  const loop = closure([capsuleOf("one", "1.2.22"), capsuleOf("two", "1.2.22"), capsuleOf("two", "1.2.23"), capsuleOf("three", "1.2.22"), capsuleOf("four", "1.2.22")], [
    { installId: "one", version: "1.2.23", taskKind: "interact" }, { installId: "three", version: "1.2.22", taskKind: "interact" },
    { installId: "four", version: "1.2.23", taskKind: "touch" }]);
  assert.deepEqual(loop, { fixed: 1, recurring: 1, waiting: 2 },
    "fixed only by a later version completing the same kind of task; a success on the failing version or another kind proves nothing");
  assert.equal(closure([{ capsule: { module: "content_engine" }, client: {} }], []), null);

  // A verified fix is kept as a field replay; a later change to that decision is reported.
  const { keep, verify } = require("./issues-verify.cjs");
  keep(find(out, "dddd"), out, { results: [{ step: "s1", now: [] }] });
  assert.ok(fs.existsSync(path.join(out, "fixtures", W, "attachments", "f2.png")), "a fixture keeps the field frame, outside the repository");
  assert.deepEqual(verify(out, { run: () => ({ results: [{ step: "s1", now: [] }] }) }).failed, []);
  assert.deepEqual(verify(out, { run: () => ({ results: [{ step: "s1", now: [[947, 300]] }] }) }).failed.map(row => row.changed), [["s1"]]);

  // The collector runs remotely with the server's python3; it must at least compile.
  const python = process.env.XIAOXI_SELF_CHECK_PYTHON || "python";
  try { execFileSync(python, ["-c", `compile(${JSON.stringify(require("./issues-pull.cjs").COLLECTOR)}, "collector", "exec")`], { stdio: "pipe" }); }
  catch (error) { if (error.code !== "ENOENT" && !/not found|Microsoft Store/i.test(String(error.stderr || ""))) throw error; }
  console.log("issues pull: clustering across computers, feedback join, incremental pull, screenshots, report, capsule view and decision replay passed");
})().catch(error => { console.error(error); process.exit(1); });
