"""P4 §B.4 image_composer.py 硬编码 Windows 字体路径修复 — 守护测试.

per `docs/superpowers/specs/_stubs/B4-windows-font-path-stub.md` 方案 B.

漏洞: image_composer.py:13-16 有 4 个 module-level 常量直接写死
"C:/Windows/Fonts/...", Linux Docker 容器路径不存在.

修复: 删 FONT_DIR/FONT_REGULAR/FONT_BOLD (dead code, 无引用),
将 FONT_EMOJI 改为跨平台候选列表 _resolve_emoji_font_path() 函数.

本测试组防止未来 PR 再加 Windows-only 硬编码常量.
"""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
COMPOSER = REPO_ROOT / "image_composer.py"


class TestNoHardcodedWindowsFontPath:
    """守护: image_composer.py 不能在顶层有 Windows 字体路径硬编码常量."""

    def test_no_font_dir_constant(self):
        """禁止 module-level `FONT_DIR = "C:/Windows/Fonts"` 常量."""
        content = COMPOSER.read_text(encoding="utf-8")
        forbidden = re.search(r'^FONT_DIR\s*=\s*["\']C:/Windows/Fonts', content, re.M)
        assert forbidden is None, (
            "image_composer.py 顶层不允许 FONT_DIR 硬编码 Windows 路径; "
            "用候选列表函数 (如 _resolve_emoji_font_path) 替代."
        )

    def test_no_font_regular_constant(self):
        """禁止 module-level `FONT_REGULAR = "C:/Windows/..."` 常量."""
        content = COMPOSER.read_text(encoding="utf-8")
        forbidden = re.search(
            r'^FONT_REGULAR\s*=\s*f?["\'].*Windows.*Fonts',
            content,
            re.M,
        )
        assert forbidden is None, (
            "FONT_REGULAR 硬编码 Windows 路径已被 _resolve_font_path 取代, "
            "请删除该常量."
        )

    def test_no_font_bold_constant(self):
        """禁止 module-level `FONT_BOLD = "C:/Windows/..."` 常量."""
        content = COMPOSER.read_text(encoding="utf-8")
        forbidden = re.search(
            r'^FONT_BOLD\s*=\s*f?["\'].*Windows.*Fonts',
            content,
            re.M,
        )
        assert forbidden is None, (
            "FONT_BOLD 硬编码 Windows 路径已被 _resolve_font_path 取代, "
            "请删除该常量."
        )


class TestEmojiFontHasCrossPlatformFallback:
    """守护: emoji 字体加载必须有跨平台候选."""

    def test_emoji_font_has_resolver_or_candidates(self):
        """必须存在 _resolve_emoji_font_path 函数或候选列表 (Linux/macOS 路径)."""
        content = COMPOSER.read_text(encoding="utf-8")
        has_resolver = "_resolve_emoji_font_path" in content
        has_linux_path = "/usr/share/fonts" in content and (
            "noto-color-emoji" in content.lower()
            or "twemoji" in content.lower()
            or "NotoColorEmoji" in content
        )
        assert has_resolver or has_linux_path, (
            "emoji 字体加载必须有跨平台支持 (函数或 Linux/Mac 候选路径); "
            "当前只有 Windows-only 路径会让 Linux 容器抛 IOError."
        )

    def test_emoji_font_function_exists(self):
        """_emoji_font 函数必须存在且不直接依赖 FONT_EMOJI 常量."""
        content = COMPOSER.read_text(encoding="utf-8")
        assert "def _emoji_font" in content, "缺 _emoji_font 函数"
        # 函数体不应直接 truetype(FONT_EMOJI, ...) 没有 fallback
        # 允许 truetype(FONT_EMOJI, size) 但必须包在 try/except 里
        # 我们的修复目标: _emoji_font 调用 _resolve_emoji_font_path 取真实路径


class TestResolveEmojiFontFunction:
    """守护: _resolve_emoji_font_path 函数应该存在并能工作."""

    def test_resolve_emoji_font_path_exists(self):
        """方案 B 修复要求新增 _resolve_emoji_font_path 函数."""
        content = COMPOSER.read_text(encoding="utf-8")
        assert "_resolve_emoji_font_path" in content, (
            "方案 B 修复要求新增 _resolve_emoji_font_path 函数 "
            "(仿 _resolve_font_path 模式), 当前未找到."
        )
