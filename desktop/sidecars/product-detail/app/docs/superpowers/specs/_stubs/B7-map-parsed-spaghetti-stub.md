# [STUB] §B.7 `_map_parsed_to_form_fields` 269 行意面 — 品类路径难复用

> ⚠️ 草稿状态: 由 P2 audit 自动生成
> 来源: § Top 10 #9 / §B.7 (= §C.8)
> 严重度: 中
> 估时: 1d
> **阻塞 P5/P6**: yes

## 问题简述

`app.py:605-873` 一个函数 269 行, 圈复杂度 > 30。承担 "AI JSON → 表单字段" 全部映射: 6 种兜底链 / 3 种品类特有分支 (b2_items / vs / kpis) / 12 种 list→JSON 序列化。每加一品类要在同函数加 if/else。

## 根因诊断

**根因 1 — app.py 单文件累积** 的子表象。也跟根因 (P5/P6 多品类未抽象) 关联。

## 修复方案

### 方案 A — 注册表 + 子函数 (推荐)
```python
# services/category_mappers.py
from typing import Protocol

class CategoryMapper(Protocol):
    def map_hero(self, parsed: dict) -> dict: ...
    def map_advantages(self, parsed: dict) -> dict: ...
    def map_vs(self, parsed: dict) -> dict: ...
    def map_brand(self, parsed: dict) -> dict: ...
    def map_kpis(self, parsed: dict) -> dict: ...

class DeviceMapper:
    def map_hero(self, parsed): ...
    def map_advantages(self, parsed): ...
    # ... 设备类专属逻辑

class ConsumableMapper:
    def map_hero(self, parsed): ...
    # 耗品类不需 map_vs / map_kpis (空 stub)

REGISTRY = {
    "设备类": DeviceMapper(),
    "耗品类": ConsumableMapper(),
    # 工具类 / 配耗类 后续添加
}

def map_parsed_to_form_fields(product_type: str, parsed: dict) -> dict:
    mapper = REGISTRY[product_type]
    result = {}
    result.update(mapper.map_hero(parsed))
    result.update(mapper.map_advantages(parsed))
    if hasattr(mapper, 'map_vs'):
        result.update(mapper.map_vs(parsed))
    ...
    return result
```
- 优势: 圈复杂度从 30+ 降到每子函数 < 10; P5/P6 加品类 = 加 mapper 类 (~60 行) 而非动 app.py
- 劣势: 抽象成本; 需迁移 7+ 路由的 caller
- 估时: 1d

### 方案 B — 拆 6-8 子函数, 不引 mapper class
```python
def _map_hero_fields(parsed): ...
def _map_advantages_fields(parsed): ...
def _map_vs_fields(parsed): ...
# ...

def _map_parsed_to_form_fields(parsed):
    result = {}
    result.update(_map_hero_fields(parsed))
    ...
```
- 优势: 简单, 0 抽象引入
- 劣势: 仍需 `if product_type ==` 分支, P5/P6 移植成本不变
- 估时: 0.5d
- 适合"先做减法, 后做注册表"

## 推荐路径

先方案 B (0.5d), 看 P5 实施时是否真需要 mapper 注册表; 再决定是否升级到方案 A。

## 兜底/回滚

`git revert`. 影响 7 处 caller, 但函数签名不变可无痛回退。

## 测试

需补 `tests/test_map_parsed.py`:
- 各品类 happy path
- 兜底链各分支 (空 parsed / 缺字段 / 类型错)

## 转正式 spec checklist

- [ ] Scott 决策 "修"
- [ ] 选方案 (B 先, A 后)
- [ ] 依赖 B1 (god module 拆分)?
- [ ] 进入 P4

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
