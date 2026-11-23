# AI 看图（微信之眼）交接 · 2026-11-21

接手先读「结论」。本页记录的任务已在 1.3.51 完成，剩下的收尾见结论。

## 目标与原则（用户定）

- 微信相关的识别失败，改为"AI 看图兜底"：规则认不出时，把截图交给视觉模型，**AI 只负责读，代码负责判**。名字或微信号要完全一致、只能唯一一行，点击前后画面要一致，AI 拿不准就照原来的做法跳过。
- 原则是 **more intelligence, less structure**：只往提示词里写真实常识，不按机型、缩放写死规则。
- **要适应不同电脑**：现场有 100/125/150/200/225/300% 缩放，约四成失败出在 200%/225%。坐标一律用"截图内的相对位置 × 截图在屏幕上的物理像素范围"换算，不用固定比例。**每种缩放都要单独回放验证**。
- 范围不只是精准触达，**自动回复、朋友圈、抖音/小红书养号**也要接，要做就做完整。
- 隐私：用户同意把截图（含联系人名字）发给阿里云百炼的 qwen3-vl-plus。费用约每次 0.2 分，可以接受。

## 结论（2026-11-22，本页任务已完成）

- **1.3.51 已发布**（test 频道，提交 b12c8b46，PR #319 #320，读回验签通过）。内容：触达 AI 标题核对与指纹取在标题处、小玺避让、搜一搜侧边栏边界；自动回复聊天列表边界从画面量、OCR 按缩放校准；朋友圈恢复打开走侧边栏、200% 菜单去重；抖音养号第一轮修正；快捷方式自修；登录页「获客」变红。开发机 200% 完整触达与 100% AI 标题核对各发 1 条 sent_verified。
- 用户 11-22 定：方向改为"不写死坐标、找特征元素、OCR 前按窗口和缩放校准"；视觉调用不设上限；报告截图范围保持现状。
- **PR #321 未发版**：抖音测试号实测后的修正（搜索重试、按播放器确认打开、关注只认可见「+」、评论等加载、遇验证返回 verification）。实测关注 2 次成功；评论被抖音短信验证拦下未发出，**评论真实发送尚未验证**。
- 发版后要看：90bd8730、b070e34b（图片粘贴/发送按钮被挡）、8a275cd0、c19d34bf（会话变了）、cfe8221b（shortcut_*），以及 vision_title_* 结果码。

以下为 2026-11-21 交接时的原文。

## 当前状态（11-21 原文）

- **1.3.50 已发布**（test 频道，提交 909a1460，读回验签通过）。内容是场景视频更真实，以及混剪素材栏铺满。发布时把增量底座换成了 `D:/OpenAI/ReleaseBases/xiaoxi-1.3.49-5576bab`，以后照常用 `release:sop`。
- **分支 `claude/update-failure-report`**（从 main 909a1460 拉出，未开 PR，未发版）：
  - `0111956c` **更新失败自动上报**：更新助手失败后，下次启动上报 `update.helper_failed`，包括阶段、错误码、系统调用、路径形态和代码行号。新增 `update-failure-report.cjs`，自检通过。
  - `e5e38d8d` / `2c0f43fe` / `ece44a7e` **搜索下拉框的 AI 兜底**：
    - `desktop/src/main/wechat-vision-check.cjs`：负责提问和比对规则，自检通过。
    - `rpa/active_touch/state_machine.dev.cjs` 里的 `visionRescueSearch`：规则判 not_found 或 identity_unverified 后，用弹窗截图问 AI；AI 认出一行后，带 `--vision-point x,y,sha,文件名` 重跑一次搜索点击。
    - `wechat_window_driver.cjs` 里的 `visionResolution`：新截图从面板顶部到目标那一行要逐像素一致才会点。比较用 `png_pixels.cjs`，和 ffmpeg 对过，0 差异。
    - `main.cjs` 和 `touch-task-ipc.cjs`：通过 `visionRescue` 把能力注入发送执行器。
  - 真机验证：开发机，只对授权的测试联系人。规则强制失败后，第 5 次 AI 兜底 → 面板一致 → 点击 → 标题核对 → `sent_verified`，实际只发出 1 条。
- 离线回放：30 张现场下拉框（大部分是 100%）。真下拉框里 10 张有目标人，AI 能救回约一半，误点 0 次。中位耗时 4.6 秒，偶尔 60 秒超时（运行时上限 20 秒）。`qwen3-vl-flash` 在网关返回 404，没开通。

## 下一步（按收益排序，每步先回放再真机）

1. **抽一个通用的"微信之眼"**：把 `wechat-vision-check.cjs` 扩成多种提问（下拉框行、聊天标题、输入框位置、发送前后画面、朋友圈按钮）。共用同一套"读 → 代码判 → 截图一致"的规则。
2. **精准触达补三处**：
   - 点开后的标题核对（`search_result_not_opened`，现场 9648 次，最大）。规则判标题不对时，让 AI 读标题栏，代码逐字比对，标题栏截图前后一致才算数。涉及三处：`state_machine.cjs` 的 `clickSearchResultDryRun` 标题核对、发送前会话核对 `verifyRealSendSessionAsync`、点发送前的核对（`sendReal` 用的 sessionDriver）。
   - 找输入框（`message_input_target_not_owned`，2451 次。200% 笔记本重新登录后输入框变矮）。
   - 发送前后确认画面（`atomic_conversation_changed`、`send_point_obscured`、`image_paste_not_accepted`）。
3. **自动回复**：发送前让 AI 确认当前打开的聊天和最新一条消息。代码在 `wechat_auto_reply_visual_*`。
4. **朋友圈 / 养号**：找点赞、评论按钮，确认操作生效（`nurture_element_missing` 143 次、`nurture_action_unconfirmed` 126 次）。代码在 `moments_*`、`social-*`。
5. **按缩放回放**：从 `D:/OpenAI/field-reports/capsules/*/attachments/passport-*-screen.png` 按 `environment.displays[0].scale` 分组，每组至少 10 张，人工标注后对比。开发机要调成 200% 真机测之前，**先问用户**。
6. 全部完成后：独立审查 → PR → CI → 合并 → `release:sop` 发 1.3.51。客户公告写成大白话。

## 测试方法（临时开关只放本地，绝不提交）

- **离线回放**：在 `main.cjs` 里 `waitForProviderSession` 前，临时加一个 `XIAOXI_VISION_REPLAY_DIR` 钩子。等网关就绪后，对目录里的 `index.json` 和图片逐张调用 `readSearch`，结果写成 json。开发版要先点"登录"，网关才会就绪。
- **真机**：
  - 在驱动里临时加 `XIAOXI_FORCE_VISION_RESCUE=1`，把规则结果强制改成 not_found。
  - 在 `main.cjs` 里加 `XIAOXI_VISION_LIVE_TEST` 钩子：从 `%APPDATA%/xiaoxi-active-touch-test/data/active_touch/contacts.json` 取授权测试联系人那条记录（名字见本机记忆，不写进仓库）（要带 `wechatAccountId`），调用 `internalRealSend.executeVerifiedContactSend`。`runStep` 用 `runActiveTouch(..., { development: true, dataDir })`，点击步骤要加 `--capture-search-failure`。
  - 测完删掉钩子，用 `git diff` 确认没有残留。
- **授权**：用户 2026-11-21 授权的范围是：开发机，只对授权的测试联系人，每次发一条。其他联系人、其他动作需要另外取得授权。

## 踩过的坑（别再踩）

- AI 会把"搜索网络结果"（左边是放大镜、没有头像）和面板后面露出来的聊天列表读成联系人。已要求 AI 输出 `avatar` 和 `in_panel` 两个字段，代码只认在面板里、有头像的行。
- 同一个人会同时出现在「最常使用」「聊天记录」「搜索网络结果」里，只有另一个联系人或群同名才算重名。
- 下拉框边缘的阴影会透出后面的窗口，所以不能比整张图，只比面板中间那一段。
- AI 会读错字（形近字）、漏数字（少一位）。完全一致加上唯一，可以把这些都挡成"不点"。按微信号搜时只认微信号；小字是「昵称」的不算微信号。
- 在 heredoc 里写补丁时，正则的反斜杠会被吃掉（`\.png` 变成 `.png`）。改正则用 Edit 工具。

## 其他未结事项

- **47d2578f**：更新到 1.3.49 完整包时，在"备份业务数据"这一步报 EPERM，根因未定。已让用户请客户从官网覆盖安装 1.3.49，安装包保留数据，启动器会自动改用新版本。**cfe8221b** 掉回了 1.3.0 底座，同样处理。客户装好后，用 `issues:pull` 复查。
- 场景视频：DZ95X 去油污镜头转弯时会留下一圈淡印，等用户决定要不要改成直线压过去。
- APIMart 出站节点 2026-12-06 到期，要提醒续费。
