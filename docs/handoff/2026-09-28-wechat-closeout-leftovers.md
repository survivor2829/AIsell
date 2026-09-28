# 微信收尾：冻结后的小项（2026-09-28）

微信拓客收尾的各卡都已审查并合并。下面这些不影响发送安全，也不影响隐私结论。冻结期间只修真实出现的问题；这里的小项等下次动到相关文件时再顺手处理，或者由用户决定单独出卡。

## 测试框架

1. **自检"安静退出"会被当成通过。** `run-self-checks.cjs` 只看退出码；某个 await 永远不结束、事件循环排空时，进程以 0 退出，也不打印 passed，仍然算通过（T9b 二审、T10b 三审的 X23 都遇到过）。建议改为必须看到本脚本的 passed 行才算通过（`wechat_render_surface` 目前不打印，需要补上）。
2. **自检在 %TEMP% 下留垃圾。** `wechat-workflow.self_check.cjs` 里的 `xiaoxi-workflow-order-*`（约 :2048）和 `xiaoxi-retry-guard-*`（约 :1302/:1359），用 mkdtemp 创建后从不删除。开发机 %TEMP% 已经积累了约 9.5 万个条目，其中一个 `xiaoxi-workflow-order-kqPUYj` 在 NTFS 层面损坏，导致 esbuild 读不了 %TEMP%（位于 %TEMP% 下的工作树构建会失败）。

## T10b 小项

3. 清扫的安全性质缺少自检兜底：前缀、只清顶层、不跟随链接、时长（变异 X06–X10、X12）；"相似文件名"的反例是新建的文件，起不到作用。
4. `wechat_search_observation` 只检查子进程 chain 的退出码，没有检查 passed 行（与第 1 条同类）。
5. 回退之后 block() 抛错的路径没有自检（X22，探针能覆盖）。
6. 每个工作流步骤都会在主进程里同步 readdirSync 整个 %TEMP%（9.5 万个条目时约 45–50 ms）。建议节流，例如每小时一次或每个任务一次。
7. 链测试会对真实的 %TEMP% 做前后差集，并删除运行期间新出现的所有 `xiaoxi-search-capture-*.png`，可能误删别的进程的文件。应改用沙箱 TEMP。

## T9b 小项

8. G14、G17 等少数非要求变异仍然存活（详见 T9b 审查文档）。
9. 保守设计：重试失败时，如果有稍后到期的任务或正处于安全间隔，整个流程保持暂停，需要用户再点一次开始。

## 其他（冻结后单独评估）

10. `state_machine.cjs` 约 :789 的子串捷径 `titles.find(t => t.includes(customerName))`（后面还有 OBSERVE 精确比较和发送前复核两层兜底）。
11. OBSERVE 的 `-cne` 对拉丁名大小写敏感，对只有大小写不同的名字，属于原有缺口（R16）。

## 开发机环境（用户处理）

- %TEMP% 里有损坏条目 `xiaoxi-workflow-order-kqPUYj`，需要用管理员权限运行 `chkdsk C: /f`（重启时执行）修复。修好后，%TEMP% 下的 `xiaoxi-*` 测试垃圾可以一起清掉。
- 9-24 创建的审查工作树曾被 Windows 临时清理删掉。基线工作树已改到 `C:\Users\Scott\xiaoxi-review\base-branch`，审查脚本备份在 `C:\Users\Scott\xiaoxi-review\scratch-backup`。

## 处理安排（2026-09-28）

- 第 1、2、8 条 → L1（B 线，`2026-09-28-L1-selfcheck-hygiene-task.md`）。
- 第 3–7、11 条 → L2（A 线，`2026-09-28-L2-capture-sweep-and-tests-task.md`）。
- 第 9 条：保守设计，不改。
- 第 10 条：属于发送链路的判定规则，发布前不改；冻结后用真实数据评估。

## L1、L2 审查结论（2026-09-28）：都已通过并合并（`8db8375`、`c48b6e9`，代码树 `da86b2d`）

- 发布候选 = 基线 + L1 + L2：
  - 在 %TEMP% 以外，`check:self` 96 项全部通过，而且每项都打印了 passed；
  - `build:test` 通过；
  - 18 项历史安全探针的结果与上一轮逐字一致。
- 本表第 1–8、11 条已经解决（第 3 条只剩下面 L2 的 F1 一个边界）。

### 第二轮小项（冻结后顺手处理，都不影响发送安全）

- **L1**：
  - 总自检只要求"有任一行 passed"。`wechat_search_observation` 在异步收尾之前就打印了一行 passed，这个检查仍然可能"卡住后以 0 退出"而被判通过。应把 passed 行挪到真正结束的地方。
  - stdout 改为管道之后，按 Ctrl+C 中断时会丢失正在跑的那个检查的进度输出。
  - 运行器自检缺少这几种用例：空输出、分组路径、正则放宽。
- **L2**：
  - 24h 删除阈值只在 48h 处断言过，改宽到 36h 也测不出来；结果文档写的"24h+60s"与实际不符。
  - 时钟回拨后，节流会让清扫停到进程重启。
  - `rpa/active_touch/self_check.cjs` 和 `wechat-workflow.self_check.cjs` 仍然会用真实时钟清扫真实 %TEMP%（原本就是这样）。
  - 链测试里的 `symlinkSync(..., 'file')` 需要 Windows 开发者模式或管理员权限，在其他机器上可能以 EPERM 失败。
- **临时目录**：每跑一次全量自检，仍会留下约 13 个 `xiaoxi-*` 和 7 个 `moments-*` 目录（来自其他自检）。
- **环境**：Windows 临时清理在审查期间又删掉了一批 `%TEMP%\xiaoxi-rv5\scratch` 里的审查脚本，已从 `C:\Users\Scott\xiaoxi-review\scratch-backup` 恢复使用。
