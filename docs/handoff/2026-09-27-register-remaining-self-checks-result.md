# 未登记自检接入结果

- 分支：`codex/register-remaining-self-checks`；基线：`f78a8b0`。
- 11 项中有 10 项直接登记；从复合自检迁出的 5 项各运行一次。`portable-release` 仍留在发布包验收。

| 自检文件（`desktop/` 下） | 处理 | 依据 |
|---|---|---|
| `src/main/touch-message-sequence.self_check.cjs` | 接入 | T5/T6a 发送顺序、安全阻断与结果不明回归；执行器为夹具，不实际发送。 |
| `rpa/active_touch/wechat_search_observation.self_check.cjs` | 接入 | T10a 的 PowerShell 搜索观察回放，输入与图像均由夹具生成；从复合自检迁出，避免重复。 |
| `src/main/failure-evidence.self_check.cjs` | 修复并接入 | 源码存在以失败原因为标记的目录条目，旧断言误要求它们包含规则 ID；同时修复合成截图角点坐标的 PowerShell 算式。捕获使用伪造窗口函数，不读取真实窗口。 |
| `rpa/active_touch/file_helper_send.self_check.cjs` | 接入 | 发送、窗口与输入驱动均由桩替代；从复合自检迁出。 |
| `rpa/active_touch/wechat_clipboard.self_check.cjs` | 接入 | 仅复制内存中的 WinForms DataObject，不读取或写入系统剪贴板；从复合自检迁出。 |
| `rpa/active_touch/wechat_render_surface.self_check.cjs` | 接入 | 合成屏幕外窗口的 UIA 回归，以前已在 CI 经朋友圈复合自检运行；现直接登记。 |
| `rpa/active_touch/wechat_search_input.self_check.cjs` | 接入 | 输入归属 receipt guard 的安全回归，以前已在 CI 经精准触达复合自检运行；现直接登记。 |
| `scripts/dev-electron.self_check.cjs` | 接入 | 仅读代码并校验端口解析，不启动 Vite 或 Electron。 |
| `scripts/portable-release.self_check.cjs` | 不接入 | 完整运行依赖事先生成的发布目录、ZIP 和可执行文件，并启动打包后的 helper；属于发布包验收。 |
| `src/main/content-engine-voice-preview-errors.self_check.cjs` | 接入 | 只用本地错误对象验证公开错误文案，不发网络请求。 |
| `src/main/narrated-batch-ipc.self_check.cjs` | 接入 | IPC、控制器与通知均为内存桩，不调用云端或真实素材。 |

## 验证

- 接入项在 Windows 上均已运行通过；`failure-evidence` 的合成脱敏、节流、本地/云端传输和导出通过。夹具不操作真实微信或系统剪贴板；`wechat_render_surface` 使用合成屏幕外窗口，`wechat_search_input` 安装并停止输入归属钩子。
- `run-self-checks.self_check.cjs` 通过；`git diff --check` 通过。
- 首次提交时 `npm.cmd run check:self` 退出码 0。新增项与结尾的实际输出摘录：

  ```text
  dev-electron self-check passed
  file-helper send self-check passed
  WeChat clipboard snapshot passed: text, image, files, detached stream, empty and unsupported data
  search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)
  failure evidence passed: 411 unique rules, synthetic redaction, throttle, local/cloud transport and export
  Touch sequence checks passed: order, restart, partial failure, pause, unknown outcome and image receipts.
  voice preview public error self-check passed
  narrated batch IPC self-check passed
  Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.
  all source self-checks passed
  ```

## 一审后追加

审查指出 `wechat_search_input` 与 `wechat_render_surface` 原本就随复合自检在 Windows CI 中执行，前者还是搜索输入归属保护。本次已改为在 `run-self-checks.cjs` 直接登记，各运行一次；`portable-release` 仍不登记。追加后的 `npm.cmd run check:self` 退出码 0，实际输出摘录：

```text
> rpa/active_touch/wechat_search_input.self_check.cjs
WeChat search owned-input self-check passed (no desktop input emitted)

> rpa/active_touch/wechat_render_surface.self_check.cjs

> rpa/active_touch/self_check.cjs
active-touch self-check passed
...
Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.

all source self-checks passed
```

未执行真实微信、发布包或异机验收；这三类验证不由本卡自检代替。
