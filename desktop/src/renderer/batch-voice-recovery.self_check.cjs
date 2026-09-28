const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// Load the real TypeScript modules (and the card component) the way the page imports them.
for (const extension of [".ts", ".tsx"]) {
  require.extensions[extension] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, strict: true },
      fileName: filename
    }).outputText;
    module._compile(output, filename);
  };
}
const {
  ACTION_LABELS, NOT_CACHED_CODE, VOICE_RECOVERY_BLOCKS, approvedVoiceIds, previewAfterFailure, previewCharge,
  resumeNeedsVoice, sessionAfterPreview, voiceRecovery
} = require("./batch-voice-recovery.ts");
const { BatchVoiceRecovery, VoiceRecoveryCard } = require("./BatchVoiceRecovery.tsx");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const page = read("BatchCreativePage.tsx");
const soundSettings = read("BatchSoundSettings.tsx");
const card = read("BatchVoiceRecovery.tsx");
const resourcePanel = read("AutoMixResourcePanel.tsx");

const monkeyId = "volc-monkey-brother-2@1";
const WARNING = "该批次的声音需要重新试听批准，或改选已批准的声音。";
const monkey = (changes = {}) => ({ voicePersonaId: monkeyId, displayName: "猴哥 2.0", approvalStatus: "pending", previewStatus: "completed", provider: "volcengine", ...changes });
const xiaohe = { voicePersonaId: "volc-xiaohe-2@1", displayName: "小何 2.0", approvalStatus: "approved", previewStatus: "completed", provider: "volcengine" };
const batchWith = (voice, changes = {}) => ({ batch_id: "narrated_batch_0a89fb41936f449bb671fb030d823ec0", settings: { voice_persona_id: voice, workflow_version: 2 }, ...changes });
const render = (batch, voices) => renderToStaticMarkup(React.createElement(BatchVoiceRecovery, { batch, voices, onApproved: () => undefined }));

// The five states of the card.
{
  const free = voiceRecovery(batchWith(monkeyId), [xiaohe, monkey()]);
  assert.equal(free.kind, "free", "a saved preview on this machine: replay it for free");
  assert.deepEqual(free.actions, ["play_saved"], "approval waits until a preview has played");
  assert.match(free.message, /本批使用的「猴哥 2\.0」批准已失效（常见原因：这台电脑运行过不含该声音的旧版本）/u);

  for (const voices of [[monkey({ previewStatus: "not_ready" })], [monkey({ previewStatus: "failed" })]]) {
    const paid = voiceRecovery(batchWith(monkeyId), voices);
    assert.equal(paid.kind, "paid", `${voices[0].previewStatus}: no saved preview, the only way is a paid one`);
    assert.deepEqual(paid.actions, ["regenerate"]);
    assert.match(paid.message, /计费/u);
  }
  for (const previewStatus of ["submitted", "outcome_unknown"]) {
    const unknown = voiceRecovery(batchWith(monkeyId), [monkey({ previewStatus })]);
    assert.equal(unknown.kind, "unknown");
    assert.deepEqual(unknown.actions, [], `${previewStatus}: no button, a new preview could be charged twice`);
    assert.match(unknown.message, /无法确认.*重复计费/u);
  }
  const retired = voiceRecovery(batchWith(monkeyId), [xiaohe]);
  assert.equal(retired.kind, "retired");
  assert.deepEqual(retired.actions, []);
  assert.match(retired.message, /不在当前声音目录.*新建视频.*其他已批准的声音/u);

  assert.equal(voiceRecovery(batchWith(monkeyId), [monkey({ approvalStatus: "approved" })]), null, "an approved voice shows no card");
  assert.equal(voiceRecovery(batchWith(monkeyId, { archived: true }), [monkey()]), null, "archived batches are only viewed");
  assert.equal(voiceRecovery(batchWith(undefined), [monkey()]), null);
  assert.equal(voiceRecovery(batchWith(monkeyId), null), null, "an unread catalog is not a revoked approval");
  assert.equal(voiceRecovery(null, [monkey()]), null);

  assert.equal(ACTION_LABELS.play_saved("猴哥 2.0"), "播放已保存试听（不计费）");
  assert.equal(ACTION_LABELS.regenerate("猴哥 2.0"), "重新生成试听（调用一次云端配音，计费）");
  assert.equal(ACTION_LABELS.approve("猴哥 2.0"), "批准使用「猴哥 2.0」");
  assert.deepEqual([...approvedVoiceIds([xiaohe, monkey()])], ["volc-xiaohe-2@1"]);
}

// What a preview teaches the card.
{
  const played = sessionAfterPreview({}, { audioDataUrl: "data:audio/wav;base64,UklGRg==" });
  assert.deepEqual(voiceRecovery(batchWith(monkeyId), [monkey()], played).actions, ["play_saved", "approve"],
    "批准使用 appears only after the replay played");
  assert.deepEqual(sessionAfterPreview({}, { audioDataUrl: null }), {}, "no audio, no approval");
  const missing = sessionAfterPreview({}, { code: NOT_CACHED_CODE });
  const fallback = voiceRecovery(batchWith(monkeyId), [monkey()], missing);
  assert.equal(fallback.kind, "paid", "not_cached switches the card to the paid preview");
  assert.deepEqual(fallback.actions, ["regenerate"]);
  assert.deepEqual(sessionAfterPreview({}, { code: "cloud_request_failed" }), {}, "other failures change nothing");
  const paidPlayed = sessionAfterPreview(missing, { audioDataUrl: "data:audio/wav;base64,UklGRg==" });
  assert.deepEqual(voiceRecovery(batchWith(monkeyId), [monkey()], paidPlayed).actions, ["regenerate", "approve"]);
}

// The card as rendered: which buttons exist and which trusted-click gate each one feeds.
{
  const free = render(batchWith(monkeyId), [monkey()]);
  assert.match(free, /<button type="button" data-xiaoxi-auto-mix-voice-preview="">播放已保存试听（不计费）<\/button>/u);
  assert.doesNotMatch(free, /data-xiaoxi-auto-mix-voice-approve|计费一次|调用一次云端配音/u, "no approval and no paid button before a replay");
  const paid = render(batchWith(monkeyId), [monkey({ previewStatus: "not_ready" })]);
  assert.match(paid, /data-xiaoxi-auto-mix-voice-preview="">重新生成试听（调用一次云端配音，计费）<\/button>/u);
  assert.doesNotMatch(paid, /不计费/u);
  for (const [voices, text] of [[[monkey({ previewStatus: "outcome_unknown" })], /无法确认/u], [[xiaohe], /新建视频/u]]) {
    const markup = render(batchWith(monkeyId), voices);
    assert.match(markup, text);
    assert.doesNotMatch(markup, /<button/u);
  }
  assert.equal(render(batchWith(monkeyId), [monkey({ approvalStatus: "approved" })]), "");

  // After a preview played: 批准使用 must feed the approval gate. With the preview gate
  // instead, the preload hands the approval no click token and it can never go through.
  const card = (session) => renderToStaticMarkup(React.createElement(VoiceRecoveryCard, {
    recovery: voiceRecovery(batchWith(monkeyId), session.notCached ? [monkey({ previewStatus: "not_ready" })] : [monkey()], session),
    audio: "data:audio/wav;base64,UklGRg==", onAction: () => undefined }));
  for (const session of [{ auditioned: true }, { auditioned: true, notCached: true }]) {
    const markup = card(session);
    assert.match(markup, /<button type="button" class="batch-primary" data-xiaoxi-auto-mix-voice-approve="">批准使用「猴哥 2\.0」<\/button>/u,
      "批准使用 carries the approval gate");
    assert.equal((markup.match(/data-xiaoxi-auto-mix-voice-approve/gu) || []).length, 1);
    assert.equal((markup.match(/data-xiaoxi-auto-mix-voice-preview/gu) || []).length, 1, "only the preview button feeds the audition gate");
    assert.match(markup, session.notCached ? /data-xiaoxi-auto-mix-voice-preview="">重新生成试听/u : /data-xiaoxi-auto-mix-voice-preview="">播放已保存试听/u);
    assert.match(markup, /<audio controls="" autoplay="" src="data:audio\/wav;base64,UklGRg==" aria-label="试听 猴哥 2\.0">/u);
  }
}

// What a voice preview button costs, wherever it is (resource panel, 声音与配乐).
{
  assert.deepEqual(previewCharge("completed"), { cacheOnly: true, label: "不计费" }, "a completed preview only replays");
  for (const status of ["not_ready", "failed", "submitted", "outcome_unknown", undefined]) {
    assert.deepEqual(previewCharge(status), { cacheOnly: false, label: "计费一次" }, `${status}: synthesizes once`);
  }
  const saved = monkey();
  const relabelled = previewAfterFailure(saved, true, NOT_CACHED_CODE);
  assert.equal(relabelled.previewStatus, "not_ready", "a replay that found nothing saved relabels the voice");
  assert.deepEqual(previewCharge(relabelled.previewStatus), { cacheOnly: false, label: "计费一次" },
    "so the next click is the labelled paid preview, not the same free button forever");
  assert.equal(saved.previewStatus, "completed", "the voice list item itself is not mutated");
  assert.equal(previewAfterFailure(saved, true, "cloud_request_failed"), saved, "other failures change nothing");
  assert.equal(previewAfterFailure(saved, false, NOT_CACHED_CODE), saved, "only a cacheOnly replay can report not_cached");
}

// 恢复任务 continues paid production that ends in the voice step (the engine refuses it
// too, resume_creative_task) for confirmed copy and legacy batches; writing copy does not.
{
  const confirmed = { script_confirmation: { script_id: "s", revision: 1 } };
  assert.equal(resumeNeedsVoice(batchWith(monkeyId, confirmed)), true, "e506: confirmed copy, paused production");
  assert.equal(resumeNeedsVoice(batchWith(monkeyId)), false, "a paused copy-writing task does not use the voice");
  assert.equal(resumeNeedsVoice({ settings: { voice_persona_id: monkeyId } }), true, "legacy samples and continue voice too");
  assert.equal(resumeNeedsVoice(null), false);
}

// The page after an approval (CE1 round-3 leftover): the approved list was read once on
// mount, so every batch loaded afterwards still reported the voice as unapproved. Wired as
// BatchCreativePage.tsx wires it; the source assertions below pin the lines it mirrors.
function engine() {
  const voices = [xiaohe, monkey()];
  return {
    voices, approvals: 0, previews: [],
    list: async () => voices.map((voice) => ({ ...voice })),
    preview: async ({ voicePersonaId, cacheOnly }) => {
      engineCalls.previews.push({ voicePersonaId, cacheOnly });
      return { audioDataUrl: "data:audio/wav;base64,UklGRg==" };
    },
    approve: async (voicePersonaId) => {
      voices[voices.findIndex((voice) => voice.voicePersonaId === voicePersonaId)].approvalStatus = "approved";
    }
  };
}
const engineCalls = { previews: [] };
function workbench(api, { refreshAfterApproval }) {
  const state = { approved: null, catalog: null, notice: "", batch: null, session: {} };
  const apply = (items) => { state.approved = approvedVoiceIds(items); state.catalog = items; };
  const warning = (b) => b.settings?.voice_persona_id && !b.archived && state.approved && !state.approved.has(b.settings.voice_persona_id) ? WARNING : "";
  return {
    state,
    async open() { apply(await api.list()); },
    load(b) { state.batch = b; state.session = {}; state.notice = warning(b); },
    card() { return voiceRecovery(state.batch, state.catalog, state.session); },
    async play() {
      const cacheOnly = this.card().actions.includes("play_saved");
      state.session = sessionAfterPreview(state.session, await api.preview({ voicePersonaId: this.card().voiceId, ...(cacheOnly ? { cacheOnly } : {}) }));
    },
    async approve() {
      await api.approve(this.card().voiceId);
      if (!refreshAfterApproval) return;
      apply(await api.list());
      if (!warning(state.batch)) state.notice = state.notice.replace(WARNING, "").trim();
    }
  };
}
async function main() {
  for (const refreshAfterApproval of [false, true]) {
    engineCalls.previews.length = 0;
    const bench = workbench(engine(), { refreshAfterApproval });
    await bench.open();
    bench.load(batchWith(monkeyId));
    assert.equal(bench.state.notice, WARNING);
    assert.equal(bench.card().kind, "free");
    await bench.play();
    assert.deepEqual(engineCalls.previews, [{ voicePersonaId: monkeyId, cacheOnly: true }], "the card replays with cacheOnly");
    assert.ok(bench.card().actions.includes("approve"));
    await bench.approve();
    bench.load(batchWith(monkeyId, { batch_id: "narrated_batch_c84e0000000000000000000000000000" }));
    if (!refreshAfterApproval) {
      assert.equal(bench.state.notice, WARNING, "the model reproduces the leftover: a later batch is still flagged");
      continue;
    }
    assert.equal(bench.card(), null, "the approved voice leaves no card");
    assert.equal(bench.state.notice, "", "and no warning on the next batch that uses it");
  }

  // Source pins for the page wiring the harness mirrors.
  assert.match(page, /approvedVoiceIds\.current = approvedIn\(items\);\s*setCatalog\(items\);/u, "one place applies the voice list");
  assert.match(page, /const approved = applyVoices\(results\[0\]\.value\.data\?\.items \|\| \[\]\);/u, "the mount read goes through it");
  assert.match(page, /results\[0\]\.status === "fulfilled" && results\[0\]\.value\.ok !== false/u, "a failed read is not an empty catalog");
  assert.match(page, /async function refreshVoices\(\) \{[\s\S]{0,400}applyVoices\(result\.data\.items \|\| \[\]\);/u);
  assert.match(page, /async function voiceApproved\(\) \{\s*await refreshVoices\(\);/u);
  assert.match(page, /onApproved=\{async \(name\) => \{ setNotice\([^;]+\); await voiceApproved\(\); \}\}/u, "the card's approval re-reads the list");
  assert.match(page, /onVoiceApproved=\{voiceApproved\} refreshToken=\{catalog\}/u, "so does an approval in 声音与配乐");
  assert.match(page, /<BatchVoiceRecovery key=\{`\$\{batch\.batch_id\}:\$\{batch\.settings\?\.voice_persona_id \|\| ""\}`\} batch=\{batch\} voices=\{catalog\}/u);
  assert.match(page, /const voiceBlocked = voiceRecovery\(batch, catalog\) !== null;/u);
  assert.match(page, /\(!visualFlow \|\| running \|\| paused \|\| submitting \|\| failedState \|\| voiceBlocked\)/u,
    "the card is in the status area at every step, also for a completed batch");
  assert.equal((page.match(/data-batch-action="continue" disabled=\{locked \|\| dirty \|\| voiceBlocked\}/gu) || []).length, 2,
    "both continue buttons wait for the voice");
  assert.match(page, /const recoveryHeld = voiceBlocked \? VOICE_RECOVERY_BLOCKS :/u);
  assert.match(page, /data-batch-action="resolve" className="batch-primary" disabled=\{busy \|\| submitting \|\| Boolean\(recoveryHeld\)\}/u);
  assert.match(page, /const continueHint = voiceBlocked \? VOICE_RECOVERY_BLOCKS :/u, "and say why");
  assert.match(VOICE_RECOVERY_BLOCKS, /恢复批准/u);
  assert.match(soundSettings, /approveAutoMixVoicePersona: async \(payload\) => \{\s*const approved = await api\.approveAutoMixVoicePersona\(payload\);[\s\S]{0,200}await approvedCallback\.current\?\.\(\);/u);
  assert.match(soundSettings, /useEffect\(\(\) => \{ void refresh\(\); \}, \[refreshToken\]\);/u);
  assert.match(soundSettings, /\{unavailable && <option value=\{settings\.voice_persona_id\} disabled>\{unavailable\}<\/option>\}/u);
  assert.match(soundSettings, /`\$\{current\.displayName\}（需重新批准）`/u);
  assert.match(card, /previewAutoMixVoicePersona\?\.\(\{ voicePersonaId: voiceId, \.\.\.\(cacheOnly \? \{ cacheOnly: true \} : \{\}\) \}\)/u);
  assert.match(card, /play_saved: \(\) => play\(true\), regenerate: \(\) => play\(false\)/u, "only the free button replays with cacheOnly");
  assert.match(card, /sessionAfterPreview\(current, result\)/u);
  assert.match(page, /const resumeHeld = paused && voiceBlocked && resumeNeedsVoice\(batch\) \? VOICE_RECOVERY_BLOCKS : "";/u);
  assert.match(page, /\{resumeHeld && <p className="batch-hint" role="status">\{resumeHeld\}<\/p>\}<button disabled=\{busy \|\| Boolean\(resumeHeld\)\} title=\{resumeHeld \|\| undefined\} onClick=\{\(\) => void run\(async \(\) => \{\s*const action = paused \? "resume" : "pause";/u,
    "恢复任务 waits for the voice card too, and says why");
  // The resource panel and 声音与配乐 label and send their previews the same way.
  assert.match(resourcePanel, /const \{ cacheOnly \} = previewCharge\(persona\.previewStatus\);[\s\S]{0,120}previewAutoMixVoicePersona\(\{ voicePersonaId: persona\.voicePersonaId, \.\.\.\(cacheOnly \? \{ cacheOnly \} : \{\}\) \}\)/u,
    "the panel's 不计费 button is a cacheOnly replay");
  assert.match(resourcePanel, /const next = previewAfterFailure\(persona, cacheOnly, errorCode\(error\)\);\s*if \(next !== persona\) setVoiceItems\(\(items\) => replacePersona\(items, next\)\);/u,
    "and after not_cached it relabels the voice instead of offering 不计费 again");
  assert.match(resourcePanel, /isPreviewing \? "读取中" : `试听（\$\{previewCharge\(persona\.previewStatus\)\.label\}）`/u);
  assert.match(soundSettings, /const \{ cacheOnly \} = previewCharge\(voice\.previewStatus\);[\s\S]{0,200}api\.previewAutoMixVoicePersona\(\{ voicePersonaId: voice\.voicePersonaId, \.\.\.\(cacheOnly \? \{ cacheOnly \} : \{\}\) \}\)/u,
    "试听声音 in 声音与配乐 replays a saved preview with cacheOnly");
  assert.match(soundSettings, /const next = previewAfterFailure\(voice, cacheOnly, \(error as \{ code\?: string \}\)\.code\);\s*if \(next !== voice\) setVoices\(/u);
  assert.match(soundSettings, /const voiceCharge = previewCharge\(current\?\.previewStatus\);/u);
  assert.match(soundSettings, /onClick=\{\(\) => current && void auditionVoice\(current\)\}>\{loading === current\?\.voicePersonaId \? "准备试听…" : current \? `试听声音（\$\{voiceCharge\.label\}）` : "试听声音"\}/u,
    "and says whether it is charged");
  assert.doesNotMatch(soundSettings, /previewAutoMixVoicePersona\(\{ voicePersonaId: id \}\)/u, "no unlabelled paid preview is left");
  assert.match(card, /onAction=\{\(action\) => void run\[action\]\(\)\} \/>/u, "the live card renders the checked view");

  console.log("Batch voice recovery card self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
