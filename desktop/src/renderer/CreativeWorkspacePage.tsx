import { BookOpenCheck, Clapperboard, Layers3, Scissors, Sparkles } from "lucide-react";
import "./CreativeWorkspacePage.css";

export function CreativeWorkspacePage() {
  return (
    <section className="page creative-workspace-page">
      <div className="page-head">
        <div>
          <h1>创作工作台</h1>
          <p>脚本生成是剪辑流程中的一个步骤，不再单独设置“AI脚本工厂”。</p>
        </div>
        <span className="workspace-building-badge">建设中</span>
      </div>

      <div className="workspace-foundation-note">
        <Layers3 size={21} />
        <div>
          <strong>先共用一套素材与成片底座</strong>
          <p>两种模式共用素材索引、字幕、品牌模板、时间线、渲染任务和成片中心，避免重复建设。</p>
        </div>
      </div>

      <div className="workspace-mode-grid">
        <article className="workspace-mode-card">
          <div className="workspace-mode-icon">
            <Scissors size={25} />
          </div>
          <div className="workspace-mode-copy">
            <span className="workspace-mode-order">优先建设</span>
            <h2>课程拆条</h2>
            <p>面向 10–40 分钟课程、会议或导师口播，自动转写并寻找观点完整的短视频片段。</p>
            <ul>
              <li><BookOpenCheck size={15} /> 生成章节、字幕和 3–8 个候选片段</li>
              <li><Clapperboard size={15} /> 竖屏重构、动态字幕和品牌包装</li>
              <li><Sparkles size={15} /> 人工调整起止点后再输出成片</li>
            </ul>
          </div>
          <button disabled>底座验收后开放</button>
        </article>

        <article className="workspace-mode-card">
          <div className="workspace-mode-icon is-mix">
            <Sparkles size={25} />
          </div>
          <div className="workspace-mode-copy">
            <span className="workspace-mode-order">第二阶段</span>
            <h2>智能混剪</h2>
            <p>面向碎片口播、产品视频、图片和产品详情图，按脚本意图匹配已有素材。</p>
            <ul>
              <li><BookOpenCheck size={15} /> 输入脚本，或根据选中素材生成脚本</li>
              <li><Clapperboard size={15} /> 自动选镜头、控重复率和节奏</li>
              <li><Sparkles size={15} /> 素材不足时明确提示，不虚构案例</li>
            </ul>
          </div>
          <button disabled>课程拆条之后开放</button>
        </article>
      </div>
    </section>
  );
}
