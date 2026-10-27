import { useEffect, useState } from 'react';
import { NarrationLayout } from '../../remotion-packaging/NarrationLayout';
import catalog from '../../remotion-packaging/narration-templates.json';
import type { NarrationPlan } from '../../remotion-packaging/NarrationLayoutV4';

// Preview and export use the same composition. These labelled sample cues
// demonstrate layout; they are never used as a customer's subtitle timeline.
const cues = [
  { text: '买洗地机，别只看价格', startMs: 0, endMs: 2400 },
  { text: '先看地面，再选设备', startMs: 2400, endMs: 4800 },
  { text: '选对机器，清洁才省心', startMs: 4800, endMs: 7200 }
];
export function NarrationTemplatePicker({ value, onChange, poster, disabled, plan, title }: { value?: string; onChange: (value: string) => void; poster?: string; disabled?: boolean; plan?: NarrationPlan; title?: string }) {
  const [now, setNow] = useState(0), [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => {
    if (!playing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const start = performance.now();
    const timer = window.setInterval(() => setNow((performance.now() - start) % 7200), 40);
    return () => clearInterval(timer);
  }, [playing]);
  return <fieldset className="rh-template-picker" disabled={disabled}><legend>网感模板</legend>
    <p className="dh-quality">移到模板上看动态排版。已生成的当前风格使用保存方案，其余为示例文案。</p>
    {value && catalog.templates.some((item) => item.id === value && item.version !== catalog.version) &&
      <p className="dh-quality">当前使用旧版「{catalog.templates.find((item) => item.id === value)?.name}」，原样保留；新做的口播可选下方新版。</p>}
    <div>{catalog.templates.filter((item) => item.version === catalog.version).map((item) => <button key={item.id} type="button" aria-pressed={value === item.id}
      onMouseEnter={() => { setNow(0); setPlaying(item.id); }} onMouseLeave={() => setPlaying(null)}
      onFocus={() => { setNow(0); setPlaying(item.id); }} onBlur={() => setPlaying(null)} onClick={() => onChange(item.id)}>
      <span className="rh-template-preview"><span className="rh-template-canvas">
        {poster && <img src={poster} alt="" />}
        <NarrationLayout styleId={item.id} title={plan?.templateId === item.id ? title || '' : '洗地机怎么选'} cues={cues} plan={plan?.templateId === item.id ? plan : undefined} nowMs={playing === item.id ? now : 1000} emphasis={['别只看价格', '再选设备', '清洁才省心']} />
      </span></span><strong>{item.name}</strong><small>{item.description}</small>
    </button>)}</div>
  </fieldset>;
}
