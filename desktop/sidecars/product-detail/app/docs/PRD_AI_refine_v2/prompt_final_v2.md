# v2 Prompt 最终版 (四段结构)

**验证日期**: 2026-04-23
**产品**: DZ600M 无人水面清洁机器人
**端点**: `POST /v1/images/generations`
**模型**: `gpt-image-2`
**相似度**: 8/10

## 完整 prompt (原文, 不动词序)

```
Image 1 is the reference photo of DZ600M — an unmanned water surface cleaning robot. Preserve its exact visual identity.

PRESERVE from Image 1 (exactly match):
- Main body color: industrial yellow
- Structural parts: two large black cylindrical auger floats
- Top: transparent dome camera housing
- Front: black propeller blade
- Proportions: compact, flat, float-style watercraft

CHANGE (new scene):
- Setting: modern Chinese urban riverbank at golden hour sunset
- Background: Chinese city skyline, skyscrapers softened by warm light, water reflecting the cityscape
- Foreground: DZ600M operating on water surface, gentle ripples, floating trash and pollutants being collected around it
- Add: Chinese environmental engineer in dark navy work uniform standing on bank, holding a tablet reviewing real-time data from robot

CONSTRAINTS:
- NO redesign of the robot
- NO color drift — yellow body stays industrial yellow
- NO added propellers or parts not in Image 1
- NO text, NO logo, NO watermark
- NO tilt-shift or miniature effects

STYLE:
Taobao/Tmall e-commerce detail page hero shot,
commercial product-in-scene photography,
sharp focus on both product and operator,
cinematic golden-hour grading, professional 8K
```

## 四段结构的作用拆解

| 段 | 作用 | 为什么必要 |
|---|------|-----------|
| **Image 1 is ...** | 明确参考图身份 + 要求保留视觉 identity | 不点名参考图 AI 会把 image_urls 当普通风格参考, 精度差一档 |
| **PRESERVE** | 列 AI **绝不能动**的硬特征 (颜色/部件/比例) | 上版 prompt 把 "white" 硬写进描述, AI 融合出白顶黄身混合体, 5/10 相似度 |
| **CHANGE** | 列 AI 可以/必须**新增**的场景要素 | 不给明确 CHANGE 指令, AI 容易只"挪个背景"不加工程师/污染物, 场景完成度低 |
| **CONSTRAINTS** | 列 AI **绝不能加**的负面项 (NO color drift / NO text / NO tilt-shift) | 这是 OpenAI 官方推荐的 gpt-image-2 prompt 结构, 比 negative_prompt 更强硬 |
| **STYLE** | 最后统一加淘宝电商/摄影/后期风格 | 不给风格, AI 随机风格漂移; 给了就锁定淘宝天猫详情页风格 |

## 每段与产品解析数据的对应关系 (给代码实现用)

```
PRESERVE.body_color        ← product.color (AI 解析)
PRESERVE.key_parts[]       ← product.key_features[] (AI 解析)
PRESERVE.proportions       ← product.category_shape (机器人/机床模板固定)
CHANGE.setting             ← scene_pack.hero_scene (风格包)
CHANGE.persona             ← scene_pack.operator (风格包)
CONSTRAINTS.no_color_drift ← PRESERVE.body_color (同步, 不能漏)
CONSTRAINTS.no_text        ← 永远加
STYLE                      ← scene_pack.style (风格包)
```

## 踩过的坑 (写进下版 prompt 前要修)

1. **"transparent dome"** AI 会具象成金属圆柱 — 需加 `with glass reflection, NOT opaque metal`
2. **"golden hour"** 水面会过度泛黄 — 加 `soft sunset, not over-saturated amber`
3. **机器前端被水遮挡** — 加 `product fully visible above waterline, not submerged`
4. **1024×1024** 边缘略糊 — 试 `2048×2048` 或 `16:9` (淘宝主图比例)
