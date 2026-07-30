"""
端到端浏览器测试:workspace UI → AI精修(专业版) → 长图结果 → 截图

做法:
  1) 进程内起 Flask(LOGIN_DISABLED=True)
  2) Playwright 打开 /workspace/设备类
  3) 用 JS 注入已解析产品数据(模拟"已粘贴文案+点过识别"的状态)
  4) 点击"AI精修(专业版)"按钮
  5) 等结果图出现 → 全页截图

产物:output/browser_smoke/workspace_after_v2.png
"""
import threading
import time
from pathlib import Path

import app as app_module
from playwright.sync_api import sync_playwright
from test_endpoint_html_parsed import PARSED_DEMO


BASE = Path(__file__).parent
OUT = BASE / "output" / "browser_smoke"
OUT.mkdir(parents=True, exist_ok=True)


def start_flask(port: int = 5001):
    """后台线程起 Flask,关掉登录"""
    app = app_module.app
    app.config["LOGIN_DISABLED"] = True
    app.config["TESTING"] = True
    # werkzeug 默认关掉 reloader 才能在线程里跑
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


def wait_server_ready(port: int = 5001, timeout: float = 15.0):
    import socket
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def main():
    port = 5001
    t = threading.Thread(target=start_flask, args=(port,), daemon=True)
    t.start()
    print(f"[server] 启动 Flask (LOGIN_DISABLED=True) :{port}")
    if not wait_server_ready(port):
        print("[FAIL] Flask 未能在 15s 内启动")
        return
    print("[server] ✅ ready")

    url = f"http://127.0.0.1:{port}/workspace/设备类"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900},
                                device_scale_factor=1)
        console_msgs = []
        page.on("console", lambda m: console_msgs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console_msgs.append(f"[pageerror] {e}"))

        print(f"[browser] → {url}")
        page.goto(url, wait_until="networkidle", timeout=30000)

        # 注入已"识别"后的状态:通过 window.__TEST_setBuildData 钩子写入闭包变量
        # (跳过"粘贴文案→点击 AI 识别"步骤,直接模拟已解析)
        import json
        parsed_json = json.dumps(PARSED_DEMO, ensure_ascii=False)
        # 真实工作流会上传一张产品图;这里注入 static/设备类/ 下的参考图,
        # 让 hero/specs 有产品主体(否则会是空的标题框)
        product_image = "/static/设备类/ref_dz50x_cover.png"
        page.evaluate(f"""
            window.__TEST_setBuildData({parsed_json}, 'classic-red', {json.dumps(product_image)});
        """)
        print(f"[browser] ✅ 注入 demo parsed_data + product_image={product_image}")

        # 截图初始 workspace 状态(按钮区域)
        page.screenshot(path=str(OUT / "01_workspace_before.png"), full_page=True)
        print(f"[browser] 截图 01_workspace_before.png")

        # 点击 "AI精修(专业版·HTML合成)" 按钮
        page.click("#btn_ai_html_v2")
        print("[browser] → 点击 #btn_ai_html_v2")

        # 等到 ai_img tab 的 loading 出现再消失、结果图渲染好
        # 轮询 #ai_img_results 下出现 <img> 且图加载完成
        try:
            page.wait_for_selector("#ai_img_results img", timeout=90000)
            page.wait_for_function(
                "() => { const img = document.querySelector('#ai_img_results img');"
                "  return img && img.complete && img.naturalHeight > 0; }",
                timeout=30000,
            )
            page.wait_for_timeout(400)  # 等 tab 按钮 / 下载链接稳定
            print("[browser] ✅ 结果图就绪")
        except Exception as e:
            print(f"[browser] ❌ 等结果图超时: {e}")
            # 超时也截一张图 + 打印控制台
            page.screenshot(path=str(OUT / "99_timeout_state.png"), full_page=True)
            print(f"[browser] 截图 99_timeout_state.png (超时状态)")
            if console_msgs:
                print("\n[browser] 控制台全量输出:")
                for m in console_msgs:
                    print(f"  {m}")
            browser.close()
            raise

        # 结果截图 — 同时截取 ai_img 面板(完整长图)
        page.screenshot(path=str(OUT / "02_workspace_after_v2.png"), full_page=True)
        print(f"[browser] 截图 02_workspace_after_v2.png")

        # 只截结果面板(对比用)
        result_el = page.query_selector("#ai_img_results")
        if result_el:
            result_el.screenshot(path=str(OUT / "03_result_panel.png"))
            print(f"[browser] 截图 03_result_panel.png")

        # 打印前端控制台消息,排查隐性错误
        if console_msgs:
            print("\n[browser] 控制台消息:")
            for m in console_msgs[-20:]:
                print(f"  {m}")

        browser.close()

    print(f"\n✅ 浏览器端到端 smoke 测试完成,截图在: {OUT}")


if __name__ == "__main__":
    main()
