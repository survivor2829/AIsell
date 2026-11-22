const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { HEADER_BAND_POWERSHELL, headerBandEnvironment, parseVisionTitle, sameTitleStrip, titleCaptureSha256, visionTitleBand } = require("./wechat_title_strip.cjs");
const { spawnSync } = require("node:child_process");

// A chat confirmed by the AI title check is fingerprinted where its title is, not in the fixed
// 34-74 dp band that missed it at 225% (review 2026-11-22). The band: share of the width and dp from the top.
const band225 = visionTitleBand({ box: { left: 0.64, right: 0.8, top: 0.45, bottom: 0.62 } }, { dpi: 216, rect: { top: 0, bottom: 1600 } });
assert.deepEqual(band225, { left: 0.64, right: 0.8, top_dp: 90, bottom_dp: 124 }, "225%: the title 90-124 dp down, under the fixed band");
assert.equal(visionTitleBand({ box: { left: 0.5, right: 0.4, top: 0.1, bottom: 0.2 } }, { dpi: 96, rect: { top: 0, bottom: 760 } }), null);
assert.equal(visionTitleBand(null, { dpi: 96, rect: { top: 0, bottom: 760 } }), null);
assert.equal(headerBandEnvironment(band225), "0.64,0.8,90,124"); assert.equal(headerBandEnvironment(null), "");
const bandRun = spawnSync("powershell.exe", ["-NoProfile", "-Command", `${HEADER_BAND_POWERSHELL}
$env:XIAOXI_HEADER_BAND = "0.64,0.8,90,124"
$a = Get-XiaoxiHeaderBand ([pscustomobject]@{ Left = 0; Top = 0; Width = 2400; Bottom = 1600 }) 216
$env:XIAOXI_HEADER_BAND = "1.2,0.8,90,124"
$b = Get-XiaoxiHeaderBand ([pscustomobject]@{ Left = 0; Top = 0; Width = 2400; Bottom = 1600 }) 216
@{ a = $a; b = ($b -eq $null) } | ConvertTo-Json -Compress`], { encoding: "utf8", timeout: 60000 });
assert.equal(bandRun.status, 0, bandRun.stderr);
const bandOut = JSON.parse(bandRun.stdout.trim().split(/\r?\n/u).at(-1));
// 90 dp minus a 10.2 dp margin at 2.25 = 179.55, rounded 180 px; 124 + 10.2 dp = 302 px; 0.64 × 2400 − 24 dp = 1482 px.
assert.deepEqual({ ...bandOut.a }, { left: 1482, right: 1974, top: 180, bottom: 302 }, "the capture box around the title, at 225%");
assert.equal(bandOut.b, true, "a band that is not a place in the window: none");
const driverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.dev.cjs"), "utf8");
const count = (text) => driverSource.split(text).length - 1;
assert.equal(count(`-ceq "vision_title") {`), 2, "both header fingerprints use the title's place");
assert.equal(count("Get-XiaoxiHeaderBand $"), 2);
assert.equal(count("if ($band -eq $null) { $captureRight = $captureLeft }"), 2, "without the place, no fingerprint");
assert.equal(count("XIAOXI_HEADER_BAND: headerBandEnvironment(context.titleBand)"), 2);
const { saveState, loadState } = require("./state_machine.cjs");
const { visionRescueTitle, confirmVisionTitle, verifyRealSendSessionAsync } = require("./state_machine.dev.cjs");

// AI 看图 for the chat title (2026-11-21): the model reads the title in the window's top strip; the
// chat counts as opened only if a new strip shows the same pixels around that title, and from then on
// only an unchanged header is required (vision_title, like a chat opened by its exact 微信号).
const encode = (width, height, paint) => {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const [r, g, b] = paint(x, y); raw.set([r, g, b, 255], y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
// A 200×40 strip: the title (dark) at x 100–140, y 15–25; a search box at x 20–60 that may change.
const strip = ({ title = 30, search = 240, width = 200 } = {}) => encode(width, 40, (x, y) =>
  x >= 100 && x < 140 && y >= 15 && y < 25 ? [title, title, title] : x >= 20 && x < 60 && y >= 10 && y < 30 ? [search, search, search] : [250, 250, 250]);
const temp = (bytes) => { const file = path.join(os.tmpdir(), `xiaoxi-title-capture-${crypto.randomBytes(16).toString("hex")}.png`); fs.writeFileSync(file, bytes); return file; };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const reference = strip();
const referenceFile = temp(reference);
const box = { left: 0.5, top: 0.375, right: 0.7, bottom: 0.625 };
const seen = { box, capture: sha(reference), reference: path.basename(referenceFile) };
assert.equal(titleCaptureSha256(referenceFile), sha(reference));
assert.equal(titleCaptureSha256(path.join(os.tmpdir(), "other.png")), "", "only our own strips");

// The argument the confirming step gets.
assert.deepEqual(parseVisionTitle(`0.5000,0.3750,0.7000,0.6250,${seen.capture},${seen.reference}`), seen);
for (const bad of [`0.7,0.3,0.5,0.6,${seen.capture},${seen.reference}`, `0.5,0.3,0.7,0.6,${seen.capture},../x.png`,
  `0.5,0.3,0.7,1.2,${seen.capture},${seen.reference}`, `0.5,0.3,0.7,${seen.capture},${seen.reference}`, ""]) assert.equal(parseVisionTitle(bad), undefined, bad);

// Same pixels around the title → the reading applies; the search box elsewhere may change.
const compare = (bytes, at = seen) => { const file = temp(bytes); try { return sameTitleStrip(at, file); } finally { fs.unlinkSync(file); } };
assert.equal(compare(strip()), true);
assert.equal(compare(strip({ search: 200 })), true, "outside the title the strip may change");
assert.equal(compare(strip({ title: 31 })), false, "the title changed by one shade: another picture");
assert.equal(compare(strip({ width: 210 })), false, "another window size");
assert.equal(compare(strip(), { ...seen, capture: "0".repeat(64) }), false, "the reference must be the picture the model read");
assert.equal(compare(strip(), { ...seen, reference: "xiaoxi-title-capture-" + "0".repeat(32) + ".png" }), false);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-title-"));
  try {
    const customer = { name: "测试联系人甲", id: "1", wechatAccountId: "wxid_account" };
    const failedState = () => saveState(root, { selected_customer: customer, target_selected: true, search_query: "测试联系人甲",
      search_result_clicked: true, last_result: "blocked", blocked_reason: "search_result_not_opened", conversation_verified: false });

    // Confirm step: a new strip of the same window, same pixels around the title → opened, vision_title.
    const capturer = (bytes, more = {}) => (context) => ({ ok: true, pid: context.pid, hWnd: context.hWnd, processName: "Weixin", file: temp(bytes),
      dpi: 216, rect: { left: 0, top: 0, right: 2400, bottom: 1600 }, ...more });
    failedState();
    const confirmed = confirmVisionTitle(root, { pid: "41", hWnd: "77", visionTitle: seen }, capturer(strip()));
    assert.equal(confirmed.ok, true);
    const opened = loadState(root);
    assert.equal(opened.conversation_verified, true); assert.equal(opened.conversation_verification_mode, "vision_title");
    assert.equal(opened.conversation_title, "测试联系人甲"); assert.equal(opened.window_pid, 41); assert.equal(opened.window_handle, "77");
    assert.equal(opened.blocked_reason, ""); assert.equal(opened.conversation_token, "", "the token is bound by the session check");
    // The title's place is kept: from now on the chat is fingerprinted there (225%: strip 200 dp).
    assert.deepEqual(opened.vision_title_band, visionTitleBand(seen, { dpi: 216, rect: { top: 0, bottom: 1600 } }));
    assert.ok(opened.vision_title_band.top_dp > 0 && opened.vision_title_band.bottom_dp <= 200);
    // Anything else keeps the skip.
    const refused = (context, capture) => { failedState(); const out = confirmVisionTitle(root, context, capture); assert.equal(out.ok, false);
      assert.equal(out.blocked_reason, "search_result_not_opened"); assert.equal(loadState(root).conversation_verified, false); return out.diagnostics.vision_title_outcome; };
    const ctx = { pid: "41", hWnd: "77", visionTitle: seen };
    assert.equal(refused(ctx, capturer(strip({ title: 90 }))), "title_strip_changed");
    assert.equal(refused(ctx, capturer(strip(), { hWnd: "78" })), "window_changed");
    assert.equal(refused(ctx, capturer(strip(), { rect: undefined })), "title_band_unknown", "no place for the title: not confirmed");
    assert.equal(refused(ctx, () => ({ ok: false, outcome: "wechat_window_not_foreground" })), "wechat_window_not_foreground");
    assert.equal(refused({ ...ctx, visionTitle: undefined }, capturer(strip())), "context_missing");
    assert.equal(refused({ ...ctx, hWnd: "7 7" }, capturer(strip())), "context_missing");
    saveState(root, { ...loadState(root), blocked_reason: "exact_search_result_not_found" });
    assert.equal(confirmVisionTitle(root, ctx, capturer(strip())).diagnostics.vision_title_outcome, "state_changed", "only right after a title that was not confirmed");

    // Orchestration: the strip goes to the model with the expected name; a confirmed reading runs the
    // confirming step with where the title is and which picture was read.
    const args = ["--expected-pid", "41", "--expected-hwnd", "77", "--min-idle-ms", "0"];
    const failure = (file) => ({ ok: false, blocked_reason: "search_result_not_opened", diagnostics: { rule_id: "search-r001", title_capture_file: file } });
    const steps = [];
    const base = { isExecutionAllowed: () => true, runStep: async (command, stepArgs) => { steps.push([command, ...stepArgs]); return { ok: true, state: {} }; } };
    failedState();
    let file = temp(reference), asked;
    const rescued = await visionRescueTitle({ ...base, visionTitle: async (input) => { asked = input; return { ok: true, box }; } }, root, failure(file), args);
    assert.equal(rescued.ok, true); assert.equal(rescued.vision_title_rescued, true);
    assert.deepEqual(asked, { file, expectedName: "测试联系人甲" });
    assert.deepEqual(steps.at(-1), ["confirm-vision-title", ...args, "--vision-title", `0.5000,0.3750,0.7000,0.6250,${sha(reference)},${path.basename(file)}`]);
    assert.equal(fs.existsSync(file), false, "a confirmed chat leaves no picture behind");

    // Not the person, a model error, a failed confirmation: the skip stands and the strip stays for the field report.
    for (const [visionTitle, runStep, outcome] of [
      [async () => ({ ok: false, reason: "vision_title_mismatch" }), base.runStep, "vision_title_mismatch"],
      [async () => { throw Object.assign(Error("x"), { code: "vision_http_502" }); }, base.runStep, "vision_http_502"],
      [async () => ({ ok: true, box }), async () => ({ ok: false, blocked_reason: "search_result_not_opened", diagnostics: { vision_title_outcome: "title_strip_changed" } }), "vision_title_title_strip_changed"]]) {
      file = temp(reference);
      const kept = await visionRescueTitle({ isExecutionAllowed: () => true, runStep, visionTitle }, root, failure(file), args);
      assert.equal(kept.ok, false); assert.equal(kept.blocked_reason, "search_result_not_opened");
      assert.equal(kept.diagnostics.vision_title_outcome, outcome); assert.equal(kept.diagnostics.title_capture_file, file);
      assert.equal(fs.existsSync(file), true); fs.unlinkSync(file);
    }
    // No strip, another failure, nothing wired in, no window identity, or a paused task: nothing is confirmed.
    let calls = 0; const count = async () => { calls += 1; return { ok: true, box }; };
    file = temp(reference);
    const before = steps.length;
    await visionRescueTitle({ ...base, visionTitle: count }, root, { ...failure(file), blocked_reason: "exact_search_result_not_found" }, args);
    await visionRescueTitle({ ...base, visionTitle: count }, root, { ok: false, blocked_reason: "search_result_not_opened", diagnostics: {} }, args);
    await visionRescueTitle(base, root, failure(file), args);
    await visionRescueTitle({ ...base, visionTitle: count }, root, failure(file), ["--min-idle-ms", "0"]);
    assert.equal(calls, 0);
    const paused = await visionRescueTitle({ ...base, isExecutionAllowed: () => false, visionTitle: count }, root, failure(file), args);
    assert.equal(paused.diagnostics.vision_title_outcome, "vision_cancelled"); assert.equal(steps.length, before, "nothing confirmed");
    fs.unlinkSync(file);

    // Later checks: a vision_title chat is checked like an exact-微信号 chat (an unchanged header), and
    // keeps its mode; a chat confirmed by its title is not.
    const contexts = [];
    const driver = async (name, context) => { contexts.push(context); return { ok: true, pid: 41, hWnd: "77", processName: "Weixin", title: name,
      verificationMode: context.allowExactSearchFallback ? context.provenMode : "conversation_title", conversationToken: "conversation:v2:41:77:visual:abc",
      accountVerified: true, accountId: "wxid_account" }; };
    saveState(root, { ...opened, real_send_status: "not_sent" });
    assert.equal((await verifyRealSendSessionAsync(root, driver)).ok, true);
    assert.equal(contexts.at(-1).allowExactSearchFallback, true); assert.equal(contexts.at(-1).provenMode, "vision_title");
    assert.equal(loadState(root).conversation_verification_mode, "vision_title");
    assert.equal(loadState(root).conversation_token, "conversation:v2:41:77:visual:abc");
    saveState(root, { ...opened, conversation_verification_mode: "conversation_title", real_send_status: "not_sent" });
    await verifyRealSendSessionAsync(root, driver);
    assert.equal(contexts.at(-1).allowExactSearchFallback, false);
    saveState(root, { ...opened, window_handle: "", real_send_status: "not_sent" });
    await verifyRealSendSessionAsync(root, driver);
    assert.equal(contexts.at(-1).allowExactSearchFallback, false, "never without the window it was confirmed in");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.unlinkSync(referenceFile);
  }
  console.log("vision title self-check passed: the model's title counts only with the same pixels twice; later checks keep the header");
})().catch((error) => { console.error(error); process.exitCode = 1; });
