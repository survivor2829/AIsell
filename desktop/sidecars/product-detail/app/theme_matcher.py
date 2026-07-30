"""主题智能匹配 — 任务9 (PRD F11)。

输入: DeepSeek 解析出的 product_type 字符串 (如 "驾驶式扫地车" / "拖把刷")
      + product_type 大类 (设备类 / 耗材类 / 配件类 / 工具类)
输出: theme_id (themes.json 里的某个 id)

匹配优先级 (从高到低):
  1. 关键词命中 (KEYWORD_RULES) — 最强信号
  2. 大类默认 (CATEGORY_DEFAULT) — 没关键词命中时按 product_type 大类回落
  3. 全局兜底 — classic-red

为什么不直接用 themes.json 的 default_for?
  → default_for 只能表达"大类→主题"一对一映射, 表达不了"AI/智能机器人 → tech-blue"
    这种基于 *具体产品名关键词* 的细粒度匹配, 而 PRD F11 明确要求关键词级路由。

使用示例:
  >>> resolve_theme_id("驾驶式扫地车", "设备类")
  ('classic-red', 'category_default:设备类')
  >>> resolve_theme_id("智能AI识别机器人", "设备类")
  ('tech-blue', 'keyword:智能机器人')
  >>> resolve_theme_id("环保清洁剂", "耗材类")
  ('fresh-green', 'keyword:环保')
"""
from __future__ import annotations

# ── 关键词 → theme_id 路由 (按优先级从上到下匹配; 任意子串命中即用) ──
# Tuple 而非 dict 是因为顺序很关键: "智能机器人" 必须先于 "智能" 之类的弱词
KEYWORD_RULES: tuple[tuple[str, str, str], ...] = (
    # (keyword, theme_id, debug_label)
    # — 科技蓝: AI / 智能 / 机器人 类强信号
    ("智能机器人",       "tech-blue",     "智能机器人"),
    ("AI",              "tech-blue",     "AI"),
    ("人工智能",         "tech-blue",     "人工智能"),
    ("机器人",           "tech-blue",     "机器人"),
    ("智能",             "tech-blue",     "智能"),
    ("自动驾驶",         "tech-blue",     "自动驾驶"),

    # — 黑金高端: 旗舰 / 高端 / 商用专业级
    ("旗舰",             "black-gold",    "旗舰"),
    ("高端",             "black-gold",    "高端"),
    ("尊享",             "black-gold",    "尊享"),
    ("豪华",             "black-gold",    "豪华"),
    ("Pro",              "black-gold",    "Pro"),

    # — 清新绿: 环保 / 绿色 / 可降解 / 耗材化学品 (浓缩/食品级/消毒/抗菌)
    ("环保",             "fresh-green",   "环保"),
    ("绿色",             "fresh-green",   "绿色"),
    ("可降解",           "fresh-green",   "可降解"),
    ("生物",             "fresh-green",   "生物"),
    ("浓缩",             "fresh-green",   "浓缩"),
    ("食品级",           "fresh-green",   "食品级"),
    ("消毒",             "fresh-green",   "消毒"),
    ("抗菌",             "fresh-green",   "抗菌"),

    # — 商务灰: 工业 / B2B / 重型
    ("工业",             "biz-gray",      "工业"),
    ("商用",             "biz-gray",      "商用"),
    ("重型",             "biz-gray",      "重型"),
    ("专业",             "biz-gray",      "专业"),

    # — 活力橙: 工具 / 手持 / 促销/活动
    ("手持",             "energy-orange", "手持"),
    ("工具",             "energy-orange", "工具"),
    ("促销",             "energy-orange", "促销"),

    # — 极简白: 配件 / 简约
    ("配件",             "minimal-white", "配件"),
    ("简约",             "minimal-white", "简约"),

    # — 深蓝专业: 检测 / 测量 / 仪器
    ("检测",             "deep-navy",     "检测"),
    ("测量",             "deep-navy",     "测量"),
    ("仪器",             "deep-navy",     "仪器"),
)

# 没关键词命中时按 product_type 大类回落
# (与 themes.json 里的 default_for 字段保持一致)
CATEGORY_DEFAULT: dict[str, str] = {
    "设备类": "classic-red",
    "工具类": "energy-orange",
    "耗材类": "fresh-green",
    "配件类": "minimal-white",
}

GLOBAL_FALLBACK = "classic-red"

# 已知的 theme_id 白名单 (与 static/themes/themes.json 对齐)
KNOWN_THEME_IDS: frozenset[str] = frozenset({
    "classic-red", "tech-blue", "black-gold", "fresh-green",
    "biz-gray", "energy-orange", "minimal-white", "deep-navy",
})


def resolve_theme_id(parsed_product_type: str | None,
                     product_category: str = "设备类") -> tuple[str, str]:
    """按 PRD F11 规则把 product_type 文本解析成 theme_id。

    Args:
        parsed_product_type: DeepSeek 返回的 parsed.product_type 字段, 例:
            "驾驶式扫地车" / "智能AI识别机器人" / "工业级洗地机"
        product_category: 上传时的产品大类 (设备类/耗材类/工具类/配件类),
            用于关键词都不命中时的兜底。

    Returns:
        (theme_id, matched_by) — matched_by 是调试字段:
            - "keyword:<词>"           关键词命中
            - "category_default:<大类>" 大类回落
            - "global_fallback"         全局兜底
    """
    text = (parsed_product_type or "").strip()
    text_lower = text.lower()

    # 1) 关键词扫描 (大小写不敏感; 中英混合都覆盖)
    if text:
        for kw, theme_id, label in KEYWORD_RULES:
            if kw.lower() in text_lower:
                return theme_id, f"keyword:{label}"

    # 2) 大类回落
    cat_theme = CATEGORY_DEFAULT.get(product_category)
    if cat_theme:
        return cat_theme, f"category_default:{product_category}"

    # 3) 全局兜底
    return GLOBAL_FALLBACK, "global_fallback"


def resolve_with_strategy(strategy: str,
                          fixed_theme_id: str | None,
                          parsed_product_type: str | None,
                          product_category: str = "设备类") -> tuple[str, str]:
    """根据批次的 template_strategy 选 theme_id。

    - strategy="fixed": 直接用 fixed_theme_id (校验白名单后); 无效则降到 auto。
    - strategy="auto" 或其它: 走 resolve_theme_id 智能匹配。

    返回 (theme_id, matched_by)。matched_by 在 fixed 模式下记 "fixed:<id>"。
    """
    if strategy == "fixed" and fixed_theme_id and fixed_theme_id in KNOWN_THEME_IDS:
        return fixed_theme_id, f"fixed:{fixed_theme_id}"
    return resolve_theme_id(parsed_product_type, product_category)


def is_known_theme(theme_id: str | None) -> bool:
    """白名单检查, 防止脏数据流到模板渲染层。"""
    return bool(theme_id) and theme_id in KNOWN_THEME_IDS


if __name__ == "__main__":
    cases = [
        ("驾驶式扫地车",       "设备类"),
        ("智能AI识别机器人",   "设备类"),
        ("AI巡检机器人",       "设备类"),
        ("旗舰版洗地机",       "设备类"),
        ("Pro 商用扫地机",     "设备类"),
        ("环保清洁剂",         "耗材类"),
        ("浓缩消毒喷雾",       "耗材类"),
        ("食品级洗涤剂",       "耗材类"),
        ("抗菌除味剂",         "耗材类"),
        ("工业级吸水胶条",     "配件类"),
        ("手持电动拖把",       "工具类"),
        ("",                  "设备类"),
        ("",                  ""),
    ]
    print(f"{'product_type':<22} {'category':<10} → {'theme_id':<14} {'matched_by'}")
    print("-" * 70)
    for pt, cat in cases:
        tid, why = resolve_theme_id(pt, cat)
        print(f"{pt!r:<22} {cat!r:<10} → {tid:<14} {why}")
