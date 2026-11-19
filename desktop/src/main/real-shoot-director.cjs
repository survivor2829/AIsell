// 场景效果视频 · 无人实拍 (pipeline 6): the customer picks the device, scene, floor, dirt and selling
// points; each selling point becomes one continuous Wan3 shot with the machine's own sound. One empty
// scene picture keeps the venue the same across shots. No story, no people to cast, no storyboard.
// Realism rules come from 场景效果视频试验/27–28: plain venue light, documentary camera, the camera
// does one thing per shot (two camera moves made the model cut at 8.3 s), and cleaning only happens
// where the working parts have passed and stays clean to the last frame.
const { DIRECT_MODEL } = require('./bailian-video-provider.cjs');
const { SCENES, FACT_LIMIT } = require('./video-directors.cjs');
const catalog = require('./scene-video-catalog.cjs');
const { IMAGE_MODEL } = require('./story-video-director.cjs');

const REAL_VERSION = 'real-1';
const PROMPT_LIMIT = 4500;
const MAX_PRODUCT_IMAGES = 3;
const fail = (code, message) => Object.assign(new Error(message), { code });
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);

const STYLE = '成像：真实现场实拍，像专业摄影师用全画幅摄影机加35毫米定焦镜头在现场拍的设备演示素材。只用场地本来的照明，光线平淡自然，不额外打光。颜色中性克制、不鲜艳，画质细腻，只有极轻微的噪点。画面稳，但有很轻的手持呼吸感。不是广告片，不是三维渲染，不是动画。';
const NEG = '不要广告感，不要夸张调色，不要青橙色调，不要柔光滤镜，不要夕阳、光柱和光晕，不要雾气，不要慢动作，不要静帧，不要镜面地板和清晰倒影，不要塑料感和渲染感，不要成堆垃圾，不要字幕、文字、水印和商标，不要第二台机器。机器不悬浮、不平移滑行、不倒车、不原地打转、不变形、不多出零件；地面不提前变干净，干净的地面不重新变脏。';
const PEOPLE = {
  none: { rule: '这是无人驾驶的清洁机器人：没有座椅、没有方向盘、没有操纵把手，没有人坐上去、推它或用手操作它，它自己移动、自己工作。画面里没有任何人。', neg: '不要出现任何人、人影或人手，不要给机器加座椅、方向盘或把手。' },
  walk: { rule: '机器由一位操作员推着或手持操作，镜头只拍到操作员的手、手臂和下半身（深色工装裤、劳保鞋），始终不露脸，不说话；操作员只用手握住把手，身体始终在机器后方，和机身保持距离、不重叠；画面里没有其他人。', neg: '不要露出操作员的脸，不要出现其他人，人和机器不重叠、不融在一起。' },
  ride: { rule: '操作员坐在驾驶位开着机器，镜头从侧后方拍，画面上沿只到操作员的肩部，始终不露脸，不说话；驾驶员从头到尾一直坐在驾驶位上，不上车也不下车，身体不和机身重叠；画面里没有其他人。', neg: '不要露出驾驶员的脸，不要出现其他人，不要上下车，人和机器不融在一起。' }
};

function pick(rows, id, label) {
  const row = rows.find((item) => item.id === id);
  if (!row) throw fail('product_video_invalid_option', `请选择有效的${label}。`);
  return row;
}
const spread = (total, count) => Array.from({ length: count }, (_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0));
// Extra cleaning shots when few points were picked: different cameras, still one move each.
const FILLERS = [
  { camera: '贴近地面的低机位，镜头离地约三十厘米，在机器斜后方同速跟随，看清工作部件和身后的干净带', caption: '一趟过去 地面见本色' },
  { camera: '摄影机在机器正后方成人胸口高度稳定跟随，身后的干净带从画面底部一直延伸到机尾', caption: '边走边清 身后就干净' },
  { camera: '机器斜前方的固定机位，成人腰部高度，机器从远处迎面驶来，从镜头一侧经过', caption: '日常保洁 交给它' },
  { camera: '场地边上略高的固定远景机位，看到机器在整片场地里沿直线作业', caption: '整片场地 一遍搞定' },
  { camera: '机器正侧面的近景，成人膝盖高度，同速横向平移，看清工作部件贴着地面工作', caption: '贴地清洁 细节看得见' }
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
  const shots = points.map((point) => ({ point, camera: point.camera }));
  for (let i = 0; shots.length < catalog.MIN_SHOTS[seconds]; i += 1) shots.push({ point: core, ...FILLERS[i % FILLERS.length], filler: true });
  const lengths = spread(seconds, shots.length);
  let cursor = 0, dirtTurn = 0;
  const planned = shots.map(({ point, camera, caption, filler }, index) => {
    const soil = point.dirt && catalog.DIRT.some((row) => row.id === point.dirt) && (device.dirt.includes(point.dirt) || dirt.some((row) => row.id === point.dirt))
      ? catalog.DIRT.find((row) => row.id === point.dirt) : dirt[dirtTurn++ % dirt.length];
    const shot = { index, seconds: lengths[index], startSecond: cursor, endSecond: cursor + lengths[index], pointId: point.id, title: filler ? '清洁效果' : point.name,
      caption: caption || point.caption, narration: '', place: point.place, cleaning: Boolean(point.cleaning), dirt: point.cleaning ? soil.name : '' };
    shot.prompt = shotPrompt({ device, scene, detail, floor, soil, point, camera, seconds: shot.seconds, productImages });
    if ([...shot.prompt].length > PROMPT_LIMIT) throw fail('product_video_invalid_input', '这一镜的拍摄要求太长，请减少勾选后重试。');
    cursor += shot.seconds; return shot;
  });
  return {
    version: REAL_VERSION, pipelineVersion: 6, videoProvider: 'bailian', videoModel: DIRECT_MODEL, videoAudio: true,
    sourceResolution: '480p', outputSize: '1080x1920', imageModel: IMAGE_MODEL,
    // The scene picture is only made (and paid for) when a shot happens in the venue.
    imageCount: planned.some((shot) => shot.place === 'venue') ? 1 : 0, director: '实拍导演',
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
  return `一张真实现场照片，竖版9:16。地点：${detail.place}（${scene.description}）。地面是用了几年的${floor.name}，${floor.look}，有正常使用留下的细微划痕、旧色差和接缝。没清洁的地面：${dirt.map((row) => row.dirty).join('；')}，量是日常的量，不是成堆的垃圾。
空无一人，没有任何机器设备。平视略低的机位，镜头朝场地深处，全画面清晰。光线：${detail.light}。
${STYLE}
不要电影感，不要广告感，不要镜面地板，不要清晰倒影，不要过饱和，不要渲染感，无人物，无文字，无商标招牌，无水印。`;
}

function shotPrompt({ device, scene, detail, floor, soil, point, camera, seconds, productImages = 1 }) {
  const products = productImages > 1 ? `${Array.from({ length: productImages }, (_, i) => `图${i + 1}`).join('、')}是这台机器不同角度的真实产品照片` : '图1是这台机器的真实产品照片', plate = `图${productImages + 1}`;
  const people = PEOPLE[device.operator];
  const light = point.night ? '夜里营业结束后，场地只开着一部分顶灯，光线偏暗但看得清，没有任何人。' : `${detail.light}。`;
  const place = point.place === 'venue' ? `${detail.place}（${scene.description}）。${plate}是这个场地：陈设、地面和光线以${plate}为准，${plate}里的地面就是没清洁过的样子。`
    : `${scene.name}这类场所里的${point.id === 'lift' ? '电梯厅' : point.id === 'gate' ? '自动玻璃门入口' : '设备间一角'}，装修朴素真实，和平时用的地方一样。`;
  const action = point.action.replace('{work}', device.work);
  const cleaning = point.cleaning ? `【清洁规则】机器只朝机头方向前进。只有工作部件实际经过之后，那里的地面才变干净，露出同一块旧地面的干净本色；机头前方和两侧没经过的地方保持原样作对照。清洁过的地面直到最后一帧都保持干净，不重新变脏；是同一块旧地面清洁干净了，不是翻新，接缝、磨损和颜色不变。没清洁的地面：${soil.dirty}。\n` : '';
  const sound = point.quiet ? '机器运转声很轻，几乎被环境声盖过' : '机器运转声平稳真实（电机、刷盘或吸风的声音），与画面动作对得上';
  return `【一、片头一句话】
${seconds}秒竖屏9:16，单个连续镜头，一镜到底：真实现场拍摄的${device.body}作业画面，展示「${point.name}」。全程无剪辑、无切镜、无转场，中途不换机位。
【二、素材】${products}：全片任何时刻都只有这一台机器，不复制、不分身、不突然冒出第二台；造型、比例、配色、零件和机身字样严格以产品照片为准，不新增零件，不变成其他型号，照片里看不到的面保持简洁合理。机器体量与真实设备一致，实实在在压在地面上，下方有接地阴影；轮子随前进滚动，机身有轻微颤动，相对背景有真实位移。
【三、地点与光线】${place}地面是用了几年的${floor.name}，${floor.look}。${light}
【四、人物】${people.rule}
【五、动作】${action}${point.cleaning ? `${device.parts}。` : ''}
【六、摄影机】${camera}。${/固定/u.test(camera) ? '摄影机全程固定在这个位置，只有很轻的手持呼吸感，不推拉、不摇镜。' : '摄影机全程只做这一件事，起步和停下有一点惯性，跟拍略微滞后于机器。'}
${cleaning}【七、声音】只有两样声音：${sound}；现场环境声（${detail.ambient}）。无人声、无对白、无旁白、无音乐。
【八、风格】${STYLE}
【九、负向】${NEG}${people.neg}`;
}

// Planned subtitles: one line per shot, shown while that shot plays.
function plannedCaptions(plan) {
  return plan.shots.filter((shot) => shot.caption).map((shot) => ({ text: shot.caption, start: shot.startSecond + 0.3, end: Math.max(shot.startSecond + 1, shot.endSecond - 0.2) }));
}

module.exports = { REAL_VERSION, PROMPT_LIMIT, MAX_PRODUCT_IMAGES, planRealShoot, plannedCaptions, platePrompt, shotPrompt };
