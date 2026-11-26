// 场景效果视频 · 无人实拍 (pipeline 6): the customer picks the device, scene, floor, dirt and selling
// points; each selling point becomes one continuous Wan3 shot with the machine's own sound. One empty
// scene picture keeps the venue the same across shots. No story, no people to cast, no storyboard.
// Realism rules come from 场景效果视频试验/27–28: plain venue light, documentary camera, the camera
// does one thing per shot (two camera moves made the model cut at 8.3 s), and cleaning only happens
// where the working parts have passed and stays clean to the last frame.
// Prompt wording is stored on the server; limits count the stored wording (promptLength), not the tokens.
const { promptRef, promptLength } = require("../shared/prompt-ref.cjs");
const { DIRECT_MODEL } = require('./bailian-video-provider.cjs');
const { SCENES, FACT_LIMIT } = require('./video-directors.cjs');
const catalog = require('./scene-video-catalog.cjs');
const { IMAGE_MODEL } = require('./story-video-director.cjs');

const REAL_VERSION = 'real-1';
const PROMPT_LIMIT = 4500;
const MAX_PRODUCT_IMAGES = 3;
const fail = (code, message) => Object.assign(new Error(message), { code });
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);

const STYLE = promptRef("video.realshoot_plan.style");
const NEG = promptRef("video.realshoot_plan.negative");
const PEOPLE = {
  none: { rule: promptRef("video.realshoot_plan.operator_none"), neg: '不要出现任何人、人影或人手，不要给机器新增产品照片里没有的部件。' },
  walk: { rule: promptRef("video.realshoot_plan.operator_walk"), neg: '不要露出操作员的脸，不要出现其他人，人和机器不重叠、不融在一起。' },
  ride: { rule: promptRef("video.realshoot_plan.operator_ride"), neg: promptRef("video.realshoot_plan.operator_ride_negative") }
};

function pick(rows, id, label) {
  const row = rows.find((item) => item.id === id);
  if (!row) throw fail('product_video_invalid_option', `请选择有效的${label}。`);
  return row;
}
const spread = (total, count) => Array.from({ length: count }, (_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0));
// Extra cleaning shots when few points were picked: different cameras, still one move each.
const FILLERS = [
  { camera: promptRef("video.realshoot_plan.camera_low"), caption: '一趟过去 地面见本色', fixed: false },
  { camera: promptRef("video.realshoot_plan.camera_behind"), caption: '边走边清 身后就干净', fixed: false },
  { camera: promptRef("video.realshoot_plan.camera_front"), caption: '日常保洁 交给它', fixed: true },
  { camera: '场地边上略高的固定远景机位，看到机器在整片场地里沿直线作业', caption: '整片场地 一遍搞定', fixed: true },
  { camera: promptRef("video.realshoot_plan.camera_side"), caption: '贴地清洁 细节看得见', fixed: false }
];

function planRealShoot(input) {
  const seconds = Number(input.durationSeconds);
  if (input.mode !== 'product' || !catalog.DURATIONS.includes(seconds)) throw fail('product_video_invalid_option', '请选择15、30、45或60秒时长。');
  if (String(input.facts || '').trim().length > FACT_LIMIT) throw fail('product_video_invalid_input', `产品资料最多${FACT_LIMIT}字，请精简后重试。`);
  const device = pick(catalog.DEVICES, input.deviceId, '设备类型');
  const sceneId = Array.isArray(input.sceneIds) && input.sceneIds.length === 1 ? input.sceneIds[0] : '';
  if (!device.scenes.includes(sceneId)) throw fail('product_video_invalid_option', `请为${device.name}选择一个适用场景。`);
  const scene = SCENES.find((row) => row.id === sceneId), detail = catalog.SCENE_DETAIL[sceneId];
  if (!device.floors.includes(input.floorId)) throw fail('product_video_invalid_option', `请为${device.name}选择适用的地面材质。`);
  const floor = pick(catalog.FLOORS, input.floorId, '地面材质');
  const dirtIds = Array.isArray(input.dirtIds) ? [...new Set(input.dirtIds)] : [];
  if (!dirtIds.length || dirtIds.length > 2 || dirtIds.some((id) => !device.dirt.includes(id))) throw fail('product_video_invalid_option', `请为${device.name}选择一到两种适用的污物。`);
  const dirt = dirtIds.map((id) => pick(catalog.DIRT, id, '污物'));
  const pointIds = Array.isArray(input.pointIds) ? [...new Set(input.pointIds)] : [];
  const allowed = catalog.forDevice(device).filter((point) => !point.core);
  if (pointIds.some((id) => !allowed.some((point) => point.id === id))) throw fail('product_video_invalid_option', `有卖点不适用于${device.name}，请重新勾选。`);
  if (pointIds.length > catalog.POINT_LIMIT[seconds]) throw fail('product_video_invalid_option', `${seconds}秒最多选${catalog.POINT_LIMIT[seconds]}个卖点。`);
  const productName = clean(input.productName, 80) || device.name;
  const extra = Array.isArray(input.extraImageIds) ? input.extraImageIds : [];
  if (extra.length > MAX_PRODUCT_IMAGES - 1) throw fail('product_video_invalid_input', `产品图最多${MAX_PRODUCT_IMAGES}张。`);
  const productImages = 1 + extra.length;

  const points = pointIds.map((id) => allowed.find((point) => point.id === id));
  const core = catalog.POINTS.find((point) => point.core);
  // The floor going from dirty to clean is the heart of the video: keep one such shot.
  if (!points.some((point) => point.cleaning) && points.length < catalog.POINT_LIMIT[seconds]) points.unshift(core);
  const shots = points.map((point) => ({ point, camera: point.camera, fixed: point.fixed }));
  for (let i = 0; shots.length < catalog.MIN_SHOTS[seconds]; i += 1) shots.push({ point: core, ...FILLERS[i % FILLERS.length], filler: true });
  const lengths = spread(seconds, shots.length);
  let cursor = 0, dirtTurn = 0;
  const planned = shots.map(({ point, camera, fixed, caption, filler }, index) => {
    const soil = point.dirt && catalog.DIRT.some((row) => row.id === point.dirt) && (device.dirt.includes(point.dirt) || dirt.some((row) => row.id === point.dirt))
      ? catalog.DIRT.find((row) => row.id === point.dirt) : dirt[dirtTurn++ % dirt.length];
    const shot = { index, seconds: lengths[index], startSecond: cursor, endSecond: cursor + lengths[index], pointId: point.id, title: filler ? '清洁效果' : point.name,
      caption: caption || point.caption, narration: '', place: point.place, cleaning: Boolean(point.cleaning), dirt: point.cleaning ? soil.name : '' };
    shot.prompt = shotPrompt({ device, scene, detail, floor, soil, point, camera, fixed, seconds: shot.seconds, productImages });
    if (promptLength(shot.prompt) > PROMPT_LIMIT) throw fail('product_video_invalid_input', '这一镜的拍摄要求太长，请减少勾选后重试。');
    cursor += shot.seconds; return shot;
  });
  return {
    version: REAL_VERSION, pipelineVersion: 6, videoProvider: 'bailian', videoModel: DIRECT_MODEL, videoAudio: true,
    sourceResolution: '480p', outputSize: '1080x1920', imageModel: IMAGE_MODEL,
    // The scene picture is only made (and paid for) when a shot happens in the venue.
    // The 定妆照 (four views from the product photo, confirmed by the customer) always; the scene picture only when a shot is in the venue.
    sheet: true, imageCount: 1 + (planned.some((shot) => shot.place === 'venue') ? 1 : 0), director: '实拍导演',
    productName, productImages, deviceId: device.id, device: device.name, operator: device.operator, scene: scene.name, sceneIds: [scene.id],
    floorId: floor.id, surface: floor.name, dirtIds, dirt: dirt.map((row) => row.name).join('、'), pointIds,
    platePrompt: platePrompt({ scene, detail, floor, dirt }), shots: planned,
    evidenceStatus: 'user_selected_unverified', goal: '真实现场的设备作业演示',
    sendText: '这是按您这台设备做的现场作业演示。把您的场地情况发来，一起看看怎么用。',
    estimateNote: '一张场景图按图片单价；视频按 Wan3 480P 有声每秒单价，各镜头同时生成；字幕按勾选的卖点生成，不另收识别费。'
  };
}

// One empty picture of the venue with the chosen floor and dirt: the place every venue shot happens in.
function platePrompt({ scene, detail, floor, dirt }) {
  return `${promptRef("video.realshoot_plan.scene_plate.p1")}${detail.place}（${scene.description}${promptRef("video.realshoot_plan.scene_plate.p2")}${floor.name}，${floor.look}${promptRef("video.realshoot_plan.scene_plate.p3")}${dirt.map((row) => row.dirty).join('；')}${promptRef("video.realshoot_plan.scene_plate.p4")}${detail.light}。
${STYLE}${promptRef("video.realshoot_plan.scene_plate.p5")}`;
}

// fixed: whether the camera stays put, carried as data (the camera wording is a server-stored prompt on a customer computer).
function shotPrompt({ device, scene, detail, floor, soil, point, camera, fixed = /固定/u.test(camera), seconds, productImages = 1 }) {
  // Real photos first, then the confirmed 定妆照 (third paid round, 2026-11-19: it kept the back and sides true), then the scene.
  const photos = productImages > 1 ? `${Array.from({ length: productImages }, (_, i) => `图${i + 1}`).join('、')}是这台机器不同角度的真实产品照片` : '图1是这台机器的真实产品照片';
  const sheet = `图${productImages + 1}`, plate = `图${productImages + 2}`;
  const products = `${photos}，${sheet}${promptRef("video.realshoot_plan.products.p1")}${sheet}为准`;
  const people = PEOPLE[device.operator];
  const light = point.night ? promptRef("video.realshoot_plan.night_light") : `${detail.light}。`;
  const place = point.place === 'venue' ? `${detail.place}（${scene.description}）。${plate}是这个场地：陈设、地面和光线以${plate}为准，${plate}里的地面就是没清洁过的样子。`
    : `${scene.name}这类场所里的${point.id === 'lift' ? '电梯厅' : point.id === 'gate' ? '自动玻璃门入口' : '设备间一角'}，装修朴素真实，和平时用的地方一样。`;
  const action = point.action.replace('{work}', device.work);
  const cleaning = point.cleaning ? `${promptRef("video.realshoot_plan.cleaning_rule.p1")}${device.wet ? '冲过的地面被清水冲湿，是干净的本色，污渍随水冲走，不留脏水；' : promptRef("video.realshoot_plan.clean_dry")}${promptRef("video.realshoot_plan.cleaning_rule.p2")}${soil.dirty}。
` : '';
  const sound = point.quiet ? '机器运转声很轻，几乎被环境声盖过' : '机器运转声平稳真实（电机、刷盘或吸风的声音），与画面动作对得上';
  return `${promptRef("video.realshoot_plan.shot.p1")}${seconds}${promptRef("video.realshoot_plan.shot.p2")}${device.body}${promptRef("video.realshoot_plan.shot.p3")}${point.name}${promptRef("video.realshoot_plan.shot.p4")}${products}${promptRef("video.realshoot_plan.shot.p5")}${place}${promptRef("video.realshoot_plan.shot.p6")}${floor.name}，${floor.look}。${light}
【四、人物】${people.rule}
【五、动作】${action}${point.cleaning ? `${device.parts}。` : ''}${promptRef("video.realshoot_plan.shot.p7")}${camera}。${fixed ? '摄影机全程固定在这个位置，只有很轻的手持呼吸感，不推拉、不摇镜。' : promptRef("video.realshoot_plan.camera_once")}
${cleaning}${promptRef("video.realshoot_plan.shot.p8")}${sound}${promptRef("video.realshoot_plan.shot.p9")}${detail.ambient}${promptRef("video.realshoot_plan.shot.p10")}${STYLE}
【九、负向】${NEG}${point.cleaning && !device.wet ? '地面上不凭空出现任何液体或水痕。' : ''}${people.neg}`;
}

// Planned subtitles: one line per shot, shown while that shot plays.
function plannedCaptions(plan) {
  return plan.shots.filter((shot) => shot.caption).map((shot) => ({ text: shot.caption, start: shot.startSecond + 0.3, end: Math.max(shot.startSecond + 1, shot.endSecond - 0.2) }));
}

module.exports = { REAL_VERSION, PROMPT_LIMIT, MAX_PRODUCT_IMAGES, FILLERS, planRealShoot, plannedCaptions, platePrompt, shotPrompt };
