# CE3【中】口播批量默认"按我的文案走"：确认稿直接配音剪辑，严格画面核对改为可选开关

分支：`claude/narrated-follow-script`，从 `main`（cc7ecda）拉出。只合入代码，不发布。

## 背景（已确证：开发机 2026-10-01 11:12 的批次，数据副本只读核对）

- 批次 `narrated_batch_5ee76…`：用户提供完整文案（`script_source=provided`），确认后进入生产。状态 `completed_with_errors`，进度停在 60%，0/1 完成。
- 作品被 `narrated_edit_rejected` 跳过，原因来自逐段事实审核 `_grounded_claim_review`。审核把用户确认稿里的业务说法都判为"缺少画面证据"，例如"已办4期""真机20-25款""学不会每月免费复训"。审核原文甚至写了"用户确认的脚本文字只能证明作者如此表述，不能替代……证据"。
- 自动修复记录：先 `narrated_mapping_invalid`，再 `narrated_edit_rejected`，口播未改。
- 用户要求（原话要点）：
  1. 默认"按我的文案走"：用户确认的口播文案直接用于配音和剪辑，不要求每句话和镜头画面一一对应，镜头只按顺序和时长匹配；
  2. 广告法绝对化用语只提示、不拦截；
  3. 原来的严格核对改成可选开关，默认关闭；
  4. 目标：上传视频加文案就能跑通。

代码位置见 Explore 报告摘要（下文"现状"）。

## 现状（确认稿 = 每个已选文案的第 1 条作品，带 `_confirmed_script`）

- `NP.review_confirmed_candidate`（narrated_production.py 546-708）依次做：
  1. 云端文本模型"正文与镜头映射"（677）；
  2. `_ground_shots` 画面事实提取（视觉模型，594）；
  3. `_review_edit` → `_review`，其中：
     - `_grounded_claim_review`：逐段视觉审核，45→60%，结束时总是写 60%；
     - `_visual_review`：整片视觉审核；
     - brief 审核：仅非用户提供稿。
  4. 任一不通过：`narrated_edit_rejected` 等错误，最多重映射 3 次，之后跳过该作品。
- 镜头若缺 `fact_id`，会落入旧版付费审核 `_review` 3703。所以只跳过 `_ground_shots` 不够，必须显式绕过审核。
- 用户提供稿在 `_refresh_provider_analysis` 里还会对代表镜头做一次 `_ground_shots`（NB 1665-1666），是付费视觉调用。
- 不存在专门的广告法检测。确认稿走云端审核时，`_confirmed_user_fact_is_locally_bindable` 的正则（NB 446-455，唯一/第一/国家级/保证……）会强制判为不支持，即拦截。
- 设置的端到端通路可参照 `settings.video_template`：
  - `BatchCreativePage.tsx`：566 行选择器；localStorage `batch-studio-settings`；草稿 310-314、确认 351-352 时带上；
  - IPC：`narrated-batch-ipc.cjs` 118-132 白名单校验，74 行 `PUBLIC_FIELDS`；
  - Python：NB `save` 1206-1210 校验，4711 固定进运行；
  - 任何设置变化都会取消确认（`save` 1282-1292）。

## 要做

### 1. 新设置 `strict_visual_review`（布尔，默认 false）

- 端到端打通：
  - 界面开关，持久化方式同 `video_template`，一旦确认即锁定；
  - IPC 校验，非布尔值拒绝；
  - `PUBLIC_FIELDS`（若设置需回传）；
  - Python `save` 校验；
  - `confirm_selections` 的设置比对。
- 旧批次没有这个键时按 false 处理。
- 开关文案（可微调）：
  - 标题："严格核对画面事实"；
  - 说明："开启后逐句核对口播与画面，与画面不符的说法会被拦下，耗时更长、云端识别会计费。默认关闭：按你确认的文案直接配音剪辑。"

### 2. 默认模式（false）下，确认稿走"按文案排镜头"新路径

在 `review_confirmed_candidate` 入口分流。只看 `strict_visual_review`，并以 `_confirmed_script` 为准，不以 `_user_supplied` 为准：用户原样确认的 AI 稿也算确认稿。

- **零云端调用**：
  - 不做文本模型映射、`_ground_shots`、claim 审核、visual 审核、brief 审核、旧版 `_review`；
  - 测试里统计 `_cloud`、`_analyze_asset`、视觉调用都是 0。
- **镜头只按顺序和时长匹配**：
  - 单元：`confirmed_narration_units` 切出的单元，每段 ≤80 字，原文一字不改；
  - 镜头顺序：素材顺序在前、素材内按时间先后；
  - 分配：按顺序依次分给各段，每段已选镜头的 `target_duration_ms` 之和不小于该段 `_phrase_budget_ms`；
  - 每个镜头最多用一次；
  - 允许一段跨两个素材：本模式不要求"同一已确认活动"，需要时给 `_repack_duration_candidate` 增加对应开关，严格模式保持原规则；
  - 素材明显多于口播所需时，把选用镜头均匀分布到全部素材上，仍保持顺序，不能只用第一个素材的开头。
- **素材不够**时明确报错，不进入付费：
  - 进入 `needs_attention`；
  - 中文提示：素材总时长不够配完这段口播，请补充素材或缩短文案；
  - 优先复用现有的 `narrated_insufficient_unique_footage` 或 `narrated_copy_too_long` 语义与重排逻辑。
- **成功后**：候选状态、审核标记与原审核通过时一致，`_render_candidate` 照常接受。
  - 候选记录 `review_mode: 'follow_script'`，供界面展示"按文案生成，未做画面事实核对"；
  - 若需回传，加进 `PUBLIC_FIELDS`。
- **进度**：本路径显式写 45→60%，文案为"正在按文案顺序安排镜头"。之后渲染 60→95% 照旧。
- **与历史作品重复**：确认稿在本模式下不因此被拒，变体照旧。
- **保持不变**：
  - `_verify_confirmed_script`；
  - 确认稿最低时长检查；
  - 渲染后按实测时长重排（CD `rebalance_narrated_phrase_refs`）；
  - 声音批准；
  - 预算；
  - `outcome_unknown` 不自动重发；
  - `_run_id` 已存在时不重映射。
- **分析阶段**：用户提供稿在默认模式下跳过代表镜头的 `_ground_shots`。新的变体流程（见第 4 节）只依据文字，不需要画面事实。

### 3. 严格模式（true）

- 行为与现在完全一致。
- 现有钉住严格行为的测试，改为在批次设置里显式打开 `strict_visual_review=True` 后继续通过。

### 4. AI 变体（序号 >1 的作品）也不核对（用户 2026-10-01 追加要求）

默认模式下，`run_production` 里 `candidate is None` 时不再调用 `_plan`，改走新的"按文案改写"流程。严格模式仍调用 `_plan`，行为不变。

- **文字**：每条变体只调用一次文本模型（不带画面），在该方向已确认文案的基础上改写。
  - 提示词：
    - 保留原文全部事实、数字、价格、承诺、地点和行动号召；
    - 不新增任何事实、数字、承诺或最高级用语；
    - 只换开头、表达和段落顺序；口语化。
  - 时长：与确认稿预计口播时长相差不超过 ±15%，且不低于最低时长；
  - 必须与确认稿、已有变体明显不同；
  - 只返回 JSON `{title, narration}`。
- **只做格式校验**，不做事实核对：
  - 校验内容：非空、长度和时长范围、不与确认稿或已有变体近似重复、素材容量够用；
  - 不通过时用 `_cloud` 的 `validation_error` 让模型重写，次数受现有预算限制。
  - 仍不通过时跳过本条，报中文原因，不影响确认稿和其他条。
- **调用安全**：走 `_cloud`，所以 `_planning_inflight`、`outcome_unknown` 不自动重发、预算这些规则全部照旧。
- **镜头**：与确认稿用同一套"按顺序和时长"分配。素材允许时，起点或选用的镜头要与确认稿及已有变体错开，避免完全相同的镜头序列；但不能因此拦截。
- **其余流程**：生成的候选标记 `review_mode: 'follow_script'`，之后与确认稿相同：
  - 不做 `_ground_shots` 和任何 claim、visual、brief 审核；
  - 直接渲染；
  - `_verify_confirmed_script` 只对确认稿生效。
- **"准备文案"阶段**（AI 根据素材写草稿，`NSD.prepare`）：
  - 默认模式下不再用"文案事实复核"（NSD 136-160）剔除草稿，草稿交给用户自己确认。
  - 起草本身仍需要画面理解（`_analysis` 和代表镜头的 `_ground_shots`），保留。
  - 严格模式不变。

### 5. 继续未完成作品

- 默认模式下，以前因画面核对被跳过的确认稿，点"继续未完成作品"后要能用新路径重跑。包括：
  - 已在 `MAPPING_ERRORS` 里的 `narrated_edit_rejected`、`narrated_mapping_invalid`；
  - 原本不可重试的 `narrated_facts_invalid`、`narrated_claim_review_invalid`、`narrated_frames_missing`：仅确认稿、仅默认模式下改为可重试。
- 重跑只在用户点击时发生（已有可信点击门槛），且不对已有 `_run_id` 或 `outcome_unknown` 的作品重跑。

### 6. 广告法绝对化用语：只提示，不拦截，不改字

- 渲染进程新增纯函数模块（例如 `src/renderer/ad-law-terms.ts`），在文案确认处和作品文案展示处列出命中的词和所在句子。
- 词表至少包含 product-detail `_EXTREME_WORD_MAP`（app.py 435-447）的键，另加：
  - 最佳、最先进、全网第一、首个、首选、国家级、世界级、史上、绝对、100%、万能、永久、根治；
  - 包过、包会、保证、确保（承诺类，可单列为"承诺用语"）。
- 不阻止确认、不禁用按钮、不改写文本。
- 严格模式下，原有正则拦截行为不变。

## 测试（每条都要证明在 cc7ecda 上失败或不存在）

**Python**（`desktop/sidecars/content-engine/tests`，按 CI 方式运行）：

1. 回放用户案例：
   - 用户提供稿，含"已办4期""20-25款""每月免费复训"等画面看不到的说法；
   - 默认模式下生产到渲染；
   - `_cloud`、视觉、分析调用均为 0；
   - 镜头保持顺序、不重复、各段容量足够；
   - 文案逐字不变。
2. 素材多于所需时，镜头覆盖多个素材且保持顺序；素材不足时报中文错误、进入 `needs_attention`、无付费调用。
3. 一段跨素材时，默认模式允许，严格模式仍按原规则。
4. 严格模式下，同一用例仍被 claim 审核拒绝，即旧行为不变。
5. 旧批次的作业因 `narrated_edit_rejected` 或 `narrated_facts_invalid` 被跳过后，默认模式下"继续"能重跑并到达渲染；`_run_id` 或 `outcome_unknown` 的作业仍不重跑。
6. 用户原样确认的 AI 稿（无 `_user_supplied`）在默认模式下同样走新路径。
7. 设置校验：非布尔值拒绝；缺省为 false；改设置会取消确认。
8. 变体：
   - 默认模式下 1 条确认稿 + 2 条变体：每条变体恰好 1 次文本 `_cloud`，0 次视觉或审核调用；
   - 变体保留原文数字；
   - 镜头序列与确认稿不完全相同（素材足够时）；
   - 格式不合格时重写，之后仍不合格则跳过本条，其他条照常完成；
   - 严格模式下仍调用 `_plan`；
   - `_cloud` 结果未知时进入 `outcome_unknown`，不重发。
9. 准备文案：默认模式下草稿不因事实复核被剔除；严格模式仍剔除。

**渲染进程 / IPC**：

10. 开关的持久化与锁定；IPC 校验；`PUBLIC_FIELDS`；广告法词表的纯函数测试（命中、句子定位、不改原文）。
11. 已有 self-check 中对 `BatchCreativePage.tsx` 源码做正则匹配的不要误伤。

**数据副本端到端**：

12. 只读复制开发机库 `%APPDATA%/xiaoxi-active-touch-test/content-engine`，到 `C:/Users/Scott/xiaoxi-review/live-db-copy`（已有一份），在副本上用桩替换所有提供方，统计调用次数。
    - 对批次 `narrated_batch_5ee76cefbba442dbaa073ffe42af1aa3` 走"继续"；
    - 证明确认稿到达渲染入口：渲染也用桩，不发真实 TTS；
    - 提供方真实调用为 0；
    - 输出镜头分配摘要。
    - 不得写回真实数据目录。

**最后**：运行 `npm.cmd run check:self` 和 `npm.cmd run build:test`，报告退出码。

## 不做

- 不改 TTS、渲染、音乐。
- 不新增云端调用类型。变体改写用的是已有的文本模型通道；默认模式下总调用数应比现在少。
- 不改已发布版本的公告。新版本公告在发布时补。
