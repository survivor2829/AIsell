# T8 结果：多段触达复用已核验会话

分支：`codex/touch-multipart-session-reuse`，从收尾基线 `986d7f1` 新建；未合并、推送或发布。

## 改了什么

- 多段触达仅在本次 `runWorkflowStep` 内保留上一段确认发送成功后的会话锚点；每一段仍执行选人、校准和冻结联系人核对。锚点不会进入段结果、任务文件、passport 或诊断。单段纯文字不启用。
- 复用闸门先检查账号、冻结身份、15 秒有效期和显示名唯一性，再用原会话核验及本次观察到的 token、模式、窗口身份做严格比对，最后使用异步、只读的前台窗口与空闲输入探测。通过才跳过窗口准备和搜索；失败、探测异常或暂停均按卡片回退或取消，完整搜索后的实际结果仍是本段结果。
- 增加 `active_touch/feature-flags.json` 的 `multipartSessionReuse:false` 远程关闭开关，每位联系人读一次；坏 JSON 按开启处理并记一条 warn。诊断只放枚举 `reuse_outcome` 和非负来源段号。图片发送器可通过选项注入，默认仍是原实现。
- 自检新增真实 `createTouchWorkflow → executeMessageSequence → executeVerifiedContactSend` 链路，CLI 的选人、校准和发前 dry-run 走真实实现；仅假 Win32 输入层。隔离子进程在模块加载前拦截 PowerShell 启动并计数。

## 验证命令与实际输出

- 在 `desktop/` 执行 `node src/main/touch-message-sequence.self_check.cjs`：退出码 0，输出 `T8 multipart session reuse checks passed; PowerShell launches: 0` 和 `Touch sequence checks passed: order, restart, partial failure, pause, unknown outcome and image receipts.`。正常四段只搜索一次；关闭开关后两段各自搜索；token、模式、窗口、人工输入、异常、超时、同名和跨步骤场景均回退。
- 在 `desktop/` 执行 `npm.cmd run build:test`：退出码 0，末行 `test renderer build completed`。
- 在 `desktop/` 执行 `npm.cmd run check:self`：退出码 0，末行 `all source self-checks passed`。

## 未验证、残余风险与任务卡异议

- 未操作真实微信、测试联系人、安装包或异机；节省的秒数和诊断分布尚无实机数据。
- 只读空闲探测看不到上一段驱动最后一次自身输入到锚点生成之间的人工输入，也可能漏过锚点后、探测实际执行前的短窗口，以及探测后到本段驱动启动前的输入。严格 token 比对可拦截会话头发生变化的情况；同名通讯录联系人不复用。仍存在切到与联系人同名的群聊、公众号等非通讯录会话且会话头证据相同的残余风险，与现有标题核验模式同级，需按卡片在异机人工复验。
- 卡片和用户说明说序列自检尚未接入 `check:self`；当前基线的 `wechat-workflow.self_check.cjs` 已间接调用它。本轮仍按要求单独运行，以便保留明确输出。
