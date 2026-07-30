"""
验证 specs 修复:
  1) 去掉 [:10] 截断 — 18 条参数全展示,不缩水
  2) 自适应密度 — 18 条触发"5px / 15px / 12px"挡位
  3) 新顺序 — specs 在倒数第二位(brand 之后,cta 之前)

用一组 18 条参数的扩展 PARSED_DEMO 跑完整 7 屏管线,产出长图供肉眼核对。
"""
from __future__ import annotations

import sys
import time
import traceback
from copy import deepcopy
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).parent.resolve()
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

import app as app_module  # noqa
from ai_compose_pipeline import compose_detail_page, DEFAULT_ORDER
from test_endpoint_html_parsed import PARSED_DEMO


# 18 条扩展参数:覆盖效率/尺寸/水电/性能/安全多维度
EXTENDED_DETAIL_PARAMS = {
    "清洁效率":     "3600㎡/h",
    "理论效率":     "4200㎡/h",
    "清扫宽度":     "850mm",
    "吸水宽度":     "920mm",
    "清水容量":     "90L",
    "污水容量":     "100L",
    "续航时间":     "4小时",
    "充电时间":     "2.5小时",
    "运行噪音":     "≤68dB",
    "最小转弯":     "1.2m",
    "整机重量":     "380kg",
    "整机尺寸":     "1450×850×1320mm",
    "刷盘电机":     "2×400W",
    "吸水电机":     "560W",
    "驱动功率":     "750W",
    "电池容量":     "24V/100Ah",
    "电池类型":     "锂电池",
    "爬坡能力":     "≤10%",
}


def main():
    parsed = deepcopy(PARSED_DEMO)
    parsed["detail_params"] = EXTENDED_DETAIL_PARAMS

    print("═" * 78)
    print(f"  验证 specs 全量展示 + 自适应 + 新顺序")
    print(f"  detail_params 行数: {len(EXTENDED_DETAIL_PARAMS)}")
    print(f"  当前 DEFAULT_ORDER: {DEFAULT_ORDER}")
    print("═" * 78)

    out_dir = BASE / "output" / "verify_specs_full"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: parsed → ctxs(走 _build_ctxs_from_parsed,验证 specs_ctx 三字段)
    with app_module.app.app_context(), app_module.app.test_request_context():
        raw_ctxs = app_module._build_ctxs_from_parsed(parsed, "", "classic-red")
        ctxs = {k: app_module._resolve_asset_urls_in_ctx(v)
                for k, v in raw_ctxs.items() if isinstance(v, dict)}

    specs_ctx = ctxs.get("specs", {})
    n = len(specs_ctx.get("specs", []))
    print(f"\n[A] specs ctx 验证")
    print(f"    specs 行数:        {n}  (期望 18)")
    print(f"    spec_row_pad:     {specs_ctx.get('spec_row_pad', '<未设置>')}")
    print(f"    spec_value_size:  {specs_ctx.get('spec_value_size', '<未设置>')}")
    print(f"    spec_label_size:  {specs_ctx.get('spec_label_size', '<未设置>')}")
    expected = {"spec_row_pad": "5px", "spec_value_size": "15px", "spec_label_size": "12px"}
    ok_adapt = all(specs_ctx.get(k) == v for k, v in expected.items())
    print(f"    自适应挡位 (16-20) → {'✅ 命中' if ok_adapt else '❌ 未命中,实际值见上'}")

    # Step 2: 校验 18 条 label 全部到位
    spec_labels = [s.get("label", "") for s in specs_ctx.get("specs", [])]
    expected_labels = set(EXTENDED_DETAIL_PARAMS.keys())
    actual_labels = set(spec_labels)
    missing = expected_labels - actual_labels
    print(f"\n[B] 全量参数核对")
    print(f"    输入 detail_params keys: {len(expected_labels)}")
    print(f"    输出 specs labels:       {len(actual_labels)}")
    if missing:
        print(f"    ❌ 缺失: {missing}")
    else:
        print(f"    ✅ 18/18 全部进入 specs")

    # Step 3: 实际渲染 + 拼长图(看 specs.png 是否字号自适应、不溢出)
    print(f"\n[C] 渲染 7 屏 → 拼长图")
    print(f"    顺序: {DEFAULT_ORDER}")

    t0 = time.time()
    try:
        result = compose_detail_page(
            ctxs, DEFAULT_ORDER, out_dir,
            out_jpg_name="long_18params.jpg",
            out_png_name=None,
            verbose=True,
        )
    except Exception as e:
        print(f"\n❌ 渲染失败: {e}")
        traceback.print_exc()
        sys.exit(1)
    elapsed = time.time() - t0

    rendered = [s["type"] for s in result["segments"]]
    print(f"\n[D] 渲染顺序核对")
    print(f"    实际顺序: {rendered}")
    if rendered == DEFAULT_ORDER:
        print(f"    ✅ specs 在倒数第二({rendered.index('specs') + 1}/{len(rendered)})")
    else:
        print(f"    ❌ 顺序不一致:期望 {DEFAULT_ORDER}")

    print(f"\n[E] 耗时 {elapsed:.1f}s · 长图 {result['width']}×{result['height']}")
    print(f"    长图: {result['jpg']}  ({result['jpg_bytes']/1024/1024:.2f} MB)")
    print(f"    specs.png: {out_dir / 'specs.png'}")

    print("\n人工核对清单:")
    print(f"  · 打开 specs.png — 应能看到 18 条参数,字号变小但仍清晰可读")
    print(f"  · 打开 long_18params.jpg — specs 应出现在 brand 之后、cta 之前")


if __name__ == "__main__":
    main()
