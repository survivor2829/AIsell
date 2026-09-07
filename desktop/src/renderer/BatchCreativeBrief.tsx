import type { Batch, Candidate } from "./batch-studio-api";

export type CreativeBrief = { target_audience: string; expression: string };
export const emptyCreativeBrief = (): CreativeBrief => ({ target_audience: "", expression: "" });
export function expressionText(value?: { expression?: string; advantages?: string; customer_pain_points?: string }): string {
  if (value?.expression !== undefined) return value.expression;
  return [value?.advantages && `产品／服务优势：${value.advantages}`, value?.customer_pain_points && `客户痛点：${value.customer_pain_points}`].filter(Boolean).join("\n\n");
}

export function BatchCreativeBrief({ value, onChange, cta, onCtaChange, suggestions }: {
  value: CreativeBrief; onChange: (value: CreativeBrief) => void;
  cta: string; onCtaChange: (value: string) => void; suggestions?: Batch["brief_suggestions"];
}) {
  return <section className="batch-creative-brief" aria-label="创作需求">
    <h2>这条视频想打动谁？</h2>
    <label><span>目标客户群体 <span className="batch-field-note">必填</span></span>
      <input required aria-label="目标客户群体" value={value.target_audience} maxLength={150}
        placeholder="这条视频想给谁看？例如渠道商、物业保洁负责人"
        onChange={(event) => onChange({ ...value, target_audience: event.target.value })} />
    </label>
    <div className="batch-brief-field"><label><span>你想表达什么 <span className="batch-field-note">选填</span></span>
      <textarea aria-label="你想表达什么" aria-describedby="batch-expression-help" value={value.expression} maxLength={4000} rows={5}
        placeholder="可以介绍素材里的人、事情背景，以及你想讲的重点。比如：这位学员是谁、为什么来学、现场学了什么；你的服务如何回应他的困扰。"
        onChange={(event) => onChange({ ...value, expression: event.target.value })} /></label>
      <p id="batch-expression-help" className="batch-hint">人物身份、经历背景、优势、痛点或故事重点都可以写，不用按固定格式。涉及谁、哪段素材时，请写清对应关系。</p>
      {!value.expression.trim() && expressionText(suggestions) && <details className="batch-inline-suggestion"><summary>查看 AI 建议</summary>
        <p>{expressionText(suggestions)}</p><button type="button" onClick={() => onChange({ ...value, expression: expressionText(suggestions) })}>采用并修改</button>
        <small>采用后重新生成选题，也可以跳过。</small>
      </details>}
    </div>
    <label><span>结尾引导 <span className="batch-field-note">选填</span></span>
      <input aria-label="结尾引导" value={cta} maxLength={300} placeholder="希望观众做什么？如：评论77，领取我准备的设备选型表"
        onChange={(event) => onCtaChange(event.target.value)} />
    </label>
    <p className="batch-hint">只填客户群体也可以。AI 会依据素材准备选题；人物姓名、经历等不清楚的信息不会自行补写。</p>
  </section>;
}

export function BatchTopicChoices({ options, selected, locked, selectionLocked, onSelect, onEdit }: {
  options: Candidate[]; selected?: string; locked: boolean; selectionLocked?: boolean;
  onSelect: (id: string) => void; onEdit: (candidate: Candidate) => void;
}) {
  const chosen = options.find((option) => option.candidate_id === selected);
  return <>
    <div className="batch-topic-choices" role="radiogroup" aria-label="选择一个选题方案">
      {options.map((option, index) => <label className={`batch-topic-choice${selected === option.candidate_id ? " is-selected" : ""}`} key={option.candidate_id}>
        <span className="batch-topic-label"><input type="radio" name="batch-topic" checked={selected === option.candidate_id} disabled={locked || selectionLocked}
          onChange={() => onSelect(option.candidate_id)} /><span>方案 {index + 1}{option.framework === "problem_solution_cta" ? " · 问题解答" : ""}</span></span>
        <strong>{option.title}</strong><span>{option.summary || option.angle}</span>
        <span className="batch-topic-opening">开头：{option.opening_example || option.narration.split(/[。！？!?]/)[0]}</span>
      </label>)}
    </div>
    {chosen && <section className="batch-selected-copy" aria-label="确认完整文案">
      <header><div><h3>{chosen.title}</h3><p>阅读并确认正文，制作时会配上真实素材。</p></div>
        <button type="button" disabled={locked} onClick={() => onEdit(chosen)}>修改文案</button></header>
      {chosen.framework === "problem_solution_cta" && <p className="batch-hint">提出问题 → 给出解决办法 → 引导行动</p>}
      <p className="batch-script-body">{chosen.narration}</p>
      <small>预计 {Math.round((chosen.estimated_duration_ms || 0) / 1000)} 秒</small>
    </section>}
  </>;
}
