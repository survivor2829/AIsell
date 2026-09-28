# CE2 结果：声音批准不再被旧版本抹掉，失效的批准可以免费恢复

分支 `claude/voice-approval-recovery`（基于 `main` 3274036，已含 CE1），未推送。提交：

- `6c83c36` 内容引擎：下线只停用、登记本机已有试听、`cache_only` 试听、付费前校验声音；
- `55bf9f6` 主进程：`cacheOnly` 经 preload、IPC、sidecar 透传；两个新错误码；`task_terminal` 的 `raw_code`；
- `052b63e` 界面：批次页恢复卡、批准后重新拉取声音、CE1 第 3 轮遗留 4～6；
- 本文档、卡片和 `PROJECT_STATUS.md` 的提交。

## 改了什么

1. **下线只停用**（`creative_domain.py` `_sync_configured_voice_persona_rows`）
   - 下线循环只执行 `SET active = 0, updated_at = ?`，不再清空 `approved_at`，也不删试听行和设计行。注释写明：保护依赖 `active = 1` 过滤和上架时的配置比对，需要强制重审时改 catalogVersion。
   - **有意翻转的断言，审查请明确确认**：
     - `test_removed_configured_persona_is_retired_without_touching_manual_rows`：下线后 `approved_at`、试听行从"为空"改为"仍在"，并新增断言 `_approved_auto_mix_voice_persona` 返回 None；
     - `test_v12_configured_persona_is_backfilled_and_retired_when_removed`：同一规则的迁移用例，下线后批准仍在但不可用。
   - `database.py` migration 013 的注释仍写着"下线时撤销活动状态和批准"。它不在本卡允许改动的文件里，没有改；实际效果（下线即不可用）不变。
2. **登记本机已有试听**（新增 `_register_saved_voice_previews`，在启动同步的同一事务末尾调用）
   - 条件：active=1、configured、`provider_voice_id` 非空、`voice_prompt` 为空、现有行的 cache key 不是当前 key、现有行不是 submitted/outcome_unknown（upsert 的 `WHERE` 再守一次）；`voice-previews/{当前 key}.wav` 解析后仍在数据目录内、0 < 大小 ≤ 8MB、通过 `_wav_duration_ms`。
   - 动作：upsert 一条 completed 行，路径格式与 `preview()` 相同，digest 为文件 sha256。只登记试听，不写 `approved_at`。单个文件读不了就跳过。
3. **只播放已保存试听**
   - `preview_auto_mix_voice_persona(..., cache_only=False)`：非布尔值报 `invalid_params`；`cache_only` 为真且没命中缓存时，在提供方检查、写行、合成之前抛出 `auto_mix_voice_preview_not_cached`。
   - protocol → service → sidecar → preload → IPC 逐层透传。preload 原样转发，IPC 拒绝非布尔值（不把 `"true"` 当成 false 去付费合成），可信点击和"本会话已试听"门槛不变，只有返回了音频的试听才打开批准门槛。
   - PUBLIC_ERRORS 新增 `auto_mix_voice_preview_not_cached`："本机没有可直接播放的已保存试听；重新生成试听会调用一次云端配音并计费。"
4. **付费前先校验声音**（`narrated_batch.py` 新增 `_require_approved_voice`）
   - `start()` 中 scripts、recommend 以外的动作（含改写后的 confirmed、samples、continue），以及 `resolve_planning_outcome()` 走 confirmed 的情况，在建任务、改 `_planning_inflight`、写审计之前检查本批声音。未批准就报 `auto_mix_voice_persona_approval_required`。
   - `save()` 的校验没改。
5. **批次页恢复卡**（新增 `batch-voice-recovery.ts` 纯逻辑、`BatchVoiceRecovery.tsx`）
   - 本批声音不在已批准列表时，在状态区显示，与规划恢复卡并列。状态区原本在可视流程的"成片"步骤不显示（0a89、c84e 就是这种），现在卡片显示时状态区也显示，所以任何步骤都能看到。
   - 文案："本批使用的「X」批准已失效（常见原因：这台电脑运行过不含该声音的旧版本）。"按情况给按钮：
     - 有已保存试听：「播放已保存试听（不计费）」，带 `data-xiaoxi-auto-mix-voice-preview`，传 `cacheOnly: true`。返回音频后才出现「批准使用「X」」，带 `data-xiaoxi-auto-mix-voice-approve`；
     - 没有缓存，或返回 not_cached：「重新生成试听（调用一次云端配音，计费）」；
     - 试听状态 submitted/outcome_unknown：只提示，不给按钮；
     - 声音不在目录：提示用「新建视频」选其他已批准的声音。
   - 批准后页面重新拉取声音列表，卡片消失，并提示"已批准「X」，这个批次可以正常保存和继续制作了。"
   - 卡片显示期间，「继续未完成作品」「满意，继续整批」「确认风险，重试未完成规划」「确认风险，仅重试未完成配音」禁用，提示"本批使用的声音需要先恢复批准，暂不能继续制作或重试规划；请先在上方处理声音。"
   - `BatchSoundSettings` 的下拉框把当前不可选的声音显示为禁用的「X（需重新批准）」（不在目录时为「id（已不在声音目录）」）。资源面板的试听按钮按 previewStatus 显示「试听（不计费）」或「试听（计费一次）」，前者用 `cacheOnly` 试听，返回 not_cached 就改标「计费一次」。

### 并入：CE1 第 3 轮遗留

1. **批准后要刷新**：页面新增 `applyVoices`/`refreshVoices`。恢复卡批准后、以及「声音与配乐」资源面板里批准后（`BatchSoundSettings` 包一层 `approveAutoMixVoicePersona`，成功后调页面的 `onVoiceApproved`），都会重新拉取声音列表，`approvedVoiceIds`、恢复卡、`voiceWarning` 用新列表，旧的"需要重新试听批准"提示同时清掉。`BatchSoundSettings` 收到新列表后也重新读取。挂载时读取失败（`ok: false`）不再当成"一个都没批准"。
2. `provider_usage_write_failed` 加进 PUBLIC_ERRORS："本机无法写入云端调用记录（例如磁盘已满），已停止继续请求；请先检查磁盘可用空间，再重试。"用户点击的试听、生成失败时页面显示这条，并照旧弹一次通知（`provider_` 前缀）。
3. `task_terminal` 退回 `unknown_error` 时记一个经过 `rawDiagnosticCode` 校验的 `raw_code`，与 IPC 失败一致。原有断言"只含 error_code、task_id 两个字段"相应改为精确比对三个字段。
4. `DETERMINISTIC_DRAFT_ERRORS` 的 16 个码逐个测试：每个码既断言 `isDeterministicDraftError` 为真，又走一遍恢复流程断言停止重放。逐个删掉 16 个码，都有测试失败（见下文变异）。
5. `recoverPlanning()`、`recoverVoice()` 像 `start()` 一样：`draftQueue.busy()` 时直接返回，然后 `cancelPending()`。不能先 `await flush()`：这两个按钮的可信点击令牌在调用 IPC 时才消费、1 秒过期，等保存可能让令牌失效。所以另外在有未保存修改时禁用这两个按钮，并提示"有修改正在保存，保存完成后再重试。"这样旧编辑总是在重试之前落地，不会在重试之后写进去。
6. 从素材仓库带素材进入时，如果缓存编辑因临时错误被保留（restore 为 kept），带入的素材不再立即自动保存（那会把保留的编辑悄悄挤进备份槽）；页面提示"所选素材已带入，但还没有保存成新视频；开始修改后才会保存。"，与原有的"……如果现在开始新的编辑，将以新的编辑为准。"一起显示。用户第一次修改时才替换。

## 与卡片的出入（请审查确认）

- **多加的后端校验**：`service.continue_narrated_batch` 对暂停中的已确认批次直接恢复原任务，不经过 `start()`。这也是"继续未完成作品"的付费制作，所以同样先校验声音（`test_paused_confirmed_production_is_not_resumed_with_a_revoked_voice`）。
- **sidecar 能力检查**：如果新的主进程配上不认识 `cache_only` 的旧引擎，旧引擎会忽略这个参数、在"不计费"按钮下付费合成。所以引擎在就绪信息里声明 `voice_preview_cache_only`，sidecar 只向声明了的引擎发送 `cache_only`，否则报 `CONTENT_ENGINE_CAPABILITY_UNAVAILABLE`。
- **not_cached 不弹桌面通知**：它加进了 `PAGE_ONLY_ERROR_CODES`，页面会切换成计费按钮，不需要桌面提醒。
- 卡片显示时，除卡上列的两个按钮外，「满意，继续整批」和「确认风险，仅重试未完成配音」也禁用，原因相同。
- 改动了卡片清单外的几个文件：`content-engine-desktop-integration.self_check.cjs`（preload 的自检）、`batch-draft-queue.ts` 及其自检（遗留 4～6 所在）、`scripts/run-self-checks.cjs`（登记新自检）。

## 验证（`C:/Users/Scott/xiaoxi-review/ce2/desktop`，%TEMP% 以外）

内容引擎按 CI 的 service-and-content 任务运行（`python -m unittest discover -s tests -p ...`，在 `desktop/sidecars/content-engine`，Python 3.12.14），另加本卡改动的声音测试文件：

| 命令 | 结果 |
|---|---|
| `-p 'test_narrated*.py'` | `Ran 111 tests in 14.835s` `OK` |
| `-p 'test_production_summary.py'` | `Ran 4 tests in 0.033s` `OK` |
| `-p 'test_provider_usage.py'` | `Ran 10 tests in 0.585s` `OK` |
| `-p 'test_auto_mix_voice_resources.py'`（CI 不跑） | `Ran 24 tests in 1.205s` `OK` |
| 全量 `discover -s sidecars/content-engine/tests`（README 的方式，CI 不跑） | `Ran 553 tests`，`FAILED (failures=13, errors=4)`。17 个失败都在 `test_creative_workbench`、`test_packaging_renderer`（本机 FFmpeg 没有 H.264 Media Foundation 编码器、封面等旧断言）。把源码换回 base 跑同样的全量：同样这 17 个失败，另加本卡 9 个新测试失败。本卡没有引入新的失败 |
| `node src/main/content-engine-ipc.self_check.cjs` | `content-engine IPC self-check passed` |
| `node src/main/content-engine-sidecar.self_check.cjs` | `content-engine sidecar self-check passed` |
| `node src/main/content-engine-voice-preview-errors.self_check.cjs` | `voice preview public error self-check passed` |
| `node src/main/content-engine-desktop-integration.self_check.cjs` | `content-engine desktop integration self-check passed` |
| `node src/main/narrated-batch-ipc.self_check.cjs` | `narrated batch IPC self-check passed` |
| `node src/renderer/batch-draft-queue.self_check.cjs` | `Batch draft restore and save queue self-check passed` |
| `node src/renderer/batch-voice-recovery.self_check.cjs`（新） | `Batch voice recovery card self-check passed` |
| `node src/renderer/product-one-click.self_check.cjs` | `product one-click V2 self-check passed` |
| `node scripts/run-self-checks.self_check.cjs` | `Self-check runner checks passed: grouping, exit status, passed lines and output forwarding.` |
| `npm.cmd run check:self` | exit 0，用时 4 分 3 秒，串行 100 项，最后一行 `all source self-checks passed`；新自检在其中（`> src/renderer/batch-voice-recovery.self_check.cjs` / `Batch voice recovery card self-check passed`） |
| `npm.cmd run build:test` | exit 0，`✓ built in 1.39s`、`test renderer build completed`；`dist-development` 中有「播放已保存试听（不计费）」「重新生成试听（调用一次云端配音，计费）」「（需重新批准）」「试听（计费一次）」等新文案 |

- **tsc**：本环境缺 `@types/react`，全仓 `tsc -p` 本来就有大量报错。按"文件 + 错误码 + 信息"与 base 对比：全仓 6150 → 6169 条，全部在改动的界面文件里，都是同类环境报错（TS7026 JSX、TS7016 react 类型、TS7006 隐式 any）；`batch-voice-recovery.ts`、`batch-draft-queue.ts` 为 0。唯一一条 TS2322 是给自定义组件传 `key`（缺 React 类型时不认识 `key`），base 里已有 6 条同样的报错。

## 撤掉修复后测试会失败

**整体换回 base**（`ce2-diag/fob.cjs`：只把 11 个源文件换成 3274036 的版本、删掉 2 个新文件，测试保持本分支，跑完按字节还原）：

- 声音测试 24 个中 9 个失败或报错：`test_unchanged_configured_voice_keeps_its_approval_across_a_catalog_absence`、`test_saved_preview_is_recorded_again_after_an_old_build_cleared_it`、`test_saved_preview_recording_skips_unknown_invalid_oversized_and_designed_voices`、`test_cache_only_preview_without_a_saved_preview_never_reaches_the_provider`（含 3 个子测试）、两条翻转的断言；
- `test_changed_configuration_on_return_still_revokes_approval_and_preview`（回归保护）在 base 上**通过**，符合卡片要求；
- narrated 4 个新测试中 3 个失败（continue、samples、暂停中继续、confirmed 规划重试）；`test_unconfirmed_planning_retry_does_not_need_the_voice` 是守护"不该多拦"的，在 base 上通过；
- 主进程与界面自检：ipc 失败于 `task diagnostics must contain only the fields …`（raw_code），sidecar 失败于能力检查，voice-preview 失败于 `the voice preview scan must see auto_mix_voice_preview_not_cached`，desktop-integration 失败于 cacheOnly 透传，draft-queue 失败于 `carried is not a function`，恢复卡自检找不到模块。

**逐项变异**（`ce2-diag/mutate.cjs`，一次撤回一处，跑对应测试，按字节还原；结果 `ce2-diag/logs/mutations.log`）：65 个变异，64 个被测出。未测出的 1 个是有意冗余：只删 Python 层的 submitted/outcome_unknown 判断时，upsert 的 `WHERE` 仍然挡住；两处一起删则被测出。

| 撤回内容 | 失败的测试或断言 |
|---|---|
| 下线又清空批准 / 又删试听行 | `test_v12_…_retired_when_removed` / `test_removed_configured_persona_…` |
| 不登记 / 登记时顺手批准 / digest 用错 | `test_saved_preview_is_recorded_again_after_an_old_build_cleared_it` |
| 去掉 WAV 校验 / 大小校验 / 设计型排除 / 结果不明两处保护 | `test_saved_preview_recording_skips_unknown_invalid_oversized_and_designed_voices` |
| `cache_only` 不生效 / 放到火山配置检查之后 / 非布尔值强转 / protocol 不透传 | `test_cache_only_preview_without_a_saved_preview_never_reaches_the_provider` |
| `start()` 不校验 / 连 scripts 也校验 | `test_revoked_voice_stops_paid_production_before_a_task_is_created` |
| 规划重试不校验 / 在写审计之后才校验 / 未确认的也校验 | `test_confirmed_planning_retry_needs_the_voice_approved_first` / 同上 / `test_unconfirmed_planning_retry_does_not_need_the_voice` |
| 暂停中继续不校验 | `test_paused_confirmed_production_is_not_resumed_with_a_revoked_voice` |
| IPC 不传 cacheOnly / 强转 / 跳过可信点击 / 试听前就打开批准门槛 | ipc 自检：`[monkeyId, { cacheOnly: true }]` 比对、`cacheOnly "true" must be refused, not coerced`、`a free replay still needs the user's own click`、`a replay that found nothing does not open the gate` |
| not_cached 未映射 / 仍弹通知；`provider_usage_write_failed` 未映射 | ipc 自检对应断言 |
| task_terminal 不记 raw_code / 不校验 raw_code | `task diagnostics must contain only the fields …` / `task_terminal for sk_ABCD…` |
| sidecar 不查能力 / 不发 cache_only / 强转 | sidecar 自检 |
| preload 丢掉或强转 cacheOnly | desktop-integration 自检 `cacheOnly must reach the main process unchanged` |
| 结果不明也给按钮 / 下架当计费 / 未试听就给批准 / 忽略 not_cached / 已批准仍显示 / 不计费按钮不传 cacheOnly | 恢复卡自检 |
| 恢复卡批准后不重新拉取 / 资源面板批准不通知页面 | `the card's approval re-reads the list` / `BatchSoundSettings` 源码断言 |
| 继续按钮不受卡片约束 / 卡片不在状态区 / 资源面板"不计费"仍合成 | 恢复卡自检对应断言 |
| 16 个确定性草稿错误码逐个删掉 | 每个都失败：`<code> is rejected the same way on every replay` |
| 重试不处理保存队列 / 有未保存修改也能点 / 带入素材总是立即保存 / 页面没接这条规则 | draft-queue 自检对应断言 |

draft-queue 自检和恢复卡自检用 harness 按页面接线建模，并各有一个"旧接线"对照，证明模型能复现问题：旧接线下批准后载入另一个猴哥批次仍提示需要重新批准；旧接线下重试后旧编辑才落地；旧接线下带入素材会把保留的编辑直接挤进备份。页面代码用源码断言固定。

## 端到端（数据副本，脚本 `ce2-diag/e2e/`）

- 数据：从 `backup-pre-1.1.54/userdata/content-engine` 复制 `content-engine.sqlite3`、`auto-mix-cache/voice-previews/` 的 3 个 WAV、`provider-usage.jsonl` 到 `ce2-diag/e2e/data*`。**没有复制任何密钥文件**，环境变量只保留系统项，没有碰实时数据目录。
- 链路：本分支的 `worker.py`（Python 源码）← 真实 `content-engine-sidecar.cjs` ← 真实 `content-engine-ipc.cjs`（含 `narrated-batch-ipc.cjs`），可信点击按自检的方式模拟。

| 步骤 | 本分支 | base（同一脚本，引擎和主进程换回 3274036） |
|---|---|---|
| 启动后猴哥的试听行 | completed，digest `33a5d934d02b69d9b673a0d338fd304d189a021286b5cf9acb60bd1a9034e1d0`（= 文件 sha256），`approved_at` 仍为 null，列表显示 pending + completed | 无试听行，previewStatus not_ready |
| 批准前保存四个批次 | 都返回 `auto_mix_voice_persona_approval_required` | 同左 |
| 批准前"继续"e506、"重试规划"1b08 | 都返回 `auto_mix_voice_persona_approval_required`，任务数 277 → 277 | **都成功**，新建了 2 个任务（副本里没有密钥，任务停在网关不可用，没有真实请求） |
| 未试听就批准 | `auto_mix_voice_preview_required` | 同左 |
| 播放已保存试听（cacheOnly） | 成功，`cacheHit: true`，返回音频的 sha256 = 文件 sha256 | `invalid_params`（旧 IPC 不认 cacheOnly），只能走付费试听 |
| 批准 | 成功 | 失败（没有试听资格） |
| 批准后保存四个批次 | 全部成功，状态仍为 completed / completed / completed_with_errors / outcome_unknown | 仍被拒 |
| `provider-usage.jsonl` | sha256 `3ccb7a0a…dbad6`、2562 行，前后不变 | 前后不变 |
| 其他 | 引擎只收到 1 次试听请求，参数 `{cacheOnly: true}`；四个批次的状态、确认稿、候选、素材数逐项不变；0 条桌面通知 | — |

另用 `ce2-diag/e2e/inprocess.py` 在第三份副本上进程内跑一遍：所有提供方入口都换成计数桩（任何调用都会记录并抛错）。结果：启动后试听行 completed、digest 同上；`cache_only` 试听 `cacheHit: true`；批准成功；四个批次 `save` 后状态不变；**提供方调用 0 次**，`provider-usage.jsonl` 不变。

## 没做或未验证

- **真实 Electron 界面没有复验**：开发版和已装测试包共用实时数据目录，本卡不碰实时数据。请用户按卡片流程验收：
  1. 运行包含 CE1 和 CE2 的版本；
  2. 打开任意一个猴哥批次，状态区应出现恢复卡；
  3. 点「播放已保存试听（不计费）」，听完点「批准使用「猴哥 2.0」」，卡片消失；
  4. 四个批次都能正常保存；0a89、c84e 可直接查看和导出；e506 的「继续未完成作品」、1b08 的「确认风险，重试未完成规划」恢复可用（是否继续由用户逐项决定，继续属于正常付费制作）；
  5. 复验时核对 `provider-usage.jsonl`，恢复过程中不应新增记录。
- 开发机上已装的旧测试包（1.1.28）以及已发布的 1.1.54 及更早版本，启动时仍会清空它们不认识的声音的批准。本版之后，每次都可以按上面的流程免费恢复（两次点击）；零点击需要批准台账，本卡按用户决定不做。
- 发布顺序：不得早于 CE1（CE1 已在 `main`）。
- 需要用户确认的清理候选：`C:/Users/Scott/xiaoxi-review/ce2-diag/`（约 241MB，含数据库副本、试听文件和调用记录，都是用户数据副本；审查复跑脚本时还要用）以及设计阶段留下的 `ce-design/ce2-judge/`、`ce-design/ce2-ux/` 副本。确认用不上后再删。
- narrated 的 4 个新测试里，`test_unconfirmed_planning_retry_does_not_need_the_voice` 守护"不该多拦"，在 base 上本来就通过。

## 第 2 轮（审查第 1 轮发现的修复）

提交（未推送）：

- `3cbfec9` 内容引擎：「恢复任务」和"仅重试未完成配音"在声音批准前拒绝（correctness-R1-1、safety-F1、tests-C1、tests-T1）；
- `4b1bbda` 内容引擎：已确认文案的批次保存时保留确认数量（safety-F3）；
- `1af0e51` 内容引擎：未做响度处理的火山原始音频不再登记成已保存试听（safety-F2）；
- `c73a5a8` migration 013 注释（safety-F4）；
- `83ad8bc` 界面：「恢复任务」随恢复卡禁用；「声音与配乐」的试听按钮标出计费（correctness-R1-4）；R1-2、R1-3 的测试；
- 本文档和 `PROJECT_STATUS.md` 的提交。

### 改了什么

1. **「恢复任务」不再绕过声音校验**（R1-1 / F1 / C1）
   - `service.resume_creative_task`：narrated 任务在两条重排分支（暂停中、网关不可用后失败）之前调用新的 `NarratedBatchDomain.require_voice_to_resume`，在写任何东西之前拒绝。规则与 `start()` 一致：写文案（scripts）、推荐数量（recommend）不需要声音；已确认文案的批次、旧流程的 samples/continue 需要。批次读不到时不在这里拦，由 worker 照旧报错。
   - `resolve_voice_outcome`（仅重试未完成配音）在作废未完成产物、写审计之前校验声音。否则它先改了批次，随后的 resume 再被拒，批次会停在半重置状态（引擎是自动提交，没有回滚）。
   - 页面：「恢复任务」在恢复卡显示、且暂停的是制作（已确认文案或旧流程批次）时禁用，按钮上方显示同一句原因。页面拿不到暂停任务的 action，所以旧流程批次暂停中的"推荐数量"任务也会被页面挡住（引擎允许）；这类批次先处理声音或取消任务即可。
2. **tests-T1**：新增 `test_revoked_voice_stops_continuing_a_confirmed_script_batch`（e506 的「继续未完成作品」，start() 里 action 变成 confirmed）。审查的 E11 变异（`{"scripts", "recommend", "confirmed"}`）现在被测出。
3. **已确认批次的数量**（F3）：页面脚本流程的草稿固定传 `target_count: 1`（确认前的占位，确认时由所选方向的数量相加得出）。`save()` 现在在确认保留的情况下保留原数量；文案改动清掉确认时照旧取请求里的值。改在引擎而不是页面，因为旧版本缓存的草稿重放时也带着 1。
4. **原始音频不当成已保存试听**（F2）
   - 火山试听由 `normalize_voice_preview` 用 ffmpeg 原地重写，ffmpeg 的 WAV 封装会写入 `LIST/INFO/ISFT "Lavf…"`（开发机备份里的两个火山试听文件都有，猴哥那个是 `Lavf62.12.101`）；提供方原始音频由 Python `wave` 写出，没有这个块。
   - 登记时，火山声音的文件没有这个标记，就按 preview() 当时留下的样子记为 `failed / auto_mix_voice_preview_normalization_pending`（digest 为文件 sha256）。下次（非 cacheOnly）试听走已有的复用分支，只在本机补做响度处理，不调用提供方；cacheOnly 仍报 not_cached，批准仍要求试听。
   - 百炼音频不重写，照旧登记为 completed。被截断的百炼流式占位文件无法识别（占位头本来就不写长度）；百炼是下载完整并校验后一次写入，所以只可能是外部损坏，按"接受"写在注释里。
   - 取舍：这种行在恢复卡上显示为计费的「重新生成试听」，实际点击只做本机响度处理、不计费。这是它被旧版本删掉之前的原样，标签偏保守。
5. **migration 013 注释**（F4）改为"下线只停用，批准留在停用行上，被 active=1 过滤挡住；配置变了回来时照旧撤销"。`database.py` 不在卡片允许的文件里，这次按编排方要求改，只改注释。
6. **「声音与配乐」的试听按钮**（R1-4）：按钮文字改为「试听声音（不计费）」或「试听声音（计费一次）」；已完成的试听用 cacheOnly 重放，返回 not_cached 后改标计费；付费试听成功后更新列表里的试听状态。原来的 `audition("voice", …)` 分支删掉，音乐试听不变。
7. **测试补强**
   - R1-2：恢复卡拆出无状态的 `VoiceRecoveryCard`，自检渲染"已试听"状态，断言「批准使用」只带 `data-xiaoxi-auto-mix-voice-approve`、试听按钮只带 `data-xiaoxi-auto-mix-voice-preview`。
   - R1-3：资源面板和「声音与配乐」共用 `previewCharge` / `previewAfterFailure`（在 `batch-voice-recovery.ts`），自检测两者的行为，并用源码断言固定两处调用（包括面板在 not_cached 后改标的那一行）。本仓库没有 DOM 测试工具，面板本身只能用源码断言。

### 未完成：tests-T2（需要编排方或用户处理）

CI 仍不跑 `test_auto_mix_voice_resources.py`。本轮尝试在 `.github/workflows/ci.yml` 的 service-and-content 任务末尾加一步，被本环境的权限检查拒绝（修改共享配置），没有绕过。需要加的内容：

```yaml
      - name: Voice approvals and saved previews
        working-directory: desktop/sidecars/content-engine
        run: python -m unittest discover -s tests -p 'test_auto_mix_voice_resources.py'
```

本机去掉 PATH 里的 ffmpeg 后，这个文件 `Ran 27 tests in 0.909s` `OK (skipped=1)`（跳过的是需要真实 ffmpeg 的那一条），不需要额外依赖。

### 撤掉修复后测试会失败

- **换回 base 3274036 的引擎源码**（`ce2-diag/r2/onbase_py.py`：`creative_domain.py`、`narrated_batch.py`、`service.py`、`protocol.py` 换成 base，测试保持本分支，跑完按字节还原）：本轮 8 个新引擎测试全部失败，`Ran 8 tests in 0.506s` `FAILED (failures=7, errors=3)`（含子测试）。其中 `test_resuming_copy_or_count_planning_does_not_need_the_voice` 在 base 上失败于旧流程 samples 被恢复；它的 scripts/recommend 部分是"不该多拦"的守护。
- **引擎逐项变异**（`ce2-diag/r2/mutate_py.py`，结果 `mutations-engine.log`）：13 个，全部测出。

| 撤回内容 | 测出的测试 |
|---|---|
| resume 不校验 / 只看 action（已确认批次的旧文案任务放行）/ 只看是否确认（旧流程 samples 放行）/ 连写文案、推荐也拦 | `test_resuming_stopped_production_…`、`test_resuming_copy_or_count_planning_…` |
| 仅重试配音在作废产物之后才校验 | `test_voice_retry_needs_the_batch_voice_approved_first` |
| start() 豁免 confirmed（审查 E11） | `test_revoked_voice_stops_continuing_a_confirmed_script_batch` |
| 原始火山音频登记为 completed / 没有 LIST 就算处理过 / 任意 INFO 标签都算 / 所有文件都不算 / 百炼也要求标记 | `test_raw_volcengine_audio_…`、`test_saved_preview_is_recorded_again_…`、`test_only_ffmpeg_s_own_tag_…`、`test_the_ffmpeg_mark_…` |
| 保存时不保留确认数量 / 确认清掉后仍保留 | `test_saving_a_confirmed_script_batch_keeps_its_confirmed_count` |

- **界面逐项变异**（`ce2-diag/r2/mutate_ui.cjs`，结果 `mutations-ui.log`）：13 个，全部测出。包括审查做过的两处：批准按钮换成试听门槛（`批准使用 carries the approval gate`）、面板的 not_cached 回退换成 `void 0`（`and after not_cached it relabels the voice instead of offering 不计费 again`）。其余是「声音与配乐」不传 cacheOnly、不标计费、不回退，「恢复任务」不禁用，`resumeNeedsVoice` 恒假或连写文案也拦，以及 `previewCharge`、`previewAfterFailure` 的几种撤回。
- 审查的 `probe_resume_bypass.py` 在本轮代码上：`resume_creative_task` 返回 `auto_mix_voice_persona_approval_required`，任务仍为 paused，没有入队，没有新任务（`ce2-diag/r2/probe-resume-r2.txt`）。它的"花费"模式现在在 resume 那一步就被拒，后面的 worker 不再运行；该脚本没有接住这个异常，所以显示为 error。

### 验证（`C:/Users/Scott/xiaoxi-review/ce2/desktop`，%TEMP% 以外，Python 3.12.14）

| 命令 | 结果 |
|---|---|
| `python -m unittest discover -s tests -p 'test_narrated*.py'` | `Ran 116 tests in 14.916s` `OK` |
| `-p 'test_production_summary.py'` | `Ran 4 tests in 0.032s` `OK` |
| `-p 'test_provider_usage.py'` | `Ran 10 tests in 0.579s` `OK` |
| `-p 'test_auto_mix_voice_resources.py'`（CI 不跑，见上） | `Ran 27 tests in 1.477s` `OK`；PATH 去掉 ffmpeg：`Ran 27 tests in 0.909s` `OK (skipped=1)` |
| 全量 `discover -s sidecars/content-engine/tests` | `Ran 561 tests in 48.243s` `FAILED (failures=13, errors=4)`；失败的 17 个与第 1 轮逐个相同（都在 `test_creative_workbench`、`test_packaging_renderer`，本机 FFmpeg 和封面旧断言），没有新增失败 |
| `node src/renderer/batch-voice-recovery.self_check.cjs` | `Batch voice recovery card self-check passed` |
| `node src/renderer/batch-draft-queue.self_check.cjs` | `Batch draft restore and save queue self-check passed` |
| `node src/renderer/product-one-click.self_check.cjs` | `product one-click V2 self-check passed` |
| `npm.cmd run check:self` | exit 0，用时 4 分 3 秒，100 项，最后一行 `all source self-checks passed` |
| `npm.cmd run build:test` | exit 0，`✓ built in 1.39s`、`test renderer build completed`；产物里有「试听声音（」「计费一次」 |
| tsc（缺 `@types/react` 的环境，与第 1 轮比） | 6169 → 6175；多出的 6 条都是同类环境报错（`BatchCreativePage.tsx` 2 条 TS7026 JSX，`BatchSoundSettings.tsx` 4 条 TS7006 隐式 any，来自无类型的 `useState` 回调参数），`batch-voice-recovery.ts` 为 0 |

主进程文件本轮没有改动，它们的自检在 `check:self` 中通过。

### 端到端（数据副本，`ce2-diag/r2/e2e/e2e_r2.cjs`）

审查第 1 轮的 `e2e_copy.cjs` 原样复制，只把数据目录改到 `ce2-diag/r2/e2e/data-head`、代码树改成本工作树：本分支 `worker.py` ← 真实 `content-engine-sidecar.cjs` ← 真实 `content-engine-ipc.cjs`。数据是 `backup-pre-1.1.54` 的数据库、3 个试听 WAV 和 `provider-usage.jsonl` 的副本，没有密钥，环境变量不含 `XIAOXI_*`，没有碰实时数据目录。保存用的是页面 `draft()` 实际发送的草稿（脚本流程 `target_count: 1`）。

- 启动后猴哥试听行 completed，digest `33a5d934d02b69d9b673a0d338fd304d189a021286b5cf9acb60bd1a9034e1d0`，`approved_at` 为空（猴哥的文件带 ffmpeg 标记，按 completed 登记）。
- 批准前：四个批次保存、三个"继续"、1b08 的规划重试都被拒（1b08 的"继续"报 `narrated_planning_outcome_unknown`，与第 1 轮相同）；未试听就批准、`cacheOnly: "true"`、非可信点击都被拒。
- 播放已保存试听：`cacheHit=true`，返回音频等于文件；随后批准成功；再批准一次（没有新试听）被拒。
- 批准后四个批次保存成功，状态 completed / completed / completed_with_errors / outcome_unknown。
- **四个批次的状态与保存前逐字段相同**（`finishedBatchesUnchanged: true`）。第 1 轮代码上同一脚本的 e506 差异是 `target_count 2 → 1`，本轮为空。
- 任务数 277 → 277；`provider-usage.jsonl` sha256 `3ccb7a0a…dbad6`、2562 行，前后不变；0 条桌面通知。`noProviderWorkPreflight` 为 false，与第 1 轮相同：那是 IPC 在"继续"前调用的 `beforeProviderWork` 桩（记录了 4 次空能力列表），没有真实请求。
- 备份里唯一暂停中的已确认制作（518c）没有设置声音，不适用这项校验，所以端到端没有覆盖「恢复任务」；这条由引擎测试和审查的探针覆盖。

### 卡片清单外的文件

- `database.py`：只改 migration 013 的注释（编排方要求）。
- `tests/test_narrated_production.py`：新增 `test_voice_retry_needs_the_batch_voice_approved_first`（重试配音的夹具在这个文件里；CI 的 `test_narrated*.py` 会跑它）。
- `.github/workflows/ci.yml`：未改（见"未完成"）。

### 仍未验证

- 真实 Electron 界面仍未复验，用户验收流程同上文。
- `ce2-diag/` 现约 885MB（本轮 `r2/` 约 118MB，含两份数据副本），清理候选同上文，待用户确认。
