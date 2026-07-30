"""守护测: /export/<product_type>/main-images 端点 (配件类一键导出三连修).

修复 prod 用户反馈三个并发问题:
1. 配件类文案少 → 候选 5 个 block 里 4 个被 if not block_data 跳过 → 只产 1 张
2. 单图也强制打 ZIP, 用户额外解压一步
3. block_a 模板 min-height:720px + flex:1 → Playwright full_page=True 截下方一片白

设计:
- 静态守护测 (grep app.py 文本): 候选清单按品类分发 / 单图 PNG 分支 / trim 调用在位
- 纯函数单测 (PIL): _trim_bottom_whitespace 三场景 (上红下白裁掉 / 全白不裁 / 全红不裁)
- 不真起 Playwright (慢 + flaky), 端点行为靠静态结构 + 单元函数双重保护
"""
from __future__ import annotations
import io
import re
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
APP_PY = REPO / "app.py"
WORKSPACE_HTML = REPO / "templates" / "workspace.html"


# ── 静态守护: 候选清单按品类分发 ────────────────────────────────────────

class TestCandidatesByCategory:
    """_MAIN_BLOCK_CANDIDATES 必须是按品类分发的 dict, 配件/耗材/工具有专属候选."""

    def test_candidates_is_dict_by_category(self):
        content = APP_PY.read_text(encoding="utf-8")
        # 找 _MAIN_BLOCK_CANDIDATES 定义体, 必须是 dict (= {) 不是 list (= [)
        m = re.search(r'_MAIN_BLOCK_CANDIDATES\s*=\s*\{', content)
        assert m, (
            "_MAIN_BLOCK_CANDIDATES 必须是按品类分发的 dict (旧版扁平 list 已废弃). "
            "配件类文案少时 list 写法只产 1 张, dict 可专属候选保 ≥3 张."
        )

    def test_accessory_has_b2_and_e_not_b3_f(self):
        """配件类 b3 清洁故事 / f VS对比 依赖大段叙事 → 必须替换为 e 参数表 + b2 核心优势."""
        content = APP_PY.read_text(encoding="utf-8")
        # 抓 "配件类": [...] 块 (非贪婪到下一个 ] )
        m = re.search(r'"配件类"\s*:\s*\[([^\]]+)\]', content)
        assert m, "_MAIN_BLOCK_CANDIDATES 必须显式列 '配件类' 候选."
        accessory_block = m.group(1)
        assert "block_e" in accessory_block, (
            "配件类必须含 block_e (产品参数表) 兜底, 文案少时仍可产出."
        )
        assert "block_b2" in accessory_block, (
            "配件类必须含 block_b2 (核心优势 icon 网格), AI 解析端已专为配件类生成 block_b2_items."
        )
        assert "block_b3" not in accessory_block, (
            "配件类不应包含 block_b3 (清洁故事 — 依赖大段文案叙事, 配件无意义)."
        )
        assert "block_f" not in accessory_block, (
            "配件类不应包含 block_f (1台顶8人 VS — 设备类专属对比逻辑)."
        )

    def test_all_four_categories_present(self):
        """4 个品类必须都有显式候选, 防止默认 fallback 退化."""
        content = APP_PY.read_text(encoding="utf-8")
        for cat in ["设备类", "耗材类", "配件类", "工具类"]:
            assert f'"{cat}"' in content, (
                f"_MAIN_BLOCK_CANDIDATES 缺品类 '{cat}', 必须显式候选."
            )

    def test_default_main_blocks_defined(self):
        """未知品类必须有 _DEFAULT_MAIN_BLOCKS fallback."""
        content = APP_PY.read_text(encoding="utf-8")
        assert "_DEFAULT_MAIN_BLOCKS" in content, (
            "必须定义 _DEFAULT_MAIN_BLOCKS 给未知品类兜底 (.get(product_type, _DEFAULT_MAIN_BLOCKS))."
        )


# ── 静态守护: 端点张数分支 + trim 调用 ──────────────────────────────────

class TestExportEndpointBranching:
    """export_main_images_zip 必须有 单图 PNG / 多图 ZIP 双分支 + trim 调用."""

    def test_single_image_branch_returns_png(self):
        content = APP_PY.read_text(encoding="utf-8")
        # 必须有 len(rendered) == 1 分支返回 image/png
        m = re.search(
            r'len\(rendered\)\s*==\s*1.*?mimetype\s*=\s*["\']image/png["\']',
            content, re.DOTALL,
        )
        assert m, (
            "export_main_images_zip 必须在 len(rendered)==1 时直发 image/png "
            "(不再无条件打 ZIP — 单图打包让用户多解压一步是 prod 体验回归)."
        )

    def test_multi_image_branch_zip(self):
        content = APP_PY.read_text(encoding="utf-8")
        # 多图分支用 zipfile.ZipFile + application/zip
        assert "zipfile.ZipFile" in content
        assert 'mimetype="application/zip"' in content or "mimetype='application/zip'" in content

    def test_trim_helper_called_after_screenshot(self):
        content = APP_PY.read_text(encoding="utf-8")
        assert "_trim_bottom_whitespace" in content, (
            "必须调用 _trim_bottom_whitespace 裁掉 block_a min-height:720px 强撑出的下方留白."
        )
        # screenshot 后立刻 trim, 不是 trim 后才截图
        m = re.search(
            r'page\.screenshot\(full_page=True\).*?_trim_bottom_whitespace',
            content, re.DOTALL,
        )
        assert m, "trim 必须在 page.screenshot 之后立即调用 (作用于 PNG bytes)."

    def test_no_hard_skip_on_empty_block_data(self):
        """放宽兜底: 不再因 block_data 为空 hard skip, 让 Jinja 模板 {% if %} 兜底渲染."""
        content = APP_PY.read_text(encoding="utf-8")
        # 切片方式: 从 def export_main_images_zip 行截到下一个 @app.route 或 def
        start = content.find("def export_main_images_zip")
        assert start >= 0, "找不到 def export_main_images_zip"
        # 搜下一个端点边界 (@app.route 装饰器)
        nxt = content.find("@app.route", start + 1)
        body = content[start:nxt] if nxt > 0 else content[start:]
        assert "block_data" in body, "断言前置: 函数体必须引用 block_data"
        # 不应有 "if not block_data: continue" 这种硬跳
        assert not re.search(
            r'if\s+not\s+block_data\s*:\s*\n\s+continue',
            body,
        ), (
            "export_main_images_zip 不应用 'if not block_data: continue' 硬跳 — "
            "已改为放宽兜底 (Jinja 模板用 {% if %} 自处理空字段)."
        )


# ── 静态守护: 前端 Content-Type 切换 ───────────────────────────────────

class TestFrontendContentTypeBranch:
    """workspace.html 必须按 Content-Type 决定 .png / .zip 后缀."""

    def test_workspace_branches_on_content_type(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        # 切片: exportMainImagesZip 函数起 → 下一个 function 关键字
        start = content.find("function exportMainImagesZip")
        assert start >= 0, "找不到 function exportMainImagesZip"
        nxt = content.find("function ", start + 20)
        body = content[start:nxt] if nxt > 0 else content[start:start + 3000]
        assert "Content-Type" in body, (
            "exportMainImagesZip 函数体必须读 resp.headers.get('Content-Type') 决定文件名后缀. "
            "不能硬码 .zip — 后端单图返 image/png 时用户会下到 .png 文件却带 .zip 后缀."
        )
        assert "isZip" in body or "ct.includes('zip')" in body or 'ct.includes("zip")' in body, (
            "exportMainImagesZip 必须根据 Content-Type 判断 isZip 切换文件名."
        )

    def test_workspace_no_hardcoded_zip_filename(self):
        """硬码 'currentProductType}_主图.zip' 已废弃, 必须按 isZip 分发."""
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        # 不能有 a.download = `${...}_主图.zip` 直接硬码
        assert not re.search(
            r'a\.download\s*=\s*`\$\{[^`]*\}_主图\.zip`',
            content,
        ), "workspace.html exportMainImagesZip 不应硬编码 .zip 后缀, 应按 isZip 三元."


# ── 纯函数单测: _trim_bottom_whitespace ────────────────────────────────

class TestTrimBottomWhitespace:
    """PIL trim 工具函数三场景验证."""

    def _make_png(self, segments: list[tuple[int, tuple[int, int, int]]]) -> bytes:
        """拼一张 750xH 的 PNG, segments=[(高度, RGB), ...]."""
        total_h = sum(h for h, _ in segments)
        img = Image.new("RGB", (750, total_h), (255, 255, 255))
        y = 0
        for h, color in segments:
            for yy in range(y, y + h):
                for xx in range(750):
                    img.putpixel((xx, yy), color)
            y += h
        out = io.BytesIO()
        img.save(out, format="PNG")
        return out.getvalue()

    def test_trim_removes_bottom_white_band(self):
        """750×1200 上方 800px 红色 + 下方 400px 白色 → 输出高度 ≈ 800px."""
        from app import _trim_bottom_whitespace
        png = self._make_png([(800, (255, 0, 0)), (400, (255, 255, 255))])
        trimmed = _trim_bottom_whitespace(png)
        result = Image.open(io.BytesIO(trimmed))
        assert result.size[0] == 750, f"宽度必须保持 750, 实际 {result.size[0]}"
        # 允许 ±5px 容差(PIL getbbox 边界处理 + tolerance)
        assert 795 <= result.size[1] <= 805, (
            f"800px 红 + 400px 白 → 期望裁后 ≈800px, 实际 {result.size[1]}px"
        )

    def test_trim_preserves_full_red_image(self):
        """全图非白(全红) → bbox = 全图 → 不裁."""
        from app import _trim_bottom_whitespace
        png = self._make_png([(1200, (200, 50, 50))])
        trimmed = _trim_bottom_whitespace(png)
        result = Image.open(io.BytesIO(trimmed))
        assert result.size[1] == 1200, (
            f"全红图不应被裁 (block_a 深色场景图就是这种情况), 实际 {result.size[1]}"
        )

    def test_trim_handles_all_white_no_crash(self):
        """全白图 → bbox = None → 返回原 bytes 不崩."""
        from app import _trim_bottom_whitespace
        png = self._make_png([(1200, (255, 255, 255))])
        trimmed = _trim_bottom_whitespace(png)
        # 不裁/裁到 0 都可接受, 关键是不抛异常
        assert trimmed is not None and len(trimmed) > 0
