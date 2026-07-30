"""
专业级 AI 生图 Prompt 模板库 —— 详情页无缝长图纯环境背景生成

v2 修订（2026-04-14）：
- 彻底删除所有电商术语（detail page / parameter / advantages / specs / card / icon grid / VS glyph / brand mark …）
- 所有正向 prompt 改为自然语言散文，删除 SCENE:/LIGHTING:/ 等大写标签（训练集里大写标签与 infographic 模板强相关，会诱导模型渲染文字标题）
- 过渡提示（_transition_hint）删除所有屏幕英文名，只保留色调 + 反模式否定语（"no visible seam or color block"）
- 统一负向提示加入已观察到的文字幻觉：parameter / advantages / vs / barrameter / dollar sign / percent sign / infographic labels
- 框架词从 "E-commerce product detail page" 改为 "natural photographic environment study"

对外函数（签名不变，兼容原调用方）：
- get_prompts_for_theme(theme_id, screen_list) → list[dict]
- build_prompt(screen_type, variant, theme_id, prev_screen, next_screen) → str
- list_variants(screen_type) → list[str]
"""
from __future__ import annotations

# ── 全局 ────────────────────────────────────────────────────────────────

QUALITY_SUFFIX = (
    "professional commercial photography, 8K ultra high resolution, "
    "natural photographic realism, soft cinematic grading"
)

# 统一反向提示词：排除所有文字/人物/产品/低质/infographic 模板特征
NEGATIVE_PROMPT = (
    # 文字类（全语言覆盖 + 具体幻觉字符串）
    "any text of any language, any letters, any digits, any numbers, any chinese characters, "
    "japanese characters, korean characters, alphabets, english typography, chinese typography, "
    "watermark, logo, signature, caption, subtitle, heading, title, label, sign, signage, "
    "parameter, parameters, barrameter, advantages, specs, specifications, comparison, versus, vs, "
    "dollar sign, percent sign, currency symbol, punctuation marks, arrow symbols, check mark, "
    "mockup text, design mockup, infographic, section header, column header, bullet list, "
    "placeholder text, sample text, lorem ipsum, price tag, badge, sticker, "
    # 人物
    "people, person, human, hands, face, crowd, silhouette, reflection of human, "
    # 产品/器物
    "product, robot, machine, device, vehicle, appliance, tool, equipment model, "
    "furniture, clutter, decorative object, sculpture, plant, animal, "
    # 风格
    "cartoon, anime, illustration, painting, sketch, stylized render, ui mockup, wireframe, "
    "website screenshot, presentation slide template, poster design, flyer layout, "
    # 画质
    "low quality, blurry, distorted, deformed, noise, artifacts, banding, jpeg compression, "
    "oversaturated, overexposed, harsh shadow, flat, plastic look"
)


# ── 主题调色板 ──────────────────────────────────────────────────────────

THEME_PALETTE: dict[str, dict] = {
    "classic-red": {
        "name": "Classic Red",
        "primary": "deep crimson red",
        "accent": "warm amber glow",
        "neutral": "charcoal grey and cream white",
        "dark_base": "deep burgundy to graphite gradient",
        "light_base": "soft cream white to warm ivory",
        "mood_word": "confident, premium, commanding",
    },
    "tech-blue": {
        "name": "Tech Blue",
        "primary": "electric deep blue",
        "accent": "cyan highlight",
        "neutral": "silver grey and frost white",
        "dark_base": "midnight navy to cobalt gradient",
        "light_base": "ice blue to frost white gradient",
        "mood_word": "futuristic, precise, intelligent",
    },
    "minimal-mono": {
        "name": "Minimal Mono",
        "primary": "pure jet black",
        "accent": "subtle silver highlight",
        "neutral": "pearl white and warm grey",
        "dark_base": "matte black to graphite gradient",
        "light_base": "pearl white to warm light grey",
        "mood_word": "minimal, refined, timeless",
    },
    "blue":  None,  # alias → tech-blue
    "red":   None,  # alias → classic-red
    "green": {
        "name": "Fresh Green",
        "primary": "deep emerald green",
        "accent": "soft lime highlight",
        "neutral": "warm beige and sand",
        "dark_base": "deep forest green to pine gradient",
        "light_base": "mint ivory to pale sage",
        "mood_word": "fresh, organic, trustworthy",
    },
}

_THEME_ALIAS = {"red": "classic-red", "blue": "tech-blue"}


def _resolve_theme(theme_id: str) -> dict:
    tid = (theme_id or "").strip()
    tid = _THEME_ALIAS.get(tid, tid)
    data = THEME_PALETTE.get(tid)
    if not data:
        data = THEME_PALETTE["classic-red"]
    return data


# ── 屏幕变体：六维 = scene / lighting / palette / material / composition / emotion
#
# 注意：
# - 所有字段用自然语言散文，不含任何电商术语 / UI 元素名。
# - composition 字段只描述"留空区"，不使用 "card / button / icon grid / glyph / brand mark"。
# - palette 支持 {primary}/{accent}/{dark_base}/{light_base} 占位符。

SCREEN_VARIANTS: dict[str, dict[str, dict]] = {

    # ── 英雄屏 ──────────────────────────────────────────────
    "hero": {
        "factory": {
            "scene": "a vast modern industrial hall interior, polished concrete floor stretching toward a distant vanishing point, steel ceiling truss lines softly out of focus in the far depth",
            "lighting": "an upper-left 45-degree rim light casts a long directional highlight across the floor, volumetric god rays descend from a ceiling skylight, gentle ambient fill warms the right side",
            "palette": "{dark_base} dominates the scene with a subtle {primary} atmospheric accent along the high horizon",
            "material": "the concrete floor reflects softly like a still shallow mirror, matte painted walls show fine texture grain, brushed steel structural members catch subtle highlights",
            "composition": "the upper two-thirds of the frame is quiet and open air, the lower third has a calm central region with deep symmetrical perspective and no foreground clutter",
            "emotion": "authoritative, industrial, cinematic stillness",
        },
        "showroom": {
            "scene": "a pristine minimalist photography studio with a seamless curved cyc-wall sweeping into a polished floor, a subtle low circular plinth sits quietly in the lower-center",
            "lighting": "a large diffused overhead softbox pours gentle key light onto the studio, a faint kicker from the lower-left rakes across the floor, light falls off gracefully toward the outer edges",
            "palette": "a smooth vertical gradient with {light_base} glowing at the top sweeping into deeper {primary} warmth toward the floor, photographic precision with clean tonal separation",
            "material": "the backdrop carries a fine seamless paper grain with no visible seams, the plinth reads as satin-finish stone with a soft floor reflection",
            "composition": "the center of the frame remains an open breathing field, the upper two-thirds is quiet empty air, side margins give generous breathing room with no competing forms",
            "emotion": "premium, confident, flagship stillness",
        },
        "outdoor": {
            "scene": "a modern architectural plaza at dusk, a geometric glass facade stretches along the background, a polished granite ground catches soft gradient reflections, a wide horizon line anchors the frame",
            "lighting": "warm golden-hour backlight glows along the horizon, soft cool sky ambience bathes the upper zone, long gentle shadows drift across the ground",
            "palette": "upper sky in {light_base} tones fades into a warm horizon glow, the foreground settles into {dark_base}",
            "material": "polished granite tiles gleam with subtle reflection, smooth glass curtain wall in the background, brushed metal railing suggested in soft bokeh",
            "composition": "the horizon sits at the lower third, the upper two-thirds is open sky and atmosphere, the ground center is left quiet and clear",
            "emotion": "expansive, aspirational, cinematic openness",
        },
        # 耗材类专用 — 实验室/工作台调性,适合清洁化学品/液体瓶/小工具
        # 2026-05-14: 把 beakers 从远景模糊区提到前景视觉锚点,加 pH meter / pipette
        # stand 等具体器材,强化"实验室"语义,避免被 Seedream 压平成"白底安静空间"
        "lab_minimal": {
            "scene": "a pristine laboratory workspace interior, a brushed stainless steel benchtop dominates the lower third, a row of empty glass beakers and amber-tinted reagent bottles arranged at the left edge of the frame, a digital pH meter and a pipette stand at the right edge, the central benchtop surface left wide and empty for compositing",
            "lighting": "uniform overhead diffused panel light, no harsh directional source, soft ambient fill on all sides, clinical even illumination",
            "palette": "cool {light_base} dominates with a faint {primary} hint near the bench edge, clean scientific atmosphere",
            "material": "brushed stainless steel benchtop with fine horizontal grain and subtle satin reflection, matte epoxy-coated white walls, frosted glass partitions softly out of focus",
            "composition": "the center of the bench is a wide quiet empty zone, upper two-thirds remains calm and open, no distracting equipment in the focal area",
            "emotion": "clinical, trustworthy, scientifically clean",
        },
    },

    # ── 优势屏 ──────────────────────────────────────────────
    "advantages": {
        "minimal_white": {
            "scene": "a pure abstract studio environment with no scene objects, simply a clean atmospheric gradient surface",
            "lighting": "flat diffused overhead illumination, no harsh directional source, uniform gentle brightness across the field",
            "palette": "a smooth gradient sweeping from pure {light_base} at the upper edge to a barely-visible {primary} tint along the lower edge, luminous and airy",
            "material": "ultra-fine paper grain texture with imperceptible film grain for depth, no specular highlights anywhere",
            "composition": "the entire central expanse is pure quiet space, only a subtle vignette touches the extreme outer edges",
            "emotion": "clean, clinical, effortless clarity",
        },
        "tech_grid": {
            "scene": "an abstract technology substrate suggesting depth, very faint geometric reference lines dissolve into holographic atmospheric layers",
            "lighting": "an inner ambient glow emerges from within the substrate itself, no single directional key light, a faint edge glow bleeds from the periphery",
            "palette": "{light_base} base with barely-perceptible {primary} accent lines and scattered soft light particles",
            "material": "smooth frosted glass surface layered over a very faint isometric reference field, micro noise for digital atmosphere",
            "composition": "the central expanse is smooth and empty, peripheral reference lines guide the eye inward without crossing the middle zone",
            "emotion": "precise, intelligent, systematized",
        },
        "soft_paper": {
            "scene": "a premium paper catalog surface aesthetic, a tactile surface with a subtle soft fold shadow at one edge",
            "lighting": "diffused window light from the upper-right creates a very soft directional gradient, natural daylight balance",
            "palette": "warm {light_base} with cream undertone, faint {accent} warmth in the highlights",
            "material": "fine laid paper texture with visible fiber grain, matte finish, tactile premium feel",
            "composition": "wide quiet center, edge shadow gradient guides the eye gently inward",
            "emotion": "editorial, thoughtful, craftsman premium",
        },
    },

    # ── 参数屏 ──────────────────────────────────────────────
    "specs": {
        "dark_carbon": {
            "scene": "a deep dark technology atmosphere, an abstract environment with no concrete objects, purely a profound depth",
            "lighting": "a thin edge light from the top creates a gentle top-to-bottom gradient, a faint rim glow along the bottom edge",
            "palette": "{dark_base} dominates, deep graphite with subtle {primary} glow pooling near the corners",
            "material": "carbon fiber weave barely visible in highlights, matte finish with micro specular glints, fine dust-like particle haze",
            "composition": "the center of the frame is a calm clean expanse, the middle seventy percent remains open with no competing elements",
            "emotion": "technical, serious, engineering authority",
        },
        "frosted_glass": {
            "scene": "a soft translucent plane floats in a deep abstract environment, behind it soft bokeh lights dissolve into depth",
            "lighting": "a backlight bleeds gently through the translucent plane, a soft gradient flows from a brighter top-center into darker edges",
            "palette": "cool {dark_base} behind the translucent layer, with {accent} light bleeding through in soft halos",
            "material": "textured frosted glass with visible sandblast grain, soft blur depth beyond, subtle light refraction",
            "composition": "the translucent plane occupies the middle region leaving a quiet backdrop around it, the surface of the plane itself is smooth and featureless",
            "emotion": "sophisticated, translucent precision, modern tech",
        },
        "metal_brushed": {
            "scene": "an abstract brushed metal wall surface, subtle industrial texture forming the entire backdrop",
            "lighting": "a raking light from the left creates a directional highlight across the brush lines, pooled softer shadow on the right",
            "palette": "cool steel tones blend into {dark_base}, faint {primary} reflections glint along the brushed grain",
            "material": "fine linear brushed stainless steel, tight horizontal grain, micro-scratch specular highlights",
            "composition": "horizontal brush lines guide the eye across the frame, the central left region remains quiet with no distracting reflections",
            "emotion": "industrial-grade, engineered, rigorous",
        },
    },

    # ── 对比屏 ──────────────────────────────────────────────
    "vs": {
        "split_light_dark": {
            "scene": "a symmetric left-right split environment, the left side is a bright modern studio and the right side is a dark industrial backdrop",
            "lighting": "the left side carries flat bright key light, the right side is lit by low-key rim light, a thin glowing divider runs softly down the center",
            "palette": "left side in {light_base} clean tones, right side in {dark_base}, central divider faintly glowing with {accent}",
            "material": "left side reads as matte seamless studio paper, right side as textured concrete with metal accents, distinct tactile contrast",
            "composition": "the vertical divider sits at exactly the midline, each half offers a generous empty central region",
            "emotion": "decisive contrast, clear hierarchy, visual argument",
        },
        "stage_arena": {
            "scene": "a theatrical split stage, two symmetric spotlighted circles on a neutral dark floor, a gentle haze floats in the air",
            "lighting": "two matched spotlights from upper corners, a shared soft ambient fill, atmospheric volumetric haze",
            "palette": "overall neutral {dark_base}, both spotlight pools glow in warm {light_base}, the rim accent picks up {primary}",
            "material": "satin dark stage floor with soft reflection, misty atmospheric depth behind",
            "composition": "two equal circular pools of light sit at mirrored positions with clean quiet space between them, the surface under each pool is featureless",
            "emotion": "dramatic, head-to-head, decisive",
        },
    },

    # ── 场景屏 ──────────────────────────────────────────────
    "scene": {
        "hotel_lobby": {
            "scene": "a luxury five-star hotel lobby interior, a tall ceiling with a decorative chandelier, a seamless polished marble floor, a distant reception counter dissolves into soft focus",
            "lighting": "warm interior ambient light, gentle bounce off the ceiling, subtle spotlight pools drift across the floor",
            "palette": "cream and champagne base tones with subtle {accent} highlights, {primary} architectural accents",
            "material": "polished veined marble floor with mirror reflection, brushed brass accents, satin wood paneling softly out of focus in the distance",
            "composition": "the central floor plane is quiet and clear, the upper zone carries architectural depth",
            "emotion": "hospitable, upscale, welcoming premium",
        },
        "factory_floor": {
            "scene": "a modern automated factory production floor, epoxy-resin-coated ground, distant conveyor lines and machinery softly out of focus",
            "lighting": "overhead industrial LED panels spread even light across the scene, faint task-lighting pools punctuate the space",
            "palette": "cool industrial grey base with {primary} safety-line accents along the edges",
            "material": "glossy self-leveling epoxy floor with subtle reflection, cleanly painted steel structures, matte concrete walls far in the background",
            "composition": "the central floor zone is a quiet clean expanse, depth recedes toward distant machinery, edges remain lightly framed",
            "emotion": "efficient, orderly, advanced manufacturing",
        },
        "mall_corridor": {
            "scene": "a large contemporary shopping mall central corridor, polished stone floor, soft-focus storefront glow along both sides",
            "lighting": "mixed ceiling spotlights create warm pools, cooler skylight ambience filters in above, bokeh highlights drift in from storefronts",
            "palette": "neutral warm stone base, subtle {accent} from storefront glow, {primary} suggested in distant bokeh",
            "material": "large-format polished porcelain floor tiles with crisp reflection, brushed metal trim, glass storefront facades in soft focus",
            "composition": "wide central corridor perspective with the floor center left quiet, symmetric flanking storefronts, upper zone clear",
            "emotion": "commercial, lively but controlled, premium retail",
        },
        "transport_hub": {
            "scene": "a modern airport or high-speed-rail concourse, a soaring ceiling with skylight, a long seamless terrazzo floor, distant structural columns softly out of focus",
            "lighting": "natural daylight pours through the skylight, cool balanced ambience, gentle long shadows drift across the floor",
            "palette": "cool {light_base} daylight base with subtle {primary} architectural accent",
            "material": "large seamless terrazzo floor with micro aggregate texture and subtle reflection, glass curtain wall stretches into the background",
            "composition": "strong one-point perspective with the floor center left wide and open, the upper architectural expanse carries mood",
            "emotion": "expansive, public-scale, clean modern infrastructure",
        },
        # 耗材类专用 — 仓储/配货走廊,体现"批量供应/专业储备"语境
        # 2026-05-14: shelving 从远景模糊提到中景明确可见,加码垛箱子 / PE 缠绕托盘
        # 等具体仓储符号,让 Seedream 真感受到"仓储"而非"通用工业走廊"
        "warehouse_aisle": {
            "scene": "a modern industrial warehouse aisle interior, tall metal pallet racks flank both sides at chest height with stacked unbranded cardboard boxes and PE-wrapped pallets clearly visible, a glossy epoxy floor stretches forward with strong one-point perspective, the central aisle floor left wide and empty for compositing",
            "lighting": "overhead linear LED panels cast uniform balanced illumination, gentle ambient bounce from the bright walls, no harsh shadows",
            "palette": "cool {light_base} dominates the upper zone, the floor reflects with a faint {primary} accent near the central perspective line",
            "material": "self-leveling epoxy floor with soft mirror-like reflection, painted steel shelving softly out of focus, matte white walls in the background",
            "composition": "the central aisle stays wide and quiet, flanking shelves recede symmetrically into depth, upper zone open and uncluttered",
            "emotion": "professional, well-stocked, supply-chain reliable",
        },
    },

    # ── 品牌屏 ──────────────────────────────────────────────
    "brand": {
        "dark_metallic": {
            "scene": "an abstract premium closing environment, a seamless curved transition where floor meets wall, a subtle low circular plinth sits in the center",
            "lighting": "a single top-down key spotlight creates a tight vignette pool, a soft rim light along the lower edge, the surrounding falls into deep shadow",
            "palette": "{dark_base} dominates eighty percent of the frame, a narrow {primary} warm rim glow pools near the top-center",
            "material": "satin-finish dark floor with subtle reflection, polished metal plate with specular accents, clean matte backdrop",
            "composition": "the center of the frame remains open and focal, the lower third carries quiet gravitas, tight cinematic vignette at the outer edges",
            "emotion": "authoritative, final statement, flagship gravitas",
        },
        "deep_gradient": {
            "scene": "an abstract deep color gradient atmosphere, no objects, purely atmospheric depth",
            "lighting": "a soft volumetric glow emerges from the upper-center, falling off gracefully into deep shadow at the lower corners",
            "palette": "rich {primary} blended into {dark_base}, a smooth vertical gradient with subtle cloud-like atmosphere",
            "material": "ultra-smooth atmospheric haze with fine film grain, barely-visible light particle flecks drifting",
            "composition": "a full-width clean canvas, the upper-center glow frames an open focal region, the lower zone is quiet and calm",
            "emotion": "closing, grand, memorable signature",
        },
    },

    # ── CTA 行动屏 ──────────────────────────────────────────
    "cta": {
        "clean_gradient": {
            "scene": "a clean abstract gradient backdrop with no environmental objects, purely atmospheric",
            "lighting": "flat even illumination with a subtle radial glow rising from the lower-center, no harsh shadows",
            "palette": "{light_base} dominant with a rising {primary} warm glow along the lower third",
            "material": "ultra-smooth gradient with micro paper grain, no specular highlights anywhere",
            "composition": "the entire center is reserved as quiet space, the outer edges carry soft quiet tonal falloff",
            "emotion": "inviting, actionable, decisive closing moment",
        },
        "soft_spotlight": {
            "scene": "a soft centered spotlight abstract backdrop, a radial gradient converges toward the middle of the frame",
            "lighting": "a single wide soft radial glow pools at the exact center, graceful falloff into deeper edges",
            "palette": "{primary} warm radiance at the middle blending outward into {dark_base} at the outer frame",
            "material": "clean atmospheric haze, imperceptible grain, no surface detail",
            "composition": "the center of the glow is wide and quiet, the outer ring fades into calm edge",
            "emotion": "focused, confident invitation, one last push",
        },
    },
}


# ── 画面尺寸 & 相邻过渡节奏 ────────────────────────────────────────────

SCREEN_HEIGHT = {
    "hero":       1334,
    "advantages": 900,
    "story":      1000,
    "specs":      1100,
    "vs":         1000,
    "scene":      900,
    "brand":      800,
    "cta":        700,
}

SCREEN_OVERLAP = {
    "hero":       120,
    "advantages": 100,
    "story":      100,
    "specs":      120,
    "vs":         100,
    "scene":      100,
    "brand":      0,
    "cta":        0,
}

DEFAULT_VARIANT = {
    "hero":       "showroom",
    "advantages": "minimal_white",
    "specs":      "dark_carbon",
    "vs":         "split_light_dark",
    "scene":      "mall_corridor",
    "brand":      "dark_metallic",
    "cta":        "clean_gradient",
    "story":      None,  # 沿用 advantages:soft_paper
}

# 实证 commercial_showroom 是唯一使用过的风格 (前端 6 个风格按钮 + 盲盒从未真正生效),
# 2026-05-11 清理后保留这套 variants 作为 ai_bg_cache 的默认编排,详见 docs/STYLE_PACK_CLEANUP.md。
# 与 DEFAULT_VARIANT (上面那个,prompt-layer 单屏 fallback) 大部分共享,仅 specs/brand 两屏
# 历史性偏 "commercial showroom" 调性,用 spread 让差异自文档化。
DEFAULT_VARIANTS_MAP: dict[str, str] = {
    **{k: v for k, v in DEFAULT_VARIANT.items() if v},  # 过滤 None (如 story)
    "specs": "frosted_glass",   # vs DEFAULT_VARIANT 的 dark_carbon
    "brand": "deep_gradient",   # vs DEFAULT_VARIANT 的 dark_metallic
}


# ── 品类覆盖层 (P5.5) ──────────────────────────────────────────────────
# 只列与 DEFAULT_VARIANTS_MAP 不同的屏;同款屏 fall through 走默认
#
# 耗材类: 清洁化学品/拖布/海绵等,产品形态小、需要"清洁/科研/仓储"叙事
#   - hero    → lab_minimal     (vs 默认 showroom — 商场调性对耗材太"重")
#   - scene   → warehouse_aisle (vs 默认 mall_corridor — 仓储语境更准)
#   - 其他屏共享默认 (advantages/specs/vs/brand/cta 抽象度高,品类无关)
CATEGORY_VARIANTS_MAP: dict[str, dict[str, str]] = {
    "耗材类": {
        "hero": "lab_minimal",
        "scene": "warehouse_aisle",
    },
}


def resolve_variants_map(product_category: str | None) -> dict[str, str]:
    """根据品类返回合并后的 variants map。

    合并规则: DEFAULT_VARIANTS_MAP 全键 + CATEGORY_VARIANTS_MAP[category] 覆盖。
    品类没列 / 传空 → 直接返回 DEFAULT_VARIANTS_MAP 原引用 (零拷贝)。

    用例:
        >>> m = resolve_variants_map("耗材类")
        >>> m["hero"], m["scene"], m["specs"]
        ('lab_minimal', 'warehouse_aisle', 'frosted_glass')
        >>> resolve_variants_map("设备类") is DEFAULT_VARIANTS_MAP
        True
    """
    overlay = CATEGORY_VARIANTS_MAP.get((product_category or "").strip())
    if not overlay:
        return DEFAULT_VARIANTS_MAP
    return {**DEFAULT_VARIANTS_MAP, **overlay}


# ── Prompt 构建 ────────────────────────────────────────────────────────

def _fmt(template: str, pal: dict) -> str:
    try:
        return template.format(**pal)
    except Exception:
        return template


def _variant_dict(screen_type: str, variant: str | None) -> dict:
    pool = SCREEN_VARIANTS.get(screen_type)
    if not pool:
        if screen_type == "story":
            return SCREEN_VARIANTS["advantages"]["soft_paper"]
        return SCREEN_VARIANTS["hero"]["showroom"]
    if variant and variant in pool:
        return pool[variant]
    default_v = DEFAULT_VARIANT.get(screen_type)
    if default_v and default_v in pool:
        return pool[default_v]
    return next(iter(pool.values()))


def _transition_hint(prev_screen: str | None, next_screen: str | None,
                     pal: dict,
                     prev_variant: str | None = None,
                     next_variant: str | None = None) -> str:
    """
    色调 + 反模式过渡提示。
    关键：绝对不出现屏幕英文名（hero/advantages/specs/vs/scene/brand/cta），
    否则模型会把英文名直接渲染成图中文字（v1 specs 段的 "Advantages" 来源）。

    prev_variant/next_variant: 邻屏**实际使用**的 variant。
    不传 → 回退 DEFAULT_VARIANT。必须传才能让拼接两侧的 palette 描述一致,
    否则 transition hint 算错,Seedream 会按错误方向着色边缘,反而产生明显色带。
    """
    parts = []
    if prev_screen is None:
        parts.append(
            "the top edge establishes a quiet anchoring tone with no hard line"
        )
    else:
        prev_v = _variant_dict(prev_screen, prev_variant or DEFAULT_VARIANT.get(prev_screen))
        prev_palette = _fmt(prev_v["palette"], pal)
        parts.append(
            f"the top fringe carries a lingering tonal echo of {prev_palette}, "
            f"blending as a seamless atmospheric gradient with absolutely no visible seam, stripe, color block, or border line"
        )
    if next_screen is None:
        parts.append(
            "the bottom edge settles into a grounded closing tone with no hard line"
        )
    else:
        next_v = _variant_dict(next_screen, next_variant or DEFAULT_VARIANT.get(next_screen))
        next_palette = _fmt(next_v["palette"], pal)
        parts.append(
            f"the bottom fringe softly dissolves toward {next_palette}, "
            f"a purely atmospheric gradient with absolutely no visible seam, stripe, color block, or border line"
        )
    return "; ".join(parts)


def build_prompt(screen_type: str,
                 variant: str | None,
                 theme_id: str,
                 prev_screen: str | None = None,
                 next_screen: str | None = None,
                 product_hint: str = "",
                 prev_variant: str | None = None,
                 next_variant: str | None = None) -> str:
    """
    构建单屏 prompt（自然语言散文，无大写分段标签，无电商词）。
    """
    pal = _resolve_theme(theme_id)
    v = _variant_dict(screen_type, variant)

    sentences = [
        # 开头框架词：纯摄影，不是 "e-commerce detail page"
        "A natural photographic environment study captured as a single cinematic still frame.",
        f"Scene setting: {_fmt(v['scene'], pal)}.",
        f"Light and shadow: {_fmt(v['lighting'], pal)}.",
        f"Color atmosphere: {_fmt(v['palette'], pal)}.",
        f"Surface and material: {_fmt(v['material'], pal)}.",
        f"Compositional breathing: {_fmt(v['composition'], pal)}, the central region is wide and uncluttered with generous negative space.",
        f"Emotional quality: {_fmt(v['emotion'], pal)}, the overall feeling reads as {pal['mood_word']}.",
    ]

    # 过渡提示 —— 纯色调 + 强否定（无屏幕名）
    # 把邻屏的实际 variant 传下去,确保接缝两侧的 palette 描述一致(不再硬编码 DEFAULT)
    transition = _transition_hint(prev_screen, next_screen, pal,
                                  prev_variant=prev_variant,
                                  next_variant=next_variant)
    if transition:
        sentences.append(f"Edge continuity: {transition}.")

    # hero 屏可以暗示用途语境（避免 "equipment" 文字化）
    if screen_type == "hero" and product_hint:
        sentences.append(
            f"The environment subtly evokes a workplace context where {product_hint} "
            f"would be used, yet no such object, machine, or vehicle appears in the frame."
        )

    # 最后三条强约束 —— 描述式写法（不是命令式），避免模型把指令当标题渲染
    sentences.extend([
        "The frame contains only atmosphere, light, and surfaces — it is an empty environment study.",
        "There is absolutely no written language anywhere: no letters, no digits, no chinese characters, no japanese characters, no typography, no watermark, no logo, no signage, no label, no caption.",
        "There are no people, no living beings, no products, no machines, no vehicles, no furniture, no clutter of any kind.",
        "The central visual region stays wide and quiet for later compositing.",
    ])

    sentences.append(QUALITY_SUFFIX + ".")

    # 输出为单段连贯散文（不用分行 / 不用大写标签）
    return " ".join(sentences)


# ── 对外主函数 ─────────────────────────────────────────────────────────

def list_variants(screen_type: str) -> list[str]:
    return list(SCREEN_VARIANTS.get(screen_type, {}).keys())


def list_themes() -> list[str]:
    return [k for k, v in THEME_PALETTE.items() if v is not None] + \
           list(_THEME_ALIAS.keys())


def get_prompts_for_theme(theme_id: str,
                          screen_list: list[str],
                          variants: dict[str, str] | None = None,
                          product_hint: str = "") -> list[dict]:
    """
    根据主题 ID 和屏幕列表返回 prompt 序列。

    优先级：显式 variants > DEFAULT_VARIANT。

    返回 list[dict]，每项：
    {
        "zone":            "hero",
        "variant":         "showroom",
        "height":          1334,
        "overlap_bottom":  120,
        "prompt":          "...",
        "negative_prompt": "...",
    }
    """
    variants = variants or {}
    out: list[dict] = []
    for i, z in enumerate(screen_list):
        prev_z = screen_list[i - 1] if i > 0 else None
        next_z = screen_list[i + 1] if i + 1 < len(screen_list) else None
        variant = variants.get(z) or DEFAULT_VARIANT.get(z)
        prev_variant = variants.get(prev_z) if prev_z else None
        next_variant = variants.get(next_z) if next_z else None
        prompt = build_prompt(z, variant, theme_id, prev_z, next_z, product_hint,
                              prev_variant=prev_variant, next_variant=next_variant)
        out.append({
            "zone":            z,
            "variant":         variant or "default",
            "height":          SCREEN_HEIGHT.get(z, 1000),
            "overlap_bottom":  SCREEN_OVERLAP.get(z, 100) if next_z else 0,
            "prompt":          prompt,
            "negative_prompt": NEGATIVE_PROMPT,
        })
    return out


if __name__ == "__main__":
    seq = get_prompts_for_theme(
        "classic-red",
        ["hero", "advantages", "specs", "vs", "brand"],
        product_hint="commercial driving-type floor scrubber",
    )
    print(f"生成 {len(seq)} 段 prompt:")
    for item in seq:
        print(f"\n[{item['zone']} / {item['variant']}] h={item['height']} overlap={item['overlap_bottom']}")
        print("-" * 60)
        print(item["prompt"])
