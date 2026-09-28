# CE1【中】内容引擎保存失败：说清真实原因、不乱弹窗、不反复重放、不覆盖已完成的批次

分支：`claude/content-engine-save-errors`（从 `main` 9484f01 拉出，Claude 自己的工作树）。随 1.1.54 一起发布，1.1.54 尚未发布。

## 背景（已确证，2026-09-28 诊断工作流 wf_2a3fbaa8-1a9）

- 开发机每次打开创作工作台都会弹出 Windows 通知"内容引擎暂时不可用，请重试"，工作台里的保存和"生成文案"也一样失败，重试、重启都没用。从 9-23 起就是这样，不是 1.1.54 引入的。
- 触发链：
  1. 本机缓存（localStorage `batch-studio-pending-draft`）里有一份旧草稿，指向已完成的批次，配音是"猴哥 2.0"（`volc-monkey-brother-2@1`）；
  2. 旧测试包和新测试包共用数据目录，猴哥的批准被撤销（`approved_at=NULL`）；
  3. `BatchCreativePage.tsx:177-189` 在页面打开时用这份缓存草稿调用 batch-save；
  4. 引擎 `narrated_batch.py:1191-1193` 抛出 `auto_mix_voice_persona_approval_required`（"请选择已试听批准的声音。"）；
  5. 这个错误码在 `narrated-batch-ipc.cjs` 的 ERRORS 和 `content-engine-ipc.cjs` 的 PUBLIC_ERRORS 里都没有，于是 `publicError()`（:852-856）退回到笼统的 `CONTENT_ENGINE_FAILED`；
  6. `shouldNotifyOperationError`（:2199-2212）按前缀 `auto_mix_voice_` 弹出 Windows 通知；
  7. 诊断日志只记 `unknown_error`；
  8. 页面失败后不删缓存，每次打开都重放，还显示误导性的"上次编辑仍保存在本机，当前任务结束后可重新打开恢复"。
- 数据风险：缓存草稿的素材分组是空的，而库里的批次已有素材、已确认文案、已完成作品。如果猴哥被重新批准，这份旧草稿会保存成功，把已完成的批次重置成空素材的草稿。

## 要做

1. **错误码映射**：在 `narrated-batch-ipc.cjs` 的 ERRORS（会合并进 PUBLIC_ERRORS）中，给 `auto_mix_voice_persona_approval_required` 一条能照着做的中文提示，例如"这条视频使用的声音尚未批准或批准已失效，请在「声音与配乐」中改选已批准的声音，或重新试听并批准后再试。"。
   - 同时补齐 save/start 路径上会冒出来的其他未映射错误码：`invalid_narrated_settings`、`invalid_narrated_groups`、`auto_mix_voice_persona_not_found`、`invalid_voice_persona_id`、`asset_archived`、`invalid_asset_ids`、`invalid_asset_id`、`UPDATE_IN_PROGRESS`、`CONTENT_ENGINE_METHOD_INVALID`，以实际代码中存在的为准。
   - 引擎返回固定中文的，可以像 `narrated_brief_invalid` 那样经 `safePublicText` 透传。
   - 加一个静态自检：扫描 `narrated_batch.py` 中 save/start 路径上用到的错误码，要求全部有映射。
2. **收紧系统通知**（`shouldNotifyOperationError`）：
   - batch-save 这类自动或后台保存不弹 Windows 通知；
   - 退回到 `CONTENT_ENGINE_FAILED`、没有登记的错误码不弹；
   - 用户自己能处理的校验类错误（例如声音未批准）只在页面上提示。
   - 真正的引擎故障（进程退出、启动失败等已登记的 `CONTENT_ENGINE_*`）和用户主动发起的长任务失败，保持现有通知行为。
3. **保留原始错误码**：当诊断码退回 `unknown_error` 时，在 details 里额外记一个经 `/^[a-z0-9_-]{1,64}$/i` 校验的 `raw_code`。不记录任何提供方原文。
4. **页面恢复逻辑**（`BatchCreativePage.tsx`、`batch-studio-api.ts`、`batch-draft-queue.ts`）：
   - `callBatch` 抛错时带上 `result.code`。
   - **缓存草稿不能写回一个非 draft 状态的批次**：服务端批次已确认文案、已有素材或作品时，缓存里的旧编辑不得覆盖它。
   - 恢复失败，且错误是确定性的校验错误（用白名单列出，例如声音未批准、声音不存在、设置或分组无效、素材已归档）时：
     - 不再每次重放；
     - 显示真实原因；
     - 去掉"当前任务结束后可重新打开恢复"这句误导文案。
   - **临时性错误不能丢草稿**：运行时不可用、繁忙、已暂停、连接中断等，要保留缓存草稿，下次继续恢复。
   - 载入批次后，如果它的声音不在已批准列表里，明确提示"该批次的声音需要重新试听批准，或改选已批准的声音"。
   - 保存队列对确定性失败的那次待保存内容，不能一直卡住"新建视频"和"选择任务"。
   - **如果决定丢弃缓存草稿，先把它原样备份**到 localStorage 的另一个键（例如 `batch-studio-discarded-draft`，只留最近一份），不能悄悄彻底丢失用户的编辑。
5. **测试**（每一条都要证明：撤掉修复后测试会失败）：
   - `content-engine-voice-preview-errors.self_check.cjs`：对新映射的错误码断言 code 原样保留、文案不是那句笼统提示、没有泄露内部细节。
   - `content-engine-ipc.self_check.cjs`：用假的 controller 让 saveNarratedBatch 抛出 `auto_mix_voice_persona_approval_required`，调用 `content-engine:batch-save`，断言三点：返回具体中文提示；notificationFactory 没被调用；诊断 details 带 `raw_code`（或映射后的正确 code）。
   - 页面逻辑用现有 renderer 自检的方式覆盖：
     - 确定性错误时不重放；
     - 临时性错误时保留草稿；
     - 不覆盖非 draft 批次；
     - 丢弃前做了备份。

## 允许改动

`desktop/src/main/content-engine-ipc.cjs`、`desktop/src/main/narrated-batch-ipc.cjs`、`desktop/src/renderer/BatchCreativePage.tsx`、`desktop/src/renderer/batch-studio-api.ts`、`desktop/src/renderer/batch-draft-queue.ts`、上述文件对应或相关的自检，以及本卡的 result 文档。新增自检要登记进 `scripts/run-self-checks.cjs`，且必须打印 passed 行。

## 禁止

- 不改内容引擎 Python 端的声音批准规则（`creative_domain.py` 的下线分支）。它属于后续评审项，本卡不做。
- 不改微信、自动回复、精准触达相关代码。
- 不调用付费接口，不改用户真实数据。

## 验收

- 在 %TEMP% 以外的工作树跑 `check:self`、`build:test`，都通过。
- 手动复验（在数据副本上，或由用户本机验收）：
  - 打开创作工作台，不弹 Windows 通知；
  - 能看到真实原因；
  - 缓存草稿不再每次重放；
  - 已完成的批次没有被改动。
