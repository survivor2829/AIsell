import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { AGENT_ROLE_ORDER, AGENT_ROLE_IDENTITIES, appearanceFor, portraitAsset, characterAsset, type AgentRoleKey, type RolePreferences } from "./role-appearance";
import "./AgentOverview.css";
import productBrand from "../../product-brand.json";

const LEADERS: Record<AgentRoleKey, { action: string; description: string }> = {
  production: { action: "制作获客短片", description: "把素材和卖点，做成客户看得懂的短视频。" },
  agent: { action: "承接微信咨询", description: "联系客户、回应咨询，把每次沟通接着做下去。" },
  operations: { action: "制作产品详情图", description: "把产品卖点讲清楚，详情图、参数图一起准备。" },
  materials: { action: "挑选行业素材", description: "做视频缺画面？从工厂、小区、设备素材中选一段。" },
  business: { action: "打开精准获客", description: "找到附近企业，查资料、留线索、接着跟进。" },
  tutorials: { action: "看一段跟着做", description: "一个操作一段视频，随时暂停重看。" }
};

export function AgentOverview({ preferences, onOpenRole }: {
  preferences: RolePreferences;
  onOpenRole: (role: AgentRoleKey) => void;
}) {
  return <div className="agent-overview">
    <header className="agent-overview-head">
      <span className="agent-overview-guide" aria-hidden="true">AI</span>
      <div><h1>生素材 · 引客户 · 促成交</h1><p>{productBrand.displayName} · 玺联惠会员超市出品</p></div>
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
