"""
图片合成器 v2 — 高质量电商详情图合成
AI背景 + 抠图产品 + 中文文字 → 专业详情图PNG
设计风格：深色科技感 + 渐变色彩 + 精致排版
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import math
import functools
import numpy as np

# ── 字体 ──────────────────────────────────────────────────────────────
# P4 §B.4 修复: 跨平台 emoji 字体候选, Windows / Linux / macOS 都能找到
# (per audit stub B4 方案 B). 原 FONT_DIR/FONT_REGULAR/FONT_BOLD 是 dead code,
# v2 管线已用 _resolve_font_path + _load_chinese_font 取代, 直接删除.
_EMOJI_FONT_CANDIDATES = [
    "C:/Windows/Fonts/seguiemj.ttf",                  # Windows 10+
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",  # Debian/Ubuntu
    "/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf",  # Fedora
    "/usr/share/fonts/noto/NotoColorEmoji.ttf",       # Arch
    "/System/Library/Fonts/Apple Color Emoji.ttc",    # macOS
]


def _resolve_emoji_font_path() -> str:
    """First-existing emoji 字体路径; 无可用返回空串 (caller fallback 到普通字体)."""
    for path in _EMOJI_FONT_CANDIDATES:
        if Path(path).exists():
            return path
    return ""

# ── 画布尺寸 ──────────────────────────────────────────────────────────
W = 750

# ── 配色 ──────────────────────────────────────────────────────────────
PRIMARY = (232, 35, 26)
ACCENT = (255, 80, 60)
DARK_BG = (10, 12, 24)
DARK_BG2 = (18, 22, 40)
WHITE = (255, 255, 255)
LIGHT_GRAY = (245, 245, 250)
TEXT_DARK = (17, 17, 17)
TEXT_GRAY = (120, 130, 145)
GOLD = (255, 200, 80)
BLUE_ACCENT = (60, 140, 255)


def _font(size, bold=False):
    return _load_chinese_font(size, bold)


def _emoji_font(size):
    """Emoji 字体, 跨平台候选解析; 全失败 fallback 到普通中文字体."""
    emoji_path = _resolve_emoji_font_path()
    if emoji_path:
        try:
            return ImageFont.truetype(emoji_path, size)
        except (IOError, OSError):
            pass
    return _font(size)


# ── 绘图工具 ──────────────────────────────────────────────────────────

def _vgradient(w, h, top_rgb, bot_rgb):
    """生成垂直渐变图像"""
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(top_rgb[0] + (bot_rgb[0] - top_rgb[0]) * t)
        g = int(top_rgb[1] + (bot_rgb[1] - top_rgb[1]) * t)
        b = int(top_rgb[2] + (bot_rgb[2] - top_rgb[2]) * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))
    return img.convert("RGBA")


def _dark_gradient_bg(w, h):
    """深色科技渐变背景"""
    return _vgradient(w, h, (8, 10, 28), (20, 26, 52))


def _light_gradient_bg(w, h):
    """浅色高级灰渐变背景"""
    return _vgradient(w, h, (240, 242, 248), (220, 225, 235))


def _draw_glow_line(draw, y, w, color=PRIMARY, alpha=60):
    """绘制发光装饰线"""
    for dy in range(-3, 4):
        a = max(0, alpha - abs(dy) * 18)
        draw.line([(40, y + dy), (w - 40, y + dy)], fill=(*color, a))


def _draw_accent_dot(draw, x, y, r=4, color=PRIMARY):
    """绘制装饰小圆点"""
    draw.ellipse([(x - r, y - r), (x + r, y + r)], fill=color)


def _draw_text_centered(draw, y, text, font, fill=WHITE, w=None):
    """居中绘制文字，返回底部y"""
    if not text:
        return y
    w = w or W
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((w - tw) // 2, y), text, font=font, fill=fill)
    return y + th


def _draw_text_left(draw, x, y, text, font, fill=WHITE):
    if not text:
        return y
    draw.text((x, y), text, font=font, fill=fill)
    bbox = draw.textbbox((0, 0), text, font=font)
    return y + bbox[3] - bbox[1]


def _draw_tag(draw, x, y, text, font, bg_color=PRIMARY, text_color=WHITE, padding=(12, 6)):
    """绘制标签胶囊"""
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    px, py = padding
    draw.rounded_rectangle(
        [(x, y), (x + tw + px * 2, y + th + py * 2)],
        radius=th // 2 + py, fill=bg_color
    )
    draw.text((x + px, y + py), text, font=font, fill=text_color)
    return y + th + py * 2


def _load_bg(bg_path, target_w, target_h):
    """加载背景图并裁切到目标尺寸"""
    if bg_path and Path(bg_path).exists():
        bg = Image.open(bg_path).convert("RGB")
        ratio = max(target_w / bg.width, target_h / bg.height)
        bg = bg.resize((int(bg.width * ratio), int(bg.height * ratio)), Image.LANCZOS)
        left = (bg.width - target_w) // 2
        top = (bg.height - target_h) // 2
        bg = bg.crop((left, top, left + target_w, top + target_h))
        return bg.convert("RGBA")
    return None


def _paste_product(canvas, product_path, max_w, max_h, cx, cy):
    """粘贴产品图到画布（居中），返回是否成功"""
    if not product_path or not Path(product_path).exists():
        return False
    prod = Image.open(product_path).convert("RGBA")
    ratio = min(max_w / prod.width, max_h / prod.height)
    new_w, new_h = int(prod.width * ratio), int(prod.height * ratio)
    prod = prod.resize((new_w, new_h), Image.LANCZOS)
    canvas.paste(prod, (cx - new_w // 2, cy - new_h // 2), prod)
    return True


def _add_shadow(canvas, product_path, max_w, max_h, cx, cy):
    """产品图底部椭圆阴影"""
    if not product_path or not Path(product_path).exists():
        return
    prod = Image.open(product_path).convert("RGBA")
    ratio = min(max_w / prod.width, max_h / prod.height)
    new_w, new_h = int(prod.width * ratio), int(prod.height * ratio)
    shadow = Image.new("RGBA", (new_w, int(new_h * 0.12)), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse([new_w * 0.1, 0, new_w * 0.9, shadow.height], fill=(0, 0, 0, 50))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    canvas.paste(shadow, (cx - new_w // 2, cy + new_h // 2 - 10), shadow)


def _add_glow_circle(canvas, cx, cy, radius=200, color=(232, 35, 26), alpha=25):
    """添加发光圆形装饰"""
    glow = Image.new("RGBA", (radius * 2, radius * 2), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([(0, 0), (radius * 2, radius * 2)], fill=(*color, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(radius // 2))
    canvas.paste(glow, (cx - radius, cy - radius), glow)


def _bottom_gradient(canvas, h, grad_h=300, max_alpha=200):
    """底部加暗渐变"""
    gradient = Image.new("RGBA", (W, grad_h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gradient)
    for y in range(grad_h):
        a = int(max_alpha * (y / grad_h))
        gd.line([(0, y), (W, y)], fill=(0, 0, 0, a))
    canvas.paste(gradient, (0, h - grad_h), gradient)


# ══════════════════════════════════════════════════════════════════════
#  屏1: 英雄屏 — 品牌+型号+产品图+参数
# ══════════════════════════════════════════════════════════════════════

def compose_hero(product_data: dict, product_image: str,
                 bg_path: str = "", save_path: str = "") -> Image.Image:
    h = 1334
    # 背景
    bg = _load_bg(bg_path, W, h)
    if bg:
        canvas = bg.copy()
        overlay = Image.new("RGBA", (W, h), (0, 0, 0, 70))
        canvas = Image.alpha_composite(canvas, overlay)
    else:
        canvas = _dark_gradient_bg(W, h)
        # 装饰光晕
        _add_glow_circle(canvas, W // 2, h // 3, 350, (30, 60, 140), 30)
        _add_glow_circle(canvas, W // 2 - 100, h // 2, 200, PRIMARY, 15)

    draw = ImageDraw.Draw(canvas)

    # 顶部装饰线
    draw.line([(60, 36), (W - 60, 36)], fill=(*WHITE, 15), width=1)

    y = 50
    brand = product_data.get("brand_text", "") or product_data.get("brand", "")
    if brand:
        # 品牌标签
        bf = _font(16)
        bbox = draw.textbbox((0, 0), brand, font=bf)
        bw = bbox[2] - bbox[0]
        bx = (W - bw - 24) // 2
        draw.rounded_rectangle([(bx, y), (bx + bw + 24, y + 30)], radius=15,
                                fill=(*WHITE, 20), outline=(*WHITE, 40))
        draw.text((bx + 12, y + 5), brand, font=bf, fill=(*WHITE, 200))
        y += 48

    cat = product_data.get("category_line", "")
    if cat:
        y = _draw_text_centered(draw, y, cat, _font(20), fill=(*WHITE, 180)) + 12

    model = product_data.get("model_name", "") or product_data.get("model", "")
    if model:
        y = _draw_text_centered(draw, y, model, _font(52, bold=True), fill=WHITE) + 8

    slogan = product_data.get("tagline_line1", "") or product_data.get("slogan", "")
    if slogan:
        y = _draw_text_centered(draw, y, slogan, _font(26, bold=True), fill=WHITE) + 6
    sub = product_data.get("tagline_line2", "") or product_data.get("sub_slogan", "")
    if sub:
        y = _draw_text_centered(draw, y, sub, _font(18), fill=(*WHITE, 160)) + 20

    # 产品图（大尺寸居中）
    prod_cy = max(y + 260, h // 2 + 40)
    _add_shadow(canvas, product_image, 520, 460, W // 2, prod_cy)
    has_prod = _paste_product(canvas, product_image, 520, 460, W // 2, prod_cy)

    if not has_prod:
        # 无产品图时绘制占位圆环
        draw = ImageDraw.Draw(canvas)
        _add_glow_circle(canvas, W // 2, prod_cy, 160, (60, 100, 200), 20)
        draw = ImageDraw.Draw(canvas)
        draw.ellipse([(W // 2 - 100, prod_cy - 100), (W // 2 + 100, prod_cy + 100)],
                     outline=(*WHITE, 40), width=2)
        _draw_text_centered(draw, prod_cy - 10, "产品图", _font(20), fill=(*WHITE, 60))

    # 底部参数条
    params = []
    for key in ["param_1", "param_2", "param_3", "param_4"]:
        label = product_data.get(f"{key}_label", "")
        value = product_data.get(f"{key}_value", "")
        if label and value:
            params.append((label, value))

    draw = ImageDraw.Draw(canvas)
    if params:
        bar_y = h - 130
        bar = Image.new("RGBA", (W, 110), (0, 0, 0, 0))
        bd = ImageDraw.Draw(bar)
        bd.rounded_rectangle([(20, 0), (W - 20, 110)], radius=16, fill=(0, 0, 0, 140))
        canvas.paste(bar, (0, bar_y), bar)
        draw = ImageDraw.Draw(canvas)

        col_w = (W - 40) // len(params)
        for i, (label, value) in enumerate(params):
            cx = 20 + col_w * i + col_w // 2
            # 分隔竖线
            if i > 0:
                draw.line([(cx - col_w // 2, bar_y + 20), (cx - col_w // 2, bar_y + 90)],
                          fill=(*WHITE, 30), width=1)
            vf = _font(26, bold=True)
            vbox = draw.textbbox((0, 0), value, font=vf)
            vw = vbox[2] - vbox[0]
            draw.text((cx - vw // 2, bar_y + 18), value, font=vf, fill=ACCENT)
            lf = _font(13)
            lbox = draw.textbbox((0, 0), label, font=lf)
            lw = lbox[2] - lbox[0]
            draw.text((cx - lw // 2, bar_y + 60), label, font=lf, fill=(*WHITE, 140))

    # 底部免责
    footer = product_data.get("footer_note", "")
    if footer:
        draw.text((30, h - 26), footer, font=_font(10), fill=(*WHITE, 60))

    if save_path:
        canvas.convert("RGB").save(save_path, quality=95)
    return canvas


# ══════════════════════════════════════════════════════════════════════
#  屏2: 核心卖点屏 — 带产品图的卖点展示
# ══════════════════════════════════════════════════════════════════════

def compose_selling_points(product_data: dict, product_image: str,
                           bg_path: str = "", save_path: str = "") -> Image.Image:
    """核心卖点详情屏：产品图 + 卖点列表"""
    advantages = product_data.get("advantages", [])
    if not advantages:
        return None

    n = len(advantages)
    has_prod = product_image and Path(product_image).exists()
    prod_space = 340 if has_prod else 40
    h = max(800, 160 + prod_space + n * 100 + 60)
    bg = _load_bg(bg_path, W, h)
    canvas = bg.copy() if bg else _dark_gradient_bg(W, h)

    # 装饰
    _add_glow_circle(canvas, 100, 200, 250, (30, 60, 180), 20)
    _add_glow_circle(canvas, W - 80, h - 300, 200, PRIMARY, 12)

    draw = ImageDraw.Draw(canvas)

    # 标题区
    y = 50
    _draw_accent_dot(draw, W // 2 - 100, y + 8, 3, ACCENT)
    _draw_accent_dot(draw, W // 2 + 100, y + 8, 3, ACCENT)
    y = _draw_text_centered(draw, y, "核心优势", _font(14), fill=(*WHITE, 120)) + 6

    title = f"{n}大核心卖点"
    y = _draw_text_centered(draw, y, title, _font(36, bold=True), fill=WHITE) + 8

    model = product_data.get("model_name", "") or product_data.get("model", "")
    if model:
        y = _draw_text_centered(draw, y, model, _font(16), fill=(*WHITE, 100)) + 20

    _draw_glow_line(draw, y, W, ACCENT, 40)
    y += 20

    # 产品图区（仅有产品图时显示）
    has_prod = product_image and Path(product_image).exists()
    if has_prod:
        prod_cy = y + 140
        _add_shadow(canvas, product_image, 340, 280, W // 2, prod_cy)
        _paste_product(canvas, product_image, 340, 280, W // 2, prod_cy)
        y = prod_cy + 160
    else:
        y += 20

    # 卖点列表
    draw = ImageDraw.Draw(canvas)
    margin = 40
    for idx, adv in enumerate(advantages):
        if isinstance(adv, dict):
            emoji = adv.get("emoji", "✅")
            text = adv.get("text", "")
        else:
            emoji, text = "✅", str(adv)
        if not text:
            continue

        ry = y + idx * 100
        # 卡片背景
        card = Image.new("RGBA", (W - margin * 2, 84), (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        cd.rounded_rectangle([(0, 0), (W - margin * 2 - 1, 83)], radius=14,
                              fill=(255, 255, 255, 18), outline=(255, 255, 255, 25))
        canvas.paste(card, (margin, ry), card)
        draw = ImageDraw.Draw(canvas)

        # 序号圆形
        num_x = margin + 38
        num_y = ry + 42
        draw.ellipse([(num_x - 18, num_y - 18), (num_x + 18, num_y + 18)], fill=PRIMARY)
        nf = _font(18, bold=True)
        nt = str(idx + 1)
        nb = draw.textbbox((0, 0), nt, font=nf)
        draw.text((num_x - (nb[2] - nb[0]) // 2, num_y - (nb[3] - nb[1]) // 2 - 1),
                  nt, font=nf, fill=WHITE)

        # emoji + 文字
        draw.text((margin + 70, ry + 16), emoji, font=_emoji_font(26), fill=WHITE,
                  embedded_color=True)
        draw.text((margin + 110, ry + 20), text, font=_font(22, bold=True), fill=WHITE)

        # 底部小装饰
        draw.line([(margin + 70, ry + 58), (margin + 110 + len(text) * 22, ry + 58)],
                  fill=(*ACCENT, 40), width=2)

    if save_path:
        canvas.convert("RGB").save(save_path, quality=95)
    return canvas


# ══════════════════════════════════════════════════════════════════════
#  屏3: 场景应用屏
# ══════════════════════════════════════════════════════════════════════

def compose_scene(product_data: dict, product_image: str,
                  scene_name: str = "", bg_path: str = "",
                  save_path: str = "") -> Image.Image:
    h = 1000
    bg = _load_bg(bg_path, W, h)
    if bg:
        canvas = bg.copy()
        _bottom_gradient(canvas, h, 350, 220)
        # 顶部也加一点暗
        top_grad = Image.new("RGBA", (W, 150), (0, 0, 0, 0))
        td = ImageDraw.Draw(top_grad)
        for y in range(150):
            a = int(100 * (1 - y / 150))
            td.line([(0, y), (W, y)], fill=(0, 0, 0, a))
        canvas.paste(top_grad, (0, 0), top_grad)
    else:
        canvas = _vgradient(W, h, (12, 18, 38), (8, 12, 28))
        _add_glow_circle(canvas, W // 2, h // 2, 300, (20, 50, 120), 25)

    # 顶部标签
    draw = ImageDraw.Draw(canvas)
    scene_text = scene_name if scene_name and scene_name != "default" else "商业场景"
    _draw_tag(draw, 30, 30, f"适用场景 · {scene_text}", _font(14), bg_color=(*PRIMARY, 180))

    # 产品图
    _add_shadow(canvas, product_image, 420, 400, W // 2, h // 2 - 30)
    _paste_product(canvas, product_image, 420, 400, W // 2, h // 2 - 30)

    draw = ImageDraw.Draw(canvas)

    # 底部效率文案
    y = h - 180
    efficiency = ""
    dp = product_data.get("detail_params", {})
    if isinstance(dp, dict):
        for k in ["工作效率", "清洁效率", "清扫效率", "洗地效率", "最大清洁效率"]:
            if k in dp:
                efficiency = dp[k]
                _draw_text_centered(draw, y, efficiency, _font(44, bold=True), fill=WHITE)
                y += 56
                _draw_text_centered(draw, y, k, _font(18), fill=(*WHITE, 160))
                y += 30
                break

    cat = product_data.get("category_line", "")
    if cat and not efficiency:
        _draw_text_centered(draw, y, cat, _font(28, bold=True), fill=WHITE)
        y += 40

    slogan = product_data.get("slogan", "") or product_data.get("tagline_line1", "")
    if slogan:
        _draw_text_centered(draw, y, slogan, _font(16), fill=(*WHITE, 140))

    if save_path:
        canvas.convert("RGB").save(save_path, quality=95)
    return canvas


# ══════════════════════════════════════════════════════════════════════
#  屏4: 参数规格屏
# ══════════════════════════════════════════════════════════════════════

def compose_specs(product_data: dict, product_image: str,
                  bg_path: str = "", save_path: str = "") -> Image.Image:
    specs = product_data.get("specs", [])
    if not specs:
        dp = product_data.get("detail_params", {})
        if isinstance(dp, dict):
            specs = [{"name": k, "value": v} for k, v in dp.items() if k and v]
    if not specs:
        return None

    rows_count = math.ceil(len(specs) / 2)
    table_h = rows_count * 50 + 80
    h = max(1200, 340 + 320 + table_h + 80)

    bg = _load_bg(bg_path, W, h)
    if bg:
        canvas = bg.copy()
        # AI背景上叠加半透明白层，确保文字可读
        white_overlay = Image.new("RGBA", (W, h), (255, 255, 255, 190))
        canvas = Image.alpha_composite(canvas, white_overlay)
    else:
        canvas = _light_gradient_bg(W, h)

    draw = ImageDraw.Draw(canvas)

    # 红色顶部条
    draw.rectangle([(0, 0), (W, 70)], fill=PRIMARY)
    model = product_data.get("model_name", "") or product_data.get("model", "")
    bar_text = f"{model} 产品参数" if model else "产品参数"
    draw.text((30, 18), bar_text, font=_font(28, bold=True), fill=WHITE)
    draw.text((W - 150, 28), "规格一览 ▸", font=_font(14), fill=(*WHITE, 180))

    # 产品图区域（浅色卡片背景）
    card_y = 90
    draw.rounded_rectangle([(20, card_y), (W - 20, card_y + 310)], radius=16,
                           fill=(255, 255, 255, 220))
    _paste_product(canvas, product_image, 360, 260, W // 2, card_y + 160)

    # 尺寸标注
    draw = ImageDraw.Draw(canvas)
    dims = product_data.get("dimensions", {})
    dim_parts = []
    for key, prefix in [("length", "长"), ("width", "宽"), ("height", "高")]:
        val = dims.get(key, "") or product_data.get(f"e_dim_{key}", "")
        if val:
            dim_parts.append(f"{prefix} {val}")
    if dim_parts:
        dim_text = "  ×  ".join(dim_parts)
        _draw_text_centered(draw, card_y + 280, dim_text, _font(16, bold=True), fill=TEXT_DARK)

    # 参数表
    table_y = card_y + 330
    margin = 24

    # 表头
    draw.rounded_rectangle([(margin, table_y), (W - margin, table_y + 52)], radius=12,
                           fill=(255, 255, 255, 240))
    draw.rectangle([(margin, table_y), (margin + 5, table_y + 52)], fill=PRIMARY)
    draw.text((margin + 18, table_y + 12), "产品参数", font=_font(20, bold=True), fill=TEXT_DARK)
    draw.text((margin + 140, table_y + 16), f"共{len(specs)}项", font=_font(13), fill=TEXT_GRAY)

    table_y += 58
    draw.line([(margin, table_y), (W - margin, table_y)], fill=(*PRIMARY, 80), width=2)
    table_y += 4

    # 双列参数行
    half = math.ceil(len(specs) / 2)
    col_w = (W - margin * 2) // 2
    label_w = 105
    row_h = 50

    for i in range(half):
        ry = table_y + i * row_h
        bg_fill = (240, 243, 248, 200) if i % 2 == 0 else (255, 255, 255, 180)
        draw.rectangle([(margin, ry), (W - margin, ry + row_h)], fill=bg_fill)

        spec = specs[i]
        draw.text((margin + 14, ry + 15), spec["name"], font=_font(14), fill=TEXT_GRAY)
        draw.text((margin + label_w, ry + 15), str(spec["value"]),
                  font=_font(14, bold=True), fill=TEXT_DARK)

        cx = margin + col_w
        draw.line([(cx, ry + 10), (cx, ry + row_h - 10)], fill=(0, 0, 0, 25), width=1)

        ri = i + half
        if ri < len(specs):
            sr = specs[ri]
            draw.text((cx + 14, ry + 15), sr["name"], font=_font(14), fill=TEXT_GRAY)
            draw.text((cx + label_w, ry + 15), str(sr["value"]),
                      font=_font(14, bold=True), fill=TEXT_DARK)

    footnote_y = table_y + half * row_h + 12
    draw.text((W - margin - 160, footnote_y), "*参数以实物为准", font=_font(12), fill=TEXT_GRAY)

    if save_path:
        canvas.convert("RGB").save(save_path, quality=95)
    return canvas


# ══════════════════════════════════════════════════════════════════════
#  屏5: VS对比屏 — 机器 vs 人工
# ══════════════════════════════════════════════════════════════════════

def compose_vs(product_data: dict, product_image: str,
               save_path: str = "") -> Image.Image:
    """VS对比屏：机器 vs 人工"""
    vs = product_data.get("vs_comparison", {})
    if not isinstance(vs, dict):
        vs = {}

    left_title = vs.get("left_title", "") or product_data.get("category_line", "")
    if not left_title:
        return None

    has_prod = product_image and Path(product_image).exists()
    card_h = 380 if has_prod else 240
    h = 320 + card_h + 60  # title + cards + bottom
    canvas = _dark_gradient_bg(W, h)
    _add_glow_circle(canvas, W // 4, h // 2, 250, BLUE_ACCENT, 15)
    _add_glow_circle(canvas, W * 3 // 4, h // 2, 250, (180, 40, 40), 12)

    draw = ImageDraw.Draw(canvas)

    # 标题
    y = 50
    count = vs.get("replace_count", "")
    if count:
        _draw_text_centered(draw, y, "1台顶", _font(28, bold=True), fill=(*WHITE, 180))
        y += 40
        _draw_text_centered(draw, y, f"{count}人", _font(56, bold=True), fill=ACCENT)
        y += 70
    else:
        _draw_text_centered(draw, y, "效率对比", _font(36, bold=True), fill=WHITE)
        y += 60

    saving = vs.get("annual_saving", "")
    if saving:
        _draw_text_centered(draw, y, f"年省 {saving} 元", _font(22), fill=GOLD)
        y += 40

    _draw_glow_line(draw, y, W, ACCENT, 50)
    y += 30

    # 左右对比
    mid = W // 2
    left_x, right_x = 40, mid + 20

    # 左侧（机器）— 绿色/蓝色调
    draw.rounded_rectangle([(left_x, y), (mid - 10, y + card_h)], radius=16,
                           fill=(20, 60, 100, 60), outline=(60, 140, 255, 60))
    draw.text((left_x + 20, y + 16), "🤖", font=_emoji_font(28), fill=WHITE,
              embedded_color=True)
    draw.text((left_x + 60, y + 20), left_title, font=_font(20, bold=True), fill=WHITE)

    left_sub = vs.get("left_sub", "")
    if left_sub:
        draw.text((left_x + 20, y + 60), left_sub, font=_font(14), fill=(*BLUE_ACCENT, 200))

    left_bottom = vs.get("left_bottom", "")
    if left_bottom:
        lines = left_bottom.replace("<br>", "\n").split("\n")
        ly = y + 100
        for line in lines:
            draw.text((left_x + 20, ly), line, font=_font(16, bold=True), fill=WHITE)
            ly += 28

    # 产品图放在左侧卡片内（仅有图时）
    if has_prod:
        _paste_product(canvas, product_image, 200, 160,
                       left_x + (mid - 10 - left_x) // 2, y + card_h - 110)

    # 右侧（人工）— 红色/暗调
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle([(right_x, y), (W - 40, y + card_h)], radius=16,
                           fill=(80, 20, 20, 60), outline=(180, 50, 50, 60))
    right_title = vs.get("right_title", "传统人工")
    draw.text((right_x + 20, y + 16), "👷", font=_emoji_font(28), fill=WHITE,
              embedded_color=True)
    draw.text((right_x + 60, y + 20), right_title, font=_font(20, bold=True), fill=(*WHITE, 180))

    right_sub = vs.get("right_sub", "")
    if right_sub:
        draw.text((right_x + 20, y + 60), right_sub, font=_font(14), fill=(*ACCENT, 200))

    right_bottom = vs.get("right_bottom", "")
    if right_bottom:
        lines = right_bottom.replace("<br>", "\n").split("\n")
        ly = y + 100
        for line in lines:
            draw.text((right_x + 20, ly), line, font=_font(16), fill=(*WHITE, 160))
            ly += 28

    # VS标记（精确居中）
    vs_y = y + card_h // 2
    draw.ellipse([(mid - 28, vs_y - 28), (mid + 28, vs_y + 28)], fill=PRIMARY)
    vf = _font(22, bold=True)
    vs_bbox = draw.textbbox((0, 0), "VS", font=vf)
    vs_tw = vs_bbox[2] - vs_bbox[0]
    vs_th = vs_bbox[3] - vs_bbox[1]
    draw.text((mid - vs_tw // 2, vs_y - vs_th // 2), "VS", font=vf, fill=WHITE)

    if save_path:
        canvas.convert("RGB").save(save_path, quality=95)
    return canvas


# ══════════════════════════════════════════════════════════════════════
#  屏6: 品牌CTA屏 — 底部收尾
# ══════════════════════════════════════════════════════════════════════

def compose_brand_cta(product_data: dict, product_image: str,
                      save_path: str = "") -> Image.Image:
    h = 600
    canvas = _vgradient(W, h, (15, 18, 38), (8, 10, 22))
    _add_glow_circle(canvas, W // 2, h // 2, 300, PRIMARY, 15)

    draw = ImageDraw.Draw(canvas)

    y = 80
    brand = product_data.get("brand", "") or product_data.get("brand_text", "")
    if brand:
        y = _draw_text_centered(draw, y, brand, _font(32, bold=True), fill=WHITE) + 16

    model = product_data.get("model_name", "") or product_data.get("model", "")
    if model:
        y = _draw_text_centered(draw, y, model, _font(44, bold=True), fill=WHITE) + 12

    slogan = product_data.get("slogan", "") or product_data.get("tagline_line1", "")
    if slogan:
        y = _draw_text_centered(draw, y, slogan, _font(18), fill=(*WHITE, 160)) + 30

    # CTA按钮
    btn_text = "立即咨询"
    bf = _font(22, bold=True)
    bbox = draw.textbbox((0, 0), btn_text, font=bf)
    bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    bx = (W - bw - 60) // 2
    by = y + 10
    draw.rounded_rectangle([(bx, by), (bx + bw + 60, by + bh + 24)], radius=(bh + 24) // 2,
                           fill=PRIMARY)
    draw.text((bx + 30, by + 12), btn_text, font=bf, fill=WHITE)

    # 底部免责
    draw.text((30, h - 40), "*产品参数以实物为准，图片仅供参考", font=_font(11), fill=(*WHITE, 60))
    draw.text((30, h - 22), "© " + (brand or "品牌"), font=_font(10), fill=(*WHITE, 40))

    if save_path:
        canvas.convert("RGB").save(save_path, quality=95)
    return canvas


# ══════════════════════════════════════════════════════════════════════
#  屏7: 清洁故事屏 — 核心清洁机构展示
# ══════════════════════════════════════════════════════════════════════

def compose_story(product_data: dict, product_image: str,
                  save_path: str = "") -> Image.Image:
    """清洁故事屏：核心清洁机构+效果数据"""
    story_t1 = product_data.get("story_title_1", "")
    story_t2 = product_data.get("story_title_2", "")
    if not story_t1 and not story_t2:
        return None

    has_prod = product_image and Path(product_image).exists()
    h = 1100 if has_prod else 600
    canvas = _dark_gradient_bg(W, h)
    _add_glow_circle(canvas, W // 2, 300, 300, (20, 50, 140), 20)

    draw = ImageDraw.Draw(canvas)

    # 标题区
    y = 50
    y = _draw_text_centered(draw, y, "清洁实力", _font(14), fill=(*WHITE, 100)) + 10
    if story_t1:
        y = _draw_text_centered(draw, y, story_t1, _font(28, bold=True), fill=WHITE) + 8
    if story_t2:
        y = _draw_text_centered(draw, y, story_t2, _font(22), fill=(*WHITE, 180)) + 20

    _draw_glow_line(draw, y, W, ACCENT, 40)
    y += 30

    # 产品图（仅有图时显示）
    if has_prod:
        prod_cy = y + 220
        _add_shadow(canvas, product_image, 500, 380, W // 2, prod_cy)
        _paste_product(canvas, product_image, 500, 380, W // 2, prod_cy)
        y = prod_cy + 220
    else:
        y += 30

    # 底部数据说明
    draw = ImageDraw.Draw(canvas)
    desc1 = product_data.get("story_desc_1", "")
    desc2 = product_data.get("story_desc_2", "")
    if desc1:
        y = _draw_text_centered(draw, y, desc1, _font(16), fill=(*WHITE, 160)) + 8
    if desc2:
        y = _draw_text_centered(draw, y, desc2, _font(16), fill=(*WHITE, 120)) + 16

    # 底部亮点条
    bot1 = product_data.get("story_bottom_1", "")
    bot2 = product_data.get("story_bottom_2", "")
    if bot1 or bot2:
        bar = Image.new("RGBA", (W - 60, 80), (0, 0, 0, 0))
        bd = ImageDraw.Draw(bar)
        bd.rounded_rectangle([(0, 0), (W - 61, 79)], radius=14, fill=(*PRIMARY, 40),
                              outline=(*PRIMARY, 80))
        canvas.paste(bar, (30, y), bar)
        draw = ImageDraw.Draw(canvas)
        if bot1:
            draw.text((60, y + 14), bot1, font=_font(20, bold=True), fill=ACCENT)
        if bot2:
            draw.text((60, y + 46), bot2, font=_font(14), fill=(*WHITE, 160))

    if save_path:
        canvas.convert("RGB").save(save_path, quality=95)
    return canvas


# ══════════════════════════════════════════════════════════════════════
#  主入口
# ══════════════════════════════════════════════════════════════════════

def compose_all(product_data: dict, product_image: str,
                backgrounds: dict, save_dir: str | Path) -> list[str]:
    """
    生成完整详情图集（6-8张）
    """
    save_dir = Path(save_dir)
    save_dir.mkdir(parents=True, exist_ok=True)
    results = []
    idx = 1

    def _save(name, img):
        nonlocal idx
        if img is None:
            return
        path = str(save_dir / f"{idx:02d}_{name}.png")
        img.convert("RGB").save(path, quality=95)
        results.append(path)
        print(f"[合成] {idx:02d}_{name} 完成")
        idx += 1

    # 1. 英雄屏（必出）
    _save("hero", compose_hero(
        product_data, product_image, bg_path=backgrounds.get("hero", "")))

    # 2. 卖点屏（有advantages时出）
    _save("selling_points", compose_selling_points(
        product_data, product_image))

    # 3. 清洁故事屏（有story数据时出）
    _save("story", compose_story(product_data, product_image))

    # 4. VS对比屏（有vs_comparison时出）
    _save("vs", compose_vs(product_data, product_image))

    # 5. 场景屏（每个场景背景各出一张）
    scene_bgs = {k: v for k, v in backgrounds.items() if k.startswith("scene_")}
    if scene_bgs:
        for name, bg in scene_bgs.items():
            sn = name.replace("scene_", "")
            _save(f"scene_{sn}", compose_scene(
                product_data, product_image, scene_name=sn, bg_path=bg))
    else:
        # 无AI背景也出一张场景屏
        _save("scene", compose_scene(product_data, product_image, scene_name="商业场景"))

    # 6. 参数屏（有参数时出）
    _save("specs", compose_specs(
        product_data, product_image, bg_path=backgrounds.get("specs", "")))

    # 7. 品牌CTA屏（收尾，必出）
    _save("brand_cta", compose_brand_cta(product_data, product_image))

    print(f"[合成] 全部完成，共 {len(results)} 张图")
    return results


# ══════════════════════════════════════════════════════════════════════
#  无缝长图合成器 — 多段 AI 背景渐变融合 + 全页内容叠加
# ══════════════════════════════════════════════════════════════════════

_FONT_CANDIDATES = {
    True: [  # bold
        "C:/Windows/Fonts/msyhbd.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.otf",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Bold.otf",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/Library/Fonts/Arial Bold.ttf",
    ],
    False: [  # regular
        "C:/Windows/Fonts/msyh.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/Library/Fonts/Arial.ttf",
    ],
}


@functools.lru_cache(maxsize=None)
def _resolve_font_path(bold: bool) -> str:
    """First-existing path; cached so candidate scanning runs once per (bold)."""
    for path in _FONT_CANDIDATES[bold]:
        if Path(path).exists():
            return path
    return ""


@functools.lru_cache(maxsize=64)
def _load_chinese_font(size: int, bold: bool = False):
    """跨平台中文字体加载，按 (size, bold) 缓存避免重复 stat + parse。"""
    path = _resolve_font_path(bold)
    if path:
        try:
            return ImageFont.truetype(path, size)
        except (IOError, OSError):
            pass
    return ImageFont.load_default()


def _draw_text_with_shadow(draw, xy, text, font, fill,
                           shadow_color=(0, 0, 0, 100),
                           shadow_offset=(2, 2)):
    """
    绘制带阴影的文字，提升深色/浅色背景可读性。
    draw: ImageDraw 对象（canvas 必须是 RGBA 模式）
    xy: (x, y) 文字左上角坐标
    shadow_color: RGBA 阴影颜色（默认半透明黑）
    shadow_offset: (dx, dy) 阴影偏移像素
    """
    sx, sy = xy[0] + shadow_offset[0], xy[1] + shadow_offset[1]
    draw.text((sx, sy), text, font=font, fill=shadow_color)
    draw.text(xy, text, font=font, fill=fill)


def blend_segments(top_img: Image.Image, bottom_img: Image.Image,
                   overlap_px: int = 120) -> Image.Image:
    """
    把两段背景图在交界处 overlap_px 像素范围内做 alpha 渐变融合，消除拼接硬边。
    两图必须等宽（宽度不同时自动将窄图 resize 至等宽）。

    - top_img 的底部 overlap_px 像素 与 bottom_img 的顶部 overlap_px 像素融合
    - 其余部分原样保留
    - 返回新的合成图（高度 = top_h + bottom_h - overlap_px）
    """
    top_img = top_img.convert("RGB")
    bottom_img = bottom_img.convert("RGB")

    tw, th = top_img.size
    bw, bh = bottom_img.size

    # 统一宽度
    target_w = max(tw, bw)
    if tw != target_w:
        top_img = top_img.resize((target_w, th), Image.LANCZOS)
        tw = target_w
    if bw != target_w:
        bottom_img = bottom_img.resize((target_w, bh), Image.LANCZOS)
        bw = target_w

    # clamp overlap
    overlap_px = max(1, min(overlap_px, th // 2, bh // 2))

    out_h = th + bh - overlap_px
    out = Image.new("RGB", (target_w, out_h))

    # --- 上段非重叠区 ---
    out.paste(top_img.crop((0, 0, target_w, th - overlap_px)), (0, 0))

    # --- 重叠区逐行混合（numpy） ---
    top_overlap = np.array(top_img.crop((0, th - overlap_px, target_w, th)),
                           dtype=np.float32)   # shape: (overlap_px, W, 3)
    bot_overlap = np.array(bottom_img.crop((0, 0, target_w, overlap_px)),
                           dtype=np.float32)

    # alpha: top 从 1→0，bottom 从 0→1，逐行线性
    alphas = np.linspace(1.0, 0.0, overlap_px, dtype=np.float32)  # (overlap_px,)
    alphas = alphas[:, np.newaxis, np.newaxis]                      # broadcast-ready

    blended = (top_overlap * alphas + bot_overlap * (1.0 - alphas)).clip(0, 255).astype(np.uint8)
    blend_img = Image.fromarray(blended, "RGB")
    out.paste(blend_img, (0, th - overlap_px))

    # --- 下段非重叠区 ---
    out.paste(bottom_img.crop((0, overlap_px, target_w, bh)), (0, th))

    return out


def compose_full_page(segment_paths: list,
                      overlaps: list = None,
                      target_width: int = 750) -> Image.Image:
    """
    把一系列分段背景图（按顺序）融合成一张连续的长图。

    segment_paths: ["/.../hero.png", "/.../adv.png", ...]
    overlaps: 每对相邻段之间的重叠像素数，长度 = len(segment_paths) - 1。
              不传时统一用 100。
    target_width: 输出宽度（默认 750）；每段图会先 resize 到该宽度保比例。

    返回融合后的 PIL Image（RGB 模式）。
    """
    # 加载并 resize 每段
    images = []
    for p in segment_paths:
        if not p or not Path(p).exists():
            print(f"[compose_full_page] 跳过不存在路径: {p}")
            continue
        img = Image.open(p).convert("RGB")
        w, h = img.size
        if w != target_width:
            new_h = int(h * target_width / w)
            img = img.resize((target_width, new_h), Image.LANCZOS)
        images.append(img)

    if not images:
        # 无可用段落：返回纯黑占位图
        return Image.new("RGB", (target_width, 1334), (10, 12, 24))

    if len(images) == 1:
        return images[0]

    # 构建 overlaps 列表
    n = len(images)
    if overlaps is None:
        overlaps = [100] * (n - 1)
    else:
        # 补齐或截断
        overlaps = list(overlaps)
        while len(overlaps) < n - 1:
            overlaps.append(100)
        overlaps = overlaps[: n - 1]

    # 逐对融合
    result = images[0]
    for i in range(1, n):
        result = blend_segments(result, images[i], overlap_px=overlaps[i - 1])

    return result


def _draw_wrapped_text(draw, x, y, text, font, fill, max_width, line_spacing=8):
    """
    自动换行绘制多行文本，返回底部 y 坐标。
    max_width: 最大行宽（像素）
    """
    if not text:
        return y
    words = list(text)  # 中文逐字拆分
    line = ""
    current_y = y
    for ch in words:
        test_line = line + ch
        bbox = draw.textbbox((0, 0), test_line, font=font)
        if bbox[2] - bbox[0] > max_width and line:
            draw.text((x, current_y), line, font=font, fill=fill)
            bbox2 = draw.textbbox((0, 0), line, font=font)
            current_y += bbox2[3] - bbox2[1] + line_spacing
            line = ch
        else:
            line = test_line
    if line:
        draw.text((x, current_y), line, font=font, fill=fill)
        bbox2 = draw.textbbox((0, 0), line, font=font)
        current_y += bbox2[3] - bbox2[1]
    return current_y


def _draw_kpi_card(draw, canvas, x, y, w, h, label, value, unit="",
                   bg_color=(255, 255, 255, 30), value_color=WHITE,
                   label_color=(255, 255, 255, 160)):
    """绘制 KPI 大数字卡（label + value + unit）"""
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([(0, 0), (w - 1, h - 1)], radius=14, fill=bg_color)
    canvas.paste(card, (x, y), card)
    draw = ImageDraw.Draw(canvas)

    # 数值（大号加粗）
    vf = _load_chinese_font(38, bold=True)
    uf = _load_chinese_font(20)
    lf = _load_chinese_font(15)

    val_text = str(value) + (unit or "")
    vbox = draw.textbbox((0, 0), val_text, font=vf)
    vw = vbox[2] - vbox[0]
    draw.text((x + (w - vw) // 2, y + 14), val_text, font=vf, fill=value_color)

    lbox = draw.textbbox((0, 0), label, font=lf)
    lw = lbox[2] - lbox[0]
    draw.text((x + (w - lw) // 2, y + h - 28), label, font=lf, fill=label_color)


def compose_final_detail_page(seamless_bg: Image.Image,
                              layout: list,
                              output_path: str,
                              theme_primary: str = "#E8231A") -> str:
    """
    在融合好的无缝背景上，逐元素叠加内容，输出最终的整张详情页长图。

    layout 是一个有序列表，每项描述一个区段（zone）的内容元素。
    支持的 element type:
      title / subtitle / section_title — 文字（居中/左/右，可选阴影）
      tag         — 胶囊标签
      product_image — 产品图（带 drop shadow）
      icon_grid   — 图标+文字网格（2列）
      params_strip — 参数条
      divider     — 极细分割线（带 alpha）
      kpi_card    — KPI 大数字卡
      text_block  — 自动换行段落

    所有 y_offset 都是「相对该 zone 的 y_start 偏移」。

    返回保存后的本地路径。
    """
    # 解析主题色
    def _hex(h):
        h = h.lstrip("#")
        return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

    primary_rgb = _hex(theme_primary)

    canvas = seamless_bg.copy().convert("RGBA")
    draw = ImageDraw.Draw(canvas)

    for zone in layout:
        y_start = zone.get("y_start", 0)
        elements = zone.get("elements", [])

        for el in elements:
            etype = el.get("type", "")
            y_abs = y_start + el.get("y_offset", 0)
            align = el.get("align", "center")
            shadow = el.get("shadow", False)
            color_raw = el.get("color", "#FFFFFF")

            def parse_color(c):
                if isinstance(c, tuple):
                    return c
                if isinstance(c, str) and c.startswith("#"):
                    return _hex(c)
                return (255, 255, 255)

            fill = parse_color(color_raw)

            # ── title / subtitle / section_title ───────────────────────
            if etype in ("title", "subtitle", "section_title"):
                sizes = {"title": 48, "section_title": 36, "subtitle": 22}
                bold_map = {"title": True, "section_title": True, "subtitle": False}
                size = el.get("size", sizes.get(etype, 28))
                is_bold = bold_map.get(etype, False)
                font = _load_chinese_font(size, bold=is_bold)
                text = el.get("text", "")
                if not text:
                    continue

                # 小色块装饰（section_title 前）
                if etype == "section_title":
                    bbox = draw.textbbox((0, 0), text, font=font)
                    tw = bbox[2] - bbox[0]
                    tx = (W - tw) // 2
                    bar_w = 4
                    bar_h = bbox[3] - bbox[1]
                    draw.rectangle([(tx - 14, y_abs + 2), (tx - 14 + bar_w, y_abs + bar_h - 2)],
                                   fill=(*primary_rgb, 200))

                if align == "center":
                    bbox = draw.textbbox((0, 0), text, font=font)
                    tw = bbox[2] - bbox[0]
                    tx = (W - tw) // 2
                elif align == "right":
                    bbox = draw.textbbox((0, 0), text, font=font)
                    tw = bbox[2] - bbox[0]
                    tx = W - tw - 40
                else:
                    tx = 40

                if shadow:
                    _draw_text_with_shadow(draw, (tx, y_abs), text, font, fill,
                                          shadow_color=(0, 0, 0, 120),
                                          shadow_offset=(2, 2))
                else:
                    draw.text((tx, y_abs), text, font=font, fill=fill)

            # ── tag ────────────────────────────────────────────────────
            elif etype == "tag":
                text = el.get("text", "")
                if not text:
                    continue
                size = el.get("size", 18)
                font = _load_chinese_font(size)
                bg_raw = el.get("bg", theme_primary)
                bg_color = parse_color(bg_raw) if isinstance(bg_raw, tuple) else _hex(bg_raw.lstrip("#"))
                bbox = draw.textbbox((0, 0), text, font=font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                px, py = 16, 7
                if align == "center":
                    tx = (W - tw - px * 2) // 2
                else:
                    tx = 40
                tag_layer = Image.new("RGBA", (tw + px * 2, th + py * 2), (0, 0, 0, 0))
                td = ImageDraw.Draw(tag_layer)
                td.rounded_rectangle([(0, 0), (tw + px * 2 - 1, th + py * 2 - 1)],
                                     radius=(th + py * 2) // 2,
                                     fill=(*bg_color, 220))
                canvas.paste(tag_layer, (tx, y_abs), tag_layer)
                draw = ImageDraw.Draw(canvas)
                draw.text((tx + px, y_abs + py), text, font=font, fill=fill)

            # ── product_image ──────────────────────────────────────────
            elif etype == "product_image":
                path = el.get("path", "")
                if not path or not Path(path).exists():
                    continue
                max_w = el.get("max_w", 560)
                max_h = el.get("max_h", 680)
                drop_shadow = el.get("drop_shadow", True)
                cx = W // 2
                cy = y_abs
                if drop_shadow:
                    _add_shadow(canvas, path, max_w, max_h, cx, cy)
                _paste_product(canvas, path, max_w, max_h, cx, cy)
                draw = ImageDraw.Draw(canvas)

            # ── icon_grid ──────────────────────────────────────────────
            elif etype == "icon_grid":
                items = el.get("items", [])
                cols = el.get("cols", 2)
                if not items:
                    continue
                col_w = (W - 60) // cols
                row_h = 120
                for idx, item in enumerate(items):
                    col = idx % cols
                    row = idx // cols
                    ix = 30 + col * col_w
                    iy = y_abs + row * row_h

                    # 卡片底
                    card = Image.new("RGBA", (col_w - 10, row_h - 10), (0, 0, 0, 0))
                    cd = ImageDraw.Draw(card)
                    cd.rounded_rectangle([(0, 0), (col_w - 11, row_h - 11)],
                                         radius=12, fill=(255, 255, 255, 22))
                    canvas.paste(card, (ix, iy), card)
                    draw = ImageDraw.Draw(canvas)

                    icon = item.get("icon", "●")
                    label = item.get("label", "")
                    desc = item.get("desc", "")

                    # emoji icon
                    ef = _emoji_font(28)
                    try:
                        draw.text((ix + 14, iy + 14), icon, font=ef, fill=fill,
                                  embedded_color=True)
                    except Exception:
                        draw.text((ix + 14, iy + 14), icon, font=_load_chinese_font(24), fill=fill)

                    lf = _load_chinese_font(18, bold=True)
                    draw.text((ix + 52, iy + 14), label, font=lf, fill=fill)
                    if desc:
                        df = _load_chinese_font(14)
                        draw.text((ix + 52, iy + 46), desc, font=df,
                                  fill=(*fill[:3], 160) if len(fill) >= 3 else fill)

            # ── params_strip ───────────────────────────────────────────
            elif etype == "params_strip":
                params = el.get("params", [])
                if not params:
                    continue
                bar_h = 90
                bar = Image.new("RGBA", (W - 40, bar_h), (0, 0, 0, 0))
                bd = ImageDraw.Draw(bar)
                bd.rounded_rectangle([(0, 0), (W - 41, bar_h - 1)], radius=14,
                                     fill=(0, 0, 0, 130))
                canvas.paste(bar, (20, y_abs), bar)
                draw = ImageDraw.Draw(canvas)

                col_w = (W - 40) // max(len(params), 1)
                for i, p in enumerate(params):
                    cx = 20 + col_w * i + col_w // 2
                    if i > 0:
                        draw.line([(cx - col_w // 2, y_abs + 15),
                                   (cx - col_w // 2, y_abs + bar_h - 15)],
                                  fill=(*fill[:3], 40), width=1)
                    vf = _load_chinese_font(24, bold=True)
                    val = str(p.get("value", ""))
                    vbox = draw.textbbox((0, 0), val, font=vf)
                    vw = vbox[2] - vbox[0]
                    draw.text((cx - vw // 2, y_abs + 10), val, font=vf,
                              fill=(*primary_rgb, 255))
                    lf2 = _load_chinese_font(13)
                    lbl = str(p.get("label", ""))
                    lbox = draw.textbbox((0, 0), lbl, font=lf2)
                    lw = lbox[2] - lbox[0]
                    draw.text((cx - lw // 2, y_abs + 52), lbl, font=lf2,
                              fill=(*fill[:3], 140))

            # ── divider ────────────────────────────────────────────────
            elif etype == "divider":
                alpha = el.get("alpha", 60)
                draw.line([(40, y_abs), (W - 40, y_abs)],
                          fill=(*fill[:3], alpha), width=1)

            # ── kpi_card ───────────────────────────────────────────────
            elif etype == "kpi_card":
                label = el.get("label", "")
                value = el.get("value", "")
                unit = el.get("unit", "")
                card_w = el.get("w", 200)
                card_h_val = el.get("h", 100)
                card_x = el.get("x", (W - card_w) // 2)
                _draw_kpi_card(draw, canvas, card_x, y_abs, card_w, card_h_val,
                               label, value, unit,
                               bg_color=(*primary_rgb, 40),
                               value_color=fill)
                draw = ImageDraw.Draw(canvas)

            # ── text_block ─────────────────────────────────────────────
            elif etype == "text_block":
                text = el.get("text", "")
                if not text:
                    continue
                size = el.get("size", 16)
                font = _load_chinese_font(size)
                margin_x = el.get("margin_x", 50)
                max_w_px = W - margin_x * 2
                _draw_wrapped_text(draw, margin_x, y_abs, text, font, fill, max_w_px)

    result = canvas.convert("RGB")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path, "PNG", optimize=True)
    return output_path


def build_seamless_layout(product_data: dict,
                          plan: list,
                          product_image: str = "") -> list:
    """
    根据已解析的 product_data 和 plan_seamless_page() 的结果，
    自动生成 compose_final_detail_page 需要的 layout 列表。

    plan 形如 [{"zone":"hero","height":1334,"overlap_bottom":120,...}, ...]

    字段映射规则：
      hero       → brand_text / model_name / main_title / sub_slogan + product_image
      advantages → advantages / icon_items
      story      → story_title_1/2 + story_desc_1/2
      specs      → specs / detail_params
      vs         → vs_comparison
      scene      → scenes（文字标签）
      brand      → brand_text + footer_note
    """
    layout = []
    y_cursor = 0

    for seg in plan:
        zone = seg.get("zone", "")
        height = seg.get("height", 900)
        overlap = seg.get("overlap_bottom", 0)
        # 在长图中这个 zone 的实际起始 y（考虑前面各段 overlap 已在 compose_full_page 消耗）
        y_start = y_cursor
        y_end = y_start + height
        y_cursor = y_end - overlap  # 下一段起点 = 当前段底 - overlap（融合消耗）

        elements = []

        if zone == "hero":
            brand = product_data.get("brand_text", "") or product_data.get("brand", "")
            model = product_data.get("model_name", "") or product_data.get("model", "")
            title = (product_data.get("main_title", "")
                     or product_data.get("tagline_line1", "")
                     or product_data.get("slogan", ""))
            sub = (product_data.get("sub_slogan", "")
                   or product_data.get("tagline_line2", ""))
            cat = product_data.get("category_line", "")

            if brand:
                elements.append({"type": "tag", "text": brand,
                                  "color": "#FFFFFF", "bg": "#FFFFFF20",
                                  "size": 16, "align": "center", "y_offset": 50})
            if cat:
                elements.append({"type": "subtitle", "text": cat,
                                  "color": "#FFFFFFB0", "size": 18,
                                  "align": "center", "y_offset": 96, "shadow": False})
            if model:
                elements.append({"type": "title", "text": model,
                                  "color": "#FFFFFF", "size": 52, "bold": True,
                                  "align": "center", "y_offset": 130, "shadow": True})
            if title:
                elements.append({"type": "subtitle", "text": title,
                                  "color": "#FFFFFF", "size": 26,
                                  "align": "center", "y_offset": 200, "shadow": True})
            if sub:
                elements.append({"type": "subtitle", "text": sub,
                                  "color": "#FFFFFFA0", "size": 18,
                                  "align": "center", "y_offset": 240, "shadow": False})

            # 产品图（居中，占据中部大面积）
            if product_image:
                elements.append({"type": "product_image", "path": product_image,
                                  "max_w": 560, "max_h": 680,
                                  "y_offset": height // 2 - 20,
                                  "drop_shadow": True})

            # 参数条
            params = []
            for key in ["param_1", "param_2", "param_3", "param_4"]:
                lbl = product_data.get(f"{key}_label", "")
                val = product_data.get(f"{key}_value", "")
                if lbl and val:
                    params.append({"label": lbl, "value": val})
            if not params:
                # 尝试从 detail_params / specs 取前 4 个
                dp = product_data.get("detail_params", {})
                if isinstance(dp, dict):
                    for k, v in list(dp.items())[:4]:
                        params.append({"label": k, "value": v})
                elif not params:
                    for sp in product_data.get("specs", [])[:4]:
                        params.append({"label": sp.get("name", ""), "value": sp.get("value", "")})
            if params:
                elements.append({"type": "params_strip", "params": params,
                                  "color": "#FFFFFF", "y_offset": height - 130})

            footer = product_data.get("footer_note", "")
            if footer:
                elements.append({"type": "text_block", "text": footer,
                                  "color": "#FFFFFF60", "size": 11,
                                  "y_offset": height - 26, "margin_x": 30})

            elements.append({"type": "divider", "color": "#FFFFFF",
                              "alpha": 30, "y_offset": height - 20})

        elif zone == "advantages":
            adv_list = product_data.get("advantages", [])
            # fallback: block_b2 icon_items
            if not adv_list:
                adv_list = product_data.get("icon_items", [])
            elements.append({"type": "section_title", "text": "六大核心优势",
                              "color": "#101828", "size": 36,
                              "align": "center", "y_offset": 60, "shadow": False})

            icon_items = []
            for i, adv in enumerate(adv_list):
                if isinstance(adv, dict):
                    icon_items.append({
                        "icon": adv.get("emoji", "✅"),
                        "label": adv.get("text", adv.get("title", f"优势{i+1}")),
                        "desc": adv.get("desc", ""),
                    })
                else:
                    icon_items.append({"icon": "✅", "label": str(adv), "desc": ""})
            if icon_items:
                elements.append({"type": "icon_grid", "items": icon_items,
                                  "cols": 2, "color": "#101828", "y_offset": 130})

        elif zone == "story":
            t1 = product_data.get("story_title_1", "")
            t2 = product_data.get("story_title_2", "")
            d1 = product_data.get("story_desc_1", "")
            d2 = product_data.get("story_desc_2", "")

            elements.append({"type": "section_title", "text": "清洁实力",
                              "color": "#FFFFFF90", "size": 14,
                              "align": "center", "y_offset": 50, "shadow": False})
            if t1:
                elements.append({"type": "title", "text": t1,
                                  "color": "#FFFFFF", "size": 28,
                                  "align": "center", "y_offset": 80, "shadow": True})
            if t2:
                elements.append({"type": "subtitle", "text": t2,
                                  "color": "#FFFFFFB0", "size": 22,
                                  "align": "center", "y_offset": 124, "shadow": False})
            if d1:
                elements.append({"type": "text_block", "text": d1,
                                  "color": "#FFFFFFA0", "size": 16,
                                  "y_offset": 200, "margin_x": 50})
            if d2:
                elements.append({"type": "text_block", "text": d2,
                                  "color": "#FFFFFF80", "size": 16,
                                  "y_offset": 240, "margin_x": 50})

        elif zone == "specs":
            specs = product_data.get("specs", [])
            if not specs:
                dp = product_data.get("detail_params", {})
                if isinstance(dp, dict):
                    specs = [{"name": k, "value": v} for k, v in dp.items() if k and v]

            model = product_data.get("model_name", "") or product_data.get("model", "")
            bar_text = f"{model} 产品参数" if model else "产品参数"
            elements.append({"type": "section_title", "text": bar_text,
                              "color": "#FFFFFF", "size": 28,
                              "align": "left", "y_offset": 18, "shadow": False})

            # KPI cards for first 4 params
            kpi_params = specs[:4] if specs else []
            card_w = (W - 60) // max(len(kpi_params), 1)
            for i, sp in enumerate(kpi_params):
                elements.append({"type": "kpi_card",
                                  "label": sp.get("name", ""),
                                  "value": sp.get("value", ""),
                                  "x": 20 + i * card_w, "w": card_w - 10, "h": 90,
                                  "color": "#FFFFFF",
                                  "y_offset": 80})
            # Remaining specs as text_block
            if len(specs) > 4:
                lines = "  /  ".join(f"{s['name']}: {s['value']}" for s in specs[4:])
                elements.append({"type": "text_block", "text": lines,
                                  "color": "#FFFFFFA0", "size": 14,
                                  "y_offset": 200, "margin_x": 30})

        elif zone == "vs":
            vs = product_data.get("vs_comparison", {})
            if not isinstance(vs, dict):
                vs = {}
            count = vs.get("replace_count", "")
            if count:
                elements.append({"type": "title",
                                  "text": f"1台顶{count}人",
                                  "color": "#FFFFFF", "size": 48,
                                  "align": "center", "y_offset": 60, "shadow": True})
            saving = vs.get("annual_saving", "")
            if saving:
                elements.append({"type": "subtitle",
                                  "text": f"年省 {saving} 元",
                                  "color": "#FFD666", "size": 22,
                                  "align": "center", "y_offset": 130, "shadow": False})
            left_title = vs.get("left_title", "")
            right_title = vs.get("right_title", "传统人工")
            if left_title:
                elements.append({"type": "section_title",
                                  "text": f"🤖 {left_title}  VS  👷 {right_title}",
                                  "color": "#FFFFFF", "size": 22,
                                  "align": "center", "y_offset": 180, "shadow": False})

        elif zone == "scene":
            scenes = product_data.get("scenes", [])
            elements.append({"type": "section_title", "text": "适用场景",
                              "color": "#101828", "size": 36,
                              "align": "center", "y_offset": 60, "shadow": False})
            if scenes:
                scene_items = []
                for sc in scenes:
                    if isinstance(sc, dict):
                        scene_items.append({
                            "icon": sc.get("icon", "🏢"),
                            "label": sc.get("name", sc.get("title", "")),
                            "desc": sc.get("desc", ""),
                        })
                    else:
                        scene_items.append({"icon": "🏢", "label": str(sc), "desc": ""})
                elements.append({"type": "icon_grid", "items": scene_items,
                                  "cols": 2, "color": "#101828", "y_offset": 140})

        elif zone == "brand":
            brand = product_data.get("brand_text", "") or product_data.get("brand", "")
            model = product_data.get("model_name", "") or product_data.get("model", "")
            slogan = (product_data.get("slogan", "")
                      or product_data.get("tagline_line1", ""))
            footer = product_data.get("footer_note", "")

            if brand:
                elements.append({"type": "title", "text": brand,
                                  "color": "#FFFFFF", "size": 32,
                                  "align": "center", "y_offset": 80, "shadow": True})
            if model:
                elements.append({"type": "title", "text": model,
                                  "color": "#FFFFFF", "size": 44,
                                  "align": "center", "y_offset": 130, "shadow": True})
            if slogan:
                elements.append({"type": "subtitle", "text": slogan,
                                  "color": "#FFFFFFA0", "size": 18,
                                  "align": "center", "y_offset": 200, "shadow": False})
            if footer:
                elements.append({"type": "text_block", "text": footer,
                                  "color": "#FFFFFF60", "size": 11,
                                  "y_offset": height - 40, "margin_x": 30})

        if elements:
            layout.append({
                "zone": zone,
                "y_start": y_start,
                "y_end": y_end,
                "elements": elements,
            })

    return layout


def compose_seamless_detail_page(product_data: dict,
                                 plan: list,
                                 segment_paths: list,
                                 product_image: str,
                                 output_path: str,
                                 theme_primary: str = "#E8231A") -> str:
    """
    无缝长图合成顶层入口，组合三步：
    1. compose_full_page(segment_paths, overlaps from plan) → seamless_bg
    2. build_seamless_layout(product_data, plan, product_image) → layout
    3. compose_final_detail_page(seamless_bg, layout, output_path)

    返回输出文件本地路径。
    """
    # 1. 融合分段背景
    overlaps = [seg.get("overlap_bottom", 100) for seg in plan[:-1]]
    seamless_bg = compose_full_page(segment_paths, overlaps=overlaps)
    print(f"[seamless] 背景合成完成，尺寸={seamless_bg.size}")

    # 2. 构建 layout（注入产品图到 hero zone）
    layout = build_seamless_layout(product_data, plan, product_image=product_image)

    # 3. 叠加内容并输出
    result_path = compose_final_detail_page(seamless_bg, layout, output_path,
                                            theme_primary=theme_primary)
    print(f"[seamless] 最终长图已保存: {result_path}")
    return result_path


# ══════════════════════════════════════════════════════════════════════
#  自测入口
# ══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import os
    from pathlib import Path as _Path

    # ── mock 产品数据 ──────────────────────────────────────────────────
    mock_product = {
        "brand_text": "德威莱克",
        "model_name": "DZ50X",
        "main_title": "驾驶式洗地机",
        "sub_slogan": "一台顶八人，智能清洁新标准",
        "category_line": "驾驶式洗地机",
        "tagline_line1": "一台顶8人 · 3600㎡/h",
        "tagline_line2": "全自动驾驶洗地，解放双手",
        "slogan": "高效清洁，智慧运营",
        "param_1_label": "清扫效率", "param_1_value": "3600㎡/h",
        "param_2_label": "续航时间", "param_2_value": "4小时",
        "param_3_label": "水箱容量", "param_3_value": "100L",
        "param_4_label": "整机重量", "param_4_value": "285kg",
        "specs": [
            {"name": "清扫效率",  "value": "3600㎡/h"},
            {"name": "续航时间",  "value": "4小时"},
            {"name": "水箱容量",  "value": "100L"},
            {"name": "整机重量",  "value": "285kg"},
            {"name": "工作宽度",  "value": "850mm"},
            {"name": "噪声值",    "value": "≤68dB"},
        ],
        "advantages": [
            {"emoji": "⚡", "text": "高效清扫 3600㎡/h"},
            {"emoji": "🤖", "text": "全自动驾驶操控"},
            {"emoji": "💧", "text": "超大100L水箱"},
            {"emoji": "🔋", "text": "4小时超长续航"},
            {"emoji": "🔇", "text": "低噪≤68dB"},
            {"emoji": "🛡️", "text": "工业级防护设计"},
        ],
        "story_title_1": "三刷三洗 深度洁净",
        "story_title_2": "专利刷盘技术，污垢无处遁形",
        "story_desc_1": "采用三刷协同清洁系统，刷洗同步，一次通过深度还原地面光洁。",
        "story_desc_2": "配合高压喷水与强力吸水，清洁效率提升300%。",
        "vs_comparison": {
            "left_title": "DZ50X洗地机",
            "left_sub": "3600㎡/h 全自动清洁",
            "right_title": "传统人工",
            "replace_count": "8",
            "annual_saving": "18万",
        },
        "footer_note": "*参数以实物为准，图片仅供参考",
    }

    # ── 找 scene_bank 里的几张图当分段背景 ─────────────────────────────
    scene_bank = _Path("C:/Users/28293/clean-industry-ai-assistant/static/scene_bank")
    scene_files = sorted(scene_bank.glob("*.jpg"))
    # 取 7 张（对应 7 个 zone），不够就重复
    zones_needed = 7
    segment_paths = []
    for i in range(zones_needed):
        segment_paths.append(str(scene_files[i % len(scene_files)]))
    print(f"[test] 使用 {len(segment_paths)} 张分段背景图")

    # ── mock plan（来自 ZONE_META）────────────────────────────────────
    from theme_color_flows import ZONE_META, ZONE_ORDER_DEFAULT
    mock_plan = []
    for zone_key in ZONE_ORDER_DEFAULT:
        meta = ZONE_META[zone_key]
        mock_plan.append({
            "zone": zone_key,
            "height": meta["height"],
            "overlap_bottom": meta["overlap_bottom"],
        })

    # ── 输出路径 ───────────────────────────────────────────────────────
    out_dir = _Path("C:/Users/28293/clean-industry-ai-assistant/output")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = str(out_dir / "test_seamless_compose.png")

    # ── 执行合成 ───────────────────────────────────────────────────────
    result = compose_seamless_detail_page(
        product_data=mock_product,
        plan=mock_plan,
        segment_paths=segment_paths,
        product_image="",          # 本机无产品图，跳过
        output_path=out_path,
        theme_primary="#E8231A",
    )

    # ── 验证 ────────────────────────────────────────────────────────────
    if _Path(result).exists():
        img = Image.open(result)
        print(f"[验证] 生成成功！尺寸: {img.size[0]} x {img.size[1]} px")
        print(f"[验证] 文件路径: {result}")
    else:
        print("[验证] 文件未生成，请检查错误！")
