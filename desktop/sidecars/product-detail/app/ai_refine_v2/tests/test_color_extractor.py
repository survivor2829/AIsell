"""color_extractor 单测.

所有 fixture 用 PIL 程序生成, 绝不依赖任何真实产品图 (避免硬编码具体产品).
"""
from __future__ import annotations

import io
import unittest
from pathlib import Path

from PIL import Image

from ai_refine_v2.color_extractor import ColorAnchor, extract_color_anchor


def _make_solid_png(rgb: tuple[int, int, int], size: int = 100, alpha: bool = False) -> bytes:
    """生成纯色 PNG bytes (in-memory). alpha=True 加 alpha=255."""
    mode = "RGBA" if alpha else "RGB"
    color = (*rgb, 255) if alpha else rgb
    img = Image.new(mode, (size, size), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class TestColorAnchorDataclass(unittest.TestCase):
    """验 ColorAnchor dataclass 的 schema 跟 spec §4.1 一致."""

    def test_color_anchor_fields(self):
        anchor = ColorAnchor(
            primary_hex="#FF0000",
            palette_hex=["#FF0000", "#00FF00", "#0000FF"],
            confidence=0.85,
            swatch_png_bytes=b"\x89PNG\r\n\x1a\n",
        )
        self.assertEqual(anchor.primary_hex, "#FF0000")
        self.assertEqual(len(anchor.palette_hex), 3)
        self.assertAlmostEqual(anchor.confidence, 0.85)
        self.assertTrue(anchor.swatch_png_bytes.startswith(b"\x89PNG"))


class TestBackgroundFilter(unittest.TestCase):
    """验非背景像素过滤. PNG alpha + JPG 白底两条路径."""

    def test_fully_transparent_png_returns_none(self):
        """完全透明的 PNG → 无非背景像素 → None (不应崩)."""
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as td:
            p = Path(td) / "fully_transparent.png"
            img = Image.new("RGBA", (100, 100), (255, 0, 0, 0))  # 红色 + alpha=0
            img.save(p, format="PNG")
            anchor = extract_color_anchor(p)
            self.assertIsNone(anchor, "全透明 PNG 应返 None, 不应识别红色")

    def test_pure_white_jpg_returns_none(self):
        """纯白 JPG → 全是背景 → None."""
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as td:
            p = Path(td) / "pure_white.jpg"
            img = Image.new("RGB", (100, 100), (255, 255, 255))
            img.save(p, format="JPEG", quality=90)
            anchor = extract_color_anchor(p)
            self.assertIsNone(anchor, "纯白 JPG 应返 None (产品像素被全部当背景滤掉)")


class TestPrimaryColorExtraction(unittest.TestCase):
    """验 quantize 主色 + palette + confidence."""

    def _save_solid(self, td: Path, name: str, rgb: tuple[int, int, int]) -> Path:
        p = td / name
        img = Image.new("RGBA", (200, 200), (*rgb, 255))
        img.save(p, format="PNG")
        return p

    def _hex_distance(self, hex1: str, hex2: str) -> float:
        """欧式距离, 单位 0-255 通道."""
        r1, g1, b1 = int(hex1[1:3], 16), int(hex1[3:5], 16), int(hex1[5:7], 16)
        r2, g2, b2 = int(hex2[1:3], 16), int(hex2[3:5], 16), int(hex2[5:7], 16)
        return ((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) ** 0.5

    def test_solid_red_primary_extracted(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as td:
            p = self._save_solid(Path(td), "red.png", (255, 0, 0))
            anchor = extract_color_anchor(p)
            self.assertIsNotNone(anchor, "纯红 cutout 应能算出主色")
            dist = self._hex_distance(anchor.primary_hex, "#FF0000")
            self.assertLess(dist, 10, f"primary_hex {anchor.primary_hex} 偏离 #FF0000 太远 (dist={dist:.1f})")

    def test_solid_red_palette_size(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as td:
            p = self._save_solid(Path(td), "red.png", (255, 0, 0))
            anchor = extract_color_anchor(p)
            self.assertIsNotNone(anchor)
            self.assertEqual(len(anchor.palette_hex), 3, "palette 必须 top-3")
            self.assertEqual(anchor.palette_hex[0], anchor.primary_hex,
                             "palette[0] 必须等于 primary_hex")

    def test_solid_red_confidence_high(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as td:
            p = self._save_solid(Path(td), "red.png", (255, 0, 0))
            anchor = extract_color_anchor(p)
            self.assertIsNotNone(anchor)
            self.assertGreater(anchor.confidence, 0.95,
                               f"纯色产品 confidence 应近 1.0, 实际 {anchor.confidence:.3f}")

    def test_he180_gray_white_not_yellow(self):
        """HE180 染黄 bug 直接钉死回归保护:
        浅白底 + 灰色机身的产品图, primary_hex 必须在灰色区间, 绝不能被算成黄色.
        """
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as td:
            p = Path(td) / "he180_simulation.png"
            # 模拟 HE180: 200x200, 中央 60% 是灰色机身 #6B7280, 四周白底
            img = Image.new("RGBA", (200, 200), (255, 255, 255, 255))
            for y in range(40, 160):
                for x in range(40, 160):
                    img.putpixel((x, y), (107, 114, 128, 255))  # #6B7280
            img.save(p, format="PNG")
            anchor = extract_color_anchor(p)
            self.assertIsNotNone(anchor, "HE180 模拟图应能算出主色")

            # primary 必须在灰色区间 (R≈G≈B 且 都不接近 255)
            r = int(anchor.primary_hex[1:3], 16)
            g = int(anchor.primary_hex[3:5], 16)
            b = int(anchor.primary_hex[5:7], 16)

            # 钉死 bug: 黄色定义 = R和G都高 而 B低. 反向断言不能是黄色.
            is_yellow_ish = (r > 200 and g > 200 and b < 150)
            self.assertFalse(is_yellow_ish,
                             f"primary {anchor.primary_hex} 不应被算成黄色 (HE180 染黄 bug 回归保护)")

            # 正向断言: 应在灰色区间 (R, G, B 接近 + 都不极亮)
            max_channel = max(r, g, b)
            min_channel = min(r, g, b)
            spread = max_channel - min_channel
            self.assertLess(spread, 50,
                            f"primary {anchor.primary_hex} 应在灰色区间 (R≈G≈B), 实际 spread={spread}")
            self.assertLess(max_channel, 200,
                            f"primary {anchor.primary_hex} 不应极亮 (机身灰应在中等亮度)")

    def test_he180_real_world_dispersed_grays(self):
        """5 灰阶分散 fixture (主簇 ~30%) 必须进双图锚定路径, 不被当多色无主导丢弃."""
        from tempfile import TemporaryDirectory
        from ai_refine_v2.color_extractor import _hex_to_rgb
        with TemporaryDirectory() as td:
            p = Path(td) / "he180_dispersed.png"
            img = Image.new("RGBA", (100, 100), (255, 255, 255, 255))
            grays = [(128, 131, 134), (67, 67, 70), (18, 18, 19),
                     (224, 224, 224), (235, 234, 234)]
            band_heights = [30, 25, 20, 15, 10]  # sum=100, 各簇占非背景 ~30/25/20/15/10%
            y_start = 0
            for h, gray in zip(band_heights, grays):
                img.paste(Image.new("RGBA", (60, h), (*gray, 255)), (20, y_start))
                y_start += h
            img.save(p, format="PNG")
            anchor = extract_color_anchor(p)
            self.assertIsNotNone(anchor,
                "5 灰阶分散主簇 ~30% 应能进双图锚定路径 (反对症 fallback)")

            r, g, b = _hex_to_rgb(anchor.primary_hex)
            self.assertLess(max(r, g, b) - min(r, g, b), 20,
                f"primary {anchor.primary_hex} 必须在灰阶, 实际 spread={max(r,g,b)-min(r,g,b)}")
            is_yellow_ish = (r > 200 and g > 200 and b < 150)
            self.assertFalse(is_yellow_ish,
                f"分散灰阶 primary {anchor.primary_hex} 不应染黄")

    def test_multicolor_yellow_body_black_wheels(self):
        """80% 黄机身 + 20% 黑轮: primary='yellow' tier, palette 含 black."""
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as td:
            p = Path(td) / "yellow_black.png"
            # 200x200 RGBA, 80% 黄 (#FFC107) + 20% 黑 (#1A1A1A) + 透明背景
            img = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
            for y in range(0, 160):
                for x in range(0, 200):
                    img.putpixel((x, y), (255, 193, 7, 255))  # 黄
            for y in range(160, 200):
                for x in range(0, 200):
                    img.putpixel((x, y), (26, 26, 26, 255))  # 黑
            img.save(p, format="PNG")
            anchor = extract_color_anchor(p)
            self.assertIsNotNone(anchor)

            # primary 应在黄区间 (R高 G高 B低)
            r = int(anchor.primary_hex[1:3], 16)
            g = int(anchor.primary_hex[3:5], 16)
            b = int(anchor.primary_hex[5:7], 16)
            self.assertGreater(r, 200, f"primary {anchor.primary_hex} R 通道应高 (黄)")
            self.assertGreater(g, 150, f"primary {anchor.primary_hex} G 通道应高 (黄)")
            self.assertLess(b, 100, f"primary {anchor.primary_hex} B 通道应低 (黄)")

            # palette 应含一个黑色簇 (R, G, B 都 < 80)
            has_black_in_palette = any(
                int(h[1:3], 16) < 80 and int(h[3:5], 16) < 80 and int(h[5:7], 16) < 80
                for h in anchor.palette_hex
            )
            self.assertTrue(has_black_in_palette,
                            f"palette {anchor.palette_hex} 应含黑色 secondary (轮子)")


class TestEdgeCases(unittest.TestCase):
    """异常路径不应抛 exception, 全部返 None 让调用方走 fallback."""

    def test_nonexistent_path_returns_none(self):
        anchor = extract_color_anchor("/nonexistent/path/to/file.png")
        self.assertIsNone(anchor)

    def test_corrupted_png_returns_none(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as td:
            p = Path(td) / "corrupted.png"
            p.write_bytes(b"\x89PNG\r\n\x1a\nNOT_A_REAL_PNG_FILE")
            anchor = extract_color_anchor(p)
            self.assertIsNone(anchor)

    def test_zero_byte_file_returns_none(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as td:
            p = Path(td) / "empty.png"
            p.write_bytes(b"")
            anchor = extract_color_anchor(p)
            self.assertIsNone(anchor)


class TestSwatchRendering(unittest.TestCase):
    """验色卡 PNG 渲染: 必须是合法 PNG bytes, 主色匹配 primary_hex."""

    def test_swatch_is_valid_png(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as td:
            p = Path(td) / "red.png"
            img = Image.new("RGBA", (200, 200), (255, 0, 0, 255))
            img.save(p, format="PNG")
            anchor = extract_color_anchor(p)
            self.assertIsNotNone(anchor)
            self.assertTrue(anchor.swatch_png_bytes.startswith(b"\x89PNG"),
                            "swatch 必须是合法 PNG (magic header)")
            self.assertGreater(len(anchor.swatch_png_bytes), 100,
                               "swatch PNG 不应太小 (空文件嫌疑)")

    def test_swatch_color_matches_primary(self):
        """色卡像素颜色应匹配 primary_hex (允许 PNG 量化误差)."""
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as td:
            p = Path(td) / "blue.png"
            img = Image.new("RGBA", (200, 200), (0, 0, 255, 255))
            img.save(p, format="PNG")
            anchor = extract_color_anchor(p)
            self.assertIsNotNone(anchor)
            # 解 swatch_png_bytes 验中心像素颜色
            swatch_img = Image.open(io.BytesIO(anchor.swatch_png_bytes))
            r, g, b = swatch_img.getpixel((swatch_img.width // 2, swatch_img.height // 2))[:3]
            primary_r = int(anchor.primary_hex[1:3], 16)
            primary_g = int(anchor.primary_hex[3:5], 16)
            primary_b = int(anchor.primary_hex[5:7], 16)
            self.assertEqual((r, g, b), (primary_r, primary_g, primary_b),
                             "swatch 中心像素必须等于 primary_hex")


class TestPseudoColorFilter(unittest.TestCase):
    """v3.2.3 HSV 伪色过滤 (修用户 2026-05-12 荧光绿被错提成深灰绿 bug).

    设计要点:
      - 剔除中亮度低饱和像素 (抗锯齿+阴影伪色)
      - 保留真黑 (V<50, 如轮子/HE180 黑灰)
      - 保留真彩色 (S>=50, 如荧光绿)
      - 保留真高亮 (V>220, 如浅彩亮版)
    """

    def test_high_saturation_real_color_preserved(self):
        """高饱和真彩色应保留 (如荧光绿 #7AAB38 V=171 S=171)."""
        from ai_refine_v2.color_extractor import _filter_pseudo_colors
        pixels = [(0x7A, 0xAB, 0x38)]
        result = _filter_pseudo_colors(pixels)
        self.assertEqual(len(result), 1, "高饱和真彩色应保留")

    def test_low_sat_mid_value_pseudo_removed(self):
        """中亮度低饱和伪色应剔除 (如 #60746F V=116 S=43)."""
        from ai_refine_v2.color_extractor import _filter_pseudo_colors
        pixels = [(0x60, 0x74, 0x6F)]
        result = _filter_pseudo_colors(pixels)
        self.assertEqual(len(result), 0, "边缘抗锯齿伪色应剔除")

    def test_true_black_preserved(self):
        """真黑 (V<50) 应保留 (如轮子 #000 V=0, HE180 黑灰 #151517 V=23)."""
        from ai_refine_v2.color_extractor import _filter_pseudo_colors
        pixels = [(0x00, 0x00, 0x00), (0x15, 0x15, 0x17)]
        result = _filter_pseudo_colors(pixels)
        self.assertEqual(len(result), 2, "真黑色应全部保留")

    def test_high_value_preserved(self):
        """真高亮 (V>220) 应保留 (如荧光绿浅版 #B6E0A1 V=224)."""
        from ai_refine_v2.color_extractor import _filter_pseudo_colors
        pixels = [(0xB6, 0xE0, 0xA1)]
        result = _filter_pseudo_colors(pixels)
        self.assertEqual(len(result), 1, "高亮区像素应保留")

    def test_user_2026_05_12_fluorescent_green_mixture(self):
        """钉死用户实际产品颜色分布 (荧光绿主体 + 伪灰边缘 + 真黑).

        prod log 实测分布 (取整百倍, 模拟 200×150 图):
          #60746F 4275 (28.3%) ← 边缘伪色, 应剔除
          #1F2120 3262 (21.6%) ← 真黑, 保留
          #7AAB38 2796 (18.5%) ← 真荧光绿, 保留
          #87C438 2701 (17.9%) ← 荧光绿亮, 保留
          #B6E0A1 2096 (13.9%) ← 荧光绿浅, 保留
        """
        from ai_refine_v2.color_extractor import _filter_pseudo_colors
        pixels = (
            [(0x60, 0x74, 0x6F)] * 100  # 伪灰应剔除
            + [(0x1F, 0x21, 0x20)] * 80
            + [(0x7A, 0xAB, 0x38)] * 70
            + [(0x87, 0xC4, 0x38)] * 65
            + [(0xB6, 0xE0, 0xA1)] * 50
        )
        result = _filter_pseudo_colors(pixels)
        result_pseudo = [p for p in result if p == (0x60, 0x74, 0x6F)]
        result_real = len(result) - len(result_pseudo)
        self.assertEqual(len(result_pseudo), 0, "#60746F 伪灰应被剔除 100%")
        self.assertEqual(result_real, 265, "真黑+真荧光绿全保留 (80+70+65+50)")


if __name__ == "__main__":
    unittest.main()
