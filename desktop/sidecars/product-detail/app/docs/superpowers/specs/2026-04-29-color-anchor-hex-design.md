# 设计文档：产品主图颜色保真 — PIL 主色提取 + 双图视觉锚定 (v3.2.2)

**日期**：2026-04-29
**作者**：Claude (Opus 4.7) + 用户协同 brainstorm
**前置 commit**：`7a77425 feat(refine-v3): v3.2.1 vision-first 颜色保真转向`
**问题源头**：用户实测 HE180/10 (浅白+灰色高压清洗车) 被 gpt-image-2 染成"浅灰+黄色"
**预期版本号**：v3.2.2

---

## 1. 背景：为什么需要这次升级

### 1.1 历史考古

| 阶段 | 表面观感 | 真实机制 | 失效条件 |
|---|---|---|---|
| 阶段五 (`0a13500`) | 3 产品颜色 OK | DeepSeek 文本猜测撞对 | 类目先验冲突时露馅 |
| v3.2 (`4575ab3`) | DZ70X 黑色保住 | 加硬编码颜色清单 (黑→黑/黄→黄/灰→灰) 暴力压制 | 清单覆盖不到的颜色组合露馅 |
| v3.2.1 (`7a77425`) | 待验证 | 砍 text-first 路径 + Image 1 vision 锚定 | gpt-image-2 vision encoder 被训练偏见压过 |
| **v3.2.2 (本设计)** | 目标：任意产品颜色一致 | PIL 像素级测量主色 + hex 数值锚 + 双图视觉锚定 | — |

### 1.2 v3.2.1 仍有的瓶颈

`refine_generator.py:575` 的 `_INJECTION_PREFIX_V3` 是纯文字约束，依赖 gpt-image-2 听话执行。当类目训练偏见极强时（清洗车 = 黄、消防车 = 红、起重机 = 橙），即便 INJECTION 写"Image 1 always wins"，模型仍可能违抗。

### 1.3 设计核心理念

**永远不要硬编码任何特定产品**。每张用户上传的主图都通过 PIL 像素级测量算出 RGB 主色 → hex 字符串数值锚 + 程序生成色卡 → 双视觉通道送进 gpt-image-2。算法对**所有**产品对称、零人工干预。

---

## 2. 目标 + 非目标

### 2.1 In-scope

- 后端用 PIL 从用户上传 cutout 算出主色 hex（PNG with alpha + JPG 白底两种格式都支持）
- `_INJECTION_PREFIX_V3` 升级为带 hex slot 的模板，把数值锚（B1）注入每屏 prompt
- `image_urls` 从单图升级为双图：`[cutout, color_swatch_png]`（B3 双图视觉锚定）
- 完整 fallback 链：anchor 失败 → 退回 v3.2.1 单图+纯文本，绝不打断生图主流程
- HE180/10 真测验证

### 2.2 Out-of-scope (YAGNI 砍掉)

- ✗ 反喂 planner（B2 路径） — 未来另立项
- ✗ 换 DeepSeek V4 — 独立 P1 任务，跟颜色无关
- ✗ 多模态 planner（VL2） — 独立 P2
- ✗ 缓存色卡到磁盘 — 内存生成够快
- ✗ 颜色风格预设 / 用户手动覆盖
- ✗ 删 planner schema `primary_color` 字段 — 留作日志

---

## 3. 架构

### 3.1 模块切分

```
ai_refine_v2/
├── color_extractor.py          # 新增 ~150 行
│   ├── @dataclass ColorAnchor
│   │      ├ primary_hex: str         例 '#6B7280'
│   │      ├ palette_hex: list[str]   top-3 簇 hex, 例 ['#6B7280', '#3A3D42', '#D8D8D8']
│   │      ├ confidence: float        主簇占非背景像素百分比 (0.0-1.0)
│   │      └ swatch_png_bytes: bytes  512x512 纯色 PNG, 用于 image_urls[1]
│   ├── extract_color_anchor(cutout_path: str | Path) -> ColorAnchor | None
│   ├── _filter_background_pixels()   PNG alpha < 128 + JPG luminance > 240 & saturation < 0.05
│   ├── _kmeans_via_quantize()        Pillow Image.quantize(colors=5, method=MEDIANCUT)
│   └── _render_swatch_png(hex, size=512)
│
├── refine_generator.py         # 现有, 改 ~40 行
│   ├── _INJECTION_PREFIX_V3_TEMPLATE   带 {primary_hex} {palette_str} 的 f-string
│   ├── _INJECTION_PREFIX_V3_LEGACY     v3.2.1 那段, 作 fallback
│   ├── generate_v2 入口加: anchor = extract_color_anchor(product_cutout_url)
│   ├── _generate_one_block_v2 签名: 接 ColorAnchor | None
│   └── _submit_image_task: image_urls=[cutout_data_url, swatch_data_url] (双图)
│
└── tests/
    ├── test_color_extractor.py    # 新增 ~120 行
    └── test_refine_generator_v2.py # 现有, 改 ~15 行 (修 INJECTION 文案断言)
```

### 3.2 数据流

```
用户上传 cutout.png/jpg
   │
   ▼
generate_v2(planning_v2, product_cutout_url=cutout, ...)
   │
   ├─ STEP 1 (新增): anchor = extract_color_anchor(cutout)
   │       ├─ 失败 → anchor=None, log warn, 走 v3.2.1 fallback
   │       └─ 成功 → ColorAnchor(primary='#6B7280', palette=[...], swatch_bytes=...)
   │
   ├─ STEP 2 (改): for each whitelisted screen:
   │       ├─ image_urls = [_to_data_url(cutout), _to_data_url_from_bytes(swatch)] if anchor.swatch_png_bytes
   │       │              else [_to_data_url(cutout)]
   │       ├─ prefix = _INJECTION_PREFIX_V3_TEMPLATE.format(primary_hex=..., palette_str=...) if anchor
   │       │          else _INJECTION_PREFIX_V3_LEGACY
   │       ├─ effective_prompt = prefix + screen_prompt
   │       └─ 提交 APIMart
   │
   └─ STEP 3: 不变 (轮询 + 下载)
```

### 3.3 关键设计决策

**主色提取只算一次**：12 屏共用一份 cutout，没必要 12 次重复算。`generate_v2` 入口算一次缓存到本地变量，传给 `_generate_one_block_v2`。

**色卡 PNG 不落盘**：`_render_swatch_png()` 返回 bytes（`io.BytesIO`），由 `_to_data_url_from_bytes()` 转 base64 → data URL。全程内存里跑，无 GC 烦恼。

**算法选择**：Pillow `Image.quantize(colors=5, method=Image.MEDIANCUT)` —— Pillow 内置中值切分法，**不引入 numpy/scikit-learn 依赖**。200×200 下采样后 ~30ms，整个 12 屏共享一次。

**背景像素过滤**：
- PNG with alpha 通道：alpha < 128 直接排除
- JPG 白底兜底：转 HSV，luminance V > 240/255 且 saturation S < 0.05 当作白背景排除
- 都排完后剩余像素数 < 100 → confidence 不足，返回 None 走 fallback

---

## 4. 接口契约

### 4.1 `color_extractor.py` 公开 API

```python
@dataclass(frozen=True)
class ColorAnchor:
    primary_hex: str              # '#RRGGBB' 大写
    palette_hex: list[str]        # top-3 簇 hex (含 primary_hex 在 [0])
    confidence: float             # = (主簇像素数) / (非背景像素总数), 范围 [0.0, 1.0]
    swatch_png_bytes: bytes       # 512x512 纯色 PNG, primary_hex 作色

def extract_color_anchor(
    cutout_path: str | Path,
    *,
    downsample_to: int = 200,           # 下采样边长, 加速 quantize
    min_non_bg_pixels: int = 100,       # 非背景像素数最小阈值
    min_confidence: float = 0.30,       # 主簇占比最小阈值
    swatch_size: int = 512,             # 色卡边长
) -> ColorAnchor | None:
    """从 cutout 图算主色 hex 锚, 失败返 None.

    失败条件 (一律返 None, 由调用方 fallback):
      - 文件不存在 / 读图失败 / 损坏
      - 非背景像素 < min_non_bg_pixels (整图基本是白底)
      - 主簇 confidence < min_confidence (产品多色无主导)
      - quantize 内部异常
    """
```

### 4.2 `refine_generator.py` 改动

```python
# 新模板 (v3.2.2): 带 hex 数值锚 + 双图说明
_INJECTION_PREFIX_V3_TEMPLATE = (
    "Image 1 is the AUTHORITATIVE source for the product's color, silhouette, "
    "and key parts. Image 2 is a pure-color reference swatch showing the "
    "product's exact primary color {primary_hex} (extracted by pixel sampling, "
    "not estimated from text). The product's palette is {palette_str}. "
    "DO NOT render Image 2 as a visible element in output — it is a color "
    "reference for matching only. Match the product's color to {primary_hex} "
    "EXACTLY. If text below mentions any color that conflicts with Image 1 / "
    "Image 2, IGNORE the text. Do not substitute the product's color based "
    "on training data or category conventions. Preserve silhouette, parts, "
    "and proportions exactly. "
)

# 保留作 fallback (v3.2.1 那段, 单图无 hex)
_INJECTION_PREFIX_V3_LEGACY = (
    "Image 1 is the AUTHORITATIVE source for the product's color, "
    "silhouette, and key parts. Match Image 1 exactly. If the text below "
    "mentions a color that conflicts with Image 1, IGNORE the text — "
    "Image 1 always wins. Do not substitute the product's color based on "
    "training data or category conventions; use only the exact RGB hue "
    "shown in Image 1. Preserve silhouette, parts, and proportions exactly. "
)
```

### 4.3 ENV 一键回退开关

新增环境变量 `COLOR_ANCHOR_DUAL_IMAGE`：
- `on` (默认)：双图模式，B1+B3 全开
- `b1_only`：只加 hex 锚（B1），不加色卡（B3）—— 万一 APIMart 拒收双图时的临时回退
- `off`：完全退回 v3.2.1 行为

读法：`os.getenv("COLOR_ANCHOR_DUAL_IMAGE", "on")`，generator 入口判一次。

---

## 5. 错误处理

### 5.1 错误处理矩阵

| 失败点 | 表现 | 处理 | 用户感知 |
|---|---|---|---|
| cutout 路径不存在 | `FileNotFoundError` | log warn, anchor=None | 退到 v3.2.1，颜色风险回到旧水平 |
| Pillow 读图失败 | `UnidentifiedImageError` | 同上 | 同上 |
| 全图都是背景 | confidence < 阈值 | log warn, anchor=None | 同上 |
| `Image.quantize()` 异常 | 任何 Exception 兜底 | log error + traceback, anchor=None | 同上 |
| swatch 渲染异常 | `Image.new` / `BytesIO` 异常 | log error, swatch_png_bytes=None, **保留 hex 锚走 B1** | 单图模式 + hex 文字约束 |
| APIMart 拒收双图 | submit HTTP 4xx | 现有重试机制；ENV 开关一键 `b1_only` 回退 | 在线降级 |

### 5.2 核心铁律

**anchor 失败绝不抛异常打断生图主流程**。颜色保护是增益功能，不是必需功能 —— 算不出来时的体验等同于 v3.2.1，绝不更差。

### 5.3 反向降级链

```
anchor 提取成功 + swatch 渲染成功 + APIMart 接受双图  → B1+B3 全开 (双图 + hex 文字锚)
anchor 提取成功 + swatch 渲染成功 + APIMart 拒收双图  → ENV 切 b1_only, 单图 + hex 文字锚
anchor 提取成功 + swatch 渲染失败                    → 自动单图 + hex 文字锚 (无需 ENV)
anchor 提取失败                                     → 单图 + v3.2.1 文字锚 (无 hex)
```

每档比上档弱一点，但每档都比"完全没保护"强。

---

## 6. 测试策略

### 6.1 Layer 1：单测 `test_color_extractor.py` (~120 行)

**全部 fixture 用 PIL 程序生成，绝不依赖任何真实产品图**（避免硬编码具体产品）。

| Fixture | 内容 | 断言 |
|---|---|---|
| `red_solid.png` | 全图纯红 #FF0000 | primary_hex 误差 < 5/255 |
| `yellow_with_black_wheels.png` | 80% 黄机身 + 20% 黑轮 | primary='yellow' tier, palette 含 'black' tier |
| `gray_white_high_pressure_washer.png` | 浅白底 + 灰色机身（模拟 HE180） | primary 在浅灰区间，**断言不会被算成黄色**（直接钉死 HE180 染黄 bug 回归保护） |
| `transparent_alpha_png.png` | PNG with alpha 通道 | 验背景过滤正确 |
| `white_background_jpg.jpg` | JPG 白底 | 验白底兜底过滤正确 |
| 边缘 case：纯黑产品 | 全图 #000000 | confidence 高，primary='#000000' |
| 边缘 case：纯白产品 | 全图 #FFFFFF | confidence 不足 → None（产品被全部当背景滤掉，符合预期） |
| 边缘 case：损坏 PNG | 截断字节 | 返回 None，不抛异常 |
| 边缘 case：路径不存在 | `/tmp/no_such_file.png` | 返回 None，不抛异常 |

### 6.2 Layer 2：集成测 `test_refine_generator_v2.py` 改动 (~15 行)

- mock APIMart 调用
- 断言成功路径：`payload["image_urls"]` 长度 = 2
- 断言 fallback 路径：`payload["image_urls"]` 长度 = 1
- 断言 `effective_prompt` 含 hex 字符串（B1 验证）
- 修改现有 INJECTION_PREFIX 文案断言（已是 v3.2.1 → 升级 v3.2.2）

### 6.3 Layer 3：真测（硬核验收）

- HE180/10 真测：用户提供 cutout 路径 + 文案
- `.stage6_v3_real_test.py` 加 he180/he10 product fixture（**测试脚本里的 fixture，不进生产 prompt**）
- 跑 `--real --product he180` → 看 12 屏是否还染黄

**通过标准**：原 9 维度 + 新增 **维度 10 "产品颜色全屏一致"** PASS

---

### 6.4 已知限制 (非 bug, 显式标注)

- **纯白产品（白色家电 / 白色机箱）**: 算法无法区分白色产品和白色背景，会把产品像素全部当背景滤掉 → confidence 不足 → 返 None → 退到 v3.2.1 fallback 路径。**结果不更糟**（等同于 v3.2.1 行为），但 hex 锚保护未启用。
- **纯透明 cutout（用户上传完全透明 PNG，例如制图错误）**: 同上，无非背景像素 → 返 None → fallback。
- **金属反光 / 镜面产品**: quantize 会把高光区独立成簇，主色簇仍能保持产品本色，但 palette top-3 可能含高光白。这是预期行为。
- **多色拼接产品（如黄+黑+白 三色均匀分布）**: 主色 = 最大簇，secondary 进 palette。不会"混合"成中间色（这是 K-means vs 直方图均值的优势）。

---

## 7. 风险评估

| 风险 | 概率 | 后果 | 缓解 |
|---|---|---|---|
| Pillow `quantize` 对透明 PNG 行为异常 | 低 | 主色算成黑色 | 单测 fixture 覆盖透明 PNG |
| APIMart `image_urls` 上限 < 2 | 中 | 双图被拒 | 错误处理矩阵 + ENV 一键回退 `b1_only` |
| gpt-image-2 把 swatch 渲染到屏上 | 中 | 屏上同时出现产品 + 色卡 | INJECTION_PREFIX 显式声明 "DO NOT render Image 2 as a visible element"；HE180 真测验证 |
| 主色算对了但 gpt-image-2 仍违抗 | 低 | hex 数值锚也压不住先验 | 真测就是验这个；如果验不过再立项 B2（反喂 planner） |

---

## 8. 工作量估算

- 编码：~3-4 小时（color_extractor + generator 改动 + ENV 开关）
- 测试：~2 小时（单测 + 集成测）
- 真测 + 1-2 轮迭代：~1 小时
- **总计：半天到一天**

---

## 9. 验收标准

1. ✓ `test_color_extractor.py` 全绿（PIL 生成 fixture 全过）
2. ✓ `test_refine_generator_v2.py` 改完后全绿
3. ✓ 现有 217 测无回归
4. ✓ HE180/10 真测：维度 2（形态一致）+ 维度 10（颜色一致）双 PASS
5. ✓ DZ70X / DZ600M 旧产品真测：无颜色 / 形态回归
6. ✓ commit 消息说明 v3.2.2 升级要点 + 历史路径

---

## 10. 后续（独立排期，不在本次 scope）

| 任务 | 解决什么 | 优先级 |
|---|---|---|
| **B2 反喂 planner** | planner 收到 hex 后能写更精准的互补色背景 | P2 |
| **DeepSeek V4 升级** | 1M context + 更准的 scenario / 形态描述 | P1，独立 |
| **DeepSeek-VL2 多模态 planner** | planner 真"看图"写 plan | P2，独立 |

---

## 附录 A：v3.2.2 INJECTION_PREFIX 原文（成功路径）

```
Image 1 is the AUTHORITATIVE source for the product's color, silhouette,
and key parts. Image 2 is a pure-color reference swatch showing the
product's exact primary color #6B7280 (extracted by pixel sampling, not
estimated from text). The product's palette is #6B7280, #3A3D42, #D8D8D8.
DO NOT render Image 2 as a visible element in output — it is a color
reference for matching only. Match the product's color to #6B7280
EXACTLY. If text below mentions any color that conflicts with Image 1 /
Image 2, IGNORE the text. Do not substitute the product's color based
on training data or category conventions. Preserve silhouette, parts,
and proportions exactly.
```

## 附录 B：v3.2.1 INJECTION_PREFIX 原文（fallback / anchor 失败时）

```
Image 1 is the AUTHORITATIVE source for the product's color, silhouette,
and key parts. Match Image 1 exactly. If the text below mentions a color
that conflicts with Image 1, IGNORE the text — Image 1 always wins. Do
not substitute the product's color based on training data or category
conventions; use only the exact RGB hue shown in Image 1. Preserve
silhouette, parts, and proportions exactly.
```
