const crypto = require("node:crypto");

const UNKNOWN = new Set(["sending", "prepared", "clicked", "outcome_unknown"]);
function messageParts(message, imageIds = [], link = "") {
  return [
    { kind: "text", message },
    ...imageIds.map((imageId) => ({ kind: "image", imageId })),
    ...(link ? [{ kind: "link", message: link }] : [])
  ];
}
function partSignature(part) {
  return crypto.createHash("sha256").update(JSON.stringify(part)).digest("hex");
}
function canContinueSequence(row) {
  return Array.isArray(row?.message_parts) && row.message_parts.length > 0
    && row.message_parts.every((part) => ["pending", "not_attempted", "sent_verified"].includes(part.status));
}

async function executeMessageSequence({ row, parts, execute, persist, isEnabled }) {
  const signatures = parts.map(partSignature);
  if (!row.message_parts) {
    row.message_parts = parts.map((part, index) => ({ kind: part.kind, signature: signatures[index], status: "pending" }));
    persist();
  }
  if (row.message_parts.length !== parts.length || row.message_parts.some((part, index) => part.signature !== signatures[index])) {
    return { ok: false, send_attempted: null, blocked_reason: "touch_sequence_changed", error: "触达内容与已开始的记录不一致，已停止发送。" };
  }
  for (let index = 0; index < parts.length; index += 1) {
    const part = row.message_parts[index];
    if (part.status === "sent_verified") continue;
    const label = part.kind === "text" ? "文字" : part.kind === "link" ? "网址" : `第 ${index} 张图片`;
    if (UNKNOWN.has(part.status) || !["pending", "not_attempted"].includes(part.status)) {
      return { ok: false, send_attempted: null, blocked_reason: "touch_part_outcome_unknown", error: `${label}的发送结果未确认，请查看微信；不会自动补发。` };
    }
    if (!isEnabled()) return { ok: false, send_attempted: false, blocked_reason: "workflow_paused", error: "已暂停，已发出的内容会保留。" };
    part.status = "sending";
    persist();
    let result;
    try {
      result = await execute(parts[index], index, (status) => {
        if (!["prepared", "clicked", "sent_verified", "not_attempted", "outcome_unknown"].includes(status)) return;
        part.status = status;
        persist();
      });
    } catch {
      part.status = "outcome_unknown";
      persist();
      return { ok: false, send_attempted: null, blocked_reason: "touch_part_exception", error: `${label}执行中断，结果未确认；不会自动补发。` };
    }
    if (result?.ok && result?.state?.real_send_status === "sent_verified") {
      part.status = "sent_verified";
      part.completedAt = new Date().toISOString();
      persist();
      continue;
    }
    // A persisted confirmed receipt wins over a late failure after confirmation.
    if (part.status === "sent_verified") continue;
    const notAttempted = result?.send_attempted === false && !["clicked", "outcome_unknown"].includes(part.status);
    part.status = notAttempted ? "not_attempted" : "outcome_unknown";
    persist();
    return { ...result, ok: false, send_attempted: notAttempted ? false : null,
      error: `${label}${notAttempted ? "尚未发送" : "发送结果未确认"}。${result?.error || result?.blocked_reason || "请检查微信后处理任务。"} 已发出的内容不会重复发送。` };
  }
  return { ok: true, send_attempted: true, state: { real_send_status: "sent_verified" } };
}

module.exports = { executeMessageSequence, messageParts, canContinueSequence };
