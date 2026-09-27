# T10b 审查结论：打回（2 处代码缺陷 + 1 处关键测试缺口，在同一分支追加）

审查对象：`codex/search-capture-evidence`（2e292ed，基线 09b0e55）

## 已做对

- **判定逻辑没变**：T10a 的审查脚本全部重跑，结果与 T10a 完全一致。
  - 20 个攻击场景 0 次点击，G8 结果为 r007；
  - 回放样本：好友 28/0/0，非好友 4/0；
  - fuzz_wrongrow 选错 0/6487；fuzz_diff 的 tOnlySel 为 0。
- **"甲乙/甲乙丙"在生产中会被拦下，发送 0 次**，共三层：
  - A：点击这一步的 `CONVERSATION_TITLE_SCRIPT`；
  - B：verify_session 的 `OBSERVE_CONVERSATION_SCRIPT`，用 `-cne` 精确比较；
  - C：`sendReal` 和 `SEND_MESSAGE_SCRIPT` 的复核。
- **隐私通过**：
  - 用 2 个字的短名字走完整链路，state.json、run_logs、touch_task.json、passport 里都没有 OCR 原文、查询词、姓名、微信号，也没有它们的 SHA-256、SHA-1、MD5。
  - 基线把 OCR 原文泄露到了执行器的 state.json，本分支修掉了这个问题。
  - 3005 个合成名字只能分出 17 种形态签名，匿名集的中位数是 1689。
- **截图**：用的是 OCR 那一刻的同一张位图，只在最终跳过时保存，每个联系人 1 条记录，走每日上限。
- T8 遗留全部处理：原因码已登记，M09、M11、M16 都被抓到。DPI 两条测试也都能抓到对应变异。
- 与 a6f5caa 合并后，`check:self`、`build:test` 都通过。

## 必须修

1. **【关键测试缺口】"甲乙丙"用例没测到生产真正把关的那一层。**
   - 新测试把 `sessionDriver` 换成了点击步骤脚本（第 A 层）的回放。但生产中发送路径的核验是 `.dev` 的 `OBSERVE_CONVERSATION_SCRIPT`（第 B 层）。
   - 另外，测试里 runner 的标题是"甲乙丙"，会命中 `state_machine.cjs` 约 :789 的 `titles.find(t => t.includes(customerName))` 子串捷径，第 A 层也被跳过了。
   - 实测：把 OBSERVE 改成"前缀对上就接受"（变异 N23），完整的 `check:self` 仍然以 0 退出。
   - 要求：用 `OBSERVE_CONVERSATION_SCRIPT` 的真实比较逻辑做回放（可参考审查脚本 `replay_observe.cjs`）。断言精确的"甲乙"会被接受；"甲乙丙"会被拒绝，并且在会话列表或聊天内容里出现"甲乙"时也要拒绝；发送 0 次。N23 必须被抓到。
   - 结果文档里"回放正式会话标题脚本"的说法要改正。
2. **【代码，隐私】搜索下拉框的截图（能看到姓名和头像）留在 %TEMP% 里，从来不删。**
   - (a) `state_machine.cjs` 的 `clickSearchResultDryRun`：从微信号搜索回退到名字搜索时，第一次的 `search_capture_file` 被丢掉了，每回退一次就留下 1 个文件。
   - (b) 只有 touch-workflow 会读取并删除这个文件。自动回复（`executeVerifiedContactSend` + `runStep`）、`touch-task-ipc.cjs:963` 的循环、开发 IPC :408 都不删，每次 OCR 搜索失败都会留下一张 PNG，不受 passport 上限和保留期管理。
   - 修法：截图文件的生命周期收在一处。谁拿到谁负责删除；没有调用方需要时，不写文件，或者写完马上删除；回退时先删掉上一张。
   - 用例：每条调用路径走完后，%TEMP% 下都没有残留。
3. **【代码，可用性】每次 OCR 搜索都会把 base64 PNG 写到 stdout，成功的搜索也一样**（driver :1914）。
   - `runPowerShell` 用的是 `spawnSync`，没有设置 `maxBuffer`（:373-387）。实测 base64 超过 1 MiB（PNG 大约 786 KB）时，出现 `ENOBUFS` → `powershell_failed`，每个联系人的搜索都会失败。
   - 修法：只在需要截图时才输出；在 PS 端限制大小，超过就不带截图；或者提高 maxBuffer。
   - 用例：大尺寸的下拉截图不会导致搜索失败。

## 必须补的测试（变异存活，代码行为目前是对的）

- N03：指纹不能来自原文集合的哈希。
- N06：熔断路径要带上 OCR 截图字节。
- N10：给定字节也要走每日上限。
- N11：缺少字节时不能退回截主窗口。
- N13：选中结果时不写临时文件。
- N08、N09：截图路径要去掉并校验。
- N16：`ocr_observation.capture_source` 要如实记录。
- N21：workflow 要保留形态特征。
- N22：不能把原始 box 直接透传。
- N25：`bottom_gap` 的计算要用 bottom。
- N26：`equals_query` 不能写死。

**自测**：审查脚本在 `C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\t10b\`。
- 文件：`replay_observe.cjs`、`probe_leak2.cjs`、`probe_privacy.cjs`、`bufprobe.cjs`、`mutations.json`；
- N23 和上面列出的存活项都要被自检抓到；
- T10a 的目标保持不变；
- `check:self`、`build:test` 都通过。

**另记（不属于本卡）**：`state_machine.cjs` 约 :789 的子串捷径 `titles.find(t => t.includes(customerName))` 是原来就有的宽松判断。目前后面还有 B、C 两层兜底；冻结后单独评估。

## 二审（f9f9210）：再修一轮（同一分支追加）

**已做对**：
- 判定逻辑没变，T10a 的各项目标与一审逐字一致。
- 隐私暴力扫描 hits={}。T5 明文探针全部为 false。
- 可用性已修：maxBuffer 16 MiB，PS 端 5 MiB 上限；1.07 MB、4.1 MB 的截图都能正常判为 r008。
- 一审要求的回退删除、自动回复和 IPC 路径不再写截图，都做到了。
- N23 以及一审点名的存活变异全部被抓到；T8 的 M09、M11、M16 也被抓到。
- 最终合并版本（基线 + T9b + T10b）上 `check:self`、`build:test`、所有历史安全探针都通过。

**必须修**（以下每条都有两名独立复核者复现过）：
1. **【代码，隐私】搜索进行中暂停，会留下下拉框截图。**
   - 位置：`state_machine.dev.cjs:816-817`。点击步骤返回后，如果 `executionMayContinue` 为 false，就直接返回 `cancelVerifiedContactSend`，丢掉了 `openedConversation.diagnostics.search_capture_file`。touch-workflow（:484）只从返回值里取路径。
   - 实测：单段、多段任务各留下 1 张。
   - 修法：取消分支先 `discardSearchCapture`，或者把 diagnostics 带回给工作流。
2. **【代码，隐私】进程内异常也会留下截图。**
   - 位置：`state_machine.cjs:706-744`。`block()` 里的 saveState 或 appendLog 抛错时（ENOSPC、EACCES），没有 try/finally 删除截图；安全 CLI 的 main 也没有 catch，主进程只拿到 `executor_no_result`，路径丢失。
   - 修法：截图写好之后，用 try/finally 保证删除或者交回。
   - **兜底**：工作流步骤开始时，清扫过期的 `xiaoxi-search-capture-*.png`（只清本程序的前缀，只清 %TEMP% 顶层，不跟随链接）。
3. **【测试，关键】"甲乙丙"用例中"经真实 executeVerifiedContactSend、发送 0 次"这一半没有判别力。**
   - sessionDriver 忽略传入的 name，固定用"甲乙"回放；返回的"接受"对象又缺少 `accountVerified`/`accountId`，所以链路总会以 `wechat_account_not_verified` 拒绝。
   - 后果：如果以后发送路径改用已打开的标题去核对（变异 R19，属于发错人的回归），`check:self` 仍然全绿。
   - 修法：
     - mock 用传入的 name 作为 `$expectedConversation`；
     - 返回完整的接受对象（包括账号和 token）；
     - 加一条正向对照：精确标题能走到 sendDriver，sends=1。
   - R19 必须被抓到。
4. **【测试】截图生命周期缺端到端用例**：
   - 工作流参数经 CLI、state_machine 传到驱动（R09）；
   - 执行器把路径交回给工作流（R21）；
   - 暂停和异常路径（第 1、2 条）。
   - R09、R21 必须被抓到。
5. **【文档】结果文档**：第 27 行的"链路层 0 次发送"要按第 3 条的实际情况改写；第 28、41 行要补上暂停和异常这两条残留路径，并写明修复方式。

**自测**：审查脚本在 `C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\t10b-r2\`：
- `orphan_paths.cjs`：pause 和 exception 场景的 orphans 都必须是 0；
- `chain_vacuity.cjs`、`mutations-r2.json`：R09、R19、R21 必须被自检抓到；
- `bufprobe_r2.cjs`、`probe_privacy_r2.cjs`；
- T10a 的目标不变，`check:self`、`build:test` 都通过。
