"""
Wave 1 验证 — 4 张上传图 (product/scene/effect/qr) 能穿过全链路落到正确的 ctx 字段。

验证链路:
  前端 payload 的 3 个新字段
    → /api/generate-ai-detail-html 端点读取
    → _build_ctxs_from_parsed(..., scene_image_url, effect_image_url, qr_image_url)
    → ctxs["scene"]["bg_url"] = effect_image_url     (覆盖 AI 生成的背景)
    → ctxs["cta"]["qr_url"]   = qr_image_url
    → generate_backgrounds(reference_image_url=scene_image)  (图生图参考)

本脚本不联网、不调 Doubao,只直接调 _build_ctxs_from_parsed,断言字段注入。
"""
from __future__ import annotations

import sys
from copy import deepcopy
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).parent.resolve()
sys.path.insert(0, str(BASE))
load_dotenv(BASE / ".env")

import app as app_module  # noqa
from test_endpoint_html_parsed import PARSED_DEMO


FAKE_PRODUCT = "/static/uploads/fake_product.png"
FAKE_SCENE   = "/static/uploads/fake_scene.png"
FAKE_EFFECT  = "/static/uploads/fake_effect.png"
FAKE_QR      = "/static/uploads/fake_qr.png"

# 模拟 Doubao 已经生成 6 屏背景(realtime 模式产出的本地路径)
FAKE_BACKGROUNDS = {
    "hero":       "/static/cache/ai_bg/hero_ai.png",
    "advantages": "/static/cache/ai_bg/advantages_ai.png",
    "specs":      "/static/cache/ai_bg/specs_ai.png",
    "vs":         "/static/cache/ai_bg/vs_ai.png",
    "scene":      "/static/cache/ai_bg/scene_ai.png",   # ← 会被 effect_image 覆盖
    "brand":      "/static/cache/ai_bg/brand_ai.png",
}


def main():
    print("═" * 78)
    print("  Wave 1 验证 — 4 张上传图穿透到 ctxs 的断言链")
    print("═" * 78)

    parsed = deepcopy(PARSED_DEMO)

    with app_module.app.app_context(), app_module.app.test_request_context():
        ctxs = app_module._build_ctxs_from_parsed(
            parsed,
            product_image_url=FAKE_PRODUCT,
            theme_id="classic-red",
            backgrounds=FAKE_BACKGROUNDS,
            scene_image_url=FAKE_SCENE,
            effect_image_url=FAKE_EFFECT,
            qr_image_url=FAKE_QR,
        )

    fails = []

    def check(label, actual, expected):
        ok = actual == expected
        mark = "✅" if ok else "❌"
        print(f"  {mark} {label}")
        print(f"      expected: {expected}")
        print(f"      actual:   {actual}")
        if not ok:
            fails.append(label)

    print("\n[A] product_image → hero/specs/cta.product_url")
    check("hero.product_url",  ctxs.get("hero", {}).get("product_url"),  FAKE_PRODUCT)
    check("specs.product_url", ctxs.get("specs", {}).get("product_url"), FAKE_PRODUCT)
    check("cta.product_url",   ctxs.get("cta", {}).get("product_url"),   FAKE_PRODUCT)

    print("\n[B] effect_image → scene.bg_url (覆盖 AI 生成背景)")
    check("scene.bg_url", ctxs.get("scene", {}).get("bg_url"), FAKE_EFFECT)

    print("\n[C] qr_image → cta.qr_url")
    check("cta.qr_url", ctxs.get("cta", {}).get("qr_url"), FAKE_QR)

    print("\n[D] 其他 5 屏 bg_url 仍用 AI 生成背景(未被污染)")
    for screen in ("hero", "advantages", "specs", "vs", "brand"):
        if screen in ctxs:
            check(f"{screen}.bg_url", ctxs[screen].get("bg_url"),
                  FAKE_BACKGROUNDS[screen])

    print("\n[E] scene_image 本身不在 ctx 里 — 它只走 generate_backgrounds 的参考图通道")
    all_values_flat = []
    for ctx in ctxs.values():
        for v in ctx.values():
            if isinstance(v, str):
                all_values_flat.append(v)
    scene_leaked = FAKE_SCENE in all_values_flat
    check("scene_image 未泄漏到任何 ctx 字段", scene_leaked, False)

    print("\n" + "═" * 78)
    print("  [F] 端点闭环 — monkeypatch generate_backgrounds 捕获参数")
    print("═" * 78)

    import ai_bg_cache
    captured = {}
    original_gen = ai_bg_cache.generate_backgrounds

    def fake_gen(**kwargs):
        captured.update(kwargs)
        # 返回和 FAKE_BACKGROUNDS 结构一致的假背景
        return dict(FAKE_BACKGROUNDS)

    ai_bg_cache.generate_backgrounds = fake_gen
    # 测试态绕过 @login_required — flask_login 官方开关
    app_module.app.config["LOGIN_DISABLED"] = True
    try:
        with app_module.app.test_client() as client:
            resp = client.post("/api/generate-ai-detail-html", json={
                "parsed_data":  parsed,
                "product_image": FAKE_PRODUCT,
                "scene_image":   FAKE_SCENE,
                "effect_image":  FAKE_EFFECT,
                "qr_image":      FAKE_QR,
                "theme_id":      "classic-red",
                "out_jpg_name":  "wave1_closure.jpg",
                "save_png":      False,
            })
            print(f"  resp.status = {resp.status_code}")
            if resp.status_code >= 400:
                print(f"  resp.body   = {resp.get_data(as_text=True)[:300]}")
    finally:
        ai_bg_cache.generate_backgrounds = original_gen

    print(f"  captured kwargs keys: {sorted(captured.keys())}")
    check("generate_backgrounds 收到 reference_image_url=scene_image",
          captured.get("reference_image_url"), FAKE_SCENE)
    check("generate_backgrounds 收到 theme_id",
          captured.get("theme_id"), "classic-red")

    print("\n" + "═" * 78)
    if fails:
        print(f"  ❌ 失败 {len(fails)} 项: {fails}")
        sys.exit(1)
    else:
        print("  ✅ Wave 1 全部通过 — 4 张图正确注入对应 ctx + endpoint 闭环")
    print("═" * 78)


if __name__ == "__main__":
    main()
