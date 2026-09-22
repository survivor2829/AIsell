import React, { useEffect, useState } from "react";
import "./VideoPresentation.css";

export type VideoTemplate = "topic_fixed" | "key_points";
export function VideoTemplatePicker({ value, onChange, disabled = false }: { value: VideoTemplate; onChange: (value: VideoTemplate) => void; disabled?: boolean }) {
  return <fieldset className="video-template-picker" disabled={disabled}><legend>视频样式</legend><div>
    {([{ id: "topic_fixed", title: "主题常驻", sample: "一句话，说清价值" }, { id: "key_points", title: "分段要点", sample: "01 · 先看产品细节" }] as const).map((item) =>
      <button type="button" key={item.id} aria-pressed={value === item.id} className={value === item.id ? "is-selected" : ""} onClick={() => onChange(item.id)}>
        <span className="video-template-preview"><strong>{item.sample}</strong><span><b>重点</b> 跟着口播走</span></span><span>{item.title}</span>
      </button>)}
  </div></fieldset>;
}

type CoverVideo = { generatedVideoId: string; title: string; coverStatus?: string | null; coverHeadlineLines?: string[]; coverTitleEditable?: boolean; coverIssueMessage?: string | null };
type Result<T> = { ok: boolean; data?: T; error?: string };
type CoverApi = {
  getGenerated: (payload: { candidateId: string }) => Promise<Result<CoverVideo>>;
  regenerateCover: (payload: { candidateId: string }) => Promise<Result<unknown>>;
  updateCoverTitle: (payload: { candidateId: string; headlineLines: string[] }) => Promise<Result<CoverVideo>>;
  downloadCandidate: (payload: { candidateId: string; variant: "thumbnail" }) => Promise<Result<{ canceled?: boolean }>>;
};

export function VideoCoverDetails({ generatedId }: { generatedId: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>预览与调整封面</summary>{open && <VideoCoverPanel key={generatedId} generatedId={generatedId} />}</details>;
}

export function VideoCoverPanel({ generatedId }: { generatedId: string }) {
  const [video, setVideo] = useState<CoverVideo | null>(null);
  const [lines, setLines] = useState<string[]>(["", ""]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const api = () => (window.xiaoxiContent as unknown as { creative: CoverApi }).creative;
  useEffect(() => {
    let active = true;
    let lastStatus: string | null | undefined;
    const read = async () => {
      try {
        const result = await api().getGenerated({ candidateId: generatedId });
        if (!result.ok) throw new Error(result.error || "封面信息暂不可用。");
        const item = result.data;
        if (!active || !item) return;
        if (lastStatus !== item.coverStatus) setRevision((count) => count + 1);
        lastStatus = item.coverStatus;
        setVideo(item);
        if (item.coverStatus === "completed") {
          setNotice((current) => current === "封面正在处理，视频可以继续使用。" ? "" : current);
        }
        setLines((previous) => previous.every((line) => !line) ? [...(item.coverHeadlineLines || []), ""].slice(0, 2) : previous);
      } catch (error) { if (active) setNotice((error as Error).message); }
    };
    void read();
    const timer = window.setInterval(() => void read(), 4500);
    return () => { active = false; window.clearInterval(timer); };
  }, [generatedId]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setNotice(""); try { await action(); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } };
  const pending = video?.coverStatus === "planned" || video?.coverStatus === "submitted";
  return <section className="video-cover-panel" aria-label="视频封面"><div className="video-cover-preview"><img src={`xiaoxi-content://generated/${generatedId}/thumbnail?v=${revision}`} alt="当前视频封面" /></div><div className="video-cover-controls"><h3>视频封面</h3>
    <button type="button" disabled={busy || !video} onClick={() => void run(async () => {
      const result = await api().downloadCandidate({ candidateId: generatedId, variant: "thumbnail" });
      if (!result.ok) throw new Error(result.error || "封面保存未完成。");
      if (!result.data?.canceled) setNotice("封面已保存。");
    })}>保存封面</button>
    {video?.coverTitleEditable && <><label>第一行<input maxLength={12} value={lines[0] || ""} onChange={(event) => setLines([event.target.value, lines[1] || ""])} /></label><label>第二行<input maxLength={12} value={lines[1] || ""} onChange={(event) => setLines([lines[0] || "", event.target.value])} /></label><button type="button" disabled={busy || !lines[0]?.trim()} onClick={() => void run(async () => {
      const result = await api().updateCoverTitle({ candidateId: generatedId, headlineLines: lines.map((line) => line.trim()).filter(Boolean) });
      if (!result.ok) throw new Error(result.error || "标题未保存。");
      if (result.data) setVideo(result.data);
      setRevision((count) => count + 1); setNotice("标题已更新。");
    })}>保存标题</button><small>只调整文字，沿用当前底图。</small></>}
    <button type="button" disabled={busy || video?.coverStatus === "outcome_unknown"} onClick={() => void run(async () => {
      const result = await api().regenerateCover({ candidateId: generatedId });
      if (!result.ok) throw new Error(result.error || "封面暂未开始生成。");
      setVideo((previous) => previous ? { ...previous, coverStatus: "planned" } : previous);
      setNotice("封面正在处理，视频可以继续使用。");
    })}>{pending ? "继续处理封面" : video?.coverStatus === "completed" ? "重新生成封面" : "生成／重试封面"}</button>
    {video?.coverIssueMessage && <p role="status">{video.coverIssueMessage}</p>}
    {notice && <p role="status">{notice}</p>}
  </div></section>;
}
