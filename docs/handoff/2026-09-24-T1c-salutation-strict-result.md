# T1c 实施结果

分支：`codex/fix-salutation-extraction`。本轮审查补丁前再次 rebase 到 `82f248d`；本结果取代 T1b 的称呼规则。

## 改动

- `contactSalutation` 只读取备注，先删除带圈字符再做 NFKC；出现任务卡列出的关系词立即返回 generic。
- 仅接受整条备注匹配“可选的机构前缀和分隔符 + 前 100 姓中的单字 + 职务 + 可选电话”的固定格式。机构前缀须以列出的机构词结尾且长度不超过 24，电话号码须至少 6 位数字；总经理统一称“总”。
- 删除 T1/T1b 遗留的常见姓全集、复姓及姓名段推断常量。`PERSON_TITLE_RE` 仍被 `fillRespectfulTemplate` 使用，保留不动。
- 自检改为表格驱动，覆盖任务卡全部正反例和昵称禁用场景。
- 审查补丁：从可称呼姓氏中去掉“付”，并在任何正则匹配前让超过 64 字符的原始备注返回 generic；补回四个旧回归样例。

## 验证

在 `desktop/` 下执行：

| 命令 | 实际输出 |
|---|---|
| 修改生产代码前 `node src/main/ai-draft.self_check.cjs` | 失败：`物业方经理` 实际 `方经理`，预期 generic。|
| 修改后 `node src/main/ai-draft.self_check.cjs` | `ai-draft self-check passed` |
| `node rpa/active_touch/self_check.cjs` | `active-touch self-check passed`；剪贴板和搜索输入相关子检查通过。|
| `node src/main/deepseek-api.self_check.cjs` | `deepseek-api self-check passed` |
| `git diff --check` | 通过。|

本轮审查补丁先运行新增断言，旧实现失败于“付总”（实际为 title）；修改后再次运行上述三项自检，分别输出 `ai-draft self-check passed`、`active-touch self-check passed`、`deepseek-api self-check passed`。

## 未验证

- 未在真实微信做精准触达 dry-run；需用户在指定测试账号与联系人范围内核对开场白。
- 未运行 3918341 的旧版自检来统计失败条数；本分支上新增断言已先失败。
- 未执行安装包构建、发布。

## 对任务卡的异议

无。任务卡已接受“石老板”和“XX学校 史老师”的残余风险，未添加特例。
