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
// Prompt wording is stored on the server; limits count the stored wording (promptLength), not the tokens.
const { promptRef, promptLength } = require("../shared/prompt-ref.cjs");

// real-3 (2026-11-27, 客户：选的卖点一个也没拍出来、想自己改动作和角度): every selling point must be filmed with a
// visible proof (no more "plain cleaning shot, let the caption say it"); each shot gets a keyframe the customer
// checks and may change (action, camera) before any video is paid for, and the video starts from that keyframe.
const VERSION = 'real-4';
// real-4 (2026-11-27, 用户：「贴近真实生活」「一眼假」「换个产品还适用吗」): a paid A/B on the user's own CC1 Pro footage showed
// a real place as the first frame plus one simple action is what looks real (an AI-drawn place and first+last frames
// morph instead of driving). So the place is one photo — the customer's, or a drawn one the customer accepts or redraws —
// every keyframe puts the machine into that same photo, and each shot is one physical action filmed like a phone in a hand.
// The camera moves paid trials proved (导演组 crew prompts) plus a low close-up of the working parts.
const CAMERAS = Object.freeze({
  side: { name: '侧面跟拍', prompt: () => promptRef('video.crew.camera_side') },
  top: { name: '俯拍迎面', prompt: () => promptRef('video.crew.camera_top') },
  follow: { name: '后方跟随', prompt: () => promptRef('video.crew.camera_follow') },
  close: { name: '特写', prompt: () => promptRef('video.realshoot.camera_close') }
});
// real-4: where the machine stands relative to a phone held at eye height (the photo's own viewpoint never changes).
const CAMERAS_V4 = Object.freeze({
  toward: { name: '迎面开来', prompt: () => promptRef('video.realshoot.v4.cam_toward') },
  side: { name: '侧面经过', prompt: () => promptRef('video.realshoot.v4.cam_side') },
  away: { name: '背面开走', prompt: () => promptRef('video.realshoot.v4.cam_away') },
  close: { name: '近处特写', prompt: () => promptRef('video.realshoot.v4.cam_close') }
});
const camerasOf = (plan) => plan?.realScene ? CAMERAS_V4 : CAMERAS;
const SCENE_REDRAWS = 2;
const ACTION_LENGTH = 40;
const DIRECTOR_MODEL = 'qwen3-vl-plus';
const DIRECTOR_ROUTE = '/bailian/compatible-mode/v1/chat/completions';
const PROMPT_LIMIT = 4500;
// 2026-11-23: up to five photos (front, sides, back, a close-up); with the 定妆照 and the scene that is 7 of Wan3's 9 references.
const MAX_PRODUCT_IMAGES = 5;
// 导演组 (real-shoot-crew.cjs): the product analyst, the site survey and the risk review before any video is paid for.
// crew-2 (2026-11-23 试拍反馈): no video while a shot is still at risk (two rewrites, then a safe shot), the
// cleaned strip must be seen, the customer's own place and site photo.
const CREW = 'crew-2';
const CREWS = new Set(['crew-1', CREW]);
const CUSTOM_LIMIT = 3, CUSTOM_LENGTH = 30, SCENE_LENGTH = 30;
const fail = (code, message) => Object.assign(new Error(message), { code });
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
// Text the customer reads on the storyboard: too long is cut at the last clause that fits, never mid-word
// (trial 2026-11-27: the director wrote 50–70 characters and the card showed "…污渍被").
function clip(value, limit) {
  const text = clean(value, 10000);
  if (text.length <= limit) return text;
  const head = text.slice(0, limit), cut = Math.max(...[...'，。；,;！!'].map((mark) => head.lastIndexOf(mark)));
  return (cut >= limit / 2 ? head.slice(0, cut) : head).replace(/[，。；、,;:：\s]+$/u, '');
}
const bare =(text) => String(text || '').replace(/\s+/gu, '');
const width = (text) => [...String(text)].reduce((sum, char) => sum + (char.codePointAt(0) <= 0x7f ? 0.5 : 1), 0);

// The look every shot shares (from real-shoot-director: plain venue light, documentary camera).
const STYLE = promptRef("video.realshoot.style");
const NEG = promptRef("video.realshoot.negative");
const PEOPLE = {
  none: promptRef("video.realshoot.operator_none"),
  walk: promptRef("video.realshoot.operator_walk"),
  ride: promptRef("video.realshoot.operator_ride")
};
// Words that made the video model paint brown dirty water out of nothing (第二、三轮付费试拍).
const LIQUID = /污水|脏水|积水|水渍|水痕|湿痕|水迹|喷水|洒水|吸水|水花|水流|泡沫/u;
// 2026-11-21 实拍 60 秒「强力去油污」：导演把油污写成「半透明黏稠状」一滩，视频模型画成液体，机器开过去
// 拖成一道油印（重拍一次仍一样）。Oil is written as old dark stains soaked into the floor, never as a liquid.
const OILY_LIQUID = /黏稠|粘稠|半透明|一滩|油洼|油坑|油池/u;
// Only a clause about oil or stains that says it is there counts (not 半透明门帘, not 「油斑不是黏稠的液体」).
const oilyWord = (text) => String(text).split(/[，。；,;]/u).map((clause) => clause.trim())
  .filter((clause) => /油|斑|渍|污/u.test(clause) && !NEGATED.test(clause) && !/不是|并非|而非/u.test(clause))
  .map((clause) => clause.match(OILY_LIQUID)?.[0]).find(Boolean) || '';
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
  return { scenes: SCENES.map(({ id, name }) => ({ id, name })), sceneLength: SCENE_LENGTH,
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
  // The place: picked from the list, or written by the customer (user 2026-11-23: 选的场景通常是通用的);
  // a photo of the real site makes every venue shot happen there instead of in a drawn one.
  const sceneIds = Array.isArray(input.sceneIds) ? input.sceneIds.filter(Boolean) : [];
  const sceneId = sceneIds.length === 1 ? sceneIds[0] : '';
  const sceneText = clean(input.sceneText, SCENE_LENGTH);
  const scene = SCENES.find((row) => row.id === sceneId);
  if (sceneIds.length > 1 || (sceneText && sceneIds.length)) throw fail('product_video_invalid_option', '使用场所选一个，或者自己写一个，不能同时。');
  if (!sceneText && (!scene || !catalog.SCENE_DETAIL[sceneId])) throw fail('product_video_invalid_option', '请选择一个使用场所，或者自己写一个。');
  const venuePhoto = typeof input.venueImageId === 'string' && input.venueImageId.length > 0;
  const pointIds = Array.isArray(input.pointIds) ? [...new Set(input.pointIds)] : [];
  const allowed = catalog.POINTS.filter((point) => !point.core);
  if (pointIds.some((id) => !allowed.some((point) => point.id === id))) throw fail('product_video_invalid_option', '有卖点无法识别，请重新勾选。');
  const custom = [...new Set((Array.isArray(input.customPoints) ? input.customPoints : []).map((text) => clean(text, CUSTOM_LENGTH)).filter(Boolean))];
  if (custom.length > CUSTOM_LIMIT) throw fail('product_video_invalid_option', `自己写的卖点最多${CUSTOM_LIMIT}条。`);
  if (pointIds.length + custom.length > catalog.POINT_LIMIT[seconds]) throw fail('product_video_invalid_option', `${seconds}秒最多${catalog.POINT_LIMIT[seconds]}个卖点。`);
  const extra = Array.isArray(input.extraImageIds) ? input.extraImageIds : [];
  if (extra.length > MAX_PRODUCT_IMAGES - 1) throw fail('product_video_invalid_input', `产品图最多${MAX_PRODUCT_IMAGES}张。`);

  const points = [...pointIds.map((id) => allowed.find((point) => point.id === id)),
    ...custom.map((text, i) => ({ id: `custom_${i}`, name: text, caption: width(text) <= catalog.CAPTION_WIDTH ? text : '', custom: true }))];
  if (!points.some((point) => point.cleaning) && points.length < catalog.POINT_LIMIT[seconds]) points.unshift(FILLER);
  // A filler never repeats a caption a selling point already has (captions compared without spaces).
  const used = new Set(points.map((point) => bare(point.caption)).filter(Boolean));
  const fillers = [...FILLERS.filter((row) => !used.has(bare(row.caption))), ...FILLERS];
  for (let i = 0; points.length < catalog.MIN_SHOTS[seconds]; i += 1) {
    const { caption, camera } = fillers[i % fillers.length];
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
    sourceResolution: '480p', outputSize: '1080x1920', imageModel: IMAGE_MODEL, storyboard: true, keyframes: shots.length,
    // real-4: one place photo for every shot; a drawn one is shown to the customer first (accept or redraw).
    realScene: true, sceneStep: !venuePhoto,
    // The 定妆照 and the scene picture: the director always sets at least one shot in the venue.
    // A site photo from the customer is the scene picture itself: nothing to draw.
    sheet: true, crew: CREW, imageCount: venuePhoto ? 1 : 2, productName, productImages: 1 + extra.length, scene: scene ? scene.name : sceneText, sceneIds: scene ? [scene.id] : [],
    ...(sceneText ? { sceneText } : {}), ...(venuePhoto ? { venuePhoto: true } : {}), pointIds, customPoints: custom,
    platePrompt: '', shots, evidenceStatus: 'user_selected_unverified', goal: '真实现场的设备作业演示',
    sendText: '这是按您这台设备做的现场作业演示。把您的场地情况发来，一起看看怎么用。',
    estimateNote: '定妆照、场景图和每镜一张分镜图按图片单价；视频按 Wan3 480P 有声每秒单价，各镜头同时生成；AI 导演看图写分镜按用量计费（几分钱）。'
  };
}

// How a selling point from the list is usually filmed — a hint the director may follow or improve on.
function pointHint(shot) {
  const point = catalog.POINTS.find((row) => row.id === shot.pointId);
  // Liquid words in a hint would be copied into the prompt; only the station shot keeps them.
  if (!point) return shot.custom ? '客户自己写的卖点：先想清楚画面里看到什么就能证明它，再按这个拍，不夸大' : '';
  // The catalog holds this hint ready-made (said: liquid sentences removed, the station shot keeps them): the action
  // wording is a server-stored prompt on a customer computer, so it cannot be split here.
  const said = point.said;
  return `${said}（参考机位：${shot.camera || point.camera}）`;
}

// The vision model's brief. images: data URLs of the product photos followed by the 定妆照.
function directorMessages({ plan, facts = '', images, feedback = '', crew = '' }) {
  const scene = SCENES.find((row) => row.id === plan.sceneIds[0]), detail = scene && catalog.SCENE_DETAIL[scene.id];
  const place = detail ? `「${scene.name}」：${detail.place}；${detail.light}；环境声：${detail.ambient}`
    : `${promptRef("video.realshoot.custom_scene.p1")}${plan.scene}${promptRef("video.realshoot.custom_scene.p2")}`;
  const photos = plan.productImages;
  const list = plan.shots.map((shot) => `第${shot.index + 1}镜｜${shot.seconds}秒｜${shot.filler || shot.pointId === 'clean' ? `清洁效果（地面由脏变干净${plan.shots.filter((row) => row.filler || row.pointId === 'clean').length > 1 ? '；几个清洁镜头换不同区域、不同机位和走向，不要拍成一样' : ''}）` : `卖点「${shot.title}」`}${shot.caption ? `｜默认字幕：${shot.caption}` : ''}${pointHint(shot) ? `｜常见拍法：${pointHint(shot)}` : ''}`).join('\n');
  const system = `${promptRef("video.realshoot.director.p1")}${photos}${promptRef("video.realshoot.director.p2")}${photos + 1}${promptRef("video.realshoot.director.p3")}${plan.venuePhoto ? promptRef("video.realshoot.venue_photo") : ''}${plan.realScene ? promptRef("video.realshoot.v4.director.p4") : promptRef("video.realshoot.director.p4", plan.storyboard ? 2 : 1)}${place}${plan.realScene ? promptRef("video.realshoot.v4.director.p5") : promptRef("video.realshoot.director.p5", plan.storyboard ? 2 : 1)}`;
  const user = [`产品名称：${plan.productName}`, `使用场所：${scene ? `${scene.name}（${scene.description}）` : `${plan.scene}（客户自己写的）`}`, facts ? `客户资料：${clean(facts, FACT_LIMIT)}` : '',
    crew ? `${promptRef("video.realshoot.crew_report.p1")}${crew}` : '',
    `分镜表（共${plan.shots.length}镜，时长不能改）：\n${list}`, feedback ? `上一次的结果不合格：${feedback}。请改正后重新输出完整 JSON。` : ''].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system },
    { role: 'user', content: [...images.map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: user }] }];
}

function directorRequest({ plan, facts, images, feedback, crew }) {
  return { model: DIRECTOR_MODEL, messages: directorMessages({ plan, facts, images, feedback, crew }), temperature: 0.6, max_tokens: 8000 };
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
    // real-4 writes no free prose for the video model: the prompt is assembled from camera, action and setup.
    if (!plan.realScene && prompt.length < 80) problems.push(`第${i + 1}镜提示词太短`);
    if (!wet && slot.pointId !== 'water' && LIQUID.test(prompt)) problems.push(`第${i + 1}镜提示词里写了「${prompt.match(LIQUID)[0]}」，不要写和水有关的词，只写看得见的结果`);
    if (oilyWord(prompt)) problems.push(`第${i + 1}镜提示词里写了「${oilyWord(prompt)}」，油污要写成渗进地面的发暗旧油斑，不写成液体`);
    if (!caption || width(caption) > catalog.CAPTION_WIDTH) problems.push(`第${i + 1}镜字幕「${caption}」超过10个汉字宽`);
    if (!plan.storyboard) return { title, caption, venue: row.venue !== false, prompt };
    // real-3: what the keyframe shows and the customer may change; a selling point needs a visible proof.
    const cameras = camerasOf(plan);
    const camera = Object.hasOwn(cameras, String(row.camera)) ? row.camera : '', action = reword(clip(row.action, ACTION_LENGTH)), proof = reword(clip(row.proof, 60));
    const unshowable = clip(row.unshowable, 60), setup = plan.realScene ? reword(clip(row.setup, 60)) : '';
    if (!camera) problems.push(`第${i + 1}镜 camera 只能是 ${Object.keys(cameras).join('、')}`);
    if (action.length < 6) problems.push(`第${i + 1}镜缺少 action（这一镜机器做什么动作）`);
    if (!slot.filler && slot.pointId !== 'clean' && proof.length < 6) problems.push(`第${i + 1}镜卖点「${slot.title}」缺少 proof：画面里看到什么就能证明它`);
    if (!wet && LIQUID.test(action)) problems.push(`第${i + 1}镜 action 里写了「${action.match(LIQUID)[0]}」，不要写和水有关的词`);
    if (!wet && LIQUID.test(setup)) problems.push(`第${i + 1}镜 setup 里写了「${setup.match(LIQUID)[0]}」，不要写和水有关的词`);
    return { title, caption, venue: row.venue !== false, prompt, camera, action, proof, unshowable, ...(plan.realScene ? { setup } : {}) };
  });
  if (!wet && LIQUID.test(plate)) problems.push(`plate 里写了「${plate.match(LIQUID)[0]}」`);
  for (const [field, text] of [['plate', plate], ['dirt', String(value.dirt || '')]]) if (oilyWord(text)) problems.push(`${field} 里写了「${oilyWord(text)}」，油污要写成渗进地面的发暗旧油斑`);
  if (out.length && !out.some((shot) => shot.venue)) problems.push('至少一镜 venue 为 true');
  out.forEach((shot, i) => { const first = out.findIndex((row) => bare(row.caption) === bare(shot.caption));
    if (first < i) problems.push(`第${i + 1}镜字幕「${shot.caption}」和第${first + 1}镜重复，每镜字幕要不同`); });
  if (problems.length) throw fail('product_video_direction_invalid', problems.slice(0, 6).join('；'));
  return { machine, operator, wet, floor: clean(value.floor, 200), dirt: clean(value.dirt, 300), plate, shots: out };
}

// real-3: the shot starts from its keyframe, the only picture Wan3 gets (a first frame cannot be combined with
// reference images), so the keyframe carries the machine's looks and the prompt says to keep them.
function cameraLine(shot, plan) { const cameras = camerasOf(plan); return Object.hasOwn(cameras, String(shot.camera)) ? `机位：${cameras[shot.camera].name}。${cameras[shot.camera].prompt()}` : ''; }
// real-4 video prompt: the keyframe, one physical action, the rules of a rigid machine and a phone in a hand. Nothing else.
function realScenePrompt(direction, shot) {
  return [promptRef("video.realshoot.first_frame"), `${cameraLine(shot, direction)}动作：${shot.action}。${shot.setup ? `现场：${shot.setup}。` : ''}`,
    promptRef("video.realshoot.v4.motion"), promptRef("video.realshoot.v4.real_look"),
    `${shot.seconds}${promptRef("video.realshoot.v4.tail")}${PEOPLE[direction.operator] || ''}${!direction.wet ? '地面上不凭空出现任何液体或水痕。' : ''}`,
    promptRef("video.realshoot.v4.negative")].join('\n');
}
function storyboardPrompt(direction, shot) {
  if (direction.realScene) return realScenePrompt(direction, shot);
  const tail = `【底线】${shot.seconds}${promptRef("video.realshoot.shot_tail.p1")}${PEOPLE[direction.operator]}${!direction.wet ? '地面上不凭空出现任何液体或水痕。' : ''}${promptRef("video.realshoot.shot_tail.p2")}${STYLE}
${NEG}`;
  const change = shot.edited ? `${promptRef("video.realshoot.customer_edit")}动作：${shot.action}。${cameraLine(shot)}` : '';
  return [promptRef("video.realshoot.first_frame"), shot.directorPrompt, change, tail].filter(Boolean).join('\n');
}
// The keyframe: drawn from the product photos, the 定妆照 and (venue shots) the scene picture, showing the start of
// the shot from its camera with the dirt and whatever proves the selling point.
function keyframePrompt(plan, shot) {
  const n = plan.productImages;
  if (plan.realScene) {
    // The place photo comes first (it is the picture being continued); then the product photos and the 定妆照.
    const base = shot.place === 'venue', offset = base ? 1 : 0;
    const photos = Array.from({ length: n }, (_, i) => `图${i + 1 + offset}`).join('、');
    const refs = `${photos}是这台机器${n > 1 ? '不同角度' : ''}的真实产品照片，图${n + 1 + offset}是它的四视角定妆图。`;
    const dirt = plan.dirt ? `地上平常的脏污：${plan.dirt}。` : '';
    return `${promptRef(base ? "video.realshoot.v4.keyframe.p1" : "video.realshoot.v4.keyframe.alone")}${refs}这台机器：${plan.machine || plan.productName}。${cameraLine(shot, plan)}这一镜的动作马上开始：${shot.action}。${shot.setup ? `本镜需要的道具和环境：${shot.setup}。` : ''}${base ? '' : dirt}${promptRef("video.realshoot.v4.keyframe.p2")}`;
  }
  const photos = n > 1 ? `${Array.from({ length: n }, (_, i) => `图${i + 1}`).join('、')}是这台机器不同角度的真实产品照片` : '图1是这台机器的真实产品照片';
  const refs = `参考图：${photos}，图${n + 1}是它的四视角定妆图${shot.place === 'venue' ? `，图${n + 2}是拍摄现场（陈设、地面和光线照它）` : ''}。`;
  const scene = [plan.surface ? `地面：${plan.surface}` : '', plan.dirt ? `脏污：${plan.dirt}` : ''].filter(Boolean).join('；');
  return `${promptRef("video.realshoot.keyframe.p1")}${refs}${promptRef("video.realshoot.keyframe.p2")}这台机器：${plan.machine || plan.productName}。${cameraLine(shot, plan)}动作：${shot.action}。${shot.proof ? `要证明：${shot.proof}。` : ''}${scene ? `${scene}。` : ''}
${STYLE}`;
}
// A customer's change to one shot on the storyboard: the action (one sentence), the camera and the caption.
// The video prompt keeps the director's description and adds the change as the rule that wins.
function editShot(plan, index, change) {
  const shot = plan.shots[index];
  if (!shot || !plan.storyboard) throw fail('product_video_invalid_input', '请刷新页面后重试。');
  const action = change.action === undefined ? shot.action : reword(clean(change.action, ACTION_LENGTH));
  const camera = change.camera === undefined ? shot.camera : change.camera;
  const caption = change.caption === undefined ? shot.caption : clean(change.caption, 30);
  if (action.length < 4) throw fail('product_video_invalid_input', '动作至少写几个字，说清楚机器在这一镜做什么。');
  if (!Object.hasOwn(camerasOf(plan), String(camera))) throw fail('product_video_invalid_input', '请选择一个机位。');
  if (!caption || width(caption) > catalog.CAPTION_WIDTH) throw fail('product_video_invalid_input', '字幕一行，最多10个汉字。');
  if (!plan.wet && LIQUID.test(action)) throw fail('product_video_invalid_input', `动作里不要写「${action.match(LIQUID)[0]}」，视频会凭空画出脏水；写看得见的结果，比如“地面变亮”。`);
  const redraw = action !== shot.action || camera !== shot.camera;
  // A redraw the customer asked for answers the "may not show" note; it is not shown again on the new picture.
  const next = { ...shot, action, camera, caption, edited: shot.edited || redraw, ...(redraw ? { unshowable: '' } : {}) };
  next.prompt = storyboardPrompt({ operator: plan.operator, wet: plan.wet, realScene: plan.realScene }, next);
  if (promptLength(next.prompt) > PROMPT_LIMIT) throw fail('product_video_invalid_input', '动作写得太长了，请精简。');
  return { plan: { ...plan, shots: plan.shots.map((row, i) => i === index ? next : row) }, redraw };
}
// The director's words plus what only the code knows: which attached picture is which, and the hard rules.
function shotPrompt(plan, direction, shot) {
  if (plan.storyboard) return storyboardPrompt({ ...direction, realScene: plan.realScene }, shot);
  const n = plan.productImages;
  const photos = n > 1 ? `${Array.from({ length: n }, (_, i) => `图${i + 1}`).join('、')}是这台机器不同角度的真实产品照片` : '图1是这台机器的真实产品照片';
  const sheet = `图${n + 1}`, plateRef = `图${n + 2}`;
  const refs = `【参考图】${photos}，${sheet}${promptRef("video.realshoot.shot_refs.p1")}${sheet}为准。${shot.venue ? `${plateRef}是拍摄现场：陈设、地面和光线以${plateRef}为准。` : ''}${promptRef("video.realshoot.shot_refs.p2")}${plan.hiddenSides ? `这台机器的${plan.hiddenSides}没有真实照片，画面里不能露出${plan.hiddenSides}。` : ''}${shot.venue ? `开拍时地面上要看得见本镜写的脏污，即使${plateRef}里的地面看起来较干净。` : ''}`;
  const tail = `【底线】${shot.seconds}${promptRef("video.realshoot.shot_tail.p1")}${PEOPLE[direction.operator]}${!direction.wet ? '地面上不凭空出现任何液体或水痕。' : ''}${promptRef("video.realshoot.shot_tail.p2")}${STYLE}
${NEG}`;
  return `${refs}\n${shot.prompt}\n${tail}`;
}
function platePrompt(plan, direction) {
  if (plan.realScene) return `${promptRef("video.realshoot.v4.scene_plate.p1")}${direction.plate}${promptRef("video.realshoot.v4.scene_plate.p2")}${direction.floor}${promptRef("video.realshoot.v4.scene_plate.p3")}${direction.dirt}${promptRef("video.realshoot.v4.scene_plate.p4")}`;
  return `${promptRef("video.realshoot.scene_plate.p1")}${direction.plate}
地面：${direction.floor}${promptRef("video.realshoot.scene_plate.p2")}${direction.dirt}${promptRef("video.realshoot.scene_plate.p3")}${STYLE}${promptRef("video.realshoot.scene_plate.p4")}`;
}
// The plan with the director's decisions in it; nothing is paid for until this succeeds.
function applyDirection(plan, direction) {
  const shots = plan.shots.map((slot, i) => {
    const decided = direction.shots[i];
    const shot = { ...slot, title: decided.title, caption: decided.caption, place: decided.venue ? 'venue' : 'other',
      ...(plan.storyboard ? { camera: decided.camera, action: decided.action, proof: decided.proof, unshowable: decided.unshowable, directorPrompt: decided.prompt, edited: false,
        ...(plan.realScene ? { setup: decided.setup || '' } : {}) } : {}) };
    shot.prompt = shotPrompt(plan, direction, plan.storyboard ? shot : decided && { ...decided, seconds: slot.seconds });
    if (promptLength(shot.prompt) > PROMPT_LIMIT) throw fail('product_video_direction_invalid', `第${i + 1}镜提示词太长`);
    return shot;
  });
  return { ...plan, directed: true, machine: direction.machine, operator: direction.operator, wet: direction.wet, surface: direction.floor, dirt: direction.dirt,
    platePrompt: platePrompt(plan, direction), imageCount: shots.some((shot) => shot.place === 'venue') && !plan.venuePhoto ? 2 : 1, shots };
}

// AI 检查 (user 2026-11-19: check only, never redo on its own): the vision model looks at four frames of
// every finished shot next to the product photos and says which shot has a visible problem. The
// customer decides whether to spend on redoing that one shot.
function reviewRequest({ plan, images, sheets, crew = '' }) {
  const list = plan.shots.map((shot) => `第${shot.index + 1}镜「${shot.title}」`).join('\n');
  const system = `${promptRef("video.realshoot.qc.p1")}${images.length}${promptRef("video.realshoot.qc.p2")}${plan.operator === 'none' ? '画面里出现人、人手，或有人坐在机器上' : '画面里的人露脸，或人和机器融在一起'}${promptRef("video.realshoot.qc.p3")}${plan.wet ? '（这台是冲洗设备，干净的清水除外）' : ''}${promptRef("video.realshoot.qc.p4", plan.storyboard ? 2 : 1)}${crew ? `${promptRef("video.realshoot.qc_parts.p1")}${crew}
` : ''}${promptRef("video.realshoot.qc.p5", plan.storyboard ? 2 : 1)}`;
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
    return { index: shot.index, ok, issue: ok ? '' : issue || '这一镜可能有问题，建议看一下', ...(plan.storyboard && !ok && row.extra === true ? { extra: true } : {}) };
  });
}

module.exports = { CAMERAS, CAMERAS_V4, camerasOf, SCENE_REDRAWS, ACTION_LENGTH, keyframePrompt, editShot, CREW, CREWS, SCENE_LENGTH, reviewRequest, parseReview, VERSION, DIRECTOR_MODEL, DIRECTOR_ROUTE, PROMPT_LIMIT, MAX_PRODUCT_IMAGES, CUSTOM_LIMIT, CUSTOM_LENGTH, LIQUID,
  choices, planDirected, directorMessages, directorRequest, parseDirection, applyDirection, shotPrompt, platePrompt, width, reword };
