# W1 Day 1-2 · DeepSeek 规划官 10 case 人工 Review 报告

> **生成时间**: 2026-04-23
> **Review 人**: Claude Opus 4.7 (人工 eyeball review, 非自动评估)
> **样本**: `docs/PRD_AI_refine_v2/w1_samples/01-10` (10 产品 × 5-7 卖点 = 58 sp)
> **结论**: visual_type 分类 93% 准确, 达 PRD § 10.1 目标. 但 2 个 P0 bug 需修 prompt 后再验证

---

## 1. 全局指标

| 维度 | 结果 |
|------|------|
| JSON schema 合规率 | **10/10 = 100%** (zero warnings) |
| 10 次调用总成本 | **¥0.022** (14,492 tokens, DeepSeek prompt cache 半命中) |
| 平均耗时 / 单次 | 22 秒 (cache 命中时 18s, 冷调用 26s) |
| **visual_type 整体准确率** | **54/58 = 93%** |
| **达 PRD § 10.1 目标 (≥85%)** | ✅ 达标 |

## 2. 逐产品准确率

| # | 产品 | 品类 | 准确率 | 突出问题 |
|---|------|------|--------|---------|
| 01 | DS500X 扫地机 | device | 6/7 = 86% | "IP54 适合室外" 误判 in_scene |
| 02 | HP3000 高压洗 | device | 5/5 = **100%** | |
| 03 | AP900 空净 | device | 5/6 = 83% | "风量 900m³/h 适合 150m²" 边界 |
| 04 | CC-100 清洁剂 | consumable | 6/6 = **100%** | 🔴 幻觉加字"耐用便携"(原文没有) |
| 05 | SM-200 地垫 | consumable | 5/6 = 83% | "可机洗可拼接" 误判 in_scene |
| 06 | MF-50 擦布 | consumable | 6/6 = **100%** | 🔴 key_visual_parts 留模板占位 |
| 07 | PL-600 抛光机 | tool | 5/6 = 83% | "1200W 铜线电机可变速" 边界 |
| 08 | ST-800 蒸汽 | tool | 6/6 visual_type = **100%** | 🟡 category 判成设备类(应工具类) |
| 09 | GC-30 水垢剂 | tool→consumable | 5/5 = **100%** | ✨ AI 帮我修正了品类(确实是耗材) |
| 10 | DZ600M | device | 5/5 = **100%** | baseline 完美 |

## 3. 分品类准确率

| 品类 | 准确 / 总 | 准确率 | 是否达 85% |
|------|----------|--------|-----------|
| 设备类 | 21/23 | **91%** | ✅ |
| 耗材类 | 22/23 | **96%** | ✅ |
| 工具类 | 11/12 | **92%** | ✅ |

## 4. visual_type 全局分布

| type | 数量 | 占比 | 评价 |
|------|------|------|------|
| product_in_scene | 14 | 24% | 正常 |
| product_closeup | 18 | 31% | 正常 |
| concept_visual | 26 | 45% | 正常 (B2B 卖点指标类本来就多) |

✅ **没有任何一个类型占比 > 80%**, 满足 "不能全判同一类型" 目标.

---

## 5. P0 Bug (必修)

### Bug 1 · key_visual_parts 出现模板占位符 (MF-50)

**证据** (样本 06):
```json
"key_visual_parts": ["color", "texture", "packaging", "usage_state"]
```

**根因**: PRD § 3.1 system prompt 里品类映射写"耗材类 → 颜色 + 形态 + 包装 + 使用状态", DeepSeek 把**类别名原样**当 phrase 抄进去.

**对照 (CC-100 正常)**:
```json
"key_visual_parts": ["blue HDPE plastic drum", "product label", "diluted solution in use", "sealed cap and handle"]
```

**影响**: 下游 gpt-image-2 PRESERVE 段拿到 "color" / "packaging" 这种空词, **直接让 v2 精修失效**. 级别 P0.

### Bug 2 · AI 改写/加字原文 (CC-100)

**证据** (样本 04, selling_points[0].text):
- 原文: `"5 升蓝色 HDPE 塑料桶包装"`
- AI 输出: `"5升蓝色HDPE塑料桶包装，耐用便携"`  ← 加了 "耐用便携"

**根因**: DeepSeek 默认"润色文案"习惯, 主动加修饰词.
**影响**: gpt-image-2 拿幻觉文案生图, 场景可能偏离产品真实描述. 级别 P0 (影响合成物真实性).

---

## 6. P1 Bug (建议修)

### Bug 3 · 边界陷阱 — "适/可" 字误导

3 个错分类共同点: 都含"适合/适用/可 XX"但**主语是认证/性能/功能**而非具体场景.

| 卖点 | AI 判 | 应判 | 为什么 |
|------|------|------|--------|
| IP54 防尘防水**适合**室外半户外 | in_scene | concept | 主语是 IP54 认证等级 |
| 处理风量 900m³/h **适合** 150m²车间 | in_scene | concept | 主语是 900m³/h 性能指标 |
| **可**机洗**可**拼接延展 | in_scene | concept | 主语是产品能力, 不是具体地点 |

### Bug 4 · 品类判定模糊 (ST-800)

ST-800 原文: "1.5L 不锈钢水箱 1800W 加热, 整机 3.5kg 便携家商两用".
**重量 3.5kg + 便携 + 手持形态** → 应判工具类, AI 判成设备类.
根因: system prompt 没给"便携 vs 固定"的重量/握把判定规则.

---

## 7. P2 (可接受)

- PL-600 "1200W 铜线电机可变速" 判 concept_visual: 兼有"铜线电机"(部件)和"可变速"(功能), 判 concept 也能解释. 不改.
- 所有 product_meta 其它字段 (name / primary_color / proportions) 在 10 个样本里都合理, 未发现系统性错误.

---

## 8. System Prompt 补丁 (增量, 非全新重写)

### 补丁 A · 修 Bug 1 (key_visual_parts 必须具体)

**替换原段落**:
```
- 设备类 → "颜色主体 + 结构部件 + 相机/传感器 + 驱动部件" 4 项
- 耗材类 → "颜色 + 形态 + 包装 + 使用状态"
- 工具类 → "颜色 + 握把 + 功能头 + 开关按钮"
```

**改成**:
```
产品品类映射 (key_visual_parts 必须是 2-4 个**具体可视英文短语**, 不是类别名):

- 设备类 维度(主色机身/主要结构/传感器或显示/驱动或底座):
  示例(扫地机器人): ["matte gray metal body", "circular LiDAR sensor",
                     "bottom brush module", "drive wheels"]

- 耗材类 维度(外观颜色/包装形态/标签印刷/使用状态):
  示例(清洁剂桶): ["blue HDPE drum", "product label with specifications",
                   "sealed cap and handle", "diluted solution pouring"]

- 工具类 维度(主色机身/握把/功能头/控制按钮):
  示例(抛光机): ["orange-black plastic body", "ergonomic rubber handle",
                 "7-inch sponge pad", "speed control dial"]

⚠️ 禁止把维度类别名 (如 "color" / "packaging" / "grip" / "texture" /
"usage_state") 当 phrase 填入. 看到这类通用词**必须**换成具体英文短语,
例如 "color" → "matte yellow aluminum body", "grip" → "black ergonomic rubber handle".
```

### 补丁 B · 修 Bug 2 (原文逐字抽取)

**在"关键原则"列表新增第 7 条**:
```
7. selling_points[].text 必须是产品文案的**逐字连续片段** (或其子串):
   - 不得添加文案中没有的形容词 / 状语 / 程度副词
   - 不得改写同义词 (如 "500kg/m²" 不能写成 "500kg per square meter")
   - 不得合并两条独立卖点成一句 (保留结构, 信息密度均衡)
   反例: 原文 "5升蓝色HDPE塑料桶包装"
         ❌ 输出 "5升蓝色HDPE塑料桶包装，耐用便携" (加了 "耐用便携")
         ✅ 输出 "5升蓝色HDPE塑料桶包装" (原文照搬)
```

### 补丁 C · 修 Bug 3 (边界陷阱反例)

**在 visual_type 判定规则后新增反例集**:
```
常见判定陷阱 — 即使含 "适合/适用/可 XX" 但 visual_type ≠ product_in_scene:

- "IP54 防尘防水适合室外半户外"   → concept_visual (主语是认证等级)
- "处理风量 900m³/h 适合 150m²"   → concept_visual (主语是性能指标)
- "可机洗可拼接延展"              → concept_visual (主语是功能能力)
- "500kg/m² 抗压可用于车间"       → concept_visual (主语是抗压强度)

判定口诀: 去掉 "适合/适用/可" 两三个字, 这卖点还在说**具体行业或地点**吗?
- 是 (商场/机场/河道/车间/厨房) → product_in_scene
- 否 (指标/等级/认证/能力)       → concept_visual
```

### 补丁 D · 修 Bug 4 (品类判定优先级)

**在"产品品类映射"前新增**:
```
品类判定优先级 (冲突时按此顺序):

1. 文案明说 "工具 / 设备 / 耗材" → 直接采纳
2. 看**形态**:
   - 便携手持 (< 10kg, 有握把, 人手操作) → 工具类
   - 固定安装 / 推车式 / 大型立柱 (≥ 20kg) → 设备类
   - 液体 / 片状 / 布片 / 膜 / 桶装 / 瓶装 / 喷雾 → 耗材类
3. 10-20kg 中间段: 看用法
   - 单人单手握持 → 工具类
   - 双手推行 / 定点部署 → 设备类
4. 不确定 → 设备类 (详情页视觉默认 fallback)
```

---

## 9. 下一轮 5 个新 Test Case (刻意陷阱)

每条文案都精确打中某个 P0/P1 bug, 验证补丁有效性:

### Case 11 · PC-80 便携手持工业吸尘器 (测补丁 D — 品类)
```
PC-80 便携手持工业吸尘器, 亮黑色机身配橙色按钮,
1200W 电机吸力 20kPa, 单手提握 3kg 整机重,
HEPA 过滤 99.97%, 2 米长软管 + 4 种刷头,
适用于车间地面 / 办公室死角 / 汽车内饰, 续航 45 分钟.
```
**陷阱**: 3kg 便携 + 单手提握 → 必须判**工具类** (补丁 D 生效).

### Case 12 · WW-20 多色玻璃水液体 (测补丁 A — key_visual_parts)
```
WW-20 多色玻璃水液体, 500ml PET 透明喷雾瓶,
柠檬黄 / 天空蓝 / 粉玫红三色可选, 中性配方 pH7,
一喷即净不留水痕, 适用于家用车挡风 / 商用洗车店 / 办公楼落地窗.
```
**陷阱**: 多色可选 + 通用包装 → 必须产出具体英文 phrase, 不能回退成 `["color", "packaging"]` (补丁 A 生效).

### Case 13 · DR-600 商用洗地机 (测补丁 C — 边界陷阱)
```
DR-600 商用洗地机, 哑光蓝金属机身,
IP66 防尘防水等级适合室外, 40L 水箱适合 2000m² 连续作业,
可调压力 2-8bar 适应不同地面, 续航 4 小时,
低噪音 < 58dB 适用于商场和写字楼, 附带 3 种刷盘.
```
**陷阱**: 4 个卖点同时含 "适合/适用/可", 但主语有认证 / 性能 / 真场景多种, 正确分类应该是 concept + concept + concept + in_scene 混合 (补丁 C 生效).

### Case 14 · CM-50 微纤维清洁布 (回归测 MF-50 bug)
```
CM-50 微纤维清洁布, 35×35cm 5 色可选, 80% 聚酯 + 20% 锦纶,
280gsm 克重厚实, 吸水量自身 6 倍, 机洗 300 次不变形,
适用于餐饮后厨 / 医院病房 / 酒店客房.
```
**陷阱**: 与 MF-50 结构几乎一样 → 验证补丁 A 真的修了 key_visual_parts 占位符 bug.

### Case 15 · FS-300 半便携推车式扫地机 (测补丁 D — 品类临界)
```
FS-300 半便携推车式扫地机, 哑光灰金属,
整机 15kg 带万向轮, 人工推行或一键电动行进,
24V 锂电续航 3 小时, 吸力 8000Pa, 适用于小型车间和商铺.
```
**陷阱**: 15kg 在 10-20kg 中间段 → AI 走 "看用法" 分支 → 双手推行 → **设备类** (不是工具类) (补丁 D 生效).

---

## 10. 下一步操作建议 (给用户)

1. **用户把补丁 A/B/C/D 合并到 `scripts/test_deepseek_planner.py` 的 `SYSTEM_PROMPT` 常量**
   (手动编辑, 不 commit, 临时跑一次验证)
2. **把 `PRODUCTS` 列表替换为 Case 11-15 (5 个新陷阱 case)**
3. **跑 `python scripts/test_deepseek_planner.py`**, 成本约 ¥0.01
4. **产物写到 `docs/PRD_AI_refine_v2/w2_samples/`** (新目录, 避免覆盖 w1_samples)
5. Claude 再 review 5 个新 JSON, 打分表给出, 判定补丁是否真修了 bug
6. 修好后: 把 PRD § 3.1 的 SYSTEM_PROMPT 正式替换成 v2 版, 进入 W1 Day 3-4 (写 refine_planner.py)

---

## 11. 诚实度自检

- [x] 逐条人工评判 58 个 selling_points (不是抽样)
- [x] 区分 P0 (必修, 影响 v2 精修不可用) / P1 (建议修) / P2 (可接受)
- [x] 每条 bug 都引用具体样本编号 + JSON 字段作为证据
- [x] 不粉饰 100% — CC-100 visual_type 100% 但有幻觉加字
- [x] 不回避 GC-30 AI 帮我修正品类 (承认 AI 判对了)
- [x] 判定陷阱用口诀给下次自我验证用
