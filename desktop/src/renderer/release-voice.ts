// Turns a release note into what the mascot says (user decisions 2026-11-09). Everything here is derived
// from the note itself, so a release needs no extra writing to get its warm presentation.

export type VoiceGroup = { title: string; items: string[] };
export type ReleaseVoice = { opener: string; highlight: string; groups: VoiceGroup[]; caveats: string[] };

const LEARNED = "我学会的新本领", FIXED = "帮你修好的", SMOOTHER = "让你更顺手的";
const FIX_WORDS = /修复|修好|解决|不再|不会再|恢复/;
const NEW_WORDS = /新增|上线|可以|支持|换成|加上|能看到|能够|现在能/;
const OPENERS = {
  learned: ["这次我又学会了新本领，以后这些事交给我～", "我偷偷练了一阵子，这回能帮你多做点事啦～", "又长本事啦！快看看我这次会了什么～"],
  fixed: ["你反馈的小毛病，我都帮你修好啦～", "之前让你费心的地方，我这次收拾好了～", "这回没学新花样，专心帮你把问题修好了～"],
  smoother: ["这次我把细节又打磨了一遍，用起来会更顺手～", "你可能一眼看不出来，但我悄悄变好用了～", "每一处小地方，我都想让你用得更省心～"]
};

const bullets = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("•")).map((line) => line.replace(/^•\s*/, ""));

export function groupOf(item: string) {
  if (FIX_WORDS.test(item)) return FIXED;
  return NEW_WORDS.test(item) ? LEARNED : SMOOTHER;
}

function steadyPick(list: string[], version: string) {
  let sum = 0;
  for (const char of version) sum += char.charCodeAt(0);
  return list[sum % list.length];
}

export function releaseVoice(version: string, notes: string): ReleaseVoice {
  const [body, cautions = ""] = String(notes || "").split("验证范围与注意事项");
  // Notes normally come as bullet lines; anything else is still shown rather than dropped.
  const lines = body.split("\n").map((line) => line.trim()).filter((line) => line && !line.endsWith("更新内容"));
  const items = bullets(body).length ? bullets(body) : lines;
  const groups = [LEARNED, FIXED, SMOOTHER].map((title) => ({ title, items: items.filter((item) => groupOf(item) === title) })).filter((group) => group.items.length);
  const kind = groups.some((group) => group.title === LEARNED) ? "learned" : groups.some((group) => group.title === FIXED) ? "fixed" : "smoother";
  return { opener: steadyPick(OPENERS[kind], version), highlight: items[0] || "", groups, caveats: bullets(cautions) };
}
