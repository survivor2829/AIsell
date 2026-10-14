import { useEffect, useRef, useState } from 'react';
import { PlayCircle, X } from 'lucide-react';
import type { TutorialTopic } from './tutorials-types';
import './VideoExamples.css';

export const VIDEO_EXAMPLES = [
  { topic: 'ai-editing', title: '学完觉得没用怎么办', module: '线索视频混剪', file: 'lead-mix', duration: '51秒' },
  { topic: 'product-video', title: '普渡 CC1 Pro', module: '产品效果视频', file: 'cc1-pro', duration: '30秒' }
] as const;
type VideoExample = typeof VIDEO_EXAMPLES[number];
const asset = (file: string) => new URL(`./video-examples/${file}`, document.baseURI).toString();
function openTutorial(topic: TutorialTopic) {
  window.dispatchEvent(new CustomEvent('xiaoxi:open-tutorials', { detail: { category: 'short-video', topic } }));
}

function ExamplePlayer({ example, onClose }: { example: VideoExample; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    const playback = video.current;
    element?.showModal();
    void playback?.play().catch(() => {});
    return () => { playback?.pause(); element?.close(); };
  }, []);
  return <dialog ref={dialog} className="video-example-dialog" aria-label={`${example.module}成片示例`} onClose={event => { if (!event.currentTarget.open) onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><div><strong>{example.title}</strong><span>{example.module} · {example.duration} · 离线示例</span></div><button type="button" aria-label="关闭成片示例" onClick={onClose}><X size={22} /></button></header>
    <div className="video-example-stage">
      {failed ? <div className="video-example-error" role="alert"><p>这段示例暂时无法播放，请重试。</p><button type="button" onClick={() => setFailed(false)}>重新播放</button><button type="button" onClick={() => { onClose(); openTutorial(example.topic); }}>查看操作教程</button></div>
        : <video ref={video} src={asset(`${example.file}.mp4`)} poster={asset(`${example.file}.jpg`)} controls autoPlay playsInline preload="metadata" onError={() => setFailed(true)} />}
    </div>
  </dialog>;
}

export function ExampleHelp({ topic }: { topic: TutorialTopic }) {
  const example = VIDEO_EXAMPLES.find(item => item.topic === topic);
  const [selected, setSelected] = useState(false);
  return <><button type="button" className="creation-tutorial" onClick={() => example ? setSelected(true) : openTutorial(topic)}><PlayCircle size={19} aria-hidden="true" /><span>{example ? '看成片示例' : '看操作演示'}</span></button>
    {selected && example && <ExamplePlayer example={example} onClose={() => setSelected(false)} />}</>;
}

export function VideoExamples() {
  const [selected, setSelected] = useState<VideoExample | null>(null);
  return <section className="video-examples" aria-label="看看短视频生成效果">
    <h2>看看生成效果</h2><p>点开成片，看看可以做出什么样的视频。</p>
    <div className="video-example-cards">{VIDEO_EXAMPLES.map(example => <button type="button" key={example.topic} onClick={() => setSelected(example)}>
      <img src={asset(`${example.file}.jpg`)} alt="" loading="lazy" /><span><small>{example.module} · {example.duration}</small><strong>{example.title}</strong><em><PlayCircle size={16} />看成片示例</em></span>
    </button>)}</div>
    {selected && <ExamplePlayer example={selected} onClose={() => setSelected(null)} />}
  </section>;
}
