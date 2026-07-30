"""
真实 AI 调用测试：用 DZ50X 设备类产品数据，分别跑通义万相 + 豆包 Seedream，
各生成一张完整无缝详情页长图。

输出：
  output/real_test_wanxiang.png
  output/real_test_seedream.png
"""
import os
import sys
import time
import traceback
from pathlib import Path

# 加载 .env
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # .env keys 已在环境

import ai_image_router
import theme_color_flows
import image_composer

BASE = Path(__file__).parent
OUT = BASE / "output"
OUT.mkdir(exist_ok=True)

# ── 真实产品数据（DZ50X 驾驶式洗地机） ────────────────────────────
PRODUCT_DATA = {
    "brand": "德威莱克",
    "brand_text": "德威莱克 DEWEILAIKE",
    "model": "DZ50X",
    "model_name": "DZ50X",
    "product_name": "驾驶式洗地机",
    "product_type": "驾驶式洗地机",
    "category_line": "商用驾驶式洗地机 · 锂电款",
    "main_title": "DZ50X 驾驶式洗地机",
    "tagline_line1": "一台顶八人",
    "tagline_line2": "效率 3600㎡/h",
    "sub_slogan": "商用清洁，从未如此简单",
    "param_1_label": "清扫效率", "param_1_value": "3600㎡/h",
    "param_2_label": "清扫宽度", "param_2_value": "1800mm",
    "param_3_label": "续航时间", "param_3_value": "3.5小时",
    "param_4_label": "运行噪音", "param_4_value": "≤65dB",
    "advantages": [
        {"icon": "⚡", "label": "高效清扫", "desc": "3600㎡/h 大面积"},
        {"icon": "💧", "label": "智能水控", "desc": "90L 大水箱"},
        {"icon": "🔋", "label": "长续航", "desc": "3.5小时连续作业"},
        {"icon": "🔇", "label": "静音设计", "desc": "≤65dB 不扰客"},
        {"icon": "📐", "label": "精准转弯", "desc": "1.2m 转弯半径"},
        {"icon": "🛡️", "label": "安全防护", "desc": "多重急停保护"},
    ],
    "specs": [
        {"label": "整机尺寸", "value": "1450×800×1180mm"},
        {"label": "整机重量", "value": "320kg"},
        {"label": "水箱容量", "value": "清水90L / 污水100L"},
        {"label": "电池规格", "value": "锂电 24V/200Ah"},
    ],
    "story_title_1": "更快",
    "story_desc_1": "效率提升 3 倍，告别低效手推",
    "story_title_2": "更净",
    "story_desc_2": "刷盘+吸水一次完成，地面光亮如新",
    "vs_comparison": {
        "left_title": "传统人工",
        "left_items": ["效率 200㎡/h", "8人轮班作业", "月成本 2万元"],
        "right_title": "DZ50X",
        "right_items": ["效率 3600㎡/h", "1人即可操作", "月成本 0.5万元"],
    },
    "scenes": [
        {"name": "商场超市", "desc": "宽敞地面快速清扫"},
        {"name": "酒店大堂", "desc": "静音不扰客"},
        {"name": "工厂车间", "desc": "重型粉尘清理"},
        {"name": "地下车库", "desc": "油污去除"},
    ],
    "footer_note": "*产品参数以实物为准，图片仅供参考",
}

# 真实产品图（已抠图的 DZ50X）
PRODUCT_IMG_CANDIDATES = [
    BASE / "static" / "outputs" / "1" / "设备类_DZ50X_20260413_135443.png",
    BASE / "static" / "outputs" / "1" / "设备类_DZ50X_20260410_183731.png",
    BASE / "static" / "outputs" / "1" / "设备类_DZ50X_20260410_123611.png",
]
PRODUCT_IMAGE = ""
for p in PRODUCT_IMG_CANDIDATES:
    if p.exists():
        PRODUCT_IMAGE = str(p)
        break

THEME_ID = "classic-red"

# ── 单引擎跑全流程 ──────────────────────────────────────────────────

def run_engine(engine: str, out_filename: str) -> dict:
    print(f"\n{'='*70}")
    print(f"  开始 {engine.upper()} — {ai_image_router.ENGINES[engine]['label']}")
    print(f"{'='*70}")

    api_keys = {
        "dashscope_api_key": os.environ.get("DASHSCOPE_API_KEY", ""),
        "ark_api_key": os.environ.get("ARK_API_KEY", ""),
    }
    needed = ai_image_router.ENGINES[engine]["key_field"]
    if not api_keys.get(needed):
        return {"engine": engine, "ok": False, "error": f"缺少 {needed} 环境变量"}

    seg_dir = OUT / f"real_segments_{engine}"
    seg_dir.mkdir(exist_ok=True)

    plan = theme_color_flows.plan_seamless_page(
        THEME_ID, product_hint=PRODUCT_DATA["product_type"]
    )
    print(f"[plan] {len(plan)} 段")

    t0 = time.time()
    segment_paths = []
    for i, seg in enumerate(plan, 1):
        zone = seg["zone"]
        print(f"[{i}/{len(plan)}] 生成 {zone} (h={seg['height']}) ...", flush=True)
        try:
            local = ai_image_router.generate_segment_to_local(
                engine, zone, seg["prompt"], api_keys, seg_dir,
                width=750, height=seg["height"],
                filename=f"{zone}.png",
            )
            segment_paths.append(local)
            print(f"       -> {'OK ' + local if local else 'FAIL (空返回)'}")
        except Exception as e:
            traceback.print_exc()
            print(f"       -> EXCEPTION: {e}")
            segment_paths.append("")

    valid = [p for p in segment_paths if p]
    if not valid:
        return {
            "engine": engine, "ok": False,
            "error": "所有段失败，无可融合内容",
            "elapsed_sec": round(time.time() - t0, 1),
        }

    print(f"[compose] 融合 {len(valid)}/{len(plan)} 段 + 叠加内容")
    out_path = OUT / out_filename
    plan_filtered = [p for p, s in zip(plan, segment_paths) if s]
    theme_primary = theme_color_flows.get_flow(THEME_ID).get("primary", "#E8231A")

    try:
        image_composer.compose_seamless_detail_page(
            product_data=PRODUCT_DATA,
            plan=plan_filtered,
            segment_paths=valid,
            product_image=PRODUCT_IMAGE,
            output_path=str(out_path),
            theme_primary=theme_primary,
        )
    except Exception as e:
        traceback.print_exc()
        return {
            "engine": engine, "ok": False,
            "error": f"合成失败: {e}",
            "elapsed_sec": round(time.time() - t0, 1),
        }

    elapsed = round(time.time() - t0, 1)
    from PIL import Image
    img = Image.open(out_path)
    return {
        "engine": engine, "ok": True,
        "path": str(out_path),
        "size": (img.width, img.height),
        "kb": round(out_path.stat().st_size / 1024, 1),
        "segments_ok": len(valid),
        "segments_total": len(plan),
        "elapsed_sec": elapsed,
    }


if __name__ == "__main__":
    print(f"产品图: {PRODUCT_IMAGE or '（无，hero zone 不叠产品图）'}")
    print(f"主题:   {THEME_ID}")
    print(f"DASHSCOPE_API_KEY: {'已配置' if os.environ.get('DASHSCOPE_API_KEY') else '缺失'}")
    print(f"ARK_API_KEY:       {'已配置' if os.environ.get('ARK_API_KEY') else '缺失'}")

    results = []
    for engine, fname in [
        ("wanxiang", "real_test_wanxiang.png"),
        ("seedream", "real_test_seedream.png"),
    ]:
        r = run_engine(engine, fname)
        results.append(r)

    print("\n" + "="*70)
    print("  最终结果")
    print("="*70)
    for r in results:
        if r["ok"]:
            print(f"[{r['engine']:9s}] OK  {r['path']}")
            print(f"            尺寸={r['size'][0]}x{r['size'][1]} 大小={r['kb']}KB "
                  f"段={r['segments_ok']}/{r['segments_total']} 用时={r['elapsed_sec']}s")
        else:
            print(f"[{r['engine']:9s}] FAIL {r.get('error', '?')} (用时 {r.get('elapsed_sec','?')}s)")
