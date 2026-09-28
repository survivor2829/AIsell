# 接入未登记自检 审查结论：小改后可合并（同一分支追加）

审查对象：`codex/register-remaining-self-checks`（791da77，基线 f78a8b0）

## 已做对

- `touch-message-sequence`（T5/T6a 发送安全测试）已接入 `check:self`。它之前完全不在 CI 里。
- `failure-evidence` 修好并已接入。
- `file_helper_send`、`wechat_clipboard`、`wechat_search_observation` 改为直接登记，不再由复合自检间接调用。
- `dev-electron`、`voice-preview-errors`、`narrated-batch-ipc` 已接入。
- `portable-release` 依赖发布产物，不接入，理由成立。

## 必须改

1. **`wechat_search_input.self_check.cjs` 和 `wechat_render_surface.self_check.cjs` 不能移出 CI。**
   - 这两项以前经由 `rpa/active_touch/self_check.cjs`、`moments_visual.self_check.cjs` 一直在 `check:self` 和 CI（windows-latest）里运行，并且能通过。
   - `wechat_search_input` 守的是"确认搜索框输入是本程序打的"（`verify owned search input`、receipt guard），这属于安全保护的测试。按规则，不能因为"可能依赖桌面"就降低它的覆盖。
   - 做法：直接登记进 `run-self-checks.cjs`。如果确实会在 CI 上失败，拿出 CI 失败的实际日志再讨论，不能凭推测移出。
2. 结果文档据此更新。

## 二审（a63d10e）：通过，已合并

- `wechat_search_input` 和 `wechat_render_surface` 已直接登记，`check:self` 里能看到这两项在跑，并且通过（"WeChat search owned-input self-check passed (no desktop input emitted)"）。
- 与最新基线合并后，`check:self` 从 87 项增加到 97 项，全部通过。
