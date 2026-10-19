import type { ReferenceTask } from './reference-human-types';

export function ReferenceCostSummary({ task, previewFirst }: { task: ReferenceTask; previewFirst: boolean }) {
  if (task.sourceTaskId) return <p className="dh-quality">本次仅本地更换包装，复用原人物和声音，无新增配音或人物生成调用。</p>;
  const q = task.quote;
  if (!q) return null;
  const estimate = q.estimate, usage = task.costUsage;
  const audioOnly = previewFirst && task.status === 'draft';
  return <div className="rh-quote">
    <h3>{task.status === 'draft' ? '确认制作费用' : '本次费用记录'}</h3>
    {estimate && task.status === 'draft' && <p className="rh-amount">预计 ¥{estimate.minimumCny.toFixed(2)}—{estimate.maximumCny.toFixed(2)}</p>}
    {estimate && task.status === 'draft' && <p>按{Number(estimate.minimumSeconds.toFixed(1))}—{Number(estimate.maximumSeconds.toFixed(1))}秒、一份配音与字幕{q.coverReserveCny ? '、一张AI封面' : ''}估算；配乐、字幕包装在本机完成。</p>}
    <p><strong>整条制作最高授权 ¥{q.maximumCny.toFixed(2)}</strong>，这是预留上限，不是已扣费用。</p>
    <details><summary>查看各项预留与计价说明</summary>
      <p>建立本人声音 ¥{(q.enrollmentReserveCny || 0).toFixed(2)} · 配音 ¥{q.voiceReserveCny.toFixed(2)} · 字幕识别 ¥{q.asrReserveCny.toFixed(2)}</p>
      <p>人物制作 ¥{q.videoCny.toFixed(2)} · AI封面 ¥{(q.coverReserveCny || 0).toFixed(2)}</p>
      {estimate && <p>配音预计 ¥{estimate.voiceCny.toFixed(3)}{q.coverReserveCny ? `；封面参考预计 ¥${estimate.coverCny.toFixed(3)}` : ''}。{estimate.coverConditional && `封面优惠价与账号等级有关，按预算汇率 ${estimate.fxCnyPerUsd} 换算，账号实际优惠尚未核实。`}</p>}
      <p>人物最多{Number((q.maximumSeconds || 45).toFixed(1))}秒，超出授权范围会暂停。写稿使用套餐额度，未开通或耗尽时不自动转付费。</p>
      <small>{q.note}</small>
    </details>
    {audioOnly && <p>本步只制作配音与字幕，最多预留 ¥{((q.enrollmentReserveCny || 0) + q.voiceReserveCny + q.asrReserveCny).toFixed(2)}；试听后再次确认才制作人物。</p>}
    {usage && task.status !== 'draft' && <div className="dh-quality"><p>已取得用量：{usage.audioSeconds ? `配音 ${usage.audioSeconds.toFixed(2)} 秒` : '时长待核实'}{usage.voiceCharacters != null ? `，供应商计费字符 ${usage.voiceCharacters}` : ''}。{usage.voiceReused && '本次复用已有配音。'}</p>
      {usage.operations.some((op) => op.state === 'unknown') && <p>有原请求结果待核对，不能视为免费或重新购买。</p>}
      <p>实际结算尚未取得供应商账单，不将预留金额或成功回执当成已扣费。</p></div>}
  </div>;
}
