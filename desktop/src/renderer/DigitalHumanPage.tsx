import { useEffect, useState } from 'react';
import './DigitalHumanPage.css';
import { ViralPipelinePage } from './ViralPipelinePage';
import { NarrationSimplePage } from './NarrationSimplePage';
import { ReferenceHumanPage } from './ReferenceHumanPage';

const DEVELOPMENT_EDITION = import.meta.env.VITE_XIAOXI_EDITION === 'development';

export function DigitalHumanPage() {
  // 数字人视频只有极简出片一个页面。开发版按 Ctrl+Shift+L 打开内部的扒爆款 / 文案库工具，
  // Ctrl+Shift+R 打开本人口播处理页（看成片、换包装），页面上都没有入口。
  // 之前做的本人口播有结果待核对或需要处理时，才从极简页进到原来的处理页面，处理完返回。
  const [internal, setInternal] = useState(false), [pending, setPending] = useState(false);
  useEffect(() => {
    if (!DEVELOPMENT_EDITION) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey) return;
      if (event.key.toLowerCase() === 'l') setInternal((open) => !open);
      if (event.key.toLowerCase() === 'r') { setInternal(false); setPending((open) => !open); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (DEVELOPMENT_EDITION && internal) return <ViralPipelinePage onImitate={() => {}} onManagePerson={() => setInternal(false)} />;
  if (pending) return (
    <div className="ns-pending-view">
      <button type="button" className="ns-back" onClick={() => setPending(false)}>← 返回数字人视频</button>
      <ReferenceHumanPage />
    </div>
  );
  return <NarrationSimplePage onOpenPending={() => setPending(true)} />;
}
