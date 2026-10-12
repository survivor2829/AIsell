import { Check, PlayCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TutorialTopic } from './tutorials-types';
import './CreationGuide.css';

export type CreationTopic = TutorialTopic;

export function TutorialHelp({ topic }: { topic: CreationTopic }) {
  return <button type="button" className="creation-tutorial" onClick={() => window.dispatchEvent(new CustomEvent('xiaoxi:open-tutorials', { detail: { category: 'short-video', topic } }))}>
    <PlayCircle size={19} aria-hidden="true" /><span>看操作演示</span>
  </button>;
}

export function CreationSteps({ labels, current, onChange, disabled = [] }: {
  labels: readonly string[]; current: number; onChange: (step: number) => void; disabled?: readonly boolean[];
}) {
  return <nav className="creation-steps" aria-label="制作步骤"><ol>{labels.map((label, index) => <li key={label}>
    <button type="button" aria-current={current === index ? 'step' : undefined} disabled={disabled[index]} onClick={() => onChange(index)}>
      <span className="creation-step-number" aria-hidden="true">{index < current ? <Check size={17} /> : index + 1}</span><span>{label}</span>
    </button>
  </li>)}</ol></nav>;
}

export function CreationStepTitle({ number, children }: { number: number; children: ReactNode }) {
  return <h2 className="creation-step-title"><span aria-hidden="true">{number}</span>{children}</h2>;
}
