// Text pasted from WeChat/Moments carries emoji and sticker codes. Voice synthesis
// reads some of them as extra words (2026-11-06: "——🤖" became "明明", "✅…——"
// became "满陇"), so the transcript check then rightly refuses to buy the video.
// Clean only what is never meant to be spoken; keep every real word, date, range
// and product name (review 2026-11-06: [重要], 2026/11/06, 10–20元, C++ must survive).

// WeChat's built-in sticker names, as they appear when copied ("[月亮]"). Only these
// are removed, so a real bracketed word such as [重要] or [AI] is kept.
const WECHAT_STICKERS = new Set(('微笑 撇嘴 色 发呆 得意 流泪 害羞 闭嘴 睡 大哭 尴尬 发怒 调皮 呲牙 惊讶 难过 酷 冷汗 抓狂 吐 偷笑 愉快 白眼 傲慢 饥饿 困 惊恐 流汗 憨笑 悠闲 奋斗 咒骂 疑问 嘘 晕 疯了 衰 骷髅 敲打 再见 擦汗 抠鼻 鼓掌 糗大了 坏笑 左哼哼 右哼哼 哈欠 鄙视 委屈 快哭了 阴险 亲亲 吓 可怜 菜刀 西瓜 啤酒 篮球 乒乓 咖啡 饭 猪头 玫瑰 凋谢 嘴唇 爱心 心碎 蛋糕 闪电 炸弹 刀 足球 瓢虫 便便 月亮 太阳 礼物 拥抱 强 弱 握手 胜利 抱拳 勾引 拳头 差劲 爱你 NO OK 爱情 飞吻 跳跳 发抖 怄火 转圈 磕头 回头 跳绳 投降 激动 乱舞 献吻 左太极 右太极 '
  + '嘿哈 捂脸 奸笑 机智 皱眉 耶 吃瓜 加油 汗 天啊 Emm 社会社会 旺柴 好的 打脸 哇 翻白眼 666 让我看看 叹气 苦涩 裂开 合十 庆祝 烟花 红包 發 福 鞭炮 爆竹 失望 无语 生病 破涕为笑 脸红 恐惧 笑脸 吐舌 Party 囧 Yeah').split(' '));

function cleanSpokenScript(value) {
  return String(value || '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\[([^\[\]\n]{1,8})\]/gu, (whole, name) => WECHAT_STICKERS.has(name) ? '' : whole)
    // Emoji, flags, skin tones, keycap marks, variation selectors and joiners.
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️‍⃣]/gu, '')
    // A dash between numbers is a range ("10–20元", "9:00—18:00"): say 到.
    .replace(/(\d)[ \t]*(?:[—–]+|-{2,})[ \t]*(?=\d)/gu, '$1到')
    // Any other dash is read aloud or as filler; a pause is what the writer meant.
    .replace(/[—–]+|-{2,}/gu, '，')
    // "清洁机器人+AI" is read 加; formulas and names like "C++", "1+1" are left alone.
    .replace(/(\p{Script=Han})[ \t]*\+[ \t]*(?=[\p{Script=Han}A-Za-z0-9])/gu, '$1加')
    .replace(/([A-Za-z0-9])[ \t]*\+[ \t]*(?=\p{Script=Han})/gu, '$1加')
    // "11月20/21/22": three or more short numbers form a list; dates such as 2026/11/06 and "3/5" stay.
    .replace(/(?<![\d/])\d{1,2}(?:[ \t]*\/[ \t]*\d{1,2}){2,}(?![\d/])/gu, (list) => list.split('/').map((part) => part.trim()).join('、'))
    .split('\n').map((line) => line.replace(/[ \t]{2,}/gu, ' ').trim()
      // A pause mark left at the start of a line, or doubled with another mark.
      .replace(/^[，、；：]+/u, '').replace(/[，、]+(?=[，、。！？；：!?])/gu, '').replace(/([。！？!?])[，、]+/gu, '$1'))
    // One paragraph, as before; a line that ends without a mark gets a pause so sentences do not run together.
    .filter(Boolean).reduce((text, line) => !text ? line : /[。！？!?，、；：…,.;:]$/u.test(text) ? text + line : `${text}，${line}`, '').trim();
}

module.exports = { cleanSpokenScript, WECHAT_STICKERS };
