# T9b 结果：控制事件与诊断补强

- 分支：`codex/diagnostics-control-events`；基线：`f78a8b0`。
- 工作流暂停开始、结束、异常、任务重试、启动前阶段及退出均写入 trace；主窗关闭、退出请求、悬浮窗关闭转向主窗也有 trace。关窗使用无副作用的 `controlSnapshot()`。
- 微信窗口驱动从已选中进程的文件版本读取微信版本，经共享白名单进入发送诊断；导出时不启动进程。
- 诊断包新增经过逐字段校验的 `app`、`wechat`、`display`、`feedback_latest`、`log_coverage`，文件名含业务版本和数据分区；分析器增加对应概况、版本变化点、人工操作和暂停到恢复统计。
- 轮转改为当前日志加 19 个归档，并支持注入轮转上限。T9a 遗留的成功打断失败串、临时目录与 JSON 转义路径测试已补；分析器跳过无效 `event`；采集脚本共享读取日志，失败时删除残缺 ZIP，错误仅显示相对文件名。

## 验证

- 定向自检：工作流、诊断日志、诊断导出、窗口布局和分析器均通过。采集脚本自检覆盖被其他进程打开的日志及失败清理。
- 20 × 5 MiB 合成日志导出：`diagnostics export benchmark: ms=1979 rss_before=94031872 rss_peak_sampled=288587776 zip_bytes=8242113`。采样 RSS 增量 194,555,904 字节，低于卡片的 500 MB 界限；耗时低于 20 秒。
- `npm.cmd run check:self`：退出码 0；末尾实际输出：

  ```text
  > src/main/wechat-workflow.self_check.cjs
  workflow scope stress: aliases_json=66671, scope_ms=22, contacts_reads=5
  auto-reply v4 self-check passed
  Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.

  all source self-checks passed
  ```

- `npm.cmd run build:test`：退出码 0；末尾实际输出：

  ```text
  ✓ 1643 modules transformed.
  ✓ built in 1.60s
  test renderer build completed
  ```

- `git diff --check`：通过。构建仅有 Vite CJS API 弃用及大于 500 kB 的 chunk 提示。

## 留待基线具备入口后补齐

基线 `f78a8b0` 尚无 T6b 的 `retryAll()` 和 `retryTask(..., andStart)`。按本轮确认，现有 `retryTask` 记录 `and_start_requested: false`；`retryAll()` 的汇总事件、两种调用触发的暂停来源及 `andStart` 真值用例待 T6b 合并后补齐。没有在本卡创建或改变这些控制行为。

采集脚本的 C4 修复依据任务卡顶部“T9a 遗留”实施；该脚本虽不在下方常规允许改动清单中，属于该遗留项的指定修复文件。既有工具 ZIP 未在本卡重打包或分发。

未在真实微信、异机或安装包中验收；内部发布及真实微信操作仍由用户另行授权。
