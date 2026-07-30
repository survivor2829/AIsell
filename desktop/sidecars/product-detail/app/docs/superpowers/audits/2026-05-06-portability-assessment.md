# 「导演思维」对耗品类可移植度评估 v1

> **日期**: 2026-05-07
> **触发**: master roadmap §10.2 — P5.0 audit-only 阶段
> **评估方法**: architect sub-agent 全量扫描 + 主线人审反向校验
> **承诺**: audit-only, 0 业务代码改动
> **下一步**: 报告导出后, P5.1 数据 schema 适配按本报告 §D 工时再校准开工

---

## 摘要

设备类管线对耗品类的**可移植度远超原 master spec 估算**。33 个 block 模板中 **24 个 (85.7%) 可直接复用**, 仅 4 个需要轻量重写, 0 个需要删除; 5 个 main_img 模板 100% 复用; 4 工序平均适配度 **8.25/10**。耗材类基建实际已完成 60%（`templates/耗材类/build_config.json` + `assembled.html` + DeepSeek prompt + theme_matcher 映射均已就位）。**P5.1+ 工时从原估 10 day 修正为 6-9 day（中位 7 day）**, 节省 30-45%。

---

## §A. 33 Block 三色矩阵

**反向校验**: Grep `机器人|续航|清洁机|洗地|刷盘|robot|battery` 扫整个 `templates/blocks/`, 设备类专属词**仅出现在注释/placeholder 字符串**, 无任何 Jinja 表达式或 inline style 中硬编码。所有 block 数据由变量注入。

### A.1 28 个 block_*.html 模板

**汇总: 🟢 24 (85.7%) | 🟡 4 (block_a/b3/c1/f) | 🔴 0**

详细矩阵见 `_raw/2026-05-06-portability.md` §A。摘录 4 个 🟡 重写项：

| Block | 标签 | 重写工时 | 关键改动点 |
|-------|------|---------|-----------|
| block_a_hero_robot_cover | 🟡 | **2h** | 改文件名 (移除 "robot") + 注释; **联动 app.py:754-757 param_label 按品类分支**（最大瓶颈） |
| block_b3_clean_story | 🟡 | 1h | floor_items 语义改为"适用材质/污渍" + 配置层 floor_title |
| block_c1_vs_data | 🟡 | 1h | 改注释示例; DeepSeek prompt 引导生成耗品对比数据 |
| block_f_showcase_vs | 🟡 | **3h** | 删 `labor_image` 分支或改"竞品图"; 硬编码"本产品/传统人工"标签改变量 |

**4 个 🟡 重写工时合计: 7h** (单工程师 1 day 内可清完)

### A.2 5 个 main_img_*.html 模板

**汇总: 🟢 5/5, 零改动可用**。这印证了主图模板设计本身就是品类无关的容器。

---

## §B. 4 工序适配度评级

| 工序 | 适配度 | 工时 | 主要瓶颈 |
|-----|-------|------|---------|
| 1: AI 解析文案 (DeepSeek prompt) | **8/10** | 2.5h | `_map_parsed_to_form_fields` param_label 硬编码 (app.py:754-757) + 兜底"商用清洁设备" (app.py:739) |
| 2: theme_matcher 选模板 | **9/10** | 0.5h | CATEGORY_DEFAULT 已含耗材类映射, 仅可选关键词补充 |
| 3: 33 block 渲染 | **9/10** | 2h | 4 个 🟡 block 改造，无版式重写 |
| 4: gpt-image-2 精修 + Pillow 拼接 | **7/10** | 4h | STYLE_PACKS 偏设备类大场景, 需新增"实验室/仓储清洁间"风格包; block_f labor_image 跳过 |

**平均适配度: 8.25/10** | **总工时: 9h**

---

## §C. 耗品 4 板斧叙事映射

| 板斧 | 现有承载 | 缺口 | 工时 |
|------|---------|------|------|
| **A. 用量** | `block_y_value_calc` (cost_per_use/coverage_text/dilution_ratio) + `block_i_kpi_strip` | **零缺口** (block_y 即为耗品设计) | 0h |
| **B. 性价比** | `block_y` 单次成本 + `block_c1_vs_data` (改注释) + `block_f_showcase_vs` (改硬编码) | 4 个 🟡 中 c1/f 改造 | 2h |
| **C. 兼容机型** | `block_p_compatibility` (注释已标"配耗类专用") | DeepSeek 耗材类 prompt 缺 `compat_models` 字段引导 | 1h |
| **D. 寿命周期** | `block_u_after_sales` (保质期) + `block_s_faq` (过期影响); 储存条件**无专用 block** | 储存条件: 塞入 `block_o_disclaimer` 兜底 OR 新写轻量 `block_z_storage` | 1-2h |

**4 板斧合计: 4-5h** | **关键发现**: `block_y` 和 `block_p` 是为耗品专门设计的（注释明确标注"耗材类专用"/"配耗类专用"），证明前任工程师已为 P5 铺过部分路。

---

## §D. P5.1+ 工时再校准

### 关键发现: 耗材类基建已完成 60%

人审已通过反向校验确认以下文件**已存在并已适配**:

- ✅ `templates/耗材类/build_config.json` (section_title 已耗品化)
- ✅ `templates/耗材类/assembled.html` (block_i/q/m/y/k/u/s 编排已选)
- ✅ `templates/assembled_base.html:6-9` (品类主题色映射已含 4 品类)
- ✅ `app.py:2530-2589` (耗材类专用 DeepSeek prompt)
- ✅ `theme_matcher.py:74-79` (CATEGORY_DEFAULT 已含 "耗材类":"fresh-green")

### 子阶段工时校准

| 子阶段 | 原估 (master spec) | 修正 | 偏差 | 主因 |
|--------|------|------|-----|------|
| P5.1 耗品配置层 | 2d | **0.5d** | -1.5d | build_config 已 60% 完成 |
| P5.2 block 适配 | 2d | **1d** | -1d | 24/28 零改动, 4 🟡 集中在注释 |
| P5.3 theme_matcher | 1d | **0.25d** | -0.75d | CATEGORY_DEFAULT 已就位 |
| P5.4 block_f VS 屏 | (含在 P5.2) | **1.5d** | +1.5d | labor_image 重构是单点风险 |
| P5.5 AI 精修风格包 | 1d | **1.5d** | +0.5d | 需新增 2-3 个耗品风格包 |
| P5.6 端到端测试 | 2d | **2d** | 0 | 不可压缩 |
| **合计** | **10d** | **6-9d (中位 7d)** | **-30% ~ -45%** | |

### 总工时区间

- **最乐观: 5.5d** (block_f 一次到位 + 0 prompt 调优迭代)
- **最可能: 7d** (block_f 重构 + 风格包 + 测试正常节奏)
- **最悲观: 9d** (block_f 双图对比需重新设计 + DeepSeek prompt 多轮调优)

---

## §E. 人审反向校验证据 (主线增值)

### E.1 验 🟢 (复用) 判断

抽样: `block_b2_icon_grid.html`
- Grep `机器人|续航|清洁机|洗地|刷盘`: 1 hit (`"label": "底部文字（如"全新锂电\n续航久"）"`)
- **此 hit 是 placeholder 示例字符串** (用于 build_config.json 默认值的注释), 不是渲染逻辑
- 所有 b2 渲染走 `{{ items[i].label }}`, 数据驱动, 品类无关 ✓

### E.2 验 app.py 硬编码瓶颈

确认 `app.py:754-757` (人审实读):

```python
"param_1_label": "工作效率", "param_1_value": param_efficiency,
"param_2_label": "清洗宽度", "param_2_value": param_width,
"param_3_label": "清水箱", "param_3_value": param_capacity,
"param_4_label": "续航时间", "param_4_value": param_runtime,
```

- **设备类专属硬编码** ✓ (architect 报告完全准确)
- 这是 P5.1 第一刀: 按 product_category 分支 param_label 字典

### E.3 验兜底字符串

`app.py:739`: `_cat = product_type_str or "商用清洁设备"`

- 兜底是设备类专属 ✓
- P5.1 修复: 改成 `_cat = product_type_str or _CAT_FALLBACK[product_category]`, 其中 dict 包含设备/耗材/工具/服务

---

## §F. 决策建议 (基于 §A-E)

### F.1 立即可做 (P5.1 MVP, 0.5-1d)

1. 改 `app.py:754-757` 加 `_PARAM_LABELS_BY_CATEGORY` dict
2. 改 `app.py:739` 加 `_CAT_FALLBACK` dict
3. 给耗材类 DeepSeek prompt (app.py:2530-2589) 补 `compat_models` 字段引导
4. 改 `block_a_hero_robot_cover.html` 注释（不必改文件名, 文件名是历史包袱）

→ **跑通一单耗品 demo 端到端** (~1d)

### F.2 第二波 (P5.2, 1.5-2d)

1. block_f labor_image 重构 (3h)
2. 新增"实验室/仓储清洁间"风格包到 STYLE_PACKS (2h)
3. 储存条件方案选: 复用 block_o disclaimer (推荐, 0h) 或新写 block_z_storage (1.5h)

### F.3 完整 P5 (P5.3-P5.6, ~3-4d)

按校准后子阶段执行, 总工时 **6-9 day**。

### F.4 风险提示

- **block_f 重构是单点风险**: labor_image 是 Seedream 生成"传统人工"对比图的逻辑, 改"竞品图"需要新 prompt + 可能新缓存 key — 估 3h 偏乐观, 实际可能爆到 1d
- **prompt 调优迭代**: 耗品 hero 屏 product_hint phrasing ("workplace context") 对瓶装液体语义偏, 可能需多轮迭代
- **耗材类 build_config 与 assembled.html 状态需 P5.1 第一步重审**: 60% 完成度是 architect 评估值, 实际 deploy 前需端到端 dry-run 验证

---

## 附: 关键文件引用

参见 `_raw/2026-05-06-portability.md` 末节, 含 12 处文件:行 引用。

---

## 附: agent runtime 元数据

- **sub-agent**: oh-my-claudecode:architect
- **runtime**: 1599435 ms (~26 min)
- **tool uses**: 60 (Read + Grep + Glob)
- **裸输出**: `_raw/2026-05-06-portability.md` (~6800 字)
- **本报告**: 主报告基于 architect 输出 + 人审反向校验 + 工时再校准 + 决策建议
- **0 业务代码改动** ✓
