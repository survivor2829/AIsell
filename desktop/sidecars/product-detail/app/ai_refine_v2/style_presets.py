"""Customer-chosen looks for an AI detail set (user decision 2026-11-09).

A preset replaces only the shared design direction after planning, so the paid planner
request and its replay receipts stay exactly as they were. It governs backgrounds, light,
layout and mood; the product itself keeps the look and colours of the customer's photo.
"""
import copy
import json
import secrets

RANDOM = "random"

PRESETS = {
    "bright": {
        "label": "明亮活泼",
        "style_dna": {
            "color_palette": "暖白与天空蓝的明亮背景，少量活力橙和阳光黄点缀，高明度、通透干净，整套不使用深色大背景",
            "lighting": "充足柔和的日光，画面明亮无暗角，阴影很轻",
            "composition_style": "留白充足，圆角信息卡片轻快错落，主体位于视觉中心，节奏活泼",
            "mood": "阳光、轻快、亲切、有活力",
            "typography_hint": "圆润粗黑体，标题醒目，深蓝或深灰字色，手机上清晰可读",
            "unified_visual_treatment": "整套统一明亮日光感和暖白天蓝底色，点缀色克制一致，每屏像同一场阳光下拍摄",
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
            "color_palette": "深蓝到青色的渐变背景，配发光的青蓝线条，冷色调为主，少量电光紫点缀",
            "lighting": "冷色边缘光与柔和辉光，主体轮廓清晰，产品真实颜色不被染色",
            "composition_style": "几何线框与细网格背景，模块化信息面板，数据感强，结构精准",
            "mood": "前沿、精准、智能、有未来感",
            "typography_hint": "方正无衬线字体，白色或青色字色，深底上清晰可读",
            "unified_visual_treatment": "整套统一深蓝渐变和青色发光线条语言，像同一套智能产品发布视觉",
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
        if old_text and isinstance(screen.get("prompt"), str):
            screen["prompt"] = screen["prompt"].replace(old_text, new_text)
    return result
