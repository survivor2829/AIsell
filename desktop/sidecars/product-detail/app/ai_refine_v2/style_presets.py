"""Customer-chosen looks for an AI detail set (user decision 2026-11-09).

A preset replaces only the shared design direction after planning, so the paid planner
request and its replay receipts stay exactly as they were. It governs backgrounds, light,
layout and mood; the product itself keeps the look and colours of the customer's photo.
"""
import copy
import json
import secrets

RANDOM = "random"
STYLE_PRIORITY = ("。风格要求最优先：本页构图里的背景、光线、配色或氛围如与整套设计不同，一律改按整套设计，"
                  "只保留场景内容和产品摆放；产品本身的外观和配色严格保持参考图原样。")

PRESETS = {
    "bright": {
        "label": "明亮活泼",
        "style_dna": {
            "color_palette": "白色与浅天蓝为主的明亮背景，少量橙色作品牌强调色，高明度、通透干净，整套不使用深色大背景",
            "lighting": "明亮通透的商业摄影布光，接近真实日光，画面无暗角，阴影轻而真实",
            "composition_style": "真实商业场景摄影为主，干净的商务版式，简洁的色块和细线分隔信息，主体突出，节奏明快",
            "mood": "明亮、积极、有活力，同时专业可信，适合企业采购和商业场景",
            "typography_hint": "现代粗体无衬线字体，标题醒目利落，深灰或深蓝字色，手机上清晰可读",
            "unified_visual_treatment": "整套统一真实照片质感和明亮商业摄影风格；不用卡通、插画、Q版、3D萌系、贴纸、表情或拟人形象，像同一家正规企业的产品宣传册",
        },
    },
    "premium": {
        "label": "高级专业",
        "style_dna": {
            "color_palette": "深炭灰到近黑的沉稳背景，点缀香槟金或冷银，低饱和，大面积深色，整套不使用亮白大背景",
            "lighting": "侧逆光与聚光勾勒轮廓，明暗对比克制，暗部保留细节，产品主体保持足够亮度",
            "composition_style": "严谨对称网格，克制留白，细线分隔，信息层级分明",
            "mood": "沉稳、高级、专业、值得信赖",
            "typography_hint": "细长现代黑体，白色或香槟金字色，深底上清晰可读",
            "unified_visual_treatment": "整套统一深色影棚质感和香槟金细线语言，像同一本高端产品画册",
        },
    },
    "fresh": {
        "label": "清新自然",
        "style_dna": {
            "color_palette": "米白、浅草绿和原木色的柔和背景，低对比，温润干净，整套不使用深色大背景",
            "lighting": "清晨般柔和的自然窗光，光影细腻，空气感强",
            "composition_style": "呼吸感留白，少量绿植与自然材质作陪衬，版式舒展不拥挤",
            "mood": "清爽、自然、干净、让人放心",
            "typography_hint": "细圆黑体，深绿或深棕字色，手机上清晰可读",
            "unified_visual_treatment": "整套统一自然窗光和米白浅绿色调，陪衬元素不抢产品，像同一处清爽空间",
        },
    },
    "tech": {
        "label": "科技未来",
        "style_dna": {
            "color_palette": "浅银白、冰蓝灰为主的明亮背景，科技蓝作细线和点缀，冷色调但整体明亮，整套不使用大面积深蓝、藏青或黑色背景",
            "lighting": "明亮干净的影棚光，冷白色调，轻微的蓝色边缘高光，产品真实颜色不被染色",
            "composition_style": "浅色背景上的细线几何和淡网格，模块化信息面板，数据感强，结构精准，留白干净",
            "mood": "前沿、精准、智能、清爽明亮",
            "typography_hint": "方正无衬线字体，深灰或科技蓝字色，浅底上清晰可读",
            "unified_visual_treatment": "整套统一浅色明亮底和科技蓝细线语言，像同一套智能产品发布视觉，不出现暗沉的深色画面",
        },
    },
}


def resolve(choice):
    """The preset id to freeze for a new task. Blank keeps the old free direction; random draws once."""
    if choice is None or choice == "":
        return None
    if not isinstance(choice, str) or (choice != RANDOM and choice not in PRESETS):
        raise ValueError("style")
    return secrets.choice(sorted(PRESETS)) if choice == RANDOM else choice


def label_of(style_id):
    return PRESETS[style_id]["label"] if style_id in PRESETS else ""


def apply(planning, style_id):
    """Put the chosen direction on the plan and in every screen prompt that quotes the planned one."""
    if style_id not in PRESETS:
        return planning
    result = copy.deepcopy(planning)
    preset = PRESETS[style_id]["style_dna"]
    previous = result.get("style_dna")
    old_text = json.dumps(previous, ensure_ascii=False) if previous else None
    new_text = json.dumps(preset, ensure_ascii=False)
    result["style_dna"] = copy.deepcopy(preset)
    result["product_style"] = style_id
    for screen in result.get("screens") or []:
        prompt = screen.get("prompt")
        if not isinstance(prompt, str):
            continue
        if old_text and old_text in prompt:
            prompt = prompt.replace(old_text, new_text)
        elif new_text not in prompt:
            prompt += "。整套设计：" + new_text
        # Each screen's scene was written for the planner's own look, so the chosen one has to win.
        screen["prompt"] = prompt + STYLE_PRIORITY
    return result
