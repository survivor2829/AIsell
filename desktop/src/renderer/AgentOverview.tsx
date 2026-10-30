import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Play } from "lucide-react";
import { AGENT_ROLE_ORDER, AGENT_ROLE_IDENTITIES, appearanceFor, characterAsset, type AgentRoleKey, type RolePreferences } from "./role-appearance";
import { gain, overviewStats, type OverviewStats } from "./overview-stats";
import "./AgentOverview.css";

type Loose = Record<string, unknown>;
type Api = { [key: string]: ((...args: unknown[]) => Promise<Loose>) | Api };
const api = (name: string) => (window as unknown as Record<string, Api | undefined>)[name];
const items = (value: unknown, ...path: string[]) => {
  let current: unknown = value;
  for (const key of path) current = (current as Loose | undefined)?.[key];
  return Array.isArray(current) ? current as Loose[] : [];
};
type Sources = Omit<Parameters<typeof overviewStats>[0], "workflowTasks">;
// Reads what the other pages already expose; a missing or failing source simply counts as nothing.
async function readSources(): Promise<Sources> {
  const call = async (read: () => Promise<Loose> | undefined) => { try { return await read() ?? {}; } catch { return {}; } };
  const content = api("xiaoxiContent") as Api | undefined;
  const [finished, acquisition, map, publish, materials, tutorials, details] = await Promise.all([
    call(() => ((content?.finished as Api | undefined)?.list as (payload: unknown) => Promise<Loose>)?.({ limit: 500 })),
    call(() => (api("xiaoxiSocialAcquisition")?.status as () => Promise<Loose>)?.()),
    call(() => (api("xiaoxiMapAcquisition")?.invoke as (name: string) => Promise<Loose>)?.("status")),
    call(() => (api("xiaoxiSocialPublish")?.status as () => Promise<Loose>)?.()),
    call(() => (api("xiaoxiOfficialMaterials")?.list as () => Promise<Loose>)?.()),
    call(() => (api("xiaoxiTutorials")?.list as () => Promise<Loose>)?.()),
    call(() => (api("xiaoxiProductDetail")?.history as () => Promise<Loose>)?.())
  ]);
  return {
    finished: items(finished, "data", "items"), acquisitionLeads: items(acquisition, "state", "leads"), mapLeads: items(map, "state", "leads"),
    publishJobs: items(publish, "state", "jobs"), detailSaves: items(details, "data", "completed"),
    materials: materials.ok ? items(materials, "data", "items").length : null,
    tutorials: tutorials.ok && items(tutorials, "data", "items").length ? items(tutorials, "data", "items").length : null
  };
}

const ROLE_COPY: Record<AgentRoleKey, (stats: OverviewStats | undefined) => ReactNode> = {
  production: (s) => <>本周做了 <b>{s?.finished.now ?? "—"}</b> 条成片</>,
  agent: (s) => <>本周触达 <b>{s?.reached.now ?? "—"}</b> 人</>,
  business: (s) => <>本周找到 <b>{s?.leads.now ?? "—"}</b> 条线索</>,
  operations: (s) => s?.details.now ? <>本周保存 <b>{s.details.now}</b> 张详情图</> : <>一张图出整套详情页</>,
  materials: (s) => s?.materials ? <>素材库 <b>{s.materials}</b> 段</> : <>现场画面随手用</>,
  tutorials: (s) => s?.publishedToday ? <>今天发出 <b>{s.publishedToday}</b> 条</> : <>手机矩阵 · 养号 · 分发</>
};

// 主页（用户 2026-10-29 选定 B1，色调用软件自己的白、浅粉和品牌红）：上面一张效果大片，
// 本周数字压在大片底部；下面 6 位 AI 员工一排，每位写着她自己的数字，点了就去找她。
export function AgentOverview({ preferences, onOpenRole, onStart, workflowTasks = [] }: {
  preferences: RolePreferences;
  onOpenRole: (role: AgentRoleKey) => void;
  onStart: () => void;
  workflowTasks?: Loose[];
}) {
  // Sources are read on opening and whenever the window comes back; WeChat tasks come live from the app.
  const [sources, setSources] = useState<Sources>();
  const refresh = useCallback(() => { void readSources().then(setSources); }, []);
  const stats = useMemo(() => sources && overviewStats({ ...sources, workflowTasks }), [sources, workflowTasks]);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const kpis: { value: number | string; unit: string; label: string; note: string }[] = [
    { value: stats?.finished.now ?? "—", unit: "条", label: "本周成片", note: stats && gain(stats.finished) ? `↑ ${gain(stats.finished)}` : "" },
    { value: stats?.leads.now ?? "—", unit: "条", label: "新线索", note: stats && gain(stats.leads) ? `↑ ${gain(stats.leads)}` : "" },
    { value: stats?.reached.now ?? "—", unit: "人", label: "微信已触达", note: stats && gain(stats.reached) ? `↑ ${gain(stats.reached)}` : "" },
    { value: stats?.publishedToday ?? "—", unit: "条", label: "今天已发出", note: stats?.platformsToday ? `${stats.platformsToday} 个平台` : "" }
  ];
  return <div className="home">
    <section className="home-hero" aria-label="本周成绩">
      <div className="home-hero-copy">
        <span className="home-chip">本周成绩</span>
        <h1>素材进来，<br /><em>客户</em>跟着来</h1>
        <p>剪辑、配音、字幕、封面，一次做好。</p>
        <button type="button" className="home-start" onClick={onStart}><Play size={18} fill="currentColor" />马上做一条</button>
      </div>
      <dl className="home-kpis">
        {kpis.map((kpi) => <div key={kpi.label}><dt>{kpi.label}</dt><dd><b>{kpi.value}</b><small>{kpi.unit}</small></dd>{kpi.note && <i>{kpi.note}</i>}</div>)}
      </dl>
      <div className="home-reel" aria-hidden="true">
        <div className="home-phone is-small"><img src="./video-examples/cc1-pro.jpg" alt="" /></div>
        <div className="home-phone"><video src="./video-examples/lead-mix.mp4" poster="./video-examples/lead-mix.jpg" autoPlay muted loop playsInline /><span>示例成片</span></div>
      </div>
    </section>
    <section className="home-crew-wrap" aria-label="6 位 AI 员工">
    <div className="home-crew-title"><h2>你的 6 位 AI 员工</h2><span>点一位，让她开始干活</span></div>
    <div className="home-crew">
      {AGENT_ROLE_ORDER.map((key) => {
        const appearance = appearanceFor(key, preferences[key].appearanceId);
        return <button type="button" key={key} className="home-mate" style={{ "--mate-surface": appearance.surface, "--mate-accent": appearance.strong } as CSSProperties} onClick={() => onOpenRole(key)}>
          <span className="home-mate-who"><strong>{AGENT_ROLE_IDENTITIES[key].responsibility}</strong><em>{preferences[key].name}</em></span>
          <img src={characterAsset(`login/${key}.webp`)} alt="" />
          <span className="home-mate-stat">{ROLE_COPY[key](stats)}</span>
        </button>;
      })}
    </div>
    </section>
  </div>;
}
