
const { promptRef } = require("../../../shared/prompt-ref.cjs");const VERSION = '3';

function productDirection({ scene, surface, facts, mode }) {
  const audience = mode === 'social' ? '正在寻找清洁设备或清洁方案的人' : '需要判断设备是否适合现场的客户';
  return {
    concept: `给${audience}看${scene.name}的${surface.name}现场及产品真实外观。`,
    photography: promptRef("video.skill.product.photography"),
    visual: promptRef("video.skill.product.visual"),
    lighting: promptRef("video.skill.product.lighting"),
    activity: facts ? '仅依据已提供的产品事实安排设备动作；动作不可从外观照片推断。' : '设备静置，展示整体与可见细节；不演示作业或清洁前后。',
    sound: promptRef("video.skill.product.sound"),
    negative: promptRef("video.skill.product.negative")
  };
}

function humanDirection({ scene, voice }) {
  return {
    concept: promptRef("video.skill.human.concept"),
    character: promptRef("video.skill.human.character"),
    photography: promptRef("video.skill.human.photography"),
    visual: promptRef("video.skill.human.visual"),
    lighting: promptRef("video.skill.human.lighting"),
    activity: `${scene.action}；只做简短指向、点头和自然手势，不遮挡产品、字幕空间或口型。`,
    sound: `${voice.prompt}；完整读出用户确认的文案，口型同步，无额外台词、背景音乐和多余人声。`,
    negative: promptRef("video.skill.human.negative")
  };
}

module.exports = { VERSION, productDirection, humanDirection };
