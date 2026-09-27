# T7b 结果：自动回复后台观察与按需返回聊天页

- 分支：`codex/auto-reply-background-scan`；基线：`7d1daa3`。
- 工作流模式新增只读 `observe`：只用 PrintWindow 读取允许名单的未读提示与当前会话消息签名，结果仅为 `ok:false` 的空闲或需前台复核，不返回联系人、消息、签名，不修改视觉基线、待处理队列或屏幕截图偏好。候选仍进入原前台扫描、验证和发送前检查。独立测试模式不启用。
- 前台扫描按未读候选、待处理状态、窗口变化、首次 prime 或每 60 秒复核触发；周期复核要求用户空闲 5 秒。连续 3 次同窗口 PrintWindow 捕获失败后暂停观察，直到下次 prime。窗口位置变化走重新摆放，PID/HWND 变化仍走原有安全处理。
- 返回聊天页由控制器按需置位：首次接管、朋友圈 publish/interact 步骤结束、以及上次扫描出现 `visual_ocr_structure_missing`、`visual_sidebar_match_missing` 或 `wechat_chat_*`。代码里的聊天页原因包括 `wechat_chat_entry_ambiguous`、`wechat_chat_entry_not_found`、`wechat_chat_entry_not_owned`、`wechat_chat_surface_unverified`。导航成功后清标志，prime 导航同样适用。每小时汇总前台原因、观察空闲、导航、被动漏检，不逐次写诊断。
- T7a 二审遗留：首次接管等待旧扫描时的用户暂停优先于待启动；悬浮窗暂停后的回复步骤返回明确的“已暂停”提示。补了第二次退避窗口、人数变化、两种加入名单原因、退避中暂停与明确重启的断言。

## 验证

- `check:self`：完整通过，包含视觉驱动、扫描驱动、自动回复控制器、工作流与原因码规则检查。之后补充了定向断言、缺失视觉驱动的安全回退及前台原因标记；受影响的定向自检均再次通过。
- `build:test`：通过；Vite 提示现有的大于 500 kB chunk。
- T7a 审查 `probe.cjs`：P1 退避中暂停后发送 0 次；其余 P2–P5 符合预期。二审 `probe2.cjs`：Q7 接管等待中暂停，最终暂停、发送 0 次；Q1/Q2 退避暂停后发送 0 次，Q1b/Q2b 明确重启后各发送 1 次；D1 两个退避窗口各记一条，D2 排除人数 1→2 各记一条。
- 原审查 `mutate.cjs mutations.json`：M01–M31 全部被自检检出。二审 `mutations2.json`：可套用的 N05–N16 均被检出，新增断言明确检出 N06、N09、N10、N15；N01–N04 的旧替换片段因新增暂停代数和提示文本而无法匹配，脚本报 `SETUP-ERROR`，并非变异存活。变异脚本结束后源码恢复。
- 单独移除首次接管的暂停代数判断（Q7_REVERT）：新增自检从“paused”变成“running”并失败；脚本已恢复源码。
- `git diff --check` 与视觉 PowerShell 脚本解析：通过。

未操作真实微信、未发送真实消息、未发布。真实账号下的 30 分钟前台次数、已打开及未打开会话的回复延迟、最小化恢复和朋友圈返回聊天页，留待用户指定测试账号及联系人后验收。PrintWindow 落后一帧时当前会话可能等待最多约 60 秒周期复核；是否调整周期由真实验收决定。
