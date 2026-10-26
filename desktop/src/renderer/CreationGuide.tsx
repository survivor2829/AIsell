import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TutorialTopic } from './tutorials-types';
import './CreationGuide.css';

export type CreationTopic = TutorialTopic;

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
