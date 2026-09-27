# T10b 结果：搜索截图证据与形态特征

分支：`codex/search-capture-evidence`，从收尾基线 `09b0e55` 新建；未合并、推送或发布。

## 改了什么

- OCR 使用的原始裁剪位图在 `CopyFromScreen` 后、缩放与识别前编码为 PNG；搜索判定仍由原规则完成。仅识别失败时，CLI 将图片暂存为随机命名的本机临时文件；工作流读入内存并立即删除临时文件。仅最终跳过或熔断时，r008 护照失败记录使用这份图片，沿用每日附件上限。捕获缺失时标记 `screenshot_unavailable`，不把主窗口截图误当作下拉框。
- 将搜索证据中的逐行原文和原文 `text_hash` 改为字符数、首尾 Unicode 类别、分界标签编辑距离、三个布尔量和坐标；指纹由这些形态特征及坐标计算。保留弹窗矩形、DPI、截图来源、截图底边距离。无弹窗时证据标记 `formula_fallback`。工作流对白名单字段再次投影，图片内容和临时路径不进入任务行或护照 JSON。
- 登记原有失败码 `wechat_window_preflight_failed` 为环境类、全局关注。补弹窗/主窗口 DPI 不同及弹窗低 DPI 回退测试；补 T8 遗留的 M09、M11、M16、句柄与进程变化、微信重启、闸门内暂停测试。
- 合成联系人分区同时含“甲乙”和“甲乙丙”：真实搜索解析落到 `unique_local_surface_visual`，点击后模拟打开“甲乙丙”；一审时只回放了点击阶段的 `CONVERSATION_TITLE_SCRIPT`，没有回放发送路径的 `OBSERVE_CONVERSATION_SCRIPT`。这一缺口在下文一审返工中补齐。

## 验证命令与实际输出

- `node rpa/active_touch/wechat_search_observation.self_check.cjs`：退出码 0；输出 `search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)`、`search wrong-title send gate passed: longer conversation opened, sends=0`。弹窗 144 DPI / 主窗口 96 DPI 取 144；弹窗 DPI 0 / 主窗口 120 DPI 回退 120。序列化搜索证据不含查询词、任一 OCR 行原文或其 SHA-256；临时 PNG 字节等于模拟的 OCR 原图。
- `node src/main/wechat-workflow.self_check.cjs`：退出码 0；输出 `T8 multipart session reuse checks passed; PowerShell launches: 0`、`Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`。r008 最终跳过只生成一张护照截图，内容与 OCR PNG 字节一致，所有临时文件已清除。
- T8 审查变异脚本 `mutate.cjs mutations.json M09 M11 M16`：退出码 0；三项输出均为 `KILLED`，新增的序列断言分别抓到失焦/布局、联系人/账号变化及迟到失败后误留锚点。
- `npm.cmd run check:self`：退出码 0；输出包含 `search wrong-title send gate passed: longer conversation opened, sends=0`、`active-touch self-check passed`、`T8 multipart session reuse checks passed; PowerShell launches: 0`，末行 `all source self-checks passed`。
- `npm.cmd run build:test`：退出码 0；输出 `✓ 1643 modules transformed`、`✓ built in 1.41s`、`test renderer build completed`。

## 未验证与任务卡异议

- 未操作真实微信、测试联系人或异机，也未生成安装包或导出真实诊断包。需由用户在授权的异机验收 r008 截图是否覆盖完整下拉框、三类异常形态能否区分，以及不同 Windows DPI 的真实表现。
- CLI 与主进程之间的截图通过系统临时 PNG 传递。一审返工将写入收窄到触达工作流显式请求，详见下文；若进程恰在文件写成后、主进程读取前异常终止，临时 PNG 仍可能残留，需在异机诊断时检查。

## 一审返工（同一分支追加）

- 用 `.dev` 中生产发送路径的 `OBSERVE_CONVERSATION_SCRIPT` 实际 PowerShell 比较片段回放 UIA 标题。精确“甲乙”通过；活动标题为“甲乙丙”时，即使会话列表或聊天内容出现“甲乙”也拒绝。三个错误标题场景均穿过真实 `executeVerifiedContactSend` 的发送前核验，发送驱动调用 0 次；N23 前缀接受变异被该断言抓到。
- 截图临时文件改为触达工作流通过 `--capture-search-failure` 显式请求，普通任务循环、自动回复及开发 IPC 默认不写。普通 CLI 和 dev CLI 均接线；微信号搜索回退名字前删除上一张，工作流仍读取并删除最终失败截图。选中联系人时不写临时文件；路径仅接受系统临时目录中的随机命名 PNG。测试结束确认本轮产生的 `%TEMP%` 截图文件无残留。
- PowerShell 在 PNG 超过 5 MiB 时不附带图片，`spawnSync` 的 `maxBuffer` 提到 16 MiB。合成 1.6 MiB stdout 测试通过，不再落入 `ENOBUFS`。OCR 失败时超限图片仍可能没有护照截图，会标记 `screenshot_unavailable`。
- 补齐形态指纹、`bottom_gap`、`equals_query`、来源枚举、工作流白名单、截图字节与护照上限的定向断言。审查脚本 N03、N06、N08、N09、N10、N11、N13、N16、N21、N22、N23、N25、N26 均输出 `KILLED`，无 `SETUP-ERROR` 或 `SURVIVED`。T10a 的 resolver 判定代码未改。

验证命令与实际输出：

- `node rpa/active_touch/wechat_search_observation.self_check.cjs`：退出码 0；`search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)`、`search wrong-title send gate passed: longer conversation opened, sends=0`。
- `node src/main/wechat-workflow.self_check.cjs`：退出码 0；`T8 multipart session reuse checks passed; PowerShell launches: 0`、`Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`。
- `node src/main/task-passport.self_check.cjs`：退出码 0；`task passport self-check passed: event-only success, failure triplet, cap, bill, retention and fail-open writes`。
- `WT=<工作区> node scratch/t10b/mutate.cjs scratch/t10b/mutations.json N03 N06 N08 N09 N10 N11 N13 N16 N21 N22 N23 N25 N26`：退出码 0；13 项均 `KILLED`；末尾 `git status after` 只列本轮预期修改。N06、N08、N13 在补强断言后的单独复验也均 `KILLED`。
- `npm.cmd run build:test`：退出码 0；`✓ 1643 modules transformed`、`✓ built in 1.47s`、`test renderer build completed`。
- `npm.cmd run check:self`：最终重跑退出码 0；含 `active-touch self-check passed`、`active-touch IPC self-check passed`、`touch-task-ipc self-check passed`、`T8 multipart session reuse checks passed; PowerShell launches: 0`，末行 `all source self-checks passed`。初次运行因新增可选上下文字段破坏旧自检的对象全等断言而失败；已改为仅显式请求时传字段，最终重跑通过。

未验证：未操作真实微信、真实联系人、异机或安装包。不同微信版本的大图 OCR 和实际 r008 护照截图仍需授权的实机空跑。进程在临时图片写入后、主进程读取前被强制终止的极端窗口尚无自动回收。

任务卡异议：原卡允许改动范围未列普通/开发 CLI 与 `state_machine.cjs`，但一审明确要求各调用路径清理和微信号回退清理，因此仅为这两项接线扩展到对应文件；未改搜索判定与发送规则。
- 卡片“允许改动”列表未列规则目录，但顶部 T8 追加明确要求登记 `wechat_window_preflight_failed`；因此仅追加了 `wechat-failure-policy.cjs` 的一条分类，未改其他规则。
