"""阶段一·任务 1.3: 真调 DeepSeek plan_v2 评审 3 个产品的 v2 schema 输出.

只调 DeepSeek, 不烧 gpt-image-2. 单产品估算 ~¥0.03, 3 产品 ~¥0.08.
失败 + 重试一次的最坏情况: ~¥0.16.

用法:
    python scripts/stage1_planner_eval.py --dry-run    # 只渲染 prompt 不调 API
    python scripts/stage1_planner_eval.py              # 真调 (需 DEEPSEEK_API_KEY)
    python scripts/stage1_planner_eval.py --product dz70x  # 只跑一个

输出:
    stage1_eval_output/<product_id>/_planning_v2.json     # 完整 v2 schema dict
    stage1_eval_output/<product_id>/_meta.json            # 调用元信息
    stage1_eval_output/_summary.md                        # Scott 评审汇总
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO))

# 跟 app.py L27 一样从仓库根 .env 加载, 让 CLI 也能读 DEEPSEEK_API_KEY
from dotenv import load_dotenv  # noqa: E402
load_dotenv(_REPO / ".env")

from ai_refine_v2.refine_planner import plan_v2, PlannerError  # noqa: E402
from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2, USER_PROMPT_TEMPLATE_V2  # noqa: E402

_OUT = _REPO / "stage1_eval_output"

# 3 个产品文案路径 (Scott 在阶段一·任务 1.3 指定)
_PRODUCTS = [
    {
        "id": "dz70x",
        "title": "德威莱克商用清洁机器人 DZ70X (盘刷版)",
        "text_path": Path(r"C:\Users\28293\Desktop\测试\DZ70X新品1\新建文本文档.txt"),
        "complexity": "中等 · 8 卖点",
    },
    {
        "id": "dz95x",
        "title": "德威莱克商用清洁机器人 DZ95X (滚刷版)",
        "text_path": Path(r"C:\Users\28293\Desktop\测试\DZ95X新品1\新建文本文档.txt"),
        "complexity": "复杂 · 7 卖点详细 + 多场景",
    },
    {
        "id": "dz600m",
        "title": "德威莱克无人水面清洁机 DZ600M",
        "text_path": Path(r"C:\Users\28293\Desktop\测试\DZ600M无人水面清洁机新品1\新建文本文档.txt"),
        "complexity": "特殊形态 · 4 大特点 · 应明显跟商用清洁机不同",
    },
]


def _render_user_prompt(product: dict, text: str) -> str:
    return USER_PROMPT_TEMPLATE_V2.format(
        product_text=text.strip(),
        product_title_hint=product["title"],
        product_image_hint="(暂无, 从文案 + 品类推断视觉特征)",
    )


def _do_dry_run(products: list[dict]) -> int:
    """渲染每个产品的 user prompt 给 Scott 审, 不调 API."""
    print("=" * 70)
    print("DRY-RUN · 不调任何 API · 只展示 prompt 内容")
    print("=" * 70)

    print(f"\n[SYSTEM PROMPT V2]")
    print(f"  长度: {len(SYSTEM_PROMPT_V2)} 字符")
    print(f"  含 'logo' 提及: {SYSTEM_PROMPT_V2.lower().count('logo')} 次")
    print(f"  含 '「」' 提及: {SYSTEM_PROMPT_V2.count('「」')} 次")
    print(f"  含 '导演视角' 提及: {SYSTEM_PROMPT_V2.count('导演视角')} 次")
    print(f"  含 'style_dna' 提及: {SYSTEM_PROMPT_V2.count('style_dna')} 次")
    print(f"  完整版见: ai_refine_v2/prompts/planner.py · SYSTEM_PROMPT_V2")

    print(f"\n[每个产品的 USER PROMPT]")
    for p in products:
        text = p["text_path"].read_text(encoding="utf-8").strip()
        user_prompt = _render_user_prompt(p, text)
        print(f"\n──── {p['id']} ({p['complexity']}) ────")
        print(f"  文案 {len(text)} 字符")
        print(f"  user_prompt {len(user_prompt)} 字符")
        print(f"  ├─ 完整 user_prompt 内容 ─┤")
        for line in user_prompt.splitlines():
            print(f"  │ {line}")
        print(f"  └─" + "─" * 30 + "┘")

    # 估算总 token + 成本
    print(f"\n[成本预估 · 单产品]")
    sys_chars = len(SYSTEM_PROMPT_V2)
    avg_user_chars = sum(
        len(_render_user_prompt(p, p["text_path"].read_text(encoding="utf-8")))
        for p in products
    ) / max(len(products), 1)
    # 粗估: 中英混合 1 char ≈ 0.6 token
    in_tokens = (sys_chars + avg_user_chars) * 0.6
    # 输出: 6-10 屏 × 800-2000 字符 prompt + style_dna ≈ 8000-15000 字符
    out_tokens_min = 8000 * 0.6
    out_tokens_max = 15000 * 0.6
    # DeepSeek-chat: 输入 ¥1/M token, 输出 ¥2/M token
    cost_min = in_tokens * 1e-6 + out_tokens_min * 2e-6
    cost_max = in_tokens * 1e-6 + out_tokens_max * 2e-6
    print(f"  输入 tokens 估算: ~{int(in_tokens)} (system {int(sys_chars*0.6)} + user 平均 {int(avg_user_chars*0.6)})")
    print(f"  输出 tokens 估算: ~{int(out_tokens_min)} - {int(out_tokens_max)}")
    print(f"  单产品成本估算: ¥{cost_min:.4f} - ¥{cost_max:.4f}")
    print(f"\n[3 产品总成本估算]")
    print(f"  最佳: ¥{cost_min * len(products):.4f}")
    print(f"  最坏: ¥{cost_max * len(products):.4f}")
    print(f"  含 1 次重试最坏: ¥{cost_max * len(products) * 2:.4f}")
    print(f"\n[Scott 预算上限] ¥3 (逼近停下问)")
    print(f"\n如确认要真调, 跑: python scripts/stage1_planner_eval.py")
    return 0


def _run_one(product: dict) -> dict:
    text = product["text_path"].read_text(encoding="utf-8").strip()
    print(f"\n══════ {product['id']} · {product['title']} ══════")
    print(f"  complexity: {product['complexity']}")
    print(f"  文案 {len(text)} 字符")

    out_dir = _OUT / product["id"]
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    try:
        result = plan_v2(
            product_text=text,
            product_image_url=None,
            product_title=product["title"],
            api_key=None,  # 从 env DEEPSEEK_API_KEY 读
            max_retries=1,
        )
    except PlannerError as e:
        elapsed = round(time.time() - t0, 2)
        print(f"  ✗ FAIL ({elapsed}s): {e}")
        meta = {
            "product": product["id"],
            "title": product["title"],
            "elapsed_s": elapsed,
            "status": "failed",
            "error": str(e),
        }
        (out_dir / "_meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return meta

    elapsed = round(time.time() - t0, 2)

    # 落盘完整 v2 schema
    (out_dir / "_planning_v2.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    # 同时落盘原始文本 (方便对照)
    (out_dir / "_input_text.txt").write_text(text, encoding="utf-8")

    # 统计
    sd = result.get("style_dna", {})
    screens = result.get("screens", [])
    prompt_lens = [len(s.get("prompt", "")) for s in screens]
    meta = {
        "product": product["id"],
        "title": product["title"],
        "elapsed_s": elapsed,
        "status": "success",
        "screen_count": result.get("screen_count"),
        "style_dna_field_lens": {k: len(sd.get(k, "")) for k in sd},
        "screen_prompt_lens": {
            "min": min(prompt_lens) if prompt_lens else 0,
            "max": max(prompt_lens) if prompt_lens else 0,
            "mean": round(sum(prompt_lens) / len(prompt_lens), 1) if prompt_lens else 0,
            "all": prompt_lens,
        },
        "screen_roles": [s.get("role") for s in screens],
        "screen_titles": [s.get("title") for s in screens],
    }
    (out_dir / "_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # 简要打屏
    print(f"  ✓ OK ({elapsed}s)")
    print(f"    screen_count = {meta['screen_count']}")
    print(f"    prompt_lens min/max/mean = "
          f"{meta['screen_prompt_lens']['min']}/"
          f"{meta['screen_prompt_lens']['max']}/"
          f"{meta['screen_prompt_lens']['mean']}")
    print(f"    roles  = {meta['screen_roles']}")
    print(f"    titles = {meta['screen_titles']}")
    print(f"    style_dna 字段长度:")
    for k, v in sd.items():
        preview = v[:60].replace("\n", " ") + ("..." if len(v) > 60 else "")
        print(f"      {k} ({len(v)} chars): {preview}")
    return meta


def _write_summary(metas: list[dict]):
    lines = [
        "# 阶段一·任务 1.3 · plan_v2 真调汇总报告\n\n",
        f"生成时间: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n",
        f"产品数: {len(metas)}\n",
    ]
    success = sum(1 for m in metas if m.get("status") == "success")
    failed = len(metas) - success
    lines.append(f"成功: {success} | 失败: {failed}\n\n")

    for m in metas:
        lines.append(f"---\n\n## {m.get('product')} — {m.get('title')}\n\n")
        lines.append(f"- 状态: **{m.get('status')}**\n")
        lines.append(f"- 耗时: {m.get('elapsed_s')} s\n")
        if m.get("status") == "success":
            lines.append(f"- screen_count: **{m.get('screen_count')}**\n")
            spl = m["screen_prompt_lens"]
            lines.append(f"- screen prompts 长度 (min / max / mean): **{spl['min']} / {spl['max']} / {spl['mean']}**\n")
            lines.append(f"- 各屏长度: {spl['all']}\n")
            lines.append(f"- 屏型 roles: {m.get('screen_roles')}\n")
            lines.append(f"- 屏标题: {m.get('screen_titles')}\n")
            lines.append(f"- style_dna 字段长度: {m.get('style_dna_field_lens')}\n")
            lines.append(f"\n详见 `stage1_eval_output/{m['product']}/_planning_v2.json`\n")
        else:
            lines.append(f"- 错误: `{m.get('error')}`\n")
        lines.append("\n")

    out_path = _OUT / "_summary.md"
    out_path.write_text("".join(lines), encoding="utf-8")
    print(f"\n✓ 汇总报告: {out_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true",
                    help="只渲染 prompt 不调 API, 让 Scott 审 prompt 内容")
    ap.add_argument("--product",
                    choices=[p["id"] for p in _PRODUCTS],
                    help="只跑指定产品 (默认 3 个全跑)")
    args = ap.parse_args()

    products = [p for p in _PRODUCTS if not args.product or p["id"] == args.product]

    if args.dry_run:
        sys.exit(_do_dry_run(products))

    if not os.environ.get("DEEPSEEK_API_KEY", "").strip():
        print("[FAIL] DEEPSEEK_API_KEY 未配置 — 设 env 后重试")
        sys.exit(1)

    print(f"准备真调 plan_v2 × {len(products)} 个产品 · 烧 DeepSeek 钱")
    _OUT.mkdir(parents=True, exist_ok=True)
    metas = []
    for p in products:
        metas.append(_run_one(p))
    _write_summary(metas)


if __name__ == "__main__":
    main()
