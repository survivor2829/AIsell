# PRD AI 精修 v3.1 — 扬子混合路线 + 11 屏型 + 8-15 屏动态（Claude Code 全自洽版）

**版本**：v3.1（补全 8 个执行漏洞）  
**日期**：2026-04-28  
**作者**：Scott（决策）+ Claude（结构化）  
**前置版本**：PRD v2（commit 0a13500，170 测全绿）  
**铁律 5 状态**：deliberate_iron_rule_5_break（本次推倒重写后立即重置）  
**Scott 总介入次数**：仅 1 次（看图打分），其余 Claude Code 全自洽

---

## 0. 一句话定义

PRD v2 的 documentary muted teal-gray 纪实风跟 B2B 消费品客户期待严重错配，PRD v3 彻底转向"扬子混合路线"——**实景摄影暖色基调 + 大数字 + 通俗易懂 + 11 屏型 + 8-15 屏动态**——服务公司全产品矩阵在不同产品类型上的稳定泛化能力。

---

## 1. 背景与决策记录

### 1.1 PRD v2 已交付能力（保留不动）

- B 方案 logo 修复（global negative phrase + 边界划分关键句）
- C 方案 unified_visual_treatment 字段（跨屏风格统一机制）
- D 方案信息密度规则 + 屏型→layout 映射表
- 4 刀 guard（A UA / B raise / D raw_url / E size guard）
- SCOTT_OVERRIDE 单屏覆写模式（v2 实战发明，v3 正式化）
- 阶段四 product_cutout_url 集成（临时脚本验证 PASS，本次正式工程化）

### 1.2 PRD v2 的根本问题

| 问题 | 现象 | 根因 |
|---|---|---|
| 暗沉压抑 | 整体 deep cyan + amber muted，看着难受 | unified_visual_treatment 走"documentary 纪实风"，跟客户期待错配 |
| 产品形态部分错 | 多场景屏 / 数据故事屏的产品 AI 脑补，跟客户上传的真实产品形态不符 | 阶段四 v2 实验白名单"5 喂图 + 3 不喂"——把"AI 创意空间"放在"产品形态准确"之前 |
| 路线不匹配 | 现风格像高级杂志摄影，但客户是 B2B 采购员要的是"通俗易懂、参数清晰、对比明显" | 阶段一定的"高级电影感纪实"路线本身错配 B2B 消费品场景 |

**当前样本说明**：阶段五至阶段六前期真测仅覆盖单一产品（管道检测机器人 DZ600M），单点样本暴露了上述问题。PRD v3 不仅修这一个产品，更服务公司全产品矩阵的稳定泛化。

### 1.3 14 个核心决策点（Scott 拍板）

| # | 决策维度 | Scott 答案 |
|---|---|---|
| 1 | 客户类型 | B2B 消费品（物业/商场/学校/工厂等） |
| 2 | 客户决策路径 | 采购技术驱动（B 偏多）+ 一线辅助（A 少） |
| 3 | 风格基调 | 早晨阳光（A）+ 工业实战（B）按屏型分配 |
| 4 | 屏数策略 | 8-15 动态，DeepSeek 完全自由判断 + 不设档位锚点 |
| 5 | 阶段四集成 | 假设已是事实（直接当标准写） |
| 6 | FAQ 屏 | 内容必须从客户文案抽取，不允许 DeepSeek 编 |
| 7 | 屏型分配 | hero/brand_quality/value_story 走 A；scenario/detail_zoom/vs_compare/feature_wall 走 B；spec_table 中性 |
| 8 | 屏数下限 | 8 屏（PRD v2 是 6 屏） |
| 9 | 失败保护 | 最多 3 次 prompt 调整迭代上限 |
| 10 | 验收标准 | 9 维度 ≥ 7 票通过 |
| 11 | 失败退路 | git revert 回 PRD v2 commit 0a13500 |
| 12 | 生产环境 | 直接替换 v1 流程 |
| 13 | 成本容忍 | 按张数结算（成本上升不影响） |
| 14 | 阶段六其他产品 | 内部用，Scott 觉得行就给同事去跑 |

### 1.4 铁律 5 deliberate break 决策

**触发原因**：

1. PRD v2 的 documentary muted teal-gray 路线**根本不匹配** B2B 消费品客户决策习惯
2. design 文件夹 37 张真实详情页图证实**业界标准是明亮、高饱和、通俗**
3. 单纯调 prompt 字段无法纠正**整体设计语言走向**

**约束（铁律重置 3 条）**：

1. SYSTEM_PROMPT_V2 第 5 次推倒后**立即重置铁律 5**——下次推倒前必须重新讨论
2. 改完即测即 commit——不允许"再改一次再跑一次"陷阱
3. commit message 必须明确写 `deliberate_iron_rule_5_break` 给继任者明确信号

---

## 2. 设计语言路线（核心改动）

### 2.1 unified_visual_treatment 重写

**v4 当前**：

> Documentary photo-realism as dominant visual base; subtle film grain texture overlay; muted teal-gray color grade with soft amber accent lighting; consistent industrial precision aesthetic across all screens.

**v5 重写为**：

> Cinematic real-world photography with warm golden-hour atmosphere as dominant visual base; vibrant and uplifting mood throughout; brand-consistent color palette derived from product's primary color + black + warm white, accented with sunlight orange (#FF8C42) for hero/brand/value screens, OR industrial cool tones (silver gray + electric blue + amber chip highlights) for technical detail/scenario screens; high readability with bold sans-serif Chinese typography; commercial e-commerce detail page aesthetic, NOT high-art editorial.

**关键变化**：

- 从 "documentary muted" → "warm golden-hour cinematic"
- 从 "single unified treatment" → "two-treatment system 按屏型分配"
- 显式说明 "commercial e-commerce, NOT high-art editorial"
- **颜色锚点动态化**：从 product_meta.primary_color 字段读取（不写死在 prompt），任何产品都能用

### 2.2 屏型 × 风格分配表

| 屏型 | 风格分配 | unified_visual_treatment 子分支 |
|---|---|---|
| hero | A 早晨阳光 | warm golden-hour atmosphere, uplifting brand-defining first impression |
| brand_quality | A 早晨阳光 | warm spotlight on premium product, aspirational quality showcase |
| value_story | A 早晨阳光 | warm sunset / sunrise scenic backdrop, hopeful narrative |
| feature_wall | B 工业实战 | clean white backdrop, vibrant icon grid, high information density |
| scenario | B 工业实战 | real-world location photography, cool industrial tones, multiple environments |
| detail_zoom | B 工业实战 | studio close-up with industrial cool lighting, technical precision |
| vs_compare | B 工业实战 | side-by-side comparison, neutral backdrop, data clarity |
| icon_grid_radial（新） | B 工业实战 | clean backdrop, product centered, configurations radiating outward |
| scenario_grid_2x3（新） | B 工业实战 | 6 real-world location photos in grid, varied environments |
| spec_table | 中性 | industrial manual aesthetic, NOT documentary（沿用 SCOTT_OVERRIDE）|
| FAQ_Q&A（新，可选）| 中性 | clean Q&A card layout, friendly but professional |

---

## 3. 屏型库扩展（11 屏型）

### 3.1 新增 3 个屏型（⭐⭐⭐ 强推）

#### 3.1.1 icon_grid_radial（径向配件围绕）

**适用场景**：当产品文案描述 ≥ 4 个独立配件 / 模块 / 拓展时

**视觉描述**：
- 中心：产品 hero shot
- 周围：6-8 个配件 icon + 名称 + 关键参数
- 风格：clean white backdrop, vibrant icons radiating outward
- layout 关键词：`radial icon grid` / `configuration showcase` / `centered product with peripheral callouts`

**何时生成**：DeepSeek 识别文案含"配件 / 拓展 / 模块 / 选配"等关键词且数量 ≥ 4

#### 3.1.2 scenario_grid_2x3（6 实景应用场景网格）

**适用场景**：当产品文案描述 ≥ 4 个不同应用场景时

**视觉描述**：
- 6 张实景照片网格（2×3 或 3×2）
- 每张照片底部 + 场景中文标题
- 风格：real-world location photography, varied lighting per scene
- layout 关键词：`6-scene application grid` / `real-world deployment showcase`

**何时生成**：DeepSeek 识别文案含 ≥ 4 个 distinct 应用场景时（替代 v4 的 scenario triptych）

#### 3.1.3 FAQ_Q&A（常见问题）

**⚠️ 严格约束（法律合规）**：

- 所有 Q&A 内容**必须从客户上传文案抽取**，不允许 DeepSeek 编造
- 如果文案没有 ≥ 3 个 explicit Q&A pairs，**这屏不生成**（屏数自然减少）
- prompt 工程硬约束：`FAQ Q and A content MUST be extracted from product_text. NEVER fabricate warranty, return policy, service commitments, certifications, or any contractual obligations not explicitly stated in product_text.`

**视觉描述**：
- 6 个 Q&A 卡片（2×3 网格）
- 每卡片：Q 加粗 + A 正常字
- 风格：clean magazine-style, friendly but professional
- layout 关键词：`FAQ card grid` / `Q&A panel layout`

**何时生成**：DeepSeek 在文案里识别出 ≥ 3 个 explicit Q&A pairs 时

### 3.2 8 个原有屏型（保留 + 微调）

| 屏型 | 改动 |
|---|---|
| hero | 风格转 A 早晨阳光，其他不动 |
| feature_wall | 保留 grid 结构，icon 风格更鲜艳通俗 |
| scenario | 保留 triptych 选项，但 scenario_grid_2x3 是新优先选择 |
| vs_compare | 从"摄影对比"改为"双列卡片对比表 + 绿勾"风格 |
| detail_zoom | 保留 macro close-up + annotation cards |
| spec_table | 保留 SCOTT_OVERRIDE 工业手册风（不动）|
| value_story | 风格转 A 早晨阳光（替代当前 HUD 科幻风）|
| brand_quality | 风格转 A 早晨阳光，加强信任背书元素 |

### 3.3 准则 7 layout 映射表更新

8 屏型 → 11 屏型完整 enum：

```
hero / feature_wall / scenario / vs_compare / detail_zoom 
/ spec_table / value_story / brand_quality
+ scenario_grid_2x3 / icon_grid_radial / FAQ
```

---

## 4. 屏数动态化机制

### 4.1 屏数规则

```
最少：8 屏
最多：15 屏
判断方式：DeepSeek 完全自由根据文案丰富度决定
不设档位锚点：让 DeepSeek 自主判断
```

### 4.2 屏型选择逻辑

```
必出屏（任何产品都生成）：
- hero
- brand_quality
- spec_table

高优先级屏（90% 产品生成）：
- scenario_grid_2x3 或 scenario（2 选 1）
- detail_zoom
- value_story
- feature_wall

中优先级屏（按文案丰富度决定）：
- vs_compare（如果文案有"对比""传统 vs 智能"等关键词）
- icon_grid_radial（如果文案含 ≥ 4 个配件/模块）
- FAQ_Q&A（如果文案含 ≥ 3 个 explicit Q&A）

风险登记：
DeepSeek 如果为"显得丰富"硬撑屏数 → schema_v2 max=15 hard limit 兜底
DeepSeek 如果偷懒只生成 8 屏 → 验收阶段判断够不够，不够触发迭代
```

### 4.3 schema_v2 改动

```python
# v4 当前
"screen_count": {"type": "integer", "minimum": 6, "maximum": 10}

# v5 改为
"screen_count": {"type": "integer", "minimum": 8, "maximum": 15}

# 同时 role enum 加 3 个新值：
"role": {"enum": [
    "hero", "feature_wall", "scenario", "vs_compare", 
    "detail_zoom", "spec_table", "value_story", "brand_quality",
    "scenario_grid_2x3", "icon_grid_radial", "FAQ"
]}
```

---

## 5. 产品形态保真度（阶段四集成正式化）

### 5.1 喂图白名单（v3 默认行为）

```
喂参考图（INJECTION_PREFIX + product_cutout_url）：
✅ hero
✅ feature_wall（如果含产品本体，不只是 icon 墙）
✅ scenario / scenario_grid_2x3
✅ vs_compare
✅ detail_zoom
✅ icon_grid_radial（中心是产品）
✅ value_story
✅ brand_quality

不喂参考图（OVERRIDE 自洽 / 数据屏）：
❌ spec_table（OVERRIDE 自洽，参数表 prompt 自带产品描述）
❌ FAQ_Q&A（纯 Q&A 卡片，不画产品）
```

**核心原则**：**但凡画产品的屏，都必须用参考图**。

### 5.2 INJECTION_PREFIX 标准化

固定一句注入：

```
"Image 1 is the reference product cutout. Preserve the product's silhouette, primary color, and key visual parts exactly. "
```

注入位置：每屏 prompt 开头

### 5.3 product_cutout_url 工程化

`generate_v2()` 函数改造为支持 per-screen 控制：

```python
def generate_v2(planning_v2, product_cutout_url=None, 
                cutout_whitelist=None, ...):
    """
    cutout_whitelist: Optional[Set[str]]
        屏型 role 集合，仅这些 role 喂参考图。
        默认 None = 用 PRD v3 默认白名单（除 spec_table / FAQ 外全喂）
    """
```

**单测扩展**：

- 测 cutout_whitelist=None 时默认行为
- 测 cutout_whitelist={"hero"} 时只喂 hero
- 测 cutout_whitelist=set() 时全不喂

---

## 6. SCOTT_OVERRIDE 模式正式化

### 6.1 现状

v2 实战发明：当某屏的视觉风格跟 unified_visual_treatment 有根本性冲突时，用单屏 prompt 整段覆写解决。

### 6.2 PRD v3 正式化

**SCOTT_OVERRIDE 是 PRD v3 一等公民模式**——不是临时 hack，是 SYSTEM_PROMPT_V2 的合法逃逸阀。

**使用规则**：

1. 当某屏视觉风格跟 unified_visual_treatment 有根本性冲突时，允许整段 prompt 覆写
2. 覆写 prompt 必须包含：
   - 显式说明跟 unified_visual_treatment 的差异
   - 完整 NO logo negative phrase
   - 中文「」标记保留
   - 末尾 "All Chinese characters render sharp, accurate, no typos"
3. meta.json 必须标注 deliberate_dna_divergence 字段

**v3 默认 SCOTT_OVERRIDE 屏型**：

- spec_table（沿用 v2 那段 1380 字符工业手册风）
- FAQ_Q&A（如果生成，走 SCOTT_OVERRIDE 路径）

---

## 7. FAQ 屏 prompt 工程

### 7.1 SYSTEM_PROMPT_V2 硬约束新增

```
准则 8（新增）—— FAQ 屏内容真实性约束：

When generating FAQ_Q&A screen, ALL question-answer pairs MUST be 
directly extractable from product_text. NEVER fabricate or infer:
- Warranty periods
- Return/refund policies  
- Service commitments
- Certifications
- Spare parts availability
- Any contractual obligations

If product_text does not contain ≥ 3 explicit Q&A pairs, DO NOT 
generate FAQ_Q&A screen. Reduce screen_count by 1 instead.

This is a LEGAL COMPLIANCE requirement, not a style preference.
```

### 7.2 单测覆盖

- 测文案含 4 个 Q&A → 生成 FAQ 屏
- 测文案含 2 个 Q&A → 不生成 FAQ 屏（屏数减 1）
- 测文案含编造性词汇 → 不抽取该 Q&A

---

## 8. 验收标准（9 维度 ≥ 7 票通过）

### 8.1 9 个客观验收维度

| # | 维度 | 通过标准 |
|---|---|---|
| 1 | 风格暖色阳光向上 | hero/brand_quality/value_story 三屏视觉确实暖色 |
| 2 | 产品形态全屏一致 | 所有"含产品屏"产品形态跟客户上传的产品参考图对齐 |
| 3 | 0 logo 出现 | 8-15 屏全无 brand logo / company name |
| 4 | 中文文字准确 | 所有「」标记的中文字符 0 错字 |
| 5 | 信息密度足够 | 非 hero 屏每屏 ≥ 3 信息单元（按 v4 准则 6） |
| 6 | 跨屏风格统一感 | 整套屏整体观感协调 |
| 7 | 配色协调 | 整套不超过 3 个主色调，不出现冲突色 |
| 8 | 跟扬子标杆通俗易懂程度 | 跟 design 文件夹标杆相比，通俗易懂程度不差太多 |
| 9 | 整体观感 | Scott 直觉判断"嗯这个能给客户看了" |

**通过门槛**：9 维度里 ≥ 7 维度 PASS = 整体 PASS

### 8.2 失败处理

```
1 次跑：< 7 维度 PASS → 调 prompt → 重跑（这是第 1 次迭代）
2 次跑：< 7 维度 PASS → 调 prompt → 重跑（这是第 2 次迭代）
3 次跑：< 7 维度 PASS → 调 prompt → 重跑（这是第 3 次迭代）
4 次跑：< 7 维度 PASS → 触发 git revert，回 PRD v2 commit 0a13500

总预算上限：¥70
- 改 SYSTEM_PROMPT_V2 + 写测试：¥0
- 4 次完整跑（最坏）：4 × 8 屏 × ¥0.7 = ¥22.4
- 之前累计 ¥25.26
- 总计上限：¥47.66 ≤ ¥70 ✅
- buffer：¥22 应对意外
```

### 8.3 失败诊断映射表（漏洞 3 补丁）

**Scott 给出哪个维度 FAIL，Claude Code 直接对应该调哪段 prompt——不需要再问 Scott**：

| FAIL 维度 | 调改方向 | 具体改动位置 |
|---|---|---|
| 1 风格不够暖 | 加强 unified_visual_treatment "warm" 关键词 | 准则 2 `warm golden-hour atmosphere` 段加强 |
| 2 产品形态错 | 检查 cutout_whitelist + INJECTION_PREFIX 注入是否生效 | 临时脚本 cutout_whitelist 配置 |
| 3 Logo 出现 | 加强 negative phrase（罕见，B 方案稳定） | 准则 5 negative phrase 段 |
| 4 中文错字 | 加强中文「」标记教学 | 准则 4 中文字体段 |
| 5 信息密度低 | 加强信息单元规则 | 准则 6 信息单元段 |
| 6 风格不统一 | 调 A/B 风格分配表 | 第 2.2 节屏型 × 风格表 |
| 7 配色不协调 | 调 unified_visual_treatment 颜色锚点 | 准则 2 颜色 palette 段 |
| 8 不够通俗 | 调 unified_visual_treatment "commercial e-commerce" 强调 | 准则 2 末尾 |
| 9 整体观感 | 综合调整（Claude Code 自己判断哪段最关键） | 多段联调 |

---

## 9. 工程改动清单

### 9.1 SYSTEM_PROMPT_V2 改动范围

```
保留段：
- 准则 1（导演视角自然语言）
- 准则 3（产品文字处理）
- 准则 5（logo negative phrase + 边界划分关键句）
- JSON Schema 框架
- 硬约束块基本结构

重写段：
- 准则 2 unified_visual_treatment（重大重写）
- 准则 4 中文「」标记教学（基本保留）
- 准则 6 信息密度（保留 ≥ 3 信息单元）
- 准则 7 屏型→layout 映射表（扩展 8 → 11）

新增段：
- 准则 8 FAQ 内容真实性约束
- 风格分配表（A 早晨阳光 / B 工业实战 / 中性）
- SCOTT_OVERRIDE 模式说明

预估总长：9733 → 11000-12000 字符
```

### 9.2 schema_v2 改动

```
- screen_count.minimum: 6 → 8
- screen_count.maximum: 10 → 15
- role.enum 加 3 个新值（scenario_grid_2x3 / icon_grid_radial / FAQ）
- 加 deliberate_dna_divergence 字段（用于 SCOTT_OVERRIDE 标注）
```

### 9.3 generate_v2 改动

```
- 新增 cutout_whitelist 参数
- 行 627 if 条件改为支持 per-screen 喂图控制
- 默认行为：除 spec_table / FAQ 外全喂
```

### 9.4 单测改动范围

```
test_refine_planner_v2.py：
- 新增：测 11 屏型 role enum
- 新增：测 screen_count 边界 8/15
- 新增：测 FAQ 内容真实性约束
- 修改：_v2_sample fixture 加新屏型 role

test_pipeline_runner_v2.py：
- 新增：测 cutout_whitelist 默认行为
- 新增：测 cutout_whitelist={"hero"} 单屏喂
- 新增：测 cutout_whitelist=set() 全不喂

test_generator_v2.py：
- 新增：测 generate_v2 接受 cutout_whitelist 参数

预估测试数：170 → 180-185
```

### 9.5 v1 老路径回归保护（漏洞 1 补丁）⭐ 重要

**任何代码改动后必须保 v1 path 完全不挂**。

**强制流程**：

```
每次 SYSTEM_PROMPT_V2 / schema_v2 / generate_v2 改动完成后：

1. 跑 v1 单测：
   .venv/Scripts/python.exe -m unittest 
   ai_refine_v1.tests.test_refine_processor 
   ai_refine_v1.tests.test_pipeline_runner_v1
   
   全过 → 继续
   挂 → 立刻 git checkout 撤销改动 → 重新设计

2. 跑 v1 端到端 smoke test：
   找一个能跑通 v1 的产品文案
   走完整 v1 path（plan → render → assemble → output）
   确认输出图片能正常生成
   
   能生成 → 继续
   失败 → 撤销改动

3. v1 + v2 全套 170 测必须全过（含 1 skipped pyyaml）

4. 这个流程是 PRD v3 的硬约束 - 不允许跳过
   原因：v1 是生产环境正在跑的路径
```

### 9.6 临时脚本标准模板（漏洞 2 补丁）

**所有 .stage6_*.py 临时脚本必须使用此模板**：

```python
"""阶段六临时脚本

跑法:
    python .stage6_<task>.py --dry    # dry-run 验证
    python .stage6_<task>.py --real   # 真调 APIMart

跑完即删 (项目铁律: 临时 .py 跑完即删).
"""

from __future__ import annotations
import argparse
import os
import sys
import time
from pathlib import Path

# 标准 boilerplate - 所有临时脚本必须包含这两行
from dotenv import load_dotenv
load_dotenv()  # 从项目根 .env 加载 GPT_IMAGE_API_KEY 等

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# ... 其他业务代码

if __name__ == "__main__":
    sys.exit(main())
```

**强制约束**：缺 `load_dotenv()` 二行 → 必然失败 → 不允许提交此种脚本运行

### 9.7 阶段六产物落盘规范（漏洞 4 补丁）

**新建目录**：`stage6_real_test/`

```
stage6_real_test/
├── _design_reference/                              (素材分析报告留档)
├── v3_iteration_1_<ts>_<product>_<屏数>screens/    (第 1 次迭代)
├── v3_iteration_2_<ts>_<product>_<屏数>screens/    (第 2 次迭代，如有)
├── v3_iteration_3_<ts>_<product>_<屏数>screens/    (第 3 次迭代，如有)
└── v3_final_<ts>_<product>_PASS/                   (最终通过版)

加进 .gitignore (跟 stage5_real_test 同款规则)
```

**meta.json 标准字段**：

```json
{
  "iteration": 1,
  "product_name": "DZ600M",
  "scott_score_9_dimensions": {
    "1_warm_color": "PASS",
    "2_product_consistency": "PASS",
    "3_no_logo": "PASS",
    "4_chinese_text_accurate": "PASS",
    "5_info_density": "PASS",
    "6_cross_screen_unity": "FAIL",
    "7_color_harmony": "PASS",
    "8_taobao_clarity": "PASS",
    "9_overall_feel": "PASS"
  },
  "scott_score_total": "8/9",
  "scott_decision": "PASS"
}
```

### 9.8 commit message 标准模板（漏洞 7 补丁）

```
feat(refine-v3): PRD v3 — 扬子混合路线 + 11 屏型 + 8-15 屏动态

【铁律标记】
deliberate_iron_rule_5_break — 触发原因: documentary 路线
跟 B2B 消费品客户期待错配。本次推倒后铁律 5 立即重置。

【主要改动】
- SYSTEM_PROMPT_V2: 9733 → ~11500 字符 (准则 2/7 重写, 准则 8 新增)
- schema_v2: screen_count 6-10 → 8-15, role enum 8 → 11
- generate_v2: 加 cutout_whitelist 参数支持 per-screen 喂图控制
- 单测: 170 → ~185 测全绿

【新增屏型】
- scenario_grid_2x3 (6 实景应用网格)
- icon_grid_radial (径向配件围绕)
- FAQ_Q&A (法律合规硬约束)

【验收】
- 9 维度 Scott 打分 X/9 PASS
- ¥X.XX 真测烧钱 (X 次迭代)
- ¥XX.XX 累计 (≤ ¥70 上限)

【经验日志】
1. 铁律重置触发条件:
   "当 SYSTEM_PROMPT_V2 整体设计语言跟客户期待不匹配时
    (不是局部 patch 能解决), 才允许 deliberate_iron_rule_5_break"
2. 客户类型决定 prompt 工程方向:
   "B2B 工业品 vs B2B 消费品的 prompt 工程语言差异巨大"
3. SCOTT_OVERRIDE 是 PRD 一等公民:
   "v2 实战发明的 SCOTT_OVERRIDE 不是 hack, 是合法逃逸阀"
4. FAQ 类内容必须从文案抽取, 不允许 AI 编:
   "涉及商业承诺 (保修/退换/认证) 的内容如果 AI 编造, 
    会引发法律风险"

【遗留】
- 1086 vs 1536 维度 (阶段三 polish)
- jinja2 模板优化 (下阶段)
- simplify 代码 (v3 稳定后)
```

---

## 10. v3 commit 后的回归保护（漏洞 8 补丁）

### 10.1 监控期 1 周

```
v3 commit 完成后 1 周内：

✅ v1 path 仍在生产跑 (v3 是开发分支)
✅ 内部继续真测 5-10 个不同产品 (Scott 同事跑)
✅ 任何回归出现 → 触发"v3 hotfix"流程
```

### 10.2 hotfix 规则

```
hotfix 仅修当前 commit 暴露的具体 bug：
- hotfix 不算重新触发铁律 5
- hotfix 不能改 PRD v3 的方向
- hotfix 不能扩 SYSTEM_PROMPT_V2 改动范围
- 每个 hotfix 必须有具体的 bug 描述 + 修复证据
```

### 10.3 切上生产的条件

```
满足以下全部条件才允许切到生产环境替换 v1：
✅ 5 个不同产品类型都跑过且 ≥ 7 维度 PASS
✅ 1 周内 0 critical bug
✅ Scott 拍板"可以切上生产"
```

### 10.4 v4 启动条件

```
如果 1 周内出现 ≥ 3 critical bug：
- 自动触发"PRD v4 启动"讨论
- 不允许 hotfix 累积导致 v3 偏离原 PRD
- 重新走 PRD 撰写流程 (Scott 决策 + Claude 顾问 + Claude Code 执行)
```

---

## 11. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | SYSTEM_PROMPT_V2 第 5 次推倒后引入新趋同问题 | 中 | 中 | 单测覆盖关键词回归 |
| 2 | 11 屏型扩展让 DeepSeek schema 输出不稳定 | 中 | 中 | schema_v2 严格校验 + retry 机制兜底 |
| 3 | 风格转向后跟 B 方案"边界划分原则"冲突 | 低 | 中 | 明确 logo negative 沿用 B 方案，不动 |
| 4 | 8-15 屏动态后单产品成本 ¥7-12 | 高 | 低 | Scott 已确认按张数结算，成本上升不影响 |
| 5 | 3 次迭代用完仍不达验收标准 | 中 | 高 | git revert 退路明确，不陷入死循环 |
| 6 | DeepSeek 生成 FAQ 时仍可能编造 | 低 | 高 | 单测 + 硬约束 + 文案抽取硬性要求 |
| 7 | v1 → v3 直接替换生产环境出问题 | 低 | 高 | v3 commit 后留 1 周观察期 |
| 8 | 改代码搞挂 v1 老路径 | 中 | 高 | 9.5 节强制 v1 回归保护流程 |

---

## 12. 阶段六完成定义

```
本次 PRD v3 实施 = 阶段六完成的最小必要条件：

✅ 1 条样品产品（当前为 DZ600M）8-15 屏完整跑通
✅ 9 维度 ≥ 7 票 PASS
✅ commit 落盘
✅ 工程经验日志固化
✅ v1 path 不挂 (170 测全绿)

阶段六其他产品验收：
→ 不在本 PRD 范围
→ Scott 觉得 v3 效果可用就给同事去跑
→ 同事跑出来的反馈未来作为 v4 的输入
```

---

## 13. Harness Engineering 执行规则（核心）

### 13.1 Scott 介入点（仅 1 处）⭐

```
唯一介入点：看图打分（最多 4 次：第 1 次跑 + 最多 3 次迭代）
   - Claude Code 真调出整套屏后
   - Scott 用浏览器看图
   - 按 9 维度打分模板填表（见 13.5 节）
   - ≥ 7 票 PASS → Claude Code 自动 commit
   - < 7 票 → Claude Code 自动按 8.3 节诊断映射调改 + 重跑

Scott 不需要做：
❌ 审 prompt 文本
❌ 审代码改动
❌ 审 dry-run 结果
❌ 审 commit message
❌ 决定迭代方向
❌ 解决 bug
❌ 看测试结果
```

### 13.2 Claude Code 自洽执行清单

**Claude Code 在 Scott 介入点之间的完整自主行为范围**：

```
代码改动：
✅ 改 SYSTEM_PROMPT_V2（按本 PRD 第 9.1 节范围）
✅ 改 schema_v2（按本 PRD 第 9.2 节）
✅ 改 generate_v2（按本 PRD 第 9.3 节）
✅ 改单测（按本 PRD 第 9.4 节）
✅ 自己跑测试套件
✅ 测试挂自己 debug + 修复
✅ web search 找答案（边界见 13.6 节）
✅ 不确定的自己看代码现状判断

v1 回归保护：
✅ 每次代码改动后自动跑 9.5 节 v1 回归流程
✅ v1 挂自动 git checkout 撤销
✅ 重新设计改动方案

真调流程：
✅ 写真调代码用 9.6 节标准模板（含 load_dotenv）
✅ 自己 dry-run 验证 prompt 装配 + data URL
✅ dry-run OK 自己 GO real（不用问 Scott）
✅ 真调失败自己重试
✅ 重试 3 次仍失败自己换策略

迭代决策（按 8.3 节失败诊断映射）：
✅ Scott 打 9 维度分后，自己按映射表确定改哪段 prompt
✅ 自己改 → 自己测 → 自己 dry-run → 自己 real → 重新让 Scott 看图
✅ 不需要问 Scott "要不要重跑" "要怎么改"

commit：
✅ 9 维度 ≥ 7 票 PASS 后自己 commit
✅ commit message 用 9.8 节标准模板自动生成
✅ 不需要 Scott 确认 commit 时机

落盘：
✅ 用 9.7 节 stage6_real_test/ 目录规范
✅ 每次迭代 v3_iteration_N，最终 v3_final
✅ meta.json 用 9.7 节标准字段
```

**Claude Code 不能做的事**：

```
❌ 触碰 v1 代码
❌ 自动 git push（commit OK，push 不允许）
❌ 跨过 9.1 节范围扩 SYSTEM_PROMPT_V2 改动
❌ 自行扩展屏型库（11 屏型外不加）
❌ 自行修改 9 验收维度
❌ 自行改 ¥70 预算上限
❌ 编造 FAQ 内容（违反法律合规硬约束）
❌ 跨过 8-15 屏数边界
❌ 跳过 9.5 节 v1 回归保护流程
❌ 临时脚本省略 load_dotenv()
```

### 13.3 异常处理（Claude Code 自洽，不问 Scott）

```
异常 1：单测全过但真调出图不达标
   → Scott 9 维度打分后按 8.3 节诊断映射调
   → 自动重跑

异常 2：真调 API 报错
   → 自动诊断（网络 / API key / payload）
   → 自动重试 max 3 次
   → 仍失败汇报 Scott (这是少数需要 Scott 介入的异常)

异常 3：测试失败
   → 自动 debug
   → web search 找解决方案 (按 13.6 节边界)
   → 自动修复

异常 4：v1 回归挂
   → 自动 git checkout 撤销改动
   → 重新设计改动方案
   → 不允许"先 commit v3 再修 v1"

异常 5：3 次迭代仍不达标
   → 自动 git revert 回 commit 0a13500
   → 自动写"迭代失败原因分析"日志
   → 自动汇报 Scott

异常 6：预算逼近 ¥70
   → 自动停下，汇报当前进度给 Scott
   → 等 Scott 决策

异常 7：Scott 打分中 Claude Code 不认识的屏型 / 文件
   → 立刻汇报 Scott，不私自处理
```

### 13.4 失败 → 调改的完整自洽循环

```
循环开始：
  Claude Code 生成 8-15 屏 + assembled
  ↓
  print 9 维度打分模板给 Scott
  ↓
  Scott 看图填表 (5-10 分钟)
  ↓
  Scott 回复："PASS 1/3/4/5/7/8/9, FAIL 2/6"
  ↓
  Claude Code 解析 Scott 回复:
  - PASS 7 票 ≥ 7 → 进 commit
  - FAIL 维度 = {2, 6}
  ↓
  Claude Code 按 8.3 节映射:
  - 维度 2 FAIL → 检查 cutout_whitelist + INJECTION_PREFIX
  - 维度 6 FAIL → 调 A/B 风格分配表
  ↓
  Claude Code 改 prompt → 跑测试 → dry-run → real
  ↓
  重新 print 9 维度打分模板给 Scott
  ↓
  循环 (最多 3 次)
  ↓
  3 次仍 < 7 → git revert + 汇报 Scott
循环结束
```

### 13.5 Scott 9 维度打分模板（漏洞 5 补丁）⭐

**Claude Code 真调完图后必须自动 print 此模板给 Scott 填**：

```
=================================
PRD v3 第 N 次迭代验收 - 请打分
=================================

请在浏览器打开以下 8-15 张图，按 9 维度 PASS/FAIL：

图片路径列表：
- screen_01_hero.jpg
- screen_02_feature_wall.jpg
- ...
- assembled.jpg (完整长图)

完整路径：stage6_real_test/v3_iteration_N_<ts>_<product>_Mscreens/

=================================
9 维度打分清单
=================================

维度 1: 风格暖色阳光向上
  hero/brand_quality/value_story 暖色
  [ ] PASS  [ ] FAIL

维度 2: 产品形态全屏一致
  含产品屏跟参考图对齐
  [ ] PASS  [ ] FAIL

维度 3: 0 logo 出现
  全图无 brand logo
  [ ] PASS  [ ] FAIL

维度 4: 中文文字准确
  所有「」标记 0 错字
  [ ] PASS  [ ] FAIL

维度 5: 信息密度足够
  非 hero 屏 ≥ 3 信息单元
  [ ] PASS  [ ] FAIL

维度 6: 跨屏风格统一感
  整套屏过渡自然
  [ ] PASS  [ ] FAIL

维度 7: 配色协调
  ≤ 3 主色调，无冲突色
  [ ] PASS  [ ] FAIL

维度 8: 跟扬子标杆通俗易懂
  跟 design 文件夹标杆相比
  [ ] PASS  [ ] FAIL

维度 9: 整体观感
  能给客户看了
  [ ] PASS  [ ] FAIL

=================================
通过门槛: ≥ 7 个 PASS
=================================

请回复格式（任选一种）：

格式 A (简洁): 
  "PASS 1/3/4/5/7/8/9, FAIL 2/6"
  
格式 B (详细):
  "PASS 7/9: 1✅ 2❌ 3✅ 4✅ 5✅ 6❌ 7✅ 8✅ 9✅"
  
格式 C (不达标 + 描述):
  "PASS 5/9: 维度 1/3/4/5/9 通过，
   维度 2/6/7/8 不通过：[简短描述哪里不对]"
```

### 13.6 web search 边界（漏洞 6 补丁）

**允许 Claude Code 主动 web search 的范围**：

```
✅ 代码层 bug:
   - PIL / urllib / json / unittest 等标准库报错
   - APIMart / DeepSeek API 文档查询
   - JSON schema 校验报错
   - Python 类型/类方法用法
   - Git 命令用法

✅ 工程问题:
   - 单测 mock 写法
   - 异常处理最佳实践
   - 文件 IO / 编码问题
```

**禁止 Claude Code web search 的范围**：

```
❌ prompt 工程方法论 (PRD v3 已定方向)
❌ 设计美学风格指南 (PRD v3 已定路线)
❌ 商业逻辑 / 客户类型分析 (Scott 已决策)
❌ "更好的" prompt / 风格 / 方案 (越界)
❌ 跟 PRD v3 框架冲突的方法

如果 web search 后想做 PRD v3 边界外的事 → 立刻停下汇报 Scott
```

### 13.7 Harness Engineering 总结

```
Scott 设缰绳 (PRD v3.1 = 本文档)
Claude (顾问) 做方向碰撞 + 决策记录 (已完成)
Claude Code 跑路线 (自洽执行 + 自洽 debug + 自洽 commit + 自洽迭代)

Scott 的 token 预算可承受 → Claude Code 不必为节省 token 频繁问 Scott
Scott 不参与 debug → Claude Code web search + 自洽诊断
Scott 介入只在 "看图打分" 1 处

PRD v3.1 是封闭契约：
- Claude Code 在本 PRD 边界内有 100% 自主权
- 越界立刻停下 + 汇报 Scott
- Scott 9 维度打分是唯一决策入口
- 其余全部 Claude Code 自洽
```

---

## 14. PRD v3.1 验收（Scott 审本文档时检查的事）

```
本 PRD v3.1 文档本身的验收：

✅ 14 个决策点全部记录 (第 1.3 节)
✅ 设计语言路线明确 (第 2 节)
✅ 11 屏型完整列出 (第 3 节)
✅ 屏数动态机制清楚 (第 4 节)
✅ 阶段四集成正式化 (第 5 节)
✅ SCOTT_OVERRIDE 模式定义 (第 6 节)
✅ FAQ 法律合规约束 (第 7 节)
✅ 9 维度验收标准 (第 8 节)
✅ 失败诊断映射表 (8.3 节，漏洞 3 补)
✅ v1 回归保护流程 (9.5 节，漏洞 1 补)
✅ 临时脚本标准模板 (9.6 节，漏洞 2 补)
✅ stage6_real_test 落盘规范 (9.7 节，漏洞 4 补)
✅ commit message 模板 (9.8 节，漏洞 7 补)
✅ v3 commit 后回归保护 (第 10 节，漏洞 8 补)
✅ Scott 9 维度打分模板 (13.5 节，漏洞 5 补)
✅ web search 边界 (13.6 节，漏洞 6 补)
✅ Scott 介入点压缩到 1 处 (第 13 节)
✅ 通用语言（不绑定特定产品名，服务全产品矩阵）
```

---

## 附录 A：本次 PRD 撰写过程的元规则

```
本 PRD 用 Harness Engineering 思路撰写：

1. Scott 通过苏格拉底式问答 (8 组 + 4 个深度追问) 确定 14 个决策点
2. Claude (顾问) 把决策点结构化为 PRD 文档
3. Claude Code (执行者) 拿 PRD 自洽实现 (含自洽 debug + 自洽 commit + 
   自洽迭代)

Claude (顾问) 的能与不能：
✅ 把 Scott 决策点的连锁影响讲清楚
✅ 把潜在风险登记下来给 Scott 知情
✅ 把 Claude Code 自洽执行的边界写清楚
❌ 跨过 Scott 决策点擅自给方向
❌ 在 PRD 写自己的"专业判断"覆盖 Scott 决策

Claude Code (执行者) 的能与不能：
✅ 自己 debug 任何代码层问题
✅ 自己 web search 找解决方案 (在 13.6 节边界内)
✅ 自己跑测试 + 自己修复
✅ 自己 dry-run + 自己 GO real
✅ 自己迭代 prompt + 自己重跑
✅ 9 维度 ≥ 7 票后自己 commit
✅ 3 次迭代失败自己 git revert
❌ 替 Scott 做决策 (除了 9 维度评分这个 Scott 必须亲做的事)
❌ 跨过 PRD 写的边界做改动
❌ 改了不测就 commit
❌ 失败不汇报继续硬跑
❌ 触碰 v1 代码
❌ 跳过 v1 回归保护流程
❌ 临时脚本省略 load_dotenv()
```

---

**END OF PRD v3.1 (Claude Code 全自洽版)**
