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
