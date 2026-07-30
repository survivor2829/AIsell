"""
v2 e2e：固定走豆包 Seedream 4.0 + prompt_templates v2（去电商词版）
5 屏（hero/advantages/specs/vs/brand）→ image_composer 合成 → output/prompt_test_v2/final.png

与 v1（run_real_product_e2e.py）唯一差异：
- engine 固定 "seedream"，不走 wanxiang
- 读取 ARK_API_KEY 而非 DASHSCOPE_API_KEY
- 第 1 段失败时立刻 abort（避免 ModelNotOpen 连烧 5 次）
- 输出目录换成 output/prompt_test_v2/
"""
import os
import sys
import time
import traceback
from pathlib import Path

import ai_image_router
import image_composer
import prompt_templates  # noqa: F401

BASE = Path(__file__).parent
ENGINE = "seedream"
OUT_DIR = BASE / "output" / "prompt_test_v2"
SEG_DIR = OUT_DIR / "segments"


# ── 1. ARK API Key 读取（env > .env）────────────────────────────────
def _load_ark_key() -> str:
    key = os.environ.get("ARK_API_KEY", "").strip()
    if key:
        return key
    env_path = BASE / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("ARK_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


ark_key = _load_ark_key()
if not ark_key:
    print("[FATAL] 未找到 ARK_API_KEY（环境变量或 .env）")
    sys.exit(2)

print(f"[v2] 引擎={ENGINE} Key len={len(ark_key)} 模型={ai_image_router.ENGINES[ENGINE]['model']}")


# ── 2. 同 v1 的洗地机产品数据 ─────────────────────────────────────
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


# ── 3. 产品抠图（复用 v1 同一张）────────────────────────────────
candidate = BASE / "output" / "dz10_product_nobg.png"
if candidate.exists():
    product_image = str(candidate)
else:
    pool = sorted(
        (BASE / "output").glob("*_nobg.png"),
        key=lambda p: p.stat().st_size, reverse=True,
    )
    product_image = str(pool[0]) if pool else ""
print(f"[v2] 产品抠图: {product_image or '（无）'}")


# ── 4. 规划 5 屏（与 v1 同顺序，便于 before/after 对比）──────────
zones = ["hero", "advantages", "specs", "vs", "brand"]
plan = ai_image_router.plan_page(
    theme_id="classic-red",
    zones=zones,
    product_hint="驾驶式洗地机，商用清洁设备",
)
print(f"[v2] 规划 {len(plan)} 屏: {[p['zone'] for p in plan]}")
for p in plan:
    print(f"  - {p['zone']:10s} variant={p['variant']:14s} h={p['height']:4d} "
          f"overlap={p['overlap_bottom']:3d}")


# ── 5. 逐段 Seedream 生成（第 1 段失败立刻 abort）────────────────
SEG_DIR.mkdir(parents=True, exist_ok=True)
api_keys = {"dashscope_api_key": "", "ark_api_key": ark_key}

segment_paths = []
t_total = time.time()
for i, seg in enumerate(plan):
    zone = seg["zone"]
    t0 = time.time()
    print(f"\n[v2] [{i+1}/{len(plan)}] 调用 Seedream 生成 {zone} ...")
    try:
        local = ai_image_router.generate_segment_to_local(
            engine=ENGINE,
            zone=zone,
            prompt=seg["prompt"],
            api_keys=api_keys,
            save_dir=SEG_DIR,
            width=750,
            height=seg["height"],
            filename=f"{zone}.png",
        )
    except Exception:
        traceback.print_exc()
        local = ""
    segment_paths.append(local)
    elapsed = time.time() - t0
    ok = "✅" if local else "❌"
    print(f"[v2]   {ok} {zone} 耗时 {elapsed:.1f}s → {local or '失败'}")

    # 第 1 段失败：大概率是 ModelNotOpen / Key 错误 → 立即 abort
    if i == 0 and not local:
        print("\n[FATAL] 第 1 段生成失败。可能原因：")
        print("  - Seedream 4.0 模型未在火山方舟控制台激活：")
        print("    https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement")
        print("  - ARK_API_KEY 过期 / 权限不足")
        print("  - 网络被 Clash 代理劫持（已在 ai_image_volcengine 内清代理）")
        sys.exit(1)

print(f"\n[v2] 5 屏生成完成，总计 {time.time()-t_total:.1f}s")


# ── 6. 合成长图 ──────────────────────────────────────────────────
pairs = [(p, s) for p, s in zip(plan, segment_paths) if s]
if not pairs:
    print("[FATAL] 所有段生成失败，无法合成")
    sys.exit(1)

valid_plan  = [p for p, _ in pairs]
valid_paths = [s for _, s in pairs]
skipped     = [p["zone"] for p, s in zip(plan, segment_paths) if not s]
if skipped:
    print(f"[v2] ⚠️ 跳过失败段: {skipped}")

out_path = OUT_DIR / "final.png"
print(f"\n[v2] 合成最终长图 → {out_path}")
t_compose = time.time()
result = image_composer.compose_seamless_detail_page(
    product_data=product_data,
    plan=valid_plan,
    segment_paths=valid_paths,
    product_image=product_image,
    output_path=str(out_path),
    theme_primary="#E8231A",
)
print(f"[v2] 合成耗时 {time.time()-t_compose:.1f}s")

from PIL import Image
img = Image.open(result)
print("=" * 60)
print(f"[v2] ✅ 全部完成")
print(f"  最终长图: {result}")
print(f"  尺寸:     {img.width} × {img.height}")
print(f"  大小:     {Path(result).stat().st_size/1024:.1f} KB")
print(f"  成功屏:   {len(valid_plan)}/{len(plan)} ({[p['zone'] for p in valid_plan]})")
print(f"  总耗时:   {time.time()-t_total:.1f}s")
