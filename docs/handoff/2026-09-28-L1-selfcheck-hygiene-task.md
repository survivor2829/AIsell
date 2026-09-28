# L1【中】自检卫生：必须看到 passed 才算通过 + 清理测试临时目录（B 线）

分支：`codex/selfcheck-hygiene`，从最新收尾基线新建。来源：`2026-09-28-wechat-closeout-leftovers.md` 第 1、2、8 条。

## 背景

- `scripts/run-self-checks.cjs` 的 `runChecks` 只看子进程退出码（`stdio: "inherit"`）。某个 await 永远不结束、事件循环排空时，子进程以 0 退出，也不打印 passed，但仍然算通过。T9b 二审、T10b 三审都实际遇到过。
- `wechat-workflow.self_check.cjs` 用 mkdtemp 建的 `xiaoxi-workflow-order-*`（约 :2048）和 `xiaoxi-retry-guard-*`（约 :1302/:1359）从不删除。开发机 %TEMP% 已经积累约 9.5 万个条目。

## 要做

1. **runChecks 必须看到 passed 行才算通过**：
   - 退出码为 0，且本检查的 stdout 至少有一行匹配 `/\bpassed\b/i`，才算通过；
   - 退出码为 0 但没有 passed 行时，按失败处理，打印 `self-check exited 0 without a passed line: <check>`，退出码非 0。
   - 输出仍要实时或完整地显示给用户（例如 stdout 用 pipe 转发，或跑完后整体写出；maxBuffer 要足够大），stderr 保持原样。
   - 并行分组（`--group=`）走同一套逻辑。
2. 逐个核对 `checks` 清单里的 95 个脚本，把成功时不打印 passed 的补上一行（已知 `rpa/active_touch/wechat_render_surface.self_check.cjs` 不打印）。**只加打印，不改断言。**
3. `run-self-checks.self_check.cjs` 补用例：
   - 退出码 0 但无 passed，判失败；
   - 退出码 0 且有 passed，判通过；
   - 退出码非 0，判失败；
   - 输出里要能看到子检查的原文。
4. `wechat-workflow.self_check.cjs`：`xiaoxi-workflow-order-*`、`xiaoxi-retry-guard-*` 以及本文件里其他 mkdtemp 建的目录，都在 finally 中 `fs.rmSync(dir, { recursive: true, force: true })` 删除。验收：跑一次后 %TEMP% 下不再新增这两种前缀的目录。
5. 补 T9b 遗留的两个存活变异（详见 T9b 审查文档）：
   - G14：`start()` 落在重试窗口内时，不能多调用一次 `reply.resumeWorkflow`；
   - G17：恢复时要 emit，状态订阅方能收到。

## 允许改动

`scripts/run-self-checks.cjs`、`scripts/run-self-checks.self_check.cjs`、`src/main/wechat-workflow.self_check.cjs`，以及为补 passed 行而改动的各个 `*.self_check.cjs`（只加 console.log）。

## 禁止

- 不改任何生产代码，不删改已有断言。
- 不动 A 线 L2 的文件：`wechat_search_observation.self_check.cjs`、`wechat_search_capture_chain.self_check.cjs`、`touch-workflow.cjs`、`wechat_window_driver.cjs`。

## 验收

- 在 %TEMP% 以外的工作树跑 `check:self`，全部通过，并且每个脚本都有 passed 行。
- 人为让任一检查"卡住后以 0 退出"，`check:self` 失败。
- `build:test` 通过。
- **注意**：开发机 %TEMP% 有损坏条目，放在 %TEMP% 下的工作树构建会失败，请在 %TEMP% 以外跑全量。
