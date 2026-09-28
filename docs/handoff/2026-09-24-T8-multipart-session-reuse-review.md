# T8 审查结论：通过，已合并（2026-09-27，合并提交 `1dc57eb`）；遗留转入 T10b

审查对象：`codex/touch-multipart-session-reuse`（e3a17a9，基线 986d7f1）

## 已做对

- 会话锚点只存在内存里，不含姓名，只在多段模式下传递。失败、迟到失败、图片不可用都会清空锚点。有远程关闭开关。
- 复用闸门会重新核验全部信息：
  - 原有的 `verifyRealSendSessionAsync`；
  - 观察到的 token、写回状态的 token 都要和锚点一致；
  - pid、句柄、核验模式；
  - 只读探测前台窗口和用户是否空闲。
  任何一项不通过，就用快照原样写回，再走完整路径。不复用时的完整路径没有删掉任何一步。
- 34 个失效场景全部通过：
  - 切走会话、句柄变化、微信重启、失焦、DPI 或布局变化、人工输入、超过 15 秒、暂停、进程重启、同名、其他联系人或账号、锚点被篡改、迟到失败；
  - 发到错误会话 0 次，重复发送 0 次；
  - 正常的"文字 + 图片"只搜索 1 次，每段各发 1 次。
- 变异 26 个，杀死 16 个；存活的 10 个逐个看过，在现有其他防线下都是等价的。
- 与最新基线（已接入 `touch-message-sequence`）合并后：`check:self` 97 项、`build:test` 都通过。
- `state_machine.dev.cjs` 在发布白名单里，属于正式发送路径。

## 遗留（转入 T10b，见其卡顶部）

1. `state_machine.dev.cjs:29` 新增常量 `WINDOW_PREFLIGHT_FAILED`，绕过了失败原因门禁的字面量检查。`wechat_window_preflight_failed` 原本就一直没登记（分类为 known:false），请在规则目录或 `workflowPolicies` 里登记。
2. 测试缺口（只有审查探针能抓到）：
   - M09：失焦或布局变化；
   - M11：联系人或账号变化；
   - M16：迟到失败后仍保留锚点。
   另外，会话驱动报告句柄或 pid 变化、微信重启、闸门内暂停，也请补进 `touch-message-sequence.self_check.cjs`。
   审查脚本在 `C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\t8\`（`probe.cjs`、`mutate.cjs` + `mutations.json`）。
3. 已知的残余风险（结果文档已写明，需要真机人工复验）：锚点之后约 0.5–1 秒内、以及探测之后到发送之前这两段时间里的人工输入；精确搜索模式下切到同名群聊。
