# T11【中】导航调整：短视频获客排第一，精准获客下新增"同城精准获客"入口

分支：`codex/adjust-nav-order`，从最新基线拉出。排在 T5、T10a 之后做。

## 目标（用户 2026-09-24 确定）

- 一级板块的顺序改为：**短视频获客 → 精准获客 → 微信拓客 → 素材仓库**。吐槽中心仍放在底部的系统区。
- 精准获客是一个大模块，下面的子模块依次为：**同城精准获客（新增，只做入口）→ 关键词获客 → 产品详情图**。
- 同城精准获客和关键词获客的逻辑不同，功能以后单独规划。本卡只加入口：不做功能，不调用任何接口。

## 要做

1. `desktop/src/renderer/App.tsx`
   - `navGroups` 的顺序改为 production、operations、agent。
   - 在 `operationsChildren` 最前面加一项：`{ key: "local-acquisition", label: "同城精准获客", icon: MapPin }`。
   - 新的 key 不要加进 `moduleIsAvailable`。这样侧边栏会显示"下一阶段"，点进去显示现有的 `Placeholder`。
   - 品牌副标题"找客户 · 做内容 · 接咨询"改成"做内容 · 找客户 · 接咨询"，和新顺序对应。
2. `desktop/src/renderer/AgentHome.tsx`
   - `AgentHomeTarget` 增加 `"local-acquisition"`。
   - 精准获客角色页的能力卡片，最前面加一张"同城精准获客"：说明文字写"按城市和区域找附近的客户"，设 `available: false`。
   - `primaryTarget` 仍然是关键词获客。
3. `desktop/src/renderer/AgentOverview.tsx`：首页三位负责人按短视频获客、精准获客、微信拓客的顺序排列。
4. 其他写死了三大板块顺序的地方（如果有），一并调整，并在结果文件里列出来。

## 不改

- 现有模块的 key、页面内容，角色的名字、形象，用户已保存的偏好。
- 主进程、IPC，以及任何获客、发送逻辑。

## 验收

1. `npm.cmd run build:test` 和 `npm.cmd run check:self` 都通过。
2. 如果有自检或快照断言了旧顺序，同步更新，并在结果文件里写明。
3. 能运行开发版的话，附截图，核对以下几点。不能运行的话写明"未做人工核对"，由 Claude 来核对。
   - 侧边栏的一级顺序；
   - 精准获客展开后，三个子项的顺序和"下一阶段"标记；
   - 点"同城精准获客"只显示"下一阶段开放"，不发出任何请求；
   - 首页的顺序；
   - 原有各模块照常能打开。

## 结果

分支：`codex/adjust-nav-order`，从 `76bade0` 拉出；未合并、未推送、未发布。

- `desktop/src/renderer/App.tsx`：一级导航改为短视频获客、精准获客、微信拓客，素材仓库仍随后显示；精准获客子项最前增加“同城精准获客”。新 key 未加入 `moduleIsAvailable`，点击只进入现有“下一阶段开放”占位页；品牌副标题同步改序。
- `desktop/src/renderer/AgentHome.tsx`：增加目标类型和禁用的同城精准获客能力卡，说明为“按城市和区域找附近的客户”；主按钮仍进入关键词获客。
- `desktop/src/renderer/AgentOverview.tsx`：三位负责人改为短视频获客、精准获客、微信拓客；额外找到写死旧顺序的首页标题，一并改为“做内容、找客户、接咨询”。未发现其他写死三大板块顺序的地方，也没有需更新的旧顺序自检或快照。

验证：在 `desktop/` 执行 `npm.cmd run build:test`，退出码 0，末行 `test renderer build completed`；执行 `npm.cmd run check:self`，退出码 0，末行 `all source self-checks passed`，其中 `WeChat failure policy review passed: every added literal reason is classified`；`git diff --check` 退出码 0（仅 LF/CRLF 提示）。代码检查确认新入口没有页面组件、请求或 IPC 调用，侧边栏使用现有 Placeholder。

未验证：未启动开发版进行人工界面核对，因此无截图；侧边栏与首页视觉顺序、点击占位页及旧模块打开情况由 Claude 在审查环境核对。未操作真实微信、未做安装包验收。对任务卡无异议。
