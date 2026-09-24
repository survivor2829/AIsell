# T9a 结果：诊断分析器与异机采集工具

- 分支：codex/diagnostics-analyzer；基线：db328d3。
- 新增 desktop/scripts/analyze-diagnostics.cjs：直接读取一个或多个 ZIP，按 run 首时间和 run 内 seq 排序、去重，只读取主日志、自动回复日志、run-bill、summary 和 environment，输出 11 节 Markdown；导出 analyzeZipBuffers。
- 修订 Collect-Diagnostics.ps1：自动选择 test/delivery 最近的主日志，支持 -DataProfile 与 -DataRoot；只收主日志和自动回复日志轮转、版本清单与脱敏环境摘要；ZipArchive 直接打 ZIP，不留中间目录。CMD 不再把脚本绝对路径写入启动日志。
- 自检已注册到 run-self-checks.cjs 的串行项。没有修改 desktop/src 或 desktop/rpa。

## 验证

- 基线 db328d3 尚无 analyze-diagnostics.cjs；旧采集脚本复制 contacts.json、只取一份自动回复日志，并使用 Compress-Archive。新增自检针对这些旧行为会失败。
- node scripts/analyze-diagnostics.self_check.cjs：通过。合成 ZIP 覆盖多 run 排序、重叠去重、活跃时段、发送状态、规则与最长连续串、10 值 p50/p90、暂停到重启、重新加入、反斜杠条目、隐私、不读附件和不落盘；PowerShell 临时数据根验证 test/delivery 自动选择、轮转日志、条目分隔符、无联系人名和绝对路径、分析器可读。
- npm.cmd run check:self：通过，末尾 all source self-checks passed，新增 diagnostics analyzer self-check passed。
- 脚本字节全小于 0x80；PowerShell 解析无错误；三个 JS 脚本 node --check 通过；git diff --check 通过。

### 本机 9 月 23 日诊断包实数据摘录

- 版本：development / 20260920T0208Z / 1.1.53
- 屏幕：2560×1440，scale_factor 1
- run 2ec782b8…：seq 15317–69909；本 run 前 15316 行已被轮转覆盖
- 时间：2026-09-20 15:01:25 → 2026-09-22 20:20:11（UTC+8），53.3 小时
- 总行数 54593；info 52156、warn 1219、error 1218；send_stage 58.2%
- 活跃时段 7 段，合计 579.0 分钟；平均每个 sent_verified 51.2 秒
- sent_verified: 679；not_attempted: 606；outcome_unknown: 0
- rule_id：search-r008: 492；search-r014: 110
- 失败 code：task_context_mismatch: 3；wechat_search_network_lookup_misclick: 1
- search-r008：最长 28；串长 1 / 2–4 / 5–9 / ≥10 = 3 / 66 / 9 / 10
- search-r014：最长 5
- click-search-result-dry-run / 成功：n 1353，p50 4326，p90 4554，max 4935 ms
- click-search-result-dry-run / 失败：n 606，p50 3702，p90 3875，max 4785 ms
- input-message-dry-run / 成功：n 674，p50 3731，p90 3820，max 4278 ms
- image_send / 成功：n 679，p50 4035，p90 4211，max 4907 ms
- prepare_window / 成功：n 1959，p50 953，p90 1328，max 1801 ms
- workflow_contact_send.finished：n 679，p50 27795，p90 28631，max 29515 ms
- 全局停机 3 次，都是 task_context_mismatch；任务 ec4ff3 / 65cb76 / 2496a8；到下次启动 5.1 / 4.5 / 6.1 秒
- classification.unknown_reason_paused：3
- 重新加入 3 次：26/9/66 人，排除 26/0/0 人；距上次发送结束 2.8/8.9/729.2 分钟
- start.started 15；start.finished：working 10、listening 5
- 自动回复 paused（间接证据）26：workflow_paused 18、app_closed 4、workflow_takeover 4
- 联系人 trace 1284；wechat_adapter executor.started 7226；executor 父 trace 1285，匹配联系人 1284
- run-bill 3 份；275 人任务 total 275，success 265，skipped 10，failed 0，rule_counts 无规则号（T5 之前的构建）
- 主日志 reply.activated 4，reply.result 1

### 工具 ZIP

- tools/AI-Customer-Diagnostics-Tool.zip SHA-256：B00498B73D726C87E02A2DB54236A21E964F1DA424EFBA89DF3B58E9692B0E17
- 条目：Collect-Diagnostics.cmd（SHA-256 D2A9FEF3241EBB25F20F517649A96BB01BEB2845F8F0E1921CCF634DBC48DB66）；Collect-Diagnostics.ps1（SHA-256 D54CC169F8DF5F2CA0B8B72E68D304C97F13AB03C81D5847E43E9E93D957F11F）。

未在异机运行或分发工具；异机采集后的真实包仍需用户操作并回传验收。