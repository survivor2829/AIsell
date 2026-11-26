"""DeepSeek 规划官 Prompt 常量 · v3 (2026-04-28 deliberate_iron_rule_5_break).

历史:
  v1 (PRD §3.1 初版) — 4 品类映射模板描述
  v2 (2026-04-23)    — 合并 w1_review.md §8 补丁 A/B/C/D
  v3 (2026-04-28, PRD AI_refine_v3.1, 铁律 5 deliberate break):
    - 推倒 SYSTEM_PROMPT_V2 (第 5 次), 推倒后铁律 5 立即重置
    - 触发原因: documentary muted teal-gray 路线跟 B2B 消费品客户期待
      根本性错配 (37 张扬子标杆图都是明亮高饱和路线)
    - 重写: 准则 2 unified_visual_treatment (warm golden-hour cinematic +
      A/B 风格分配 + 颜色锚点动态化)
    - 重写: 准则 3 屏数 6-10 → 8-15, 加 11 屏型必出/高优/中优分类
    - 扩展: 准则 7 屏型→layout 映射表 8 → 11 屏型
    - 新增: 准则 8 FAQ 内容真实性约束 (法律合规硬约束)
    - 新增: 准则 9 SCOTT_OVERRIDE 模式正式化
    - 新增: deliberate_dna_divergence 字段 (SCOTT_OVERRIDE 标注)
    - schema 改: screen_count [6,10] → [8,15], role enum 8 → 11
  v3.iter2 (2026-04-29, Scott 4/9 PASS 反馈自洽迭代):
    - 第 1 次跑产品图露出过密 (12 屏 ~10 屏画产品), B2B 详情页应"产品离场"
    - 准则 4: 加中文易错词显式书写规则 (修"昿联网"应是"物联网")
    - 准则 7: scenario_grid_2x3 改"6 格内容多元化, 产品图最多 2 格"
    - 准则 7: 加 lifestyle_demo 屏型 (真人 + 产品 + 实景, A 暖色, B2B 必备)
    - 新增: 准则 10 产品图露出频率限制 (12 屏型每屏 0/1/2 张, 总数 ≤ 8)
    - 新增: 准则 11 屏型唯一性硬约束 (DeepSeek iter1 detail_zoom × 2)
    - spec_table 修正: 上半部 1 张产品图 + 下方参数 (Scott 改动 4)
    - schema 改: role enum 11 → 12 (+lifestyle_demo)
  v3.2 (2026-04-29, deliberate_iron_rule_5_break_2nd, Scott 跨产品色染验证后推倒):
    - 触发原因: DZ70X (黑色产品) 用 v3.iter2 暖色阳光路线染成金色 — 暖色调
      会污染非暖色产品 (黑/灰/银/白). 公司产品矩阵颜色多样, 通用方案必须中性.
    - 推倒 SYSTEM_PROMPT_V2 准则 2 (第 6 次), 推倒后铁律 5 立即重置 (第 2 次重置)
    - 重写: 准则 2 路线 warm golden-hour cinematic → DJI/Apple-inspired
      premium minimalist grayscale (大疆风高级灰)
    - 删除: A/B 风格分配表 (早晨阳光 / 工业实战), 全屏型统一灰色基调 + 产品本色
    - 重写: 准则 7 layout 映射表 — 每个屏型加"灰色背景"和"产品本色保留"描述
    - 加: 准则 9 末尾产品颜色保真硬约束 (黑→黑/黄→黄/灰→灰, 不被环境光染色)
    - 加: INJECTION_PREFIX 强化版 (强调 EXACT original color WITHOUT ambient
      color shifting), generator 端实施
    - schema 不变 (12 屏型 / 8-15 屏 / role 唯一)
  v3.2 精修 (2026-04-29, Scott v3.2 PASS 后 2 个精修):
    - 反馈 1 (lifestyle_demo 必出): DeepSeek 自由判断时跳过 lifestyle_demo,
      但客户强需"产品使用效果展示". 准则 3 必出屏 3 → 4, schema 校验加必出
      _REQUIRED_ROLES_V2 += {lifestyle_demo}, 准则 7 强化"产品在工作中"
    - 反馈 2 (商业承诺 GLOBAL): DZ70X iter1 brand_quality 屏出现"41 年品牌保证"
      和"全国 200+ 售后网点", 文案没写, DeepSeek 编造 → 法律风险.
      准则 8 从 FAQ 限定扩展为 GLOBAL 商业承诺真实性约束 (适用所有屏型),
      覆盖 5 类 (时间承诺 / 数量承诺 / 资质认证 / 退换政策 / 任何具体数字)
  v3.2.1 (2026-04-29, vision-first 颜色保真转向):
    - 触发原因: HE180/10 (浅白+灰色高压清洗车) 实测被 gpt-image-2 染成
      浅灰+黄色. 根因 = text-first 路径: DeepSeek 看主图 URL 文本猜
      primary_color → 写"the product is industrial blue-gray" → gpt-image-2
      看到 text 描述 + 自己 vision bias (清洗车=黄) 撕扯 → bias 胜.
    - 修法 = vision-first 设计: 把 Image 1 (image_urls[0]) 立成颜色权威源
      * 准则 9 末尾删硬编码颜色清单 (黄→黄/黑→黑列表), 改 vision-first 设计文档
      * 屏 prompt 不再写产品颜色字面值, 改 "the product as in Image 1" 引用语法
      * INJECTION_PREFIX_V3 强化: 显式告诉 gpt-image-2 "text 颜色冲突时 Image 1 总赢"
      * 准则 2 + 反例正例所有"industrial yellow / blue-gray / charcoal"
        改成 "color/silhouette from Image 1"
    - 影响: product_meta.primary_color 字段保留 (仅日志), 不再复述到 prompt

W2 验证 (v2, 2026-04-23 实测 ~100% 准确率):
  - 历史 5 case 测试沿用作 v3 回归保护 (品类判定不动, 只判定逻辑保留)

迭代指引:
  修这个 prompt 后必须跑 `ai_refine_v2/tests/` 全套单测,
  确保所有 case 全绿 (170+15 v3 新增, 期望 ~185 测全绿).
"""
from prompt_ref import prompt_ref


SYSTEM_PROMPT = prompt_ref("detail.planner.system_v1")


USER_PROMPT_TEMPLATE = (prompt_ref("detail.planner.user_v1.p1", formatted=True) + "{product_text}" + prompt_ref("detail.planner.user_v1.p2", formatted=True) + "{product_image_hint}" + prompt_ref("detail.planner.user_v1.p3", formatted=True) + "{force_vs}" + prompt_ref("detail.planner.user_v1.p4", formatted=True) + "{force_scenes}" + prompt_ref("detail.planner.user_v1.p5", formatted=True) + "{force_specs}" + prompt_ref("detail.planner.user_v1.p6", formatted=True) + "\n  \"product_meta\": {{" + prompt_ref("detail.planner.user_v1.p7", formatted=True) + prompt_ref("detail.planner.user_v1.p8", formatted=True) + prompt_ref("detail.planner.user_v1.p9", formatted=True) + "\n  ],\n  \"planning\": {{" + prompt_ref("detail.planner.user_v1.p10", formatted=True) + "\n}}")


# ──────────────────────────────────────────────────────────────────
# v2 (PRD §阶段一·任务 1.1, 2026-04-27): style_dna + N 屏导演 prompt
# ──────────────────────────────────────────────────────────────────
# 跟 v1 完全独立的两个常量, plan_v2() 用. 老 SYSTEM_PROMPT/USER_PROMPT_TEMPLATE
# 由 plan() 继续用, 不动. 等 PRD §阶段二 generator 重写完, pipeline_runner
# 切到 plan_v2 后, 老的 SYSTEM_PROMPT/USER_PROMPT_TEMPLATE + plan() 整组才下架.

PRODUCT_PRESENTATIONS = {
    "concept_detail": "Make the source-supported component the main subject as a photorealistic illustrative design. No whole-product thumbnail is required. Infer visual form conservatively; do not add unprovided functions, specifications or extra components, and do not label it an actual product photograph.",
    "whole_product": "Show the whole product as the main subject; reserve this for product recognition, not as a default for every selling point.",
    "working_scene": "Make the real use scene and visible result the main subject. Integrate the product at a believable working scale, not as a large pasted catalogue cutout.",
    "visible_detail": "Crop tightly to a relevant part actually visible in Image 1. Do not add a second whole-product portrait, reveal hidden parts, or invent internal structure.",
    "diagram_only": "Use flat schematic pictograms, labeled outlines or data graphics with supplied facts. Do NOT draw the whole product, a product silhouette, photorealistic tanks or invented hardware. For dry-collection capacity use dry particles or an abstract volume outline, NEVER liquid or a water-fill effect. Match the actual medium in the source; if unspecified keep the graphic abstract. Image 1 is a reference, not mandatory visible content.",
    "small_reference": "Make the information or spatial comparison dominant. Show the product only as a small supporting reference; do not enlarge it into another hero portrait.",
}

SYSTEM_PROMPT_V2 = prompt_ref("detail.planner.system_v2")

USER_PROMPT_TEMPLATE_V2 = (prompt_ref("detail.planner.user_v2.p1", formatted=True) + "{product_text}" + prompt_ref("detail.planner.user_v2.p2", formatted=True) + "{product_title_hint}" + prompt_ref("detail.planner.user_v2.p3", formatted=True) + "{product_image_hint}" + prompt_ref("detail.planner.user_v2.p4", formatted=True))
