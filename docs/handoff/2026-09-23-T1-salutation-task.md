# T1【P0】修正客户称呼提取

分支：`codex/fix-salutation-extraction`

## 问题（已实测确认）

`desktop/src/main/ai-draft.cjs:9-20` 的 `contactSalutation` 在职务前的文字里**倒序**找第一个常见姓的字，导致给真实客户发错称呼。该结果同时用于 AI 草稿（`generatePersonalizedDraft`）和固定话术兜底（`fillRespectfulTemplate` → 精准触达实发）。

| 备注 | 现在 | 应为 |
|---|---|---|
| 刘国强总 | 强总 | 刘总 |
| 王建国经理 | 国经理 | 王经理 |
| 李白老师 | 白老师 | 李老师 |
| 物业管理公司总经理 | 司经理 | generic（只用时间问候） |
| 华东区域经理 | 东经理 | generic |
| 张伟经理 | 张经理 | 张经理（保持） |
| 保洁部陈主任 | 陈主任 | 陈主任（保持） |
| 王总 | 王总 | 王总（保持） |
| 小李 / 张三 | generic | generic（保持） |

复现：`cd desktop && node -e 'const a=require("./src/main/ai-draft.cjs");console.log(a.contactSalutation({remark:"刘国强总"}))'`

## 规则

- 只看紧挨在职务（总/经理/总监/主任/老师/老板）前面的"人名段"：长度 1–3 个汉字（复姓时 2–4），且**首字**是 `COMMON_SURNAMES` 中的姓或以 `COMPOUND_SURNAMES` 开头，取首字（或复姓）+ 职务。
- 人名段需与前文有边界：前面是文本开头、分隔符，或一个明确的机构/部门后缀（如"部""公司""中心"等，沿用 `GENERIC_ENTITY_SUFFIX_RE` 并补"部"）。例如 `保洁部陈主任` 取 `陈`。
- 无法确定时一律返回 `{ type: "generic", value: "" }`。宁可只说"早上好"，不可叫错。

## 允许改动

- `desktop/src/main/ai-draft.cjs` 中的 `contactSalutation`（以及必要的常量）
- `desktop/src/main/ai-draft.self_check.cjs`

## 禁止

- 不改 `fillRespectfulTemplate`、`timeGreeting`、DeepSeek 提示词、RPA 发送链路。
- 不顺手重构其他函数。

## 验收

1. `ai-draft.self_check.cjs` 新增上表全部用例；这些断言在当前 HEAD（`bf985a2` 引入的实现）上必须失败。
2. `node src/main/ai-draft.self_check.cjs` 通过。
3. `node rpa/active_touch/self_check.cjs` 通过。
4. `node src/main/deepseek-api.self_check.cjs` 通过。

## 需用户本人验收

- 下次精准触达 dry-run 时，确认带职务备注的联系人开场白正确。
