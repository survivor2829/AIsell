const VERSION = '2';

function productDirection({ scene, surface, facts, mode }) {
  const audience = mode === 'social' ? '正在寻找清洁设备或清洁方案的人' : '需要判断设备是否适合现场的客户';
  return {
    concept: `给${audience}看${scene.name}的${surface.name}现场及产品真实外观。`,
    photography: '竖屏9:16；中景交代现场，近景核对可见结构，缓慢平移或小幅推进；产品始终保持真实体量和空间关系。',
    visual: '真实商业摄影；中性白平衡，保留地面原有材质纹理和产品原图颜色；不以过饱和滤镜掩盖细节。',
    lighting: '以场景可解释的自然光或顶灯为主光，柔和补光看清设备，阴影方向始终一致。',
    activity: facts ? '仅依据已提供的产品事实安排设备动作；动作不可从外观照片推断。' : '设备静置，展示整体与可见细节；不演示作业或清洁前后。',
    sound: mode === 'social' ? '自然普通话旁白提出一个现场问题，环境声轻而真实；不自动添加背景音乐。' : '自然普通话讲解现场与产品，环境声轻而真实；不自动添加背景音乐。',
    negative: '不改变产品造型、颜色、标识和零件；不添加虚构操作者、参数、污渍消失效果、校名院名、字幕、水印或乱码。'
  };
}

function humanDirection({ scene, voice }) {
  return {
    concept: '由已授权的本人形象向客户介绍真实产品，重点是让人看清人物、产品和用途。',
    character: '以已审核的人物参考校准脸型、年龄、发型、服装和真实肤色；保持产品与人物的实际体量关系。',
    photography: '竖屏9:16；稳定平视中景，人物与产品同框；仅在真实细节可辨时切近景。',
    visual: '自然肤色，避免过度磨皮、美白、塑料质感和不合理的高饱和度；产品颜色以原图为准。',
    lighting: '柔和主光照亮面部与产品，少量补光保留皮肤纹理；场景中光源和阴影方向一致。',
    activity: `${scene.action}；只做简短指向、点头和自然手势，不遮挡产品、字幕空间或口型。`,
    sound: `${voice.prompt}；完整读出用户确认的文案，口型同步，无额外台词、背景音乐和多余人声。`,
    negative: '不换脸、不改变年龄或肤色、不新增产品按钮和功效；大型设备不拿起，不生成多余人物、字幕、水印和乱码。'
  };
}

module.exports = { VERSION, productDirection, humanDirection };
