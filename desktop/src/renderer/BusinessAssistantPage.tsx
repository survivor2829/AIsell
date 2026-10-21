import { Settings2 } from "lucide-react";
import { appearanceStyle, type RoleAppearance } from "./role-appearance";
import { MapAcquisitionPanel } from './MapAcquisitionPanel';
import "./BusinessAssistantPage.css";

export type BusinessModule = "business-map";
export function isBusinessModule(key: string): key is BusinessModule { return key === "business-map"; }

export function BusinessAssistantPage({ appearance, onPersonalize }: {
  appearance: RoleAppearance;
  onPersonalize: () => void;
}) {
  return <section className="page business-assistant-page" style={appearanceStyle(appearance, true)}>
    <header className="business-page-head"><div><h1>精准获客</h1><p>地图获客 · 查看企业资料与公开电话，收藏并记录跟进。</p></div>
      <button type="button" className="business-personalize" onClick={onPersonalize}><Settings2 size={16} />形象与名字</button>
    </header>
    <MapAcquisitionPanel />
  </section>;
}
