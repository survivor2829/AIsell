"""任务2 实时状态 · Playwright 证据脚本

跑法 (生产):
  docker exec clean-industry-ai-assistant-web-1 python3 scripts/verify_task2_realtime.py

验证内容 (5 个 viewport × 4 场景 × computed style 断言):
  - 5 viewport: 1920 / 1600 / 1440 / 1366 / 375
  - 场景 A: stage-pending pill 初始状态
  - 场景 B: stage-parsing (processing) pill - breathing 动画生效
  - 场景 C: stage-done pill - 成功色 + 无动画
  - 场景 D: toast 出现右上角 - z-index=300

所有断言必须 PASS, 任何一个 FAIL → 整个脚本非零退出.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("[FATAL] playwright not installed — 只能在生产镜像内跑")
    sys.exit(1)


# 1. 构造 mock HTML, 注入真实 design-system.css 里 stage-pill + toast 全部规则
CSS_PATH = Path("/app/static/css/design-system.css")
if not CSS_PATH.is_file():
    CSS_PATH = Path(__file__).resolve().parent.parent / "static/css/design-system.css"

css_content = CSS_PATH.read_text(encoding="utf-8")

MOCK_HTML = f"""<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<title>task2 verify</title>
<style>{css_content}
body {{ padding: 40px; background: #f5f6f8; }}
table {{ border-collapse: collapse; }}
td {{ padding: 8px 12px; border: 1px solid #eee; }}
</style>
</head><body>
<h2>任务2 Stage Pill 验证</h2>
<table id="t"><tbody>
  <tr data-name="pending-row"><td>待测</td>
    <td class="status-cell"><span class="stage-pill stage-pending" id="pill-pending">⏳ 等待中</span></td>
  </tr>
  <tr data-name="parsing-row"><td>解析中</td>
    <td class="status-cell"><span class="stage-pill stage-parsing" id="pill-parsing">🧠 AI 解析中...</span></td>
  </tr>
  <tr data-name="done-row"><td>已完成</td>
    <td class="status-cell"><span class="stage-pill stage-done" id="pill-done">✅ 完成</span></td>
  </tr>
  <tr data-name="failed-row"><td>失败</td>
    <td class="status-cell"><span class="stage-pill stage-failed" id="pill-failed" title="模拟 error msg">❌ 失败</span></td>
  </tr>
</tbody></table>

<div id="toastMount"></div>
<script>
  // mock showToast (和 upload.html 的实现保持一致)
  function showToast(kind, title, msg) {{
    const icons = {{ success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' }};
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + kind;
    toast.id = 'test-toast';
    toast.innerHTML = `
      <span class="toast-icon">${{icons[kind] || 'ℹ️'}}</span>
      <div class="toast-body">
        <strong class="toast-title">${{title}}</strong>
        <span class="toast-msg">${{msg}}</span>
      </div>
      <button class="toast-close" aria-label="关闭">×</button>
    `;
    document.body.appendChild(toast);
  }}
  showToast('success', '批次完成', '3 个产品已全部生成 · 耗时 1 分 42 秒');
</script>
</body></html>
"""


VIEWPORTS = [
    (1920, 1080, "desktop-1920"),
    (1600,  900, "mid-1600"),
    (1440,  900, "laptop-1440"),
    (1366,  768, "old-1366"),
    ( 375,  667, "mobile-375"),
]


# 每个 viewport 跑的断言集合 (key, js_expr, expected_predicate, label)
ASSERTIONS = [
    # === pending pill ===
    (
        "pending-bg",
        "() => getComputedStyle(document.getElementById('pill-pending')).backgroundColor",
        lambda v: v in ("rgb(249, 250, 251)", "rgba(249, 250, 251, 1)"),  # var(--color-bg-subtle) = #f9fafb
        "stage-pending bg = #f9fafb (color-bg-subtle)",
    ),
    # === processing (parsing) pill ===
    (
        "parsing-bg",
        "() => getComputedStyle(document.getElementById('pill-parsing')).backgroundColor",
        lambda v: "20, 110, 245" in v or "rgba(20, 110, 245, 0.08" in v,
        "stage-parsing bg = primary-light (rgba(20,110,245,0.08))",
    ),
    (
        "parsing-animation",
        "() => getComputedStyle(document.getElementById('pill-parsing')).animationName",
        lambda v: v == "breathing",
        "stage-parsing animation-name = breathing",
    ),
    (
        "parsing-color",
        "() => getComputedStyle(document.getElementById('pill-parsing')).color",
        lambda v: v in ("rgb(20, 110, 245)", "rgba(20, 110, 245, 1)"),
        "stage-parsing color = #146ef5 (primary)",
    ),
    # === done pill ===
    (
        "done-color",
        "() => getComputedStyle(document.getElementById('pill-done')).color",
        lambda v: v in ("rgb(0, 215, 34)", "rgba(0, 215, 34, 1)"),
        "stage-done color = #00d722 (success)",
    ),
    (
        "done-animation",
        "() => getComputedStyle(document.getElementById('pill-done')).animationName",
        lambda v: v in ("none", ""),
        "stage-done 无动画",
    ),
    # === failed pill ===
    (
        "failed-color",
        "() => getComputedStyle(document.getElementById('pill-failed')).color",
        lambda v: v in ("rgb(238, 29, 54)", "rgba(238, 29, 54, 1)"),
        "stage-failed color = #ee1d36 (error)",
    ),
    # === toast ===
    (
        "toast-zindex",
        "() => getComputedStyle(document.getElementById('test-toast')).zIndex",
        lambda v: v == "300",
        "toast z-index = 300",
    ),
    (
        "toast-position",
        "() => getComputedStyle(document.getElementById('test-toast')).position",
        lambda v: v == "fixed",
        "toast position = fixed",
    ),
]


def run():
    failures = []
    total_checks = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        for w, h, label in VIEWPORTS:
            ctx = browser.new_context(viewport={"width": w, "height": h})
            page = ctx.new_page()
            page.set_content(MOCK_HTML)
            page.wait_for_function("document.getElementById('test-toast')", timeout=3000)

            print(f"\n=== {label} ({w}x{h}) ===")
            for key, js_expr, predicate, label_a in ASSERTIONS:
                total_checks += 1
                value = page.evaluate(js_expr)
                ok = predicate(value)
                status = "PASS" if ok else "FAIL"
                print(f"  [{status}] {label_a}: got={value!r}")
                if not ok:
                    failures.append((label, key, label_a, value))
            ctx.close()
        browser.close()

    print("\n" + "=" * 60)
    total = total_checks
    passed = total - len(failures)
    print(f"SUMMARY: {passed}/{total} checks passed across {len(VIEWPORTS)} viewports")
    if failures:
        print("\nFAILURES:")
        for vp, key, label_a, value in failures:
            print(f"  [{vp}] {key}: {label_a} — got {value!r}")
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    run()
