# L2【高】搜索截图清扫节流 + 截图相关测试补强（A 线）

分支：`codex/capture-sweep-hardening`，从最新收尾基线新建。来源：`2026-09-28-wechat-closeout-leftovers.md` 第 3–7、11 条。

## 要做

1. **清扫节流（代码）**：`touch-workflow.cjs` 约 :211 在每个工作流步骤都调用 `cleanupStaleSearchCaptures()`，同步 readdirSync 整个 %TEMP%（9.5 万个条目时约 45–50 ms，会卡住 Electron 主线程）。
   - 改为同一进程内最多每 60 分钟扫一次（时钟可注入，便于测试）。进程启动后的第一步仍然要扫。
   - 清扫规则本身（前缀、只扫顶层、不跟随链接、24h 阈值）不变。
2. **清扫安全性质补自检**（`wechat_search_capture_chain.self_check.cjs` 或新自检，必须用**沙箱 TEMP**）：
   - 精确前缀才删；大小写不同、位数不对、`.png.tmp`、`.jpg`、其他前缀的文件都要保留；
   - 只扫顶层，子目录里的文件保留；
   - 不跟随 junction 和符号链接；
   - 未满 24 小时的保留，满 24 小时的删除，毫秒和秒不能混淆。
   - 要求：审查变异 X06、X07、X08、X09、X10、X12 都被抓到（审查脚本 `scratch\t10b-r3\`，其中 sweep_probe.cjs 可以参考）。
3. **链测试改用沙箱 TEMP**：不要再对真实 %TEMP% 做差集，也不要删除别的进程的 `xiaoxi-search-capture-*.png`。
4. **回退后异常的用例**：微信号搜索回退到名字搜索之后，`block()` 抛错，finally 删掉的必须是回退后的那张截图（X22）。
5. **`wechat_search_observation` 检查 chain 子进程的 passed 行**，不能只看 status===0。chain 卡住后以 0 退出时，obs 必须失败（X23）。
6. **OBSERVE 大小写**：补一条用例，锁定 `-cne` 对拉丁名的大小写敏感行为，例如期望 "Abc" 时，标题 "abc" 必须被拒绝（R16）。

## 允许改动

`src/main/touch-workflow.cjs`（只改清扫调用处和节流）、`rpa/active_touch/wechat_window_driver.cjs`（只在节流需要时改清扫函数的参数）、`rpa/active_touch/wechat_search_capture_chain.self_check.cjs`、`rpa/active_touch/wechat_search_observation.self_check.cjs`、`src/main/touch-message-sequence.self_check.cjs` 或 `wechat-workflow.self_check.cjs` 中与节流相关的用例（如需要），以及新增的自检文件（要登记进 `run-self-checks.cjs` 的 checks 清单）。

## 禁止

- 不改判定、点击、发送链路。
- 不改清扫规则本身。
- 不动 B 线 L1 的 `run-self-checks.cjs` 逻辑部分（只允许往 checks 清单里加一行）。

## 验收

- 上面列出的变异（X06–X10、X12、X22、X23、R16）都被自检抓到。
- 节流有测试：同一小时内连续执行步骤只扫一次；超过 60 分钟后再扫一次。
- T10a 的目标不变（attacks 20/20 不点击等）；orphan_paths 各场景 orphans=0。
- 在 %TEMP% 以外的工作树跑 `check:self`、`build:test`，都通过。
