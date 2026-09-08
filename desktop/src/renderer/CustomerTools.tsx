import { BookOpen, Bell, RefreshCw, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { CustomerPanel } from "./CustomerPanel";
import type { CloudStatus } from "./CloudMaintenance";
import type { AgentHomeTarget } from "./AgentHome";

type TutorialTarget = AgentHomeTarget | "api-key" | "diagnostics";
const GUIDES: { title: string; heading: string; intro: string; steps: string[]; links: { title: string; target: TutorialTarget }[]; note: string }[] = [
  { title: "快速开始", heading: "先完成一件小事", intro: "从你今天最想完成的事情开始：联系客户，或做出一条视频。",
    steps: ["使用授权信息登录软件，在「API密钥」配置已开通的 AI 服务。", "要运营微信客户，先同步联系人；要制作内容，先把真实图片和视频加入素材仓库。", "进入对应工作台，确认客户范围或创作要求后再开始。进度和需要确认的内容会留在任务里。"],
    links: [{ title: "配置 AI 服务", target: "api-key" }, { title: "打开素材仓库", target: "materials" }], note: "角色主页的「形象与名字」可以更换伙伴外观和称呼，下次打开仍会保留。" },
  { title: "微信客户运营", heading: "让客户运营有计划", intro: "先确认当前登录的微信和客户范围，再安排每天要做的事情。",
    steps: ["打开「同步联系人」，按提示确认微信账号并完成同步。首次同步可能需要重新登录微信。", "在「今日计划」选择要执行的触达或朋友圈任务，确认对象、内容和时间。", "需要客户接待时进入「自动回复」，检查资料和接待范围后开启。", "出现「需要处理」时打开对应任务查看原因；发送结果不确定时，先在微信核对再操作。"],
    links: [{ title: "同步联系人", target: "contact-sync" }, { title: "查看今日计划", target: "workflow" }], note: "微信任务运行时尽量保持窗口可用，避免同时手动切换会话或修改正在发送的内容。" },
  { title: "内容创作", heading: "把真实素材做成视频", intro: "先给素材和背景，再选文案。已经完成的步骤会保留在制作任务中。",
    steps: ["在素材仓库选择图片、视频，进入创作工作台。", "填写目标客户；在「你想表达什么」说明实际背景、人物与素材的关系，可补充结尾引导。", "阅读三个文案方向，选择一份并确认完整正文、数量、声音和配乐。", "开始制作，等待画面、配音、字幕和视频合成完成。需要确认或资料不足时，按具体提示处理。", "在成片中心完整播放检查，再导出使用；修改文字后注意重新检查声画和字幕。"],
    links: [{ title: "进入创作工作台", target: "workspace" }, { title: "查看成片", target: "finished" }], note: "这里介绍的是使用真实素材制作视频。独立的文生视频、图生视频入口尚未开放。" },
  { title: "素材与成片", heading: "素材和作品各有位置", intro: "素材仓库存原料，创作工作台存制作进度，成片中心看完成的作品。",
    steps: ["将同一活动或同一商品的素材整理到素材集，并补充必要的事实说明。", "原文件留在原来的磁盘位置。移动或删除原文件后，需要重新定位才能继续使用。", "首页「待处理制作」按业务批次统计，分析和审核等处理步骤可在详情查看。", "旧制作可在历史记录中查看；归档批次会退出待处理列表，素材和已有成片继续保留。"],
    links: [{ title: "管理素材", target: "materials" }, { title: "打开成片中心", target: "finished" }], note: "成片仍需要完整播放检查。后台某个步骤完成，不代表整条视频已经制作成功。" },
  { title: "常见问题", heading: "遇到问题，直接告诉我们", intro: "不必理解错误码，也可以把问题说清楚。",
    steps: ["AI 服务提示额度、余额或权限问题时，核对对应服务账户和配置，保留当前制作进度。", "制作提示资料不足时，补充真实素材或调整表达，不必反复点击重新生成。", "打开「吐槽中心」，描述刚才做了什么、哪里不好用。可随本次反馈附带脱敏诊断。", "在「我的反馈」查看待处理、处理中或已解决状态；需要人工协助时，可展开底部日志诊断导出诊断包。"],
    links: [{ title: "前往吐槽中心", target: "diagnostics" }, { title: "检查 AI 配置", target: "api-key" }], note: "渠道发布、线索回流等标注为未开放的功能尚不能执行；教程会随实际功能一起更新。" }
];

export function CustomerTools({ onNavigate }: { onNavigate: (target: TutorialTarget) => void }) {
  const [panel, setPanel] = useState<"announcements" | "tutorial" | null>(null);
  const [state, setState] = useState<CloudStatus>();
  const [error, setError] = useState("");
  const [guideIndex, setGuideIndex] = useState(0);
  useEffect(() => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api) return;
    let active = true; let updated = false;
    const receive = (value: CloudStatus) => { if (active) setState(value); };
    const unsubscribe = api.onUpdate((value) => { updated = true; receive(value); });
    void api.status().then((value) => { if (!updated) receive(value); }).catch(() => { if (active) setError("暂时无法读取公告，可稍后刷新。"); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const refresh = async () => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api) return;
    setError("");
    try { setState(await api.announcements()); }
    catch { setError("公告暂时刷新失败，本机记录仍可查看。"); }
  };
  const read = (sequence: number) => {
    if (!window.xiaoxiCloudMaintenance) return;
    void window.xiaoxiCloudMaintenance.readAnnouncement(sequence).then(setState).catch(() => setError("已读状态暂未保存，请稍后重试。"));
  };
  const guide = GUIDES[guideIndex];
  return <div className="topbar-tools">
    <button type="button" className="topbar-tool" aria-label={`更新公告${state?.unreadAnnouncements ? `，${state.unreadAnnouncements} 条未读` : ""}`} title="更新公告" aria-expanded={panel === "announcements"}
      onClick={() => { setPanel("announcements"); void refresh(); }}><Bell size={17} /><span>更新公告</span>{Boolean(state?.unreadAnnouncements) && <span className="topbar-unread" aria-hidden="true" />}</button>
    <button type="button" className="topbar-tool" aria-label="使用教程" title="使用教程" aria-expanded={panel === "tutorial"} onClick={() => setPanel("tutorial")}><BookOpen size={17} /><span>使用教程</span></button>
    {panel === "announcements" && <CustomerPanel title="更新公告" description="看看这次有哪些改进。" onClose={() => setPanel(null)}>
      <div className="announcement-toolbar"><span>当前版本 {state?.version || "—"}</span><button type="button" className="customer-text-button" disabled={!state?.enabled || state.announcementsChecking} onClick={() => void refresh()}><RefreshCw size={14} />{state?.announcementsChecking ? "正在刷新…" : "刷新公告"}</button></div>
      {state?.announcements?.length ? <div className="announcement-list">{state.announcements.map((entry, index) => <details key={entry.sequence} className="announcement-entry" open={index === 0 ? true : undefined}
        onToggle={(event) => { if (event.currentTarget.open && !entry.read) read(entry.sequence); }}>
        <summary><strong>版本 {entry.version}</strong>{!entry.read && <span className="announcement-new">新更新</span>}{entry.publishedAt && <time dateTime={entry.publishedAt}>{new Date(entry.publishedAt).toLocaleDateString("zh-CN")}</time>}</summary>
        <p>{entry.notes || "此版本尚未提供更新说明。"}</p>
      </details>)}</div> : <p className="customer-empty">{state?.enabled ? "暂时没有收到更新公告。联网后刷新即可查看。" : "当前版本尚未启用云端公告。使用教程仍可离线查看。"}</p>}
      {(error || state?.announcementError) && <p className="customer-error" role="alert">{error || state?.announcementError}</p>}
      {state?.lastAnnouncementsCheck && <p className="customer-field-hint">最近检查：{new Date(state.lastAnnouncementsCheck).toLocaleString("zh-CN", { hour12: false })}。这里保留本机最近收到的公告。</p>}
    </CustomerPanel>}
    {panel === "tutorial" && <CustomerPanel title="使用教程" description="从一个具体任务开始，几步找到下一步。" onClose={() => setPanel(null)}>
      <nav className="tutorial-categories" aria-label="教程分类">{GUIDES.map((entry, index) => <button type="button" key={entry.title} aria-pressed={guideIndex === index} onClick={() => setGuideIndex(index)}>{entry.title}</button>)}</nav>
      <article className="tutorial-article"><h3>{guide.heading}</h3><p>{guide.intro}</p><ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        <div className="tutorial-links">{guide.links.map((link) => <button type="button" className="secondary-button" key={link.target} onClick={() => { setPanel(null); onNavigate(link.target); }}>{link.title}<ArrowRight size={15} /></button>)}</div>
        <p className="tutorial-note">{guide.note}</p>
      </article>
    </CustomerPanel>}
  </div>;
}
