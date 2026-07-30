"""任务10 费用预估 — 豆包 Seedream 单价配置 + 估算函数。

PRD F6:
  即将对 X 个产品进行AI精修
  预估消耗：X × 6 = XX 次豆包Seedream API调用
  预估费用：约 ¥XX.XX 元
  预估耗时：约 X 分钟

为什么单独成模块?
  → 豆包价格会变,运维只需改这一个文件,不动 app.py / batch_processor.py。
  → 单测友好 (无副作用,纯函数)。
"""
from __future__ import annotations

import os

# ── 可调参数 ─────────────────────────────────────────────────────────────
# 豆包 Seedream 文生图当前单价 (元/次调用)。变价时只改这里。
SEEDREAM_UNIT_PRICE_YUAN: float = 0.20

# v3.3 单屏 reroll 单价 (gpt-image-2 一次调用约 ¥0.7, 与批次 v2 path 同级 model).
# 改这个值的运维场景: APIMart 调价, 或换 model.
REGEN_SCREEN_UNIT_PRICE_YUAN = 0.70

# 物理余额保护上限 (元) — 单次 /ai-refine-start 请求预估超过此值直接 400 拦住。
# 防止用户手滑勾选过多产品或前端 bug 导致一次烧光豆包额度。
# 环境变量 MAX_REFINE_COST_PER_RUN 覆盖, 默认 ¥5 = 4 个产品 × 6 屏 × ¥0.20 还剩 ¥0.2 余量。
# 2026-04-20 线上事故后加 — 当次用户连点 3 次确认烧了 ¥10.8, 有此上限就只会烧 ¥4.8.
try:
    MAX_REFINE_COST_PER_RUN: float = float(
        os.environ.get("MAX_REFINE_COST_PER_RUN", "5.0")
    )
except (TypeError, ValueError):
    MAX_REFINE_COST_PER_RUN = 5.0

# 每个产品 AI 精修需要生成的屏数 (PRD F6: "X × 6")。
# 对应 theme_color_flows.ZONE_ORDER_DEFAULT 里需要 AI 背景的屏:
#   hero / advantages / story / specs / vs / scene  (brand 屏不烧背景)。
ZONES_PER_PRODUCT: int = 6

# 端到端吞吐 (次/分钟): 3 并发 × Seedream ~6s/call + Playwright/合成开销 ~10s
# 实测约 25 次/分钟。给 0.7 系数留余量,对外说 17。变更需基于真实日志校准。
THROUGHPUT_PER_MINUTE: float = 17.0


# ── 计算函数 ─────────────────────────────────────────────────────────────
def compute_estimate(product_count: int) -> dict:
    """估算 N 个产品做完 AI 精修的 调用数 / 费用 / 耗时。

    返回 dict 直接喂给 jsonify; 字段命名和前端模板一一对应,改名要双侧改。

    Args:
        product_count: 要精修的产品数 (已勾选且 status=done)。

    Returns:
        {
          "count": int,
          "api_calls": int,
          "est_cost_yuan": float,           # 已 round 2 位
          "est_minutes": float,             # 已 round 1 位,最小 1 分钟
          "unit_price_yuan": float,         # 当前单价(给前端透明展示)
          "zones_per_product": int,         # 每产品屏数(给前端展示 "X × 6 =")
        }
    """
    n = max(0, int(product_count))
    api_calls = n * ZONES_PER_PRODUCT
    est_cost = round(api_calls * SEEDREAM_UNIT_PRICE_YUAN, 2)
    # 至少给 1 分钟兜底 — 0 分钟会让 UI 显示 "约 0 分钟" 很奇怪
    est_min_raw = api_calls / THROUGHPUT_PER_MINUTE if api_calls > 0 else 0
    est_minutes = round(max(est_min_raw, 1.0), 1) if api_calls > 0 else 0.0
    return {
        "count": n,
        "api_calls": api_calls,
        "est_cost_yuan": est_cost,
        "est_minutes": est_minutes,
        "unit_price_yuan": SEEDREAM_UNIT_PRICE_YUAN,
        "zones_per_product": ZONES_PER_PRODUCT,
    }
