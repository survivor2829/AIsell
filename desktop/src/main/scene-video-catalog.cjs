// The catalog's prompt wording is stored on the server (prompt-library.json); pick lists show only names.
const { promptRef } = require("../shared/prompt-ref.cjs");
// 场景效果视频 · 无人实拍 (pipeline 6): everything the customer picks instead of writing a prompt.
// Device type → scene → floor → dirt → selling points. Each selling point carries its own shot:
// where it happens, what the machine does, how the camera films it (one thing only, no cut) and one
// short subtitle line. Selling points follow what commercial cleaning makers advertise (station
// refill/drain, return to charge, riding lifts, passing doors, avoiding obstacles, edge cleaning…).
// The customer only ticks what their own product can do; nothing here is claimed on its own.
const { SCENES } = require('./video-directors.cjs');

const GROUPS = Object.freeze([
  { id: 'robot', name: '清洁机器人' },
  { id: 'traditional', name: '传统清洁设备' }
]);
const INDOOR = ['market', 'hospital', 'school', 'hotel', 'office', 'station', 'factory', 'facilities'];
const ALL_SCENES = SCENES.map((scene) => scene.id);
const OUTDOOR = ['community', 'station', 'factory', 'facilities'];
const HARD = ['tile', 'anti_slip', 'marble', 'terrazzo', 'epoxy', 'pvc', 'concrete'];

// operator: none = 画面里没有人; walk = 只拍操作员的手和下半身; ride = 只拍驾驶员肩部以下.
const DEVICES = Object.freeze([
  { id: 'robot_scrubber', group: 'robot', name: '洗地机器人', operator: 'none', scenes: INDOOR, floors: HARD, dirt: ['footprints', 'drink', 'oil', 'water', 'tire', 'dust'],
    body: promptRef("video.catalog.device.robot_scrubber.body"), parts: promptRef("video.catalog.device.robot_scrubber.parts"), work: promptRef("video.catalog.device.robot_scrubber.work") },
  { id: 'robot_sweeper', group: 'robot', name: '扫地机器人', operator: 'none', scenes: INDOOR, floors: [...HARD, 'carpet', 'wood'], dirt: ['dust', 'grit', 'paper', 'cigarette', 'metal', 'leaves'],
    body: promptRef("video.catalog.device.robot_sweeper.body"), parts: promptRef("video.catalog.device.robot_sweeper.parts"), work: promptRef("video.catalog.device.robot_sweeper.work") },
  { id: 'robot_dust', group: 'robot', name: '尘推机器人', operator: 'none', scenes: INDOOR, floors: ['marble', 'terrazzo', 'tile', 'pvc', 'wood', 'epoxy'], dirt: ['dust', 'grit', 'footprints'],
    body: promptRef("video.catalog.device.robot_dust.body"), parts: promptRef("video.catalog.device.robot_dust.parts"), work: promptRef("video.catalog.device.robot_dust.work") },
  { id: 'robot_combo', group: 'robot', name: '洗扫一体机器人', operator: 'none', scenes: INDOOR, floors: HARD, dirt: ['dust', 'grit', 'paper', 'footprints', 'drink', 'oil', 'water', 'tire', 'metal'],
    body: promptRef("video.catalog.device.robot_combo.body"), parts: promptRef("video.catalog.device.robot_combo.parts"), work: promptRef("video.catalog.device.robot_combo.work") },
  { id: 'robot_outdoor', group: 'robot', name: '户外清扫机器人', operator: 'none', scenes: OUTDOOR, floors: ['asphalt', 'paver', 'concrete'], dirt: ['leaves', 'paper', 'cigarette', 'grit', 'dust'],
    body: promptRef("video.catalog.device.robot_outdoor.body"), parts: promptRef("video.catalog.device.robot_outdoor.parts"), work: promptRef("video.catalog.device.robot_outdoor.work") },
  { id: 'walk_scrubber', group: 'traditional', name: '手推式洗地机', operator: 'walk', scenes: INDOOR, floors: HARD, dirt: ['footprints', 'drink', 'oil', 'water', 'tire', 'dust'],
    body: promptRef("video.catalog.device.walk_scrubber.body"), parts: promptRef("video.catalog.device.walk_scrubber.parts"), work: promptRef("video.catalog.device.walk_scrubber.work") },
  { id: 'ride_scrubber', group: 'traditional', name: '驾驶式洗地机', operator: 'ride', scenes: INDOOR, floors: HARD, dirt: ['footprints', 'drink', 'oil', 'water', 'tire', 'dust', 'metal'],
    body: promptRef("video.catalog.device.ride_scrubber.body"), parts: promptRef("video.catalog.device.ride_scrubber.parts"), work: promptRef("video.catalog.device.ride_scrubber.work") },
  { id: 'walk_sweeper', group: 'traditional', name: '手推式扫地机', operator: 'walk', scenes: ALL_SCENES, floors: [...HARD, 'asphalt', 'paver'], dirt: ['dust', 'grit', 'paper', 'leaves', 'cigarette', 'metal'],
    body: promptRef("video.catalog.device.walk_sweeper.body"), parts: promptRef("video.catalog.device.walk_sweeper.parts"), work: promptRef("video.catalog.device.walk_sweeper.work") },
  { id: 'ride_sweeper', group: 'traditional', name: '驾驶式扫地车', operator: 'ride', scenes: ALL_SCENES, floors: [...HARD, 'asphalt', 'paver'], dirt: ['dust', 'grit', 'paper', 'leaves', 'cigarette', 'metal'],
    body: promptRef("video.catalog.device.ride_sweeper.body"), parts: promptRef("video.catalog.device.ride_sweeper.parts"), work: promptRef("video.catalog.device.ride_sweeper.work") },
  { id: 'pressure_washer', group: 'traditional', name: '高压清洗机', operator: 'walk', wet: true, scenes: ['factory', 'facilities', 'community', 'station'], floors: ['concrete', 'epoxy', 'paver', 'asphalt', 'anti_slip'], dirt: ['oil', 'tire', 'footprints', 'dust'],
    body: promptRef("video.catalog.device.pressure_washer.body"), parts: promptRef("video.catalog.device.pressure_washer.parts"), work: promptRef("video.catalog.device.pressure_washer.work") },
  { id: 'wet_dry_vac', group: 'traditional', name: '吸尘吸水机', operator: 'walk', scenes: INDOOR, floors: [...HARD, 'carpet'], dirt: ['water', 'dust', 'grit', 'drink'],
    body: promptRef("video.catalog.device.wet_dry_vac.body"), parts: promptRef("video.catalog.device.wet_dry_vac.parts"), work: promptRef("video.catalog.device.wet_dry_vac.work") }
]);

const FLOORS = Object.freeze([
  { id: 'tile', name: '瓷砖', look: '砖缝清楚，表面有柔和反光' },
  { id: 'anti_slip', name: '防滑地砖', look: '哑光颗粒表面，基本不反光' },
  { id: 'marble', name: '大理石', look: '纹理清楚，有自然的柔和反光' },
  { id: 'terrazzo', name: '水磨石', look: '石子纹理清楚，有柔和反光' },
  { id: 'epoxy', name: '环氧地坪', look: '半哑光，颜色均匀，只有微弱反光' },
  { id: 'pvc', name: 'PVC 卷材', look: '哑光，有拼缝，颜色均匀' },
  { id: 'concrete', name: '水泥地', look: '哑光灰色，有细微色差，不反光' },
  { id: 'asphalt', name: '沥青路面', look: '深灰色粗糙表面，完全不反光' },
  { id: 'paver', name: '透水砖/广场砖', look: '一块块拼铺，砖缝清楚，不反光' },
  { id: 'carpet', name: '地毯', look: '短绒商用地毯，有轻微压痕' },
  { id: 'wood', name: '木地板', look: '木纹清楚，有轻微使用痕迹' }
]);

// dirty: what the floor looks like before (a normal day's amount, never heaps of rubbish).
const DIRT = Object.freeze([
  { id: 'oil', name: '油污', dirty: '地面上有几片发暗的油渍和拖开的油印，边缘不规则' },
  { id: 'metal', name: '铁屑', dirty: '地面上散落着细小发亮的金属碎屑和铁屑' },
  { id: 'dust', name: '灰尘', dirty: '地面蒙着一层薄薄的浮灰，看得出下面的本色' },
  { id: 'grit', name: '砂砾', dirty: '地面上零星散落着细小砂砾' },
  { id: 'paper', name: '纸屑', dirty: '地面上零星散落着小纸屑和包装碎片' },
  { id: 'leaves', name: '落叶', dirty: '地面上零星散落着落叶' },
  { id: 'water', name: '积水', dirty: '地面上有几片浅浅的积水和水渍' },
  { id: 'footprints', name: '泥脚印', dirty: '地面上有几道清楚的灰色泥脚印' },
  { id: 'drink', name: '饮料渍', dirty: '地面上有几处干掉的饮料渍和黏印' },
  { id: 'cigarette', name: '烟头', dirty: '地面上零星散落着几个烟头和小碎屑' },
  { id: 'tire', name: '轮胎印', dirty: '地面上有几道发黑的轮胎印' }
]);

// What each scene looks like and sounds like, with the floor and dirt it usually has.
const SCENE_DETAIL = Object.freeze({
  community: { place: promptRef("video.catalog.scene.community.place"), light: promptRef("video.catalog.scene.community.light"), ambient: promptRef("video.catalog.scene.community.ambient"), floor: 'paver', dirt: ['leaves', 'cigarette'] },
  market: { place: promptRef("video.catalog.scene.market.place"), light: promptRef("video.catalog.scene.market.light"), ambient: promptRef("video.catalog.scene.market.ambient"), floor: 'tile', dirt: ['drink', 'footprints'] },
  hospital: { place: promptRef("video.catalog.scene.hospital.place"), light: promptRef("video.catalog.scene.hospital.light"), ambient: promptRef("video.catalog.scene.hospital.ambient"), floor: 'pvc', dirt: ['footprints', 'water'] },
  school: { place: promptRef("video.catalog.scene.school.place"), light: promptRef("video.catalog.scene.school.light"), ambient: promptRef("video.catalog.scene.school.ambient"), floor: 'terrazzo', dirt: ['paper', 'footprints'] },
  hotel: { place: promptRef("video.catalog.scene.hotel.place"), light: promptRef("video.catalog.scene.hotel.light"), ambient: promptRef("video.catalog.scene.hotel.ambient"), floor: 'carpet', dirt: ['dust', 'footprints'] },
  office: { place: promptRef("video.catalog.scene.office.place"), light: promptRef("video.catalog.scene.office.light"), ambient: promptRef("video.catalog.scene.office.ambient"), floor: 'marble', dirt: ['footprints', 'dust'] },
  station: { place: promptRef("video.catalog.scene.station.place"), light: promptRef("video.catalog.scene.station.light"), ambient: promptRef("video.catalog.scene.station.ambient"), floor: 'terrazzo', dirt: ['footprints', 'paper'] },
  factory: { place: promptRef("video.catalog.scene.factory.place"), light: promptRef("video.catalog.scene.factory.light"), ambient: promptRef("video.catalog.scene.factory.ambient"), floor: 'epoxy', dirt: ['oil', 'metal'] },
  facilities: { place: promptRef("video.catalog.scene.facilities.place"), light: promptRef("video.catalog.scene.facilities.light"), ambient: promptRef("video.catalog.scene.facilities.ambient"), floor: 'epoxy', dirt: ['tire', 'oil'] }
});

// A selling point is one continuous shot. place: venue = the chosen scene (uses the scene picture);
// other = a corner of the same building (station, lift, door) where the scene picture is only a style hint.
// cleaning = the floor goes from dirty to clean in this shot. Captions stay within one line (≤ 10 wide).
const POINTS = Object.freeze([
  { id: 'clean', name: '清洁效果', caption: '走过的地方 干干净净', devices: '*', cleaning: true, place: 'venue', core: true,
    camera: promptRef("video.catalog.point.clean.camera"), action: '{work}' + promptRef("video.catalog.point.clean.action"), fixed: false, said: promptRef("video.catalog.point.clean.said") },
  { id: 'wide', name: '大面积高效', caption: '一趟洗一大片', devices: ['robot_scrubber', 'robot_combo', 'ride_scrubber', 'ride_sweeper', 'robot_outdoor', 'robot_sweeper'], cleaning: true, place: 'venue',
    camera: promptRef("video.catalog.point.wide.camera"), action: '{work}' + promptRef("video.catalog.point.wide.action"), fixed: false, said: promptRef("video.catalog.point.wide.said") },
  { id: 'stain', name: '顽固污渍', caption: '顽固污渍 一遍洗净', devices: ['robot_scrubber', 'robot_combo', 'walk_scrubber', 'ride_scrubber', 'pressure_washer'], cleaning: true, place: 'venue',
    camera: promptRef("video.catalog.point.stain.camera"), action: '{work}' + promptRef("video.catalog.point.stain.action"), fixed: true, said: promptRef("video.catalog.point.stain.said") },
  { id: 'dry', name: '洗完即干', caption: '洗完即干 不留水渍', devices: ['robot_scrubber', 'robot_combo', 'walk_scrubber', 'ride_scrubber', 'wet_dry_vac'], cleaning: true, place: 'venue',
    camera: promptRef("video.catalog.point.dry.camera"), action: '{work}' + promptRef("video.catalog.point.dry.action"), fixed: false, said: promptRef("video.catalog.point.dry.said") },
  { id: 'oil', name: '强力去油污', caption: '油污 一洗就掉', devices: ['robot_scrubber', 'robot_combo', 'walk_scrubber', 'ride_scrubber', 'pressure_washer'], cleaning: true, place: 'venue', dirt: 'oil',
    camera: promptRef("video.catalog.point.oil.camera"), action: '{work}' + promptRef("video.catalog.point.oil.action"), fixed: true, said: promptRef("video.catalog.point.oil.said") },
  { id: 'sweep', name: '扫吸一体 不扬尘', caption: '扫吸一体 不扬尘', devices: ['robot_sweeper', 'robot_combo', 'robot_outdoor', 'walk_sweeper', 'ride_sweeper', 'wet_dry_vac'], cleaning: true, place: 'venue',
    camera: promptRef("video.catalog.point.sweep.camera"), action: '{work}' + promptRef("video.catalog.point.sweep.action"), fixed: true, said: promptRef("video.catalog.point.sweep.said") },
  { id: 'edge', name: '贴边清洁', caption: '贴边清洁 不留死角', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor', 'walk_sweeper', 'ride_sweeper', 'walk_scrubber', 'ride_scrubber'], cleaning: true, place: 'venue',
    camera: promptRef("video.catalog.point.edge.camera"), action: '{work}' + promptRef("video.catalog.point.edge.action"), fixed: true, said: promptRef("video.catalog.point.edge.said") },
  { id: 'narrow', name: '窄道灵活', caption: '窄通道 转弯灵活', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'walk_scrubber', 'walk_sweeper', 'ride_scrubber', 'ride_sweeper'], cleaning: false, place: 'venue',
    camera: promptRef("video.catalog.point.narrow.camera"), action: promptRef("video.catalog.point.narrow.action"), fixed: true, said: promptRef("video.catalog.point.narrow.said") },
  // Third paid round (2026-11-19): two obstacles and a following camera made the cone jump and the machine flip; now one cone, a fixed camera, one direction.
  { id: 'obstacle', name: '自动避障', caption: '遇到障碍 自己绕开', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor'], cleaning: false, place: 'venue',
    camera: promptRef("video.catalog.point.obstacle.camera"), action: promptRef("video.catalog.point.obstacle.action"), fixed: true, said: promptRef("video.catalog.point.obstacle.said") },
  { id: 'water', name: '自动上下水', caption: '自动上下水 不用人管', devices: ['robot_scrubber', 'robot_combo'], cleaning: false, place: 'other',
    camera: promptRef("video.catalog.point.water.camera"), action: promptRef("video.catalog.point.water.action"), fixed: true, said: promptRef("video.catalog.point.water.said") },
  { id: 'charge', name: '自动回充', caption: '电量低 自己回去充电', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor'], cleaning: false, place: 'other',
    camera: promptRef("video.catalog.point.charge.camera"), action: promptRef("video.catalog.point.charge.action"), fixed: true, said: promptRef("video.catalog.point.charge.said") },
  { id: 'lift', name: '自己乘电梯', caption: '自己坐电梯 跨楼层', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo'], cleaning: false, place: 'other',
    camera: promptRef("video.catalog.point.lift.camera"), action: promptRef("video.catalog.point.lift.action"), fixed: true, said: promptRef("video.catalog.point.lift.said") },
  { id: 'gate', name: '自动过门', caption: '自动门 自己通过', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor'], cleaning: false, place: 'other',
    camera: promptRef("video.catalog.point.gate.camera"), action: promptRef("video.catalog.point.gate.action"), fixed: true, said: promptRef("video.catalog.point.gate.said") },
  { id: 'night', name: '夜间无人作业', caption: '下班以后 它自己干活', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor'], cleaning: true, place: 'venue', night: true,
    camera: promptRef("video.catalog.point.night.camera"), action: promptRef("video.catalog.point.night.action.p1") + '{work}' + promptRef("video.catalog.point.night.action.p2"), fixed: true, said: promptRef("video.catalog.point.night.said") },
  { id: 'quiet', name: '低噪音', caption: '运行安静 不打扰', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'walk_scrubber', 'walk_sweeper'], cleaning: true, place: 'venue', quiet: true,
    camera: promptRef("video.catalog.point.quiet.camera"), action: '{work}' + promptRef("video.catalog.point.quiet.action"), fixed: false, said: promptRef("video.catalog.point.quiet.said") },
  { id: 'slope', name: '爬坡有力', caption: '上坡也稳稳的', devices: ['ride_sweeper', 'ride_scrubber', 'robot_outdoor', 'walk_sweeper'], cleaning: true, place: 'venue',
    camera: promptRef("video.catalog.point.slope.camera"), action: '{work}' + promptRef("video.catalog.point.slope.action"), fixed: true, said: promptRef("video.catalog.point.slope.said") },
  { id: 'easy', name: '一键启动 上手快', caption: '一键启动 上手就会', devices: ['walk_scrubber', 'walk_sweeper', 'ride_scrubber', 'ride_sweeper', 'pressure_washer', 'wet_dry_vac'], cleaning: false, place: 'venue',
    camera: promptRef("video.catalog.point.easy.camera"), action: promptRef("video.catalog.point.easy.action"), fixed: false, said: promptRef("video.catalog.point.easy.said") }
]);

// Per duration: how many selling points at most (user, 2026-11-19), and the shortest number of shots
// so that no single shot is long enough for the model to cut it by itself.
const POINT_LIMIT = Object.freeze({ 15: 3, 30: 5, 45: 6, 60: 8 });
const MIN_SHOTS = Object.freeze({ 15: 2, 30: 3, 45: 5, 60: 6 });
const DURATIONS = Object.freeze([15, 30, 45, 60]);
const CAPTION_WIDTH = 10;

const forDevice = (device) => POINTS.filter((point) => point.devices === '*' || point.devices.includes(device.id));
function sceneDefaults(sceneId, device) {
  const detail = SCENE_DETAIL[sceneId];
  const floor = device.floors.includes(detail?.floor) ? detail.floor : device.floors[0];
  const dirt = (detail?.dirt || []).filter((id) => device.dirt.includes(id));
  return { floorId: floor, dirtIds: dirt.length ? dirt : [device.dirt[0]] };
}
// What the page shows: only what fits the chosen device, so nothing has to be typed.
function choices() {
  return { groups: GROUPS,
    devices: DEVICES.map((device) => ({ id: device.id, group: device.group, name: device.name, operator: device.operator, scenes: device.scenes, floors: device.floors, dirt: device.dirt,
      points: forDevice(device).filter((point) => !point.core).map((point) => point.id),
      defaults: Object.fromEntries(device.scenes.map((id) => [id, sceneDefaults(id, device)])) })),
    scenes: SCENES.map((scene) => ({ id: scene.id, name: scene.name })),
    floors: FLOORS.map(({ id, name }) => ({ id, name })), dirt: DIRT.map(({ id, name }) => ({ id, name })),
    points: POINTS.filter((point) => !point.core).map(({ id, name, caption, place, cleaning }) => ({ id, name, caption, place, cleaning: Boolean(cleaning) })),
    durations: DURATIONS, pointLimit: POINT_LIMIT, minShots: MIN_SHOTS };
}
module.exports = { GROUPS, DEVICES, FLOORS, DIRT, SCENE_DETAIL, POINTS, POINT_LIMIT, MIN_SHOTS, DURATIONS, CAPTION_WIDTH, forDevice, sceneDefaults, choices };
