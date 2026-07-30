# 产品主图颜色保真 v3.2.2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 生成的产品详情页颜色严格匹配用户上传的主图，对任意产品对称、零硬编码。

**Architecture:** 后端用 PIL (Pillow `Image.quantize`) 从用户上传的 cutout 像素采样算出 RGB 主色 hex，注入两个独立通道 → ① INJECTION_PREFIX 内 hex 字符串数值锚 (B1) ② `image_urls` 加程序生成的纯色色卡 (B3)。fallback 链：双图 → 单图+hex → v3.2.1 单图+文字。

**Tech Stack:** Python 3.x · Pillow 已在 deps · pytest unittest · 不引 numpy / scikit-learn

**前置 Spec:** `docs/superpowers/specs/2026-04-29-color-anchor-hex-design.md`

---

## File Structure

| 路径 | 行为 | 责任 |
|---|---|---|
| `ai_refine_v2/color_extractor.py` | **创建** | 主色提取 + 色卡渲染唯一来源；纯函数模块，无副作用 |
| `ai_refine_v2/tests/test_color_extractor.py` | **创建** | 单测 + PIL 程序生成 fixture（绝不依赖真实产品图） |
| `ai_refine_v2/refine_generator.py` | **修改** (~40 行) | INJECTION_PREFIX 模板化 + generate_v2 入口调 anchor + 双图喂 image_urls + ENV 开关 |
| `ai_refine_v2/tests/test_refine_generator_v2.py` | **修改** (~15 行) | 现有 23 测保持绿，加 4-5 测覆盖双图 / hex 锚 / ENV 三档 |

---

## Task 1: ColorAnchor dataclass + 模块骨架 + 首个失败测

**Files:**
- Create: `ai_refine_v2/color_extractor.py`
- Create: `ai_refine_v2/tests/test_color_extractor.py`

- [ ] **Step 1: 写第一个失败测**

新建 `ai_refine_v2/tests/test_color_extractor.py`：

```python
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
            swatch_png_bytes=b"\x89PNG\r\n\x1a\n",  # PNG magic
        )
        self.assertEqual(anchor.primary_hex, "#FF0000")
        self.assertEqual(len(anchor.palette_hex), 3)
        self.assertAlmostEqual(anchor.confidence, 0.85)
        self.assertTrue(anchor.swatch_png_bytes.startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测验失败**

```bash
cd C:/Users/28293/clean-industry-ai-assistant
python -m pytest ai_refine_v2/tests/test_color_extractor.py -v
```

Expected: `ModuleNotFoundError: No module named 'ai_refine_v2.color_extractor'`

- [ ] **Step 3: 写最小骨架让测试过**

新建 `ai_refine_v2/color_extractor.py`：

```python
"""产品主色提取 + 色卡渲染 (v3.2.2 颜色保真双图锚定).

设计文档: docs/superpowers/specs/2026-04-29-color-anchor-hex-design.md

核心理念: PIL 像素级测量主色 → hex 数值锚 + 程序生成色卡, 对任意产品对称.
依赖: 仅 Pillow (已在 deps), 不引 numpy / scikit-learn.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class ColorAnchor:
    """产品主色锚点 (一次提取, 12 屏共享).

    成员:
        primary_hex: '#RRGGBB' 大写, 主簇 centroid hex
        palette_hex: top-3 簇 hex (含 primary_hex 在 [0])
        confidence: 主簇像素 / 非背景像素总数, 范围 [0.0, 1.0]
        swatch_png_bytes: 512x512 纯色 PNG bytes (primary_hex 作色), 用作 image_urls[1]
    """
    primary_hex: str
    palette_hex: list[str]
    confidence: float
    swatch_png_bytes: bytes


def extract_color_anchor(
    cutout_path: str | Path,
    *,
    downsample_to: int = 200,
    min_non_bg_pixels: int = 100,
    min_confidence: float = 0.30,
    swatch_size: int = 512,
) -> Optional[ColorAnchor]:
    """从 cutout 算主色 hex 锚, 失败返 None (调用方走 fallback).

    失败条件:
      - 文件不存在 / 读图失败 / 损坏
      - 非背景像素 < min_non_bg_pixels (整图基本是白底)
      - 主簇 confidence < min_confidence (产品多色无主导)
      - quantize 内部异常
    """
    return None  # 骨架: 后续 Task 逐步实现
```

- [ ] **Step 4: 跑测验通过**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py -v
```

Expected: `1 passed`

- [ ] **Step 5: commit**

```bash
git add ai_refine_v2/color_extractor.py ai_refine_v2/tests/test_color_extractor.py
git commit -m "feat(refine-v3): v3.2.2 task1 — ColorAnchor dataclass + 模块骨架 (1 测绿)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: PNG alpha + JPG 白底背景过滤

**Files:**
- Modify: `ai_refine_v2/color_extractor.py`
- Modify: `ai_refine_v2/tests/test_color_extractor.py`

- [ ] **Step 1: 写背景过滤的失败测**

在 `test_color_extractor.py` 末尾追加:

```python
class TestBackgroundFilter(unittest.TestCase):
    """验非背景像素过滤. PNG alpha + JPG 白底两条路径."""

    def test_fully_transparent_png_returns_none(self, tmp_path=None):
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
```

- [ ] **Step 2: 跑测验失败**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py::TestBackgroundFilter -v
```

Expected: 当前 stub 返 None → 这两个测**意外通过**（因为返 None 是正确行为，但不是因为背景过滤）。这其实是 ✓，但下面 Task 3 会让它们仍然通过。所以这步标 PASS，进入 step 3。

> **测试断言点**：本 Task 的两个测都**期望** `extract_color_anchor` 返 None。stub 全返 None 让它们通过是巧合，Task 3 真实实现后这两个测仍要通过。这是预期。

- [ ] **Step 3: 实现 _filter_background_pixels**

在 `color_extractor.py` 顶部 `extract_color_anchor` 之前加：

```python
from PIL import Image, UnidentifiedImageError


def _filter_background_pixels(img: Image.Image) -> list[tuple[int, int, int]]:
    """返回非背景像素的 RGB 列表.

    PNG with alpha: alpha < 128 排除
    其他模式 (JPG): 转 HSV, V > 240/255 且 S < 0.05 视为白背景排除
    """
    if img.mode == "RGBA":
        rgba_pixels = list(img.getdata())
        return [(r, g, b) for r, g, b, a in rgba_pixels if a >= 128]

    # JPG / RGB 路径: 用 HSV 滤白背景
    rgb_img = img.convert("RGB") if img.mode != "RGB" else img
    hsv_img = rgb_img.convert("HSV")
    rgb_pixels = list(rgb_img.getdata())
    hsv_pixels = list(hsv_img.getdata())
    out = []
    for (r, g, b), (h, s, v) in zip(rgb_pixels, hsv_pixels):
        # V > 240/255 且 S < 0.05 视为白背景 (S 范围 0-255, 0.05 * 255 ≈ 13)
        if v > 240 and s < 13:
            continue
        out.append((r, g, b))
    return out
```

替换 `extract_color_anchor` 函数体：

```python
def extract_color_anchor(
    cutout_path: str | Path,
    *,
    downsample_to: int = 200,
    min_non_bg_pixels: int = 100,
    min_confidence: float = 0.30,
    swatch_size: int = 512,
) -> Optional[ColorAnchor]:
    p = Path(cutout_path)
    if not p.is_file():
        return None
    try:
        img = Image.open(p)
        # 下采样加速 quantize
        if max(img.size) > downsample_to:
            ratio = downsample_to / max(img.size)
            new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
            img = img.resize(new_size, Image.LANCZOS)
        non_bg = _filter_background_pixels(img)
        if len(non_bg) < min_non_bg_pixels:
            return None
    except (UnidentifiedImageError, OSError, Exception):
        return None

    # Task 3 在这里加 quantize 算主色, 暂时仍返 None
    return None
```

- [ ] **Step 4: 跑测验通过**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py -v
```

Expected: 3 passed (原 dataclass 测 + 2 个新背景过滤测)

- [ ] **Step 5: commit**

```bash
git add ai_refine_v2/color_extractor.py ai_refine_v2/tests/test_color_extractor.py
git commit -m "feat(refine-v3): v3.2.2 task2 — PNG alpha + JPG 白底背景过滤 (3 测绿)

PNG with alpha: alpha < 128 排除
JPG 白底: HSV V > 240 且 S < 13 排除

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: K-means quantize → primary_hex + palette_hex + confidence

**Files:**
- Modify: `ai_refine_v2/color_extractor.py`
- Modify: `ai_refine_v2/tests/test_color_extractor.py`

- [ ] **Step 1: 写主色提取的失败测**

在 `test_color_extractor.py` 末尾追加:

```python
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
            # 量化误差容许 < 10/255
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
```

- [ ] **Step 2: 跑测验失败**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py::TestPrimaryColorExtraction -v
```

Expected: 3 个测全 FAIL（`anchor` 仍是 None）

- [ ] **Step 3: 实现 _kmeans_via_quantize + 主色逻辑**

在 `color_extractor.py` 的 `_filter_background_pixels` 之后加：

```python
def _kmeans_via_quantize(
    pixels: list[tuple[int, int, int]],
    k: int = 5,
) -> list[tuple[tuple[int, int, int], int]]:
    """用 Pillow Image.quantize MEDIANCUT 做 k-means 替代品.

    返回 [(centroid_rgb, pixel_count), ...] 按 pixel_count 降序.
    """
    if not pixels:
        return []
    # 把 pixels 装成 1xN PIL 图 → quantize → 读 palette + 计数
    n = len(pixels)
    img = Image.new("RGB", (n, 1))
    img.putdata(pixels)
    quantized = img.quantize(colors=k, method=Image.Quantize.MEDIANCUT)
    # quantized.getpalette() 返扁平 [r0,g0,b0,r1,g1,b1,...]
    palette_flat = quantized.getpalette() or []
    # quantized 是 P-mode, getdata() 返 palette index
    indices = list(quantized.getdata())
    # 计数每个 index
    from collections import Counter
    counts = Counter(indices)
    out: list[tuple[tuple[int, int, int], int]] = []
    for idx, cnt in counts.most_common():
        if idx * 3 + 2 >= len(palette_flat):
            continue
        rgb = (palette_flat[idx * 3], palette_flat[idx * 3 + 1], palette_flat[idx * 3 + 2])
        out.append((rgb, cnt))
    return out


def _rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)
```

替换 `extract_color_anchor` 函数体（接 Task 2 后续部分）：

```python
def extract_color_anchor(
    cutout_path: str | Path,
    *,
    downsample_to: int = 200,
    min_non_bg_pixels: int = 100,
    min_confidence: float = 0.30,
    swatch_size: int = 512,
) -> Optional[ColorAnchor]:
    p = Path(cutout_path)
    if not p.is_file():
        return None
    try:
        img = Image.open(p)
        if max(img.size) > downsample_to:
            ratio = downsample_to / max(img.size)
            new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
            img = img.resize(new_size, Image.LANCZOS)
        non_bg = _filter_background_pixels(img)
        if len(non_bg) < min_non_bg_pixels:
            return None

        clusters = _kmeans_via_quantize(non_bg, k=5)
        if not clusters:
            return None

        primary_rgb, primary_count = clusters[0]
        confidence = primary_count / len(non_bg)
        if confidence < min_confidence:
            return None

        primary_hex = _rgb_to_hex(primary_rgb)
        palette_hex = [_rgb_to_hex(rgb) for rgb, _ in clusters[:3]]
        # 不足 3 簇时填充
        while len(palette_hex) < 3:
            palette_hex.append(primary_hex)

        # swatch 在 Task 7 实现, 暂用占位
        swatch_bytes = b""

        return ColorAnchor(
            primary_hex=primary_hex,
            palette_hex=palette_hex,
            confidence=confidence,
            swatch_png_bytes=swatch_bytes,
        )
    except (UnidentifiedImageError, OSError, Exception):
        return None
```

- [ ] **Step 4: 跑测验通过**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py -v
```

Expected: 6 passed (3 dataclass+filter + 3 primary)

- [ ] **Step 5: commit**

```bash
git add ai_refine_v2/color_extractor.py ai_refine_v2/tests/test_color_extractor.py
git commit -m "feat(refine-v3): v3.2.2 task3 — Pillow quantize 主色提取 + palette + confidence (6 测绿)

Image.quantize(colors=5, method=MEDIANCUT) 替代 sklearn k-means
不引 numpy / scikit-learn 依赖

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: HE180 回归测 — 浅白+灰色不被算成黄色

**Files:**
- Modify: `ai_refine_v2/tests/test_color_extractor.py`

- [ ] **Step 1: 写 HE180 回归测**

在 `test_color_extractor.py` 的 `TestPrimaryColorExtraction` 类内追加：

```python
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
```

- [ ] **Step 2: 跑测验通过**（Task 3 实现已支持，本测应直接绿）

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py::TestPrimaryColorExtraction::test_he180_gray_white_not_yellow -v
```

Expected: PASS（`primary_hex` ≈ `#6B7280`, spread = max(107,114,128) - min(107,114,128) = 21 < 50, max=128 < 200, 不是黄色）

如果 FAIL，说明背景过滤或 quantize 没工作 — 回到 Task 2 / 3 修。

- [ ] **Step 3: 跑全 color_extractor 测**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py -v
```

Expected: 7 passed

- [ ] **Step 4: commit**

```bash
git add ai_refine_v2/tests/test_color_extractor.py
git commit -m "feat(refine-v3): v3.2.2 task4 — HE180 染黄回归保护测 (7 测绿)

钉死: 浅白底+灰色机身 → primary 必须在灰区间, 绝不算成黄色

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 多色产品（黄机身+黑轮）primary 简洁 + palette 含 secondary

**Files:**
- Modify: `ai_refine_v2/tests/test_color_extractor.py`

- [ ] **Step 1: 写多色产品测**

```python
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
```

- [ ] **Step 2: 跑测验通过**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py::TestPrimaryColorExtraction::test_multicolor_yellow_body_black_wheels -v
```

Expected: PASS

- [ ] **Step 3: 跑全 color_extractor 测验无回归**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py -v
```

Expected: 8 passed

- [ ] **Step 4: commit**

```bash
git add ai_refine_v2/tests/test_color_extractor.py
git commit -m "feat(refine-v3): v3.2.2 task5 — 多色产品 primary+palette 验收 (8 测绿)

黄机身+黑轮: primary=黄, palette 含黑 secondary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Edge cases — 损坏文件 + 路径不存在

**Files:**
- Modify: `ai_refine_v2/tests/test_color_extractor.py`

- [ ] **Step 1: 写 edge case 测**

```python
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
```

- [ ] **Step 2: 跑测验通过**（Task 3 try/except 已覆盖）

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py::TestEdgeCases -v
```

Expected: 3 passed

- [ ] **Step 3: 跑全 color_extractor 测**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py -v
```

Expected: 11 passed

- [ ] **Step 4: commit**

```bash
git add ai_refine_v2/tests/test_color_extractor.py
git commit -m "feat(refine-v3): v3.2.2 task6 — edge cases (损坏文件/缺失/零字节) 全返 None (11 测绿)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 色卡渲染 — _render_swatch_png + ColorAnchor.swatch_png_bytes wired

**Files:**
- Modify: `ai_refine_v2/color_extractor.py`
- Modify: `ai_refine_v2/tests/test_color_extractor.py`

- [ ] **Step 1: 写色卡渲染测**

```python
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
```

- [ ] **Step 2: 跑测验失败**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py::TestSwatchRendering -v
```

Expected: 2 个测 FAIL（`swatch_png_bytes = b""` 不是合法 PNG）

- [ ] **Step 3: 实现 _render_swatch_png + 接入 extract_color_anchor**

在 `color_extractor.py` 的 `_rgb_to_hex` 之后加：

```python
def _render_swatch_png(hex_color: str, size: int = 512) -> bytes:
    """渲染纯色色卡 PNG bytes (in-memory).

    用于 image_urls[1], gpt-image-2 双图视觉锚定.
    PNG 在写盘前不落盘, 全程 io.BytesIO.
    """
    import io
    r = int(hex_color[1:3], 16)
    g = int(hex_color[3:5], 16)
    b = int(hex_color[5:7], 16)
    img = Image.new("RGB", (size, size), (r, g, b))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
```

修改 `extract_color_anchor` 的 swatch 占位行：

```python
        # 替换:
        # swatch_bytes = b""
        # 为:
        try:
            swatch_bytes = _render_swatch_png(primary_hex, size=swatch_size)
        except Exception:
            swatch_bytes = b""  # 渲染失败仍允许返 anchor (走 B1 only)
```

- [ ] **Step 4: 跑测验通过**

```bash
python -m pytest ai_refine_v2/tests/test_color_extractor.py -v
```

Expected: 13 passed

- [ ] **Step 5: commit**

```bash
git add ai_refine_v2/color_extractor.py ai_refine_v2/tests/test_color_extractor.py
git commit -m "feat(refine-v3): v3.2.2 task7 — 色卡渲染 _render_swatch_png + 接入 ColorAnchor (13 测绿)

512x512 纯色 PNG bytes, 全程 io.BytesIO 不落盘
渲染失败时仍返 anchor (B1 only fallback)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: refine_generator.py — INJECTION_PREFIX 模板拆分 (V3_TEMPLATE + V3_LEGACY)

**Files:**
- Modify: `ai_refine_v2/refine_generator.py:565-582`

- [ ] **Step 1: 拆分常量**

打开 `ai_refine_v2/refine_generator.py`，把 line 565-582 这段：

```python
# v3 (PRD AI_refine_v3.1 §5.2): 喂 cutout 屏的 prompt 开头注入此句, 让 gpt-image-2
# 知道 image_urls[0] 是产品参考图, 必须保留产品 silhouette / 主色 / 关键部件.
# 不喂图屏不注入 (没 image_urls, 注入这句反而误导模型). 跟 cutout_whitelist 联动.
#
# v3.2.1 (2026-04-29 vision-first 转向, 用户实测 HE180/10 浅白灰被染浅灰黄):
# 之前的版本仍写 "preserve primary color" 但 prompt 文本里 DeepSeek 还会写
# "the product is industrial blue-gray" 这种颜色字面值, gpt-image-2 看到
# 文字描述跟自己 vision bias (清洗车 = 黄) 撕扯, 结果按 bias 走染黄.
# 修法: 把 Image 1 立成"颜色权威", 显式告诉模型: 文字里写的颜色不算数,
# 看图为准. 反向锚定 vision-first 而不是 text-first.
_INJECTION_PREFIX_V3 = (
    "Image 1 is the AUTHORITATIVE source for the product's color, "
    "silhouette, and key parts. Match Image 1 exactly. If the text below "
    "mentions a color that conflicts with Image 1, IGNORE the text — "
    "Image 1 always wins. Do not substitute the product's color based on "
    "training data or category conventions; use only the exact RGB hue "
    "shown in Image 1. Preserve silhouette, parts, and proportions exactly. "
)
```

替换为：

```python
# v3 (PRD AI_refine_v3.1 §5.2): 喂 cutout 屏的 prompt 开头注入注入语,
# 让 gpt-image-2 知道 image_urls[0] 是产品参考图, 必须保留产品 silhouette / 主色 / 关键部件.
#
# v3.2.1 (2026-04-29 vision-first 转向): 推倒 text-first 颜色描述路径
# v3.2.2 (2026-04-29 双图锚定): PIL 像素级测量主色 hex → 数值锚 (B1) + 双图 (B3)
#   - extract_color_anchor 成功 → 用 _INJECTION_PREFIX_V3_TEMPLATE.format(...)
#   - 失败 → 退到 _INJECTION_PREFIX_V3_LEGACY (v3.2.1 单图无 hex)

# v3.2.2 双图 + hex 数值锚 (anchor 提取成功路径)
_INJECTION_PREFIX_V3_TEMPLATE = (
    "Image 1 is the AUTHORITATIVE source for the product's color, silhouette, "
    "and key parts. Image 2 is a pure-color reference swatch showing the "
    "product's exact primary color {primary_hex} (extracted by pixel sampling, "
    "not estimated from text). The product's palette is {palette_str}. "
    "DO NOT render Image 2 as a visible element in output — it is a color "
    "reference for matching only. Match the product's color to {primary_hex} "
    "EXACTLY. If text below mentions any color that conflicts with Image 1 / "
    "Image 2, IGNORE the text. Do not substitute the product's color based "
    "on training data or category conventions. Preserve silhouette, parts, "
    "and proportions exactly. "
)

# v3.2.1 单图无 hex (anchor 失败 fallback)
_INJECTION_PREFIX_V3_LEGACY = (
    "Image 1 is the AUTHORITATIVE source for the product's color, "
    "silhouette, and key parts. Match Image 1 exactly. If the text below "
    "mentions a color that conflicts with Image 1, IGNORE the text — "
    "Image 1 always wins. Do not substitute the product's color based on "
    "training data or category conventions; use only the exact RGB hue "
    "shown in Image 1. Preserve silhouette, parts, and proportions exactly. "
)

# 向下兼容: 旧名指向 LEGACY, 等所有引用迁完后删
_INJECTION_PREFIX_V3 = _INJECTION_PREFIX_V3_LEGACY
```

- [ ] **Step 2: 跑现有测验无回归**

```bash
python -m pytest ai_refine_v2/tests/test_refine_generator_v2.py -v
```

Expected: 23 passed (现有断言 `prompt.startswith("Image 1 is the AUTHORITATIVE source")` 仍然成立, 因 LEGACY 起始字串相同)

- [ ] **Step 3: commit**

```bash
git add ai_refine_v2/refine_generator.py
git commit -m "feat(refine-v3): v3.2.2 task8 — INJECTION_PREFIX 拆分 _TEMPLATE + _LEGACY (23 测无回归)

v3.2.1 _INJECTION_PREFIX_V3 → 重命名 _INJECTION_PREFIX_V3_LEGACY
新增 _INJECTION_PREFIX_V3_TEMPLATE 带 {primary_hex} {palette_str} slot
旧名 _INJECTION_PREFIX_V3 指向 LEGACY 向下兼容

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: refine_generator.py — generate_v2 入口调 extract_color_anchor 一次

**Files:**
- Modify: `ai_refine_v2/refine_generator.py:692-790` (generate_v2 函数)

- [ ] **Step 1: 在 generate_v2 加 anchor 提取 + 缓存**

打开 `ai_refine_v2/refine_generator.py`，找到 line 758-763 的 `base_image_data_url` 段：

```python
    # v3.2 simplify: hoist _to_data_url 出循环, 避免 N 次重复 base64 同一文件.
    # 转换失败 → 全部 block 走纯文生 (跟旧行为一致, 单 block 失败 print warning 即可).
    base_image_data_url: Optional[str] = None
    if product_cutout_url:
        try:
            base_image_data_url = _to_data_url(product_cutout_url)
        except Exception as e:
            print(f"[gen_v2] 参考图转 data URL 失败, 全部 block 降级纯文生: {e}")
```

在它**之后**追加：

```python
    # v3.2.2: PIL 抽 cutout 主色 → hex 锚 + 色卡 PNG bytes (12 屏共享一次)
    # 失败返 None, 调用方走 v3.2.1 fallback (单图 + LEGACY prefix).
    color_anchor: Optional["ColorAnchor"] = None
    if product_cutout_url:
        try:
            from ai_refine_v2.color_extractor import extract_color_anchor
            color_anchor = extract_color_anchor(product_cutout_url)
            if color_anchor:
                print(f"[gen_v2] color_anchor: primary={color_anchor.primary_hex}, "
                      f"palette={color_anchor.palette_hex}, "
                      f"confidence={color_anchor.confidence:.3f}")
            else:
                print(f"[gen_v2] color_anchor 提取失败 (产品多色无主导/纯白/损坏图), "
                      f"走 v3.2.1 fallback")
        except Exception as e:
            print(f"[gen_v2] color_anchor 异常 (走 fallback): {e}")
            color_anchor = None
```

在 generator 文件**顶部** import 段加（ColorAnchor 类型注解用）：

```python
from ai_refine_v2.color_extractor import ColorAnchor  # v3.2.2
```

- [ ] **Step 2: 跑现有测验无回归**

```bash
python -m pytest ai_refine_v2/tests/test_refine_generator_v2.py -v
```

Expected: 23 passed (现有 mock 测的 product_cutout_url 多半是 fake 路径或 None, extract_color_anchor 返 None, fallback 路径不变)

如果有测红，说明某个测传了真实 cutout 路径 + 期望旧行为 — 那个测需要在 Task 12 调整。本步先记下哪个测红，但不动它。

- [ ] **Step 3: commit**

```bash
git add ai_refine_v2/refine_generator.py
git commit -m "feat(refine-v3): v3.2.2 task9 — generate_v2 入口调 extract_color_anchor 一次 (23 测无回归)

12 屏共享一次提取, 失败返 None 走 v3.2.1 fallback
日志打印 primary / palette / confidence 便于调试

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: refine_generator.py — _generate_one_block_v2 双图 + 模板格式化

**Files:**
- Modify: `ai_refine_v2/refine_generator.py:618-700` (_generate_one_block_v2)
- Modify: `ai_refine_v2/refine_generator.py:782-790` (generate_v2 调 _generate_one_block_v2 处)
- Modify: `ai_refine_v2/refine_generator.py:155-175` (_submit_image_task)

- [ ] **Step 1: 加 _to_data_url_from_bytes 工具**

在 `refine_generator.py` 的 `_to_data_url` 函数附近追加：

```python
def _to_data_url_from_bytes(png_bytes: bytes, mime: str = "image/png") -> str:
    """把 PNG bytes 转 data URL (色卡用, 全程内存)."""
    import base64
    b64 = base64.b64encode(png_bytes).decode("ascii")
    return f"data:{mime};base64,{b64}"
```

- [ ] **Step 2: 改 _submit_image_task 接受 image_urls list**

找到 line 155 附近：

```python
    if image_data_url:
        payload["image_urls"] = [image_data_url]
```

替换为：

```python
    # v3.2.2: image_data_url 可以是 str (单图) 或 list[str] (双图: cutout + swatch)
    if image_data_url:
        if isinstance(image_data_url, list):
            payload["image_urls"] = image_data_url
        else:
            payload["image_urls"] = [image_data_url]
```

- [ ] **Step 3: 改 _generate_one_block_v2 签名 + INJECTION 逻辑**

找到 `_generate_one_block_v2` 函数 (line 618 起)，在签名加 `color_anchor`：

```python
def _generate_one_block_v2(
    block: dict,
    image_data_url: Optional[str],
    api_key: str,
    api_call_fn: ApiCallFn,
    max_retries: int,
    thinking: str,
    size: str,
    color_anchor: Optional["ColorAnchor"] = None,  # v3.2.2 新增
) -> tuple[BlockResult, float]:
```

替换 line 652-657 的 INJECTION 逻辑：

```python
    effective_prompt = prompt
    if image_data_url:
        effective_prompt = _INJECTION_PREFIX_V3 + prompt
```

为：

```python
    # v3.2.2 INJECTION 选择:
    #   anchor 成功 + ENV=on        → TEMPLATE (双图 + hex)
    #   anchor 成功 + ENV=b1_only   → TEMPLATE (单图 + hex)
    #   anchor 失败 / ENV=off        → LEGACY (v3.2.1 单图无 hex)
    effective_prompt = prompt
    effective_image_urls: Optional[object] = image_data_url  # str | list[str] | None

    if image_data_url:
        env_mode = os.getenv("COLOR_ANCHOR_DUAL_IMAGE", "on").strip().lower()
        if color_anchor and env_mode != "off":
            palette_str = ", ".join(color_anchor.palette_hex)
            effective_prompt = _INJECTION_PREFIX_V3_TEMPLATE.format(
                primary_hex=color_anchor.primary_hex,
                palette_str=palette_str,
            ) + prompt
            # B3 双图: 仅 ENV=on 且 swatch 渲染成功
            if env_mode == "on" and color_anchor.swatch_png_bytes:
                swatch_data_url = _to_data_url_from_bytes(color_anchor.swatch_png_bytes)
                effective_image_urls = [image_data_url, swatch_data_url]
            else:
                effective_image_urls = image_data_url  # B1 only: 单图 + hex 文字锚
        else:
            effective_prompt = _INJECTION_PREFIX_V3_LEGACY + prompt
            effective_image_urls = image_data_url
```

把 _generate_one_block_v2 内调 api_call_fn 的地方（约 line 663）改用新变量。原代码：

```python
            url = api_call_fn(effective_prompt, image_data_url, api_key, thinking, size)
```

替换为（注意 api_call_fn 是 **positional** 调用，跟现有约定一致）：

```python
            url = api_call_fn(effective_prompt, effective_image_urls, api_key, thinking, size)
```

仅这一处。`_generate_one_block_v2` 内只有 1 处调 api_call_fn (在 retry 循环内)。

- [ ] **Step 4: 改 generate_v2 调 _generate_one_block_v2 处传 color_anchor**

找到 generate_v2 内 line 782-790 附近 Hero 调用：

```python
    hero_res, hero_cost = _generate_one_block_v2(
        hero_block, _cutout_for(hero_block), use_key, call_fn,
        max_retries_hero, thinking, size,
    )
```

改为：

```python
    hero_res, hero_cost = _generate_one_block_v2(
        hero_block, _cutout_for(hero_block), use_key, call_fn,
        max_retries_hero, thinking, size,
        color_anchor=color_anchor,
    )
```

同样找到并行 SP 屏调用（约 line 800 附近），加 `color_anchor=color_anchor` 参数。

- [ ] **Step 5: 跑现有测验无回归**

```bash
python -m pytest ai_refine_v2/tests/test_refine_generator_v2.py -v
```

Expected: 23 passed（旧测 color_anchor=None → 走 LEGACY → 起始字串不变）

如有红测，定位是哪段 mock 不兼容，记下，Task 12 修。

- [ ] **Step 6: commit**

```bash
git add ai_refine_v2/refine_generator.py
git commit -m "feat(refine-v3): v3.2.2 task10 — _generate_one_block_v2 双图 + 模板格式化 (23 测无回归)

新增 _to_data_url_from_bytes (色卡 PNG → data URL)
_submit_image_task 接受 list[str] image_urls
_generate_one_block_v2 加 color_anchor 参数, INJECTION 三档分支

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: ENV COLOR_ANCHOR_DUAL_IMAGE 三档开关测

**Files:**
- Modify: `ai_refine_v2/tests/test_refine_generator_v2.py`

- [ ] **Step 1: 写 ENV 三档测**

在 `test_refine_generator_v2.py` 末尾追加：

```python
class TestColorAnchorDualImage(unittest.TestCase):
    """v3.2.2 双图 + ENV 三档开关.

    color_anchor 注入路径:
      ENV=on (默认)  + anchor 成功 → 双图 + TEMPLATE prefix (含 hex)
      ENV=b1_only   + anchor 成功 → 单图 + TEMPLATE prefix (含 hex)
      ENV=off       + anchor 任何 → 单图 + LEGACY prefix (无 hex)
      ENV 任何       + anchor 失败 → 单图 + LEGACY prefix (跟 v3.2.1 一致)
    """

    def _make_anchor(self) -> "ColorAnchor":
        from ai_refine_v2.color_extractor import ColorAnchor
        return ColorAnchor(
            primary_hex="#6B7280",
            palette_hex=["#6B7280", "#3A3D42", "#D8D8D8"],
            confidence=0.85,
            swatch_png_bytes=b"\x89PNG\r\n\x1a\n_FAKE_SWATCH_BYTES_",
        )

    @mock.patch.dict("os.environ", {"COLOR_ANCHOR_DUAL_IMAGE": "on"})
    def test_env_on_dual_image_with_hex(self):
        from ai_refine_v2.refine_generator import _generate_one_block_v2
        block = {"block_id": "test", "visual_type": "hero", "is_hero": True,
                 "prompt": "test prompt " * 20, "title": "t"}
        captured = []

        # 跟现有测约定一致: api_call_fn 是 positional (prompt, img_url, api_key, thinking, size)
        def fake_call(prompt, img_url, api_key, thinking, size):
            captured.append((prompt, img_url))
            return "https://example.com/result.png"

        _generate_one_block_v2(
            block, "data:image/png;base64,FAKE_CUTOUT", "key", fake_call,
            max_retries=0, thinking="medium", size="3:4",
            color_anchor=self._make_anchor(),
        )

        prompt, img_url = captured[0]
        self.assertIn("#6B7280", prompt, "ENV=on 时 prompt 应含 primary_hex")
        self.assertIn("Image 2 is a pure-color reference swatch", prompt)
        self.assertIsInstance(img_url, list, "ENV=on 应双图 list")
        self.assertEqual(len(img_url), 2)

    @mock.patch.dict("os.environ", {"COLOR_ANCHOR_DUAL_IMAGE": "b1_only"})
    def test_env_b1_only_single_image_with_hex(self):
        from ai_refine_v2.refine_generator import _generate_one_block_v2
        block = {"block_id": "test", "visual_type": "hero", "is_hero": True,
                 "prompt": "test prompt " * 20, "title": "t"}
        captured = []

        def fake_call(prompt, img_url, api_key, thinking, size):
            captured.append((prompt, img_url))
            return "https://example.com/result.png"

        _generate_one_block_v2(
            block, "data:image/png;base64,FAKE_CUTOUT", "key", fake_call,
            max_retries=0, thinking="medium", size="3:4",
            color_anchor=self._make_anchor(),
        )

        prompt, img_url = captured[0]
        self.assertIn("#6B7280", prompt, "ENV=b1_only 时 prompt 仍应含 hex")
        # b1_only 是字符串 (str) 不是 list
        self.assertIsInstance(img_url, str, "ENV=b1_only 应单图 str")

    @mock.patch.dict("os.environ", {"COLOR_ANCHOR_DUAL_IMAGE": "off"})
    def test_env_off_falls_back_to_legacy(self):
        from ai_refine_v2.refine_generator import _generate_one_block_v2
        block = {"block_id": "test", "visual_type": "hero", "is_hero": True,
                 "prompt": "test prompt " * 20, "title": "t"}
        captured = []

        def fake_call(prompt, img_url, api_key, thinking, size):
            captured.append((prompt, img_url))
            return "https://example.com/result.png"

        _generate_one_block_v2(
            block, "data:image/png;base64,FAKE_CUTOUT", "key", fake_call,
            max_retries=0, thinking="medium", size="3:4",
            color_anchor=self._make_anchor(),
        )

        prompt, img_url = captured[0]
        self.assertNotIn("#6B7280", prompt, "ENV=off 时 prompt 不应含 hex")
        self.assertNotIn("Image 2", prompt, "ENV=off 时不应提 Image 2")
        self.assertIsInstance(img_url, str, "ENV=off 应单图 str")
```

- [ ] **Step 2: 跑测验通过**

```bash
python -m pytest ai_refine_v2/tests/test_refine_generator_v2.py::TestColorAnchorDualImage -v
```

Expected: 3 passed

- [ ] **Step 3: 跑全 generator 测**

```bash
python -m pytest ai_refine_v2/tests/test_refine_generator_v2.py -v
```

Expected: 26 passed (23 + 3)

- [ ] **Step 4: commit**

```bash
git add ai_refine_v2/tests/test_refine_generator_v2.py
git commit -m "test(refine-v3): v3.2.2 task11 — ENV COLOR_ANCHOR_DUAL_IMAGE 三档开关测 (26 测绿)

on / b1_only / off 三档行为分别钉死

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: 修复任何 Task 9-11 遗留的回归测

**Files:**
- Modify: `ai_refine_v2/tests/test_refine_generator_v2.py` (如有需要)

- [ ] **Step 1: 跑全套验状态**

```bash
python -m pytest ai_refine_v2/tests/test_refine_generator_v2.py -v
```

Expected: 26 passed

如全过 → 跳到 Step 4 直接 commit "no-op"。

如仍有红测 → 进 Step 2-3 修。

- [ ] **Step 2: 定位红测原因**

红测候选场景:
- 旧测期望 prompt 起始为完整 v3.2.1 prefix → 在 Task 10 把 `_INJECTION_PREFIX_V3 = _INJECTION_PREFIX_V3_LEGACY` 这行没生效
- 旧测 mock 的 `_to_data_url` 路径在 extract_color_anchor 调用时抛错 → log 多了但 anchor=None 应该 OK
- 现有测里有传真实 PNG 路径的 → extract_color_anchor 真算出 anchor → 行为变了

修法:
- 如是第 1 类 → 修 Task 8 的 `_INJECTION_PREFIX_V3 = _INJECTION_PREFIX_V3_LEGACY` 兼容行
- 如是第 3 类 → 给那个测显式加 `color_anchor=None` 或 mock `extract_color_anchor` 返 None

- [ ] **Step 3: 修红测后再跑**

```bash
python -m pytest ai_refine_v2/tests/test_refine_generator_v2.py -v
```

Expected: 26 passed

- [ ] **Step 4: commit (如有改动)**

```bash
git add ai_refine_v2/tests/test_refine_generator_v2.py
git commit -m "test(refine-v3): v3.2.2 task12 — 修补 v3.2.1 → v3.2.2 迁移残留测断言

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: 跑全项目测验整体不回归 + smoke 检查

**Files:** 无修改，仅验证

- [ ] **Step 1: 跑 ai_refine_v2 全套测**

```bash
python -m pytest ai_refine_v2/tests/ -v
```

Expected: 全绿（之前 217 → 现在约 217 + 13(color_extractor) + 3(generator dual_image) = ~233）

- [ ] **Step 2: 跑项目级 smoke**

```bash
# 用项目自带的 smoke skill
# 检查 imports / app boot / 关键端点 / e2e composer
```

或手动 import sanity check:

```bash
python -c "from ai_refine_v2.color_extractor import extract_color_anchor, ColorAnchor; print('✓ color_extractor 导出 OK')"
python -c "from ai_refine_v2.refine_generator import generate_v2, _INJECTION_PREFIX_V3_TEMPLATE, _INJECTION_PREFIX_V3_LEGACY; print('✓ generator v3.2.2 常量 OK')"
```

Expected: 两行 ✓

- [ ] **Step 3: 集成验证 — 假调一次 generate_v2**

```bash
python -c "
from ai_refine_v2.refine_generator import generate_v2

planning = {
    'product_meta': {'name': 'Test', 'category': '设备类', 'primary_color': 'gray', 'key_visual_parts': []},
    'style_dna': {'color_palette': 'test palette', 'lighting': 'test', 'composition_style': 'test', 'mood': 'test', 'typography_hint': 'test'},
    'screen_count': 1,
    'screens': [{'idx': 1, 'role': 'hero', 'title': 'h', 'prompt': 'test prompt ' * 20}],
}

calls = []
# api_call_fn 是 positional 签名 (prompt, img_url, api_key, thinking, size)
def fake_api(prompt, img_url, api_key, thinking, size):
    calls.append({'prompt_head': prompt[:200], 'img_url_type': type(img_url).__name__})
    return 'https://example.com/result.png'

result = generate_v2(planning, product_cutout_url=None, api_key='fake_key', api_call_fn=fake_api, max_retries_hero=0)
print(f'✓ 假调 generate_v2 OK, blocks={len(result.blocks)}')
print(f'  prompt_head: {calls[0][\"prompt_head\"]!r}')
print(f'  img_url_type: {calls[0][\"img_url_type\"]}')
"
```

Expected: 输出含 `✓ 假调 generate_v2 OK, blocks=1`，prompt_head 不含 INJECTION（因 cutout=None）。

- [ ] **Step 4: 最终 commit (空 commit 加版本标记)**

```bash
git commit --allow-empty -m "chore(refine-v3): v3.2.2 全套测绿, 颜色保真双图锚定上线就绪

Tasks 1-13 完成:
- color_extractor.py PIL 主色 + 色卡渲染 (13 测)
- refine_generator.py INJECTION_PREFIX 模板化 + 双图 + ENV 三档 (新增 3 测)
- HE180 染黄回归保护测钉死

待办: HE180/10 真测 (用户提供 cutout + 文案后跑 .stage6_v3_real_test.py)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review 清单

实施前后, 实施工程师应自查:

- [ ] **Spec 覆盖**: spec §3 模块切分 / §4 接口契约 / §5 错误处理 / §6 测试策略 每条都有对应任务
- [ ] **Placeholder 扫**: 全文搜 TBD/TODO/FIXME, 应零命中
- [ ] **类型一致性**: ColorAnchor 字段名 (primary_hex / palette_hex / confidence / swatch_png_bytes) 在 task 1 / 7 / 11 应完全一致
- [ ] **fallback 链完整**: anchor 失败 / swatch 失败 / ENV=off / ENV=b1_only 四档全有测覆盖
- [ ] **YAGNI**: 没有反喂 planner / 没有删除 primary_color schema / 没有引 numpy

---

## 后续 (不在本计划)

- HE180/10 真测：用户提供 cutout + 文案 → `.stage6_v3_real_test.py` 加 fixture → 真调验证维度 10 颜色一致 PASS
- 通过后 push + deploy 上线
- 如真测仍不达标 → 立项 B2 (反喂 planner) 或 V4 升级 (独立 P1)
