"""
真实洗地机产品 AI 精修全流程 e2e：
5 屏通义万相生成 → image_composer 合成（背景+产品+文字）→ output/real_product_test.png
"""
import os
import sys
import time
import traceback
from pathlib import Path

import ai_image_router
import image_composer
import prompt_templates  # noqa: F401  (间接经由 router)

BASE = Path(__file__).parent


# ── 1. DashScope API Key（环境变量 or .env） ──────────────────────────
def _load_api_key() -> str:
    key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if key:
        return key
    env_path = BASE / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("DASHSCOPE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


api_key = _load_api_key()
if not api_key:
    print("[FATAL] 未找到 DASHSCOPE_API_KEY（环境变量或 .env）")
    sys.exit(2)


# ── 2. 洗地机产品数据（DZ50X 驾驶式） ─────────────────────────────────
product_data = {
    "brand":         "德威莱克",
    "brand_text":    "德威莱克",
    "model":         "DZ50X",
    "model_name":    "DZ50X",
    "product_name":  "驾驶式洗地机",
    "product_type":  "驾驶式洗地机",
    "category_line": "驾驶式洗地机",
    "main_title":    "DZ50X 驾驶式洗地机",
    "tagline_line1": "一台顶八人",
    "tagline_line2": "效率 3600㎡/h",
    "sub_slogan":    "商用清洁 · 智能驾驶",
    "slogan":        "解放人力 · 提升效率",

    "param_1_label": "清扫效率", "param_1_value": "3600㎡/h",
    "param_2_label": "清扫宽度", "param_2_value": "850mm",
    "param_3_label": "续航时间", "param_3_value": "4小时",
    "param_4_label": "运行噪音", "param_4_value": "≤68dB",

    "advantages": [
        {"emoji": "⚡",  "text": "高效清扫 3600㎡/h"},
        {"emoji": "💧",  "text": "90L 大水箱长续航"},
        {"emoji": "🔋",  "text": "锂电 4 小时连续"},
        {"emoji": "🔇",  "text": "≤68dB 静音不扰客"},
        {"emoji": "📐",  "text": "1.2m 精准转弯"},
        {"emoji": "🛡️",  "text": "多重安全防护"},
    ],
    "specs": [
        {"name": "清扫效率", "value": "3600㎡/h"},
        {"name": "续航时间", "value": "4小时"},
        {"name": "水箱容量", "value": "清水90L/污水100L"},
        {"name": "整机重量", "value": "285kg"},
        {"name": "工作宽度", "value": "850mm"},
        {"name": "噪声值",   "value": "≤68dB"},
    ],
    "vs_comparison": {
        "left_title": "传统人工",
        "left_items": ["效率 200㎡/h", "8 人轮班", "月成本 2 万"],
        "right_title": "DZ50X",
        "right_items": ["效率 3600㎡/h", "1 人操作", "月成本 0.5 万"],
    },
    "footer_note": "*产品参数以实物为准，图片仅供参考",
}


# ── 3. 产品抠图 ───────────────────────────────────────────────────────
candidate = BASE / "output" / "dz10_product_nobg.png"
if candidate.exists():
    product_image = str(candidate)
else:
    # 兜底：挑一张最大的 _nobg.png
    pool = sorted(
        (BASE / "output").glob("*_nobg.png"),
        key=lambda p: p.stat().st_size, reverse=True,
    )
    product_image = str(pool[0]) if pool else ""
print(f"[e2e] 产品抠图: {product_image or '（无）'}")


# ── 4. 规划 5 屏 ──────────────────────────────────────────────────────
zones = ["hero", "advantages", "specs", "vs", "brand"]
plan = ai_image_router.plan_page(
    theme_id="classic-red",
    zones=zones,
    product_hint="驾驶式洗地机，商用清洁设备",
)
print(f"[e2e] 规划 {len(plan)} 屏: {[p['zone'] for p in plan]}")
for p in plan:
    print(f"  - {p['zone']:10s} variant={p['variant']:14s} h={p['height']:4d} "
          f"overlap={p['overlap_bottom']:3d}")


# ── 5. 逐段通义万相生成 ───────────────────────────────────────────────
seg_dir = BASE / "output" / "real_product_test_segments"
seg_dir.mkdir(parents=True, exist_ok=True)
api_keys = {"dashscope_api_key": api_key, "ark_api_key": ""}

segment_paths = []
t_total = time.time()
for i, seg in enumerate(plan):
    zone = seg["zone"]
    t0 = time.time()
    print(f"\n[e2e] [{i+1}/{len(plan)}] 调用通义万相生成 {zone} ...")
    try:
        local = ai_image_router.generate_segment_to_local(
            engine="wanxiang",
            zone=zone,
            prompt=seg["prompt"],
            api_keys=api_keys,
            save_dir=seg_dir,
            width=750,
            height=seg["height"],
            filename=f"{zone}.png",
        )
    except Exception as e:
        traceback.print_exc()
        local = ""
    segment_paths.append(local)
    elapsed = time.time() - t0
    ok = "✅" if local else "❌"
    print(f"[e2e]   {ok} {zone} 耗时 {elapsed:.1f}s → {local or '失败'}")

print(f"\n[e2e] 5 屏生成完成，总计 {time.time()-t_total:.1f}s")


# ── 6. 合成最终长图 ───────────────────────────────────────────────────
# 过滤空段以保持 plan/paths 对齐
pairs = [(p, s) for p, s in zip(plan, segment_paths) if s]
if not pairs:
    print("[FATAL] 所有段生成失败，无法合成")
    sys.exit(1)

valid_plan   = [p for p, _ in pairs]
valid_paths  = [s for _, s in pairs]
skipped      = [p["zone"] for p, s in zip(plan, segment_paths) if not s]
if skipped:
    print(f"[e2e] ⚠️ 跳过失败段: {skipped}")

out_path = BASE / "output" / "real_product_test.png"
print(f"\n[e2e] 合成最终长图 → {out_path}")
t_compose = time.time()
result = image_composer.compose_seamless_detail_page(
    product_data=product_data,
    plan=valid_plan,
    segment_paths=valid_paths,
    product_image=product_image,
    output_path=str(out_path),
    theme_primary="#E8231A",
)
print(f"[e2e] 合成耗时 {time.time()-t_compose:.1f}s")

from PIL import Image
img = Image.open(result)
print("=" * 60)
print(f"[e2e] ✅ 全部完成")
print(f"  最终长图: {result}")
print(f"  尺寸:     {img.width} × {img.height}")
print(f"  大小:     {Path(result).stat().st_size/1024:.1f} KB")
print(f"  成功屏:   {len(valid_plan)}/{len(plan)} ({[p['zone'] for p in valid_plan]})")
print(f"  总耗时:   {time.time()-t_total:.1f}s")
