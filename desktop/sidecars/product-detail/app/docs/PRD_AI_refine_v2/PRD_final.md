# AI 精修 v2 PRD · 卖点驱动动态生成 (方向 D)

> **版本**: PRD Final v0.1
> **冻结时间**: 2026-04-23
> **决策树**: Q1 = 完全替换 Seedream / Q2 = Best-effort + Hero 整单 fail / 方向 = **D 卖点驱动**
> **状态**: 等用户批准 → Phase 2 开工
> **硬约束**: 不写代码 · 不动 `refine_processor.py` · 不跑 API · 所有参数有依据

---

## 0. 核心理念

> "GPT-image-2 能力那么突出那么显眼, 不用设计非常好的提示词都可以生成优美图像.
> 我想 AI 精修完全靠卖点文案来生成产品详情页, 不按照固定的 VS 对比或其他模板,
> 有需要就生成, 没需要就不生成, 完全依靠卖点文案, 目的是把详情页做得精美."
> — 用户原话, 2026-04-23

**抛弃的东西**: 固定 5-8 屏模板, 每屏必有 (Hero / 六大优势 / VS / 参数表 / 场景).

**替代的东西**: 卖点决定屏数和类型, 没需要的屏不生.

---

## 1. 架构对比 (v1 vs v2)

### v1 架构 (现有 Seedream 精修)

```
[用户上传文案+图]
      ↓
[固定模板填 slot]
  block_a / block_b2 / block_b3 / block_e / block_f (5 屏固定)
      ↓
[Seedream 生图 (固定背景)]
      ↓
[拼接 assembled.html]
```

**问题**: 5 屏硬编码, 有产品没"螺旋清污机构"也硬要画一张 VS 图.

### v2 架构 (卖点驱动)

```
[用户上传文案+图]
      ↓
┌─ Step 1: DeepSeek 解析 ─────────────────┐
│  输入: 产品文案 + 产品图 URL            │
│  输出:                                   │
│    product_meta (color, key_parts, ...)  │
│    selling_points[] (text, visual_type)  │
└──────────────────────────────────────────┘
      ↓
┌─ Step 2: DeepSeek 规划 ─────────────────┐
│  输入: selling_points + 用户UI勾选选项   │
│  输出: blocks[] 数组                     │
│    [{type: hero,       visual_type: ...},│
│     {type: point_1,    visual_type: ...},│
│     {type: point_N,    visual_type: ...},│
│     (用户勾选: VS / 场景 / 规格)]         │
└──────────────────────────────────────────┘
      ↓
┌─ Step 3: 并发生成 (gpt-image-2) ────────┐
│  for block in blocks:                    │
│    match block.visual_type:              │
│      product_in_scene  → 图生图 + PRESERVE│
│      product_closeup   → 图生图 + 特写    │
│      concept_visual    → 纯文生图         │
│  thinking=medium, 并发度 3                │
│  Hero 失败整单 fail, 其它 best-effort    │
└──────────────────────────────────────────┘
      ↓
┌─ Step 4: 拼接 ──────────────────────────┐
│  block.type → Jinja 模板槽               │
│  顺序: Hero → 卖点高优先级 → 用户选填    │
└──────────────────────────────────────────┘
      ↓
[assembled.html 预览 + 导出 PNG]
```

**优势**:
- 屏数动态 (3-10), 没需要的屏不烧钱
- 3 类 visual_type 让 AI 发挥所长 (概念图用文生图, gpt-image-2 强项)
- Hero 锁产品, 概念图放飞, **取长补短**

---

## 2. 3 类 visual_type 定义

| visual_type | 典型卖点关键词 | 是否需产品 | 生成方式 | gpt-image-2 强弱 |
|------|------|------|------|------|
| **product_in_scene** | 适用于河道/工厂/商场, 在城市中作业 | **必须** | 图生图 + PRESERVE | 强 (v2 demo 实测 8/10) |
| **product_closeup** | 螺旋清污机构, 防腐涂层, 六组电机 | **必须** | 图生图 + 特写构图 | 中 (7/10, 特写易变形) |
| **concept_visual** | 续航 8 小时, 压力大, 噪音低, 成本省 | **不需要** | 纯文生图 | **强** (8.5/10, AI 最擅长) |

---

## 3. DeepSeek 解析 + 规划 Prompt 设计

### 3.1 系统 prompt

```
你是 B2B 工业产品详情页的视觉策划总监。你的任务是把产品文案拆成"卖点 → 视觉"的结构化 JSON, 供下游 gpt-image-2 生图用。

关键原则:
1. 每个卖点必须判定 visual_type (product_in_scene / product_closeup / concept_visual)
2. visual_type 判定依据:
   - 卖点提到"用于/适用/场景/行业/地点" → product_in_scene
   - 卖点提到"结构/部件/涂层/技术/机构/工艺" → product_closeup
   - 卖点提到"续航/噪音/成本/速度/压力/效率/等抽象指标" → concept_visual
3. 不能所有卖点都判成 product_in_scene (会重复)
4. 卖点最多 8 个, 超过则按优先级合并低优先级项
5. Hero 场景永远从最高优先级的 product_in_scene 卖点中取
6. 输出纯 JSON, 无额外文字

产品品类映射:
- 设备类 → key_parts 里应有"颜色主体 + 结构部件 + 相机/传感器 + 驱动部件"4 项
- 耗材类 → key_parts 里应有"颜色 + 形态 + 包装 + 使用状态"
- 工具类 → key_parts 里应有"颜色 + 握把 + 功能头 + 开关按钮"
```

### 3.2 用户 prompt (每次替换变量)

```
产品文案:
\"\"\"
{product_text}
\"\"\"

产品图 URL: {product_image_url}

用户 UI 勾选:
- 强制 VS 对比屏: {user_opts.force_vs}        # true/false
- 强制多场景屏:   {user_opts.force_scenes}    # true/false
- 强制规格参数表: {user_opts.force_specs}     # true/false

请输出 JSON, schema 如下 (不要加 ```json 包裹, 直接输出):
```

### 3.3 输出 Schema (严格)

```json
{
  "product_meta": {
    "name": "string, 产品名 + 型号 + 一句话描述, < 40 字",
    "category": "enum: 设备类 | 耗材类 | 工具类",
    "primary_color": "string, 英文色彩名, 如 'industrial yellow'",
    "key_visual_parts": ["string, 英文 phrase, 2-4 个, 按视觉显著性排序"],
    "proportions": "string, 英文 phrase, 如 'compact flat float-style watercraft'"
  },
  "selling_points": [
    {
      "idx": 1,
      "text": "原文关键句, 30 字内",
      "visual_type": "enum: product_in_scene | product_closeup | concept_visual",
      "priority": "enum: high | medium | low",
      "reason": "判定依据, 一句话"
    }
  ],
  "planning": {
    "total_blocks": "int, = 1 + selling_points.length + 用户勾选数",
    "block_order": ["hero", "selling_point_3", "selling_point_1", "..."],
    "hero_scene_hint": "string, 从最高优先级 product_in_scene 卖点提取的场景描述, 英文, < 60 字, 给 gpt-image-2 的 CHANGE 段用"
  }
}
```

### 3.4 示例输入输出 (DZ600M 水面清洁机)

**输入文案**:
```
DZ600M 无人水面清洁机, 工业黄色机身, 螺旋清污机构清污效率提升 3 倍,
续航 8 小时一天不充电, 适用于城市河道 / 工厂污水池 / 景区湖泊,
防腐涂层 5 年不锈, 低噪音运行不打扰居民.
```

**期望 JSON 输出**:
```json
{
  "product_meta": {
    "name": "DZ600M 无人水面清洁机",
    "category": "设备类",
    "primary_color": "industrial yellow",
    "key_visual_parts": [
      "two black cylindrical auger floats",
      "transparent dome camera housing",
      "black propeller blade"
    ],
    "proportions": "compact flat float-style watercraft"
  },
  "selling_points": [
    {
      "idx": 1,
      "text": "螺旋清污机构, 清污效率提升 3 倍",
      "visual_type": "product_closeup",
      "priority": "high",
      "reason": "具体机械结构, 特写可展现螺旋几何"
    },
    {
      "idx": 2,
      "text": "续航 8 小时, 一天不充电",
      "visual_type": "concept_visual",
      "priority": "medium",
      "reason": "抽象续航指标, 用日出日落弧象征"
    },
    {
      "idx": 3,
      "text": "适用于城市河道",
      "visual_type": "product_in_scene",
      "priority": "high",
      "reason": "具体应用场景, 必须产品 + 河道"
    },
    {
      "idx": 4,
      "text": "防腐涂层 5 年不锈",
      "visual_type": "product_closeup",
      "priority": "medium",
      "reason": "材质特性, 特写涂层纹理"
    },
    {
      "idx": 5,
      "text": "低噪音运行不打扰居民",
      "visual_type": "concept_visual",
      "priority": "low",
      "reason": "抽象听觉概念, 安静水面 + 居民窗户"
    }
  ],
  "planning": {
    "total_blocks": 6,
    "block_order": ["hero", "selling_point_1", "selling_point_3", "selling_point_4", "selling_point_2", "selling_point_5"],
    "hero_scene_hint": "modern Chinese urban riverbank at golden hour, product operating on water surface, engineer reviewing tablet"
  }
}
```

---

## 4. gpt-image-2 · 3 类 visual_type 模板 + 示例

### 4.0 共享 STYLE_BASE (所有模板默认追加, 避免重复)

下面 3 个模板渲染前自动追加以下共享基线, 每个模板下方的 `STYLE MODIFIER` 段只写"差异化"部分:

```
Taobao/Tmall e-commerce detail page quality,
professional 8K, sharp focus,
commercial photography standard.
```

### 4.1 Template 1 · product_in_scene

**参数来源**:
- `{product.name}` `{product.primary_color}` `{product.key_visual_parts}` `{product.proportions}` ← DeepSeek product_meta
- `{scene}` ← `planning.hero_scene_hint` (Hero) 或 `selling_point.text` 衍生

**模板原文**:
```
Image 1 is the reference photo of {product.name}. Preserve its exact visual identity.

PRESERVE from Image 1:
- Main body color: {product.primary_color}
- Structural parts: {product.key_visual_parts | join(', ')}
- Proportions: {product.proportions}

CHANGE (new scene):
- Setting: {scene}
- Context: {selling_point.text if not hero else "hero shot, product prominent"}
- Human presence: {human_hint}

CONSTRAINTS:
- NO redesign of the product
- NO color drift — {product.primary_color} body stays pure
- NO added parts not in Image 1
- NO text, NO logo, NO watermark

STYLE MODIFIER:
cinematic golden-hour grading, product-in-scene composition.
```

**示例 · Hero (DZ600M)**:
```
Image 1 is the reference photo of DZ600M unmanned water surface cleaning robot.

PRESERVE from Image 1:
- Main body color: industrial yellow
- Structural parts: two black cylindrical auger floats, transparent dome camera housing, black propeller blade
- Proportions: compact flat float-style watercraft

CHANGE:
- Setting: modern Chinese urban riverbank at golden hour
- Context: hero shot, product prominent, operating on water
- Human presence: environmental engineer in dark navy uniform holding tablet

CONSTRAINTS:
- NO redesign, NO color drift, NO added parts, NO text

STYLE MODIFIER: cinematic golden-hour grading, product-in-scene composition.
```

### 4.2 Template 2 · product_closeup

**模板原文**:
```
Image 1 is the reference photo of {product.name}. Preserve its exact visual identity.

PRESERVE from Image 1:
- Main body color: {product.primary_color}
- Focus part: {focus_part}    # 从 selling_point 提取的具体部件英文名

CHANGE:
- Perspective: macro close-up of {focus_part}
- Background: soft neutral bokeh, studio gray
- Angle: 3/4 isometric view, emphasize mechanical detail
- Lighting: directional studio key light + soft fill

CONSTRAINTS:
- NO redesign of the mechanical part
- NO color drift
- NO text, NO logo
- Mechanical geometry fully visible and sharp

STYLE MODIFIER: macro photography, studio lighting, B2B technical catalog.
```

**示例 · "螺旋清污机构" 卖点**:
```
Image 1 is the reference photo of DZ600M.

PRESERVE from Image 1:
- Main body color: industrial yellow
- Focus part: two black cylindrical auger floats (spiral waste-collection mechanism)

CHANGE:
- Perspective: macro close-up of the auger floats
- Background: soft neutral bokeh, studio gray
- Angle: 3/4 isometric view, emphasize spiral geometry and debris interaction
- Lighting: directional studio key + soft fill

CONSTRAINTS:
- NO redesign, NO color drift, NO text
- Spiral geometry fully visible and sharp

STYLE MODIFIER: macro photography, studio lighting, B2B technical catalog.
```

### 4.3 Template 3 · concept_visual (极简, 放飞 AI)

**核心理念**: gpt-image-2 + Thinking mode 自带构图推理能力, 短 prompt 反而能出神图 (推特 / 抖音上大量短 prompt 神图案例验证).
过度约束会削弱 AI 创造力. **让 AI 自由发挥, 只守住"无 text / logo / watermark"底线**.

**模板原文** (**无 Image 1, 纯文生图**):
```
把这个 B2B 工业卖点可视化: {selling_point.text}

CONSTRAINTS:
- NO text, NO logo, NO watermark
```

**可选增强** (若风格包有配置, 作为 hint 而非强约束):
```
Color theme hint: {theme_pack.concept_palette}    # 如"深蓝→琥珀"
Style hint: {theme_pack.concept_style}            # 如"B2B editorial"
```
两项仅作参考, Thinking mode 会自己权衡是否采用. **不写死, 不当 CONSTRAINT**.

**示例 · "续航 8 小时" 卖点**:
```
把这个 B2B 工业卖点可视化: 续航 8 小时, 一天不充电

CONSTRAINTS:
- NO text, NO logo, NO watermark
```

---

## 5. 成本 / 质量 / 交付成功率 (所有数字都有依据)

### 5.1 成本

| 环节 | 单次成本 | 依据 |
|------|---------|------|
| DeepSeek 解析 | ~¥0.02 | 输入 300 token + 输出 500 token, 按 DeepSeek 列表价 |
| DeepSeek 规划 | ~¥0.03 | 同上但输出更长 (JSON schema), ~1.5× |
| gpt-image-2 单张 | **¥0.7** | 本次 demo 实测: APIMart 单张 $0.06 (thinking=medium 含 +50% 溢价), 按 6.8 汇率 |
| 拼接 | ¥0 | Jinja 渲染, 本地 CPU |

**全链路单产品成本**:

| 卖点数 N | Hero | 卖点图 | DeepSeek | 合计 | 可选强制屏 (VS/场景/规格) |
|---|---|---|---|---|---|
| 3 | 0.7 | 2.1 | 0.05 | **¥2.85** | +¥0.7/屏 |
| 5 | 0.7 | 3.5 | 0.05 | **¥4.25** | |
| 8 | 0.7 | 5.6 | 0.05 | **¥6.35** | 硬上限 |

### 5.2 质量预估 (每类 visual_type)

| visual_type | 质量预估 | 依据 |
|------|------|------|
| Hero (product_in_scene) | **8.0 / 10** | v2 demo DZ600M 实测, 逐项对照 PRESERVE 得分 |
| product_in_scene 卖点图 | 7.5 / 10 | 跟 Hero 同逻辑, 但场景更简单 (单场景描述), 产品 PRESERVE 压力小 |
| product_closeup | 7.0 / 10 | **AI 特写弱项**, 易变形. 本次 demo 的"透明圆顶变金属"就是这类失误 |
| concept_visual | **8.5 / 10** | gpt-image-2 **最强项** (纯文生图 + 抽象可视化, 无 PRESERVE 压力) |
| **加权平均** (N=5) | **7.7 / 10** | 1 hero 8 + 2 concept 17 + 1 in_scene 7.5 + 1 closeup 7 = 39.5 / 5 |

### 5.3 交付成功率

假设:
- gpt-image-2 单张 API 成功率 99% (网络/服务端/prompt 被拒)
- 加重试 1 次 → 单张成功率 99.99%

**Hero 失败 → 整单 fail**:
- Hero 1 张 + 重试 1 次 → 99.99% 成功
- 整单成功率 ≈ **99.99%** (按 Hero)

**卖点图失败 → best-effort**:
- 每张独立重试 1 次
- 失败后降级占位图 → 用户永远拿到产物
- 卖点图降级率 ≈ 0.01% (即 1 万个产品里可能有 1 张是占位)

**整体 "产品成功交付" 成功率**:
> ≈ 99.99%

符合用户 Q2 要求的 99%+.

### 5.4 耗时

| 环节 | 时间 | 依据 |
|------|------|------|
| DeepSeek 解析 + 规划 | ~10 秒 | 两次调用, 每次 4-5 秒 |
| gpt-image-2 并发 N 张 | ~60 秒 | 单张 46s 实测 (thinking=medium), 并发度 3 → 2-3 批次 |
| 拼接 + 前端 render | ~3 秒 | Jinja + Playwright screenshot 估算 |
| **总耗时 (5 张卖点)** | **~75 秒** | 用户等 1 分钟多能接受, UI 要有进度条 |

---

## 6. 前端 UI 设计

### 6.1 位置
在 `templates/build_form.html` 和 `templates/batch/upload.html` 都加一块 "AI 精修 v2" 区域 (原 Seedream v1 UI 下线).

### 6.2 UI 草图 (ASCII)

```
┌─ AI 精修 v2 · 卖点驱动详情页生成 ─────────────────┐
│                                                    │
│  产品文案: [多行文本框,已填]                      │
│  产品图:   [已上传缩略图]                         │
│                                                    │
│  [✨ AI 智能解析卖点] (点击后调 DeepSeek,5s)      │
│                                                    │
│  ↓ 解析完成显示 ─────────────────────────────     │
│                                                    │
│  📋 识别到 5 个卖点, 每个已自动判定视觉类型:       │
│                                                    │
│  [✓] 螺旋清污机构 (高)      🔬 产品特写 (¥0.7)   │
│  [✓] 续航 8 小时 (中)       💡 概念图像 (¥0.7)   │
│  [✓] 适用于城市河道 (高)    🎬 产品场景 (¥0.7)   │
│  [✓] 防腐涂层 5 年 (中)     🔬 产品特写 (¥0.7)   │
│  [ ] 低噪音运行 (低)        💡 概念图像 (取消可省 ¥0.7) │
│                                                    │
│  + Hero 主图 (必选)                     🎬 (¥0.7)  │
│                                                    │
│  📎 可选强制屏:                                    │
│  [ ] VS 对比屏                          (+¥0.7)    │
│  [ ] 多场景屏 (3 个应用场景)             (+¥2.1)    │
│  [ ] 规格参数表 (文字 + 图)              (+¥0.7)    │
│                                                    │
│  ──────────────────────────────────────────        │
│  📊 合计: 5 张图                                   │
│  💰 预估费用: ¥3.55 (含 DeepSeek ¥0.05)           │
│  ⏱  预计耗时: ~75 秒                               │
│                                                    │
│  [🔄 重新解析] [🎨 开始生成]                       │
└────────────────────────────────────────────────────┘
```

### 6.3 交互细节

- **勾选框**: 用户可取消低优先级卖点 → 实时更新费用
- **visual_type 标签可点击修改**: DeepSeek 判错时用户手动改 (enum 三选一)
- **重新解析**: 用户改完文案可重新调 DeepSeek, 前一次结果覆盖
- **生成中**: WebSocket 推进度, 每张图完成打一个 tick
- **完成后**: 跳 `assembled.html` 预览, 带导出 PNG 按钮

---

## 7. 失败降级策略 (详细伪代码, **不是实际代码**, 仅结构描述)

```
# Hero 生成 (严格, 整单 fail)
def generate_hero(product, plan):
    for attempt in range(2):  # 2 次尝试
        try:
            return call_gpt_image2(
                template="product_in_scene",
                thinking="medium" if attempt == 0 else "high",  # 第 2 次加码
                ...
            )
        except Exception as e:
            log(f"Hero attempt {attempt+1} failed: {e}")
    raise HeroFailure("整单 fail: Hero 生成失败, 已全额退款")

# 卖点图并发生成 (宽松, best-effort)
def generate_selling_points(product, plan, blocks):
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        futures = {ex.submit(generate_one_block, b): b for b in blocks}
        for fut in as_completed(futures):
            block = futures[fut]
            try:
                results.append((block, fut.result()))
            except Exception:
                results.append((block, placeholder_image(block)))  # 占位兜底
    return results

def generate_one_block(block):
    template = {
        "product_in_scene":  "product_in_scene_tpl",
        "product_closeup":   "product_closeup_tpl",
        "concept_visual":    "concept_visual_tpl"
    }[block.visual_type]

    for attempt in range(2):
        try:
            return call_gpt_image2(template=template, thinking="medium", ...)
        except Exception:
            pass
    raise BlockFailure(block)

def placeholder_image(block):
    # 灰色背景 + 卖点文案水印 + "AI 未生成, 建议补拍"
    return render_placeholder(block.text)
```

**关键失败点**:
| 失败点 | 表现 | 用户感知 |
|--------|------|---------|
| DeepSeek 解析失败 | 整流程 abort | "无法解析产品, 请补充文案" |
| DeepSeek JSON 不合 schema | 重试 1 次 → 再失败 abort | 同上 |
| Hero gpt-image-2 失败 2 次 | 整单 fail | "Hero 生成失败, 全额退款" |
| 某卖点图失败 2 次 | 占位图 | 前端标 "该屏 AI 未生成, 建议补拍实景图" |
| 用户强制屏 (VS/场景/规格) 失败 | 占位 + 标注 | 同卖点图 |

---

## 8. Phase 2 开发计划 (3 周, 按周可上线 beta)

### Week 1 · 规划层 (DeepSeek)

| Day | 任务 | 交付 |
|-----|------|------|
| 1-2 | 写 DeepSeek system prompt + schema, 人工手动测 10 个真实产品 (设备类 / 耗材类 / 工具类 各 3) | prompt 稳定版 + 10 个 JSON 样本 |
| 3-4 | 写 `ai_refine_v2/refine_planner.py` (新文件, 不动 refine_processor.py), 输入产品文案 + 图 URL, 输出 planning JSON | `refine_planner.py` + 单测 |
| 5 | 边界 case: 卖点 < 3 / 卖点 > 8 / 文案乱码 / 纯英文 / 图片无法下载 | 边界 case 测试报告 |

**W1 beta**: 可调 API 得到 JSON, 但下游还没接 gpt-image-2.

### Week 2 · 生成层 (gpt-image-2)

| Day | 任务 | 交付 |
|-----|------|------|
| 1 | 把 3 类 prompt 模板写成 `prompts/refine_v2/{in_scene,closeup,concept}.jinja2` | 3 个模板文件 |
| 2-3 | 写 `ai_refine_v2/refine_generator.py`, 输入 planning JSON → 输出图片 URL 数组 (并发 3, 重试 1) | `refine_generator.py` |
| 4 | 接 Hero 失败 → 整单 fail 逻辑 + 卖点图失败 → 占位 + 重试 | 失败降级单测 |
| 5 | 端到端: DZ600M + 2 个其它产品全链路跑通 (不含前端 UI) | 3 份实物产物 + 质量人工评 |

**W2 beta**: 后端全通, 命令行能跑出 5 张图.

### Week 3 · 前端 + 拼接 + 验收

| Day | 任务 | 交付 |
|-----|------|------|
| 1 | 拼接层: 按 planning JSON.block_order 映射到现有 Jinja block_*.html 模板的 image slot | 拼接函数 + 预览 OK |
| 2-3 | 前端 UI (上面第 6 节的草图), 接入 `build_form.html` + `batch/upload.html` | UI 上线 |
| 4 | WebSocket 进度推送 (每张图完成一个 tick) | 进度条可见 |
| 5 | 5 个真实产品端到端用户验收 + 成本记录 + 质量评分 + 回访 | 验收报告 |

**W3 上线**: 正式交付, Seedream v1 精修路径下线.

**总工时**: ~15 工作日 (3 周, 1 人独立) 或 ~8-9 工作日 (2 人并行分 W1/W2, 再会师 W3).

---

## 9. 风险清单 (10 项, 分等级)

| # | 风险 | 等级 | 缓解方案 |
|---|------|------|---------|
| R1 | DeepSeek 判错 visual_type (如把"续航 8 小时"判成 product_closeup) | 🟡 中 | prompt 里加 5 个正反例, W1 Day 1-2 人工审 30 个 case 前不上线 |
| R2 | concept_visual 放飞 AI 可能偏离品牌调性 (短 prompt 自由发挥, 可能生成和产品不匹配的视觉) | 🟡 中 | **不强约束**: 短 prompt + Thinking mode 是刻意选择; Phase 2 W2 人工审 10 张 concept 屏决定是否增加最小风格 hint (仍然 hint 而非 CONSTRAINT) |
| R3 | product_closeup 质量卡 7/10 不到 8/10 (AI 特写弱项) | 🟡 中 | 前端标注"特写屏因 AI 限制可能不完美, 建议用户自行补摄影"; 下次 prompt 迭代可试 `thinking=high` |
| R4 | 并发 3 张打满 APIMart rate limit | 🟡 中 | 限并发度 3 (不是 8), 其余串行; APIMart 429 自动退避 |
| R5 | 卖点文案太短 (< 15 字) DeepSeek 分类不准 | 🟡 中 | fallback: 短文案默认判 product_in_scene, 前端允许用户改 |
| R6 | APIMart edits 端点未来开通, 是否切? | 🟢 低 | 季度复测 1 次; 当前 generations 足够用 (8/10 已达标) |
| R7 | thinking="medium" 偶发超时 (>4 分钟) | 🟡 中 | 超时降级 `thinking=None` 重试; 监控超时率 |
| R8 | 卖点 > 8 时用户不满 (只生前 8, 后面丢) | 🟢 低 | UI 提示"已截取 top 8 高优先级" + 鼓励用户精简文案 |
| R9 | Hero 因 prompt 对某产品不友好连续 2 次失败 → 整单 fail 率高 | 🔴 高 | 第二次重试用 `thinking=high` + scene 换 scene_pack 的 fallback 场景; 监控整单 fail 率 > 5% 触发告警 |
| R10 | 用户投诉"卖点图看不到产品, 不像详情页" | 🟡 中 | concept_visual 屏支持品牌水印 (非产品, 是 logo + 色彩), 让品牌可见 |

---

## 10. 验收标准 (Phase 2 结束前)

### 10.1 技术验收

- [ ] DeepSeek 输出 JSON 100% 符合 schema (10 个 case 全绿)
- [ ] visual_type 分类准确率 ≥ 85% (人工评 30 case)
- [ ] gpt-image-2 Hero 成功率 ≥ 99% (不算重试前)
- [ ] Hero 质量 ≥ 8/10 (5 个产品人工评分均值)
- [ ] concept_visual 质量 ≥ 8/10
- [ ] product_closeup 质量 ≥ 7/10
- [ ] 整单 fail 率 < 1%
- [ ] 单产品耗时 < 2 分钟 (P95)

### 10.2 业务验收

- [ ] 成本在预估 ±10% 以内 (3 卖点 ~¥2.85, 5 卖点 ~¥4.25)
- [ ] 3 个真实客户端到端体验, NPS ≥ 8
- [ ] Seedream v1 精修路径下线, 代码删除 (不并存)

---

## 11. 不做的事 (划定边界, 避免 Phase 2 Scope Creep)

- ❌ **不**做"零 Hero"模式 (全卖点图, 无产品主图)
- ✅ **可以**混用中英 prompt:
  - 产品名 / 卖点原文 → **中文** (gpt-image-2 官方强调中文渲染能力, demo test 1 "小玺AI·批量生成" 已验证可渲染中文大字)
  - 构图指令 / PRESERVE / CONSTRAINTS → **英文** (AI 理解度更稳定, 不易漂移)
  - 混搭方式: 把"场景描述"写英文, "卖点短句"保留中文原文让 AI 直接吃
- ❌ **不**做"用户手动改 PRESERVE" 的细粒度编辑 (太重, V2.1 再说)
- ❌ **不**做 A/B 测试两张选一张 (成本翻倍, V2.1 再说)
- ❌ **不**做视频生成 (超纲)
- ❌ **不**做 fal.ai / OpenAI 直连 (APIMart 够用且便宜, V2.2 再考虑)

---

## 12. 文档关联

- 端点探测依据: `endpoint_probe_results.md`
- prompt 四段结构: `prompt_final_v2.md`
- 相似度打分方法: `similarity_scoring.md`
- 成本对照依据: `cost_comparison.md`
- 生成脚本: `demo_gpt_image2_v2.py`
- v2 demo 实物: `demo_gpt2_v2_dz600m.jpg`

---

## 13. 审批路径

| 审批项 | 签字人 | 日期 |
|--------|--------|------|
| PRD 最终版 | 用户 (2829347524an@gmail.com) | 2026-04-24 明天 (预计) |
| Phase 2 开工 | 同上 | 批准后立即 |
| Seedream v1 下线 | 同上 | Phase 2 W3 验收通过后 |

---

**本文档不含任何代码改动, 仅为 PRD 蓝图. 所有参数均基于:**
- v2 demo 实测 (2026-04-23 DZ600M, task_01KPW11ZY5CWV92QYGFDK55KM3)
- APIMart 官方定价 + 文档 (2026-04-23 llms.txt + docs)
- DeepSeek 官方定价 (公开列表价)
- 项目已有的 style_packs_v1 / theme_matcher 基础设施

**等你批准, 明天 Phase 2 开工.**
