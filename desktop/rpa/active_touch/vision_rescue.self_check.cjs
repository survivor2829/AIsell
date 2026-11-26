const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { visionResolution, searchCaptureSha256 } = require("./wechat_window_driver.cjs");
const { parseVisionPoint, saveState } = require("./state_machine.cjs");
const { visionRescueSearch } = require("./state_machine.dev.cjs");

// AI 看图兜底 (2026-11-21): the model's row is clicked only when the dropdown just taken matches the
// picture it read, pixel for pixel, from the panel's top down past that row (the edges may differ).
const zlib = require("node:zlib");
const encode = (width, height, paint) => {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const [r, g, b] = paint(x, y); raw.set([r, g, b, 255], y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
const panel = (edge = 0, rowShade = 200) => encode(50, 100, (x, y) => x < 3 || x > 46 ? [edge, edge, edge] : y >= 10 && y < 20 ? [rowShade, 0, 0] : [250, 250, 250]);
const png = panel();
const { decodePng } = require("./png_pixels.cjs");
assert.equal(decodePng(png).pixels[(15 * 50 + 10) * 4], 200, "the test picture decodes");
const sha = crypto.createHash("sha256").update(png).digest("hex");
const reference = `xiaoxi-search-capture-${crypto.randomBytes(16).toString("hex")}.png`;
fs.writeFileSync(path.join(os.tmpdir(), reference), png);
const observed = (bytes = png, more = {}) => ({ searchCapturePng: bytes.toString("base64"),
  searchResultObservation: { captureSource: "popup", popupBounds: { left: 110, top: 126, right: 846, bottom: 1126 }, ...more } });
const at = { x: 0.25, y: 0.15, capture: sha, reference };
assert.deepEqual(visionResolution(observed(), at).candidate, { x: 294, y: 276 }, "relative point → screen point in the popup");
assert.equal(visionResolution(observed(), at).mode, "vision_row");
assert.equal(visionResolution(observed(panel(90)), at).mode, "vision_row", "the window behind the panel's edges may change");
assert.equal(visionResolution(observed(panel(0, 120)), at), null, "a row above or at the point that changed is never clicked");
assert.equal(visionResolution(observed(encode(50, 90, () => [250, 250, 250])), at), null, "another size is another dropdown");
assert.equal(visionResolution(observed(), { ...at, capture: "0".repeat(64) }), null, "the reference must be the picture the model read");
assert.equal(visionResolution(observed(), { ...at, reference: "other.png" }), null);
assert.equal(visionResolution(observed(png, { captureSource: "formula_crop" }), at), null, "only a real popup capture");
assert.equal(visionResolution(observed(), { ...at, x: 0 }), null);
assert.equal(visionResolution(observed(), null), null);
assert.deepEqual(parseVisionPoint(`0.2500,0.1500,${sha},${reference}`), { x: 0.25, y: 0.15, capture: sha, reference });
for (const bad of [`1.2,0.1,${sha},${reference}`, `0.25,0.1,${sha}`, `0.25,0.1,${sha},../x.png`, "0.25,0.1"]) assert.equal(parseVisionPoint(bad), undefined, bad);
fs.unlinkSync(path.join(os.tmpdir(), reference));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-rescue-"));
  try {
    saveState(root, { selected_customer: { name: "测试联系人甲", id: "1" }, search_query: "测试联系人甲", search_query_type: "name_fallback" });
    const capture = path.join(os.tmpdir(), `xiaoxi-search-capture-${crypto.randomBytes(16).toString("hex")}.png`);
    const failed = () => { fs.writeFileSync(capture, png); return { ok: false, blocked_reason: "exact_search_result_not_found", diagnostics: { capture_source: "popup", search_capture_file: capture } }; };
    assert.equal(searchCaptureSha256(failed().diagnostics.search_capture_file), sha);
    const steps = [];
    const runStep = async (command, args) => { steps.push([command, ...args]); return { ok: true, state: {} }; };
    const base = { isExecutionAllowed: () => true, runStep };
    const args = ["--expected-pid", "1", "--expected-hwnd", "2", "--min-idle-ms", "0"];

    // Found: the search runs once more with the point and the picture's fingerprint; the old capture goes.
    let asked;
    const stages = [];
    const rescued = await visionRescueSearch({ ...base, onDiagnostic: (detail) => stages.push(`${detail.stage}:${detail.phase}`),
      visionRescue: async (input) => { asked = input; return { ok: true, x: 0.25, y: 0.1 }; } }, root, failed(), args);
    assert.equal(rescued.ok, true); assert.equal(rescued.vision_rescued, true);
    // The AI look is its own stage, so 小玺 can say the AI is looking (user 2026-11-26).
    assert.deepEqual(stages, ["vision_search:start", "vision_search:finish"]);
    assert.deepEqual(asked, { file: capture, query: "测试联系人甲", queryType: "name", expectedName: "测试联系人甲" });
    assert.deepEqual(steps.at(-1), ["click-search-result-dry-run", ...args, "--vision-point", `0.2500,0.1000,${sha},${path.basename(capture)}`]);
    assert.equal(fs.existsSync(capture), false);

    // Not found, a model error, or a second run that fails: the first failure stands, with its evidence.
    for (const visionRescue of [async () => ({ ok: false, reason: "vision_not_found" }), async () => { throw Object.assign(Error("x"), { code: "vision_http_502" }); }]) {
      const before = steps.length;
      const kept = await visionRescueSearch({ ...base, visionRescue }, root, failed(), args);
      assert.equal(kept.ok, false); assert.equal(kept.blocked_reason, "exact_search_result_not_found");
      assert.match(kept.diagnostics.vision_outcome, /^vision_/u); assert.equal(steps.length, before, "nothing clicked");
      assert.equal(fs.existsSync(capture), true, "the failure picture stays for the field report");
    }
    const retryFails = await visionRescueSearch({ isExecutionAllowed: () => true, runStep: async () => ({ ok: false, blocked_reason: "search_result_not_opened" }),
      visionRescue: async () => ({ ok: true, x: 0.25, y: 0.1 }) }, root, failed(), args);
    assert.equal(retryFails.ok, false); assert.equal(retryFails.diagnostics.vision_outcome, "vision_retry_search_result_not_opened");
    // A retry that ran into something else (here a misclick onto 网络查找 the user's typing kept from
    // being undone) is its own result: the workflow pauses on it and records the bad candidate.
    const misclick = await visionRescueSearch({ isExecutionAllowed: () => true, visionRescue: async () => ({ ok: true, x: 0.25, y: 0.1 }),
      runStep: async () => ({ ok: false, blocked_reason: "wechat_search_network_lookup_misclick", landing_recovered: false, poisoned_candidate: "row-2", diagnostics: {} }) }, root, failed(), args);
    assert.equal(misclick.blocked_reason, "wechat_search_network_lookup_misclick");
    assert.equal(misclick.landing_recovered, false); assert.equal(misclick.poisoned_candidate, "row-2");
    assert.equal(misclick.diagnostics.vision_outcome, "vision_retry_wechat_search_network_lookup_misclick");
    // A point at the very edge stays a valid fraction (x = 0.99997 is not printed as 1.0000).
    const edgeSteps = [];
    await visionRescueSearch({ isExecutionAllowed: () => true, visionRescue: async () => ({ ok: true, x: 0.99997, y: 0 }),
      runStep: async (...step) => { edgeSteps.push(step); return { ok: true, diagnostics: {} }; } }, root, failed(), args);
    assert.match(edgeSteps[0][1].at(-1), /^0.9999,0.0001,/u);

    // Other failures, no capture, no rescue wired in, or a paused task: nothing is asked.
    let calls = 0; const count = async () => { calls += 1; return { ok: true, x: 0.5, y: 0.5 }; };
    await visionRescueSearch({ ...base, visionRescue: count }, root, { ...failed(), blocked_reason: "wechat_window_not_foreground" }, args);
    await visionRescueSearch({ ...base, visionRescue: count }, root, { ok: false, blocked_reason: "exact_search_result_not_found", diagnostics: { capture_source: "popup" } }, args);
    await visionRescueSearch({ ...base, visionRescue: count }, root, { ...failed(), diagnostics: { capture_source: "formula_fallback", search_capture_file: capture } }, args);
    assert.equal(calls, 0);
    assert.equal((await visionRescueSearch(base, root, failed(), args)).ok, false);
    const paused = await visionRescueSearch({ isExecutionAllowed: () => false, runStep, visionRescue: async () => ({ ok: true, x: 0.5, y: 0.5 }) }, root, failed(), args);
    assert.equal(paused.diagnostics.vision_outcome, "vision_cancelled");
    try { fs.unlinkSync(capture); } catch {}
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log("vision rescue self-check passed: same picture only, point to screen, any doubt keeps the skip and its evidence");
})().catch((error) => { console.error(error); process.exitCode = 1; });
