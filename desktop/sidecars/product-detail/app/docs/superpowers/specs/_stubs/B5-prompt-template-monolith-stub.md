# [STUB] §B.5 prompt 模板 330 行硬编码 — P5/P6 多品类阻塞

> ⚠️ 草稿状态: 由 P2 audit 自动生成
> 来源: § Top 10 #10 / §B.5
> 严重度: 中
> 估时: 4h
> **阻塞 P5/P6**: yes

## 问题简述

`app.py:2296-2625` `_build_category_prompt` 函数 330 行, 每品类 (设备/耗品/工具/配耗) 各 ~80 行 prompt 字符串拼接。P5/P6 加新品类 = 复制粘贴 ~80 行, 公共规则 (`_NO_FABRICATION_RULE` / `_EXTREME_WORDS_RULE` / JSON schema 骨架) 无法 DRY 复用。

## 根因诊断

**根因 1 (app.py 累积)** + **根因 3 (无 config 体系)** 双重命中。Prompt 是配置不是代码 — 应当是 .json / .jinja, 不是 .py 字符串。

## 修复方案

### 方案 A — Jinja2 模板 + JSON schema (推荐)

目录:
```
prompts/
├── _base/
│   ├── no_fabrication.jinja      # 公共反伪造规则
│   ├── extreme_words.jinja       # 公共极端词规则
│   └── json_schema_skeleton.jinja
├── 设备类.jinja
├── 耗品类.jinja
├── 工具类.jinja
└── 配耗类.jinja
```

各品类模板:
```jinja
{# 耗品类.jinja #}
{% include "_base/no_fabrication.jinja" %}
{% include "_base/extreme_words.jinja" %}

# 耗品类专属规则
- 强调耗材替换周期 / 兼容设备型号
- block_b2 改为"6 大优势"标题为"为什么选我们的耗材"

{% include "_base/json_schema_skeleton.jinja" %}
```

代码:
```python
# services/prompt_loader.py
from jinja2 import Environment, FileSystemLoader
env = Environment(loader=FileSystemLoader("prompts/"))

def render_parse_prompt(product_type: str, raw_text: str) -> str:
    tpl = env.get_template(f"{product_type}.jinja")
    return tpl.render(raw_text=raw_text)
```

`_call_deepseek_parse` 调用方式不变, 仅 `_build_category_prompt` → `render_parse_prompt`。

- 优势: P5/P6 加品类 = 加 1 个 .jinja 文件; 公共规则 1 处改全局生效
- 劣势: 增加 Jinja2 模板调试成本 (但 Jinja 本身已是 Flask 依赖, 0 新增)
- 估时: 4h (含 4 品类迁移 + 测试)

### 方案 B — JSON 配置
```json
{
  "common_rules": ["反伪造规则...", "极端词规则..."],
  "categories": {
    "设备类": {"specific_rules": [...], "block_overrides": {...}},
    "耗品类": {...}
  }
}
```
- 优势: 极易 review, 非程序员也能改
- 劣势: 复杂逻辑 (条件包含 / 循环) 不好表达
- 估时: 6h

## 兜底/回滚

`git revert`, 旧 `_build_category_prompt` 一次性回来。可保留旧函数标 deprecated 1 个发版周期。

## 测试

`tests/test_prompt_loader.py`:
- 各品类 render 不抛错
- 公共规则 ALL 渲染都包含
- raw_text 注入正确

## 转正式 spec checklist

- [ ] Scott 决策 "修"
- [ ] 选方案 (A 推荐)
- [ ] 依赖 B1?
- [ ] 进入 P4 (作为 P5 前置)

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
