# B0 实施结果

分支：`codex/remove-social-video`（基于 `codex/fix-apimart-gateway-transport`）。

## 改动

- 删除侧边导航、首页能力卡和页面路由中的“社媒短片”入口；`ProductVideoPage` 固定创建产品效果视频。
- `planVideo` 只接受 `mode: "product"`，移除社媒分镜和“叶映声”规划分支。
- 更新角色清单、480p 说明及导演 Skill 的对应文案。
- 新增回归：新建 `social` 任务被拒绝；预置旧 `social` 完成态任务仍可通过服务 API `list`、`get`、`media` 预览和 `exportVideo` 导出。

旧任务兼容依据：`product-video-service.cjs` 的 `read`、`list`、`get`、`media`、`exportVideo` 使用保存的 `task.plan` 和成片文件，不调用 `planVideo`；只有 `create` 调用 `planVideo`。本卡未修改服务和已有任务数据。

## 验证

在 `desktop/` 下执行：

| 命令 | 实际输出 |
|---|---|
| 修改生产代码前 `node src/main/product-video.self_check.cjs` | 失败：`Missing expected exception`，旧实现仍允许新建 `social` 任务。|
| 修改后 `node src/main/product-video.self_check.cjs` | `product-video self-check passed`，包含旧任务列出、读取、预览和导出。|
| `npm.cmd run build:test` | `✓ 1643 modules transformed`、`✓ built in 1.39s`、`test renderer build completed`。|
| `git grep -n -e 'social-video' -e 'mode="social"' -- desktop/src` | 无匹配。|
| `npm.cmd run check:self` | 完整运行通过，末行 `all source self-checks passed`。|
| `git diff --check` | 通过。|

## 未验证

- 未在运行中的 Electron 界面做人工视觉验收；界面构建和源码入口搜索已通过。
- 未执行真实视频生成或付费调用；旧任务兼容由本地预置任务覆盖。
- 因本分支必须从原基线拉出，B0 分支的 `check:self` 尚未包含独立 T2 分支注册的产品视频自检；已另外直接运行该自检。合并 T2 后统一自检才会自动运行它。

## 对任务卡的异议

- `desktop/src/main/skills/cleaning-video-director/rules.cjs` 仍有旧 `social` 规则，但不在 B0 允许文件内；新建任务无法走到该分支，旧任务读取不重新规划，故未越界清理。
- 删除入口后，历史 `social` 任务没有此页的可见列表入口；服务 API 的列出、读取、预览、导出能力仍在。若要求普通用户从界面直接访问旧社媒任务，需要另定入口和允许范围。
