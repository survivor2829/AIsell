# 成片流程实施与验证

日期：2026-09-05。用户在实施中确认尚未开通火山语音账号，本轮先完成接口和流程。

后续更新：用户现已保存 API Key、开通服务并选定小何 2.0，实际 15.221 秒试听已生成，默认声音已保存，见 [小何接入记录](2026-09-05-xiaohe-voice-selection.md)。早先直率英子请求被拒绝的记录保留于 [首次试听记录](2026-09-05-volc-audition-first-attempt.md)。下文保留接口实施阶段的原始验证范围。

## 已实现

- 四步主流程：选素材、阅读三个完整文案、选择方向并确认、自动制作本批。备选 `script_options` 与成片 `candidates` 独立，成片数量不再受三个备选影响。
- 每稿展示受众、痛点、角度、正文、预计时长和版本。正文可修改；确认保存正文快照和版本，首条严格使用确认正文。后续稿沿用选定方向，首条完成后再继续生成。修改会使确认失效，不能悄悄换稿。
- 保留旧批次流程、旧声音批准状态和缓存。已完成一条后增加本批数量，可以继续制作第二条；明确重试可恢复已知本地渲染失败，外部结果未知仍不重提。
- 火山引擎官方 SSE 配音接口、加密 API Key 设置与三个待试听预置候选已接通。新候选共用试听正文和 -16 LUFS 音量处理；未自动批准任何新声音。
- 折叠配乐选择区提供真实本地试听、曲库勾选和换曲。仅从指定可用曲库中按内容选曲，同批优先未使用且匹配的曲目，并保存实际选曲记录。旧批次未指定曲库时保持兼容。
- 复用 ASR 的词句时间，显示文字仍取确认正文；可靠逐句镜头绑定才调整分镜。没有细分时间时保留整句，不制作虚假的逐字同步；整句过长无法清楚排成两行时，返回具体原因并要求修改后重新确认。
- 新流程字幕采用白字黑描边、约 64px、画面 74% 高度、一到两行；取消旧模板的蓝色遮罩和画面脉动。少量关键词强调、本地 Noto 表情仅作装饰，相关许可证随资源保存。

## 实际验证

- `npm.cmd run build:test` 最终通过；主进程与预加载 JS 语法检查通过。独立 Remotion development 运行时构建及 Chromium composition 检查通过，目录为 `desktop/.build/remotion-runtime/narration-v2-20260905`，旧运行时保留。
- Python 编译及必要专项检查通过：三稿阶段零渲染、确认首条先于后续稿、修改/过期版本、旧六条批次、同稿本地重试、音色目录与旧缓存兼容、未知结果不重复、指定曲库隔离和轮换、真实字幕时间与过长无时间字幕失败原因。
- 实际 Electron 已读取三个新候选，均为 `pending/not_ready`；火山配置为未配置。四首原有授权配乐可以读取，其中一首成功返回约 20 秒本地 WAV 试听。该操作没有云端请求，也没有把这些旧曲标成热门。
- 使用实际 React 组件与明确标注的合成数据进行离线界面检查：选第二个方向、编辑正文不提交镜头字段、新版本正文正确显示、已完成 1/目标 2 时继续入口有效；1440px 三列与 920px 单列无横向溢出或页面错误。它不是 AI 生成结果或真实批量成片。
- 本地 Remotion 字幕样式图片已渲染并目视检查；该图片只验证样式，不代表正文、声音或完整成片验收。
- 仓库全量 `tsc --noEmit` 因已有 React 类型声明缺失产生大量类型错误，不能报告全仓 TypeScript 检查通过。没有为此扩展修改无关依赖。

验证文件：

- `outputs/video-optimization-20260905/implementation-preview/script-choice-wide.png`
- `outputs/video-optimization-20260905/implementation-preview/script-choice-narrow.png`
- `outputs/video-optimization-20260905/implementation-preview/script-choice-ui-check.json`
- `outputs/video-optimization-20260905/implementation-preview/electron-voice-candidates.png`
- `outputs/video-optimization-20260905/implementation-preview/electron-live-check.json`
- `outputs/video-optimization-20260905/implementation-preview/subtitle-style.png`
- `docs/reviews/2026-09-05-volcengine-boundary-review/review.json`

## 尚待实际验收

1. 开通火山语音账号，在创作工作台的声音设置中保存 API Key，分别试听并批准喜欢的声音。候选为直率英子、懒音绵宝、解说小明；只有直率英子同时有本次近期教程线索，后两是有官方接口的替代候选，不是已核实的热门同款。真实语速和 15–20 秒样本时长须在账号接入后实测。
2. 新热门曲库目前新增 **0 首已确认可导出曲目**。《早晨的光》《启程》《远去的列车》等五条线索已记录，但教程精确版本、适配听感和导出授权未齐全。核验详情见 `outputs/video-optimization-20260905/audition-research.md`。
3. 声音和配乐选定后，用真实素材生成三个稿件，确认其中一稿先做一条，再在同批增加至两条。核对首条正文完全一致、后续方向一致且内容有变化、字幕和镜头时间、配乐轮换，并用手机外放确认人声清楚、音乐不抢。

本轮没有付费云调用、没有新完整成片、没有发布或重新打包。原素材与旧样片保留。其他并行任务产生的工作区改动不属于本报告。
