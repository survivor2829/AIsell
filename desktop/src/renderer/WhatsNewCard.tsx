import { useEffect, useRef } from "react";
import { MascotHello } from "./MascotHello";
import { releaseVoice, type ReleaseVoice } from "./release-voice";

export function ReleaseBody({ voice, skipHighlight = false }: { voice: ReleaseVoice; skipHighlight?: boolean }) {
  const groups = voice.groups.map((group) => ({ ...group, items: group.items.filter((item) => !skipHighlight || item !== voice.highlight) })).filter((group) => group.items.length);
  return <div className="release-body">
    {groups.map((group) => <section key={group.title}>
      <h4>{group.title}</h4>
      <ul>{group.items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>)}
    {voice.caveats.length > 0 && <section className="release-caveats"><h4>我还在继续打磨的</h4><ul>{voice.caveats.map((item) => <li key={item}>{item}</li>)}</ul></section>}
  </div>;
}

// Shown once, the first time the software opens after an update.
export function WhatsNewCard({ version, notes, onClose }: { version: string; notes: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; if (node && !node.open) node.showModal(); }, []);
  const voice = releaseVoice(version, notes);
  return <dialog ref={dialog} className="whats-new" aria-label={`已升级到 ${version}`} onCancel={onClose}>
    <div className="whats-new-hero">
      <MascotHello moment="celebrate" width={170} />
      <div>
        <small>刚刚升级到 {version}</small>
        <h2>我升级好啦！</h2>
        <p>{voice.opener}</p>
      </div>
    </div>
    {voice.highlight && <p className="whats-new-highlight"><span>这次的亮点</span>{voice.highlight}</p>}
    <ReleaseBody voice={voice} skipHighlight />
    <footer><span>每一次更新，都是想让你用得更省心。</span><button type="button" className="primary-button" autoFocus onClick={onClose}>好的，去试试</button></footer>
  </dialog>;
}
