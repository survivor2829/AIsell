"""AI 精修 v2 · 卖点驱动动态生成模块 (Phase 2 · W1 Day 3-4).

模块入口: from ai_refine_v2.refine_planner import plan

关联文档:
  - docs/PRD_AI_refine_v2/PRD_final.md (方向 D 最终版)
  - docs/PRD_AI_refine_v2/w1_review.md (补丁 A/B/C/D)
  - docs/PRD_AI_refine_v2/w2_review.md (补丁验证 ~100%)

硬约束:
  - 本模块**不依赖** refine_processor.py (W1 不动旧管线)
  - 仅负责"规划层" (DeepSeek), 不做 gpt-image-2 生图 (W2 再说)
"""
from ai_refine_v2.refine_planner import (  # noqa: F401
    plan,
    plan_v2,
    PlannerError,
)
