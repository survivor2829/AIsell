// 场景效果视频 · 导演组 (2026-11-23, user: "多 agent 不同职责对应不同岗位"; "一次到位，不自动重拍").
// Video seconds are the expensive part; looking and thinking cost a few fen. So every check that can
// happen before a video is paid for happens here, each by its own role:
//   产品分析师  the photos (and the 定妆照) → a parts list, which sides of the machine were really photographed
//   场景勘察    the customer's site photo, or the scene picture → how wide, where the machine can work, can it turn
//   风险审查    every shot the director wrote, against those two → which shot would show what nobody photographed
// The director and the final check get their findings. Nothing here pays for a picture or a video again.
// Why (任务 pv_87e32caf, 驾驶式扫地车 / 小区): one front photo, the 定妆照 had no real back, the director wrote a
// shot from behind, and the video model turned the machine round on a narrow path and painted extra wheels.
const { DIRECTOR_MODEL, CREW: VERSION, shotPrompt } = require('./real-shoot-ai-director.cjs');
const { promptRef } = require("../shared/prompt-ref.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
const SIDES = Object.freeze({ front: '正面/车头', left: '左侧', right: '右侧', back: '背面/车尾', top: '顶部' });
const SIZES = ['large', 'medium', 'small'];

function jsonOf(content) {
  const text = String(content || '').replace(/```(?:json)?/giu, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw fail('product_video_crew_invalid', '没有输出 JSON');
  try { return JSON.parse(text.slice(start, end + 1)); } catch { throw fail('product_video_crew_invalid', 'JSON 格式不完整'); }
}
const message = (system, images, text) => [{ role: 'system', content: system },
  { role: 'user', content: [...images.map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text }] }];

// ① 产品分析师. images: the real photos, then the 定妆照 when there is one.
function analystRequest({ productName, facts = '', photos, sheet = '' }) {
  const n = photos.length;
  const system = `${promptRef("video.crew.analyst.p1")}${n}${promptRef("video.crew.analyst.p2")}${sheet ? `；最后一张是 AI 根据照片画的四视角定妆图，它可能画错，需要你核对` : ''}${promptRef("video.crew.analyst.p3")}${sheet ? promptRef("video.crew.sheet_issues") : ''}${promptRef("video.crew.analyst.p4")}${sheet ? ',"sheetIssues":[]' : ''}}`;
  const text = [`产品名称：${clean(productName, 80)}`, facts ? `客户资料：${clean(facts, 3000)}` : ''].filter(Boolean).join('\n');
  return { model: DIRECTOR_MODEL, temperature: 0.2, max_tokens: 1500, messages: message(system, sheet ? [...photos, sheet] : photos, text) };
}
function parseAnalyst(content) {
  const value = jsonOf(content);
  const sides = [...new Set((Array.isArray(value.sides) ? value.sides : []).filter((side) => SIDES[side]))];
  if (!sides.length) throw fail('product_video_crew_invalid', 'sides 为空');
  const parts = (Array.isArray(value.parts) ? value.parts : []).slice(0, 16)
    .map((row) => ({ name: clean(row?.name, 20), count: clean(row?.count, 120), where: clean(row?.where, 40) })).filter((row) => row.name);
  return { sides, parts, size: SIZES.includes(value.size) ? value.size : 'medium', sizeNote: clean(value.sizeNote, 120), turning: clean(value.turning, 120),
    sheetIssues: (Array.isArray(value.sheetIssues) ? value.sheetIssues : []).map((row) => clean(row, 80)).filter(Boolean).slice(0, 6) };
}

// ② 场景勘察. image: the customer's site photo, or the scene picture the director had drawn.
function surveyRequest({ sceneName, image, inventory, fromCustomer }) {
  const system = `${promptRef("video.crew.site_survey.p1")}${fromCustomer ? '客户在真实现场拍的照片' : 'AI 画的拍摄场地'}${promptRef("video.crew.site_survey.p2")}${sceneName}${promptRef("video.crew.site_survey.p3")}${inventory.sizeNote || inventory.size}；${inventory.turning || ''}${promptRef("video.crew.site_survey.p4")}`;
  return { model: DIRECTOR_MODEL, temperature: 0.2, max_tokens: 800, messages: message(system, [image], '请勘察这张场地图。') };
}
function parseSurvey(content) {
  const value = jsonOf(content);
  const widthM = Number(value.widthM);
  return { widthM: Number.isFinite(widthM) && widthM > 0 && widthM < 200 ? Math.round(widthM * 10) / 10 : null, floor: clean(value.floor, 120), dirt: clean(value.dirt, 160),
    zone: clean(value.zone, 160), canTurn: value.canTurn === true, fits: value.fits !== false, dirtVisible: value.dirtVisible !== false, note: clean(value.note, 120) };
}

// The sides no real photo shows. Left and right count as one: these machines are built symmetrical,
// so one side photographed is enough; the front and the back are not interchangeable.
function hiddenSides(inventory) {
  const sides = inventory?.sides || [];
  if (!sides.length) return '';
  const missing = [...(sides.includes('front') ? [] : [SIDES.front]), ...(sides.includes('left') || sides.includes('right') ? [] : ['侧面']), ...(sides.includes('back') ? [] : [SIDES.back])];
  return missing.join('、');
}
// What the director and the final check are told (text, built from the two reports).
function briefing(crew) {
  const inv = crew?.inventory;
  if (!inv) return '';
  const missing = hiddenSides(inv) ? [hiddenSides(inv)] : [];
  const lines = [`${promptRef("video.crew.report_analyst.p1")}${inv.sides.map((side) => SIDES[side]).join('、')}。${missing.length ? `没拍到：${missing.join('、')}——这些面视频模型只能瞎猜（会多画轮子、改结构），任何镜头都不能让它们出现在画面里；机器朝向和机位要保证画面里只露出拍到的面。` : ''}`,
    inv.parts.length ? `部件清单（照片能数清的）：${inv.parts.map((row) => `${row.name}${row.count ? ` ${row.count}` : ''}${row.where ? `（${row.where}）` : ''}`).join('；')}。画面里部件数量不能多也不能少。` : '',
    `体量：${({ large: '大型', medium: '中型', small: '小型' })[inv.size]}${inv.sizeNote ? `，${inv.sizeNote}` : ''}。${inv.turning}`];
  const site = crew.survey;
  if (site) lines.push(`${promptRef("video.crew.report_site.p1")}${crew.venuePhoto ? '客户现场照片' : '场地图'}${promptRef("video.crew.report_site.p2")}${site.widthM ?? '?'}${promptRef("video.crew.report_site.p3")}${site.floor}；脏污${site.dirt}；作业区：${site.zone}。${site.canTurn ? '' : '这里机器不能转弯或掉头，每个镜头都只能直行。'}${site.fits ? '' : '机器放在这里偏挤，镜头要选最宽的一段，不要贴近两侧障碍。'}${site.dirtVisible ? '' : '这张图里地面偏干净：每个清洁镜头都要写明开拍时地上有哪些脏污，不然看不出清洁效果。'}${site.note}`);
  return lines.filter(Boolean).join('\n');
}

// ③ 风险审查: before any video is paid for, every shot is read against the two reports.
function riskRequest({ plan, crew, photos, sheet, plate }) {
  const images = [...photos, ...(sheet ? [sheet] : []), ...(plate ? [plate] : [])];
  const list = plan.shots.map((shot) => `第${shot.index + 1}镜（${shot.seconds}秒，${shot.place === 'venue' ? '在场地图里' : '在别处'}）：${shot.prompt}`).join('\n\n');
  const system = `${promptRef("video.crew.risk_review.p1")}${photos.length}${promptRef("video.crew.risk_review.p2")}${sheet ? '，下一张是定妆图' : ''}${plate ? '，最后一张是拍摄场地' : ''}。
${briefing(crew)}${promptRef("video.crew.risk_review.p3")}`;
  return { model: DIRECTOR_MODEL, temperature: 0.2, max_tokens: 1500, messages: message(system, images, `分镜提示词：\n${list}`) };
}
function parseRisk(content, plan) {
  const value = jsonOf(content);
  const rows = Array.isArray(value.shots) ? value.shots : [];
  return plan.shots.map((shot) => {
    const row = rows.find((item) => Number(item?.index) === shot.index + 1) || {};
    const ok = row.ok !== false;
    return { index: shot.index, ok, risk: ok ? '' : clean(row.risk, 120) || '有穿帮风险', fix: ok ? '' : clean(row.fix, 160) };
  });
}
// The reviewer's findings, worded for the director's next attempt.
const riskFeedback = (risks) => risks.filter((row) => !row.ok).map((row) => `风险审查：第${row.index + 1}镜${row.risk}${row.fix ? `，${row.fix}` : ''}`).join('；');

// The last resort before money is spent (user 2026-11-23: 一次到位): a shot still flagged after the director's
// rewrites becomes the one camera move these models have never got wrong for us — a fixed, slightly raised
// camera beside a machine driving straight past (or towards the camera when no side was photographed),
// so only photographed sides show and the cleaned strip stays in view. Its caption stays.
// Which safe move a shot gets, from the sides really photographed: beside it, towards the camera, or behind it.
function safeMove(crew) {
  const sides = crew?.inventory?.sides || [];
  return sides.includes('left') || sides.includes('right') ? 'side' : sides.includes('front') ? 'front' : 'back';
}
function safeShotText({ plan, crew, shot }) {
  const move = safeMove(crew), side = move === 'side', front = move === 'front';
  const zone = crew?.survey?.zone ? `作业区：${crew.survey.zone}。` : '';
  const floor = `地面是${plan.surface || '这个场所常见的旧地面'}，开拍时地上看得见${plan.dirt || '日常的浮灰和脏污'}。`;
  const work = promptRef("video.crew.work");
  const camera = side
    ? promptRef("video.crew.camera_side")
    : front
      ? promptRef("video.crew.camera_top")
      : promptRef("video.crew.camera_follow");
  return `${zone}${floor}${camera}${work}`;
}
function applySafeShots(plan, crew) {
  const flagged = new Set((crew?.risks || []).filter((row) => !row.ok).map((row) => row.index));
  if (!flagged.size) return { plan, fallback: [] };
  const direction = { operator: plan.operator || 'none', wet: plan.wet === true };
  const shots = plan.shots.map((shot) => flagged.has(shot.index) ? { ...shot, place: plan.shots.some((row) => row.place === 'venue') ? 'venue' : shot.place, safe: true,
    prompt: shotPrompt(plan, direction, { prompt: safeShotText({ plan, crew, shot }), venue: plan.shots.some((row) => row.place === 'venue'), seconds: shot.seconds }) } : shot);
  return { plan: { ...plan, shots }, fallback: [...flagged] };
}

module.exports = { VERSION, SIDES, hiddenSides, analystRequest, parseAnalyst, surveyRequest, parseSurvey, briefing, riskRequest, parseRisk, riskFeedback, safeMove, safeShotText, applySafeShots };
