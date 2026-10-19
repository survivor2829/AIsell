import { useEffect, useRef, useState } from 'react';
import catalog from '../../remotion-packaging/narration-templates.json';
import type { ReferenceHumanApi, ReferenceTask } from './reference-human-types';

export function ReferenceCoverPanel({ task, api, onTask }: { task: ReferenceTask; api: ReferenceHumanApi; onTask: (task: ReferenceTask) => void }) {
  const saved = task.coverQuote?.design || task.coverRequest?.design;
  const [title, setTitle] = useState(saved?.title || task.title);
  const [style, setStyle] = useState(saved?.style || catalog.templates.find((item) => item.id === task.captionStyleId)?.coverStyle || 'paper');
  const [seconds, setSeconds] = useState(saved?.frame_seconds || 0);
  const [frame, setFrame] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [status, setStatus] = useState(''), [revision, setRevision] = useState(0);
  const preview = useRef<HTMLDialogElement>(null);
  const coverUrl = `xiaoxi-content://generated/${task.generatedVideoId}/thumbnail?v=${revision}`;
  const creative = () => (window.xiaoxiContent as any).creative;
  useEffect(() => {
    let active = true, last = '';
    const read = async () => {
      const result = await creative().getGenerated({ candidateId: task.generatedVideoId });
      if (!active) return;
      if (!result.ok) { setNotice(result.error || '封面状态读取失败，请稍后查询。'); return; }
      const state = result.data?.coverStatus || '';
      setStatus(state);
      if (state !== last) { setRevision((value) => value + 1); last = state; }
      if (result.data?.coverIssueMessage) setNotice(result.data.coverIssueMessage);
    };
    void read().catch((error) => active && setNotice(error.message));
    const timer = window.setInterval(() => void read().catch((error) => active && setNotice(error.message)), 4500);
    return () => { active = false; clearInterval(timer); };
  }, [task.generatedVideoId]);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => { void api.coverFrame({ id: task.id, seconds }).then((result) => {
      if (!active) return;
      if (result.ok && result.data) setFrame(result.data.previewDataUrl); else setNotice(result.error || '人物画面读取失败。');
    }).catch((error) => active && setNotice(error.message)); }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [task.id, seconds]);
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setNotice(''); try { await action(); } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); } };
  const quote = task.coverQuote;
  const matches = quote?.design.title === title.trim() && quote.design.style === style && quote.design.frame_seconds === seconds;
  const pending = ['planned', 'submitted', 'outcome_unknown'].includes(status);
  const submitted = ['submitted', 'outcome_unknown'].includes(status);
  return <section className="rh-ai-cover" aria-label="AI设计封面">
    <h3>AI设计封面 <small>独立3:4图片</small></h3>
    <div className="rh-cover-images"><figure>{frame && <img src={frame} alt="选定的真实人物帧" />}<figcaption>人物参考 · {seconds.toFixed(1)}秒</figcaption></figure>
      <figure><button className="rh-cover-open" onClick={() => preview.current?.showModal()} aria-label="放大查看已保存封面"><img src={coverUrl} alt="当前已保存封面" /></button><figcaption>当前封面 · 点击放大</figcaption></figure></div>
    <dialog ref={preview} className="rh-cover-dialog" aria-label="完整封面预览"><button className="dh-button" autoFocus onClick={() => preview.current?.close()}>关闭预览</button><img src={coverUrl} alt="完整封面" /></dialog>
    <label className="dh-field"><span>选择人物画面</span><input type="range" min="0" max={Math.max(0, (task.actualDurationSeconds || 1) - .2)} step="0.1" value={seconds} disabled={busy || pending} onChange={(event) => setSeconds(Number(event.target.value))} /></label>
    <label className="dh-field rh-title-field"><span>封面标题</span><input maxLength={24} value={title} disabled={busy || pending} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="dh-field"><span>封面风格</span><select value={style} disabled={busy || pending} onChange={(event) => setStyle(event.target.value)}>{catalog.coverStyles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <p className="dh-quality">AI整张设计，人物、标题和背景一起生成。改标题或换风格需重新生成并计费；不影响已有视频。</p>
    {quote && matches && <p className="dh-quality">{quote.estimatedCny != null && `本张参考预计 ¥${quote.estimatedCny.toFixed(3)}（账号优惠待核实）；`}最多预留 ¥{quote.maximumCny.toFixed(2)}，不是已扣费用。{quote.note}</p>}
    <div className="dh-output-actions">
      <button className="dh-button" disabled={busy || submitted || !title.trim()} onClick={() => void run(async () => {
        const result = await api.coverQuote({ id: task.id, design: { title: title.trim(), style, frameSeconds: seconds } });
        if (!result.ok || !result.data) throw Error(result.error || '未取得封面报价。'); onTask(result.data);
      })}>查看本张费用</button>
      {quote && matches && !submitted && <button className="dh-button is-primary" data-xiaoxi-digital-human-action="reference-cover-generate" disabled={busy} onClick={() => void run(async () => {
        const result = await api.generateCover({ id: task.id, revision: quote.revision });
        if (!result.ok || !result.data) throw Error(result.error || '封面未开始。'); onTask(result.data); setStatus('planned'); setNotice('封面正在处理，视频可以继续使用。');
      })}>{status === 'planned' ? '确认费用，继续未提交封面' : '确认费用，生成封面'}</button>}
      {task.coverRequest && <button className="dh-button" data-xiaoxi-digital-human-action="reference-cover-generate" disabled={busy} onClick={() => void run(async () => {
        const result = await api.generateCover({ id: task.id, recover: true });
        if (!result.ok || !result.data) throw Error(result.error || '原封面查询未完成。'); onTask(result.data); setRevision((value) => value + 1); setNotice('已查询原封面请求，不会重复提交。');
      })}>查询原封面</button>}
      <button className="dh-button" disabled={busy} onClick={() => void run(async () => {
        const result = await creative().downloadCandidate({ candidateId: task.generatedVideoId, variant: 'thumbnail' });
        if (!result.ok) throw Error(result.error || '下载未完成。'); if (!result.data?.canceled) setNotice('封面已保存。');
      })}>保存当前封面</button>
    </div>{notice && <p className="dh-quality" role="status">{notice}</p>}
  </section>;
}
