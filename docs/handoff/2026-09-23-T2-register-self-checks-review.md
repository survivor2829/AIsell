# T2 审查结论：通过

审查对象：`codex/register-missing-self-checks`（8b96141）

## 结论

**通过，可以合并。**

## 验证结果

- 三个自检单独运行都通过，各连续跑两次也都通过，没有发现不稳定。
- `run-self-checks.self_check` 通过。
- 四张卡合并后的版本上，`check:self` 共 84 项全部执行并通过，product-video、digital-human、keyword-acquisition 都在其中。

## 发现的旧问题（不是 T2 引入的，以后出 T2b 卡处理）

1. 还有 12 个已有自检没有接入 `check:self`，例如 `touch-message-sequence`、`failure-evidence`、`provider-gateway-client`、`narrated-batch-ipc`，以及 5 个 rpa 自检。需要先逐个评估是否会动到真实微信。
2. **在 Git Bash 里跑 `check:self` 会提前中断**：`customer-edition.self_check.cjs:441` 调用 `tar.exe` 时，找到的是 Git 自带的 GNU tar，它把 `C:` 当成了远程主机。在 3918341 上也一样失败。修法：用绝对路径 `%SystemRoot%\System32\tar.exe`。在 PowerShell 或 cmd 里跑不受影响。
3. `run-self-checks.cjs` 只看退出码。如果某个自检的 promise 永远不结束，Node 会以 0 退出，被当成通过。
