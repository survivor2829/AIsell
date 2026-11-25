// 精准触达在小玺卡片里的进度（用户 2026-11-24 选 C 版：不写“搜索员/发送员”这类角色，卡片常驻、原地更新，
// 下面滚动最近三步）。执行器一秒内会报好几个细步骤，这里只归成几大步，大步骤变了日志才添一行。
// 执行器按“段”发送：先文字，再一张张图片，最后网址；每段开头都会重新准备联系人、核对当前聊天，
// 所以先看正在发哪一段：图片段、网址段整段算一步，只有文字段才分找人 / 核对 / 发文字。认不出的步骤返回空，不添行。
export type TouchStep = { stage: string; partKind: string; partIndex?: number };

const WRITE = new Set(["draft_generation"]);
const FIND = new Set(["prepare_contact", "contact_send", "select-customer", "calibrate", "prepare_window", "click-search-result-dry-run"]);
const VERIFY = new Set(["verify_session", "session_reuse", "session_reuse_verify"]);
const CONFIRM = new Set(["after_send_confirmation", "part_complete", "post_confirm"]);

export function touchPhase({ stage, partKind, partIndex }: TouchStep): string {
  if (WRITE.has(stage)) return "准备文字";
  // partIndex counts the text as part 1, so the first picture is part 2 (same rule as the page's detail line).
  if (partKind === "image") return `发第 ${Math.max(1, (partIndex || 2) - 1)} 张图片`;
  if (partKind === "link") return "发网址";
  if (CONFIRM.has(stage)) return "确认文字已发出";
  if (FIND.has(stage)) return "找这位客户";
  if (VERIFY.has(stage)) return "核对聊天对象";
  return partKind === "text" && stage ? "发文字" : "";
}
