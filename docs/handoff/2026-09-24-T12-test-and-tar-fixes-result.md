# T12 结果：自动回复自检哨兵与系统 tar

- 分支：codex/test-and-tar-fixes；基线：a1b890a。
- 自动回复自检：将易撞上随机十六进制日志的短片段换成含 z 和连字符的签名哨兵；保留一条用于生成 observation_ref 的有效 64 位十六进制签名，并用完整 64 位断言保护它。原文、联系人、上下文泄露断言保留。
- 打包工具：新增 desktop/scripts/system-tar.cjs，优先使用 SystemRoot/System32/tar.exe，仅在该文件不存在时回退 tar.exe；三处调用参数未变。

## 验证

1. 在 desktop 运行 node src/main/auto-reply-ipc.self_check.cjs：通过。
2. 在 desktop 用 Node child_process.spawn 启动 500 个独立自检进程，并发数 8，每次使用系统随机源。输出：TOTAL 500 PASS 500 FAIL 0，耗时约 179 秒。
3. 内存变异：在读取 boundSessionRecheckLog 前，临时向诊断日志追加一条含 zz-sig-canary-session 原始签名的 JSON 行；未修改磁盘上的测试源码。自检在 bound-session 原文与签名泄露断言处失败，符合预期。
4. PowerShell 运行 node scripts/customer-edition.self_check.cjs：edition boundary self-check passed。
5. Git Bash 不加 PATH 前缀，运行 cd /c/Users/Scott/Desktop/xiaoxi-active-touch/desktop && npm.cmd run check:self：最终 all source self-checks passed，其中 customer-edition 和 auto-reply 自检均通过。
6. 五个改动的 .cjs 文件 node --check 通过；git diff --check 通过。

未构建正式安装包，未做真实微信操作；本卡只修自检和打包 tar 路径。