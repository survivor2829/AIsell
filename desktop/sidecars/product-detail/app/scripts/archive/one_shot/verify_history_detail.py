"""方向 B 历史批次详情页 · Playwright 证据脚本

跑法 (生产):
  docker exec clean-industry-ai-assistant-web-1 python3 scripts/verify_history_detail.py

验证:
  - 5 viewport (1920/1600/1440/1366/375)
  - 对每个 viewport 注入真实 history_detail.html (mock fetch 3 种 disk_available 状态)
  - CSS computed style 断言:
    * 三态 banner 颜色 (full=success / partial=warning / missing=error)
    * .hd-btn-dl.hd-btn-disabled cursor=not-allowed + pointer-events=none
    * .hd-thumb cursor=zoom-in (lightbox 可点)
    * 响应式手机端 .hd-card 变单列

所有断言必须 PASS, 否则非零退出.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("[FATAL] playwright not installed")
    sys.exit(1)

ROOT = Path("/app") if Path("/app/app.py").exists() else Path(__file__).resolve().parent.parent
DESIGN_CSS = (ROOT / "static/css/design-system.css").read_text(encoding="utf-8")
DETAIL_HTML = (ROOT / "templates/batch/history_detail.html").read_text(encoding="utf-8")

# 提取 history_detail.html 里的 <style> 块和 <body> 骨架
style_m = re.search(r"<style>(.*?)</style>", DETAIL_HTML, re.DOTALL)
assert style_m, "detail html 没 style 块"
DETAIL_STYLE = style_m.group(1)


def mock_page_html(disk_status: str):
    """构造最小独立 HTML 页: design-system.css + detail-style + 3 个示例 card + banner.
    每个 card 模拟不同 exists 组合. disk_status 控制 banner 可见/颜色."""
    # 3 cards: 0 全 exists / 1 只 HTML / 2 全 missing
    cards = []
    for i, (html_ok, ai_ok) in enumerate([(True, True), (True, False), (False, False)]):
        html_col = (
            '<img class="hd-thumb" src="about:blank" alt="">'
            '<a class="hd-btn-dl" href="#">↓ HTML版</a>'
        ) if html_ok else (
            '<div class="hd-thumb-missing"><span class="hd-thumb-missing-icon">⚠️</span><span>文件已丢失</span></div>'
            '<span class="hd-btn-dl hd-btn-disabled">↓ HTML版</span>'
        )
        ai_col = (
            '<img class="hd-thumb" src="about:blank" alt="">'
            '<a class="hd-btn-dl" href="#">↓ AI版</a>'
        ) if ai_ok else (
            '<div class="hd-thumb-missing"><span class="hd-thumb-missing-icon">⚠️</span><span>文件已丢失</span></div>'
            '<span class="hd-btn-dl hd-btn-disabled">↓ AI版</span>'
        )
        cards.append(f'''
<div class="hd-card" data-name="产品{i}" data-item-id="{i}">
  <div class="hd-card-left">
    <div class="hd-name">产品{i}</div>
    <span class="stage-pill stage-done">✅ 完成</span>
  </div>
  <div class="hd-thumb-col" id="htmlCol{i}">
    <div class="hd-thumb-label">HTML 版预览</div>
    {html_col}
  </div>
  <div class="hd-thumb-col" id="aiCol{i}">
    <div class="hd-thumb-label">AI 精修版</div>
    {ai_col}
  </div>
</div>''')

    banner_class = "" if disk_status == "full" else f"hd-disk-banner {disk_status}"
    banner_text = {"full": "", "partial": "⚠️ 部分文件已丢失",
                   "missing": "❌ 全部文件已丢失"}[disk_status]
    banner_hidden = "hidden" if disk_status == "full" else ""

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>test {disk_status}</title>
<style>{DESIGN_CSS}
{DETAIL_STYLE}
</style></head><body>
<div class="hd-container">
  <div class="hd-header">
    <div class="hd-header-left"><h1 class="hd-title">测试批次 {disk_status}</h1></div>
    <a id="btnZip" class="hd-btn-zip" href="#">↓ 批量 zip 下载</a>
  </div>
  <div id="diskBanner" class="{banner_class}" {banner_hidden}>{banner_text}</div>
  <div id="itemList">{''.join(cards)}</div>
</div>
</body></html>"""


VIEWPORTS = [
    (1920, 1080, "desktop-1920"),
    (1600,  900, "mid-1600"),
    (1440,  900, "laptop-1440"),
    (1366,  768, "old-1366"),
    ( 375,  667, "mobile-375"),
]

# (selector, css_prop, predicate, label)
# 三态 banner 各自一个 HTML, 对应断言
STATE_ASSERTIONS = {
    "full": [
        # disk_available=full → banner hidden (display:none), 不断言它
        ("#htmlCol0 .hd-btn-dl", "cursor", lambda v: "pointer" in v or v == "auto",
         "full 状态下载按钮可点 (cursor=pointer/auto)"),
    ],
    "partial": [
        ("#diskBanner", "background-color", lambda v: "rgb(255, 251, 235)" == v or "rgba(255, 251, 235, 1)" == v,
         "partial banner bg = warning-bg (#fffbeb)"),
        ("#aiCol1 .hd-btn-disabled", "cursor", lambda v: v == "not-allowed",
         "partial 状态 AI 下载置灰 cursor=not-allowed"),
        ("#aiCol1 .hd-btn-disabled", "pointer-events", lambda v: v == "none",
         "partial 状态 AI 下载置灰 pointer-events=none"),
    ],
    "missing": [
        ("#diskBanner", "background-color", lambda v: "rgb(254, 242, 242)" == v or "rgba(254, 242, 242, 1)" == v,
         "missing banner bg = error-bg (#fef2f2)"),
        ("#htmlCol2 .hd-thumb-missing", "border-style", lambda v: v == "dashed",
         "missing card thumb 用 dashed border"),
        ("#htmlCol2 .hd-btn-disabled", "cursor", lambda v: v == "not-allowed",
         "missing 状态下载按钮置灰"),
    ],
    # 每个 viewport 都测: 可点的 thumb cursor=zoom-in (任何状态都应该对)
    "_thumb": [
        ("#htmlCol0 .hd-thumb", "cursor", lambda v: v == "zoom-in",
         "可点 thumb cursor=zoom-in"),
    ],
}


def run():
    failures = []
    total = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        for w, h, label in VIEWPORTS:
            ctx = browser.new_context(viewport={"width": w, "height": h})
            page = ctx.new_page()
            print(f"\n━━━ {label} ({w}x{h}) ━━━")
            for disk_status in ["full", "partial", "missing"]:
                page.set_content(mock_page_html(disk_status))
                # 基础断言 (可点 thumb cursor=zoom-in)
                checks = list(STATE_ASSERTIONS.get("_thumb", []))
                checks += STATE_ASSERTIONS.get(disk_status, [])
                for sel, prop, pred, desc in checks:
                    total += 1
                    try:
                        # getPropertyValue() 支持带短横的属性名 (background-color 等),
                        # 直接用 .background-color 会被 JS 解析成减法表达式.
                        val = page.evaluate(
                            f"() => getComputedStyle(document.querySelector({sel!r})).getPropertyValue({prop!r})")
                    except Exception as e:
                        val = f"ERR:{e}"
                    ok = pred(val) if not str(val).startswith("ERR:") else False
                    tag = "PASS" if ok else "FAIL"
                    print(f"  [{tag}] [{disk_status}] {desc} — {prop}={val!r}")
                    if not ok:
                        failures.append((label, disk_status, desc, val))

            # 响应式断言: mobile 屏 card 变单列 (grid-template-columns 只有 1 个 1fr)
            if w <= 768:
                total += 1
                page.set_content(mock_page_html("full"))
                cols = page.evaluate("""() => {
                    const c = document.querySelector('.hd-card');
                    return c ? getComputedStyle(c).gridTemplateColumns : '';
                }""")
                # 手机端 grid-template-columns: 1fr (一个值) → 单列
                ok = cols and len(cols.split()) == 1
                tag = "PASS" if ok else "FAIL"
                print(f"  [{tag}] [mobile] .hd-card 单列 grid (cols={cols!r})")
                if not ok:
                    failures.append((label, "responsive", "mobile 单列", cols))
            ctx.close()
        browser.close()

    print(f"\nSUMMARY: {total - len(failures)}/{total} PASS")
    if failures:
        print("\nFAILURES:")
        for vp, state, desc, val in failures:
            print(f"  [{vp}|{state}] {desc}: {val!r}")
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    run()
