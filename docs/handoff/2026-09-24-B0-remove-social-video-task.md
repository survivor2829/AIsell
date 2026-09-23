# B0 删除"社媒短片"入口

分支：`codex/remove-social-video`（与 T1/T4/T5 文件不重叠，可并行）

## 背景

"社媒短片"是 Codex 按用户 9-23 第 4 条需求（不出镜、发社媒获取咨询、导演懂爆款）单独拆出来的入口，和"产品效果视频"共用 `ProductVideoPage` 与 `product-video-service`（`mode="social"`）。它的目标和"数字人视频"重叠，用户看了也不理解，已决定删除。"开头钩子、咨询引导"这类爆款规则以后并入数字人导演（B1），本卡不处理。

## 要做

1. 删除导航和首页入口：
   - `desktop/src/renderer/App.tsx:409`（`social-video` 导航项）
   - `desktop/src/renderer/App.tsx:912`（`<ProductVideoPage mode="social" />`）
   - `desktop/src/renderer/App.tsx:499` 的 `moduleIsAvailable` 列表中的 `"social-video"`，以及 `ModuleKey` 类型中的对应成员
   - `desktop/src/renderer/AgentHome.tsx:50,103`
2. `ProductVideoPage.tsx` 去掉 `mode` 属性和 `"social"` 分支，页面只服务产品效果视频。
3. `desktop/src/main/video-directors.cjs`：新建任务只接受 `mode: "product"`，删除 `socialShots`（:60-65）和 `叶映声` 分支（:85）。**历史 social 任务仍须能 `list`、`get`、预览和导出**：读取旧任务时不能重新调用 `planVideo` 校验 mode。在 result 中说明你是怎么保证的。
4. 当前页面不做持久化（`App.tsx:554` 使用 `useState(DEFAULT_ACTIVE_MODULE)`），所以升级后不需要迁移。如果你发现其他地方（如 AgentHome 跳转或 overview 按钮）仍能导航到 `social-video`，一并删除。
5. 更新文档：`docs/agent-roster.md:8`（删除"社媒短片"）、`docs/video-quality-480p.md:5`。
6. `desktop/src/main/skills/cleaning-video-director/SKILL.md:8` 里"叶映声·口播导演"的说法，本卡只改成"数字人口播导演"，完整重写留给 B1。

## 允许改动

上面列出的文件，以及 `product-video.self_check.cjs`、`customer-edition.self_check.cjs`（如有断言依赖这些文件）。

## 禁止

- 不删除 `product-video-*` 服务本身，也不改数字人模块。
- 不删除用户已有的 social 任务数据。

## 验收

1. `npm.cmd run build:test` 通过；导航和首页找不到"社媒短片"。
2. self_check 新增两个用例：
   - 用 `mode:"social"` 新建任务，被拒绝；
   - 一个预置的旧 social 任务能列出、读取，完成态能导出。
   - 另外用 `git grep -n "social-video\|mode=\"social\"" desktop/src` 确认没有残留。
3. `npm.cmd run check:self` 通过（在 T2 注册 product-video 自检之后）。
