import type { CSSProperties } from "react";
import { ArrowRight, Folder } from "lucide-react";
import { appearanceFor, characterAsset, type AgentRoleKey, type RolePreferences } from "./role-appearance";
import "./AgentOverview.css";
import productBrand from "../../product-brand.json";

const LEADERS: { key: AgentRoleKey; action: string; description: string }[] = [
  { key: "production", action: "制作获客短片", description: "把产品做成能引发咨询的短视频。" },
  { key: "operations", action: "制作产品详情图", description: "上传产品图片和卖点，制作清楚易读的详情图。" },
  { key: "agent", action: "承接微信咨询", description: "核对身份和任务状态，礼貌跟进客户。" }
];

export function AgentOverview({ preferences, onOpenRole, onOpenModule }: {
  preferences: RolePreferences;
  onOpenRole: (role: AgentRoleKey) => void;
  onOpenModule: (key: "materials") => void;
}) {
  return <div className="agent-overview">
    <header className="agent-overview-head">
      <span className="agent-overview-guide" aria-hidden="true">AI</span>
      <div><h1>生素材 · 引客户 · 变成交</h1><p>{productBrand.displayName}，从今天要完成的工作开始。</p></div>
    </header>
    <div className="agent-overview-leaders">
      {LEADERS.map(({ key, action, description }) => {
        const appearance = appearanceFor(key, preferences[key].appearanceId);
        const style = { "--overview-surface": appearance.surface, "--overview-accent": appearance.strong } as CSSProperties;
        return <button className="agent-overview-leader" style={style} key={key} onClick={() => onOpenRole(key)}>
          <img src={characterAsset(`${appearance.portraitKey}-idle.png`)} alt="" />
          <span className="agent-overview-leader-copy"><strong>{key === "operations" ? "产品详情图" : key === "production" ? "短视频获客" : "微信拓客"}</strong><em>{preferences[key].name}</em><small>{description}</small><b>{action}<ArrowRight size={15} /></b></span>
        </button>;
      })}
    </div>
    <button className="agent-overview-materials" type="button" onClick={() => onOpenModule("materials")}>
      <span className="agent-overview-materials-icon"><Folder size={21} /></span>
      <span><strong>素材仓库</strong><small>产品图片、实拍视频和说明放在这里，制作短片时可以直接选用。</small></span>
      <ArrowRight size={17} />
    </button>
  </div>;
}
