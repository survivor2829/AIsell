# T9a 诊断分析脚本 + 异机采集工具修正（开发者工具，不进安装包）

分支：`codex/diagnostics-analyzer`

- **在 T2 合并后开始**：T2、C1、B1a、B4b、B5c、B5d 和本卡都往 `desktop/scripts/run-self-checks.cjs` 追加条目；只是追加，冲突按合并顺序 rebase。
- 不改任何产品代码（`desktop/src/`、`desktop/rpa/`），与 T1、T3–T8、B0 没有文件重叠。
- 计划表里 T9 列的 `touch-workflow.cjs:152,171`（run-bill 规则号）已归 T5 第 5 项，本卡和 T9b 都不做。
- T9b 在本卡合并后开始，会扩展本卡的脚本。
- 给测试人员的一页指引 `docs/testing/wechat-remote-loop.md` 由 Claude 写，不在本卡。

## 背景

- 9-23 包的统计（wechat-logs 报告）是临时手写 `unzip -p | node -e` 算出来的，每轮异机复验都得重写一遍。需要一个固定脚本：直接读导出的 zip，不解压到磁盘，输出 Markdown 时间线。它是"异机日志 → 根因 → 修复 → 复验"循环的标准入口。
- 远程采集工具 `tools/remote-diagnostics/Collect-Diagnostics.ps1` 在异机上基本无效，还会带出联系人名（见现状）。

## 现状（HEAD 258e37a，已逐条核对）

**诊断包结构**（`desktop/src/main/diagnostics-ipc.cjs:283-328`）：
- zip 根目录是 `diagnostics.jsonl` 和 `.1`…`.5`。轮转常量在 `desktop/src/main/diagnostics.cjs:9-10`，轮转逻辑在 `:205-214`：5 MB × 6 份。
- `auto_reply/auto-reply-diagnostics.jsonl*`、`failure-evidence/<id>.json|png`、`summary.json`。
- `task-passports/<module>/<task>-<i>/`：`events.jsonl`，以及成组的 `<时间戳>-<id>-expected.json`、`-raw-reading.json`、`-screen.png`（未脱敏截图）。
- `task-passports/active_touch/bills/<run_id>/run-bill.json|txt`。json 的结构是 `summary.{total,success,skipped,failed}`、`reason_counts`、`rule_counts`、`result_code_counts`、`failures[]`。

**日志行格式**：
- 每行 `{v, ts, run_id, seq, level, module, event, trace_id?, parent_trace_id?, phase?, code?, duration_ms?, details}`。
- `seq` 只在同一个 run 内递增。文件名顺序不等于时间顺序，排序口径见"要做"第 1 步。

**联系人级链路**：
- `active_touch` 的 `workflow_contact_send.started|finished|failed`，加上同一 trace 下的 `send_stage` 行。`send_stage` 的 `details.stage` 是步骤名；finish 行带 `details.elapsed_ms` 和 `details.ok`。
- `wechat_adapter/executor.*` 通过 `parent_trace_id` 挂在联系人 trace 下。
- 失败行的 `code` 是原因码，`details.rule_id` 是规则号。

**队列事件**（都在 `desktop/src/main/wechat-workflow.cjs`）：
- 全局停机 `task.global_stop`（:424）；
- 未知原因 `classification.unknown_reason_paused`（:126）；
- 重新加入 `touch.skipped_requeued`（:738），`details.retried_count` / `excluded_count` 是人数；
- 启动 `start.started`（:856）。

**其他**：
- `task_id` 在日志里是 `{present,length,sha256_16}`（被 `diagnostics.cjs:103-109` 摘要化），只能靠 `sha256_16` 区分任务。
- `summary.json` 里 `diagnostics.environment.app.edition` 也被摘要化了，版本类型要读明文的 `build.edition`。
- `jszip` 已是 `desktop/package.json` 依赖。
- 打包只复制 `rpa`、`src/main`、`src/shared`（`desktop/scripts/build-portable-release.cjs:162`），所以 `desktop/scripts/` 不会进安装包。

**`Collect-Diagnostics.ps1` 的问题**：
- `:12` 把数据根写死为 `%APPDATA%\xiaoxi-active-touch-delivery\data`。异机跑的是 development 版（9-23 `summary.json` 中 `build.edition = "development"`），数据在 `%APPDATA%\xiaoxi-active-touch-test\data`（`main.cjs:211-214`、`bootstrap.cjs:22-23`）。所以在异机上收不到任何东西。
- 从来不收 `data\logs\diagnostics.jsonl*`。自动回复日志只收当前文件，不收轮转文件（:19）。
- 隐私问题：
  - 复制 `contacts.json`（含同步的联系人名，:21）和 `auto-reply-state.json`（:20）；
  - 记录 `mainWindowTitle`（:59、:75）、`computerName` / `userName`（:96-97）；
  - 记录绝对路径：进程 `path`（:61、:76）、`dataRoot`（:106、README :121），以及缺失文件的完整路径 `missingFiles`（:29 写入，:108、README :127 输出，路径里带 Windows 用户名）。

  数据根修正后，这些内容会真的从异机带出来，所以必须一并去掉。
- 打包方式：
  - 先把文件复制到桌面的中间目录再压缩（:10、:14、:135），中间目录不删，未压缩的副本一直留在桌面。
  - 本机是 PowerShell 5.1 + `Microsoft.PowerShell.Archive` 1.0.1.0。这个旧版的 `Compress-Archive` 已知会给子目录条目写反斜杠，JSZip 读出来就成了 `auto_reply\auto-reply-diagnostics.jsonl` 这样的根目录文件名。验收里用"条目名不含 `\`"把关。
- 源码是纯 ASCII：中文产品名和文件名用 `[char]` 码拼出来（:66、:83）。第 1 行的注释说的是文件名，不是编码。

## 要做

### 1. 新增 `desktop/scripts/analyze-diagnostics.cjs`

**用法**：`node scripts/analyze-diagnostics.cjs <zip> [<zip>…] [--examples N]`，Markdown 输出到 stdout。传多个 zip 时按 (run_id, seq) 去重合并，用来拼接同一台机器的多次导出。

**只读**：
- 用 `JSZip.loadAsync(fs.readFileSync(zip))` 读取，逐条目 `async("string")`；
- 不解压，不写任何文件，不建临时目录；
- 不打开 `*.png`、`failure-evidence/*`、`*raw-reading.json`、`*expected.json`、`task-passports/**/events.jsonl`。

**读取范围**：
- `diagnostics.jsonl*`
- `auto_reply/auto-reply-diagnostics.jsonl*`
- `task-passports/*/bills/*/run-bill.json`
- `summary.json`
- 第 2 步采集工具生成的 `environment.json`（如有）

**口径**：
- 排序：同一 run 内按 `seq`；不同 run 之间按各自首行 `ts`，不按 run_id 字典序。
- 时间一律按 UTC+8 手工格式化，不依赖本机时区。
- 分位数用最近秩：排序后取下标 `round(q·(n−1))`。
- 条目名里的 `\` 先当作 `/` 处理，兼容旧采集工具生成的包。

**输出章节**：
1. **包概况**
   - summary 中的 `build.edition`、`build.buildId`、`environment.app.version`，以及 `environment.displays`（分辨率和 `scale_factor`）；
   - run_id 列表，每个 run 的 seq 范围；
   - 首末时间和覆盖小时数；
   - 总行数、各 level 行数、`send_stage` 行占比；
   - 首个 seq > 1 时注明"本 run 前 N 行已被轮转覆盖"。
2. **活跃时段**
   - 以 `workflow_contact_send.*` 事件间隔 > 2 分钟切段；
   - 每段给出：起止时间、分钟数、尝试数、`sent_verified` 数、各 rule_id 的失败数、任务哈希前缀；
   - 最后给出合计分钟数，以及平均每个 `sent_verified` 联系人耗时多少秒。
3. **发送状态**
   - 对 `workflow_contact_send.finished|failed`，按 `details.outcome`、`side_effect`、`send_attempted` 计数；
   - `outcome_unknown` 即使为 0 也要单列。
4. **原因与规则**
   - 失败行按 `code` 和 `details.rule_id` 计数；
   - `task.global_stop` 按原因计数；
   - `executor.failed` 按 code 计数。
5. **连续失败**
   - 把全部 `workflow_contact_send.finished|failed` 按上面的顺序排开，遇到成功或换了 rule_id（没有 rule_id 时用 code）就断开；
   - 给出每个 rule_id 的最长连续串；
   - 串长分布：1、2–4、5–9、≥10。
6. **步骤耗时**
   - `send_stage` 的 finish 行按 `details.stage` × 成功/失败，给出 n、p50、p90、max、累计分钟；
   - `workflow_contact_send.finished` 的 `duration_ms`；
   - `executor.*` 按 `details.action` 统计。
7. **全局暂停与恢复**
   - 逐条列出 `task.global_stop`：时间、原因、任务哈希前缀，以及到下一次 `start.started` 的秒数；
   - `classification.unknown_reason_paused` 的次数；
   - 逐条列出 `touch.skipped_requeued`：重新加入人数、排除人数，以及距上一次联系人发送结束的等待时长。
8. **人工操作**
   - `start.started` 次数，按 `start.finished` 的 `details.status` 分列；重新加入次数；
   - 暂停、继续、关窗目前没有主日志，由 T9b 补上后再加入本章节；
   - 在那之前，列出 `auto_reply` 日志里的 `paused` 事件（按 code：`workflow_paused`、`app_closed`、`workflow_takeover`）及时间，标注"间接证据"。
9. **trace 链**
   - 联系人 trace 总数，带 `parent_trace_id` 的 executor 子链数；
   - 列出前 N 个失败联系人样例（默认 10）：时间、trace 前 8 位、code/rule_id、步骤序列（用 `>` 连接各 `stage:phase`）。
10. **run-bill**
    - 每份的 `summary.{total,success,skipped,failed}`、`reason_counts`、`rule_counts`；
    - `rule_counts` 为空时写"无规则号（T5 之前的构建）"；
    - 不输出 `failures[]` 的内容。
11. **自动回复**
    - `auto_reply` 日志按 event/code 计数；
    - 主日志里的 `reply.*` 按 code 计数。

**隐私**：
- 只输出白名单字段：module、event、code、rule_id、stage、phase、outcome、side_effect、reason、任务哈希前缀、trace 前缀，以及数值；
- 不整体打印 `details`。

**导出函数**：`analyzeZipBuffers(buffers, options) → { markdown, stats }`，供自检调用；CLI 只是一层包装。

### 2. 修 `tools/remote-diagnostics/Collect-Diagnostics.ps1`

- **数据根**：新增 `-DataProfile auto|test|delivery`（默认 auto）和可选的 `-DataRoot`。
  - 参数不要叫 `-Profile`，会遮住 PowerShell 自动变量 `$PROFILE`。
  - auto 模式：在 `%APPDATA%\xiaoxi-active-touch-test\data` 和 `…-delivery\data` 中，选 `logs\diagnostics.jsonl` 修改时间最新的那个；
  - `environment.json` 记录选中的 profile（传了 `-DataRoot` 时记 `custom`），另一个 profile 是否存在只记布尔值。
- **收集日志**：
  - `data\logs\diagnostics.jsonl*` 的全部轮转文件放在 zip 根目录；
  - `data\auto_reply\auto-reply-diagnostics.jsonl*` 放在 `auto_reply/`；
  - 文件名和目录与应用内导出一致，第 1 步的脚本不用区分来源。
- **打包**：不用 `Compress-Archive`。用 `System.IO.Compression.ZipArchive` 逐条 `CreateEntry`，条目名用 `/` 分隔，直接写目标 zip，不在桌面留中间目录。
- **不再复制** `contacts.json`、`auto-reply-state.json`，改为在 `environment.json` 里只写数量（联系人条数、接待状态条数）。
- **删除** `mainWindowTitle`、`computerName`、`userName` 和所有绝对路径（进程 `path`、`dataRoot`、`missingFiles`、README 中的 Data root 和缺失文件列表）。缺失文件改为只记相对名，例如 `logs/diagnostics.jsonl`。
- **保留**：微信进程名和 FileVersion、DPI、屏幕信息、版本清单复制。
- zip 名改为 `AI-Customer-Diagnostics-<profile>-<timestamp>.zip`。
- 源码保持纯 ASCII：PowerShell 5.1 按 ANSI 代码页读取无 BOM 的 .ps1。中文照现有做法用 `[char]` 码拼（:66、:83）。
- 用更新后的两个文件重新生成 `tools/AI-Customer-Diagnostics-Tool.zip`（现在是 7-22 的旧版），在 result 中列出 zip 内的文件和 SHA-256。

### 3. 新增自检并注册

新增 `desktop/scripts/analyze-diagnostics.self_check.cjs`，追加到 `run-self-checks.cjs` 的 `checks` 数组（:5-87）。
- 它不匹配 `groupDefinitions`（:89-102）的并行组规则，会自动走串行（:108）。
- 不改 `groupDefinitions`。它会启动 PowerShell，按 `run-self-checks.self_check.cjs:11-12` 的约定，PowerShell 类自检保持串行。

## 允许改动

- 新增 `desktop/scripts/analyze-diagnostics.cjs`、`desktop/scripts/analyze-diagnostics.self_check.cjs`
- `desktop/scripts/run-self-checks.cjs`（只注册新自检）
- `tools/remote-diagnostics/Collect-Diagnostics.ps1`
- `tools/remote-diagnostics/Collect-Diagnostics.cmd`（仅当提示文字需要改时）
- `tools/AI-Customer-Diagnostics-Tool.zip`

## 禁止

- 不改 `desktop/src/`、`desktop/rpa/` 的任何代码，不改日志格式（那是 T9b 的范围）。
- 脚本不写盘、不解压。自检里除了 PowerShell 采集用例的临时目录，不落任何中间文件。
- 不把联系人名、聊天内容、截图、微信号、绝对路径带进脚本输出或采集包。
- 不在异机上运行采集工具，也不分发工具 zip。这两件由用户操作。

## 验收（新增断言在当前 HEAD 上必须失败）

### 1. 自检（合成数据，用 JSZip 在内存中生成 zip）

- **排序与去重**：
  - 两个 run，文件名乱序（例如 `.1` 比 `.10` 新），按口径排序正确；
  - 晚启动的 run，其 run_id 按字典序排在前面时，仍然排在后面；
  - 两次导出的重叠部分被去重。
- **统计正确**：以下结果都与预期一致：
  - 发送状态、rule 计数、最长连续串；
  - 给定 10 个值时的 p50/p90（精确值）；
  - 活跃时段切分；
  - `task.global_stop` 到 `start.started` 的秒数；
  - `touch.skipped_requeued` 计数。

  另外，`outcome_unknown` 为 0 时仍出现在输出中。
- **隐私**：在 `details` 里放入 `private-contact-name`、`private-chat-text` 这类字段，输出中不得出现。
- **不落盘**：
  - 分析期间把 `fs.writeFile*`、`fs.appendFile*`、`fs.mkdir*`、`fs.mkdtemp*`、`fs.createWriteStream`、`fs.copyFile*`（含 `fs.promises` 的同名方法）换成会抛错的桩，分析仍然成功；
  - JSZip 中 `*.png`、`*raw-reading.json`、`*expected.json` 条目的 `async` 从未被调用。
- **兼容**：条目名为 `auto_reply\auto-reply-diagnostics.jsonl`（反斜杠）的合成包，自动回复章节照常计数。
- **采集工具**：
  - 准备：用临时目录作为子进程的 `APPDATA`，里面只建以下文件：
    - `xiaoxi-active-touch-test\data\logs\diagnostics.jsonl(.1)`
    - `auto_reply\auto-reply-diagnostics.jsonl` 和 `.1`
    - 含 `private-contact-name` 的 `active_touch\contacts.json`
  - 以 `-OutputRoot <临时目录> -NoOpen` 运行，断言：
    - zip 根目录有 `diagnostics.jsonl`、`diagnostics.jsonl.1`，`auto_reply/` 下有两份自动回复日志；
    - 所有条目名都不含 `\`；
    - `environment.json` 的 profile 为 `test`；
    - 整个 zip 里找不到 `private-contact-name` 和临时目录路径；`USERNAME` 不少于 4 个字符时，也找不到它；
    - `<OutputRoot>` 下只有这一个 zip，没有中间目录；
    - 第 1 步的脚本能直接分析这个 zip。
  - 守护项（HEAD 上本就通过）：`Collect-Diagnostics.ps1` 的每个字节都 < 0x80。

### 2. 实数据

在 `desktop/` 下运行（只读本机已有的包，不涉及微信操作）：

```
node scripts/analyze-diagnostics.cjs "D:\微信\xwechat_files\wxid_y6vxvbcy1eri22_3dd4\msg\file\2026-09\AI获客 V1.0版本-诊断日志-2026-09-23T01-46-50-544Z(1).zip"
```

输出必须包含以下数字（我已按同一口径复算），把对应的输出行贴进 result：

- **概况**：
  - run `2ec782b8…`，seq 15317–69909，注明前 15316 行已被轮转覆盖；
  - 时间 2026-09-20 15:01:25 → 2026-09-22 20:20:11（UTC+8），约 53.3 小时；
  - 共 54,593 行（info 52,156、warn 1,219、error 1,218），`send_stage` 占 58.2%；
  - `build.edition` 为 `development`，版本 1.1.53，单屏 2560×1440，`scale_factor` 1。
- **发送状态**：`workflow_contact_send` 中 `sent_verified`/`confirmed` 679，`not_attempted`/`none` 606，`outcome_unknown` 0。
- **失败**：
  - `search-r008` 492、`search-r014` 110、`task_context_mismatch` 3、`wechat_search_network_lookup_misclick` 1；
  - 最长连续：r008 28，r014 5；
  - r008 串长分布（1 / 2–4 / 5–9 / ≥10）：3 / 66 / 9 / 10。
- **步骤耗时**（`send_stage` finish 行，`details.ok` 区分成败）：

  | 步骤 | n | p50 | p90 | max |
  |---|---|---|---|---|
  | `click-search-result-dry-run` 成功 | 1353 | 4326 ms | 4554 ms | 4935 ms |
  | `click-search-result-dry-run` 失败 | 606 | 3702 ms | 3875 ms | 4785 ms |
  | `input-message-dry-run` | 674 | 3731 ms | 3820 ms | 4278 ms |
  | `image_send` | 679 | 4035 ms | 4211 ms | 4907 ms |
  | `prepare_window` | 1959 | 953 ms | 1328 ms | 1801 ms |

- **成功联系人耗时**（`workflow_contact_send.finished`）：p50 27.8 s，p90 28.6 s，max 29.5 s。
- **全局停机**：3 次，都是 `task_context_mismatch`，任务哈希前缀 `ec4ff3`、`65cb76`、`2496a8`；到下一次启动分别 5.1 s、4.5 s、6.1 s；`classification.unknown_reason_paused` 3 次。
- **人工操作**：
  - `start.started` 15 次（其中 `start.finished` 状态 working 10 次、listening 5 次）；
  - 重新加入 3 次，分别 26、9、66 人（排除 26、0、0 人）；距上次发送结束分别 2.8 min、8.9 min、729 min；
  - 间接证据：`auto_reply` 的 `paused` 共 26 条，其中 `workflow_paused` 18、`workflow_takeover` 4、`app_closed` 4。
- **其他**：
  - `wechat_adapter` 的 `executor.started` 7226 次（不按模块区分是 7234，含 `contact_sync` 8 次），全部带 `parent_trace_id`；
  - trace 链：联系人 trace 1284 个；executor 的父 trace 有 1285 个，其中 1284 个能对上联系人 trace，另 1 个的联系人起始行已被轮转覆盖；
  - 活跃时段 7 段，合计 579 min（±1），平均每个 `sent_verified` 51.2 s；
  - run-bill 3 份，其中 275 人任务成功 265、跳过 10，`rule_counts` 为空；
  - 主日志 `reply.activated` 4 次、`reply.result` 1 次。

### 3. 全量自检

`npm.cmd run check:self` 通过。

## 需用户本人验收

- 把新的 `AI-Customer-Diagnostics-Tool.zip` 发给异机，在异机上运行一次，把生成的 zip 发回来。我用脚本确认能读出日志，并且不含联系人名。
