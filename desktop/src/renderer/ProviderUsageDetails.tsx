import { useState } from "react";

type UsageCall = {
  call_id: string; purpose: string; kind: string; model: string; outcome: string;
  started_at: string; attempt: number; correction_attempt: number; elapsed_ms: number | null;
  request_id: string; client_request_id: string; log_id: string;
  input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null;
  billed_characters: number | null; requested_characters: number | null; audio_ms: number | null;
};
export type ProviderUsage = { items: UsageCall[]; totals: Record<string, number | null>; truncated: boolean; amount: null };
const outcomes: Record<string, string> = { succeeded: "已完成", rejected: "请求被拒绝", failed: "失败", invalid_response: "返回内容无效", outcome_unknown: "结果未知" };
const number = (value: number | null | undefined) => value == null ? "未知" : value.toLocaleString("zh-CN");

export function ProviderUsageDetails({ taskId, batchId }: { taskId: string | null; batchId: string | null }) {
  const [data, setData] = useState<ProviderUsage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (busy || (!taskId && !batchId)) return;
    setBusy(true); setError("");
    try {
      const result = await window.xiaoxiContent?.productions.usage(batchId ? { batchId } : { taskId: taskId! });
      if (!result?.ok || !result.data) throw new Error(result?.error || "暂时无法读取用量");
      setData(result.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法读取用量"); }
    finally { setBusy(false); }
  };
  const total = (key: string) => {
    const value = data?.totals[key]; const unknown = data?.totals[`unknown_${key}_calls`];
    return unknown ? value == null ? `未知（${unknown} 次未返回）` : `已知 ${number(value)}，另 ${unknown} 次未知` : number(value);
  };
  return <details className="studio-production-steps provider-usage" onToggle={(event) => { if (event.currentTarget.open) void load(); }}>
    <summary>调用用量</summary>
    <p>{batchId ? "本批次全部已记录请求" : "当前制作步骤的已记录请求"}。缺失用量显示未知，实际金额以服务平台账单为准。</p>
    {busy && <p role="status">正在读取…</p>}{error && <p role="alert">{error}</p>}
    {data && (data.totals.calls ? <>
      <p>共 {data.totals.calls} 次请求 · 成功 {data.totals.succeeded_calls} · 拒绝 {data.totals.rejected_calls} · 失败 {data.totals.failed_calls} · 内容无效 {data.totals.invalid_response_calls} · 结果未知 {data.totals.outcome_unknown_calls}</p>
      <p>输入 {total("input_tokens")} / 输出 {total("output_tokens")} / 缓存 {total("cached_tokens")} token</p>
      <p>配音计费字符 {data.totals.tts_calls ? total("billed_characters") : "未调用"} · 识别音频 {data.totals.asr_calls ? `${total("audio_ms")} 毫秒` : "未调用"}</p>
      <ol>{data.items.map((call) => <li key={call.call_id}>
        <strong>{call.purpose || call.kind} · {outcomes[call.outcome] || "未知"}</strong>
        <span>{call.model} · 第 {call.attempt} 次请求 / 第 {call.correction_attempt} 轮内容校正 · {number(call.elapsed_ms)} 毫秒</span>
        <span>{call.kind === "llm" ? `输入 ${number(call.input_tokens)} / 输出 ${number(call.output_tokens)} / 缓存 ${number(call.cached_tokens)} token` : call.kind === "tts" ? `提交 ${number(call.requested_characters)} 字符 / 平台计费 ${number(call.billed_characters)} 字符` : `识别音频 ${number(call.audio_ms)} 毫秒`}</span>
        <span>请求标识：{call.request_id || call.client_request_id || "平台未返回"}{call.log_id ? ` · 日志标识 ${call.log_id}` : ""}</span>
      </li>)}</ol>
      {data.truncated && <p>仅显示最近 {data.items.length} 次明细，上方汇总包含全部已记录请求。</p>}
    </> : <p>还没有请求用量记录。记录功能启用前的历史调用不追溯估算。</p>)}
  </details>;
}
