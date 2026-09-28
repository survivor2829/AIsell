# CE1 结果：内容引擎保存失败说清原因、不乱弹窗、不反复重放、不覆盖已完成批次

分支 `claude/content-engine-save-errors`（基于 `main` 9484f01），未推送。提交：

- `f4dfdd9` 主进程：错误码映射、收紧系统通知、`raw_code`，以及三份主进程自检；
- `3bc80f2` 界面：缓存草稿恢复、保存队列、`callBatch` 带 code、新增界面自检并登记；
- `94f355a` 自检：缺少备份时给出明确的失败信息。

## 改了什么

1. **错误码映射**
   - `narrated-batch-ipc.cjs` 的 ERRORS 新增：`auto_mix_voice_persona_approval_required`（用卡上建议的文案）、`auto_mix_voice_persona_not_found`、`invalid_voice_persona_id`、`invalid_narrated_settings`、`invalid_narrated_groups`、`invalid_asset_ids`、`invalid_asset_id`、`asset_archived`、`narrated_script_already_confirmed`。
   - 最后一个不在卡片清单里，是静态扫描在 `start()` 路径上发现的未映射码。
   - `UPDATE_IN_PROGRESS`、`CONTENT_ENGINE_METHOD_INVALID` 由 sidecar 抛出，不是批次专用，放在 `content-engine-ipc.cjs` 的 PUBLIC_ERRORS 里，和其他 `CONTENT_ENGINE_*` 放在一起。两张表最终会合并，效果一样。
   - `invalid_narrated_settings`：引擎给出的是固定中文（例如“请选择至少一首配乐，或改为自动配乐。”），只要不含拉丁字母、`\`、`/`，就经 `safePublicText` 原样显示。IPC 回显的错误码、带英文字段名的 f-string、路径都退回映射文案。
2. **系统通知**（`shouldNotifyOperationError`）
   - 以下情况一律不弹：没登记的码（也就是会退回 `CONTENT_ENGINE_FAILED` 的）；`batch-save`；页面上能自己处理的声音/配乐选择校验（`PAGE_ONLY_ERROR_CODES`：声音未批准、未选声音、声音不存在、未试听、未生成声音、缺配乐）。
   - 另外把 `batch-get`、`batch-list`、`batch-collections` 也算作后台读取、不弹。原因是现在每次打开工作台，恢复前会先读一次批次。
   - 用户主动发起的操作遇到已登记的引擎故障（例如 `CONTENT_ENGINE_EXITED`）、云端或供应商错误，仍照旧弹通知。任务失败和批次结果的通知没有改动。
3. **`raw_code`**
   - 诊断码退回 `unknown_error` 时，details 里多记一个 `raw_code`。
   - 校验：必须是字符串，并通过 `/^[a-z0-9_-]{1,64}$/i`；另外排除像密钥的值（`sk-`/`ak_`/`LTAI…`）和 16 位以上的纯十六进制。原因是现有自检要求这类值绝不能进入诊断。
   - 按操作去重的键改成带上 raw_code，这样不同的未知码各记一条。不记录任何提供方原文。
4. **页面恢复**（`batch-draft-queue.ts` 里的纯函数，页面调用它们）
   - `callBatch` 抛出的错误带 `code`。
   - `restorePendingDraft`：缓存草稿带 `batch_id` 时先 `get` 这个批次。以下情况不写回，先备份再丢弃：已确认文案、已有成片（`completed_count`，或候选已完成/有成片）、状态为 rendering / awaiting_confirmation / completed / completed_with_errors、已归档、库里有素材而缓存草稿没有素材。
   - 写回时遇到确定性校验错误（白名单：声音未批准、声音不存在、声音 ID 无效、设置或分组无效、数量无效、素材 ID 无效、素材已归档、素材不存在、素材集或品牌包不存在、批次不存在、`invalid_params`、`invalid_id`）：备份后丢弃，显示“上次未保存的编辑无法恢复：<真实原因>……不会再自动恢复。”，以后不再重放。
   - 其他错误一律视为临时性（运行时不可用、繁忙、已暂停、连接中断、更新中、没有 code）：保留缓存草稿，提示“暂未恢复……下次打开时会继续恢复”。
   - “当前任务结束后可重新打开恢复”这句已删除。
   - 丢弃前，先把原字符串原样写进 `batch-studio-discarded-draft`（只留最近一份），再删除 `batch-studio-pending-draft`。备份写不进去时不删。
   - 保存队列：遇到确定性失败时丢掉这一份，不再放回队列。触发失败的那次 flush 仍会报一次原因，之后“新建视频”“选择任务”不会再被它卡住。更新的编辑照常保存。页面的 `failed` 回调会按指纹把这份编辑移进备份。
   - 载入批次（打开页面或“选择任务”）时，如果它的声音不在已批准列表里，提示“该批次的声音需要重新试听批准，或改选已批准的声音。”。已归档批次不提示。这里只看是否批准，不限火山。
5. **测试**
   - `content-engine-voice-preview-errors.self_check.cjs`：对新映射的码，断言 code 原样保留、不是笼统文案、没有泄露内部细节；并覆盖 settings 透传的正反例。
   - `content-engine-ipc.self_check.cjs`：假 controller 的 `saveNarratedBatch` 抛 `auto_mix_voice_persona_approval_required`，调用 `content-engine:batch-save`，断言返回具体中文、`notificationFactory` 未被调用、诊断记为映射后的 code。
     - 未登记的码：返回 `CONTENT_ENGINE_FAILED`，details 为 `{error_code:"unknown_error", raw_code}`，且不含原文。
     - batch-save 或 batch-get 遇到引擎故障：不弹。
     - batch-scripts（用户主动）遇到声音未批准、未登记的 `cloud_*`：不弹；遇到 `CONTENT_ENGINE_EXITED`：弹一次。
   - `narrated-batch-ipc.self_check.cjs`：静态扫描 `narrated_batch.py` 的 `save`、`start`、`_load`、`_idle`、`_asset_ids`、`validate_count`，以及 `creative_domain.py` 的 `_asset_row`、`_brand_row`、`_task_row` 里 `require(...)` 和 `ContentEngineError(...)` 的错误码，共 21 个，要求全部有映射。遇到非字面量的码直接失败。同时检查 IPC 自己的 `invalid("...")` 码。
   - 新增 `src/renderer/batch-draft-queue.self_check.cjs`（已登记进 `scripts/run-self-checks.cjs`）：用 TypeScript 转译真实模块做行为测试，覆盖确定性错误不重放、临时错误保留草稿、不覆盖非 draft 批次、先备份后丢弃、队列丢弃与保留、较新的编辑不丢；另有页面接线的源码断言。

## 验证（在 %TEMP% 以外的工作树 `C:/Users/Scott/xiaoxi-review/ce-fix/desktop`）

| 命令 | 结果 |
|---|---|
| `node src/main/content-engine-voice-preview-errors.self_check.cjs` | exit 0，`voice preview public error self-check passed` |
| `node src/main/content-engine-ipc.self_check.cjs` | exit 0，`content-engine IPC self-check passed` |
| `node src/main/narrated-batch-ipc.self_check.cjs` | exit 0，`narrated batch IPC self-check passed` |
| `node src/renderer/batch-draft-queue.self_check.cjs` | exit 0，`Batch draft restore and save queue self-check passed` |
| `node scripts/run-self-checks.self_check.cjs` | exit 0 |
| `npm.cmd run check:self` | exit 0，共 99 项，最后一行 `all source self-checks passed` |
| `npm.cmd run build:test` | exit 0，`test renderer build completed`；产物里已没有旧文案，新提示在其中 |

- `check:self` 跑在 `94f355a` 之前。`94f355a` 只在新自检里加了一行断言，已单独复跑通过。
- 全仓 `tsc --noEmit` 在本环境原本就大量报错（缺 `@types/react`）。对比了改动前后三份改动文件的报错：只多了 2 条同类的 TS7006（`voices` 没有类型导致的 implicit any），和原有行一样，没有新的真实类型错误。

## 撤掉修复后测试会失败（证据）

把 5 个源码文件整体换回 9484f01，四份自检都失败：

- voice-preview：`auto_mix_voice_persona_approval_required must keep its own code`；
- ipc：`:1369` 处 code 实际是 `CONTENT_ENGINE_FAILED`；
- narrated-batch：`every save/start error code in narrated_batch.py needs a public message`；
- 界面：`callBatch must carry result.code`。

逐项撤回（脚本 `ce-diag/mutate.cjs`，每次改完用 `git checkout HEAD` 还原）：

| 撤回内容 | 失败的断言 |
|---|---|
| ERRORS 映射还原为 base | voice-preview :55；narrated-batch 扫描 :61；ipc :1369 |
| 删一条 `narrated_script_already_confirmed` | narrated-batch 扫描 :61 |
| 删 `UPDATE_IN_PROGRESS` | voice-preview :55 |
| 关掉 settings 透传 | voice-preview :64 |
| `content-engine-ipc.cjs` 整体还原 | ipc :1371 `an automatic draft save must not raise a desktop notification` |
| 去掉 batch-save 豁免 | ipc :1381 |
| 去掉 PAGE_ONLY 校验码 | ipc :1396 |
| 未登记码照样弹 | ipc :1399 |
| 去掉 batch-get 豁免 | ipc :1388 |
| 一律不弹（检查故障通知仍保留） | ipc :1402 |
| 不记 raw_code | ipc :1376 |
| raw_code 不过滤 | ipc :2844（原有的密钥形状码泄露断言） |
| `callBatch` 还原 | 界面 :73 |
| 队列失败一律放回 | 界面 :186 `a deterministic failure must not be replayed` |
| 不做 draft 守卫 / 只去掉素材分组守卫 | 界面 :133 `must not overwrite …` |
| 不写备份 / 先删后备份 / 备份不是原样 | 界面 :91 / :161 / :93 |
| 临时错误也丢弃 / 确定性错误也保留 | 界面 :102 / :87 |
| 页面还原为 base | 界面 :205（旧文案仍在） |
| 页面去掉实时编辑备份 / 去掉声音提示 | 界面 :209 / :212 |

## 端到端回放（数据副本，脚本 `ce-diag/ce1-e2e/e2e.cjs`）

- 用已安装 1.1.54 的 `content-engine-worker.exe`，数据用 `backup-pre-1.1.54` 数据库的**新副本**（`ce-diag/ce1-e2e/data/*`）。缓存草稿用诊断时导出的真实 `batch-studio-pending-draft`。主进程接真实的 `content-engine-ipc.cjs`，界面用真实的恢复逻辑，模拟连续打开两次工作台。
- 只调用本地的 save/get，没有付费调用，没有碰实时数据。

| 场景 | base（9484f01） | 本分支 |
|---|---|---|
| 猴哥未批准（现状） | 每次打开都重放 save，提示“上次编辑仍保存在本机，当前任务结束后…”，弹通知“内容引擎暂时不可用，请重试。”，诊断 `unknown_error` | 第一次打开：先读批次，发现已完成，不写回，备份（与原文逐字相同）后提示原因；第二次打开无操作。0 条通知。实时保存返回“这条视频使用的声音尚未批准或批准已失效…”，诊断记为该 code。批次 0a89 逐字节不变 |
| 副本里重新批准猴哥 | 恢复**成功**，批次 0a89 从 completed、4 个素材、已确认文案、1 条成片，变成 **draft、0 个素材、无确认稿、无候选** | 不写回，备份后提示原因；批次 0a89 逐字节不变 |

## 没做或未验证

- **没在真实 Electron 界面里复验**：开发版和测试包共用实时数据目录，没有可切换的数据目录，所以没有启动应用。请用户在本机验收：
  1. 用本分支打开创作工作台，应该不弹 Windows 通知；
  2. 页面应显示“上次未保存的编辑属于已确认文案或已有成片的批次，为避免覆盖已完成的内容，没有写回，也不会再自动恢复。”（第二轮改过文案），以及“该批次的声音需要重新试听批准，或改选已批准的声音。”；
  3. 再打开一次，第一条提示不再出现；在 DevTools 里看，`batch-studio-pending-draft` 已经没有，`batch-studio-discarded-draft` 存在；
  4. 制作记录里的批次 0a89 仍是已完成、有 4 个素材和成片；
  5. 诊断里不再出现开机时的 `batch-save.failed`。
  - 注意：这一步会改本机 localStorage（把缓存草稿移进备份键），属于用户的验收操作。
- 按卡片要求，没改 Python 端撤销声音批准的规则（`creative_domain.py` 的下线分支）。
- 诊断里的开放问题没有排查：缓存草稿为什么素材分组为空、却挂在已完成批次上。本卡的守卫已经挡住它造成的覆盖。
- 缓存草稿本身不是合法 JSON 时，打开时的恢复仍忽略它；第二轮起，页面写入新编辑前会先把它原样备份。
- 已确认文案的批次，“声音与配乐”仍然是锁住的（原有设计）。这种情况下只能重新试听并批准原声音，或者新建视频。

## 第二轮：按审查意见修复（2026-09-28）

提交：`17d72fd`（主进程）、`db3b470`（界面），以及本文档的提交。未推送。

### 改了什么

1. **启动路径上漏掉的两个码**（correctness-F1）
   - `CONTENT_ENGINE_PROVIDER_REFRESH_BUSY`、`CONTENT_ENGINE_PROVIDER_REFRESH_FAILED` 由 `main.cjs` 的 `beforeContentProviderWork` 在批次开始前抛出。第一轮没登记，页面显示笼统提示，通知也被新规则挡掉了。
   - 现在已登记进 PUBLIC_ERRORS，页面显示各自的中文原因。它们属于已登记的 `CONTENT_ENGINE_*`，用户主动开始任务时照旧弹通知。
   - 静态自检加扫 `beforeContentProviderWork`：扫到的码必须正好是这 3 个，且都有映射。
2. **保存队列**（draft-safety-F1、F6）
   - 确定性失败的编辑先挂起，不在后台重试。
   - 下一次显式 flush（新建视频、选择任务、离开页面）再试一次。所以用户在页面上批准声音后再点“新建视频”，这份编辑能存进批次。
   - 第二次仍被拒才放下，而且不抛错、不挡操作。
   - 较新的编辑会替换挂起的那份；某次保存失败时如果已经有较新的编辑，立刻接着存（F6）。
3. **页面**
   - 实时保存失败不再移动缓存槽。
   - 只有用户点新建视频、选择任务，且第二次仍被拒时，才把这份编辑原样备份。离开页面时编辑留在缓存槽，下次打开重放一次，所以在别处批准声音后回来能恢复（draft-safety-F1 路径 B）。
   - 提示分两种：“草稿尚未保存：…”和“上一份编辑未能保存：…”。后者在“选择任务”载入新批次后仍然显示。之后保存成功，会清掉过时的“草稿尚未保存”。
4. **缓存槽**（draft-safety-F2、correctness-F3）
   - 新增 `createPendingDraftSlot`。页面只覆盖或清除自己为当前表单写的最新编辑。
   - 缓存槽里的其他内容（上次会话保留的、页面已离开的、旧版本写的、无法解析的）先原样备份再覆盖。备份写不进去就不覆盖，新编辑只靠 IPC 保存。
   - 开始任务成功后只清除自己的编辑，不再无条件删除。
   - 缓存槽多记一个 `base_updated_at`，即这份编辑基于的批次 `updated_at`。保存成功后，同一表单较新的缓存编辑会一起更新 `batch_id` 和 base。
5. **恢复规则**（correctness-F4、draft-safety-F3）
   - 只写回 status 为 `draft`、且 `updated_at` 与编辑的 base 一致的批次。旧版本写的缓存没有 base，仍用“不能清空素材”的守卫。
   - 这比卡片的要求更严：`scripts_ready` 等非 draft 批次一律不写回，1 个素材的过期缓存也不会覆盖之后改动过的草稿批次。
   - 代价是：在非 draft 批次上改需求，实时保存又恰好因临时错误失败，之后关了应用，下次打开不会写回，而是备份并说明原因。
   - 删掉了 `completed_count` 检查，因为 `get()` 从不返回这个字段。成片只看候选状态。
6. **提示文字**（correctness-F2、draft-safety-F4、tests-C1、draft-safety-F7）
   - 备份写不进去时，结果是 kept，提示“这份编辑仍保留在本机，下次打开时会再次检查。”，不再说已经备份或不会再恢复。
   - 拒绝写回分五种原因，各有提示：已归档；已确认文案或已有成片；已生成文案或已开始处理；之后又有更新；缓存没有素材、写回会清空已选素材。
   - 面向客户的提示不再说“已在本机另存备份”，因为没有界面能读取它。备份键 `batch-studio-discarded-draft` 仍然保留，供排查。
   - 临时错误的提示改为“下次打开工作台时会再尝试；如果现在开始新的编辑，将以新的编辑为准。”
7. **自检**（correctness-F5、tests-T1、tests-T2、draft-safety-T1）
   - `content-engine-ipc.self_check.cjs`：
     - 用户主动开始任务时，`cloud_request_failed`、`provider_gateway_unavailable` 和两个 REFRESH 码返回各自文案，各弹一次通知。
     - `raw_code`：含空格、含中文、超过 64 位、32 位十六进制、UUID 都不记；不同的未知码各记一条，同一个码重复只记一次。
   - `batch-draft-queue.self_check.cjs` 重写为行为测试，覆盖：
     - `discardPendingDraft` 的指纹闸门（指纹不同时不动、相同时原样移走、内容无法解析时不动）；
     - 备份失败时如实提示；
     - 队列的挂起、重试、放下，以及 F6；
     - 缓存槽的归属、base 更新、开始任务后只清自己的编辑；
     - 五种拒绝原因；
     - 按页面接线组装的流程：页面上改好声音后再离开、不改就离开、离开后在别处批准再回来、临时错误保留的草稿遇到新编辑或开始任务。
   - 页面接线仍用源码断言：缓存槽的读写只能经 `draftSlot`，页面里不再直接 `setItem`/`removeItem` 缓存键。

### 验证（`C:/Users/Scott/xiaoxi-review/ce-fix/desktop`，%TEMP% 以外）

| 命令 | 结果 |
|---|---|
| `node src/main/content-engine-ipc.self_check.cjs` | exit 0，`content-engine IPC self-check passed` |
| `node src/main/narrated-batch-ipc.self_check.cjs` | exit 0，`narrated batch IPC self-check passed` |
| `node src/main/content-engine-voice-preview-errors.self_check.cjs` | exit 0，`voice preview public error self-check passed` |
| `node src/renderer/batch-draft-queue.self_check.cjs` | exit 0，`Batch draft restore and save queue self-check passed`（约 5 秒，含真实 400ms 防抖等待） |
| `node scripts/run-self-checks.self_check.cjs` | exit 0 |
| `npm.cmd run check:self` | exit 0，用时 4 分 0 秒，最后一行 `all source self-checks passed`；上面四份都在输出里 |
| `npm.cmd run build:test` | exit 0，`test renderer build completed`。产物里旧文案（“当前任务结束后可重新打开恢复”“已在本机另存备份”“下次打开时会继续恢复”）都是 0 处，新提示都在 |

- `tsc --noEmit`：只看改动的三个界面文件，并排除本环境缺 `@types/react` 造成的 JSX 报错，和第一轮相比只多 1 条 TS7006（`setNotice((current) => …)` 的参数）。它和原有的 `setSettings((previous) => …)` 是同一类问题；`batch-draft-queue.ts` 没有报错。

### 撤掉修复后测试会失败

- 把新自检跑在第一轮（7dff097）的界面文件上：失败于 `/当前任务结束后|备份/` 断言。
- 逐项撤回：脚本 `ce-diag/mutate2.cjs`，按原字节还原，不碰 git；清单在 `ce-diag/r2-*-mutations.json`。共 40 个不同的变异（其中一个分别对两份自检各跑一次，合计 41 次），只有 1 个没被测出，见表后说明。

| 撤回内容 | 失败的断言 |
|---|---|
| 删掉两个 REFRESH 码 / 只删 FAILED | narrated-batch :77 `every provider preflight code needs a public message`；ipc :1444 |
| `cloud_request_failed` 或 `provider_gateway_unavailable` 加进 PAGE_ONLY；去掉 `cloud_`、`provider_` 前缀 | ipc :1445 `… on a user-started batch must still notify` |
| raw_code 字符集检查改为 true / 十六进制过滤改为 true / 去重键不含 raw_code | ipc :1394 / :1394 / :1393 |
| 队列第一次确定性失败就丢弃（第一轮的做法） | 界面 :350 `an explicit flush retries the held edit once the cause is fixed` |
| 从不放下 / 第一次显式 flush 就放下 | 界面 :357（flush 一直抛错）/ :356 `a first rejection is reported and holds the page` |
| 去掉“失败后接着存较新编辑” | 界面 :408（F6） |
| enqueue 或 cancelPending 不清挂起的编辑 | 界面 :382 / :391 |
| restore 忽略备份结果 | 界面 :263 `without a backup the edit is kept, not reported as discarded` |
| 指纹检查删掉 / 取反 / 整段不执行；先删后备份 | 界面 :150；:166 |
| 缓存槽无条件覆盖 / 备份失败仍覆盖 / 不看 owner | 界面 :289 / :301 / :296 |
| 保存后清掉别人的编辑 / 开始任务后清掉任意编辑 / 不更新 base | 界面 :320 / :320 / :311 |
| 允许非 draft / 不看 base / 去掉素材守卫 / 去掉候选成片守卫 | 界面 :230 / :230 / :230 / :231 |
| 拒绝原因只用一种文案；临时错误用旧文案 | 界面 :231；:192 |
| 页面：实时失败就移走缓存 / 离开页面时也移走 / 直接写缓存键 / 开始任务直接删缓存键 / 不记 base / 仍用 `discard` 选项 / 载入批次时盖掉“上一份编辑未能保存” | 界面 :509 / :509 / :502 / :502 / :507 / :505 / :512 |

- 唯一没被测出的是等价变异：把挂起编辑的重试从“仅显式 flush”放宽到“任意 flush”。后台计时器只由 `enqueue` 触发，而 `enqueue` 会先清掉挂起的编辑，所以这个改动不会改变任何行为。

### 端到端回放（全部在数据副本上）

用已安装 1.1.54 的 `content-engine-worker.exe`，数据用 `backup-pre-1.1.54` 数据库的新副本，缓存草稿用诊断时导出的真实值。只调用本地 save/get，没有付费调用，没有碰实时数据。

| 场景（脚本） | 结果 |
|---|---|
| 猴哥未批准（`ce1-e2e/e2e.cjs … asis`） | 第一次打开：discarded，“…已确认文案或已有成片的批次，为避免覆盖已完成的内容，没有写回，也不会再自动恢复。”，备份与原文逐字相同。第二次打开无操作。0 条通知。实时保存返回声音未批准的提示，诊断记为该 code。批次 0a89 逐字节不变 |
| 副本里重新批准猴哥（同上 `reapproved`） | 0 次 save；提示同上；批次 0a89 逐字节不变 |
| 审查的 scripts_ready 场景（`ce-diag/r2-e2e-copy.cjs reapproved-scripts-ready`，由审查脚本改指向本工作树） | discarded，“…已生成文案或已开始处理，为避免覆盖其中的结果，没有写回…”。批次 21e428 仍是 scripts_ready，`script_options` 仍为 1，逐字节不变。第一轮这里从 1 变成了 0 |
| 更新中 / 找不到运行时（`update-hold` / `runtime-missing`） | 两次打开都是 kept，缓存槽不变，0 条通知，提示是“软件正在更新…”或“未找到可用的内容引擎…”加上“下次打开工作台时会再尝试…” |
| 带素材的过期缓存（`reapproved-with-assets`） | discarded（已确认文案或已有成片），批次不变 |

### 仍未验证或未做

- 仍没在真实 Electron 界面里复验，原因同上。上面的手动验收步骤已按新文案更新。另外可以加测一条：打开一个声音已失效的批次，改一句文案，看到“草稿尚未保存：…”；在“声音与配乐”里重新批准该声音，然后点“新建视频”。回到制作记录，这句改动应该已经存进该批次。
- 备份键只存最近一份，也没有界面能读取它；它只供排查用，客户提示里不再提。
- 旧版本写的缓存没有 base，无法判断批次在那之后有没有改过：只要批次还是 draft、缓存也没有清空素材，就会写回。每台机器最多遇到一次。

## 第三轮：按第二轮审查意见修复（2026-09-29）

提交如下，都未推送：

- `40a90b5` 主进程：真实日志器不再把不同的未登记码合并成一条（correctness-F1）；
- `9414987` 主进程：登记网关证书、配音下载等错误码（correctness-F5）；
- `b2eba7a` 自检：工作台读取豁免、页面级校验码、开始与确认路径的扫描（correctness-F2、F3、F4）；
- `ca9660d` 界面：恢复结果如实上报、挂起的拒绝不被重置、`task_not_found`、从别的批次打开时也恢复、归档竞态（draft-safety-F1～F5、draft-safety-T1、tests-T1）；
- `b259da3` 自检：按引擎的真实行为模拟归档竞态；
- 本文档的提交。

### 改了什么

1. **`raw_code` 去重**（correctness-F1）
   - 诊断日志器按 event + code 合并连续的相同故障，而所有未登记码的 code 都是 `unknown_error`，所以同一操作上第二个不同的未登记码会被吞掉。
   - 现在有 `raw_code` 时，把 `unknown_error:<raw_code>` 作为 `dedupeKey` 传给日志器。已登记的码不传，行为不变。
   - 自检里的桩日志器同时把每条事件写进一个真实的 `createDiagnosticLogger`（临时目录）。断言写出的文件里，连续的 first、second、first 三条都在。
2. **声音试听和生成的错误码**（correctness-F5）
   - 新登记 5 个码：`provider_gateway_tls_not_configured`、`provider_gateway_tls_invalid`、`auto_mix_voice_download_failed`、`cloud_response_invalid`、`cloud_response_too_large`。
   - 用户点击试听遇到这些错误时，页面显示各自的原因，并照旧弹一次通知。它们带 `provider_`、`cloud_` 或 `auto_mix_voice_` 前缀，且已登记。
   - 审查提到的 `cloud_timeout` 在内容引擎的 Python 代码里不存在，只出现在更新下载用的 `cloud-transport.cjs` 里，所以没有登记。
   - voice-preview 自检新增静态扫描，覆盖以下代码，共扫到 23 个码，要求全部有映射：
     - `provider_tls.py`、`volcengine_tts.py` 全文件；
     - `creative_analysis.py` 的 `synthesize_auto_mix_phrase`、`design_auto_mix_voice`、`_request_json`；
     - `creative_domain.py` 的试听、生成、批准和取声音记录。
3. **自检覆盖**（correctness-F2、F3、F4）
   - `batch-get`、`batch-list`、`batch-collections` 遇到 `CONTENT_ENGINE_EXITED` 时都不弹通知。
   - `PAGE_ONLY_ERROR_CODES` 的 6 个码逐个放在用户点击的开始任务上验证：返回自己的 code，不弹通知。
   - 静态扫描新增以下函数，覆盖的码从 21 个增加到 38 个：
     - `service.py` 的 `_start_narrated_batch`、`probe_asset`、`_require_media_probe`、`_validate_id`；
     - `narrated_batch.py` 的 `confirm_script`；
     - `narrated_production.py` 的 `confirm_selections` 及其 4 个容量检查。
   - `_validate_render_capacity` 抛出的是运行时得到的码（渲染器的 capability code），手工解析为 `media_tools_unavailable`、`media_encoder_unavailable`，两个都已有映射。
   - 这两条路径上目前没有未映射的码，所以 F4 只扩大了扫描范围，源码没改。
4. **恢复结果如实上报**（draft-safety-F1）
   - 同一份存储上重叠的恢复（开发版 StrictMode 会把挂载 effect 跑两遍）共用一次重放和同一个结果。
   - 停止重放时区分三种情况：
     - 已移进备份：报 discarded；
     - 缓存槽里已经不是这份编辑（被别的流程移走、写回或替换）：报 none，不再给提示；
     - 备份写不进去：报 kept。
5. **挂起的拒绝**（draft-safety-F2）
   - 页面每次操作失败、busy 变回 false 后，会把同一份表单重新入队。
   - 现在同一 owner、同一指纹的重新入队会保留“已拒绝一次”的标记，也不再触发后台保存。下一次显式 flush 就是最后一次尝试。
6. **`task_not_found`**（draft-safety-F3）：加入确定性错误白名单。
7. **从别的批次打开时的缓存编辑**（draft-safety-F4）
   - 以前只在“打开的批次就是缓存编辑所属批次”时才恢复。现在无论从哪里打开工作台，都先按同样的守卫重放缓存编辑。
   - 如果编辑写回的是另一个批次，页面仍打开所请求的批次，并提示“上次未保存的编辑已存回它所属的视频草稿，可在「制作记录」中找到。”。被拒绝或暂未恢复时，显示对应的原因。
   - 这样在所打开批次上的第一次按键没有东西可替换，不会再悄悄把那份编辑移进备份。
   - 备份仍只留一份（卡片的规定）。暂未恢复（临时错误）时，提示里已经写明“如果现在开始新的编辑，将以新的编辑为准”。
8. **归档竞态**（draft-safety-F5，base 已有的问题）
   - “归档批次”先 `await draftQueue.flush()`，让还在防抖中的编辑先存进去，然后再归档。
   - 归档后执行 `draftOwner += 1` 和 `cancelPending()`，旧表单之后的保存响应不会再把已归档的批次选回来。
   - flush 第一次遇到确定性拒绝时，和“新建视频”一样先挡一次；再点一次就放下这份编辑。
9. **自检**（draft-safety-T1、tests-T1）
   - 新增单元测试：并发恢复（`Promise.all`）；“缓存槽已不在”和“备份失败”分开测；`task_not_found`；重新入队不重置拒绝标记；`restoreNotice` 对 none、kept、discarded、restored 四种结果的返回值。
   - 页面 harness 现在会模拟 busy 变回 false 后自动保存 effect 重跑，以及点击失败后重新入队。
   - 新增页面流程：
     - 连点两次“新建视频”；
     - 从制作记录打开另一个批次；
     - 归档竞态，同时用旧接线跑一遍作对照，证明模型能复现这个竞态。
   - 源码断言固定 harness 模拟的页面代码：
     - 恢复时不再传 batchId；
     - 恢复成功后只在打开的是同一批次时载入；
     - `const notices = [restoreNotice(restore)];` 以及随后的 `setNotice`；
     - 自动保存 effect 的依赖里有 busy；
     - 归档前 flush，归档后 owner 递增。

### 验证（`C:/Users/Scott/xiaoxi-review/ce-fix/desktop`，%TEMP% 以外）

| 命令 | 结果 |
|---|---|
| `node src/main/content-engine-ipc.self_check.cjs` | exit 0，`content-engine IPC self-check passed` |
| `node src/main/narrated-batch-ipc.self_check.cjs` | exit 0，`narrated batch IPC self-check passed` |
| `node src/main/content-engine-voice-preview-errors.self_check.cjs` | exit 0，`voice preview public error self-check passed` |
| `node src/renderer/batch-draft-queue.self_check.cjs` | exit 0，`Batch draft restore and save queue self-check passed`（约 7 秒） |
| `node scripts/run-self-checks.self_check.cjs` | exit 0 |
| `npm.cmd run check:self` | exit 0，用时 4 分 2 秒，最后一行 `all source self-checks passed`。上面四份自检都在输出里（日志第 202、205、208、226 行），日志在 `ce-diag/r3/check-self.log` |
| `npm.cmd run build:test` | exit 0，`test renderer build completed`。`dist-development` 里有新提示和 `task_not_found`；旧文案（“当前任务结束后可重新打开恢复”“已在本机另存备份”“下次打开时会继续恢复”）都是 0 处 |

- **tsc**：
  - 项目 `tsc -p` 在三个界面文件上报 639 条错误，按“文件 + 错误码 + 信息”对比，与本轮修改前完全相同。这些都是本环境原有的问题，例如缺 `@types/react`、webp 模块声明。
  - `batch-draft-queue.ts` 单独用 strict 模式检查，0 错误。

### 撤掉修复后测试会失败

- **整体换回第二轮**：把 4 个源文件换回第二轮（`4f300fc`）的版本，再跑新自检：
  - 界面：`TypeError: restoreNotice is not a function`；
  - ipc：`the real logger must not fold different unknown codes into one entry`；
  - voice-preview：`every voice preview or design error code needs a public message`；
  - narrated-batch：exit 0。F4 只扩大了扫描范围，第二轮的源码本来就没有未映射的码。
- **逐项变异**：
  - 脚本 `ce-diag/r3/mutate.cjs`，按原字节还原，不碰 git。
  - 清单 `ce-diag/r3/m-main-all.json`、`m-renderer-all.json`，结果在 `r3-main-mutations.results.json`、`r3-renderer-mutations.results.json`。
  - 共 35 个变异，全部被测出。

| 撤回内容 | 失败的断言 |
|---|---|
| 不传 `dedupeKey` | ipc :1415 `the real logger must not fold different unknown codes into one entry` |
| 删掉两个 TLS 码之一，或删掉 `auto_mix_voice_download_failed` | voice-preview :51（扫描）；ipc :2619 `… must reach the page as its own code` |
| 删掉 `cloud_response_too_large` 或 `cloud_response_invalid` | voice-preview :51 |
| 豁免列表去掉 `batch-list` 或 `batch-collections` | ipc :1436 `… while the workbench opens reports on the page only` |
| `PAGE_ONLY_ERROR_CODES` 删掉或改名其余 5 个码中的任意一个 | ipc :1447 `… is fixed on the page, not announced on the desktop` |
| 在 `_start_narrated_batch`、`probe_asset` 或 `confirm_selections` 里新增一个未登记的码；删掉 `narrated_duration_too_short` 或 `media_encoder_unavailable` 的映射 | narrated-batch :76 `every save/start/confirm error code the engine raises needs a public message` |
| 把 `media_metadata_unavailable` 改名 | narrated-batch :74（扫描必须看到它） |
| 去掉单飞 | 界面 :317（第二次恢复的结果必须和第一次相同） |
| 缓存槽已不在时仍报 kept | 界面 :327 `an edit no longer cached must not be reported as kept` |
| 指纹不同也照样移走 | 界面 :187 |
| 重新入队清掉拒绝标记 / 保留标记但仍后台重试 | 界面 :479 `re-enqueueing the rejected form does not retry it in the background` |
| 不比较 owner | 界面 :487 `the same form under a new owner starts over` |
| 只撤回队列修复并删掉单元测试段（只留页面流程） | 界面 :587 `the second click moves on without waiting for a background save` |
| 去掉 `task_not_found` | 界面 :298 |
| `restoreNotice` 不提示“已存回” | 界面 :294 |
| 页面仍传 `batchId: initial?.batchId` / 恢复后无论打开哪个批次都载入恢复的批次 | 界面 :671 / :672 |
| `const notices: string[] = []`（tests-T1 的变异）/ 不再 `setNotice(notices…)` | 界面 :673 `the page must show the outcome of a replay it does not load` / :674 |
| 自动保存 effect 的依赖去掉 busy | 界面 :675 |
| 归档前不 flush / 归档后不递增 owner | 界面 :676 `archiving must let a waiting edit land first and ignore later responses for the old form` |

### 端到端回放（全部在数据副本上）

- 脚本 `ce-diag/r3/e2e.cjs`，输出在 `ce-diag/r3/e2e-*.json`。
- 用已安装 1.1.54 的 `content-engine-worker.exe`，数据用 `backup-pre-1.1.54` 数据库的新副本，缓存草稿用诊断时导出的真实值。
- 主进程接本工作树真实的 `content-engine-ipc.cjs`，界面用真实的恢复逻辑和队列，按第三轮的页面接线组装。
- 只调用本地的 get、save、archive，没有付费调用，没有碰实时数据。

| 场景 | 结果 |
|---|---|
| 猴哥未批准，连续打开两次（`asis`） | 第一次 discarded，提示“…已确认文案或已有成片的批次…也不会再自动恢复。”，备份与原文逐字相同。第二次 none。0 次 save，0 条通知，0a89 逐字节不变 |
| StrictMode 并发打开，缓存为事故草稿（`strictmode-asis`） | 两次运行结果相同，都是 discarded 且提示相同。只读了 1 次批次，0 次 save，0 条通知。第二轮这里 run B 报 kept |
| StrictMode 并发打开，缓存为可恢复的草稿（`strictmode-restore`） | 两次都是 restored，结果相同。只 save 1 次，5befae 的标题变成“R3 恢复标题”。第二轮这里 run B 报 kept，并说“所属批次又有了更新” |
| 从制作记录打开 0a89，缓存的是 5befae 的编辑（`open-other`） | restored。页面仍打开 0a89，提示“上次未保存的编辑已存回它所属的视频草稿…”。5befae 已写入这份编辑，缓存槽已清空。反过来打开 5befae、缓存为事故草稿时：discarded，显示原因，0a89 逐字节不变 |
| 声音未批准，200 ms 内连点两次“新建视频”（`click-twice`） | 第一次被挡，显示原因。第二次放行，提示“上一份编辑未能保存：…”，这份编辑已备份。共 2 次 save，之后 700 ms 内没有后台保存。0 条通知 |
| 改完标题立即归档（`archive-race`） | 最后一次编辑先存进 5befae，然后归档。页面没有把该批次选回来。下一条视频存成新批次，5befae 仍是已归档 |
| 同上，旧接线对照（`archive-race-old`） | 页面把已归档批次选了回来。下一条视频存进 5befae，5befae 变成未归档、0 个素材、标题“新视频”，和审查的结论一致 |
| 批次指向不存在的任务（`dangling-task`：在副本里把 5befae 的 task_id 改成一个不存在的值） | 第一次 discarded，提示“…没有恢复，也不会再自动恢复：没有找到这条任务记录。”。第二次 none。0 次 save，0 条通知 |

### 仍未验证或需要确认

- **需要用户确认的行为变化（F4）**：从制作记录打开批次 Y 时，如果本机缓存了批次 X 的未保存编辑，现在会在同样的守卫下写回 X，或者新建一个草稿（缓存的是从未保存过的新视频时），并在 Y 的页面上提示。以前这种情况什么都不做，而在 Y 上第一次按键时，这份编辑会被悄悄移进备份。
- **真实 Electron 界面仍未复验**，原因同前。手动验收在前面的步骤之外，再加三条：
  1. 开发版（`npm.cmd run desktop`，StrictMode）打开工作台，只出现一条“…也不会再自动恢复。”，不会出现“仍保留在本机”；
  2. 在某个批次上改一句，400 ms 内点“归档批次”。制作记录里该批次应在已归档分类里，并且带着这句改动；随后新写的视频是一个新批次；
  3. 先在一个草稿批次上改一句，并让它没存上（例如保存时引擎未就绪），关掉应用；再从制作记录打开另一个批次。页面应提示“已存回它所属的视频草稿”，原批次里应有这句改动。
- 备份仍只留最近一份，也没有界面能读取（卡片规定，未改）。
