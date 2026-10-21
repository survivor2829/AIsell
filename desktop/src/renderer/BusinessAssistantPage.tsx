import { ArrowLeft, ArrowRight, Globe2, MapPin, MessageCircle, Search, Settings2 } from "lucide-react";
import { appearanceStyle, portraitAsset, type RoleAppearance, type RolePreference } from "./role-appearance";
import "./BusinessAssistantPage.css";
import { PreciseAcquisitionPanel } from './PreciseAcquisitionPanel';
import { GeoWorkbenchPanel } from './GeoWorkbenchPanel';
import { MapAcquisitionPanel } from './MapAcquisitionPanel';

export const BUSINESS_MODULES = {
  "business-map": {
    label: "地图获客", purpose: "找附近企业", icon: MapPin,
    title: "按地区寻找适合开发的企业",
    description: "查看企业资料与公开电话，收藏并记录跟进。",
    steps: ["选择地区与客户类型", "自动查找并保存企业", "查看资料，记录跟进"],
    emptyTitle: "本次搜索结果",
    emptyDescription: "地图企业的实际需求仍待确认。",
  },
  "business-acquisition": {
    label: "精准获客", purpose: "找客户", icon: Search,
    title: "找到值得联系的生意机会",
    description: "面向清洁设备渠道商、物业和保洁公司，按地区与业务发现商机。",
    steps: ["选择服务地区与业务", "查看商机依据和联系路径", "记录联系结果，安排下一步"],
    emptyTitle: "商机列表将在这里呈现",
    emptyDescription: "接通后，每条商机将说明来源、时间、匹配原因和联系路径；尚未确认的需求会单独标明。",
  },
  "business-wecom": {
    label: "企微助手", purpose: "跟客户", icon: MessageCircle,
    title: "让咨询有回应，跟进有着落",
    description: "围绕企业微信整理客户需求、推荐回复与资料，提醒下一次跟进。",
    steps: ["连接企业微信与业务资料", "查看回复建议和适用素材", "处理客户跟进与回访待办"],
    emptyTitle: "客户跟进待办将在这里呈现",
    emptyDescription: "企微尚未连接。后续将根据已授权的能力提供客户资料、回复建议和跟进提醒。",
  },
  "business-geo": {
    label: "GEO推广", purpose: "让客户找到我", icon: Globe2,
    title: "让搜索相关问题的人更容易了解你",
    description: "围绕你的产品、服务和真实案例准备内容，观察品牌在 AI 搜索中的表现。",
    steps: ["完善公司与产品服务资料", "确认推广内容与发布渠道", "查看品牌提及和咨询来源"],
    emptyTitle: "推广内容与检测记录将在这里呈现",
    emptyDescription: "尚未接通内容发布与检测。后续会分别记录发布结果、AI 提及和实际咨询，不将提及次数当作客户数。",
  },
} as const;
export type BusinessModule = keyof typeof BUSINESS_MODULES;
export function isBusinessModule(key: string): key is BusinessModule {
  return Object.prototype.hasOwnProperty.call(BUSINESS_MODULES, key);
}

export function BusinessAssistantPage({ module, preference, appearance, onPersonalize, onOpenModule, onReturnHome }: {
  module?: BusinessModule;
  onOpenModule: (module: BusinessModule) => void;
  onReturnHome: () => void;
  preference: RolePreference;
  appearance: RoleAppearance;
  onPersonalize: () => void;
}) {
  const current = module ? BUSINESS_MODULES[module] : undefined;
  const Icon = current?.icon || Search;
  if (module === 'business-map' || module === 'business-acquisition' || module === 'business-geo') return <section className="page business-assistant-page" style={appearanceStyle(appearance, true)}>
    <button type="button" className="business-personalize" onClick={onReturnHome}><ArrowLeft size={16} aria-hidden="true" />返回 AI 生意助手</button>
    {module === 'business-map' ? <MapAcquisitionPanel /> : module === 'business-acquisition' ? <PreciseAcquisitionPanel /> : <GeoWorkbenchPanel />}
  </section>;
  return <section className="page business-assistant-page" style={appearanceStyle(appearance, true)}>
    <header className="business-page-head">
      <div><h1>{current?.label || "AI生意助手"}</h1><p>{current ? `AI生意助手 · ${current.purpose}` : "从发现商机，到客户跟进与品牌推广。"}</p></div>
      <span className="business-stage">{current ? '功能筹备中' : '本地工作台'}</span>
    </header>
    {!current && <div className="business-overview-layout">
    <div className="business-companion">
      <img className="business-portrait" src={portraitAsset(appearance)} alt={`${preference.name}，你的AI生意助手`} />
      <div className="business-companion-copy">
        <div className="business-companion-title">
          <h2>我是{preference.name}，你的生意伙伴</h2>
          <button type="button" className="business-personalize" onClick={onPersonalize}><Settings2 size={16} />形象与名字</button>
        </div>
        <p>找客户、跟客户，让客户找到你。<br />三个方向放在一起，生意进展看得清楚。</p>
        <p className="business-framework-note">地图获客与 GEO 可整理本地资料、连接平台账号；采集、检测与发布分别核验能力。企微助手仍在筹备中。</p>
      </div>
    </div>
    <nav className="business-module-nav" aria-label="生意助手功能">
      {(Object.entries(BUSINESS_MODULES) as [BusinessModule, typeof BUSINESS_MODULES[BusinessModule]][]).map(([key, item]) => {
        const ModuleIcon = item.icon;
        return <button type="button" key={key} onClick={() => onOpenModule(key)}>
          <ModuleIcon size={22} aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.purpose}</small></span><ArrowRight size={16} aria-hidden="true" />
        </button>;
      })}
    </nav>
    </div>}
    {current && <section id="business-module-detail" className="business-module-detail" aria-labelledby="business-module-title">
      <h2 id="business-module-title">{current.title}</h2>
      <p>{current.description}</p>
      <ol className="business-steps" aria-label={`${current.label}规划流程`}>
        {current.steps.map((step, index) => <li key={step}><span aria-hidden="true">{index + 1}</span>{step}</li>)}
      </ol>
      <div className="business-empty">
        <Icon size={30} strokeWidth={1.6} aria-hidden="true" />
        <div><h3>{current.emptyTitle}</h3><p>{current.emptyDescription}</p></div>
      </div>
    </section>}
  </section>;
}
