// 精准触达：发消息时由小玺说出“谁在干哪一步”（用户 2026-11-24：触达时主窗口被微信挡住，工作台看不到，
// 搬进小玺）。角色只由执行器真实报的段与步骤决定；认不出的步骤不派角色。
// 执行器按“段”发送：先文字，再一张张图片，最后网址；每段开头都会重新准备联系人、核对当前聊天，
// 所以先看正在发哪一段：图片段、网址段整段由发图员/发送员负责，只有文字段才分找人/核对/发文字。
export type TouchStep = { stage: string; partKind: string };

const WRITE = new Set(["draft_generation"]);
const FIND = new Set(["prepare_contact", "contact_send", "select-customer", "calibrate", "prepare_window", "click-search-result-dry-run"]);
const VERIFY = new Set(["verify_session", "session_reuse", "session_reuse_verify"]);
const CONFIRM = new Set(["after_send_confirmation", "part_complete"]);

export function touchRole({ stage, partKind }: TouchStep): string {
  if (WRITE.has(stage)) return "文案";
  if (partKind === "image") return "发图员";
  if (partKind === "link") return "发送员";
  if (CONFIRM.has(stage)) return "核验员";
  if (FIND.has(stage)) return "搜索员";
  if (VERIFY.has(stage)) return "核对员";
  return partKind === "text" && stage ? "发送员" : "";
}
