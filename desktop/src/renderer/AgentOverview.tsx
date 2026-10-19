import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { AGENT_ROLE_ORDER, AGENT_ROLE_IDENTITIES, appearanceFor, portraitAsset, characterAsset, type AgentRoleKey, type RolePreferences } from "./role-appearance";
import "./AgentOverview.css";
import productBrand from "../../product-brand.json";

const LEADERS: Record<AgentRoleKey, { action: string; description: string }> = {
  production: { action: "制作获客短片", description: "用优质视频，帮你吸引精准客户。" },
  agent: { action: "承接微信咨询", description: "用真诚沟通，帮你连接更多客户。" },
  operations: { action: "制作产品详情图", description: "用精美图片，帮你展示产品、提升转化。" },
  materials: { action: "挑选行业素材", description: "工厂、小区、机器人素材拿来用。" },
  business: { action: "打开生意助手", description: "按地区找企业，查看公开电话、收藏和记录跟进。" },
  tutorials: { action: "看一段跟着做", description: "一个操作一段视频，随时暂停重看。" }
};

export function AgentOverview({ preferences, onOpenRole }: {
  preferences: RolePreferences;
  onOpenRole: (role: AgentRoleKey) => void;
}) {
  return <div className="agent-overview">
    <header className="agent-overview-head">
      <span className="agent-overview-guide" aria-hidden="true">AI</span>
      <div><h1>做视频 · 聊客户 · 出美图</h1><p>{productBrand.displayName} · 玺联惠会员超市出品</p></div>
    </header>
    <div className="agent-overview-leaders">
      {AGENT_ROLE_ORDER.map((key) => {
        const { action, description } = LEADERS[key];
        const appearance = appearanceFor(key, preferences[key].appearanceId);
        const style = { "--overview-surface": appearance.surface, "--overview-accent": appearance.strong, "--overview-pattern": key === "business" ? `url("${characterAsset(appearance.pattern)}")` : "none" } as CSSProperties;
        return <button className="agent-overview-leader" style={style} key={key} onClick={() => onOpenRole(key)}>
          <img src={portraitAsset(appearance)} alt="" />
          <span className="agent-overview-leader-copy"><strong>{AGENT_ROLE_IDENTITIES[key].responsibility}</strong><em>{preferences[key].name}</em><small>{description}</small><b>{action}<ArrowRight size={15} /></b></span>
        </button>;
      })}
    </div>
  </div>;
}
