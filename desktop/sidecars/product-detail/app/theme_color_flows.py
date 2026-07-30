"""
主题色调流 — 为每套主题规划从上到下的背景色调节奏
用于 AI 生图「无缝长图」方案：每段 prompt 带上下段色调信息，保证相邻段自然衔接。
"""

ZONE_META = {
    "hero":       {"label": "英雄封面",   "height": 1334, "overlap_bottom": 120},
    "advantages": {"label": "六大优势",   "height": 900,  "overlap_bottom": 100},
    "story":      {"label": "清洁故事",   "height": 1000, "overlap_bottom": 100},
    "specs":      {"label": "核心参数",   "height": 1100, "overlap_bottom": 120},
    "vs":         {"label": "VS对比",    "height": 1000, "overlap_bottom": 100},
    "scene":      {"label": "适用场景",   "height": 900,  "overlap_bottom": 100},
    "brand":      {"label": "品牌背书",   "height": 800,  "overlap_bottom": 0},
}

ZONE_ORDER_DEFAULT = ["hero", "advantages", "story", "specs", "vs", "scene", "brand"]


THEME_COLOR_FLOWS = {
    "classic-red": {
        "name": "经典红",
        "primary": "#E8231A",
        "flow": {
            "hero":       {"bg_tone": "深蓝灰到深红棕渐变，大气商业摄影氛围，顶部有微弱暖光晕，底部接近纯黑以便过渡",      "transition_hint": "底部向纯白过渡"},
            "advantages": {"bg_tone": "纯净的浅灰白到极浅暖灰渐变，干净极简，轻微的颗粒质感，适合深色文字",             "transition_hint": "底部向浅暖灰过渡"},
            "story":      {"bg_tone": "柔和的暖米灰到淡奶油色，自然漫射光，纸感背景，温暖但克制",                          "transition_hint": "底部向深色过渡"},
            "specs":      {"bg_tone": "深蓝黑到石墨灰渐变，科技磨砂质感，细微网格线点缀，适合白色参数文字",                  "transition_hint": "底部向纯白过渡"},
            "vs":         {"bg_tone": "左明右暗的分屏视觉，整体偏中性灰白，有微弱的中线光带",                              "transition_hint": "底部向浅灰过渡"},
            "scene":      {"bg_tone": "浅冷灰到暖灰渐变，模拟真实场景环境光，适合场景图网格",                                "transition_hint": "底部向品牌红过渡"},
            "brand":      {"bg_tone": "深红棕渐变到纯黑，带有微弱的金属光泽和顶部高光",                                    "transition_hint": "无"},
        },
    },
    "tech-blue": {
        "name": "科技蓝",
        "primary": "#2F6BFF",
        "flow": {
            "hero":       {"bg_tone": "深海蓝到午夜蓝渐变，星光颗粒点缀，顶部光带，底部深邃",          "transition_hint": "底部向浅蓝白过渡"},
            "advantages": {"bg_tone": "浅蓝白渐变到冰蓝，清新干净，微弱的网格纹理",                   "transition_hint": "底部向中蓝灰过渡"},
            "story":      {"bg_tone": "雾蓝到浅灰蓝，柔和自然光，干净利落",                           "transition_hint": "底部向深蓝过渡"},
            "specs":      {"bg_tone": "深蓝黑渐变，科技几何线条，荧光蓝点装饰",                       "transition_hint": "底部向白过渡"},
            "vs":         {"bg_tone": "左白右深蓝的分屏视觉，中间有蓝色光带",                         "transition_hint": "底部向浅灰蓝过渡"},
            "scene":      {"bg_tone": "浅灰到雾蓝的柔和渐变，真实环境感",                            "transition_hint": "底部向深蓝过渡"},
            "brand":      {"bg_tone": "深蓝黑渐变到纯黑，金属质感",                                  "transition_hint": "无"},
        },
    },
    "minimal-mono": {
        "name": "极简黑白",
        "primary": "#111111",
        "flow": {
            "hero":       {"bg_tone": "纯黑到深灰渐变，柔和顶光，极简现代",        "transition_hint": "底部向白过渡"},
            "advantages": {"bg_tone": "纯白到浅灰，干净素雅",                      "transition_hint": "底部向浅灰过渡"},
            "story":      {"bg_tone": "浅暖灰渐变，纸感质朴",                      "transition_hint": "底部向深色过渡"},
            "specs":      {"bg_tone": "深灰黑渐变，磨砂质感，白色几何线条",        "transition_hint": "底部向白过渡"},
            "vs":         {"bg_tone": "左白右黑分屏，中线为灰色光带",              "transition_hint": "底部向浅灰过渡"},
            "scene":      {"bg_tone": "浅灰到中灰的柔和渐变",                      "transition_hint": "底部向黑过渡"},
            "brand":      {"bg_tone": "纯黑底渐变，顶部微弱白色光",                "transition_hint": "无"},
        },
    },
}


def get_flow(theme_id: str) -> dict:
    """按 theme_id 取色调流，未命中时 fallback 到 classic-red"""
    return THEME_COLOR_FLOWS.get(theme_id) or THEME_COLOR_FLOWS["classic-red"]


def build_segment_prompt(zone: str,
                         theme_id: str,
                         prev_zone: str | None,
                         next_zone: str | None,
                         product_hint: str = "") -> str:
    """
    为单段背景生成 prompt，自动带入上一段和下一段的色调信息，
    保证上下边缘自然衔接。

    zone: "hero" | "advantages" | "story" | "specs" | "vs" | "scene" | "brand"
    theme_id: 主题 ID
    prev_zone/next_zone: 相邻段（顶部段 prev=None，底部段 next=None）
    product_hint: 可选的产品类型提示（仅用于 hero/scene）
    """
    flow = get_flow(theme_id)["flow"]
    curr = flow.get(zone) or flow["hero"]

    prev_tone = flow.get(prev_zone, {}).get("bg_tone") if prev_zone else None
    next_tone = flow.get(next_zone, {}).get("bg_tone") if next_zone else None

    lines = [
        "电商产品详情页背景长图的一段，专业商业设计级质感，",
        f"当前段氛围：{curr['bg_tone']}。",
    ]
    if prev_tone:
        lines.append(f"顶部边缘需要和上一段自然衔接，上一段色调是：{prev_tone}。")
    else:
        lines.append("这是详情页的最顶部，顶部可以有强视觉主导色。")

    if next_tone:
        lines.append(f"底部边缘需要向下一段平滑过渡，下一段色调是：{next_tone}。")
    else:
        lines.append("这是详情页的最底部，底部可以有落地收束感。")

    if zone == "hero" and product_hint:
        lines.append(f"环境氛围可暗示「{product_hint}」的应用场景，但不要画出产品本身。")

    lines += [
        "严格要求：",
        "- 整张图是连续的纯背景氛围图，**不要画任何产品、不要画任何人物、不要出现任何文字或水印**；",
        "- 中央需要留出大面积干净的空间用于叠加产品图和中文文字；",
        "- 光线和色调专业克制，避免过度饱和、避免卡通风格；",
        "- 8K 超清，高级质感，商业摄影光影语言。",
    ]
    return "\n".join(lines)


def plan_seamless_page(theme_id: str,
                       zones: list[str] | None = None,
                       product_hint: str = "") -> list[dict]:
    """
    规划一张无缝长图需要生成的段列表，每段包含 zone/height/prompt/overlap。

    返回 list[dict]，每项：
    {
        "zone": "hero",
        "height": 1334,
        "overlap_bottom": 120,
        "prompt": "...",
    }
    """
    zones = zones or ZONE_ORDER_DEFAULT
    result = []
    for i, z in enumerate(zones):
        meta = ZONE_META.get(z)
        if not meta:
            continue
        prev_z = zones[i - 1] if i > 0 else None
        next_z = zones[i + 1] if i + 1 < len(zones) else None
        result.append({
            "zone": z,
            "height": meta["height"],
            "overlap_bottom": meta["overlap_bottom"] if next_z else 0,
            "prompt": build_segment_prompt(z, theme_id, prev_z, next_z, product_hint),
        })
    return result


if __name__ == "__main__":
    plan = plan_seamless_page("classic-red", product_hint="商用清洁机器人")
    print(f"生成 {len(plan)} 段：")
    for p in plan:
        print(f"  [{p['zone']}] h={p['height']} overlap={p['overlap_bottom']}")
        print(f"    {p['prompt'][:80]}...")
