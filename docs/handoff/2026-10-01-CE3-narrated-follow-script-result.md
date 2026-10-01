# CE3 结果：口播批量默认"按我的文案走"，严格画面核对改为可选开关

分支 `claude/narrated-follow-script`（基于 `main` cc7ecda），未推送。任务卡见 [2026-10-01-CE3-narrated-follow-script-task.md](2026-10-01-CE3-narrated-follow-script-task.md)。

## 第 3 轮（修复第 2 轮审查）

第 2 轮审查的结论成立：分支上只有任务卡，没有任何实现和测试（flow-R2F-1～8、safety-S1～S8、tests-R2-1～2 都指向这一点）。本轮补齐全部实现、测试和数据副本回放。提交：

- `b850e1d` 内容引擎：新设置、默认按文案排镜头、变体改写、准备文案、分析阶段、继续重跑，以及 Python 测试；
- `20fd7f2` IPC 与界面：设置白名单和回传、开关、"按文案生成"标记、广告法提示模块及自检；
- 本文档的提交。

### 改了什么

1. **设置 `strict_visual_review`**（布尔，缺省按 false）
   - `narrated_batch.py` `save`：加入键白名单，非布尔值报 `invalid_narrated_settings`（"画面核对开关无效。"）。旧批次没有这个键，`narrated_production.strict_visual_review()` 只认显式 `True`。
   - 改设置会取消确认：沿用 `save` 原有的整体比较；`confirm_selections` 的设置比对也是整体相等比较，新键自动参与，无需改动。
   - `narrated-batch-ipc.cjs` `soundSettings`：加入白名单，非布尔值（含 `null`、`"true"`、`1`）在主进程就拒绝；`PUBLIC_FIELDS` 加 `strict_visual_review`、`review_mode`。`invalid_narrated_settings` 的文案补上"画面核对开关"。
   - `BatchCreativePage.tsx`：视频样式下方加开关"严格核对画面事实"，说明文字按卡片原文。持久化与 `video_template` 相同（`batch-studio-settings`，开始和确认时写入），确认后禁用。"继续未完成作品"的提示按模式区分。
2. **默认模式：确认稿按文案排镜头**（`narrated_production.py`）
   - `review_confirmed_candidate` 在最低时长检查之后用 `follows_script` 分流：只看 `strict_visual_review`，以 `_confirmed_script` 为准，所以用户原样确认的 AI 稿也走新路径。
   - `arrange_follow_script` → `follow_script_candidate` → `follow_script_phrases` / `follow_script_footage`：
     - 不调用 `_cloud`、`_ground_shots`、`_review_edit`/`_review`/claim/visual/brief 审核；
     - 段落是 `confirmed_narration_units` 的单元（≤80 字，原文不改）。只有空白的单元并入相邻段；超过 40 段时合并最短的相邻两段，合并后仍须 ≤80 字；
     - 镜头池按素材分组顺序、素材内时间排序，按 `visual_key` 去重并排除重叠区间；
     - 每段取紧接的最少镜头，使 `target_duration_ms` 之和不小于 `_phrase_budget_ms`。一段可以跨到下一个素材；
     - 素材有富余时，把空余时长平均分到段与段之间：第一段从第一个素材开头，最后一段落在最后一个素材，顺序不变；
     - 素材不够时报 `narrated_insufficient_unique_footage`："素材总时长不够配完这段口播：约需 N 秒不重复画面，现有约 M 秒；请补充素材或缩短文案。"`run_production` 原有逻辑把它转为 `needs_attention`，作业保持 queued。需要超过 40 个镜头时报 `narrated_copy_too_long`。
   - 结果与原来审核通过时一致：`status=planned`、`review_version=2`，另记 `review_mode='follow_script'` 和 `review_reason`。进度显式写 45%"正在按文案顺序安排镜头"、60%"已按文案顺序安排镜头"。`_voice_capacity_retry` 时预算放宽 1.2 倍重排（文字不变，配音缓存可复用）。
   - 与历史作品重复：确认稿在排镜头时不比对历史；`validate_actual_timeline`（配音之后）对 follow_script 确认稿也不比对。否则付费配音之后仍会被拒。变体仍比对已发布作品。
   - `_create_run`：follow_script 作品只做本地 `narrated_brief.issue` 格式检查，不调用 `narrated_brief.review`。
   - 保持不变：`_verify_confirmed_script`、最低时长检查、CD `rebalance_narrated_phrase_refs`、声音批准、预算、`outcome_unknown` 不重发、有 `_run_id` 时不重映射。
3. **AI 变体**（`run_production`、`rewrite_variation`）
   - 默认模式下 `candidate is None` 不再调用 `_plan`，改为一次 `_cloud`（purpose"文案改写"，`generation_rules=False`，不带画面）。提示词：保留全部事实、数字、价格、承诺、地点和行动号召；不新增事实、数字、承诺或最高级用语；只换开头、表达和段落顺序；只返回 `{title,narration}`。
   - 只做格式校验，用 `_cloud` 的 `validation_error` 让模型在同一次请求里重写：
     - 标题 1～100 字，正文 1～2400 字；
     - 非空白字数在原文的 ±15% 内，且不低于最低时长所需字数；
     - 与确认稿、已有变体的相似度不超过 0.9；
     - 素材容量够用（与确认稿同一套分配）。
   - 仍不合格时报 `narrated_variation_invalid`（"AI 改写未通过格式检查，已跳过本条：…"），只跳过本条，其他条照常完成。
   - 镜头：同一套"按顺序和时长"分配。起点依次试空余时长的 1/2、1/4、3/4……，与本批已有作品错开；错不开也不拦截。
   - 严格模式仍走 `_plan`。`_planning_inflight`、`outcome_unknown` 不重发和预算都由 `_cloud` 原样负责。
4. **准备文案**（`narrated_script_drafts.prepare`）：默认模式不再发起"文案事实复核"，草稿只按重复方向剔除，交给用户确认；`_draft_review` 为空，提示改为"请通读文案后确认……"。严格模式与原来逐字一致。
5. **分析阶段**（`_analysis(observe=...)`、`_refresh_provider_analysis`）：默认模式在生产前补分析时不做代表镜头的 `_ground_shots`，提供方迁移时的重新分析同样不做。未取证的镜头使用单独的 `_analysis_key`，之后准备文案时仍会重新取证。起草本身（scripts 动作）不变。
6. **继续未完成作品**（`retryable_planning_jobs`）
   - 默认模式下，确认稿因 `narrated_facts_invalid`、`narrated_claim_review_invalid`、`narrated_frames_missing` 被跳过时改为可重试。`narrated_edit_rejected`、`narrated_mapping_invalid` 原本就在 MAPPING_ERRORS 里，重试后走新路径。
   - 有 `_run_id`、状态或错误码为 unknown 的确认稿一律不重试，`_planning_inflight` 时整批不重试。
   - 另把 `narrated_variation_invalid` 加入可重试集合，与 `narrated_no_usable_candidate` 一样，只在用户点击后重跑。
7. **广告法提示**（新增 `src/renderer/ad-law-terms.ts`、`BatchCreativeBrief.tsx` 的 `AdLawHint`）
   - 词表包含 product-detail `_EXTREME_WORD_MAP` 的全部键，以及卡片列出的追加词（另加全角"100％"）。"包过、包会、保证、确保"单列为承诺用语，显示时标注"（承诺用语）"。
   - 按句列出命中词：长词覆盖其中的短词，例如"全网第一"不再重复列"第一"。
   - 显示位置：确认文案（`BatchTopicChoices` 的确认视图、旧版方向卡片）和作品的"完整口播与镜头安排"。只提示，不禁用按钮，不改文字。
   - 严格模式下 `_confirmed_user_fact_is_locally_bindable` 的正则拦截不变；默认模式不会走到这里。
8. **旧版单稿确认路径**（`_run_script_workflow`）：当前界面总是带 `selections` 走 `run_production`，没有用到这条路径。为保持一致，默认模式下 `needs_review` 的确认稿改走 `review_confirmed_candidate`（即新路径），严格模式不变。这条路径的续作仍调用 `_plan`，见下文范围说明。

### 与卡片的出入（请审查确认）

- **没有改 `_repack_duration_candidate`**：新路径自己生成段落，直接交给 `_normalize_candidate`，后者没有"同一已确认活动"的限制，所以不需要新开关。严格模式的映射仍经 `_repack_duration_candidate`，原规则由测试 3 钉住。
- 卡片外的改动：`_create_run` 跳过 brief 复核；`validate_actual_timeline` 的重复检查豁免（理由见上）；旧版单稿路径的分流；`narrated_variation_invalid` 可重试；默认模式下 unknown 确认稿不重试（比原来更严）。
- `run()` 在生产前仍检查云端网关已配置。这只是检查配置，不发请求；本卡没有改。
- 测试 5 里 `narrated_facts_invalid` 的跳过状态由测试按旧版留下的样子构造，因为新代码在默认模式下不会再产生这个错误码。

### 验证（`C:/Users/Scott/xiaoxi-review/ce3/desktop`，%TEMP% 以外；Python 3.12.14，Node v24.16.0）

内容引擎按 CI 的 service-and-content 任务，在 `desktop/sidecars/content-engine` 运行 `python -m unittest discover -s tests -p …`：

| 命令 | 结果 |
|---|---|
| `-p 'test_narrated*.py'` | `Ran 129 tests in 18.534s` `OK`（cc7ecda 上为 117 个；新增 12 个） |
| `-p 'test_production_summary.py'` | `Ran 4 tests in 0.034s` `OK` |
| `-p 'test_provider_usage.py'` | `Ran 10 tests in 0.576s` `OK` |
| `-p 'test_auto_mix_voice_resources.py'` | `Ran 33 tests in 1.963s` `OK` |
| `server/maintenance` `-p 'test_*.py'` | `Ran 7 tests in 2.742s` `OK` |
| `node src/main/narrated-batch-ipc.self_check.cjs` | `narrated batch IPC self-check passed` |
| `node src/renderer/ad-law-terms.self_check.cjs`（新） | `ad-law hint and strict review switch self-check passed` |
| `npm.cmd run check:self` | exit 0，共 99 项（串行 88 项，并行组 11 项），新自检在其中；最后一行 `all source self-checks passed` |
| `npm.cmd run build:test` | exit 0，`✓ built in 3.87s`、`test renderer build completed`；`dist-development` 中有"广告法提示""按文案生成，未做画面事实核对"和开关文案 |

- 钉住严格行为的 11 个原有测试改为在批次设置里显式打开 `strict_visual_review=True`（10 个在 `test_narrated_production.py`，1 个在 `test_narrated_brief.py`），改后都通过。其中 5 个不打开就会失败：两个草稿复核、`_review_edit` 断点续跑、变体走 `_plan`、草稿映射付费调用。
- 原有 `self_check` 对 `BatchCreativePage.tsx` 做的源码正则（draft-queue、voice-recovery）没有受影响，都在 check:self 中通过。
- 没有运行 `tsc`。

### 新测试（`test_narrated_production.py`）与卡片测试编号

| 卡片 | 测试 |
|---|---|
| 1 | `test_provided_copy_with_unseen_claims_reaches_render_without_any_paid_call`：用户提供稿，含"已办4期""20-25款""学不会每月免费复训"；`_cloud`/视觉/审核/`_plan`/`_analyze_asset`/提供方请求均为 0；真实 `_create_run`；镜头按素材和时间排序且不重复，各段容量足够，覆盖全部 7 个素材；文案逐字不变；进度 45/60；已发布作品与本作品镜头相同也不拒 |
| 2 | `test_surplus_footage_spreads_in_order_and_shortage_stops_before_paid_work`（含镜头长短不一时不复用镜头） |
| 3 | `test_default_mode_lets_one_paragraph_continue_into_the_next_material` |
| 4 | `test_strict_mode_still_reviews_and_refuses_the_same_copy`（同一文案：严格模式取证、claim 审核拒绝、尝试一次付费重映射；默认模式 0 次调用） |
| 5 | `test_continue_reruns_confirmed_copy_skipped_by_the_visual_review`（`narrated_edit_rejected`、`narrated_facts_invalid` 两种；`_run_id`、unknown、`_planning_inflight` 不重跑；严格模式保持原规则） |
| 6 | `test_ai_draft_confirmed_unchanged_takes_the_follow_script_path` |
| 7 | `test_strict_setting_is_boolean_defaults_off_and_unconfirms_when_changed` |
| 8 | `test_variations_are_one_text_rewrite_each_without_visual_review`、`test_unknown_variation_rewrite_is_not_sent_again`；严格模式仍调用 `_plan` 由已改为严格的 `test_selected_counts_preserve_both_seeds_and_resume_without_duplicates` 钉住 |
| 9 | `test_default_draft_preparation_keeps_drafts_for_the_user_to_confirm`；严格模式由 `test_draft_preparation_keeps_good_choices_and_repairs_only_the_rejected_one` 钉住 |
| 分析阶段 | `test_default_analysis_skips_representative_frames_but_strict_keeps_them` |
| 旧版路径 | `test_single_confirmation_path_also_follows_the_script_by_default` |
| 10、11 | `narrated-batch-ipc.self_check.cjs` 新增段落、`ad-law-terms.self_check.cjs` |

### 在 cc7ecda 上失败的证明

- **Python**：把 `content_engine` 换成 cc7ecda 的版本（`git archive`），测试保持本分支，放在 `C:/Users/Scott/xiaoxi-review/ce3-e2e/old-proof/`。12 个新测试 `Ran 12 tests`、`FAILED (failures=9, errors=5)`，日志在 `ce3-e2e/old-proof.log`：
  - 测试 1：`0 != 1 : _cloud must not run in the default mode`；
  - 测试 5：`Lists differ: [] != [{...}]`（旧版重新排队后又进入审核），以及 `narrated_facts_invalid` 时 `False is not true`；
  - 测试 6：`0 != 2 : _cloud`；
  - 测试 7：旧版 `save` 拒绝这个键，报"批量创作设置格式无效。"；
  - 测试 8：`['文案改写', '文案改写'] != ['正文与镜头映射']`，以及 unknown 时 `['文案改写'] != ['正文与镜头映射']`；
  - 测试 9：`'reviews须逐一覆盖每份文案。' is not None`；
  - 分析阶段：`[] != [21]`（旧版对 21 个镜头取证）；
  - 旧版路径：`0 != 1 : _review_edit`；
  - 测试 2、3、4 依赖的新函数在旧版不存在（`TypeError`）。
- **IPC**：把 `narrated-batch-ipc.cjs` 临时换回 cc7ecda 版本跑新自检，失败于第一次带开关的保存（`actual: false, expected: true`）；换回后用 `cmp` 确认逐字节一致。
- **界面**：cc7ecda 上自检报 `Cannot find module './ad-law-terms.ts'`。

### 逐项变异（一次一处，跑完逐字节还原）

- Python（`ce3-e2e/mutate.py`，在引擎副本上改；结果 `ce3-e2e/mutations.log`）：26/26 被测出。
  - 新路径：去掉默认分流、新路径里取证、同一镜头用两次、先按时间后按素材排序、只用第一个素材、不看容量、用规范化后的文字代替确认原文、去掉 45% 进度、不分散富余镜头、素材不足时只跳过不提示。
  - 设置和重试：缺省改为严格、接受非布尔值、重试不看 `_run_id`、重试不看 unknown、画面类错误码不可重试。
  - 变体：调用 `_plan`、去掉长度检查、去掉相似度检查、复用确认稿镜头。
  - 准备文案和分析：默认仍复核草稿、严格不再复核草稿、默认仍取证代表镜头。
  - 其他：确认稿因历史重复被拒、配音后时间线因历史重复被拒、follow_script 仍做 brief 复核、旧版路径仍走付费审核。
- IPC 与界面（`ce3-e2e/mutate-js.cjs`，结果 `ce3-e2e/mutations-js.log`）：10/10 被测出：
  - 接受非布尔值、白名单漏掉键、`review_mode` 不回传；
  - 漏掉承诺用语、提示改写句子、命中词禁用确认按钮；
  - 确认后开关不锁定、成片处不提示、确认处不提示、长词不覆盖短词。

### 数据副本端到端（`ce3-e2e/replay.py`，输出 `ce3-e2e/replay.log`）

- 数据：把 `live-db-copy` 再复制到 `ce3-e2e/run-*/` 后运行。脚本从不打开实时数据库，只在前后各读一次它的大小和修改时间，两次相同（`57970688`）。
- 提供方全部换成计数桩：云端模型、视觉、素材分析、配音、渲染器，以及 `_cloud`、`_ground_shots`、各审核、`_plan`、`_analysis`、`narrated_brief.review`、`_run_auto_mix_v2`。渲染入口的桩先校验确认稿，再在副本里调用真实 `_create_run` 写入方案行，然后停止，不发 TTS。
- 批次 `narrated_batch_5ee76cefbba442dbaa073ffe42af1aa3`：回放前为 `completed_with_errors`，作业 `skipped / narrated_edit_rejected`，`production_retry_available=true`。走 `continue_narrated_batch` 加 `run_creative_task`：
  - 提供方和审核调用：`{}`（0 次）；
  - 进度：`正在按文案顺序安排镜头 45` → `已按文案顺序安排镜头 60`；
  - 到达渲染入口：是（`auto_mix_run_d06db79d…`）。原文与确认稿逐字节一致，配音稿（忽略空白）一致；`review_mode=follow_script`；
  - 镜头分配：素材池 48 个镜头、223.5 秒、5 个素材。副本里没有配音样本，预算按回退值 325 ms/字，比 App 冻结的 245.8 ms/字更保守。共 11 段：
    - 镜头按顺序、不重复，5 个素材都用到；
    - 每段容量都够，例如 P02"我们已经办了4期了……"需 10.2 秒、配 15.0 秒；
    - P06 从素材 2 接到素材 3；
  - 按 App 冻结的预算离线重排：11 段，19 个镜头。

### 未验证

- 没有启动真实 Electron 界面，开关、提示和标记只有源码断言与 `renderToStaticMarkup` 渲染检查。
- 没有真实 TTS、ASR、渲染，也没有真实云端改写。变体的提示词效果（是否真保留数字）只能靠真实模型验收，测试里的模型是桩。
- 回放没有走完配音和渲染，停在渲染入口。
- 实时数据目录没有写入；开发机上的这个批次需要用户在新版本里点"继续未完成作品"才会重跑。

### AI 变体的范围说明

- 按用户追加要求（"AI改写的也不用核对"），变体只做格式校验，不做事实核对。保留数字、承诺等只写在提示词里，程序不比对，模型仍可能改动事实；广告法提示会在成片的口播旁列出绝对化用语，供用户自查。
- 旧版单稿确认路径（不带 `selections`）的续作仍调用 `_plan`。当前界面不走这条路径，本卡没有改。
