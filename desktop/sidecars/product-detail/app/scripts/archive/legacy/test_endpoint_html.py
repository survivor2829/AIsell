"""
AI 合成管线 · 阶段三 测试:/api/generate-ai-detail-html 端点烟雾测试

用 Flask 的 test_client() 在进程内直接调用端点,不需要启动服务器。
关键:
  - LOGIN_DISABLED=True 绕过 @login_required(测试专用)
  - 匿名用户(uid=0),输出落 static/outputs/0/ai_compose/
  - 复用 build_long_image.py 的 CTX_BUILDERS(DZ50X 7 屏测试数据)

预期:
  200 OK,返回 image_url + 统计;物理尺寸 1500×11200,JPEG < 5 MB。
"""
import sys
from pathlib import Path

from build_long_image import CTX_BUILDERS, SCREEN_ORDER


def main():
    # 关键:设置 LOGIN_DISABLED 必须在 import app 之前(Flask 启动时读 config)
    # 但 app.py 是模块级,只能 import 后再改 config + 走 test_client
    import app as app_module
    app = app_module.app
    app.config["LOGIN_DISABLED"] = True
    app.config["TESTING"] = True

    # 构造 7 屏 ctxs
    ctxs = {k: builder() for k, builder in CTX_BUILDERS.items()}

    # build_long_image.py 里产品图/场景图用的是 file:// URI(CLI 本地路径),
    # 端点的 _resolve_asset_urls_in_ctx 只转换 /static/... 相对路径 — file:// 会原样透传。
    # 这正是我们想要的:CLI 本地 URI + HTTP 请求的 /static/... 都能走同一管线。

    payload = {
        "ctxs":         ctxs,
        "order":        SCREEN_ORDER,
        "out_jpg_name": "test_endpoint.jpg",
        "jpg_quality":  90,
        "save_png":     False,  # 生产模式:跳过 PNG(省 ~21s)
    }

    client = app.test_client()
    print(f"[test] POST /api/generate-ai-detail-html ({len(ctxs)} 屏)")
    print(f"[test]   order: {' → '.join(SCREEN_ORDER)}")

    resp = client.post("/api/generate-ai-detail-html", json=payload)
    print(f"[test]   status: {resp.status_code}")

    if resp.status_code != 200:
        print(f"[FAIL] {resp.get_json() or resp.data.decode(errors='replace')}")
        sys.exit(1)

    result = resp.get_json()
    print()
    print("=" * 72)
    print(f"✅ 端点返回 200")
    print(f"   image_url:      {result['image_url']}")
    print(f"   segments:       {len(result['segments'])} 屏")
    for s in result["segments"]:
        print(f"     {s['type']:12s} {s['w']}×{s['h']}  {s['elapsed']:.2f}s")
    print(f"   render_elapsed: {result['render_elapsed']:.2f}s")
    print(f"   stitch_elapsed: {result['stitch_elapsed']:.2f}s")
    print(f"   total_elapsed:  {result['total_elapsed']:.2f}s")
    print(f"   尺寸:          {result['width']} × {result['height']}")
    jpg_mb = result["jpg_bytes"] / (1024 * 1024)
    print(f"   JPEG:          {jpg_mb:.2f} MB  "
          f"{'✅ < 5 MB' if jpg_mb < 5 else '⚠️ > 5 MB'}")

    # 验证文件真的落盘
    jpg_path = Path(__file__).parent / result["image_url"].lstrip("/")
    if not jpg_path.exists():
        print(f"[FAIL] 返回的 image_url 对应文件不存在: {jpg_path}")
        sys.exit(1)
    print(f"   文件已落盘:    {jpg_path}")
    print("=" * 72)


if __name__ == "__main__":
    main()
