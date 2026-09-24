# T3 产品效果视频：补齐恢复路径（2026-09-24 修订）

分支：`codex/product-video-recovery`（在 T2 和 B0 合并后开始）

> **修订说明（2026-09-24）**：
> - 删除原 3c（改导演名）。负责人名单现在只有三位负责人，子角色名不再对外展示。导演字段在 B1 重做。
> - 原 3d（"旁白由视频模型生成"）被用户决策推翻，改为统一 TTS 配音加字幕，由 B3 实现。本卡不再处理旁白。
> - 原 3e（30 秒样片）移到 B6，等 B1–B3 完成后再付费验证。
> - 社媒短片由 B0 删除，本卡只针对产品效果视频。

## 背景

`ProductVideoPage` → `src/main/product-video-service.cjs`。本机数据目录中还没有 `product_video` 任务，也就是说这个模块从未真实跑过。

## 要做

### 3a `outcome_unknown` 的出口
- 现状：
  - `outcome_unknown` 不在 `RUNNING` 集合里（`product-video-service.cjs:13`）；
  - `refresh()` 不处理它（:247）；
  - `canRetry` 只对 `needs_attention` 为真（:58）；
  - 页面没有按钮（`ProductVideoPage.tsx:136-137`）。
- 参照 `digital-human-service.cjs:315-331` 的做法，新增 `verify(id)`（或扩展 `refresh`）。对 `outcome_unknown` 任务，用 `task.operations[<当前操作>].id` 查询 `/operations/{id}`：
  - 有结果：记录 `response`，恢复为 `resumeStatus` 并调度；
  - 返回 `pending` 或查询失败：保持 `outcome_unknown`，更新提示；
  - 明确被拒：转为 `needs_attention`。
- **绝不**为结果不明的请求自动重新 POST。
- 新增的 IPC 通道要走现有的发送方校验；页面对 `outcome_unknown` 显示"核对请求"按钮。

### 3b 启动后自动续跑
- 参照 `digital-human-service.cjs:356-361`：服务创建后扫描 `RUNNING` 状态的任务并 `schedule`；`close()` 时清理定时器。

## 允许改动

- `src/main/product-video-service.cjs`、`product-video-ipc.cjs`、`product-video-preload.cjs`
- `src/renderer/ProductVideoPage.tsx`（及 css）
- `src/main/product-video.self_check.cjs`

## 禁止

- 不改 `video-directors.cjs`（B1 会重做），不改数字人服务、网关客户端、内容引擎。
- 不发起任何真实 APIMart 调用。

## 验收

- `product-video.self_check.cjs` 新增：
  - `outcome_unknown` 场景：查询成功后继续；查询 pending 时保持原状态；查询被拒时转为 `needs_attention`；
  - 全程**不重复 POST**（用计数断言）；
  - 服务重建后自动续跑处于 `generating` 的任务。
- `npm.cmd run check:self`、`npm.cmd run build:test` 通过。
