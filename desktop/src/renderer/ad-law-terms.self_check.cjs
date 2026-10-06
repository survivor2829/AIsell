const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// Load the real TypeScript modules the way the page imports them.
for (const extension of [".ts", ".tsx"]) {
  require.extensions[extension] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, strict: true },
      fileName: filename
    }).outputText;
    module._compile(output, filename);
  };
}
require.extensions[".css"] = () => undefined;
const { ABSOLUTE_TERMS, PROMISE_TERMS, adLawSentences } = require("./ad-law-terms.ts");
const { AdLawHint, BatchTopicChoices } = require("./BatchCreativeBrief.tsx");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const page = read("BatchCreativePage.tsx");

// The word list covers product-detail's _EXTREME_WORD_MAP and the CE3 additions.
const productDetail = fs.readFileSync(path.join(__dirname, "../../sidecars/product-detail/app/app.py"), "utf8");
const mapSource = /_EXTREME_WORD_MAP = \{([\s\S]*?)\n\}/u.exec(productDetail)?.[1];
assert.ok(mapSource, "product-detail must still define _EXTREME_WORD_MAP");
const extremeKeys = [...mapSource.matchAll(/"([^"]+)":/gu)].map((match) => match[1]);
assert.ok(extremeKeys.length >= 20);
for (const term of [...extremeKeys, "最佳", "最先进", "全网第一", "首个", "首选", "国家级", "世界级", "史上", "绝对", "100%", "万能", "永久", "根治"]) {
  assert.ok(ABSOLUTE_TERMS.includes(term), `absolute wording must include ${term}`);
}
assert.deepEqual([...PROMISE_TERMS], ["包过", "包会", "保证", "确保"], "promises are listed apart");

// Hits name the term and the sentence it is in; the text itself is never changed.
const copy = "我们是全网第一的培训营。\n学不会每月免费复训，包会为止！已办4期，真机20-25款。保证100%满意";
const before = copy;
const found = adLawSentences(copy);
assert.equal(copy, before, "the copy is read, not rewritten");
assert.deepEqual(found.map((item) => item.sentence), ["我们是全网第一的培训营。", "学不会每月免费复训，包会为止！", "保证100%满意"]);
assert.deepEqual(found[0].terms, [{ term: "全网第一", kind: "absolute" }], "the longer term covers 第一 inside it");
assert.deepEqual(found[1].terms, [{ term: "包会", kind: "promise" }]);
assert.deepEqual(found[2].terms, [{ term: "保证", kind: "promise" }, { term: "100%", kind: "absolute" }]);
for (const item of found) assert.equal(copy.slice(item.start, item.start + item.sentence.length), item.sentence, "start locates the sentence in the copy");
assert.deepEqual(adLawSentences("已办4期，真机20-25款，学不会每月免费复训。"), [], "ordinary business claims are not flagged");
assert.deepEqual(adLawSentences(""), []);
assert.equal(adLawSentences("第一步先看设备，第一次来也不用担心。")[0].terms.length, 1, "a term is listed once per sentence");

// The hint renders the words and sentences only; it adds no control that could block.
assert.equal(renderToStaticMarkup(React.createElement(AdLawHint, { text: "已办4期。" })), "");
const hint = renderToStaticMarkup(React.createElement(AdLawHint, { text: copy }));
assert.match(hint, /广告法提示/u);
assert.match(hint, /全网第一/u);
assert.match(hint, /包会（承诺用语）/u);
assert.match(hint, /学不会每月免费复训，包会为止！/u);
assert.doesNotMatch(hint, /<button|disabled/u, "a hint never blocks or disables anything");
const chosen = { candidate_id: "narrated_candidate_a", title: "学员招募", narration: copy, angle: "", status: "needs_review", shots: [], revision: 1 };
const review = renderToStaticMarkup(React.createElement(BatchTopicChoices, { options: [chosen], selected: chosen.candidate_id, locked: false, onSelect() {}, onEdit() {}, mode: "review" }));
assert.match(review, /我们是全网第一的培训营。/u, "the confirmed copy is shown as written");
assert.match(review, /batch-ad-law-hint/u, "the confirm view lists the hits");
assert.doesNotMatch(review, /<button[^>]*disabled/u, "the edit button stays available");

// Page wiring: hints at confirmation and on finished works, never on the confirm button.
assert.equal((page.match(/<AdLawHint text=\{(?:option|c)\.narration\} \/>/gu) || []).length, 2, "legacy choices and finished works show hints");
assert.match(page, /data-batch-action="confirm" disabled=\{locked \|\| saving \|\| dirty \|\| !countsValid \|\| !settings\.voice_persona_id\}/u,
  "the hint does not take part in enabling 确认文案");
assert.doesNotMatch(page, /adLawSentences/u, "the page only renders the hint");
// The strict switch: same persistence as video_template, locked once the copy is confirmed.
assert.match(page, /<input type="checkbox" checked=\{settings\.strict_visual_review === true\} disabled=\{locked \|\| !!batch\?\.script_confirmation\} onChange=\{\(event\) => changeSoundSettings\(\{ \.\.\.settings, strict_visual_review: event\.target\.checked \}\)\} \/>/u);
assert.match(page, /严格核对画面事实/u);
assert.match(page, /默认关闭：按你确认的文案直接配音剪辑。/u);
for (const handler of ["async function start(", "async function confirmScript("]) {
  const body = page.slice(page.indexOf(handler), page.indexOf("} finally { setSubmitting(false); }", page.indexOf(handler)));
  assert.match(body, /localStorage\.setItem\("batch-studio-settings", JSON\.stringify\(settings\)\)/u,
    `the switch is remembered with the other settings in ${handler}`);
}
assert.match(page, /JSON\.parse\(localStorage\.getItem\("batch-studio-settings"\) \|\| "\{\}"\)/u);
assert.match(page, /callBatch<Batch>\("confirm", \{ batch_id: batch\.batch_id, settings,/u, "confirmation sends the switch");
assert.match(page, /c\.review_mode === "follow_script" && <p className="batch-hint">按文案生成，未做画面事实核对<\/p>/u);
// Round 4: the switch is per batch (not inherited into a new batch, where it would silently govern the
// paid draft review), the draft and the confirmation both carry the settings, saved settings still seed
// the page, and follow-script shots without a frame description are named by material.
assert.match(page, /delete saved\.strict_visual_review;\s*return \{ minimum_duration_seconds: 30, music_mode: "auto", music_track_ids: \[\], \.\.\.saved, voice_persona_id/u,
  "a new batch starts with the strict switch off; the other saved settings still seed the page");
assert.match(page, /material_context: materialContext, cta, target_count: target, settings,/u, "the draft sends the settings");
assert.match(page, /\{s\.description \|\| materialLabel\(batch, s\.asset_id\)\}/u, "shots without a description are named by material");
assert.match(page, /function materialLabel\(batch: Batch \| null \| undefined, assetId: string\)/u);
assert.match(page, /settings\.strict_visual_review \? "继续会重新安排未完成作品的镜头并复核画面；已完成作品会保留。" : "继续会按文案顺序重新安排未完成作品的镜头；已完成作品会保留。"/u,
  "the 继续 hint tells the user which mode will run");

console.log("ad-law hint and strict review switch self-check passed");
