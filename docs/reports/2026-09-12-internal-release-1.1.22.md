# 1.1.22 内部增量发布记录

## 修复范围

- 精准触达不再使用微信号拼接搜索结果的完整 AutomationId，改为解析唯一的本地联系人结果。
- UIA 空树时允许联系人名称唯一匹配的视觉结果继续；只有明确无本地联系人时才跳过，其他无法确认的结果暂停。
- 点击发送后若首次只因 `input_draft_read_failed` 无法读取草稿，会在重新确认账号、进程、窗口和当前会话后仅重试一次只读确认；不会再次点击发送。两次仍无法确认时保留 `outcome_unknown` 并暂停。
- 微信窗口驱动向上保留发送确认的具体失败原因，不再把这类现场统一折叠成 `powershell_output_invalid`。
- 增量构建忽略 Electron 运行期间临时生成的根目录 `debug.log`，避免把日志误判为底座升级。

## 本地验证

- headless 故障注入覆盖微信号与联系人名称不同、UIA 空树、仅有“搜一搜”、OCR 不可用、多候选及网页查询词分行。
- 精准触达自检、消息顺序、任务 IPC、`npm.cmd run check:self`、`npm.cmd run build:test` 均通过；未执行真实微信发送。
- 最终应用提交 `ee7c49862c5d74873738152d7954a8729743b039` 构建 1.1.22 组件候选成功，源码状态为干净，基础指纹与 1.1.21 验收底座一致：`8aeab74252cc4ba1258ffa46c0112429511eab3483e6595208065c25a21f7e9b`。
- 候选目录为 `release/components/test/candidate-42608-1789214831459-dhfgmbai8`，四个组件合计 70487477 字节并通过组合应用校验。
- 新 application 组件摘要为 `e69725cfef5020e4b4c8e64c6727398d01519f6e1859ed72f945ebfc002d2c3f`；content-engine、product-detail、video 与 1.1.21 摘要相同，发布时只上传 1 个变化归档。

## CI 与发布状态

- 最终应用提交对应的 Windows CI `34692107346` 已完成，`source-and-renderer` 与 `service-and-content` 均成功。
- 1.1.22 已发布到内部 `test` 频道；服务器回读序号为 `1789214922723`，发布时间为 `2026-09-12T12:08:42.723Z`，线上 application 及三个复用组件摘要均与候选一致。
- 未执行真实微信发送；异机真实微信验收仍由用户完成。历史 `outcome_unknown` 任务在人工确认发送状态前不得自动续跑或补发。
