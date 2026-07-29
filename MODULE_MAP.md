# 模块边界

本文只说明代码职责和状态归属，不记录功能是否通过验收；当前能力与验证结果只看 `PROJECT_STATUS.md`。

## 代码边界

| 区域 | 职责 | 不应承担 |
|---|---|---|
| `desktop/src/renderer/` | React 页面、用户输入、状态展示和 IPC 调用 | 直接访问微信、文件系统、明文 Key 或执行业务发送 |
| `desktop/src/main/` | Electron 生命周期、IPC、业务编排、DeepSeek、运行协调和数据目录注入 | 在页面组件中复制 RPA 逻辑；把单功能状态写进共享适配配置 |
| `desktop/rpa/contact_sync/` | 读取微信联系人并输出规范化联系人清单 | 自动回复、主动触达或朋友圈动作 |
| `desktop/rpa/active_touch/` | 微信窗口观察/发送适配、主动触达状态机及测试版朋友圈执行器 | renderer 状态管理、API Key 持久化、跨业务混用发送账本 |
| `desktop/scripts/` | self-check、renderer 构建、便携包生成和包内检查 | 保存运行数据或作为 live 验收凭证 |
| `release/` | 从源码生成的便携目录与 ZIP | 手工修改后回灌源码或作为唯一真相 |

朋友圈主进程内部继续分两层：`moments-campaign-ipc.cjs` 只编排单轮逐帖动作，`moments-daily-automation.cjs` 只管理每日目标、时间、跨日状态和下一次调度；每日层复用单轮控制器，不复制微信识别或点击逻辑。

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

| 子目录 | 权威状态 |
|---|---|
| `contact_sync/` | 联系人同步过程和诊断；同步后的规范化联系人清单写入 `active_touch/contacts.json`，供业务只读消费 |
| `active_touch/` | 主动触达任务快照、联系人清单、发送事务、结果账本和运行日志 |
| `auto_reply/` | 状态 v3、稳定消息 occurrence、exactly-once 去重、未知发送 occurrence 隔离和诊断；旧包 OCR 临时观察与频率事件不跨版本继承 |
| `moments/` | 朋友圈观察、帖子稳定标识、动作尝试、去重账本及独立的每日计划状态 |
| `wechat_adapter/` | 共享微信窗口与 adapter 配置，不含业务结果 |
| `runtime_archive/` | 数据拆分或迁移前的证据归档，不作为现役状态读取 |

各业务只能读取共享联系人或适配证据，不能读取另一业务的成功账本来决定自己的动作。迁移旧状态时先归档，再拆分；不得把朋友圈字段继续写回主动触达的 `state.json`。

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
```
