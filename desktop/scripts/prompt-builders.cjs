"use strict";
// Prompt assembly paths of the main process (user decision 2026-11-25: prompt wording lives on the server).
// prompt-equivalence.self_check.cjs builds each one with the wording (repository) and with tokens (as on a customer
// computer, then expanded the way the gateway does); both must send the same text. Add new paths when migrating.
const path = require("node:path");

const main = (name) => require(path.join(__dirname, "..", "src", "main", name));

async function builders() {
  const out = {};
  const catalog = main("scene-video-catalog.cjs");
  // 无人实拍: every device, scene and selling point (camera kind, {work}, liquid-free hints all branch on data).
  const real = main("real-shoot-director.cjs");
  const base = { mode: "product", durationSeconds: 60, productName: "CC1 Pro", extraImageIds: ["a", "b"] };
  for (const device of catalog.DEVICES) for (const sceneId of device.scenes) {
    const points = catalog.forDevice(device).filter((point) => !point.core).map((point) => point.id);
    for (let i = 0; i < points.length; i += 8) {
      const plan = real.planRealShoot({ ...base, deviceId: device.id, sceneIds: [sceneId], ...catalog.sceneDefaults(sceneId, device), pointIds: points.slice(i, i + 8) });
      out[`realshoot.${device.id}.${sceneId}.${i}`] = plan.shots.map((shot) => shot.prompt);
    }
  }
  out["realshoot.fillers"] = real.planRealShoot({ ...base, durationSeconds: 60, deviceId: "robot_scrubber", sceneIds: ["factory"], floorId: "epoxy", dirtIds: ["oil"], pointIds: ["lift"] }).shots.map((shot) => shot.prompt);
  // AI 导演: brief per selling point (hints without liquid words), customer-written points, the station keeps water.
  const ai = main("real-shoot-ai-director.cjs");
  const aiBase = { mode: "product", durationSeconds: 60, productName: "DZ95X 洗地机器人", sceneIds: ["factory"] };
  const optional = catalog.POINTS.filter((point) => !point.core).map((point) => point.id);
  for (let i = 0; i < optional.length; i += 3) {
    const plan = ai.planDirected({ ...aiBase, pointIds: optional.slice(i, i + 3), customPoints: ["洗拖一体"] });
    out[`ai.director.${i}`] = ai.directorMessages({ plan, images: ["data:a", "data:b"] });
  }
  // 剧情版.
  const story = main("story-video-director.cjs");
  const times = ["0-2", "2-4", "4-7", "7-9", "9-12", "12-15"];
  const sample = { title: "长通道", logline: "保洁员犯愁，机器替他扫干净了。", place: "物流仓库货架通道，绿色环氧地坪。",
    floor: { material: "绿色环氧地坪", dirty: "一层薄薄的浮灰。", clean: "同一块地面扫干净。" }, light: "普通白色工业灯。", background: "远处叉车驶过。",
    machine: { size: "约到成人胸口高", moving: "边刷旋转" },
    characters: [{ name: "老周", role: "保洁员", look: "五十多岁男性", voice: "低沉", prop: "尘推" }, { name: "小林", role: "主管", look: "三十岁女性", voice: "清亮", prop: "平板" }],
    segments: [0, 1].map((s) => ({ arc: "累到轻松", shots: times.map((time, k) => ({ time, camera: "中景平视", picture: `第${s + 1}段第${k + 1}镜`, ground: "前脏后净",
      lines: k === 1 ? [{ who: "老周", line: "又得扫半天", tone: "叹气" }] : [], sound: "电机声" })) })) };
  const parsed = story.parseStory(JSON.stringify(sample), 2);
  for (const unmanned of [false, true]) {
    for (const segments of [1, 2]) out[`story.messages.${unmanned}.${segments}`] = story.storyMessages({ productName: "CC1 Pro", facts: "资料", scene: { name: "医院", description: "公共区域" }, segments, unmanned });
    out[`story.video.${unmanned}`] = [0, 1].map((index) => story.videoPrompt({ ...parsed, unmanned }, index));
  }
  out["story.images"] = [story.sheetPrompt("CC1 Pro"), story.sheetPrompt("CC1 Pro", 3), story.scenePrompt(parsed), story.floorPrompt(parsed),
    story.personPrompt(parsed, 0), story.framePrompt(parsed, 0, 1), story.framePrompt(parsed, 1, 2)];
  // 产品效果视频.
  const video = main("video-directors.cjs");
  for (const facts of ["", "续航4小时，作业宽度55厘米，可清洗油污"]) {
    for (const surfaceId of ["tile", "epoxy"]) out[`video.plan.${facts ? "facts" : "plain"}.${surfaceId}`] = video.planVideo({ mode: "product", imageId: "a", productName: "CC1", facts, surfaceId, durationSeconds: 30, budgetCny: 50 }).shots.map((shot) => shot.prompt);
  }
  const rules = main("skills/cleaning-video-director/rules.cjs");
  out["skill.product"] = rules.productDirection({ scene: { name: "工厂" }, surface: { name: "环氧地坪" }, facts: "有", mode: "social" });
  out["skill.human"] = rules.humanDirection({ scene: { action: "指向产品" }, voice: { prompt: "温和女声" } });
  // 触达与客服话术 (requests captured from the client).
  const { createDeepSeekClient } = main("deepseek-api.cjs");
  const bodies = [];
  const client = createDeepSeekClient({ keyStore: { read: () => "test-key", status: () => ({ configured: true }) }, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body); bodies.push(body);
    const reply = body.response_format ? JSON.stringify({ action: "answer", reply: "好的", reasonCode: "answered", type: "person", value: "张总", salutation: "张总" }) : "您好";
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: reply } }] }) };
  } });
  const expert = { id: "e", name: "接待专家", rules: "只答产品问题", knowledge: "我们卖清洁设备", tone: "亲切", handoff: "报价转人工" };
  const settle = async (call) => { try { await call(); } catch { /* only the request body matters here */ } };
  await settle(() => client.draft({ task: { script: "欢迎咨询" }, result: { salutation: { type: "person", value: "张总" } } }));
  await settle(() => client.classifySalutation({ contact: { remark: "张总-保洁", nickname: "z" } }));
  await settle(() => client.reply({ expert, context: [{ role: "user", content: "多少钱？" }] }));
  await settle(() => client.reply({ expert, clarificationAllowed: false, context: [{ role: "user", content: "多少钱？" }] }));
  await settle(() => client.momentsComment({ postText: "新店开业", guidance: "自然一点" }));
  out["deepseek.requests"] = bodies.map((body) => body.messages);
  return out;
}

module.exports = { builders };

if (require.main === module) builders().then((out) => process.stdout.write(JSON.stringify(out)));
