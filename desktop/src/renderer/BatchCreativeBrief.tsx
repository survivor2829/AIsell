import { Check, Film } from "lucide-react";
import { AssetThumb } from "./BatchAssets";
import type { Asset, Batch, Candidate } from "./batch-studio-api";

export type CreativeBrief = { target_audience: string; expression: string; script_source: "ideas" | "provided" };
export const emptyCreativeBrief = (): CreativeBrief => ({ target_audience: "", expression: "", script_source: "ideas" });
export function expressionText(value?: { expression?: string; advantages?: string; customer_pain_points?: string; description?: string; material_context?: string }): string {
  const expression = value?.expression !== undefined ? value.expression : [value?.advantages && `产品／服务优势：${value.advantages}`, value?.customer_pain_points && `客户痛点：${value.customer_pain_points}`].filter(Boolean).join("\n\n");
  return [expression, value?.description, value?.material_context].filter((text, index, all) => text && all.indexOf(text) === index).join("\n\n");
}

export function BatchCreativeBrief({ value, onChange, cta, onCtaChange, suggestions }: {
  value: CreativeBrief; onChange: (value: CreativeBrief) => void;
  cta: string; onCtaChange: (value: string) => void; suggestions?: Batch["brief_suggestions"];
}) {
  return <section className="batch-creative-brief" aria-label="创作需求">
    <label><span>给谁看？ <span className="batch-field-note">必填</span></span>
      <input required aria-label="目标客户群体" value={value.target_audience} maxLength={150}
        placeholder="例如：物业保洁负责人、清洁设备经销商" aria-describedby="batch-audience-help"
        onChange={(event) => onChange({ ...value, target_audience: event.target.value })} />
      <small id="batch-audience-help" className="batch-hint">写具体的人群，以及他们关心的问题，帮助文案贴近观众。</small>
    </label>
    <div className="batch-brief-field"><label><span>想讲什么？ <span className="batch-field-note">选填</span></span>
      <textarea aria-label="你想表达什么" aria-describedby="batch-expression-help" value={value.expression} maxLength={14000} rows={4}
        placeholder="可以直接粘贴完整文案，也可以写零碎想法、口语要点或真实经历"
        onChange={(event) => onChange({ ...value, expression: event.target.value })} /></label>
      <p id="batch-expression-help" className="batch-hint">已有完整文案，勾选下方选项后保留原文；零碎想法会按你的方向整理。涉及人物或经历，请注明对应素材。</p>
      <label className="batch-provided-script"><input type="checkbox" checked={value.script_source === "provided"} onChange={(event) => onChange({ ...value, script_source: event.target.checked ? "provided" : "ideas" })} /><span>这是完整文案，保留原文</span></label>
      {value.script_source === "provided" && <small className="batch-hint">直接进入文案确认，不调用 AI 写稿。当前支持 2400 字以内；制作前仍会核对素材与实际时长。</small>}
      {!value.expression.trim() && expressionText(suggestions) && <details className="batch-inline-suggestion"><summary>查看 AI 建议</summary>
        <p>{expressionText(suggestions)}</p><button type="button" onClick={() => onChange({ ...value, expression: expressionText(suggestions) })}>采用并修改</button>
        <small>采用后重新生成选题，也可以跳过。</small>
      </details>}
    </div>
    <details className="batch-brief-optional" hidden={value.script_source === "provided"}><summary>结尾引导{cta ? " · 已填写" : " · 选填"}</summary>
      <label><span>希望观众做什么？</span><input aria-label="结尾引导" value={cta} maxLength={300} placeholder="例如：留言聊聊你关心的问题"
        onChange={(event) => onCtaChange(event.target.value)} />
    </label></details>
  </section>;
}

export function BatchTopicChoices({ options, selected, locked, selectionLocked, onSelect, onEdit, assets = [], mode = "both" }: {
  options: Candidate[]; selected?: string; locked: boolean; selectionLocked?: boolean;
  onSelect: (id: string) => void; onEdit: (candidate: Candidate) => void;
  assets?: Asset[]; mode?: "choices" | "review" | "both";
}) {
  const chosen = options.find((option) => option.candidate_id === selected);
  const previewFor = (option: Candidate, index = 0) => {
    const matching = assets.filter((asset) => (option.actual_shots || option.shots || []).some((shot) => shot.asset_id === asset.assetId));
    const available = matching.length ? matching : assets;
    return available.length ? available[index % available.length] : undefined;
  };
  return <>
    {mode !== "review" && <div className="batch-topic-choices" role="radiogroup" aria-label="选择一个选题方案">
      {options.map((option, index) => <label className={`batch-topic-choice batch-topic-visual${selected === option.candidate_id ? " is-selected" : ""}`} key={option.candidate_id}>
        <span className="batch-topic-image">{previewFor(option, index) ? <AssetThumb asset={previewFor(option, index)!} /> : <Film size={44} strokeWidth={1.3} />}
          <span className="batch-topic-image-caption">素材预览</span>
          {selected === option.candidate_id && <span className="batch-topic-selected"><Check size={18} /></span>}
        </span>
        <span className="batch-topic-copy">
        <span className="batch-topic-label"><input type="radio" name="batch-topic" checked={selected === option.candidate_id} disabled={locked || selectionLocked}
          onChange={() => onSelect(option.candidate_id)} /><span>方案 {index + 1}{option.framework === "problem_solution_cta" ? " · 问题解答" : ""}</span></span>
        <strong>{option.title}</strong><span>{option.summary || option.angle}</span>
        <span className="batch-topic-opening">{option.opening_example || option.narration.split(/[。！？!?]/)[0]}</span>
        </span>
      </label>)}
    </div>}
    {mode !== "choices" && chosen && <section className="batch-selected-copy" aria-label="确认完整文案">
      <header><div><h3>{chosen.title}</h3></div>
        <button type="button" disabled={locked} onClick={() => onEdit(chosen)}>修改文案</button></header>
      <div className="batch-copy-review-layout">
        <div className="batch-copy-review-image">{previewFor(chosen) ? <AssetThumb asset={previewFor(chosen)!} /> : <Film size={48} />}<span>将使用你的真实素材</span></div>
        <div><p className="batch-script-body">{chosen.narration}</p><small>预计 {Math.round((chosen.estimated_duration_ms || chosen.duration_ms || 0) / 1000)} 秒</small></div>
      </div>
    </section>}
  </>;
}
