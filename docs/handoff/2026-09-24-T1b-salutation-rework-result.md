# T1b 实施结果

分支：`codex/fix-salutation-extraction`，在 T1 提交 `03f313b` 后追加。

## 改动

- `contactSalutation` 在备注非空时只解析备注；备注为空才解析昵称。出现任务卡列出的关系词时直接返回 generic。
- 职务优先识别“总经理”，输出“总”；姓氏判断改为任务卡的常见姓、长度、复姓、边界词和两字停用词规则。无法唯一判断时返回 generic。
- `ai-draft.self_check.cjs` 改为覆盖任务卡完整表格、昵称优先级和十条“不叫错姓”回归断言，并补一条 Unicode 横线分隔符用例。

## 验证

在 `desktop/` 下执行：

| 命令 | 实际输出 |
|---|---|
| 修改生产代码前 `node src/main/ai-draft.self_check.cjs` | 失败：`李白老师` 实际 `李老师`，预期 generic。|
| 修改后 `node src/main/ai-draft.self_check.cjs` | `ai-draft self-check passed` |
| `node rpa/active_touch/self_check.cjs` | `active-touch self-check passed`；剪贴板、搜索观察及输入自检亦通过。|
| `node src/main/deepseek-api.self_check.cjs` | `deepseek-api self-check passed` |
| `git diff --check` | 通过。|

## 未验证

- 未在真实微信执行精准触达 dry-run；需用户在指定测试账号和联系人范围内核对开场白。
- 未重新运行 3918341 的旧版自检；旧版至少五条错误由任务卡及审查证据记录，本次已在 T1 分支确认新增用例先失败。
- 未执行安装包构建或发布。

## 对任务卡的异议

无。T1 原规则的歧义由 T1b 明确修正。
