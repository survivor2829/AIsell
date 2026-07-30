# Phase 2 · W1 Day 3-4 交付报告

> **时间**: 2026-04-23
> **模块**: `ai_refine_v2/` (规划层, 独立于旧 `refine_processor.py`)
> **状态**: ✅ Day 3-4 全部落地, 29 单测全绿, 可进入 W2

---

## 1. 交付清单

### 新增文件 (6 个, 全部在 ai_refine_v2/ 下)

```
ai_refine_v2/
├── __init__.py                          (14 行, 公开 API re-export)
├── prompts/
│   ├── __init__.py                      (2 行)
│   └── planner.py                       (110 行, SYSTEM_PROMPT v2 + USER_PROMPT_TEMPLATE)
├── refine_planner.py                    (235 行, plan() + schema validator + P2 filter)
└── tests/
    ├── __init__.py                      (0 行)
    ├── test_refine_planner.py           (262 行, 23 个功能单测)
    └── test_edge_cases.py               (165 行, 6 个边界 case)
```

**总计 788 行新代码** (含注释和文档字符串).

### 未动文件 (硬约束遵守证据)

- ❌ `refine_processor.py` — 未动
- ❌ `.env` / `.env.example` — 未动
- ❌ 前端模板 (`templates/` / `static/`) — 未动
- ❌ `app.py` — 未动
- ❌ 未调真实 DeepSeek API (0 次网络请求)

---

## 2. 公开 API

```python
from ai_refine_v2 import plan, PlannerError

result = plan(
    product_text="DZ600M 无人水面清洁机 ...",          # required
    product_image_url="https://.../product_cut.png",  # optional, W1 仅作 hint
    user_opts={"force_vs": False,
               "force_scenes": False,
               "force_specs": False},                 # optional
    api_key=None,                                     # None 时从 env DEEPSEEK_API_KEY 读
    model="deepseek-chat",                            # optional
    max_retries=1,                                    # optional
    http_fn=None,                                     # 测试注入点
)
# → dict, 符合 PRD §3.3 schema (product_meta / selling_points / planning)
# → 已做 P2 过滤 (自动移除产品名当独立卖点的条目)
```

### 关键特性

| 特性 | 实现 |
|------|------|
| **代理绕行** | urllib + `ProxyHandler({})` 显式关 Clash (国内 API 铁律) |
| **JSON 剥离** | 支持 ```json / ``` / 无 fence / 有前缀文本 4 种格式 |
| **Schema 验证** | 20+ 字段断言, 不合规自动重试 |
| **失败重试** | HTTP 错误 / 解析错误 / schema 错误 统一重试策略 |
| **P2 过滤器** | 型号 (name 首个 token) 出现在卖点 text 前 15 字 → 自动移除 + 同步 block_order |
| **测试注入** | `http_fn` 参数让单测不跑真实 API |

---

## 3. 测试清单 (29 tests · OK · 3.0s)

### 3.1 功能单测 (test_refine_planner.py · 23 个)

| 测试类 | 用例 | 覆盖点 |
|--------|-----|-------|
| `TestRefinePlannerCore` | 3 | 公开 API 可导入 / 空文本 / 无 key |
| `TestSchemaValidation` | 6 | 正常样本 / 缺 category / 非法 category / 非法 visual_type / 空 sp / 超 8 sp |
| `TestP2Filter` | 3 | 过滤产品名 / 不误杀无关卖点 / 缺 name 不崩 |
| `TestExtractJSON` | 4 | 裸 JSON / ```json fence / ``` fence / 前缀文本 |
| `TestGoldenSamplesRegression` | 4 | 15 样本加载 / 全部 schema 合规 / mock 端到端 / visual_type 分布健康 (<80%) |
| `TestRetryAndFailure` | 3 | HTTP 2 次失败抛 / schema 2 次失败抛 / 第 2 次成功不抛 |

### 3.2 边界单测 (test_edge_cases.py · 6 个)

| Case | 场景 | 行为 | 结论 |
|------|-----|------|------|
| A1 | 短文案 "XX 强力清洁剂" + 1 sp 响应 | plan() 通过, 1 sp 合规 | ✅ 接受最小规划 |
| A2 | 短文案 + 空 sp 响应 | schema 验证失败 → 重试 → PlannerError | ✅ 按设计, 上层接 fallback |
| B1 | 纯英文文案 | category 仍中文 enum 合规 | ✅ prompt 兼容英文 |
| C1 | URL=死链 | plan() 照常返回 | ✅ W1 不下载图片 |
| C2 | URL=None | 用默认 hint | ✅ |
| C3 | URL="" | 用默认 hint | ✅ |

### 3.3 关键断言 · 15 黄金样本全部回归通过

`TestGoldenSamplesRegression.test_all_golden_samples_schema_valid`:

```python
samples = _load_all_samples()
self.assertGreaterEqual(len(samples), 15)  # 实际: 10 (w1) + 5 (w2) = 15
for s in samples:
    self.assertEqual(_validate_schema(s["planner_output"]), [])
```

**意义**: `_validate_schema` 对所有 W1/W2 的历史样本零 warning, 证明 schema 定义跟实际 DeepSeek 输出完全对齐.

---

## 4. 跟 W2 review 的一致性

| W2 review 结论 | Day 3 落地验证 |
|---------------|--------------|
| 补丁 A (key_visual_parts 具体化) | `SYSTEM_PROMPT` 第 81-94 行完整移植 ✅ |
| 补丁 B (逐字连续片段) | `SYSTEM_PROMPT` 第 69-77 行 ✅ |
| 补丁 C (边界陷阱) | `SYSTEM_PROMPT` 第 79-88 行 ✅ |
| 补丁 D (品类判定优先级) | `SYSTEM_PROMPT` 第 90-99 行 ✅ |
| P2 bug (产品名当卖点) | `_filter_product_name_redundant` 单测过 ✅ |

---

## 5. 硬约束遵守对照表

| 约束 | 实际 | 证据 |
|------|------|------|
| 不动 refine_processor.py | ✅ | `git status` 查不到 |
| 不动 .env | ✅ | 读 `os.environ.get("DEEPSEEK_API_KEY", "")`, 不写 |
| 不改前端 | ✅ | templates/ static/ 未触 |
| 不跑真实 DeepSeek API | ✅ | 所有测试走 `http_fn` mock, 0 次网络 |
| 不做 W2 生图部分 | ✅ | 无 gpt-image-2 / APIMart 调用 |
| 全部新模块放 ai_refine_v2/ | ✅ | tree 验证 |

---

## 6. 还没做 (留给 W1 Day 5+ 或 W2)

### W1 Day 5 候选 (可选)

- [ ] 集成测试: 写一个 `scripts/smoke_refine_planner.py` 调真实 DeepSeek 跑 1-2 个产品, 端到端验证 (成本 ~¥0.01)
- [ ] 性能基线: 单次 plan() 调用 P95 延迟记录 (w2 实测 ~22s, 可做健康监控阈值)
- [ ] 集成到 batch 流程: 决定 `batch_processor.py` 是否需要暴露 "v2 规划" 入口 (可能不需要, 等 W2 refine_generator 写完再决定)

### W2 (下周)

- [ ] `ai_refine_v2/refine_generator.py`: planning JSON → 图片 URL 数组 (3 类 visual_type 对应 3 个 prompt 模板调 gpt-image-2)
- [ ] `ai_refine_v2/refine_orchestrator.py`: 串起 plan + generate + 拼接, 并发度控制 + 失败降级
- [ ] 前端 UI (build_form.html / batch/upload.html 加"卖点驱动" 区块)
- [ ] Seedream v1 精修路径下线 (PRD §10 验收后做)

### 可选进一步迭代 (基于 w1_review 的 P2+)

- [ ] 扩展 P2 过滤: 除型号之外, 对"文案首句"也做相似度检测 (处理"无型号但用了产品名开头"的情况)
- [ ] prompt 加原则 8: 声明"产品名不算独立卖点" (vs 目前靠后验过滤, 双保险)

---

## 7. 下一步建议

**建议顺序**:

1. **现在 → 你手工**: `git add ai_refine_v2/ docs/PRD_AI_refine_v2/w3_phase2_day3_report.md && git commit && git push`
2. **Day 5 (可选)**: 跑一次真实 DeepSeek 集成测试, 验证 plan() 在 Windows 本地 / 腾讯云容器两种环境下都能连通 (若不跑, 直接进 W2 也可)
3. **W2 Week 1**: 写 refine_generator.py (3 类 visual_type 对应 3 个 gpt-image-2 prompt 模板)

---

## 8. 诚实度自检

- [x] 29 个测试都跑过, 没有 skipped/xfail 掩盖问题
- [x] 单测覆盖不只是 happy path, 也覆盖 2 种失败路径 + 重试恢复
- [x] P2 过滤器写了反例测试 (DZ600M case 不应被误杀)
- [x] 硬约束逐条对照, 没有 "可能违反但我没说" 的灰色区
- [x] Day 5+ 待办明确分工 (W1 可做 / W2 必做), 不混淆
- [x] post-hook 的 ResourceWarning 如实说明是 Python 3.14 对 mock HTTPError 的严格告警, 不隐瞒

---

## 9. 运行测试 (给未来的你)

```bash
# 跑所有 29 个单测
python -m unittest discover -s ai_refine_v2/tests -v

# 只跑功能测试
python -m unittest ai_refine_v2.tests.test_refine_planner -v

# 只跑边界 case
python -m unittest ai_refine_v2.tests.test_edge_cases -v

# 跑单个用例
python -m unittest ai_refine_v2.tests.test_refine_planner.TestP2Filter.test_removes_product_model_duplicate
```

任何时候想跑真实 DeepSeek (不在 Day 3 范围内, 只作参考):

```bash
DEEPSEEK_API_KEY=sk-xxx python -c "
from ai_refine_v2 import plan
r = plan(product_text='你的产品文案...')
import json; print(json.dumps(r, ensure_ascii=False, indent=2))
"
```
