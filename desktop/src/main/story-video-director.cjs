// 场景效果视频 · 剧情版 (pipeline 5): the flow proven in 场景效果视频试验/28 (2026-11-16, 「多镜头版-带对话-15秒」),
// generalised: AI writes a short documentary-style story for the product and scene, then
// 定妆照 (confirmed by the customer) → 场景图 + 地面对照图 + 两个人物定妆照 → 每段六格分镜 → Wan3 每段 15 秒带对话现场声.
// Prompts follow the spike's wording (common.js / videoA-final.txt); only the story parts are filled in.
// Prompt wording is stored on the server; limits count the stored wording (promptLength), not the tokens.
const { promptRef, promptLength } = require("../shared/prompt-ref.cjs");
const { DIRECT_MODEL } = require('./bailian-video-provider.cjs');
const { SCENES, FACT_LIMIT } = require('./video-directors.cjs');

const STORY_VERSION = 'story-1';
const IMAGE_MODEL = 'gpt-image-2.5-ext';
const SEGMENT_SECONDS = 15;
const STORY_SECONDS = Object.freeze([15, 30, 45, 60]);
const SHOTS_PER_SEGMENT = 6;
const VIDEO_PROMPT_LIMIT = 4500;
const LINE_LIMIT = 24;

const STYLE = promptRef("video.story.style");
const NEG = promptRef("video.story.negative");

const fail = (code, message) => Object.assign(new Error(message), { code });
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);

function planStoryVideo(input) {
  const seconds = Number(input.durationSeconds);
  if (input.mode !== 'product' || !STORY_SECONDS.includes(seconds)) throw fail('product_video_invalid_option', '请选择15、30、45或60秒时长。');
  if (String(input.facts || '').trim().length > FACT_LIMIT) throw fail('product_video_invalid_input', `产品资料最多${FACT_LIMIT}字，请精简后重试。`);
  const asked = Array.isArray(input.sceneIds) ? input.sceneIds : [];
  if (asked.length > 1 || (asked.length && !SCENES.some((row) => row.id === asked[0]))) throw fail('product_video_invalid_option', '请选择一个有效场景。');
  const scene = SCENES.find((row) => row.id === asked[0]) || SCENES.find((row) => row.id === 'factory');
  const productName = clean(input.productName, 80) || '这款产品';
  const segments = seconds / SEGMENT_SECONDS;
  // A cleaning robot drives itself: nobody sits on it, steers or pushes it (customer video, 2026-11-19).
  const unmanned = /机器人|无人驾驶|无人值守|自主导航|自动驾驶/u.test(`${productName}${input.facts || ''}`);
  return {
    version: STORY_VERSION, pipelineVersion: 5, videoProvider: 'bailian', videoModel: DIRECT_MODEL, videoAudio: true,
    sourceResolution: '480p', outputSize: '1080x1920', imageModel: IMAGE_MODEL, director: '剧情导演',
    productName, scene: scene.name, sceneIds: [scene.id], segments, unmanned,
    // One image for the 定妆照, four for the place, the floor and two people, six per segment for the storyboard.
    imageCount: 1 + 4 + SHOTS_PER_SEGMENT * segments,
    shots: Array.from({ length: segments }, (_, index) => ({ index, seconds: SEGMENT_SECONDS, title: `第 ${index + 1} 段`, narration: '' })),
    evidenceStatus: 'user_supplied_unverified', goal: '纪实小故事里展示设备替人干活', sendText: '这是依据产品资料制作的现场小故事。把您的现场和需求发来，一起匹配方案。',
    estimateNote: '定妆照、场景、人物、分镜按图片单价；视频按 Wan3 480P 有声每秒单价；字幕识别另预留。'
  };
}

// What the writer is asked for. Facts are data, not instructions.
// Rules from a customer's video (2026-11-19): a driver appeared on an unmanned robot, a person did by
// hand what the machine does by itself, a person merged into the machine, the ending happened twice.
const UNMANNED_RULE = promptRef("video.story.unmanned");
const CONTACT_RULE = '人物和机器之间始终隔着至少一米，不碰机身，身体不和机器重叠。';
function storyMessages({ productName, facts, scene, segments, feedback = '', unmanned = false }) {
  const system = [
    promptRef("video.story.writer"),
    promptRef("video.story.facts_only"),
    promptRef("video.story.rules"),
    promptRef("video.story.direction"),
    ...(unmanned ? [UNMANNED_RULE, promptRef("video.story.auto_functions")] : []),
    CONTACT_RULE,
    promptRef("video.story.lines_once"),
    `${promptRef("video.story.segment_shots.p1")}${SHOTS_PER_SEGMENT}${promptRef("video.story.segment_shots.p2")}${LINE_LIMIT - 6}${promptRef("video.story.segment_shots.p3")}`,
    segments > 1 ? `一共 ${segments}${promptRef("video.story.multi_segment.p1")}` : promptRef("video.story.single_segment"),
    '只输出 JSON，不要多余文字。'
  ].join('\n');
  const schema = {
    title: '故事标题（10字内）', logline: '一句话讲清这个故事', place: '具体地点：环境、陈设、地面材质和颜色、几处真实的使用痕迹',
    floor: { material: '地面材质和颜色', dirty: '没扫的样子（薄灰、少量碎屑）', clean: '扫干净后的样子（同一块旧地面的干净状态，不是翻新）' },
    light: '光线（场地本来的照明）', background: '背景里各忙各的人或车（一两句）',
    machine: { size: '机器体量，如「约到成人胸口高」', moving: '它怎么动（只写资料里有的部件）' },
    characters: [{ name: '人物名', role: '身份', look: '年龄、性别、长相、服装（普通人，衣服旧但整洁）', voice: '说话方式', prop: '手里的东西' }, { name: '…', role: '…', look: '…', voice: '…', prop: '…' }],
    segments: Array.from({ length: segments }, () => ({ arc: '这一段的情绪走向', shots: [{ time: '0-2', camera: '景别、机位、摄影机怎么动', picture: '画面里发生什么（谁在哪、做什么、机器在哪）', ground: '这一刻地面状态：哪里没扫、哪里干净', lines: [{ who: '人物名', line: '台词', tone: '语气' }], sound: '这一镜的声音' }] }))
  };
  const user = `产品名：${productName}
场景：${scene.name}（${scene.description}）
片长：${segments * SEGMENT_SECONDS} 秒，共 ${segments}${promptRef("video.story.user.p1")}${clean(facts, FACT_LIMIT) || '（没有资料：只展示外形和在现场干活，不写任何性能数字）'}${promptRef("video.story.user.p2")}${JSON.stringify(schema)}${feedback ? `\n上一次写的故事没有通过检查：${clean(feedback, 200)}。请改正后重新输出完整 JSON。` : ''}`;
  return { system, user };
}

function parseTime(value) {
  const match = String(value || '').match(/^(\d{1,2})\s*[-~–]\s*(\d{1,2})/u);
  return match ? [Number(match[1]), Number(match[2])] : null;
}
// Strict enough that a malformed story stops before any paid image.
function parseStory(text, segments) {
  let story;
  try { story = typeof text === 'string' ? JSON.parse(text.replace(/^```(?:json)?|```$/gu, '').trim()) : text; } catch { throw fail('product_video_story_invalid', '故事没有写成可用的格式，没有继续花钱，请重试。'); }
  const need = (value, label, limit = 400) => { const result = clean(value, limit); if (!result) throw fail('product_video_story_invalid', `故事缺少「${label}」，没有继续花钱，请重试。`); return result; };
  const characters = Array.isArray(story?.characters) ? story.characters.slice(0, 2) : [];
  if (characters.length !== 2) throw fail('product_video_story_invalid', '故事需要两个人物，没有继续花钱，请重试。');
  const people = characters.map((person, index) => ({ key: index ? 'b' : 'a', name: need(person.name, '人物名', 8), role: need(person.role, '人物身份', 20),
    look: need(person.look, '人物外貌', 200), voice: clean(person.voice, 80), prop: clean(person.prop, 40) }));
  if (people[0].name === people[1].name) throw fail('product_video_story_invalid', '两个人物重名，没有继续花钱，请重试。');
  if (!Array.isArray(story.segments) || story.segments.length !== segments) throw fail('product_video_story_invalid', `故事需要 ${segments} 段，没有继续花钱，请重试。`);
  const names = new Set(people.map((person) => person.name));
  const parts = story.segments.map((segment, s) => {
    const shots = Array.isArray(segment?.shots) ? segment.shots : [];
    if (shots.length !== SHOTS_PER_SEGMENT) throw fail('product_video_story_invalid', `第 ${s + 1} 段需要 ${SHOTS_PER_SEGMENT} 个镜头，没有继续花钱，请重试。`);
    let cursor = 0, spoken = 0;
    const rows = shots.map((shot, k) => {
      const time = parseTime(shot.time);
      if (!time || time[0] !== cursor || time[1] <= time[0]) throw fail('product_video_story_invalid', `第 ${s + 1} 段第 ${k + 1} 个镜头时间不连续，没有继续花钱，请重试。`);
      cursor = time[1];
      const lines = (Array.isArray(shot.lines) ? shot.lines : []).filter((row) => clean(row?.line, 60)).slice(0, 2).map((row) => {
        const who = clean(row.who, 8), line = clean(row.line, LINE_LIMIT + 10);
        if (!names.has(who)) throw fail('product_video_story_invalid', `台词里出现了故事外的人物「${who}」，没有继续花钱，请重试。`);
        if ([...line].length > LINE_LIMIT) throw fail('product_video_story_invalid', '有一句台词太长，没有继续花钱，请重试。');
        return { who, line, tone: clean(row.tone, 20) };
      });
      spoken += lines.length;
      return { start: time[0], end: time[1], camera: need(shot.camera, '镜头机位', 160), picture: need(shot.picture, '镜头画面', 320), ground: need(shot.ground, '地面状态', 160), lines, sound: clean(shot.sound, 120) };
    });
    if (cursor !== SEGMENT_SECONDS) throw fail('product_video_story_invalid', `第 ${s + 1} 段镜头加起来不是 15 秒，没有继续花钱，请重试。`);
    if (spoken > 5) throw fail('product_video_story_invalid', `第 ${s + 1} 段台词太多，没有继续花钱，请重试。`);
    return { arc: clean(segment.arc, 120), shots: rows };
  });
  return {
    title: need(story.title, '标题', 20), logline: need(story.logline, '一句话故事', 160), place: need(story.place, '地点', 400),
    floor: { material: need(story.floor?.material, '地面材质', 40), dirty: need(story.floor?.dirty, '没扫的地面', 200), clean: need(story.floor?.clean, '扫干净的地面', 200) },
    light: clean(story.light, 160) || '场地本来的照明，光线平淡均匀。', background: clean(story.background, 200),
    machine: { size: clean(story.machine?.size, 60) || '体量与真实产品一致', moving: clean(story.machine?.moving, 160) },
    characters: people, segments: parts
  };
}

const personText = (person) => `${person.name}（${person.role}）：${person.look}${person.prop ? `，手里拿着${person.prop}` : ''}。`;
const machineRule = (story) => `${promptRef("video.story.machine_rule.p1")}${story.machine.size}${promptRef("video.story.machine_rule.p2")}${story.unmanned ? UNMANNED_RULE : ''}${CONTACT_RULE}`;

function sheetPrompt(productName, photos = 1) {
  return `${promptRef("video.story.product_sheet.p1")}${photos > 1 ? `${photos}${promptRef("video.story.sheet_photos.p1")}${productName}${promptRef("video.story.sheet_photos.p2")}` : `参考图是「${productName}」的真实产品照`}${promptRef("video.story.product_sheet.p2")}`;
}
function scenePrompt(story) {
  return `${promptRef("video.story.scene_frame.p1")}${story.place}地面是${story.floor.material}${promptRef("video.story.scene_frame.p2")}${story.floor.dirty}${promptRef("video.story.scene_frame.p3")}${story.light}
${STYLE}
${NEG}`;
}
function floorPrompt(story) {
  return `${promptRef("video.story.floor_compare.p1")}${story.floor.material}${promptRef("video.story.floor_compare.p2")}${story.floor.dirty}${promptRef("video.story.floor_compare.p3")}${story.floor.clean}${promptRef("video.story.floor_compare.p4")}${STYLE}
${NEG}`;
}
function personPrompt(story, person) {
  return `${promptRef("video.story.character_sheet.p1")}${personText(person)}${promptRef("video.story.character_sheet.p2")}${STYLE}
${NEG}`;
}
function framePrompt(story, segmentIndex, shotIndex) {
  const shot = story.segments[segmentIndex].shots[shotIndex];
  const [a, b] = story.characters;
  return `${promptRef("video.story.storyboard_frame.p1")}${a.name}${promptRef("video.story.storyboard_frame.p2")}${b.name}${promptRef("video.story.storyboard_frame.p3")}${machineRule(story)}${promptRef("video.story.storyboard_frame.p4")}${personText(a)}${personText(b)}
画面：${shot.camera}。${shot.picture}
地面：${shot.ground}${promptRef("video.story.storyboard_frame.p5")}${story.floor.dirty}${promptRef("video.story.storyboard_frame.p6")}${story.floor.clean}${promptRef("video.story.storyboard_frame.p7")}${STYLE}
${NEG}`;
}
function videoPrompt(story, segmentIndex) {
  const segment = story.segments[segmentIndex], [a, b] = story.characters;
  const total = story.segments.length;
  const shots = segment.shots.map((shot, k) => `第${k + 1}个镜头[${shot.start}-${shot.end}秒]：对应图4第${k + 1}格。${shot.camera}。${shot.picture} 地面状态：${shot.ground}${shot.lines.length ? ` 台词：${shot.lines.map((row) => `${row.who}（${row.tone || '自然'}）：“${row.line}”`).join(' ')}` : ''}${shot.sound ? ` 声音：${shot.sound}` : ''}`).join('\n');
  const prompt = `${promptRef("video.story.segment_video.p1")}${total > 1 ? `（整个故事的第${segmentIndex + 1}段，共${total}段）` : ''}${promptRef("video.story.segment_video.p2")}${story.logline}
【二、情绪】${segment.arc || '累 → 意外 → 看清楚它怎么干活 → 放心和轻松'}${promptRef("video.story.segment_video.p3")}${a.name}${promptRef("video.story.segment_video.p4")}${b.name}${promptRef("video.story.segment_video.p5")}${story.machine.size}${story.machine.moving ? `，${story.machine.moving}` : ''}。${personText(a)}说话：${a.voice || '普通话，口语自然'}。${personText(b)}说话：${b.voice || '普通话，口语自然'}${promptRef("video.story.segment_video.p6")}${story.place} ${story.light}${story.background ? ` 背景：${story.background}` : ''}${promptRef("video.story.segment_video.p7")}${shots}${promptRef("video.story.segment_video.p8")}${story.unmanned ? UNMANNED_RULE : ''}${CONTACT_RULE}${promptRef("video.story.segment_video.p9")}${story.floor.dirty}${promptRef("video.story.segment_video.p10")}${story.unmanned ? '人坐在或站在机器上、人握方向盘、人推机器、给机器新增座椅或方向盘、' : ''}${promptRef("video.story.segment_video.p11")}`;
  if (promptLength(prompt) > VIDEO_PROMPT_LIMIT) throw fail('product_video_story_invalid', '这一段的拍摄要求太长，没有继续花钱，请重试。');
  return prompt;
}
// All dialogue in order, for subtitles and the record.
const storyScript = (story) => story.segments.flatMap((segment) => segment.shots.flatMap((shot) => shot.lines.map((row) => row.line))).join('。');

module.exports = { STORY_VERSION, IMAGE_MODEL, SEGMENT_SECONDS, STORY_SECONDS, SHOTS_PER_SEGMENT, VIDEO_PROMPT_LIMIT,
  planStoryVideo, storyMessages, parseStory, sheetPrompt, scenePrompt, floorPrompt, personPrompt, framePrompt, videoPrompt, storyScript };
