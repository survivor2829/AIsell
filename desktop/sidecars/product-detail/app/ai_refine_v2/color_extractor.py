"""产品主色提取 + 色卡渲染 (v3.2.2 颜色保真双图锚定).

设计文档: docs/superpowers/specs/2026-04-29-color-anchor-hex-design.md

核心理念: PIL 像素级测量主色 → hex 数值锚 + 程序生成色卡, 对任意产品对称.
依赖: 仅 Pillow (已在 deps), 不引 numpy / scikit-learn.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PIL import Image, UnidentifiedImageError


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


def _apply_hsv_white_filter(
    rgb_pixels: list[tuple[int, int, int]],
    hsv_pixels: list[tuple[int, int, int]],
) -> list[tuple[int, int, int]]:
    """从 rgb_pixels 中过滤白底 (V > 240/255 且 S < 0.05).

    HSV 阈值: V > 240, S < 13 (S 范围 0-255, 0.05 * 255 ≈ 13).
    rgb_pixels 和 hsv_pixels 必须等长且一一对应.
    """
    out: list[tuple[int, int, int]] = []
    for (r, g, b), (h, s, v) in zip(rgb_pixels, hsv_pixels):
        if v > 240 and s < 13:
            continue
        out.append((r, g, b))
    return out


def _filter_background_pixels(img: Image.Image) -> list[tuple[int, int, int]]:
    """返回非背景像素的 RGB 列表.

    PNG with alpha: alpha < 128 排除, 同时过滤白底 (V > 240/255 且 S < 0.05)
    其他模式 (JPG): 转 HSV, V > 240/255 且 S < 0.05 视为白背景排除
    """
    if img.mode == "RGBA":
        # RGBA 路径: 先过滤 alpha, 再过滤白底
        rgba_pixels = list(img.getdata())
        rgb_with_alpha = [(r, g, b) for r, g, b, a in rgba_pixels if a >= 128]

        # 对保留的 RGB 像素再做白底过滤 (转 HSV)
        if not rgb_with_alpha:
            return []
        # Build 1×N RGB temp image for efficient batch HSV conversion
        # (避免 pixel-by-pixel RGB→HSV 数学)
        temp_img = Image.new("RGB", (len(rgb_with_alpha), 1))
        temp_img.putdata(rgb_with_alpha)
        hsv_img = temp_img.convert("HSV")
        hsv_pixels = list(hsv_img.getdata())

        return _apply_hsv_white_filter(rgb_with_alpha, hsv_pixels)

    # JPG / RGB 路径: 用 HSV 滤白背景
    rgb_img = img.convert("RGB") if img.mode != "RGB" else img
    hsv_img = rgb_img.convert("HSV")
    rgb_pixels = list(rgb_img.getdata())
    hsv_pixels = list(hsv_img.getdata())
    return _apply_hsv_white_filter(rgb_pixels, hsv_pixels)


# v3.2.3 HSV 伪色过滤阈值 (calibrated 用户 2026-05-12 实测产品颜色样本)
# 调参时改这里, 不动函数签名 — 避免调用方手动传参漂移.
_PSEUDO_MIN_SATURATION = 50   # S < 此值 + V 在中亮度区间 = 抗锯齿伪色
_PSEUDO_VALUE_MIN = 50        # V < 此值 = 真黑 (轮子/HE180 黑灰), 保留
_PSEUDO_VALUE_MAX = 220       # V > 此值 = 真白/高亮 (荧光绿浅版), 保留


def _filter_pseudo_colors(
    pixels: list[tuple[int, int, int]],
    *,
    min_saturation: int = _PSEUDO_MIN_SATURATION,
    pseudo_value_min: int = _PSEUDO_VALUE_MIN,
    pseudo_value_max: int = _PSEUDO_VALUE_MAX,
) -> list[tuple[int, int, int]]:
    """剔除"伪色"像素 (边缘抗锯齿 + 阴影产生的中亮度低饱和混色).

    v3.2.3 修 bug: 用户实测荧光绿产品 (palette 真色 #7AAB38 占 50%) 被错提成
    深灰绿 #60746F (边缘伪色 28%, MEDIANCUT 把同色不同亮度拆成 3 簇).

    HSV 判定 "伪色":
      pseudo_value_min <= V <= pseudo_value_max  AND  S < min_saturation
      → 中亮度 + 低饱和 = 抗锯齿混色 / 阴影 / 灰色边缘伪色, 应剔除

    保留:
      - 高饱和真彩色 (S >= min_saturation, 如荧光绿 #7AAB38 S=168)
      - 真黑 (V < pseudo_value_min, 如黑轮子 #000 V=0, HE180 黑灰 V=23)
      - 真白 (V > pseudo_value_max, 但已被上层 _filter_background_pixels 剔除)

    Trade-off: 纯中灰色大块产品 (#888888 V=136 S=0) 会被错剔. 实际生产场景
    中工业品很少有纯中灰主色 (要么白/黑/彩), 此 trade-off 由调用方 fallback 兜底.
    """
    if not pixels:
        return []
    temp_img = Image.new("RGB", (len(pixels), 1))
    temp_img.putdata(pixels)
    hsv_img = temp_img.convert("HSV")
    hsv_pixels = list(hsv_img.getdata())

    out: list[tuple[int, int, int]] = []
    for rgb, (_h, s, v) in zip(pixels, hsv_pixels):
        is_pseudo = (s < min_saturation and pseudo_value_min <= v <= pseudo_value_max)
        if not is_pseudo:
            out.append(rgb)
    return out


def _kmeans_via_quantize(
    pixels: list[tuple[int, int, int]],
    k: int = 5,
) -> list[tuple[tuple[int, int, int], int]]:
    """用 Pillow Image.quantize MEDIANCUT 做 k-means 替代品.

    返回 [(centroid_rgb, pixel_count), ...] 按 pixel_count 降序.
    """
    if not pixels:
        return []
    n = len(pixels)
    img = Image.new("RGB", (n, 1))
    img.putdata(pixels)
    quantized = img.quantize(colors=k, method=Image.Quantize.MEDIANCUT)
    palette_flat = quantized.getpalette() or []
    indices = list(quantized.getdata())
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


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    """'#RRGGBB' / 'RRGGBB' → (r, g, b). 大小写不敏感."""
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _render_swatch_png(hex_color: str, size: int = 512) -> bytes:
    """渲染纯色色卡 PNG bytes (in-memory).

    用于 image_urls[1], gpt-image-2 双图视觉锚定.
    PNG 在写盘前不落盘, 全程 io.BytesIO.
    """
    import io
    img = Image.new("RGB", (size, size), _hex_to_rgb(hex_color))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def extract_color_anchor(
    cutout_path: str | Path,
    *,
    downsample_to: int = 200,
    min_non_bg_pixels: int = 100,
    min_confidence: float = 0.25,
    swatch_size: int = 512,
) -> Optional[ColorAnchor]:
    """从 cutout 算主色 hex 锚, 失败返 None (调用方走 fallback).

    失败条件:
      - 文件不存在 / 读图失败 / 损坏
      - 非背景像素 < min_non_bg_pixels (整图基本是白底)
      - 主簇 confidence < min_confidence (产品多色无主导)
      - quantize 内部异常
    """
    p = Path(cutout_path)
    print(f"[color_anchor] start path={p} exists={p.is_file()}")
    if not p.is_file():
        print(f"[color_anchor] FAIL reason=cutout_missing path={p} ⚠️")
        return None
    try:
        img = Image.open(p)
        orig_size = img.size
        # 下采样加速 quantize
        if max(img.size) > downsample_to:
            ratio = downsample_to / max(img.size)
            new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
            img = img.resize(new_size, Image.LANCZOS)
        non_bg = _filter_background_pixels(img)
        total_pixels = img.size[0] * img.size[1]
        print(f"[color_anchor] orig_size={orig_size} downsampled={img.size} mode={img.mode} "
              f"non_bg_pixels={len(non_bg)} total_pixels={total_pixels} "
              f"non_bg_ratio={len(non_bg)/total_pixels if total_pixels else 0:.4f}")
        if len(non_bg) < min_non_bg_pixels:
            print(f"[color_anchor] FAIL reason=too_few_non_bg_pixels "
                  f"got={len(non_bg)} required>={min_non_bg_pixels} ⚠️")
            return None

        # v3.2.3 伪色过滤: 剔除中亮度低饱和 (抗锯齿+阴影) 但保留真黑+真彩色.
        # 如果过滤后剩 >= min_non_bg_pixels, 用过滤后的; 否则 fallback (纯灰中色保护).
        non_bg_clean = _filter_pseudo_colors(non_bg)
        if len(non_bg_clean) >= min_non_bg_pixels:
            print(f"[color_anchor] pseudo-color filter: non_bg {len(non_bg)} → "
                  f"clean {len(non_bg_clean)} (剔除边缘伪色, 保留真黑+真彩色)")
            non_bg = non_bg_clean
        else:
            print(f"[color_anchor] pseudo-color filter SKIPPED: only {len(non_bg_clean)} "
                  f"clean pixels (need >= {min_non_bg_pixels}), "
                  f"fallback 原 {len(non_bg)} 像素 (纯中灰色产品保护)")

        clusters = _kmeans_via_quantize(non_bg, k=5)
        if not clusters:
            print(f"[color_anchor] FAIL reason=quantize_returned_empty ⚠️")
            return None

        primary_rgb, primary_count = clusters[0]
        confidence = primary_count / len(non_bg)
        primary_hex_preview = _rgb_to_hex(primary_rgb)
        cluster_summary = [(f"{_rgb_to_hex(rgb)}", cnt, f"{cnt/len(non_bg):.3f}")
                           for rgb, cnt in clusters[:5]]
        print(f"[color_anchor] clusters (hex, count, ratio)={cluster_summary}")
        if confidence < min_confidence:
            print(f"[color_anchor] FAIL reason=low_confidence "
                  f"primary_hex={primary_hex_preview} confidence={confidence:.4f} "
                  f"required>={min_confidence} ⚠️")
            return None

        primary_hex = _rgb_to_hex(primary_rgb)
        palette_hex = [_rgb_to_hex(rgb) for rgb, _ in clusters[:3]]
        # 不足 3 簇时填充
        while len(palette_hex) < 3:
            palette_hex.append(primary_hex)

        # 渲染色卡 PNG bytes (Task 7)
        try:
            swatch_bytes = _render_swatch_png(primary_hex, size=swatch_size)
        except Exception as e:
            print(f"[color_anchor] swatch_render_failed err={e} → 走 B1 only 单图模式 ⚠️")
            swatch_bytes = b""  # 渲染失败仍允许返 anchor (走 B1 only)

        print(f"[color_anchor] OK primary_hex={primary_hex} palette={palette_hex} "
              f"confidence={confidence:.4f} swatch_bytes={len(swatch_bytes)}")
        return ColorAnchor(
            primary_hex=primary_hex,
            palette_hex=palette_hex,
            confidence=confidence,
            swatch_png_bytes=swatch_bytes,
        )
    except Exception as e:  # 按 spec §5.1: 任何异常 → 返 None, 不外抛
        print(f"[color_anchor] FAIL reason=extraction_exception err={e} ⚠️")
        return None
