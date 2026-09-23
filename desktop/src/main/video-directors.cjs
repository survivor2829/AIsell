const { VERSION: DIRECTOR_VERSION, productDirection } = require('./skills/cleaning-video-director/rules.cjs');

const SCENES = Object.freeze([
  { id: "community", name: "小区外围", description: "真实小区道路与出入口，居民活动自然，背景不喧宾夺主" },
  { id: "school", name: "学校", description: "真实学校公共区域，避开未成年人面部和校名标识" },
  { id: "hospital", name: "医院", description: "真实医院公共区域，避开患者、医护身份和院方标识" },
  { id: "office", name: "办公楼", description: "真实办公楼大堂或走廊，商业摄影光线" },
  { id: "factory", name: "厂区", description: "真实厂区通道，留出符合设备体量的作业空间" }
]);
const SURFACES = Object.freeze([
  { id: "marble", name: "大理石" }, { id: "terrazzo", name: "水磨石" },
  { id: "tile", name: "瓷砖" }, { id: "concrete", name: "水泥地" },
  { id: "epoxy", name: "环氧地坪" }, { id: "asphalt", name: "沥青路面" }
]);
const DIRT = Object.freeze([
  { id: "none", name: "不指定污渍" }, { id: "dust", name: "灰尘" },
  { id: "leaves", name: "落叶" }, { id: "water", name: "积水" },
  { id: "footprints", name: "脚印" }
]);
const GOALS = Object.freeze([
  { id: "appearance", name: "展示产品外观" },
  { id: "operation", name: "展示作业过程" },
  { id: "result", name: "展示清洁前后" }
]);
const OUTPUT_SECONDS = new Set([30, 45, 60]);
const USD_PER_SECOND_480P = 0.09608;
const USD_PER_SECOND_1080P = 0.38488;

function selected(rows, id, field) {
  const value = rows.find((row) => row.id === id);
  if (!value) throw Object.assign(new Error(`请选择有效的${field}。`), { code: "product_video_invalid_option" });
  return value;
}

function planVideo(input) {
  if (!["product", "social"].includes(input.mode) || !OUTPUT_SECONDS.has(input.durationSeconds)) {
    throw Object.assign(new Error("请选择视频类型和 30、45 或 60 秒时长。"), { code: "product_video_invalid_option" });
  }
  const scene = selected(SCENES, input.sceneId, "场景");
  const surface = selected(SURFACES, input.surfaceId, "地面材质");
  const dirt = selected(DIRT, input.dirtId, "污渍");
  const goal = selected(GOALS, input.goalId, "演示目标");
  const facts = String(input.facts || "").trim().slice(0, 400);
  const expression = String(input.expression || "").trim().slice(0, 400);
  const count = input.durationSeconds / 15;
  const brief = productDirection({ scene, surface, facts, mode: input.mode });
  const evidence = facts ? `已提供的产品事实：${facts}。只能表达这些事实，不得补充数字、功效、品牌承诺或不存在的结构。` : "没有已核实的产品能力资料，只能展示外观、体量、细节和场景，不得演示具体清洁效果或声称适用材质。";
  const base = `竖屏9:16、源视频480p。参考图是唯一的产品外观依据，保持造型、颜色、标识、结构和真实体量。${scene.description}。地面为${surface.name}。${brief.photography}${brief.visual}${brief.lighting}${brief.activity}${evidence}无人物出镜。负面约束：${brief.negative}`;
  const productShots = facts ? [
    ["场景与需求", `先展示${scene.name}的${surface.name}地面及产品全貌；${dirt.id === "none" ? "不添加明显污渍" : `可见${dirt.name}`}。`],
    ["产品与动作", `依据产品照片和已提供事实展示可确认的细节；演示目标为${goal.name}，只有事实明确支持时才表现设备作业。`],
    ["效果与证据", `展示已提供事实能够支持的结果；没有清洁效果依据时只展示产品和应用环境，不生成夸张的前后对比。`],
    ["客户下一步", "回到完整产品与应用场景，留出后期加客户沟通文字的画面空间。"]
  ] : [
    ["场景", `展示${scene.name}的${surface.name}地面，突出真实空间。`],
    ["外观", "从产品整体转到可见的真实结构，产品静置，不虚构作业动作。"],
    ["细节", "用近景展示参考图片清晰可辨的真实细节，不展示清洁效果。"],
    ["收束", "产品与场景同框，留出后期添加销售沟通文字的空间。"]
  ];
  const socialShots = [
    ["开头问题", `以${scene.name}中${surface.name}地面的真实管理场景开头，用画面提出问题，不做未经证实的功效承诺。`],
    ["产品亮相", "参考图中的清洁设备进入画面，展示真实外观和体量，不出现真人。"],
    ["有据可讲", facts ? `仅用已提供的事实表现产品细节：${facts}` : "用可见的产品外观细节维持兴趣，不演示未经证实的效果。"],
    ["咨询引导", "产品与场景同框，留白供后期加入适用需求和咨询引导文字。"]
  ];
  const beats = input.mode === "product" ? productShots : socialShots;
  const chosenBeats = count === 2
    ? [beats[0], [`${beats[1][0]}与咨询`, `${beats[1][1]} ${beats[3][1]}`]]
    : count === 3 ? [beats[0], beats[1], beats[3]] : beats;
  const shots = Array.from({ length: count }, (_, index) => {
    const [title, direction] = chosenBeats[index];
    const closing = index === count - 1;
    const narration = input.mode === "product"
      ? closing ? "如果您有现场需求，可以把场景发来一起看看。" : [`先看看${scene.name}的现场环境。`, "这款设备的外观和结构，可以从不同角度看清。", facts ? `关于产品，我们已确认：${facts.slice(0, 42)}。` : "具体性能和作业效果，请以产品资料和现场演示为准。"][index]
      : closing ? "您的现场是什么材质？欢迎留言交流。" : [`在${scene.name}管理清洁现场，您会先关注什么？`, "先看设备的真实外观和体量。", facts ? `已确认的产品信息是：${facts.slice(0, 38)}。` : "作业方式与效果，需要结合真实产品资料核对。"][index];
    return { index, seconds: 15, startSecond: index * 15, endSecond: (index + 1) * 15,
      title, narration, camera: index === 0 ? '中景建立现场' : closing ? '稳定全景收束' : '中近景缓慢推进',
      action: direction, sound: brief.sound,
      prompt: `${base}镜头${index + 1}：${direction}${expression ? `客户补充观点：${expression}；仅当它与已提供事实一致时表达。` : ""} 镜头运动自然，产品外观稳定，单镜头15秒。同一位自然、清晰的成年普通话旁白说：${narration}。不让画面中的人说话，不添加其他台词。` };
  });
  const sendText = input.mode === "product"
    ? `这是产品在${scene.name}、${surface.name}场景下的展示视频。您目前更关注哪类现场需求？`
    : `在${scene.name}管理清洁设备时，您最想解决哪一步？欢迎告诉我现场情况。`;
  return {
    version: DIRECTOR_VERSION, director: input.mode === "product" ? "叶镜川" : "叶映声",
    scene: scene.name, surface: surface.name, dirt: dirt.name, goal: goal.name,
    evidenceStatus: facts ? "user_supplied_unverified" : "appearance_only",
    concept: brief.concept, personReference: '无真人出镜', photography: brief.photography,
    visualDirection: brief.visual, skinTone: '无真人出镜', lighting: brief.lighting,
    activity: brief.activity, soundDesign: brief.sound, negativeConstraints: brief.negative,
    sourceResolution: '480p', outputSize: '1080x1920', enhancement: 'lanczos_resize',
    shots, sendText, estimatedVideoUsd: Number((input.durationSeconds * USD_PER_SECOND_480P).toFixed(2)),
    estimateNote: "仅按当前 480p 视频单价估算；本地放大后为 1080p 尺寸，不等于原生 1080p 细节。预览、重做及后期另计，实际以服务账单为准。"
  };
}

module.exports = { SCENES, SURFACES, DIRT, GOALS, OUTPUT_SECONDS, USD_PER_SECOND_480P, USD_PER_SECOND_1080P, DIRECTOR_VERSION, planVideo };
