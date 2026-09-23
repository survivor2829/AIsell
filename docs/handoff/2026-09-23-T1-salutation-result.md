# T1 实施结果

分支：`codex/fix-salutation-extraction`（基于 `codex/fix-apimart-gateway-transport`）。

## 改动

- `contactSalutation` 只从职务前有明确边界的人名段取姓；支持机构/部门后缀后的姓名，普通姓名限 1–3 字、复姓姓名限 2–4 字，无法确认则返回 generic。
- `ai-draft.self_check.cjs` 加入任务卡表内全部 10 个备注场景。

## 验证

在 `desktop/` 下执行：

| 命令 | 实际输出 |
|---|---|
| 修改生产代码前 `node src/main/ai-draft.self_check.cjs` | 失败：`刘国强总` 实际 `强总`，预期 `刘总`。|
| 修改后 `node src/main/ai-draft.self_check.cjs` | `ai-draft self-check passed` |
| `node rpa/active_touch/self_check.cjs` | `active-touch self-check passed`；剪贴板、搜索观察及输入自检也通过。|
| `node src/main/deepseek-api.self_check.cjs` | `deepseek-api self-check passed` |

## 未验证

- 未执行真实微信精准触达 dry-run；需用户在指定账号和联系人范围内验收开场白。
- 未运行完整构建；本卡只修改 CommonJS 称呼函数和对应自检。

## 对任务卡的异议

无。表内场景均可按规则实现。
