"""AI 精修 v2 demo — Seedream 图生图 (reference_image + 产品语义 prompt).

跑一次 ¥0.2, 验证新架构:
  - 产品图作 reference (image-to-image 模式, 不是纯文生图)
  - prompt 含产品卖点 / 场景 / 人物 / 工作状态
  - 砍掉 v1 的 200+ negative prompt 反向词 (会排斥 product)
  - style reference 锚定 "淘宝/天猫详情页"

用法:
  docker exec clean-industry-ai-assistant-web-1 python3 /tmp/demo_refine_v2.py

输出:
  /tmp/demo_v2_DZ600M.jpg (容器内), scp 出来.
"""
from __future__ import annotations
import base64
import mimetypes
import os
import sys
import time
import traceback
from pathlib import Path


REF_PATH = Path(
    "/app/static/uploads/batches/batch_20260422_001_3858/测试/"
    "DZ600M无人水面清洁机新品1/product_cut.png"
)
OUT_PATH = Path("/tmp/demo_v2_DZ600M.jpg")


PROMPT_EN = """A Chinese water-treatment engineer in a professional dark blue uniform
stands on the bank of an urban river. In the far distance, a modern
Chinese city skyline at golden hour — skyscrapers softened by warm sunset
glow.

In the foreground, a white unmanned surface cleaning robot (DZ600M, its
body and hull MUST strictly match the reference image) operates on the
water surface — gentle ripples around the hull, floating pollutants
around it being collected.

The engineer holds a tablet reviewing real-time telemetry from the robot.

Color tone: modern technology blue dominant, warm amber sunset accent,
city silhouette subtly reflected on the water.

Professional environmental technology photography, 8K ultra-sharp,
cinematic grading, both the product and the operator clearly visible
and in focus.

Style reference: Taobao/Tmall e-commerce detail page hero image,
clean commercial composition, high-end B2B industrial product photography,
professional product-and-scene integration."""


NEGATIVE = "text, logo, watermark, lens flare artifacts"


def to_data_url(p: Path) -> str:
    raw = p.read_bytes()
    mime, _ = mimetypes.guess_type(p.name)
    if not mime:
        mime = "image/png"
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{b64}"


def main():
    print("=" * 60)
    print("AI 精修 v2 demo — Seedream 图生图 (¥0.2 × 1 张)")
    print("=" * 60)

    if not REF_PATH.is_file():
        print(f"[FAIL] 参考图不存在: {REF_PATH}"); sys.exit(1)
    ref_size_kb = REF_PATH.stat().st_size // 1024
    print(f"[info] 参考图: {REF_PATH.name} ({ref_size_kb}KB)")

    data_url = to_data_url(REF_PATH)
    print(f"[info] Base64 data URL 长度: {len(data_url):,} 字符")

    api_key = os.environ.get("ARK_API_KEY", "").strip()
    if not api_key:
        print("[FAIL] ARK_API_KEY 未配置"); sys.exit(1)
    print(f"[info] ARK_API_KEY 就绪 (len={len(api_key)})")

    import ai_image_volcengine as vol

    print("[info] 调 Seedream (image-to-image + 产品语义 prompt)...")
    print(f"[info] Prompt 长度: {len(PROMPT_EN)} 字符 / Negative: {NEGATIVE!r}")
    print(f"[info] Size: 1024x1024  Model: {vol.T2I_MODEL}")

    t0 = time.time()
    try:
        urls = vol.generate_background(
            prompt=PROMPT_EN,
            api_key=api_key,
            size="1024x1024",
            negative_prompt=NEGATIVE,
            reference_image_url=data_url,
        )
    except Exception as e:
        print(f"[FAIL] API 异常: {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
    elapsed = round(time.time() - t0, 2)
    print(f"[info] API 耗时: {elapsed}s")

    if not urls:
        print("[FAIL] API 返回空 URL (见上方 [豆包生图] 错误行)")
        sys.exit(1)

    print(f"[info] 返回 {len(urls)} 个 URL:")
    for i, u in enumerate(urls):
        print(f"  [{i}] {u[:140]}...")

    saved = vol.download_image(urls[0], OUT_PATH.parent, OUT_PATH.name)
    if not saved:
        print("[FAIL] 图片下载失败")
        sys.exit(1)

    out_kb = Path(saved).stat().st_size // 1024
    print()
    print("=" * 60)
    print(f"[OK] 产物: {saved} ({out_kb}KB)")
    print(f"[OK] 总耗时: {elapsed}s  成本: ¥0.20")
    print("=" * 60)


if __name__ == "__main__":
    main()
