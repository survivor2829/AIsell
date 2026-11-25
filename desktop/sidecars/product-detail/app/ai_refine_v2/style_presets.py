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

# The four looks offered until 1.3.68. No longer offered; kept so a task that froze one still renders the same.
LEGACY_PRESETS = {
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


# Colour schemes (user 2026-11-25: the cheerful looks read as amateur; use professional colour pairings, after a
# list of ten UI schemes the user collected, refined to a designer's standard). Each is a base, a secondary and an
# accent used about 60/30/10. Where the list gave no accent one is added; scheme 6's "lemon yellow #FDA2A2" is a
# coral pink by its value and is named so.
# (id, name, short line, (base, secondary, accent), dark, base words, secondary words, accent words, mood, lighting, layout)
_SCHEMES = (
    ("onyx_green", "曜黑亮绿", "黑底 · 透白 · 亮绿", ("#0B0B0C", "#DADADB", "#47C86D"), True,
     "曜石黑", "透白灰", "亮绿", "冷静、锐利、有科技感", "深色影棚里的侧光勾边，产品主体明亮清楚",
     "黑底上的透白信息面板与细线，亮绿只用于关键数字、图标和小标签"),
    ("misty_forest", "雾林绿", "雾绿 · 森林绿 · 亮绿", ("#DDE7DF", "#1B412D", "#47C86D"), False,
     "雾绿", "森林绿", "亮绿", "沉静、自然、可信", "柔和的自然漫射光，阴影轻而干净",
     "雾绿大底，森林绿做标题和信息块，亮绿少量点出重点"),
    ("signal_red", "冷白正红", "冷白 · 银灰 · 正红", ("#EBECEE", "#BCBBBF", "#D71019"), False,
     "冷白", "银灰", "正红", "干脆、权威、工业品质", "均匀明亮的工业影棚光，冷白色调",
     "瑞士网格式排版，银灰细线分区，正红只做标题条、编号和一处重点"),
    ("studio_white", "影棚灰白", "纯白 · 浅灰 · 石墨", ("#FFFFFF", "#D0D0D0", "#2B2B2B"), False,
     "纯白", "浅灰", "石墨黑", "极简、克制、高级", "无影棚的柔光，产品像在白色展台上",
     "大面积留白，浅灰色块承托信息，石墨黑做标题和细线"),
    ("silver_steel", "银雾钢蓝", "雾白 · 银灰 · 钢蓝", ("#F2F7F8", "#DBE1E4", "#3A6EA5"), False,
     "雾白", "银灰", "钢蓝", "洁净、精准、值得信赖", "清亮的冷白光，带一点通透的空气感",
     "雾白底上的银灰卡片，钢蓝做图标、数据和细线"),
    ("ice_coral", "冰蓝珊瑚", "冰白 · 灰蓝 · 珊瑚粉", ("#F0F1F6", "#C2CADD", "#FDA2A2"), False,
     "冰白", "灰蓝", "珊瑚粉", "清爽、柔和、有亲和力", "明亮柔和的漫射光，色调偏冷",
     "冰白底配灰蓝圆角卡片，珊瑚粉只点在标签、按钮和一两个重点上"),
    ("slate_orange", "岩灰亮橙", "深蓝灰 · 冷灰 · 亮橙", ("#263844", "#A0A1A3", "#F2743A"), True,
     "深蓝灰", "冷灰", "亮橙", "硬朗、可靠、工业力量感", "深色背景下的轮廓光和顶光，金属质感清楚",
     "深蓝灰大底，冷灰做次级信息，亮橙做标题强调、编号和箭头"),
    ("moss_lime", "墨绿酸绿", "墨绿 · 银灰 · 酸绿", ("#062320", "#B4B9B4", "#58B04B"), True,
     "墨绿", "银灰", "酸绿", "沉稳、环保、专业", "低调的暗调布光，局部柔光照亮产品",
     "墨绿深底，银灰文字与分隔线，酸绿做数据和图标高亮"),
    ("carbon_volt", "炭黑荧光", "炭黑 · 石墨灰 · 荧光黄绿", ("#0F0F0F", "#282828", "#E1FD09"), True,
     "炭黑", "石墨灰", "荧光黄绿", "有冲击力、运动感、先锋", "强对比的硬光与边缘光，产品像在发布会舞台上",
     "炭黑底与石墨灰面板叠层，荧光黄绿只用于最关键的数字和标题字"),
    ("paper_ink", "暖白墨字", "暖白 · 墨黑 · 古铜", ("#FFF8F2", "#190300", "#B08D57"), False,
     "暖白", "墨黑", "古铜", "安静、雅致、像一本画册", "温暖柔和的窗光，阴影细腻",
     "暖白纸张感大底，墨黑做标题和正文，古铜细线和小图标点缀，版式像杂志内页"),
)


def _scheme(entry):
    style_id, name, line, (base, secondary, accent), dark, base_words, secondary_words, accent_words, mood, lighting, layout = entry
    text = "白色或很浅的颜色" if dark else secondary_words
    return style_id, {
        "label": name,
        "line": line,
        "swatches": [base, secondary, accent],
        "dark": dark,
        "style_dna": {
            "color_palette": (f"严格使用三色配色：{base_words} {base} 约占六成，作背景和大面积底色；{secondary_words} {secondary} 约占三成，"
                              f"作信息面板、次级色块和分隔线；{accent_words} {accent} 约占一成，只用于关键数字、标签、图标和少量强调。"
                              "不引入其他鲜艳颜色，整套同一套配色。"),
            "lighting": lighting + "；产品真实颜色不被环境光染色",
            "composition_style": layout + "；版式像大公司的产品官网与发布会画面，网格对齐，留白充足，信息层级清楚",
            "mood": mood + "，专业可信，适合企业采购和商业场景",
            "typography_hint": f"现代无衬线字体，标题粗、正文细，文字用{text}，与背景对比度足够，手机上清晰可读",
            "unified_visual_treatment": "整套统一这三种颜色和同一种光线；真实商业摄影质感，不用卡通、插画、贴纸、表情或渐变彩虹色，像同一家公司的一套正式物料",
        },
    }


PRESETS = dict(_scheme(entry) for entry in _SCHEMES)


def _preset(style_id):
    return PRESETS.get(style_id) or LEGACY_PRESETS.get(style_id)


def resolve(choice):
    """The preset id to freeze for a new task. Blank keeps the old free direction; random draws once among the offered schemes."""
    if choice is None or choice == "":
        return None
    if not isinstance(choice, str) or (choice != RANDOM and _preset(choice) is None):
        raise ValueError("style")
    return secrets.choice(sorted(PRESETS)) if choice == RANDOM else choice


def label_of(style_id):
    preset = _preset(style_id)
    return preset["label"] if preset else ""


def apply(planning, style_id):
    """Put the chosen direction on the plan and in every screen prompt that quotes the planned one."""
    if _preset(style_id) is None:
        return planning
    result = copy.deepcopy(planning)
    preset = _preset(style_id)["style_dna"]
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
