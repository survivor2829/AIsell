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
    body: '商用洗地机器人', parts: '底部刷盘贴着地面刷洗，刷过的地面立刻干燥', work: '底部刷盘贴着地面刷洗，边刷边前进，刷过的地方污渍直接消失，身后的地面立刻干净、干燥' },
  { id: 'robot_sweeper', group: 'robot', name: '扫地机器人', operator: 'none', scenes: INDOOR, floors: [...HARD, 'carpet', 'wood'], dirt: ['dust', 'grit', 'paper', 'cigarette', 'metal', 'leaves'],
    body: '商用扫地机器人', parts: '前方边刷把垃圾扫向中间，底部吸口把垃圾吸进尘盒', work: '边刷把垃圾往中间拢，底部吸口随即吸走，地面不扬尘' },
  { id: 'robot_dust', group: 'robot', name: '尘推机器人', operator: 'none', scenes: INDOOR, floors: ['marble', 'terrazzo', 'tile', 'pvc', 'wood', 'epoxy'], dirt: ['dust', 'grit', 'footprints'],
    body: '商用尘推机器人', parts: '底部宽幅尘推布贴着地面推尘', work: '底部宽幅尘推布贴地推过，浮灰和细砂被推走带走' },
  { id: 'robot_combo', group: 'robot', name: '洗扫一体机器人', operator: 'none', scenes: INDOOR, floors: HARD, dirt: ['dust', 'grit', 'paper', 'footprints', 'drink', 'oil', 'water', 'tire', 'metal'],
    body: '商用洗扫一体机器人', parts: '前方边刷和吸口先扫走碎屑，底部刷盘再刷洗地面，刷过的地面立刻干燥', work: '先扫走碎屑，紧接着刷洗地面，一趟过去，身后的地面干净、干燥' },
  { id: 'robot_outdoor', group: 'robot', name: '户外清扫机器人', operator: 'none', scenes: OUTDOOR, floors: ['asphalt', 'paver', 'concrete'], dirt: ['leaves', 'paper', 'cigarette', 'grit', 'dust'],
    body: '户外无人清扫车', parts: '两侧大边刷把路面垃圾扫向中间，底部吸盘吸进垃圾箱', work: '两侧边刷把路面垃圾拢向中间，底部吸盘随即吸走，身后路面干净' },
  { id: 'walk_scrubber', group: 'traditional', name: '手推式洗地机', operator: 'walk', scenes: INDOOR, floors: HARD, dirt: ['footprints', 'drink', 'oil', 'water', 'tire', 'dust'],
    body: '手推式洗地机', parts: '底部刷盘贴着地面刷洗，刷过的地面立刻干燥', work: '操作员握着把手推着它直线前进，刷过的地方污渍直接消失，身后的地面立刻干净、干燥' },
  { id: 'ride_scrubber', group: 'traditional', name: '驾驶式洗地机', operator: 'ride', scenes: INDOOR, floors: HARD, dirt: ['footprints', 'drink', 'oil', 'water', 'tire', 'dust', 'metal'],
    body: '驾驶式洗地机', parts: '底部宽幅刷盘贴着地面刷洗，刷过的地面立刻干燥', work: '操作员坐在驾驶位开着它直线前进，刷过的地方污渍直接消失，身后的地面立刻干净、干燥' },
  { id: 'walk_sweeper', group: 'traditional', name: '手推式扫地机', operator: 'walk', scenes: ALL_SCENES, floors: [...HARD, 'asphalt', 'paver'], dirt: ['dust', 'grit', 'paper', 'leaves', 'cigarette', 'metal'],
    body: '手推式扫地机', parts: '前方边刷把垃圾扫向中间，主刷把垃圾扫进垃圾斗', work: '操作员推着它前进，边刷把垃圾往中间拢，主刷扫进垃圾斗' },
  { id: 'ride_sweeper', group: 'traditional', name: '驾驶式扫地车', operator: 'ride', scenes: ALL_SCENES, floors: [...HARD, 'asphalt', 'paver'], dirt: ['dust', 'grit', 'paper', 'leaves', 'cigarette', 'metal'],
    body: '驾驶式扫地车', parts: '两侧边刷把垃圾扫向中间，主刷和吸风把垃圾送进垃圾箱', work: '操作员坐在驾驶位开着它前进，两侧边刷拢起垃圾，主刷扫进垃圾箱，不扬尘' },
  { id: 'pressure_washer', group: 'traditional', name: '高压清洗机', operator: 'walk', wet: true, scenes: ['factory', 'facilities', 'community', 'station'], floors: ['concrete', 'epoxy', 'paver', 'asphalt', 'anti_slip'], dirt: ['oil', 'tire', 'footprints', 'dust'],
    body: '高压清洗机', parts: '主机连着高压水管，操作员手持喷枪', work: '操作员手持喷枪，扇形高压水柱贴着地面来回冲洗，冲过的地方露出本色' },
  { id: 'wet_dry_vac', group: 'traditional', name: '吸尘吸水机', operator: 'walk', scenes: INDOOR, floors: [...HARD, 'carpet'], dirt: ['water', 'dust', 'grit', 'drink'],
    body: '桶式吸尘吸水机', parts: '桶身连着软管和地面吸嘴', work: '操作员推着地面吸嘴走过，吸嘴经过的地方积水和灰尘直接被吸进桶里消失，身后的地面立刻干燥' }
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
  community: { place: '小区里的步行道和楼前空地', light: '白天自然光，天空偏阴，光线平淡', ambient: '远处的鸟叫和隐约的车声', floor: 'paver', dirt: ['leaves', 'cigarette'] },
  market: { place: '商超货架之间的主通道，货架上商品码放整齐但没有可识别商标', light: '顶上成排的白色日光灯，光线均匀', ambient: '商场空旷的混响和远处听不清内容的广播底噪', floor: 'tile', dirt: ['drink', 'footprints'] },
  hospital: { place: '医院门诊楼的公共走廊，两侧是候诊座椅，没有院方标识', light: '顶部的白色平板灯，光线冷白均匀', ambient: '走廊里轻微的空调声和远处的提示音', floor: 'pvc', dirt: ['footprints', 'water'] },
  school: { place: '教学楼一层的公共走廊，没有校名和标语', light: '窗外白天的自然光加走廊顶灯', ambient: '远处隐约的上课铃和空旷走廊的混响', floor: 'terrazzo', dirt: ['paper', 'footprints'] },
  hotel: { place: '酒店客房层的公共走廊，没有店名和门牌号', light: '走廊暖白色筒灯，光线柔和', ambient: '安静走廊里轻微的空调声', floor: 'carpet', dirt: ['dust', 'footprints'] },
  office: { place: '写字楼一层大堂，没有公司名称和标识', light: '大堂顶部的灯光加玻璃幕墙透进的白天自然光', ambient: '大堂空旷的混响', floor: 'marble', dirt: ['footprints', 'dust'] },
  station: { place: '客运站或地铁站的公共大厅，没有可识别的站名', light: '大厅顶部的白色灯光，光线平淡', ambient: '大厅空旷的混响和远处听不清内容的广播底噪', floor: 'terrazzo', dirt: ['footprints', 'paper'] },
  factory: { place: '厂房车间或仓储货架之间的通道，有立柱、周转箱和黄色地标线', light: '厂房顶上普通的白色工业灯，光线平淡，略微偏冷', ambient: '厂房空旷的混响和远处隐约的设备运转声', floor: 'epoxy', dirt: ['oil', 'metal'] },
  facilities: { place: '地下停车场的车道，有立柱、车位线和停着的车辆（看不清车牌）', light: '停车场顶部的白色灯管，光线偏暗偏冷', ambient: '地下车库低沉的混响和远处车辆驶过声', floor: 'epoxy', dirt: ['tire', 'oil'] }
});

// A selling point is one continuous shot. place: venue = the chosen scene (uses the scene picture);
// other = a corner of the same building (station, lift, door) where the scene picture is only a style hint.
// cleaning = the floor goes from dirty to clean in this shot. Captions stay within one line (≤ 10 wide).
const POINTS = Object.freeze([
  { id: 'clean', name: '清洁效果', caption: '走过的地方 干干净净', devices: '*', cleaning: true, place: 'venue', core: true,
    camera: '摄影机放在机器斜前方偏侧面的位置，成人腰部高度，跟着机器同速横向平移，机器始终在画面中间偏下', action: '{work}。机器以成人慢走的速度匀速前进，身后留下一条和机身同宽的干净地面。' },
  { id: 'wide', name: '大面积高效', caption: '一趟洗一大片', devices: ['robot_scrubber', 'robot_combo', 'ride_scrubber', 'ride_sweeper', 'robot_outdoor', 'robot_sweeper'], cleaning: true, place: 'venue',
    camera: '摄影机在机器正后方偏高的位置（约成人头顶高度），稳定地跟在后面，能看清身后一长条干净带一直延伸到画面底部', action: '{work}。机器沿着宽阔场地直线前进，身后一条宽宽的干净带越拉越长，两侧没清洁的地面保持原样作对照。' },
  { id: 'stain', name: '顽固污渍', caption: '顽固污渍 一遍洗净', devices: ['robot_scrubber', 'robot_combo', 'walk_scrubber', 'ride_scrubber', 'pressure_washer'], cleaning: true, place: 'venue',
    camera: '贴近地面的低机位近景，镜头离地约三十厘米，固定不动，机器的工作部件从画面一侧进入，压过污渍', action: '{work}。工作部件压过地上的污渍，污渍被刷洗带走，露出同一块地面的本色，没有残留的印子。' },
  { id: 'dry', name: '洗完即干', caption: '洗完即干 不留水渍', devices: ['robot_scrubber', 'robot_combo', 'walk_scrubber', 'ride_scrubber', 'wet_dry_vac'], cleaning: true, place: 'venue',
    camera: '贴近机尾的低机位，镜头离地约四十厘米，在机尾后方同速跟随，看清机尾和它身后的地面', action: '{work}。机尾经过之后，地面马上是干的，没有水痕、没有水渍。' },
  { id: 'oil', name: '强力去油污', caption: '油污 一洗就掉', devices: ['robot_scrubber', 'robot_combo', 'walk_scrubber', 'ride_scrubber', 'pressure_washer'], cleaning: true, place: 'venue', dirt: 'oil',
    camera: '斜前方中近景，成人膝盖高度，固定机位，油渍在画面中间，机器从画面一侧进入', action: '{work}。机器经过地上发暗的油渍，油渍被刷洗干净，露出地面原本的颜色，不留油印。' },
  { id: 'sweep', name: '扫吸一体 不扬尘', caption: '扫吸一体 不扬尘', devices: ['robot_sweeper', 'robot_combo', 'robot_outdoor', 'walk_sweeper', 'ride_sweeper', 'wet_dry_vac'], cleaning: true, place: 'venue',
    camera: '机器正前方贴地的低机位，镜头离地约三十厘米，固定不动，机器迎面缓慢驶来又从镜头一侧经过', action: '{work}。地上的碎屑被扫进吸走，空气里没有扬起的灰尘。' },
  { id: 'edge', name: '贴边清洁', caption: '贴边清洁 不留死角', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor', 'walk_sweeper', 'ride_sweeper', 'walk_scrubber', 'ride_scrubber'], cleaning: true, place: 'venue',
    camera: '墙角处的低机位，镜头沿着墙根方向，固定不动，机器贴着墙根从远处驶近', action: '{work}。机器贴着墙根和柱脚前进，边刷伸进墙角，墙根处的脏污也被清走，墙边一条干净。' },
  { id: 'narrow', name: '窄道灵活', caption: '窄通道 转弯灵活', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'walk_scrubber', 'walk_sweeper', 'ride_scrubber', 'ride_sweeper'], cleaning: false, place: 'venue',
    camera: '通道拐角外侧的固定机位，成人胸口高度，能同时看到拐角前后两段通道', action: '机器沿着窄通道前进，到拐角处平稳减速，顺着机头方向转过拐角，不碰到两侧货架或墙面，转过去后继续清洁前进。' },
  // Third paid round (2026-11-19): two obstacles and a following camera made the cone jump and the machine flip; now one cone, a fixed camera, one direction.
  { id: 'obstacle', name: '自动避障', caption: '遇到障碍 自己绕开', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor'], cleaning: false, place: 'venue',
    camera: '通道一侧的固定机位，成人腰部高度，侧面拍，能同时看到机器、锥桶和绕行的全过程', action: '通道中间只放着一个黄色锥桶，位置从头到尾固定不动。机器从画面左侧沿通道朝画面右侧直线开来，在离锥桶约半米处减速，平稳地从锥桶旁边绕过，绕过后回到原来的路线继续往右开。机器全程只朝这一个方向前进，不掉头，画面里没有其他障碍物。' },
  { id: 'water', name: '自动上下水', caption: '自动上下水 不用人管', devices: ['robot_scrubber', 'robot_combo'], cleaning: false, place: 'other',
    camera: '工作站正侧面的固定中景，成人胸口高度，能同时看到机器和靠墙的工作站', action: '机器自己驶向靠墙的自动工作站，缓慢对准后停稳，工作站的管路接上机器，透明管里能看到清水灌进机器、污水被抽走，工作站指示灯亮起。全程没有人碰它。' },
  { id: 'charge', name: '自动回充', caption: '电量低 自己回去充电', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor'], cleaning: false, place: 'other',
    camera: '充电桩侧前方的固定中景，成人膝盖高度', action: '机器自己驶向靠墙的充电桩，缓慢调整方向对准，倒退贴上充电触点停稳，机身的指示灯变成充电中的颜色。全程没有人碰它。' },
  { id: 'lift', name: '自己乘电梯', caption: '自己坐电梯 跨楼层', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo'], cleaning: false, place: 'other',
    camera: '电梯厅里正对电梯门的固定中景，成人胸口高度', action: '空无一人的电梯厅，机器停在电梯门前等候，电梯门自动打开，里面是空的，机器平稳驶进电梯轿厢，电梯门随后自动关上。电梯按钮和楼层显示看不清具体字样。' },
  { id: 'gate', name: '自动过门', caption: '自动门 自己通过', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor'], cleaning: false, place: 'other',
    camera: '自动玻璃门内侧的固定中景，成人胸口高度，正对门口', action: '机器朝自动玻璃门驶来，玻璃门在它面前自动向两侧打开，机器平稳通过，门在它身后自动关上，机器继续往里清洁前进。' },
  { id: 'night', name: '夜间无人作业', caption: '下班以后 它自己干活', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'robot_outdoor'], cleaning: true, place: 'venue', night: true,
    camera: '场地深处的远景固定机位，成人平视高度，看到整片空场地和远处正在作业的机器', action: '夜里营业结束后，场地只开着一部分灯，空无一人，机器亮着灯带独自作业。{work}。' },
  { id: 'quiet', name: '低噪音', caption: '运行安静 不打扰', devices: ['robot_scrubber', 'robot_sweeper', 'robot_dust', 'robot_combo', 'walk_scrubber', 'walk_sweeper'], cleaning: true, place: 'venue', quiet: true,
    camera: '机器侧面的中景，成人腰部高度，同速横向平移跟拍', action: '{work}。机器运转声很轻，几乎被环境声盖过。' },
  { id: 'slope', name: '爬坡有力', caption: '上坡也稳稳的', devices: ['ride_sweeper', 'ride_scrubber', 'robot_outdoor', 'walk_sweeper'], cleaning: true, place: 'venue',
    camera: '坡道底部侧面的固定机位，成人胸口高度，能看到整段坡道', action: '{work}。机器沿着一段缓坡匀速向上行驶，速度不减，不打滑，边走边清洁。' },
  { id: 'easy', name: '一键启动 上手快', caption: '一键启动 上手就会', devices: ['walk_scrubber', 'walk_sweeper', 'ride_scrubber', 'ride_sweeper', 'pressure_washer', 'wet_dry_vac'], cleaning: false, place: 'venue',
    camera: '操作面板的近景，从操作员肩后略高的位置拍，只拍到手', action: '操作员的一只手按下机器操作面板上的启动按钮，机器的指示灯亮起、开始运转，手握住把手（或方向盘），机器平稳开动。只拍到手和手臂。面板上的字样看不清。' }
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
