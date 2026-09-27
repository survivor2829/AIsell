# T10b 结果：搜索截图证据与形态特征

分支：`codex/search-capture-evidence`，从收尾基线 `09b0e55` 新建；未合并、推送或发布。

## 改了什么

- OCR 使用的原始裁剪位图在 `CopyFromScreen` 后、缩放与识别前编码为 PNG；搜索判定仍由原规则完成。仅识别失败时，CLI 将图片暂存为随机命名的本机临时文件；工作流读入内存并立即删除临时文件。仅最终跳过或熔断时，r008 护照失败记录使用这份图片，沿用每日附件上限。捕获缺失时标记 `screenshot_unavailable`，不把主窗口截图误当作下拉框。
- 将搜索证据中的逐行原文和原文 `text_hash` 改为字符数、首尾 Unicode 类别、分界标签编辑距离、三个布尔量和坐标；指纹由这些形态特征及坐标计算。保留弹窗矩形、DPI、截图来源、截图底边距离。无弹窗时证据标记 `formula_fallback`。工作流对白名单字段再次投影，图片内容和临时路径不进入任务行或护照 JSON。
- 登记原有失败码 `wechat_window_preflight_failed` 为环境类、全局关注。补弹窗/主窗口 DPI 不同及弹窗低 DPI 回退测试；补 T8 遗留的 M09、M11、M16、句柄与进程变化、微信重启、闸门内暂停测试。
- 合成联系人分区同时含“甲乙”和“甲乙丙”：真实搜索解析落到 `unique_local_surface_visual`，点击后模拟打开“甲乙丙”；重放正式会话标题脚本的核对分支并接入真实 `executeVerifiedContactSend`，结果在发前被拦，发送驱动调用 **0** 次。正式脚本的精确“甲乙”对照用例通过。

## 验证命令与实际输出

- `node rpa/active_touch/wechat_search_observation.self_check.cjs`：退出码 0；输出 `search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)`、`search wrong-title send gate passed: longer conversation opened, sends=0`。弹窗 144 DPI / 主窗口 96 DPI 取 144；弹窗 DPI 0 / 主窗口 120 DPI 回退 120。序列化搜索证据不含查询词、任一 OCR 行原文或其 SHA-256；临时 PNG 字节等于模拟的 OCR 原图。
- `node src/main/wechat-workflow.self_check.cjs`：退出码 0；输出 `T8 multipart session reuse checks passed; PowerShell launches: 0`、`Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`。r008 最终跳过只生成一张护照截图，内容与 OCR PNG 字节一致，所有临时文件已清除。
- T8 审查变异脚本 `mutate.cjs mutations.json M09 M11 M16`：退出码 0；三项输出均为 `KILLED`，新增的序列断言分别抓到失焦/布局、联系人/账号变化及迟到失败后误留锚点。
- `npm.cmd run check:self`：退出码 0；输出包含 `search wrong-title send gate passed: longer conversation opened, sends=0`、`active-touch self-check passed`、`T8 multipart session reuse checks passed; PowerShell launches: 0`，末行 `all source self-checks passed`。
- `npm.cmd run build:test`：退出码 0；输出 `✓ 1643 modules transformed`、`✓ built in 1.41s`、`test renderer build completed`。

## 未验证与任务卡异议

- 未操作真实微信、测试联系人或异机，也未生成安装包或导出真实诊断包。需由用户在授权的异机验收 r008 截图是否覆盖完整下拉框、三类异常形态能否区分，以及不同 Windows DPI 的真实表现。
- CLI 与主进程之间的截图通过系统临时 PNG 传递；正常步骤结束后立即删除。若进程恰在文件写成后、主进程读取前异常终止，临时 PNG 可能残留，需在异机诊断时检查并清理。这个限制来自任务卡只允许改搜索驱动、工作流和护照文件，无法在执行器 IPC 中直接传二进制。
- 卡片“允许改动”列表未列规则目录，但顶部 T8 追加明确要求登记 `wechat_window_preflight_failed`；因此仅追加了 `wechat-failure-policy.cjs` 的一条分类，未改其他规则。
