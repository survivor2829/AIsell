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
  const system = `你是商用清洁设备的产品分析师，给视频导演和质检员出一份“这台机器长什么样”的清单。只信真实照片，不猜。
前${n}张是这台机器的真实照片${sheet ? `；最后一张是 AI 根据照片画的四视角定妆图，它可能画错，需要你核对` : ''}。
1. sides：真实照片里真正拍到了哪几面（front 车头正面、left 左侧、right 右侧、back 车尾背面、top 顶部）。斜45°同时看到车头和一侧的，两面都算。只在定妆图里出现的面不算。
2. parts：看得见的外部部件和数量，尤其是轮子（每一侧几个、前后各几个）、刷子/刷盘、刮条、座椅/方向盘、灯、后视镜。只列你确定看到的；数量只写照片里能数清的，被挡住看不清的写“看不清”；某一面没拍到，那一面的部件写“未拍到”，不要推测。
3. size：large（乘驾式、带驾驶室或座椅、车身比人宽）、medium（手推或跟随式，齐腰高）、small（家用/桌面大小）；sizeNote 写你根据门、座椅、人体比例估的长宽高（米），资料里有尺寸以资料为准。
4. turning：这种机器转弯需要多大空间，一句话（如“车身约1.4米宽，掉头需要约4米宽的路面”）。
${sheet ? '5. sheetIssues：定妆图和真实照片明显对不上、会让视频拍错的地方（多了/少了部件、轮子数不同、结构明显不同、主色不同）。这些不算问题，不要写：照片上临时贴的纸质标签、胶带被去掉了；照片背景里的其他设备、人和杂物没画进去；光线、角度、清晰度造成的轻微差别；刷子、刮条收起或放下的不同。定妆图里画了真实照片没拍到的面，写一句“背面为 AI 推测”之类的提醒。没有问题就是空数组。' : ''}
只输出 JSON：{"sides":["front","left"],"parts":[{"name":"轮子","count":"左侧2个（前1后1）","where":"车身下方"}],"size":"large","sizeNote":"","turning":""${sheet ? ',"sheetIssues":[]' : ''}}`;
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
  const system = `你是拍摄前的场地勘察。这张图是${fromCustomer ? '客户在真实现场拍的照片' : 'AI 画的拍摄场地'}，场所类型是「${sceneName}」。要在这里拍一台清洁设备作业：${inventory.sizeNote || inventory.size}；${inventory.turning || ''}。
根据门、台阶、灌木、货架、地砖等参照估算：
1. widthM：主要可作业路面的宽度（米，数字）。
2. floor：地面材质和新旧；dirt：地上平时会有的脏污（只写看得见或这种场所常见的，不夸张）。
3. zone：机器应该在画面里哪一块作业、朝哪个方向开（例如“沿画面中央主通道从近处向远处直行”）。
4. canTurn：这块地方能不能让这台机器转弯或掉头（true/false）。fits：机器放进来是否合理、不显得挤（true/false）。
5. dirtVisible：这张图里的地面上现在看不看得见脏污（true/false）。地面看起来像刚打扫过、干干净净的就是 false。
6. note：给导演的一句提醒（如“通道窄，只能直行，不要安排转弯”）。
只输出 JSON：{"widthM":3.5,"floor":"","dirt":"","zone":"","canTurn":false,"fits":true,"dirtVisible":true,"note":""}`;
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
  const lines = [`【产品分析师】真实照片拍到的面：${inv.sides.map((side) => SIDES[side]).join('、')}。${missing.length ? `没拍到：${missing.join('、')}——这些面视频模型只能瞎猜（会多画轮子、改结构），任何镜头都不能让它们出现在画面里；机器朝向和机位要保证画面里只露出拍到的面。` : ''}`,
    inv.parts.length ? `部件清单（照片能数清的）：${inv.parts.map((row) => `${row.name}${row.count ? ` ${row.count}` : ''}${row.where ? `（${row.where}）` : ''}`).join('；')}。画面里部件数量不能多也不能少。` : '',
    `体量：${({ large: '大型', medium: '中型', small: '小型' })[inv.size]}${inv.sizeNote ? `，${inv.sizeNote}` : ''}。${inv.turning}`];
  const site = crew.survey;
  if (site) lines.push(`【场景勘察】${crew.venuePhoto ? '客户现场照片' : '场地图'}：可作业路面约${site.widthM ?? '?'}米宽；地面${site.floor}；脏污${site.dirt}；作业区：${site.zone}。${site.canTurn ? '' : '这里机器不能转弯或掉头，每个镜头都只能直行。'}${site.fits ? '' : '机器放在这里偏挤，镜头要选最宽的一段，不要贴近两侧障碍。'}${site.dirtVisible ? '' : '这张图里地面偏干净：每个清洁镜头都要写明开拍时地上有哪些脏污，不然看不出清洁效果。'}${site.note}`);
  return lines.filter(Boolean).join('\n');
}

// ③ 风险审查: before any video is paid for, every shot is read against the two reports.
function riskRequest({ plan, crew, photos, sheet, plate }) {
  const images = [...photos, ...(sheet ? [sheet] : []), ...(plate ? [plate] : [])];
  const list = plan.shots.map((shot) => `第${shot.index + 1}镜（${shot.seconds}秒，${shot.place === 'venue' ? '在场地图里' : '在别处'}）：${shot.prompt}`).join('\n\n');
  const system = `你是视频开拍前的风险审查。视频生成模型会照着下面的提示词和参考图拍，它最容易在这些地方出错：
A. 镜头让机器露出真实照片没拍到的面（例如只有前侧照却从后方跟拍、绕到背后）——模型会编出不存在的轮子和结构；
B. 机器需要转弯、掉头、绕圈、倒车，或者开头机器朝向和镜头要求相反（例如参考照是车头朝向镜头，提示词却要从后方跟拍），模型会让它原地打转；
C. 场地放不下这台机器，或者要在窄处做大动作；
D. 提示词要求的部件数量、位置和部件清单不一致；
E. 清洁镜头里看不到清洁效果：机位让机器挡住了它身后的干净带（例如低机位正面迎着镜头开来、镜头结束前干净带始终不在画面里），或者提示词没写开拍时地上有脏污。
这些不是风险，不要报：拍到的面怎么拍都可以——有背面照时从后方跟随是好镜头，有侧面照时侧面平移最能看到干净带；直行中的轻微摆动；定妆图和照片的细小差别。不要因为“可能”就判风险，也不要把每个镜头都改成同一种机位，镜头要有变化。
参考图：前${photos.length}张是真实产品照${sheet ? '，下一张是定妆图' : ''}${plate ? '，最后一张是拍摄场地' : ''}。
${briefing(crew)}
逐镜判断。确实会踩上面 A–E 任一条才判 ok=false，并在 fix 里用一句话说怎么改，改法要保住这一镜的卖点、也让干净带看得见（如“改成固定在侧面略高处平移跟拍，机器从左向右直行，不拍车尾”）。拿不准算 ok。
只输出 JSON：{"shots":[{"index":1,"ok":true,"risk":"","fix":""}]}`;
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
  const work = '工作部件放下贴着地面作业，只有它经过的地方变干净、露出地面本色、颜色明显变亮，没经过的地方保持原样。';
  const camera = side
    ? '摄影机固定在场地一侧约1.8米高处、略向下俯视，和机器同速平移跟拍。机器从画面左侧沿一条直线匀速驶向右侧，全程只露出侧面，车头一直朝着行进方向，不转弯、不掉头、不倒车。机器身后留下一条笔直的干净带，和两侧没清洁的地面分界清楚，到最后一帧都留在画面里。'
    : front
      ? '摄影机固定在约2米高处、向下俯视约30°，不移动。机器从画面远处沿一条直线匀速朝镜头方向驶来，车头始终朝向镜头，在画面中下部之前结束，不转弯、不掉头、不倒车。俯视下能看到机器身后一条笔直的干净带从远处一直延伸到机器，和两侧没清洁的地面分界清楚。'
      : '摄影机在机器正后方约3米、略高处同速跟随，只拍到车尾，不绕到侧面和前面。机器沿一条直线匀速向前，不转弯、不掉头。镜头和机器之间是它刚留下的干净带，和两侧没清洁的地面分界清楚。';
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
