import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, PlayCircle, X } from 'lucide-react';
import type { TutorialTopic } from './tutorials-types';
import './VideoExamples.css';

export const VIDEO_EXAMPLES = [
  { topic: 'ai-editing', title: '学完觉得没用怎么办', module: '线索视频混剪', file: 'lead-mix', duration: '51秒' },
  { topic: 'product-video', title: '普渡 CC1 Pro', module: '产品效果视频', file: 'cc1-pro', duration: '30秒' }
] as const;
// 微信拓客各子模块的操作实录（宽屏，客户名单和号码已打码），教程分类为 wechat。
export const WECHAT_DEMOS = [
  { topic: 'wechat-touch', title: '选好客户，自动发消息和图片', module: '精准触达', file: 'wechat-touch', duration: '1分08秒' },
  { topic: 'wechat-reply', title: '客户来消息，自动接待回复', module: '自动回复', file: 'wechat-reply', duration: '1分10秒' },
  { topic: 'wechat-moments', title: '写好文案选好图，自动发朋友圈', module: '朋友圈运营', file: 'wechat-moments', duration: '1分05秒' }
] as const;
type VideoExample = typeof VIDEO_EXAMPLES[number] | typeof WECHAT_DEMOS[number];
const isWechatDemo = (example: VideoExample) => example.topic.startsWith('wechat-');
const asset = (file: string) => new URL(`./video-examples/${file}`, document.baseURI).toString();
function openTutorial(example: VideoExample) {
  const detail = isWechatDemo(example) ? { category: 'wechat' } : { category: 'short-video', topic: example.topic as TutorialTopic };
  window.dispatchEvent(new CustomEvent('xiaoxi:open-tutorials', { detail }));
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
  const label = isWechatDemo(example) ? '操作演示' : '成片示例';
  return <dialog ref={dialog} className={`video-example-dialog${isWechatDemo(example) ? ' is-wide' : ''}`} aria-label={`${example.module}${label}`} onClose={event => { if (!event.currentTarget.open) onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><div><strong>{example.title}</strong><span>{example.module} · {example.duration} · {isWechatDemo(example) ? '真实操作录屏' : '离线示例'}</span></div><button type="button" aria-label={`关闭${label}`} onClick={onClose}><X size={22} /></button></header>
    <div className="video-example-stage">
      {failed ? <div className="video-example-error" role="alert"><p>这段示例暂时无法播放，请重试。</p><button type="button" onClick={() => setFailed(false)}>重新播放</button><button type="button" onClick={() => { onClose(); openTutorial(example); }}>查看操作教程</button></div>
        : <video ref={video} src={asset(`${example.file}.mp4`)} poster={asset(`${example.file}.jpg`)} controls autoPlay playsInline preload="metadata" onError={() => setFailed(true)} />}
    </div>
  </dialog>;
}

// Three steps laid out across the banner, so the right side carries the flow instead of blank space.
const BANNER_TEXT: Record<VideoExample['topic'], { result: string; steps: { title: string; detail: string }[] }> = {
  'ai-editing': {
    result: '一次做出多条讲清卖点的获客短视频，导出后可发抖音、快手、视频号。',
    steps: [
      { title: '上传素材', detail: '几段产品和现场视频、图片，写下卖点' },
      { title: 'AI 制作', detail: '挑镜头、写文案、配音、加字幕' },
      { title: '一次出多条', detail: '每条带 AI 网感封面，直接下载发布' }
    ]
  },
  'product-video': {
    result: '没有拍摄条件，也能让客户看到产品真实的使用效果。',
    steps: [
      { title: '上传产品图', detail: '一张清楚的产品照片，填几条卖点' },
      { title: 'AI 生成画面', detail: '产品在现场使用的效果，配讲解和字幕' },
      { title: '拿到成片', detail: '约 30 秒，带 AI 网感封面' }
    ]
  },
  'wechat-touch': {
    result: '挑好要联系的客户，软件替你在电脑微信里逐个发消息和图片，发完自动核对。',
    steps: [
      { title: '选客户', detail: '从通讯录里勾选，或按标签筛选' },
      { title: '写话术加图片', detail: '一段消息，可带产品图或视频' },
      { title: '自动发送', detail: '逐个发出，结果在记录里看得到' }
    ]
  },
  'wechat-reply': {
    result: '客户发来消息，软件按你的产品资料自动接待回复，人不在电脑前也不漏。',
    steps: [
      { title: '选接待客户', detail: '只回复你勾选的客户，群聊不碰' },
      { title: 'AI 按资料回复', detail: '根据产品资料和话术生成回答' },
      { title: '自动发出', detail: '发出前核对聊天对象，不发错人' }
    ]
  },
  'wechat-moments': {
    result: '写好文案、选好图片，到点自动发到你的朋友圈。',
    steps: [
      { title: '写文案', detail: '自己写，或让 AI 帮你写' },
      { title: '选图片', detail: '最多 9 张，顺序按你排的来' },
      { title: '自动发布', detail: '立即发或定时发，发完自动核对' }
    ]
  }
};
const collapsedKey = (topic: string) => `video-example-banner-collapsed:${topic}`;
function readCollapsed(topic: string) { try { return localStorage.getItem(collapsedKey(topic)) === '1'; } catch { return false; } }
function writeCollapsed(topic: string, value: boolean) { try { localStorage.setItem(collapsedKey(topic), value ? '1' : '0'); } catch { /* Only a convenience. */ } }

// 模块页顶部横幅：左边示例成片（点了在原地播放，不自动播放），右边说明做出来是什么样。
export function ExampleBanner({ topic }: { topic: VideoExample['topic'] }) {
  const example: VideoExample = [...VIDEO_EXAMPLES, ...WECHAT_DEMOS].find(item => item.topic === topic)!;
  const text = BANNER_TEXT[topic];
  const wide = isWechatDemo(example);
  const label = wide ? '操作演示' : '成片示例';
  const [enlarged, setEnlarged] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(topic));
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const toggle = () => { const next = !collapsed; setCollapsed(next); writeCollapsed(topic, next); if (next) video.current?.pause(); };
  if (collapsed) return <section className="example-banner is-collapsed" aria-label={`${example.module}${label}`}>
    <span><PlayCircle size={17} aria-hidden="true" />{wide ? `${example.module}用起来是什么样？` : `${example.module}做出来是什么样？`}</span>
    <button type="button" onClick={toggle}>{`看${label}`}<ChevronDown size={16} aria-hidden="true" /></button>
  </section>;
  return <section className={`example-banner${wide ? ' is-wide' : ''}`} aria-label={`${example.module}${label}`}>
    <div className="example-banner-player">
      {failed ? <div className="example-banner-error" role="alert"><p>示例暂时无法播放</p><button type="button" onClick={() => { setFailed(false); setStarted(false); }}>重试</button></div>
        : started ? <video ref={video} src={asset(`${example.file}.mp4`)} poster={asset(`${example.file}.jpg`)} controls autoPlay playsInline preload="metadata" onError={() => setFailed(true)} />
        : <button type="button" className="example-banner-poster" aria-label={`播放${example.module}${label}`} onClick={() => wide ? setEnlarged(true) : setStarted(true)}>
          <img src={asset(`${example.file}.jpg`)} alt="" /><span aria-hidden="true"><PlayCircle size={44} /></span>
        </button>}
    </div>
    <div className="example-banner-copy">
      {/* Header row spans the full width: title on the left, actions in the top-right corner. */}
      <div className="example-banner-head">
        <div>
          <small>{label} · {example.duration} · {wide ? '真实操作录屏' : `「${example.title}」`}</small>
          <h2>{wide ? example.title : '做出来是这样的'}</h2>
          <p>{text.result}</p>
        </div>
        <div className="example-banner-actions">
          <button type="button" className="example-banner-tutorial" onClick={() => openTutorial(example)}>看操作教程</button>
          <button type="button" className="example-banner-collapse" onClick={toggle}>收起<ChevronUp size={16} aria-hidden="true" /></button>
        </div>
      </div>
      <ol className="example-banner-steps">{text.steps.map((step, index) => <li key={step.title}><b>{index + 1}</b><span><strong>{step.title}</strong>{step.detail}</span></li>)}</ol>
    </div>
    {enlarged && <ExamplePlayer example={example} onClose={() => setEnlarged(false)} />}
  </section>;
}

export function VideoExamples() {
  const [selected, setSelected] = useState<VideoExample | null>(null);
  return <section className="video-examples" aria-label="看看短视频生成效果">
    <h2>看看生成效果</h2><p>看看素材和卖点，怎样变成一条发给客户的视频。</p>
    <div className="video-example-cards">{VIDEO_EXAMPLES.map(example => <button type="button" key={example.topic} onClick={() => setSelected(example)}>
      <img src={asset(`${example.file}.jpg`)} alt="" loading="lazy" /><span><small>{example.module} · {example.duration}</small><strong>{example.title}</strong><em><PlayCircle size={16} />看成片示例</em></span>
    </button>)}</div>
    {selected && <ExamplePlayer example={selected} onClose={() => setSelected(null)} />}
  </section>;
}
