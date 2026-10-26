# SPEC：统一口号 · 静默更新 · 账号中心 · 一键分发 · 关键词获客 · 养号

## Context
网关部署和发布推迟，等爆款流水线收尾后再一起跑 CI/CD。这期间做以下几件事：

1. 品牌口号统一成「生素材 · 引客户 · 促成交」。
2. 打开软件即静默更新。
3. 把「精准获客」下的「企微助手」改成「关键词获客」。
4. 新增「养号」。
5. 新增「一键分发」板块，放在成片中心上方。

功能原理参考了桌面上两款竞品：ai-auto「AI超级员工」和 dt-ai-helper「谷小智AI员工」。只借鉴原理，不复制它们的代码。

**两款竞品的共同原理：**
- 用浏览器自动化操作各平台的**官方网页**，每个账号有独立的登录态。
- 读取页面自身请求返回的 JSON，拿到评论和用户信息。
- 用页面点击来完成私信、关注、点赞、上传。
- 没有私有签名接口，没有 ADB，也不用手机。

**用户已确认：**
- 打开软件即静默更新。
- 关键词获客第一期做抖音和快手，动作包括自动私信、自动回复评论、留痕（点赞、关注、收藏）。
- 养号按 8 天阶段计划做。
- 一键分发做抖音、快手、视频号、小红书四个平台。
- 每个平台支持多个账号。
- 话术用「模板随机 + AI 扩写」。
- 真机测试用用户提供的专用测试号，发送对象只限我们自己的号。

## 总体技术路线（推荐，沿用现有模式）
- **浏览器**：复用 Electron `BrowserWindow`，加上按账号区分的 `session.fromPartition('persist:social-<platform>-<accountId>')`。参照 `desktop/src/main/viral-scout.cjs:111-170`：隐藏窗口，用 `webContents.debugger` 的 `Network.getResponseBody` 读页面自身的响应。
  - 不额外打包 Chrome 或 patchright，安装包不变大。
  - 窗口隐藏，靠 `sendInputEvent` 和页面脚本操作，不占用真实鼠标键盘，可以和微信 RPA 同时跑。
- **复用现有代码**：
  - `douyin-browser-adapter.cjs`：只消费官方页面的响应，不重放私有接口，不把 token 读进应用。它的 `parsePageResponse`/`inspectPage` 已经能解析评论、视频和验证码。
  - `keyword-acquisition.cjs`：已有任务、线索和 attempts 账本，崩溃后转成 `outcome_unknown`，不自动重发。另有意向词正则。
  - `KeywordAcquisitionPage.tsx`：已渲染在 `App.tsx:967`，但导航里没有入口。
- **统一的「平台任务队列」**（新文件 `social-task-queue.cjs`）：
  - 分发、获客、养号三种任务共用一个队列。同一账号同一时刻只跑一个任务；不同账号可以并行，默认并发上限是 2。
  - 每账号每天的动作上限和随机间隔集中配置。
  - 遇到验证码、登录失效或「操作频繁」时，暂停该账号并提示用户手动处理。**不自动过验证码。**
- **AI 扩写**：复用现有写稿额度和网关接口。只有用户点了扩写才花额度，平时随机挑选模板，不花钱。

## 分阶段实施（每阶段一个短分支、一个 PR）

### P0 口号统一（小）
- `AgentOverview.tsx:23`：主页标题「做视频 · 聊客户 · 出美图」改为「生素材 · 引客户 · 促成交」。
- `App.tsx:837`：侧边栏已经是这句，保持不变。
- 登录页 `LoginScreen.tsx` 品牌名下方加上口号。这里就是用户说的「封面」。
- 文档 `docs/handoff/2026-10-07-ui-product-closeout.md:5` 写的是「变成交」，改成「促成交」。
- 安装包和可执行文件名**不改**，因为更新助手依赖 `AI获客 V1.0版本-测试版.exe` 这个路径。

### P1 打开即静默更新
现状：
- `cloud-maintenance.cjs:430` 启动时检查一次，之后每 6 小时检查一次。
- 安装要用户点「立即更新」（`CustomerTools.tsx:88-118`）。
- 已有 `installOnExit`（`main.cjs:1044`）。

改动：
- 检查到新版本就自动下载并校验。
- 没有微信或视频任务在跑（复用现有 hold 判定 `global.__xiaoxiUpdateHold`），而且用户约 2 分钟没操作时，自动走 helper 换组件并重启。否则等到退出时用 `installOnExit` 安装。
- 顶栏显示「已自动更新到 x.y.z」，原来的手动按钮保留。
- 新版启动失败时按现有健康 ACK 回滚。

### P2 平台账号中心（P3–P5 的基础）
- 把 `App.tsx:1153` 的静态 `AccountManagement` 改成真实页面：
  - 四个平台各自可以「添加账号」，弹出可见的登录窗口让用户扫码。
  - 登录后通过页面响应识别出账号的 id 和昵称，落盘到 `social_accounts/state.json`，只存 id、昵称、平台和 partition 名，**不存 cookie**，cookie 由 Electron 分区保存。
  - 支持多账号、状态检测（已登录或失效）和删除，删除时清空对应分区。
- 新建主进程模块 `social-accounts.cjs`、`social-accounts-ipc.cjs` 和 preload，并在 `MODULE_MAP.md` 登记。

### P3 一键分发（侧边栏「成片中心」上方的新入口）
- 从成片中心选视频（多选），勾选平台和账号，填写：
  - 标题、描述、话题（可以统一填，也可以逐条填，可用 AI 生成标题文案）；
  - 发布时间：立即、指定时间，或每天某个时间分批发。
- 各平台的上传驱动 `publish-<platform>.cjs` 在隐藏窗口里打开创作者后台：
  - 用 `webContents.debugger` 的 `DOM.setFileInputFiles` 选择文件；
  - 填写标题和话题；
  - 等待上传完成，点击发布；
  - 再从「作品管理」页的响应确认作品已经存在，才记为 `published_verified`。
- 结果账本沿用 prepared、clicked、outcome_unknown、verified 四态。状态不明时**不重发**，提示用户去后台核对。
- 每账号每天的发布上限默认 10 条，可以调。
- 入口加在 `App.tsx:881` 成片中心按钮上方，成片中心的视频卡片上也加「分发」按钮。

### P4 关键词获客（替换精准获客 → 企微助手）
- `BusinessAssistantPage.tsx:13-18` 的企微助手条目改为「关键词获客」，`available: true`，内嵌 `KeywordAcquisitionPage`。
- 页面扩展为三部分：任务配置、线索列表（可导出）、动作记录。任务配置包括：
  - 平台（抖音或快手）和账号；
  - 搜索关键词（最多 30 个）、排序方式、每条视频读取多少评论；
  - 意向词、评论时间范围（1 天、7 天、30 天）、IP 地区、跳过作者自己的评论、昵称黑名单；
  - 动作：私信、回复评论、留痕（点赞、关注、收藏），每种动作有单独开关；
  - 话术模板（可 AI 扩写）、每日上限、随机间隔、每天开始时间。
- 流程：搜索 → 滚动结果 → 逐条打开视频 → 读取评论接口的响应 → 过滤 → 去重（全局记录已触达用户）→ 按开关执行动作 → 写账本。
- 快手新增 `kuaishou-browser-adapter.cjs`，和抖音的适配器同构。
- 默认上限（偏保守，可调）：
  - 每账号每天私信 30 条、回复评论 30 条、关注 20 个；
  - 两次动作之间随机等待 45–180 秒；
  - 遇到「频繁」提示，该账号停到第二天。

### P5 养号（抖音，8 天阶段计划）
- 「养号」页放在精准获客下，归入账号中心的账号。
- 每个计划包含：账号、行业关键词、评论模板（可 AI 扩写）、测试视频（可选）、每天开始时间。
- 阶段参数照竞品，存在 `social-nurture-plan.cjs` 的常量表里，界面可以微调：

| 天数 | 阶段 | 每天几段 × 每段时长 | 互动 |
|---|---|---|---|
| D1 | 纯浏览 | 2 × 15–20 分钟 | 每条看 5–15 秒，不搜索 |
| D2–3 | 打标签 | 3 × 13–17 分钟 | 开始搜索关键词；每 5–10 条点一个赞，每天 15–20 个；每天关注 3–4 个 |
| D4–5 | 中度互动 | 3 × 15–20 分钟 | 每 10–15 条评论一次，逐字输入 |
| D6–7 | 强化 | 3 × 20–25 分钟 | 每天点赞 25–30 个、评论 5–6 条；看直播 10–15 分钟 |
| D8 | 测试发布 | — | 调用 P3 的发布驱动，发布测试视频 |

- 进度和每天的计数按账号落盘，界面显示「第 N 天 / 今日已赞 x / 评 y」。
- 和获客、分发共用 P2 的队列，同一账号同一时间只跑一件事。

## 不做或明确边界
- 不读取微信数据库密钥（竞品有这一功能），不自动过验证码，不用代理或指纹伪装。
- 企业微信本身这期不做，只是把这个入口换成关键词获客。
- 所有真实的私信、评论、发布，只用用户提供的测试号，发给我们自己的号。每次真机测试前按动作和对象单独确认。

## 关键文件
- 修改：
  - `desktop/src/renderer/AgentOverview.tsx`、`LoginScreen.tsx`、`App.tsx`（导航和 AccountManagement）、`BusinessAssistantPage.tsx`、`KeywordAcquisitionPage.tsx`、`CustomerTools.tsx`
  - `desktop/src/main/cloud-maintenance.cjs`、`main.cjs`、`keyword-acquisition.cjs`、`douyin-browser-adapter.cjs`
- 新增：
  - 主进程：`social-accounts*.cjs`、`social-task-queue.cjs`、`publish-{douyin,kuaishou,channels,xhs}.cjs`、`kuaishou-browser-adapter.cjs`、`social-nurture*.cjs`
  - 界面：`DistributionPage.tsx`、`NurturePage.tsx`
  - 每个新模块配一个 `*.self_check.cjs`，并登记到 `scripts/self-check-groups.cjs`
- 文档：`MODULE_MAP.md`、`PROJECT_STATUS.md`、失败码和规则目录（`wechat-failure-policy.cjs` 同类机制，或新建 social 的失败码表）

## 验证
- **每阶段**：`npm.cmd run build:test`，跑相关模块的自检。
- **页面解析**：用保存下来的真实页面响应和 DOM 快照做离线回放（参照 `douyin-browser-adapter` 现有的纯函数测试方式），覆盖以下几类：
  - 正常；
  - 需要登录；
  - 出现验证码；
  - 提示频繁；
  - 上传失败；
  - 发布后状态不明，必须不重发。
- **队列**：上限、去重、同账号互斥、崩溃后变为 `outcome_unknown`。
- **静默更新**：本地起一个假的组件源，覆盖三种情况：
  - 空闲时自动重启；
  - 有任务在跑时等到退出才装；
  - 新版启动失败时回滚。
- **真机验收**（用户授权后）：
  - 测试号扫码登录；
  - 分发一条视频到四个平台，在后台核对；
  - 关键词获客给自己的另一个号私信和回复一次；
  - 养号跑完 D1 的一段。
- CI 通过且审查通过后按长期授权合并。发布仍然等爆款流水线收尾后统一进行。

## 建议顺序
P0 → P1 → P2 → P3 → P4 → P5。P0 和 P1 很小，可以先合并。P2 是后面三项的基础。
