// 场景效果视频 · AI 导演 (2026-11-19, "less structure, more intelligence"): the customer gives the product
// photos, its name, the kind of place and the selling points (picked or written); a vision model looks at
// the photos and the confirmed 定妆照 and decides everything else — what the machine is and how it moves,
// the floor and dirt of that place, every shot and its prompt. The code keeps only what it knows for
// certain (shot lengths, which picture is which, subtitles on one line) and the few rules paid trials
// proved (场景效果视频试验/27–31): one continuous shot with one camera move, only one machine, the
// photo's parts unchanged, no invented liquid, nothing the customer did not claim.
const catalog = require('./scene-video-catalog.cjs');
const { SCENES, FACT_LIMIT } = require('./video-directors.cjs');
const { DIRECT_MODEL } = require('./bailian-video-provider.cjs');
const { IMAGE_MODEL } = require('./story-video-director.cjs');
const { FILLERS } = require('./real-shoot-director.cjs');

const VERSION = 'real-2';
const DIRECTOR_MODEL = 'qwen3-vl-plus';
const DIRECTOR_ROUTE = '/bailian/compatible-mode/v1/chat/completions';
const PROMPT_LIMIT = 4500;
const MAX_PRODUCT_IMAGES = 3;
const CUSTOM_LIMIT = 3, CUSTOM_LENGTH = 30;
const fail = (code, message) => Object.assign(new Error(message), { code });
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
const width = (text) => [...String(text)].reduce((sum, char) => sum + (char.codePointAt(0) <= 0x7f ? 0.5 : 1), 0);

// The look every shot shares (from real-shoot-director: plain venue light, documentary camera).
const STYLE = '成像：真实现场实拍，像专业摄影师用全画幅摄影机加35毫米定焦镜头在现场拍的设备演示素材。只用场地本来的照明，光线平淡自然，不额外打光。颜色中性克制、不鲜艳，画质细腻，只有极轻微的噪点。画面稳，但有很轻的手持呼吸感。';
const NEG = '不要广告感，不要夸张调色，不要柔光滤镜，不要光柱和光晕，不要雾气，不要慢动作，不要静帧，不要镜面地板和清晰倒影，不要塑料感和渲染感，不要成堆垃圾，不要字幕、文字、水印和商标，不要第二台机器。';
const PEOPLE = {
  none: '画面里没有任何人：没有人坐上去、驾驶、推它或用手操作它，它自己移动、自己工作。不要出现任何人、人影或人手。',
  walk: '只拍到操作员的手、手臂和下半身（深色工装裤、劳保鞋），始终不露脸、不说话，身体在机器后方，和机身不重叠、不融在一起；画面里没有其他人。',
  ride: '操作员坐在驾驶位上，镜头只拍到肩部以下，始终不露脸、不说话，从头到尾不上下车，身体和机身不重叠、不融在一起；画面里没有其他人。'
};
// Words that made the video model paint brown dirty water out of nothing (第二、三轮付费试拍).
const LIQUID = /污水|脏水|积水|水渍|水痕|水迹|喷水|洒水|吸水|水花|水流|泡沫/u;
// 2026-11-21 实拍 60 秒「强力去油污」：导演把油污写成「半透明黏稠状」一滩，视频模型画成液体，机器开过去
// 拖成一道油印（重拍一次仍一样）。Oil is written as old dark stains soaked into the floor, never as a liquid.
const OILY_LIQUID = /黏稠|粘稠|半透明|一滩|油洼|油坑|油池/u;
// Part names and "no water marks" are what a director naturally writes; they are reworded rather than
// sent back, so only a real description of liquid on the floor makes it write the shot again.
const REWORD = [[/吸水扒|吸水胶条|刮水胶条|刮水条|刮水板|刮水器/gu, '后部刮条'], [/水箱/gu, '箱体']];
// In a clause that says what is NOT there ("无任何水渍、湿痕或反光"), the items about liquid are dropped;
// every shot's closing rule already says no liquid appears.
const NEGATED = /^(?:[^，。；、]{0,6}?(无|没有|不要|避免|严禁|禁止)|(不))(?:任何)?/u;
const NOT_LIQUID = /水泥|水磨石|水平|上下水|水箱/gu;
const WET_ITEM = { test: (text) => /水|湿|泡沫/u.test(String(text).replace(NOT_LIQUID, '')) };
function reword(text) {
  const renamed = REWORD.reduce((value, [pattern, to]) => value.replace(pattern, to), String(text));
  return renamed.replace(/[^，。；,;]+[，。；,;]?/gu, (segment) => {
    const body = segment.replace(/[，。；,;]$/u, ''), end = segment.slice(body.length);
    const negation = body.trim().match(NEGATED);
    if (!negation || !WET_ITEM.test(body)) return segment;
    const kept = body.trim().split(/、|或|和|与|及/u).filter((item) => !WET_ITEM.test(item));
    if (!kept.length) return '';
    return `${NEGATED.test(kept[0]) ? '' : negation[0].replace(/任何$/u, '')}${kept.join('、')}${end}`;
  }).replace(/^[，；]/u, '');
}
// Extra cleaning shots when few points were picked; the director decides how each is filmed.
// 2026-11-21 实拍 45 秒：两个补位清洁镜头字幕一样（「走过的地方 干干净净」连放两遍），显得廉价。
// Like the fixed planner, each extra cleaning shot takes its own caption and camera from FILLERS.
const FILLER = { id: 'clean', name: '清洁效果', caption: '走过的地方 干干净净', cleaning: true };

// What the customer can tick: every selling point, whatever the machine (the customer knows what it can do).
function choices() {
  return { scenes: SCENES.map(({ id, name }) => ({ id, name })),
    points: catalog.POINTS.filter((point) => !point.core).map(({ id, name, caption, cleaning }) => ({ id, name, caption, cleaning: Boolean(cleaning) })),
    durations: catalog.DURATIONS, pointLimit: catalog.POINT_LIMIT, minShots: catalog.MIN_SHOTS, customLimit: CUSTOM_LIMIT, customLength: CUSTOM_LENGTH };
}

const spread = (total, count) => Array.from({ length: count }, (_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0));
// The shot list is fixed before anything is paid for, so the price and the time estimate hold:
// one shot per selling point, a cleaning shot first when none was picked and there is room, then
// extra cleaning shots up to the minimum so no shot is long enough for the model to cut it itself.
function planDirected(input) {
  const seconds = Number(input.durationSeconds);
  if (input.mode !== 'product' || !catalog.DURATIONS.includes(seconds)) throw fail('product_video_invalid_option', '请选择15、30、45或60秒时长。');
  if (String(input.facts || '').trim().length > FACT_LIMIT) throw fail('product_video_invalid_input', `产品资料最多${FACT_LIMIT}字，请精简后重试。`);
  const productName = clean(input.productName, 80);
  if (!productName) throw fail('product_video_invalid_input', '请填写产品名称，AI 导演要知道它是什么设备。');
  const sceneId = Array.isArray(input.sceneIds) && input.sceneIds.length === 1 ? input.sceneIds[0] : '';
  const scene = SCENES.find((row) => row.id === sceneId);
  if (!scene || !catalog.SCENE_DETAIL[sceneId]) throw fail('product_video_invalid_option', '请选择一个使用场所。');
  const pointIds = Array.isArray(input.pointIds) ? [...new Set(input.pointIds)] : [];
  const allowed = catalog.POINTS.filter((point) => !point.core);
  if (pointIds.some((id) => !allowed.some((point) => point.id === id))) throw fail('product_video_invalid_option', '有卖点无法识别，请重新勾选。');
  const custom = (Array.isArray(input.customPoints) ? input.customPoints : []).map((text) => clean(text, CUSTOM_LENGTH)).filter(Boolean);
  if (custom.length > CUSTOM_LIMIT) throw fail('product_video_invalid_option', `自己写的卖点最多${CUSTOM_LIMIT}条。`);
  if (pointIds.length + custom.length > catalog.POINT_LIMIT[seconds]) throw fail('product_video_invalid_option', `${seconds}秒最多${catalog.POINT_LIMIT[seconds]}个卖点。`);
  const extra = Array.isArray(input.extraImageIds) ? input.extraImageIds : [];
  if (extra.length > MAX_PRODUCT_IMAGES - 1) throw fail('product_video_invalid_input', `产品图最多${MAX_PRODUCT_IMAGES}张。`);

  const points = [...pointIds.map((id) => allowed.find((point) => point.id === id)),
    ...custom.map((text, i) => ({ id: `custom_${i}`, name: text, caption: width(text) <= catalog.CAPTION_WIDTH ? text : '', custom: true }))];
  if (!points.some((point) => point.cleaning) && points.length < catalog.POINT_LIMIT[seconds]) points.unshift(FILLER);
  for (let i = 0; points.length < catalog.MIN_SHOTS[seconds]; i += 1) {
    const { caption, camera } = FILLERS[i % FILLERS.length];
    points.push({ ...FILLER, caption, camera, filler: true });
  }
  const lengths = spread(seconds, points.length);
  let cursor = 0;
  const shots = points.map((point, index) => {
    const shot = { index, seconds: lengths[index], startSecond: cursor, endSecond: cursor + lengths[index], pointId: point.id, title: point.name,
      caption: point.caption || '', narration: '', place: 'venue', cleaning: Boolean(point.cleaning), custom: Boolean(point.custom), filler: Boolean(point.filler), prompt: '',
      ...(point.filler ? { camera: point.camera } : {}) };
    cursor += shot.seconds; return shot;
  });
  return {
    version: VERSION, pipelineVersion: 6, director: 'ai', directorModel: DIRECTOR_MODEL, videoProvider: 'bailian', videoModel: DIRECT_MODEL, videoAudio: true,
    sourceResolution: '480p', outputSize: '1080x1920', imageModel: IMAGE_MODEL,
    // The 定妆照 and the scene picture: the director always sets at least one shot in the venue.
    sheet: true, imageCount: 2, productName, productImages: 1 + extra.length, scene: scene.name, sceneIds: [scene.id], pointIds, customPoints: custom,
    platePrompt: '', shots, evidenceStatus: 'user_selected_unverified', goal: '真实现场的设备作业演示',
    sendText: '这是按您这台设备做的现场作业演示。把您的场地情况发来，一起看看怎么用。',
    estimateNote: '一张场景图按图片单价；视频按 Wan3 480P 有声每秒单价，各镜头同时生成；AI 导演看图写分镜按用量计费（几分钱）。'
  };
}

// How a selling point from the list is usually filmed — a hint the director may follow or improve on.
function pointHint(shot) {
  const point = catalog.POINTS.find((row) => row.id === shot.pointId);
  // Liquid words in a hint would be copied into the prompt; only the station shot keeps them.
  if (!point) return shot.custom ? '客户自己写的卖点，按字面意思拍出看得见的证明，不夸大' : '';
  const action = point.action.replace('{work}', '机器正常作业');
  const said = point.id === 'water' ? action : action.split(/(?<=[，。；])/u).filter((part) => !LIQUID.test(part)).join('');
  return `${said}（参考机位：${shot.camera || point.camera}）`;
}

// The vision model's brief. images: data URLs of the product photos followed by the 定妆照.
function directorMessages({ plan, facts = '', images, feedback = '' }) {
  const detail = catalog.SCENE_DETAIL[plan.sceneIds[0]], scene = SCENES.find((row) => row.id === plan.sceneIds[0]);
  const photos = plan.productImages;
  const list = plan.shots.map((shot) => `第${shot.index + 1}镜｜${shot.seconds}秒｜${shot.filler || shot.pointId === 'clean' ? `清洁效果（地面由脏变干净${plan.shots.filter((row) => row.filler || row.pointId === 'clean').length > 1 ? '；几个清洁镜头换不同区域、不同机位和走向，不要拍成一样' : ''}）` : `卖点「${shot.title}」`}${shot.caption ? `｜默认字幕：${shot.caption}` : ''}${pointHint(shot) ? `｜常见拍法：${pointHint(shot)}` : ''}`).join('\n');
  const system = `你是商用清洁设备的实拍导演，同时负责给视频生成模型写提示词。客户没有设备也没有场地，要靠你写的提示词，让模型拍出像在真实现场实拍、看不出是 AI 的设备作业视频。
先认真看图：前${photos}张是这台机器的真实产品照片，最后一张是根据照片画的四视角定妆图（前侧、正侧、背后、工作部件近景）。判断它是什么设备、怎么移动（自主行驶的机器人 / 人推着走 / 人坐着开）、工作部件在哪、怎样清洁地面。产品名称里有“机器人”，或客户的卖点是自动避障、自动回充、乘电梯、夜间无人作业这类自主功能时，它就是自己行驶的机器人（operator 为 none），即使照片上有座椅或方向盘，座位上也没有人。
然后为每一镜写一段给视频模型的中文提示词。下面是付费试拍验证过的经验，必须遵守：
1. 每镜是一个连续镜头，一镜到底，不剪辑不转场；摄影机全程只做一件事（固定不动、或同速平移跟拍、或在后方跟随，三选一），不推拉摇移组合。
2. 全片只有这一台机器，外观完全照照片和定妆图；照片里有的部件保留，没有的不加。照片里有座椅或方向盘但你判断是无人驾驶机器人时，座位上没有人。产品照片多是展示时拍的，刷子、刷盘、后部刮条常常收起悬空；作业时要写成放下的样子：刷子压在地面上转，后部刮条整条落地、胶条贴着地面略微压弯向后拖，和地面之间不留缝，这不算改外观。
3. 机器只朝机头方向前进，不倒着走。清洁镜头：开始时地面上的脏污要清楚可见，只有工作部件真正经过的地方才变干净，露出同一块旧地面的本色，机器前方和两侧没经过的地方保持原样作对照，干净的地方到最后一帧都保持干净。干净程度要像真实作业一遍：浮灰、碎屑和表面的脏污被带走，地面颜色明显变亮；旧地面本身的划痕、磨损和多年的老印子只是变淡，不会变成崭新的地面。带后部刮条的洗地设备，刮过的地面干净并带着柔和的光泽，能淡淡映出顶灯的光，但不是镜面、没有清晰倒影；不带刮条的扫地设备只写变干净，不写光泽。
4. 不要在提示词里写“水、污水、积水、水渍、喷水、泡沫”这类词（视频模型会凭空画出脏水），只写看得见的结果，比如“地面露出本色、颜色变亮”。只有冲洗类设备（如高压清洗机）例外，并把 wet 设为 true。油污也一样：写成渗进地面、颜色发暗的旧油斑和拖开的油印，不写黏稠、半透明、一滩这类像液体的词，否则会被画成一滩油、被机器拖开。
5. 画面要真实：场地原本的照明、纪实摄影机位、日常的脏污量（不是成堆垃圾），没有字幕、文字、商标。具体描述地面材质、脏污的样子、机器的动作速度和摄影机位置，写清楚但不堆形容词。
6. 只拍客户给的卖点，不添加客户没说的功能，不编数字。
7. 场景要符合「${scene.name}」：${detail.place}；${detail.light}；环境声：${detail.ambient}。场地的大小要配得上机器：大型设备（乘驾式、带座椅或方向盘、机身比人宽的）放在宽阔开敞的大片区域作业，比如宽主通道、车间空地、大堂中间，四周留足空间，不挤在窄过道和货架缝里，plate 也照这个写。地面材质和脏污由你根据这个场所和这台机器判断（例如工厂常见环氧地坪上的油污、铁屑，纺织车间的线头，写字楼的大理石和泥脚印）。
8. 字幕每镜一行，最多10个汉字宽（英文和数字算半个），说卖点本身，不夸大；各镜字幕互不相同。
只输出一个 JSON 对象，不要任何其他文字：
{"machine":"一句话：这是什么设备、怎么移动、工作部件在哪、有没有后部刮条","operator":"none 或 walk 或 ride","wet":false,"floor":"地面材质和旧化程度","dirt":"地上有什么脏东西、什么样子","plate":"这个场所的空场景照片描述：地点、陈设、地面、脏污、光线，不含机器和人","shots":[{"title":"不超过8字","caption":"一行字幕","venue":true,"prompt":"这一镜给视频模型的提示词，300到900字"}]}
venue：镜头发生在场所主区域时为 true（会附上场景照片保持一致）；在电梯厅、门口、充电桩、工作站旁等别处时为 false。至少一镜为 true。shots 数量和顺序必须与分镜表完全一致。`;
  const user = [`产品名称：${plan.productName}`, `使用场所：${scene.name}（${scene.description}）`, facts ? `客户资料：${clean(facts, FACT_LIMIT)}` : '',
    `分镜表（共${plan.shots.length}镜，时长不能改）：\n${list}`, feedback ? `上一次的结果不合格：${feedback}。请改正后重新输出完整 JSON。` : ''].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system },
    { role: 'user', content: [...images.map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: user }] }];
}

function directorRequest({ plan, facts, images, feedback }) {
  return { model: DIRECTOR_MODEL, messages: directorMessages({ plan, facts, images, feedback }), temperature: 0.6, max_tokens: 8000 };
}

function jsonOf(content) {
  const text = String(content || '').replace(/```(?:json)?/giu, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw fail('product_video_direction_invalid', '没有输出 JSON');
  try { return JSON.parse(text.slice(start, end + 1)); } catch { throw fail('product_video_direction_invalid', 'JSON 格式不完整'); }
}
// Checks the director's answer; every problem is said in words so the next attempt can fix it.
function parseDirection(content, plan) {
  const value = jsonOf(content);
  const problems = [];
  const operator = ['none', 'walk', 'ride'].includes(value.operator) ? value.operator : '';
  if (!operator) problems.push('operator 只能是 none、walk 或 ride');
  const wet = value.wet === true;
  const machine = reword(clean(value.machine, 200)), plate = reword(clean(value.plate, 800));
  if (!machine) problems.push('缺少 machine');
  if (plate.length < 20) problems.push('plate 场景描述太短');
  const shots = Array.isArray(value.shots) ? value.shots : [];
  if (shots.length !== plan.shots.length) problems.push(`shots 必须正好 ${plan.shots.length} 镜，现在是 ${shots.length} 镜`);
  const out = plan.shots.map((slot, i) => {
    const row = shots[i] || {};
    const prompt = reword(clean(row.prompt, 2000)), caption = clean(row.caption, 30) || slot.caption, title = clean(row.title, 16) || slot.title;
    if (prompt.length < 80) problems.push(`第${i + 1}镜提示词太短`);
    if (!wet && slot.pointId !== 'water' && LIQUID.test(prompt)) problems.push(`第${i + 1}镜提示词里写了「${prompt.match(LIQUID)[0]}」，不要写和水有关的词，只写看得见的结果`);
    if (OILY_LIQUID.test(prompt)) problems.push(`第${i + 1}镜提示词里写了「${prompt.match(OILY_LIQUID)[0]}」，油污要写成渗进地面的发暗旧油斑，不写成液体`);
    if (!caption || width(caption) > catalog.CAPTION_WIDTH) problems.push(`第${i + 1}镜字幕「${caption}」超过10个汉字宽`);
    return { title, caption, venue: row.venue !== false, prompt };
  });
  if (!wet && LIQUID.test(plate)) problems.push(`plate 里写了「${plate.match(LIQUID)[0]}」`);
  for (const [field, text] of [['plate', plate], ['dirt', String(value.dirt || '')]]) if (OILY_LIQUID.test(text)) problems.push(`${field} 里写了「${text.match(OILY_LIQUID)[0]}」，油污要写成渗进地面的发暗旧油斑`);
  if (out.length && !out.some((shot) => shot.venue)) problems.push('至少一镜 venue 为 true');
  out.forEach((shot, i) => { const first = out.findIndex((row) => row.caption === shot.caption);
    if (first < i) problems.push(`第${i + 1}镜字幕「${shot.caption}」和第${first + 1}镜重复，每镜字幕要不同`); });
  if (problems.length) throw fail('product_video_direction_invalid', problems.slice(0, 6).join('；'));
  return { machine, operator, wet, floor: clean(value.floor, 200), dirt: clean(value.dirt, 300), plate, shots: out };
}

// The director's words plus what only the code knows: which attached picture is which, and the hard rules.
function shotPrompt(plan, direction, shot) {
  const n = plan.productImages;
  const photos = n > 1 ? `${Array.from({ length: n }, (_, i) => `图${i + 1}`).join('、')}是这台机器不同角度的真实产品照片` : '图1是这台机器的真实产品照片';
  const sheet = `图${n + 1}`, plateRef = `图${n + 2}`;
  const refs = `【参考图】${photos}，${sheet}是同一台机器的四视角定妆图，照片里看不到的面以${sheet}为准。${shot.venue ? `${plateRef}是拍摄现场：陈设、地面和光线以${plateRef}为准。` : ''}全片只有这一台机器，不复制、不分身；造型、比例、配色、零件和机身字样严格照照片，不新增零件，不变成其他型号。`;
  const tail = `【底线】${shot.seconds}秒竖屏9:16，单个连续镜头，一镜到底，无剪辑、无切镜、无转场。机器只朝机头方向前进，不倒着走，不原地打转。${PEOPLE[direction.operator]}${!direction.wet ? '地面上不凭空出现任何液体或水痕。' : ''}声音只有机器运转声和现场环境声，无人声、无旁白、无音乐。
${STYLE}
${NEG}`;
  return `${refs}\n${shot.prompt}\n${tail}`;
}
function platePrompt(plan, direction) {
  return `一张真实现场照片，竖版9:16。${direction.plate}
空无一人，没有任何机器设备。平视略低的机位，镜头朝场地深处，全画面清晰。
${STYLE}
不要电影感，不要广告感，不要镜面地板，不要清晰倒影，不要过饱和，不要渲染感，无人物，无文字，无商标招牌，无水印。`;
}
// The plan with the director's decisions in it; nothing is paid for until this succeeds.
function applyDirection(plan, direction) {
  const shots = plan.shots.map((slot, i) => {
    const decided = direction.shots[i];
    const shot = { ...slot, title: decided.title, caption: decided.caption, place: decided.venue ? 'venue' : 'other' };
    shot.prompt = shotPrompt(plan, direction, decided && { ...decided, seconds: slot.seconds });
    if ([...shot.prompt].length > PROMPT_LIMIT) throw fail('product_video_direction_invalid', `第${i + 1}镜提示词太长`);
    return shot;
  });
  return { ...plan, directed: true, machine: direction.machine, operator: direction.operator, wet: direction.wet, surface: direction.floor, dirt: direction.dirt,
    platePrompt: platePrompt(plan, direction), imageCount: shots.some((shot) => shot.place === 'venue') ? 2 : 1, shots };
}

// AI 检查 (user 2026-11-19: check only, never redo on its own): the vision model looks at four frames of
// every finished shot next to the product photos and says which shot has a visible problem. The
// customer decides whether to spend on redoing that one shot.
function reviewRequest({ plan, images, sheets }) {
  const list = plan.shots.map((shot) => `第${shot.index + 1}镜「${shot.title}」`).join('\n');
  const system = `你是视频质检员。前${images.length}张图是一台清洁设备的产品照片和定妆图；后面每张图对应成片里的一个镜头：从左到右是这个镜头先后6个时刻的画面，格与格之间用白色竖条隔开，各格之间是时间先后，同一台机器在不同格里位置、角度不同是正常移动，不是分身。
只检查单看某一格就能确定的问题：
1. 同一格画面里同时出现两台机器；
2. 机器外形、颜色、部件和产品照片明显不是同一款；
3. ${plan.operator === 'none' ? '画面里出现人、人手，或有人坐在机器上' : '画面里的人露脸，或人和机器融在一起'}；
4. 地上出现明显的积水、污水或泡沫${plan.wet ? '（这台是冲洗设备，干净的清水除外）' : ''}；
5. 画面里出现字幕、大段文字或水印；
6. 机器在地上走着作业，后部刮条或刷子却明显悬空、离开地面。
清洁效果好不好、动作是否连贯这类单看几格判断不准的，不要报。拿不准就算合格（ok 为 true）。
只输出 JSON：{"shots":[{"index":1,"ok":true,"issue":""}]}，issue 用一句不超过30字的中文说清楚在第几格看到了什么。`;
  return { model: DIRECTOR_MODEL, temperature: 0.2, max_tokens: 1500, messages: [{ role: 'system', content: system },
    { role: 'user', content: [...[...images, ...sheets].map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: `镜头列表：\n${list}` }] }] };
}
function parseReview(content, plan) {
  const value = jsonOf(content);
  const rows = Array.isArray(value.shots) ? value.shots : [];
  return plan.shots.map((shot) => {
    const row = rows.find((item) => Number(item?.index) === shot.index + 1) || {};
    const issue = clean(row.issue, 60);
    const ok = row.ok !== false;
    return { index: shot.index, ok, issue: ok ? '' : issue || '这一镜可能有问题，建议看一下' };
  });
}

module.exports = { reviewRequest, parseReview, VERSION, DIRECTOR_MODEL, DIRECTOR_ROUTE, PROMPT_LIMIT, MAX_PRODUCT_IMAGES, CUSTOM_LIMIT, CUSTOM_LENGTH, LIQUID,
  choices, planDirected, directorMessages, directorRequest, parseDirection, applyDirection, shotPrompt, platePrompt, width, reword };
