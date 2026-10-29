import { ArrowRight, Globe2, MapPin, Search, Settings2 } from "lucide-react";
import { appearanceStyle, type RoleAppearance } from "./role-appearance";
import { MapAcquisitionPanel } from './MapAcquisitionPanel';
import { AcquisitionPage } from './AcquisitionPage';
import "./BusinessAssistantPage.css";

export const BUSINESS_MODULES = {
  "business-map": {
    label: "地图获客", icon: MapPin, available: true,
    title: "找到附近值得联系的企业",
    description: "找到附近企业，查资料、留线索、接着跟进。",
    plans: []
  },
  "business-keyword": {
    label: "关键词获客", icon: Search, available: true,
    title: "从同行视频的评论里找到想买的人",
    description: "按关键词搜视频、读评论，把问价、想买、要联系方式的人整理成线索。",
    plans: []
  },
  "business-geo": {
    label: "GEO推广", icon: Globe2, available: false,
    title: "让有需求的客户更容易了解您",
    description: "计划围绕您的产品、服务和真实案例准备内容，观察品牌在AI搜索中的表现。",
    plans: ["整理公司、产品与服务资料", "准备内容并确认发布渠道", "分别查看品牌提及与实际咨询"]
  }
} as const;
export type BusinessModule = keyof typeof BUSINESS_MODULES;
export function isBusinessModule(key: string): key is BusinessModule {
  return Object.prototype.hasOwnProperty.call(BUSINESS_MODULES, key);
}

export function BusinessAssistantPage({ module, appearance, onPersonalize, onOpenModule }: {
  module?: BusinessModule;
  appearance: RoleAppearance;
  onPersonalize: () => void;
  onOpenModule: (module: BusinessModule) => void;
}) {
  const current = module ? BUSINESS_MODULES[module] : undefined;
  return <section className="page business-assistant-page" style={appearanceStyle(appearance, true)}>
    <header className="business-page-head"><div><h1>{current?.label || "精准获客"}</h1><p>{current?.description || "从找到企业，到接住咨询、持续跟进，选择您接下来要做的事。"}</p></div>
      <button type="button" className="business-personalize" onClick={onPersonalize}><Settings2 size={16} />形象与名字</button>
    </header>
    {!current && <nav className="business-module-nav" aria-label="精准获客功能">{Object.entries(BUSINESS_MODULES).map(([key, item]) => {
      const Icon = item.icon;
      return <button type="button" key={key} aria-label={`打开${item.label}`} onClick={() => onOpenModule(key as BusinessModule)}><Icon size={27} /><span><strong>{item.label}{!item.available && <small className="business-stage">待开放</small>}</strong><span>{item.description}</span></span><ArrowRight size={18} /></button>;
    })}</nav>}
    {module === "business-map" && <MapAcquisitionPanel />}
    {module === "business-keyword" && <AcquisitionPage />}
    {current && !current.available && <section className="business-module-plan" aria-label={`${current.label}规划`}><span className="business-stage">待开放</span><h2>{current.title}</h2><p>这里先为您介绍后续方向，当前尚未开放以下功能。</p><ul>{current.plans.map(plan => <li key={plan}>{plan}</li>)}</ul><p>开放后会在更新公告中说明使用方式。您现在可以先用地图获客整理企业资料。</p><button type="button" className="primary-button" onClick={() => onOpenModule("business-map")}>进入地图获客<ArrowRight size={16} /></button></section>}
  </section>;
}
