# T12【高·小】B 线第一张：偶发失败的自检，和打包工具的 tar 路径

分支：`codex/test-and-tar-fixes`，从最新基线拉出。B 线第一张卡，和 A 线并行。

## 要做

1. **自动回复自检偶发失败**
   - 位置：`desktop/src/main/auto-reply-ipc.self_check.cjs:1960,1986`。
   - 原因：`/bbbb|cccc|dddd/`、`/ffff/` 会和日志里随机生成的十六进制串撞上，大约每 500 次误报一次。
   - 修法：把这些片段换成随机十六进制里不可能出现的哨兵串，例如含 `z`、`-` 的 `zz-sig-canary-1`，同时修改写入这些串的测试数据。
   - 要求：这两条断言必须继续守住"不泄露原文和签名"。故意把原始签名写进日志时，测试必须失败，并在结果里写明做过这个变异。
2. **tar 路径**
   - 位置：`desktop/scripts/build-portable-release.cjs:400`、`customer-edition.self_check.cjs:436`、`portable-release.self_check.cjs:123`。
   - 问题：这三处直接调用 `"tar.exe"`。在 Git Bash 里会先找到 Git 自带的 GNU tar，它不支持 `-a` 打 zip，导致自检失败，打包也可能出错。
   - 修法：在 `desktop/scripts/` 下加一个小函数，解析出 `%SystemRoot%\System32\tar.exe`（这个文件不存在时才退回 `"tar.exe"`），三处都改用它。

## 允许改动

上面列出的 4 个文件，以及 `desktop/scripts/` 下新增的一个小工具文件。

## 禁止

- 不改自动回复的业务代码。
- 不改打包参数和产物内容。

## 验收

1. 自动回复自检用不同随机种子连续跑 500 次，全部通过（附命令和统计）。
2. 在 Git Bash 里**不加 PATH 前缀**直接运行 `npm.cmd run check:self`，能够通过。
3. 在 PowerShell 里执行打包相关的自检，结果与改动前一致。

## 结果

写在 `2026-09-24-T12-test-and-tar-fixes-result.md`。
