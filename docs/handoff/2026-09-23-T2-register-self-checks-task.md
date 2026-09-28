# T2 注册遗漏的自检

分支：`codex/register-missing-self-checks`（可在 T1 之后或并行，两者文件不重叠）

## 问题

以下自检存在但未加入 `desktop/scripts/run-self-checks.cjs` 的 `checks` 列表，`npm.cmd run check:self` 不会运行它们：

- `src/main/product-video.self_check.cjs`
- `src/main/digital-human.self_check.cjs`
- `src/main/keyword-acquisition.self_check.cjs`

## 要做

1. 先逐个单独运行三者，记录结果。
2. 加入 `checks` 列表（放在相邻的 `src/main/*` 条目附近）。
3. 如 `scripts/run-self-checks.self_check.cjs` 对列表有约束，一并满足。
4. 跑 `npm.cmd run check:self`。若新注册的自检失败：只修测试本身的环境问题或最小的代码缺陷，并在 result 中逐条说明原因；涉及业务逻辑的失败**不要修**，写进 result 交回。

## 允许改动

- `desktop/scripts/run-self-checks.cjs`
- 上述三个 self_check 文件（仅限测试环境问题）

## 禁止

- 不改产品视频、数字人、关键词获客的业务代码（这些属于 T3/T4/T5）。

## 验收

- `npm.cmd run check:self` 全部通过，输出中包含三个新注册的自检。
