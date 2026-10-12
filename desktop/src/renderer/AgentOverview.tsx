import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { AGENT_ROLE_ORDER, AGENT_ROLE_IDENTITIES, appearanceFor, portraitAsset, type AgentRoleKey, type RolePreferences } from "./role-appearance";
import "./AgentOverview.css";
import productBrand from "../../product-brand.json";

const LEADERS: Record<AgentRoleKey, { action: string; description: string }> = {
  production: { action: "制作获客短片", description: "上传素材，跟着三步做视频。" },
  agent: { action: "承接微信咨询", description: "同步客户，有计划地跟进。" },
  operations: { action: "制作产品详情图", description: "上传产品图，把卖点讲清楚。" },
  materials: { action: "挑选行业素材", description: "工厂、小区、机器人素材拿来用。" },
  tutorials: { action: "看一段跟着做", description: "一个操作一段视频，随时暂停重看。" }
};

export function AgentOverview({ preferences, onOpenRole }: {
  preferences: RolePreferences;
  onOpenRole: (role: AgentRoleKey) => void;
}) {
  return <div className="agent-overview">
    <header className="agent-overview-head">
      <span className="agent-overview-guide" aria-hidden="true">AI</span>
      <div><h1>生素材 · 引客户 · 促成交</h1><p>{productBrand.displayName}，从今天要完成的工作开始。</p></div>
    </header>
    <div className="agent-overview-leaders">
      {AGENT_ROLE_ORDER.map((key) => {
        const { action, description } = LEADERS[key];
        const appearance = appearanceFor(key, preferences[key].appearanceId);
        const style = { "--overview-surface": appearance.surface, "--overview-accent": appearance.strong } as CSSProperties;
        return <button className="agent-overview-leader" style={style} key={key} onClick={() => onOpenRole(key)}>
          <img src={portraitAsset(appearance)} alt="" />
          <span className="agent-overview-leader-copy"><strong>{AGENT_ROLE_IDENTITIES[key].responsibility}</strong><em>{preferences[key].name}</em><small>{description}</small><b>{action}<ArrowRight size={15} /></b></span>
        </button>;
      })}
    </div>
  </div>;
}
