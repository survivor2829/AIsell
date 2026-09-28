# CE2【中】声音批准不再被旧版本抹掉；失效的批准可以免费恢复，四个猴哥批次重新可用

分支：`claude/voice-approval-recovery`。已于 CE1 合入后从 `main` 拉出，因为两张卡都改 `content-engine-ipc.cjs` 和 `BatchCreativePage.tsx`。发布不得早于 CE1：否则猴哥一重新批准，本机旧草稿就能保存成功，把已完成的批次重置成空素材草稿。

## 背景（已确证：wf_2a3fbaa8-1a9，另在备份副本上核对过）

- 触发：9-21 批准猴哥 2.0（`volc-monkey-brother-2@1`）之后，开发机启动了一个目录里没有猴哥的旧测试包。这个测试包和开发版共用 `%APPDATA%/xiaoxi-active-touch-test`。旧包用它自己的下线分支（`creative_domain.py:641-668`，从 fc0d1ac 起就有）置 active=0、清空 approved_at、删除试听行。之后新版把猴哥重新上架，但按设计不恢复批准。
- 影响：四个批次都用猴哥，保存都报 `auto_mix_voice_persona_approval_required`：
  - 0a89、c84e：completed；
  - e506：completed_with_errors；
  - 1b08：文案已确认，规划 outcome_unknown。
- 为什么用户自己恢复不了：
  - 已确认的批次默认停在成片页（`BatchCreativePage.tsx:339`），「声音与配乐」只在确认步骤出现，找不到恢复入口；
  - 资源面板能重新试听，但试听行已被删，点了会走付费合成，界面上没有任何计费提示。
- 试听音频还在：`auto-mix-cache/voice-previews/ca64cfe2…297ac.wav`。
  - 文件名等于按当前配置算出的 cache key；
  - sha256 `33a5d934…1d0` 与 9-22 备份库里批准那次试听的 digest 一致；
  - 全仓没有删除这个目录下文件的代码。
- 下线分支的安全意图（依据：注释 :676-677、:758-761，migration 013 注释，d1c7efe 提交说明）有三条：
  1. 下线的声音立即不可列出、不可使用；
  2. 批准只代表用户听过这份私有配置；
  3. 配置变了，旧试听和旧批准都不能沿用。
- 第 1 条已由所有读取处的 `active = 1` 过滤保证（:790、:804、:4361、`narrated_batch.py:628`）；第 3 条由重新上架时的 `private_configuration_changed` 保证。"配置没变、只是暂时缺席也清空批准"是多余的副作用。

## 要做

1. **下线只停用**：下线循环只执行 `SET active = 0, updated_at = ?`，不再清空 approved_at，也不删试听行和设计行。加注释写明：保护依赖 active=1 过滤和上架时的配置比对；需要强制重审时改 catalogVersion。
2. **登记本机已有的试听**（放在启动同步末尾）：
   - 适用的声音：active=1、configured、provider_voice_id 非空、voice_prompt 为空、没有当前 cache key 的试听行、现有行不是 submitted/outcome_unknown；
   - 条件：data_dir 内的 `voice-previews/{当前key}.wav` 存在，0 < 大小 ≤ `MAX_VOICE_PREVIEW_BYTES`，并通过 `_wav_duration_ms` 校验；
   - 动作：upsert 一条 completed 行，路径格式与 preview() 相同，digest 取文件 sha256；
   - 只登记试听，绝不写 approved_at；单个文件出错就跳过，不影响启动。
3. **只播放缓存的试听**：
   - `preview_auto_mix_voice_persona(..., cache_only=False)`：cache_only 为真且没命中缓存时，在任何提供方检查、写行、合成之前抛出 `auto_mix_voice_preview_not_cached`；
   - protocol、service、sidecar、preload、IPC 逐层透传布尔值 `cacheOnly`；IPC 拒绝非布尔值，可信点击和"本会话已试听"门槛都不变；
   - PUBLIC_ERRORS 加一条中文提示，写明重新生成会计费。
4. **付费前先校验声音**：以下两处在创建任务前要求本批声音已批准，否则抛 approval_required，不建任务，也不动 `_planning_inflight`：
   - `start()` 中 scripts、recommend 以外的动作；
   - `resolve_planning_outcome()` 中将走 confirmed 的情况。
   - `save()` 的批准校验不改，它正挡着旧草稿覆盖已完成批次。
5. **批次页恢复卡**：本批声音不在已批准列表时，在状态区显示恢复卡，与规划恢复卡并列，任何步骤都可见。卡上写"本批使用的「X」批准已失效（常见原因：这台电脑运行过不含该声音的旧版本）"，按情况给按钮：
   - 有已保存试听：「播放已保存试听（不计费）」，带 `data-xiaoxi-auto-mix-voice-preview`，传 cacheOnly:true。播放成功后才出现「批准使用「X」」，带 `data-xiaoxi-auto-mix-voice-approve`。
   - 没有缓存，或返回 not_cached：「重新生成试听（调用一次云端配音，计费）」。
   - 试听状态是 submitted/outcome_unknown：只提示，不给按钮。
   - 声音已不在目录：提示用「新建视频」选其他已批准的声音。
   - 批准后重新拉取声音列表，卡片消失。卡片显示期间禁用「继续未完成作品」和「确认风险，重试未完成规划」，并说明原因。
   - `BatchSoundSettings` 的下拉框把当前未批准的声音显示为不可选的「X（需重新批准）」。资源面板的试听按钮按 previewStatus 标出「不计费」或「计费一次」。

## 允许改动

- 内容引擎：`creative_domain.py`、`narrated_batch.py`、`service.py`、`protocol.py`，以及 `tests/test_auto_mix_voice_resources.py`、`tests/test_narrated_batch.py`。
- 主进程：`src/main/content-engine-sidecar.cjs`、`content-engine-ipc.cjs`、`preload-api.cjs` 及其自检。
- 界面：`src/renderer/BatchCreativePage.tsx`、`BatchSoundSettings.tsx`、`AutoMixResourcePanel.tsx`；新增 `batch-voice-recovery.ts`、`BatchVoiceRecovery.tsx` 及自检。新自检登记进 `scripts/run-self-checks.cjs`，并打印 passed 行。
- 文档：`PROJECT_STATUS.md` 的声音批准一节，以及本卡的 result。

## 禁止

- 不自动批准任何声音；不从备份库、已完成批次或历史记录推断并恢复猴哥的批准。
- 不放宽 `save()` 校验、主进程的试听门槛和可信点击。
- 不做"文案确认后原地换声"，不做批准台账，不做数据目录分离（后者另开 CE3，高风险）。
- 不调用付费接口；不读写实时数据目录，只用备份副本验证。

## 验收

- 必测。除标了"回归保护"的一条外，每条都要证明在本分支基线（CE1 合入后的 main）上失败：
  - **相同配置重新上架**：批准保留，analyzer 调用次数不增加。下线期间：不在列表里，`_approved_auto_mix_voice_persona` 返回 None，preview/approve 报 not_found。需要翻转 `test_removed_configured_persona_is_retired_without_touching_manual_rows` 里关于批准的断言，审查必须明确确认这是有意的。
  - **回归保护**：用改过的 catalog_version、provider_voice_id 或 instruction 上架，批准和试听照旧被撤销；manual 行不受影响。
  - **模拟旧包清空**：用旧包的 SQL 清空 approved_at、删除试听行（保留文件），再重新同步。断言：
    - 试听行为 completed，digest 等于文件 sha256，approved_at 仍为空；
    - cache_only 试听命中缓存（cacheHit），analyzer 调用为 0；
    - 随后批准成功。
    - 负例：outcome_unknown 的行不被改动；坏 WAV、超过 8MB 的文件、设计型声音都不登记。
  - **cache_only 且没有缓存**：报 not_cached，不新增行，不产生调用；火山未配置时结果相同。
  - **narrated**：撤销批准后，`start('continue')` 和 `resolve_planning_outcome` 都报 approval_required，content_tasks 不增加；`start('scripts')` 不受影响。
  - **主进程自检**：cacheOnly 能透传，非布尔值被拒，仍需可信点击，只有 cacheOnly 试听成功后才能通过批准门槛；not_cached 的错误映射正确。
  - **恢复卡纯逻辑自检**：覆盖五种状态——不计费、计费、结果不明、已下架、已批准时不显示。
- 在 %TEMP% 以外的工作树运行内容引擎 pytest、`check:self`、`build:test`，分别报告结果。
- 修复后的用户流程（恢复本身不产生付费调用）：
  1. 运行包含 CE1 和 CE2 的版本；
  2. 打开任意一个猴哥批次；
  3. 在恢复卡上点「播放已保存试听（不计费）」；
  4. 听完点「批准使用」，四个批次都能正常保存。
  - 之后：0a89、c84e 直接查看和导出。e506 和 1b08 是否继续制作由用户逐项决定，继续属于正常付费制作：e506 点「继续未完成作品」；1b08 先核对服务记录，再点「确认风险，重试未完成规划」。
  - 复验时核对 provider-usage.jsonl，确认恢复过程中没有新增记录。
- 在此之前：CE1 合入前不要重新批准猴哥。开发机上已装的旧测试包更新之前，每启动一次都会再抹掉一次批准；修复后仍可按上面的流程免费恢复。

## 用户决定（2026-09-29）

- 同意：同一声音暂时从目录缺席、以相同配置回来时，保留原批准（需要强制重审时改 catalogVersion）。
- 同意：猴哥的恢复方式是播放本机已保存的试听（不计费）并由用户亲自点「批准使用」，不从备份库把批准写回。
- 已核实：实时数据目录里 `voice-previews/ca64cfe2…297ac.wav` 还在，sha256 以 `33a5d934` 开头，与当初批准的那次试听一致，所以恢复不需要计费。
- 暂不做：批准台账（零点击恢复）；开发版与测试版分开数据目录（CE3）。e506、1b08 是否继续制作，等修复后由用户逐项决定。
- 与 1.1.54 一起发布，但不得早于 CE1。

## 并入：CE1 第 3 轮遗留（都已复核确认、都是次要，与本卡同改一批文件）

1. **批准后要刷新**：`approvedVoiceIds` 只在页面挂载时读一次（`BatchCreativePage.tsx` 约 :181）。用户在同一页面批准声音后，之后载入批次仍会误报"需要重新批准"。批准成功后要重新拉取已批准声音列表，恢复卡和 voiceWarning 都用新列表。补行为测试。
2. `provider_usage_write_failed` 加进 PUBLIC_ERRORS，给出中文提示（用量记录写不进去，比如磁盘满了）。用户点击触发的试听、设计、生成失败时，页面要能看到这条提示。
3. `task_terminal` 事件在退回到 `unknown_error` 时，也要记一个经过校验的 `raw_code`，和 IPC 失败的处理保持一致。
4. **补测试**：确定性草稿错误白名单 `DETERMINISTIC_DRAFT_ERRORS` 的 16 个码，目前只有 4 个被测试固定。其余 12 个逐个删掉时，都必须有测试失败。
5. `recoverPlanning()`、`recoverVoice()` 发起任务前要像 `start()` 那样处理草稿保存队列（先 flush，或者取消），避免恢复任务结束后才把旧编辑写进去。
6. 从素材仓库进入工作台（`initial.assetIds`）时，如果重放因临时错误而被保留，不能被新视频的自动保存悄悄挤进备份槽。页面要提示，或者先完成恢复再进入新视频。
