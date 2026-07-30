# 耗品类可移植度评估报告 (Architect Agent 原始输出)

**日期**: 2026-05-07
**Agent**: oh-my-claudecode:architect (sub-agent)
**评估范围**: 33 block 模板 + 5 main_img 模板 + 4 工序管线
**方法**: 全量 Read + Grep 反向校验,零猜测
**Runtime**: 1599435 ms (~26 min)
**Tool uses**: 60

> **状态**: 此为 architect agent 原始输出,未经人审。主报告在 `2026-05-06-portability-assessment.md`,人审会基于本文件做反向校验和工时再校准修正。

---

## §A. 33 Block 三色矩阵

**反向校验结论**: Grep `机器人|续航|智能|ROI|robot|battery|洗地|扫地|清洁机|驾驶式|手推式|刷盘|吸水|水箱|污水|清水` 扫描 `templates/blocks/` 全目录,设备类专属词**仅出现在 HTML 注释 (comment/docstring)**,无一处在渲染代码 (Jinja 表达式或 inline style) 中硬编码。所有 block 的数据全部由 Jinja 变量注入。

| # | block_name | 标签 | 一句话理由 | 重写工时(h) | 关键改动点 |
|---|-----------|------|----------|-----------|----------|
| 1 | block_a_hero_robot_cover | 🟡 重写 | 文件名含"robot",注释提及"机器人";渲染逻辑品类无关但需改名+注释;`app.py:754-757` 硬编码参数条标签"工作效率/清洗宽度/清水箱/续航时间"需按品类分支 | 2h | 改文件名+注释; `_map_parsed_to_form_fields` 按 product_category 分支 param_label |
| 2 | block_b2_icon_grid | 🟢 复用 | 纯数据驱动: items/title_num/title_text 全由变量注入; 注释里"续航久"仅为示例 | - | - |
| 3 | block_b3_clean_story | 🟡 重写 | 注释写"设备类卖点竖屏";`floor_items`(地坪适用宫格)对耗品需改为"适用材质/污渍类型"语义;渲染代码本身品类无关 | 1h | 改注释; 配置层把 floor_title 改为"适用场景" |
| 4 | block_c1_vs_data | 🟡 重写 | 注释示例"锂电vs铅酸";版式(左右两列对比)通用,但耗品需改为"浓缩液vs散装/竞品";数据结构不变 | 1h | 改注释示例; DeepSeek prompt 引导生成耗品对比数据 |
| 5 | block_c3_vs_upgrade | 🟢 复用 | "升级前vs升级后"版式品类通用(如"旧配方vs新配方");纯数据驱动 | - | - |
| 6 | block_d1_scene_hero | 🟢 复用 | 场景大图+文字叠加,纯数据驱动;无品类硬编码 | - | - |
| 7 | block_d2_product_detail | 🟢 复用 | 白底大图+文字,纯数据驱动;注释示例"操作简单"属通用UX | - | - |
| 8 | block_e_glass_dimension | 🟢 复用 | 参数表+尺寸标注纯数据驱动;specs[] 按 build_config 的 ai_detail_key_priority 填充,耗材类已有适配版("容量/稀释比/PH值") | - | - |
| 9 | block_f_showcase_vs | 🟡 重写 | 模板内硬编码"本产品"/"传统人工"标签(`app.py:52-62`);`labor_image`(Seedream生成人工图)概念对耗品不适用;VS对比行版式可复用,但需改为"本品vs散装/竞品" | 3h | 删 labor_image 分支或改为"竞品图"; 改硬编码标签为变量; prompt 适配 |
| 10 | block_g_brand_story | 🟢 复用 | 品牌背书纯数据驱动;brand_stats/brand_story_lines 品类无关 | - | - |
| 11 | block_h_scene_grid | 🟢 复用 | 适用场景网格纯数据驱动;耗品同样有场景(医院/酒店/工厂) | - | - |
| 12 | block_i_kpi_strip | 🟢 复用 | KPI大数字条纯数据驱动;耗材类 build_config 已设 section_title="产品数据" | - | - |
| 13 | block_j_core_tech | 🟢 复用 | 核心技术列表纯数据驱动;耗品可填"活性配方/环保因子/缓蚀技术" | - | - |
| 14 | block_k_cert_badges | 🟢 复用 | 资质认证纯数据驱动;耗材类已设 section_title="安全认证" | - | - |
| 15 | block_l_service_compare | 🟢 复用 | 服务对比(官方vs普通商家)品类通用;纯数据驱动 | - | - |
| 16 | block_m_steps | 🟢 复用 | 使用流程纯数据驱动;注释示例"加注清水"仅为示例;耗材类已设 section_title="使用方法" | - | - |
| 17 | block_n_quote_cta | 🟢 复用 | CTA 纯数据驱动;耗材类已有适配的 highlights("厂家直供/批量优惠/配方定制") | - | - |
| 18 | block_o_disclaimer | 🟢 复用 | 免责声明纯数据驱动;耗材类已设适配文案("按推荐稀释比例使用") | - | - |
| 19 | block_p_compatibility | 🟢 复用 | 注释已标注"配耗类专用";数据结构(compat_models)正好承载耗品的"兼容机型"叙事 | - | - |
| 20 | block_q_before_after | 🟢 复用 | 注释已标注"耗材类/工具类通用";使用前后对比纯数据驱动;耗材类已设 section_title="清洁效果对比" | - | - |
| 21 | block_r_package_list | 🟢 复用 | 包装清单纯数据驱动;品类无关 | - | - |
| 22 | block_s_faq | 🟢 复用 | FAQ 纯数据驱动;耗材类已设 section_title="常见问题" | - | - |
| 23 | block_t_customer_cases | 🟢 复用 | 客户案例纯数据驱动;品类无关 | - | - |
| 24 | block_u_after_sales | 🟢 复用 | 售后承诺纯数据驱动;耗材类已有适配 promises("SGS/0磷/3年保质期/1v1指导") | - | - |
| 25 | block_v_model_compare | 🟢 复用 | 型号对比表纯数据驱动;耗品可对比不同规格/浓度 | - | - |
| 26 | block_w_video_cover | 🟢 复用 | 视频封面纯数据驱动;品类无关 | - | - |
| 27 | block_x_durability | 🟢 复用 | 实测数据条纯数据驱动;耗品可填"去污率/杀菌率/残留率" | - | - |
| 28 | block_y_value_calc | 🟢 复用 | 注释已标注"耗材类专用";cost_per_use/coverage_text/dilution_ratio 完美承载"性价比"叙事;耗材类已有适配 config | - | - |

**汇总**: 🟢 24 个 (85.7%) | 🟡 4 个 (block_a/b3/c1/f) | 🔴 0 个

### §A.2 五个 main_img 模板

| # | 模板名 | 标签 | 理由 |
|---|-------|------|------|
| 1 | main_img_1_white_bg | 🟢 复用 | product_image/logo_image/model_name 品类无关 |
| 2 | main_img_2_gradient_hero | 🟢 复用 | slogan/sub_slogan/product_image 品类无关 |
| 3 | main_img_3_specs_callout | 🟢 复用 | spec_callouts[] 纯数据驱动;耗品可填"稀释比/PH值" |
| 4 | main_img_4_scene_blend | 🟢 复用 | scene_image/advantages 品类无关 |
| 5 | main_img_5_selling_points | 🟢 复用 | advantages/brand_text 品类无关 |

**main_img 汇总**: 🟢 5/5,零改动可用。

---

## §B. 4 工序适配度评级

### 工序 1: AI 解析文案 (DeepSeek prompt -> JSON)

**适配度: 8/10**

- **已做**: `app.py:2530-2589` 已有完整的耗材类专用 prompt,输出 schema 含 `kpis`/`usage_steps`/`before_after`/`block_b2_items` 等耗品字段;`_build_category_prompt()` 按 product_type 分支。
- **改动点**:
  1. prompt 缺耗品 4 板斧的 **寿命周期** 字段 (开封后保质期/储存条件/过期影响),需补 `shelf_life`/`storage_conditions` 到 JSON schema (~1h)
  2. `_map_parsed_to_form_fields()` 的 `param_1-4_label` 硬编码设备类参数名("工作效率/清洗宽度/清水箱/续航时间",`app.py:754-757`),耗品需按品类分支为"容量/稀释比/适用场景/保质期" (~1h)
  3. `app.py:739` 最终兜底 "商用清洁设备" 需改为按品类映射 (~0.5h)
- **预估工时**: 2.5h

### 工序 2: theme_matcher 选模板

**适配度: 9/10**

- **已做**: `theme_matcher.py:74-79` 的 `CATEGORY_DEFAULT` 已含 `"耗材类": "fresh-green"`;关键词规则("环保/绿色/可降解" -> fresh-green)覆盖耗品常见词。
- **改动点**:
  1. 可增加耗品特有关键词 ("浓缩/食品级/消毒" -> fresh-green 或其他主题),但非必须 (~0.5h)
- **预估工时**: 0.5h

### 工序 3: 33 block 渲染 (Jinja + CSS)

**适配度: 9/10**

- **已做**: 耗材类 `build_config.json` 已存在且 section_title 已适配;`assembled.html` 已选择了 block_i/q/m/y/k/u/s 的耗品适配子集;`assembled_base.html` 已有品类主题色映射。
- **改动点**:
  1. block_a 文件名和注释 (~0.5h)
  2. block_f 的 "本产品/传统人工" 硬编码标签 (~1h)
  3. `assembled.html` 可能需补 block_p(兼容机型)到耗品序列 (~0.5h)
- **预估工时**: 2h

### 工序 4: gpt-image-2 精修 + Pillow 长图拼接

**适配度: 7/10**

- **已做**: `prompt_templates.py` 的 SCREEN_VARIANTS 全部品类无关(纯环境/光影/材质描述);`ai_image_router.py` 无品类硬编码;`ai_refine_v2/screen_types.py` 的 ScreenType 是品类无关的抽象。
- **改动点**:
  1. `prompt_templates.py:571` 的 `product_hint="commercial driving-type floor scrubber"` 是测试用例,实际 `build_prompt()` 的 product_hint 由调用方传入,但 hero 屏的 "workplace context where {product_hint} would be used" 对耗品(瓶装液体)语义略偏,需调 prompt phrasing (~1h)
  2. STYLE_PACKS 的场景描述 ("工业权威/商业展厅/奢华酒店") 偏设备类大场景,耗品需增加 "实验室/仓储/清洁间" 类风格包 (~2h)
  3. block_f 的 labor_image (Seedream 生成人工劳动图) 对耗品无意义,精修管线需跳过或替换 (~1h)
- **预估工时**: 4h

---

## §C. 耗品 4 板斧叙事映射

### A. 用量 (一瓶能用多少次/多久/几个机型)

| 维度 | 现有承载 | 缺口 | 方案 | 工时 |
|------|---------|------|------|------|
| 每次用量/覆盖面积 | block_y_value_calc (`coverage_text`, `cost_per_use`) | 无 | 直接复用,config 已适配 | 0h |
| 稀释比 | block_y_value_calc (`dilution_ratio`) | 无 | 直接复用 | 0h |
| 用量明细 | block_y_value_calc (`calc_items`) | 无 | 直接复用 | 0h |
| KPI 展示 | block_i_kpi_strip | 无 | 直接复用,填"每瓶可用N次" | 0h |

**结论**: 完全覆盖,零缺口。block_y 是为耗品专门设计的。

### B. 性价比 (单次成本/跟散装竞品对比)

| 维度 | 现有承载 | 缺口 | 方案 | 工时 |
|------|---------|------|------|------|
| 单次成本 | block_y (`cost_per_use`) | 无 | 直接复用 | 0h |
| 跟竞品对比 | block_c1_vs_data / block_f_showcase_vs | 需改造 | block_c1 改注释+prompt引导;block_f 改硬编码标签 | 2h |

**结论**: 基本覆盖。block_c1 的 VS 数据对比版式天然适合"浓缩液 vs 散装"对比,仅需 prompt 引导。

### C. 兼容机型 (适配哪些机器人/跨品牌)

| 维度 | 现有承载 | 缺口 | 方案 | 工时 |
|------|---------|------|------|------|
| 适配型号列表 | block_p_compatibility | 无 | 直接复用,注释已标"配耗类专用" | 0h |
| DeepSeek 解析 | `_build_category_prompt()` 耗材类 prompt | 已含 compat_models? | **缺口**: 耗材类 prompt (`app.py:2530`) 未要求 compat_models 字段,但配耗类 prompt (`app.py:2469`) 有 | 1h |

**结论**: 模板层零缺口。DeepSeek prompt 层耗材类需补 `compat_models` 字段引导 (~1h)。

### D. 寿命周期 (开封后保质期/储存条件/过期影响)

| 维度 | 现有承载 | 缺口 | 方案 | 工时 |
|------|---------|------|------|------|
| 保质期数字 | block_u_after_sales (已配"3年保质期"卡片) | 无 | 直接复用 | 0h |
| 储存条件/开封后寿命 | **无专用 block** | **缺口** | 方案1: 塞入 block_o_disclaimer 的 disclaimer_text; 方案2: 新写 block_z_storage (~15行 Jinja,1个"储存条件"卡片组) | 1-2h |
| 过期影响 | block_s_faq | 无 | FAQ 里加一条"过期后能用吗?" | 0h |

**结论**: 保质期/过期影响已有承载,储存条件可用 block_o 兜底或新写轻量 block (~1-2h)。

---

## §D. P5.1+ 工时再校准

master spec 估 P5.1-P5.6 共 ~10 day。基于本次评估:

### 关键发现: 耗材类基建已完成 60%

`耗材类/build_config.json` + `耗材类/assembled.html` + 耗材类 DeepSeek prompt + `CATEGORY_DEFAULT` + `_theme_colors` 映射已全部就位。这意味着 P5.1 的"配置层搭建"工作量比预估小得多。

### 可压短的子阶段

| 子阶段 | 原估 | 修正 | 理由 |
|--------|------|------|------|
| P5.1 耗品配置层 | 2d | 0.5d | build_config.json 已存在且已适配;仅需补 compat_models 到 prompt + param_label 品类分支 |
| P5.2 block 适配 | 2d | 1d | 24/28 block 零改动;4 个 🟡 block 改动集中在注释/标签/prompt,不涉及版式重写 |
| P5.3 theme_matcher | 1d | 0.25d | 已有 category_default 映射,仅需可选关键词补充 |

### 可能爆的子阶段

| 子阶段 | 原估 | 修正 | 理由 |
|--------|------|------|------|
| P5.4 block_f VS 屏重构 | 含在 P5.2 | 独立 1.5d | "本产品/传统人工" 硬编码标签 + labor_image Seedream 生成逻辑 需较大改造; 如果要保留双图对比能力(本品vs竞品图),需改 prompt + 模板 + 精修管线 |
| P5.5 AI 精修风格包 | 1d | 1.5d | 需新增耗品适配风格包("实验室/仓储清洁间");hero 屏 product_hint phrasing 需调整;STYLE_PACKS 新增 2-3 个 |
| P5.6 端到端测试 | 2d | 2d | 不可压; 需真实耗品文案走完 4 工序全流程 |

### 总工时修正

| 维度 | 原估 | 修正 | 置信区间 |
|------|------|------|---------|
| 最乐观 | - | 5.5 day | 所有 🟡 block 改造顺利,无 prompt 调优迭代 |
| 最可能 | 10 day | 7 day | block_f 重构 + 风格包 + 测试正常节奏 |
| 最悲观 | - | 9 day | block_f 双图对比需重新设计 + DeepSeek prompt 需多轮调优 |

**结论: 原估 10 day 偏保守,实际 6-9 day (中位 7 day)**。主要节省来自耗材类基建已完成 60%、24/28 block 零改动的事实。主要风险来自 block_f VS 屏重构和 prompt 调优迭代。

---

## 附: 关键文件引用

- `templates/耗材类/build_config.json` -- 耗材类配置已存在,section_title 已适配
- `templates/耗材类/assembled.html` -- 耗材类 block 编排已存在(i/q/m/y/k/u/s)
- `templates/assembled_base.html:6-9` -- 品类主题色映射已含4品类
- `app.py:754-757` -- **硬编码瓶颈**: param_label 写死设备类参数名
- `app.py:739` -- **硬编码瓶颈**: 兜底"商用清洁设备"
- `app.py:2530-2589` -- 耗材类 DeepSeek prompt 已存在
- `theme_matcher.py:74-79` -- CATEGORY_DEFAULT 已含 "耗材类":"fresh-green"
- `templates/blocks/block_y_value_calc.html` -- 耗材类专用 block,完整承载"用量+性价比"
- `templates/blocks/block_p_compatibility.html` -- 配耗类专用 block,承载"兼容机型"
- `templates/blocks/block_f_showcase_vs.html:52-62` -- 硬编码"本产品/传统人工"标签
