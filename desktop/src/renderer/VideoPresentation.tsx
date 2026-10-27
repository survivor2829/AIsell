import React, { useState } from "react";
import "./VideoPresentation.css";

export type VideoTemplate = "topic_fixed" | "key_points";
export function VideoTemplatePicker({ value, onChange, disabled = false }: { value: VideoTemplate; onChange: (value: VideoTemplate) => void; disabled?: boolean }) {
  return <fieldset className="video-template-picker" disabled={disabled}><legend>字幕样式</legend><div>
    {([{ id: "topic_fixed", title: "主题常驻", sample: "一句话，说清价值" }, { id: "key_points", title: "分段要点", sample: "01 · 先看产品细节" }] as const).map((item) =>
      <button type="button" key={item.id} aria-pressed={value === item.id} className={value === item.id ? "is-selected" : ""} onClick={() => onChange(item.id)}>
        <span className="video-template-preview"><strong>{item.sample}</strong><span><b>重点</b> 跟着口播走</span></span><span>{item.title}</span>
      </button>)}
  </div></fieldset>;
}

type Result<T> = { ok: boolean; data?: T; error?: string };
export function VideoDownloadButton({ generatedId }: { generatedId: string }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const saving = React.useRef(false);
  const download = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setNotice("");
    try {
      const api = (window.xiaoxiContent as unknown as { creative?: {
        downloadCandidate: (payload: { candidateId: string }) => Promise<Result<{ canceled?: boolean; filename?: string }>>;
      } })?.creative;
      if (!api?.downloadCandidate) throw new Error("下载功能尚未加载，请重启软件后再试。");
      const result = await api.downloadCandidate({ candidateId: generatedId });
      if (!result.ok || !result.data) throw new Error(result.error || "视频未保存成功，请重试。");
      if (!result.data.canceled) setNotice(`已保存视频：${result.data.filename || "视频.mp4"}`);
    } catch (error) { setNotice((error as Error).message || "视频未保存成功，请重试。"); }
    finally { saving.current = false; setBusy(false); }
  };
  return <><button type="button" disabled={busy} onClick={() => void download()}>{busy ? "保存中…" : "下载视频"}</button>{notice && <p role="status">{notice}</p>}</>;
}

