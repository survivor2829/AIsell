# 模块边界

本文只说明代码职责和状态归属，不记录功能是否通过验收；当前能力与验证结果只看 `PROJECT_STATUS.md`。

## 代码边界

| 区域 | 职责 | 不应承担 |
|---|---|---|
| `desktop/src/renderer/` | React 页面、用户输入、状态展示和 IPC 调用 | 直接访问微信、文件系统、明文 Key 或执行业务发送 |
| `desktop/src/main/` | Electron 生命周期、IPC、业务编排、DeepSeek、运行协调和数据目录注入 | 在页面组件中复制 RPA 逻辑；把单功能状态写进共享适配配置 |
| `desktop/rpa/contact_sync/` | 读取微信联系人并输出规范化联系人清单 | 自动回复、主动触达或朋友圈动作 |
| `desktop/rpa/active_touch/` | 微信窗口观察/发送适配、主动触达状态机及测试版朋友圈执行器 | renderer 状态管理、API Key 持久化、跨业务混用发送账本 |
| `desktop/sidecars/product-detail/` | 产品详情图本地 sidecar、隔离工作台和用户数据迁移 | 向 renderer 暴露文件系统、密钥或任意本机进程能力 |
| `desktop/sidecars/content-engine/` | 原素材原地索引、媒体探测、素材版权/使用权状态、内容任务和成片登记 | 复制或删除用户原片；调用微信自动化或绕过 Electron 主进程 |
| `desktop/scripts/` | self-check、renderer 构建、便携包生成和包内检查 | 保存运行数据或作为 live 验收凭证 |
| `.github/workflows/ci.yml`、`desktop/scripts/build-internal-release.cjs`、`publish-cloud-release.cjs` | 提交后的自动检查、受控 Windows 完整候选包构建与内部测试频道发布；步骤见 `docs/internal-release.md` | 将 CI 通过当作用户验收；上传签名私钥；把内部制品发布到正式频道 |
| `desktop/src/shared/role-appearance.json`、`desktop/src/renderer/role-appearance.ts`、`desktop/src/main/role-preferences.cjs` | 3 位角色、9 种形象的共享目录；名字与形象校验、主进程原子持久化及相关工作区配色 | 用页面本地状态冒充保存成功；允许任意文件或远程地址作为形象 |
| `desktop/src/renderer/CustomerTools.tsx`、`desktop/src/renderer/CustomerPanel.tsx` | 顶栏公告、离线教程和对应功能跳转；公告只展示主进程已验证数据 | 下载或执行公告内容；从远程页面加载教程代码 |
| `desktop/src/main/cloud-maintenance*`、`cloud-transport.cjs` | 测试版签名更新、公告缓存/已读状态、30 分钟元数据刷新、自动脱敏诊断队列及受限 IPC | 上传聊天原文；把查看公告当成下载安装包；绕过正常退出流程安装 |
| `desktop/src/main/feedback-*`、`desktop/src/renderer/FeedbackCenter.tsx` | 吐槽中心草稿、固定提交快照、独立发送队列、加密回执凭据、处理进度及日志诊断入口 | 将反馈提交视为持续自动上传授权；未收到回执即显示已进入服务端处理 |
| `desktop/sidecars/content-engine/content_engine/production_summary.py` | 完整数据库记录的业务制作归并、分类、统计和分页；与精确任务/候选查询配合恢复历史制作 | 截取前 N 条原任务再推算总数；改写历史失败或把同项目所有任务合为一项 |
| `desktop/sidecars/content-engine/content_engine/provider_usage.py` | 已接入供应商的真实请求开始/结果事件、上下文关联和用量汇总 | 记录提示词/正文/密钥；把缺失用量当零或自行推定账单金额 |
| `server/maintenance/` | 测试更新分发、诊断聚合、`feedback.py` 私有回执与处理状态，以及 SSH 隧道后台 | 公网列出反馈；接管微信操作、客户密钥或计费授权 |
| `release/` | 从源码生成的便携目录与 ZIP | 手工修改后回灌源码或作为唯一真相 |

正常入口由 `wechat-workflow.cjs` 统一安排触达、朋友圈发布／互动和客户回复优先级，`wechat-workflow-ipc.cjs` 管理统一进度浮窗。各业务执行器完成一个工作单元后交还调度权，不把业务发送账本搬进协调层。朋友圈的 `moments-daily-automation.cjs` 仅保留旧独立模式；统一工作流接管时停止其调度，避免双重执行。

## 共享微信适配边界

自动回复和主动触达共享同一组底层动作语义：定位窗口、固定左上角、观察会话、验证输入框、写入草稿、发送前复核、执行发送和验证结果。UIA 与视觉识别是可替换 adapter；一次事务选定一种证据链，不在中途拼接两套会话基线。

共享层可以保存：

- 微信版本、PID/HWND、窗口位置和 DPI。
- adapter 类型、视觉配置和最近一次适配诊断。
- 不含业务含义的会话观察证据。

共享层不能保存：

- 某条客户消息是否已回复。
- 某位联系人是否已主动触达。
- 某条朋友圈是否已点赞或评论。
- 业务任务的成功、失败或补发决定。

## 业务状态分离

运行根目录由 `desktop/src/main/runtime-data.cjs` 统一创建：

| 子目录或文件 | 权威状态 |
|---|---|
| `contact_sync/` | 联系人同步过程和诊断；同步后的规范化联系人清单写入 `active_touch/contacts.json`，供业务只读消费 |
| `active_touch/` | 主动触达任务快照、联系人清单、发送事务、结果账本和运行日志 |
| `auto_reply/` | 状态 v3、稳定消息 occurrence、exactly-once 去重、未知发送 occurrence 隔离和诊断；旧包 OCR 临时观察与频率事件不跨版本继承 |
| `moments/` | 朋友圈观察、帖子稳定标识、动作尝试、去重账本及独立的每日计划状态 |
| `wechat_workflow/` | 跨模块任务编号、排序、执行时间、汇总进度与最后展示任务；不保存正文、联系人快照或发送凭证 |
| `wechat_adapter/` | 共享微信窗口与 adapter 配置，不含业务结果 |
| `role-preferences.json` | 各角色已保存的名字和该角色有效形象 ID；共享目录定义默认值与可选范围 |
| `feedback/state.json` | 反馈草稿、不可变正文/诊断快照、当前 Windows 账户加密的回执凭据、投递重试和已收到的服务端状态 |
| `cloud-maintenance/state.json`、`cloud-maintenance/outbox.json` | 签名更新/公告缓存、已读状态、自动上报授权和独立自动诊断队列；不承担反馈状态 |
| `runtime_archive/` | 数据拆分或迁移前的证据归档，不作为现役状态读取 |

各业务只能读取共享联系人或适配证据，不能读取另一业务的成功账本来决定自己的动作。迁移旧状态时先归档，再拆分；不得把朋友圈字段继续写回主动触达的 `state.json`。

计划正文和冻结素材保存在对应业务目录的 `planned_tasks/`、`planned_runs/`；接待范围保存在 `auto_reply/workflow-recipients.json`。统一界面仅投影各执行器返回的进度，不自行推测发送成功。

内容生产使用独立的 `product-detail/` 与 `content-engine/` 数据目录。前者保存产品详情图的数据库、上传、输出和缓存；后者保存素材索引、任务、成片登记和缓存设置。原始视频和图片只由素材索引记录位置、指纹、媒体信息与版权/使用权状态，始终留在用户原有磁盘位置。

`production_summary.py` 只读关联 `content_tasks`、批次、引导会话和运行记录，先按明确业务归属与重试关系归并，再分类和分页。首页及创作工作台共用该汇总口径；详情传原 `taskId`、批次/会话/运行 ID，历史候选在 SQL 的 `LIMIT` 之前按任务过滤。批次归档标记保留在原批次私有状态，已归档界面只读，不删除原任务或成片。

内容引擎数据目录中的 `provider-usage.jsonl` 是追加事件账本。`usage_scope` 传递任务、批次、运行和操作上下文；`ProviderRequest` 在真实请求前持久记录开始，随后记录结果、耗时和供应商已返回的指标。查询按 `call_id` 合并同次请求事件；未结束的请求保留 `outcome_unknown`，缺失 token/字符/音频指标保留未知，金额由供应商账单确认。请求开始记录写入失败时，不继续发起该请求；账本不作为自动重试未知结果的许可。

反馈服务与自动诊断使用不同记录与授权语义。客户端仅将用户本次确认的文字和可选白名单诊断送往 `/v1/feedback`；服务端 `feedback.py` 保存凭据摘要和幂等内容摘要，只有持有对应回执凭据才能批量查询状态。处理状态只由回环管理后台修改；诊断 30 天到期后清理附件，反馈正文、状态和幂等凭据记录继续保留。

## 数据流

```text
renderer
  -> preload 暴露的最小 IPC
  -> main 业务控制器
  -> 共享微信 adapter
  -> 微信窗口

contact_sync -> active_touch/contacts.json
DeepSeek Key -> main 进程 -> AI 文案/回复
业务结果 -> 对应业务目录，不回写共享 adapter

内容生产：素材原文件 -> content-engine 原地索引/探测 -> 课程拆条或智能混剪工作流 -> 可编辑时间线/渲染 -> 成片中心
产品详情图 -> 用户确认后登记到素材仓库 -> 后续内容工作流
```

内容分析、转码和渲染的资源队列必须与微信协调器隔离：内容任务可暂停、恢复或失败，不得占用微信 RPA 的锁，也不得阻断联系人同步、自动回复、主动触达或朋友圈计划。
