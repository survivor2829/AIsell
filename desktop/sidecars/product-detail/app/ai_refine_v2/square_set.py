"""1:1 e-commerce main images (电商主图) derived locally from a finished AI精修 task.

No AI call and no cost: the four squares reuse what the task already has.
- white: the uploaded product photo (already cut out on upload) on a plain white square.
- main:  the hero screen.
- scene: the person-at-work screen (lifestyle_demo), else a working-scene screen.
- spec:  the parameter screen (spec_table).
The AI screens are 3:4 with text painted in by the model, so they are never cropped:
each is placed whole in the square, and the side bands are filled with a soft,
blurred copy of the same picture.
"""
from __future__ import annotations

import json
from pathlib import Path

SIZE = 1200
KINDS = (
    ("white", "白底图"),
    ("main", "主图"),
    ("scene", "场景图"),
    ("spec", "参数图"),
)


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _block_file(task_dir: Path, block: dict | None) -> Path | None:
    if not block or not block.get("success") or not block.get("file"):
        return None
    path = (task_dir / str(block["file"])).resolve()
    try:
        path.relative_to(task_dir.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


def _pick_sources(task_dir: Path) -> dict[str, Path | None]:
    summary = _read_json(task_dir / "_summary.json") or {}
    planning = _read_json(task_dir / "_planning.json") or {}
    blocks = summary.get("blocks") or []
    screens = planning.get("screens") or []
    by_idx = {}
    for position, block in enumerate(blocks, 1):
        by_idx[int(block.get("idx") or position)] = block

    def screen_block(test):
        for position, screen in enumerate(screens, 1):
            if test(screen):
                block = by_idx.get(int(screen.get("idx") or position))
                if _block_file(task_dir, block):
                    return block
        return None

    def presentation(screen):
        brief = screen.get("visual_brief") if isinstance(screen.get("visual_brief"), dict) else {}
        return brief.get("product_presentation")

    hero = screen_block(lambda s: s.get("role") == "hero") or by_idx.get(1)
    scene = (screen_block(lambda s: s.get("role") == "lifestyle_demo")
             or screen_block(lambda s: s.get("role") == "scenario" or presentation(s) == "working_scene")
             or by_idx.get(2))
    spec = screen_block(lambda s: s.get("role") == "spec_table")
    inputs = _read_json(task_dir / "_input.json") or {}
    photo = Path(str(inputs.get("product_image_url") or ""))
    return {
        "white": photo if str(photo) and photo.is_file() else None,
        "main": _block_file(task_dir, hero),
        "scene": _block_file(task_dir, scene),
        "spec": _block_file(task_dir, spec),
    }


def _white_square(photo: Path):
    from PIL import Image

    with Image.open(photo) as source:
        product = source.convert("RGBA")
    # Trim the transparent margin; faint specks the cutout leaves behind do not count as product.
    alpha_box = product.getchannel("A").point(lambda a: 255 if a > 32 else 0).getbbox()
    if alpha_box:
        product = product.crop(alpha_box)
    inner = int(SIZE * 0.86)
    scale = inner / max(product.width, product.height)  # Small uploads are enlarged too.
    product = product.resize((max(1, round(product.width * scale)), max(1, round(product.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGB", (SIZE, SIZE), (255, 255, 255))
    canvas.paste(product, ((SIZE - product.width) // 2, (SIZE - product.height) // 2), product)
    return canvas


def _fit_square(screen: Path):
    from PIL import Image, ImageEnhance, ImageFilter

    with Image.open(screen) as source:
        picture = source.convert("RGB")
    # Background: the same picture covering the square, heavily blurred and softened.
    scale = max(SIZE / picture.width, SIZE / picture.height)
    cover = picture.resize((max(1, round(picture.width * scale)), max(1, round(picture.height * scale))), Image.LANCZOS)
    left, top = (cover.width - SIZE) // 2, (cover.height - SIZE) // 2
    background = cover.crop((left, top, left + SIZE, top + SIZE)).filter(ImageFilter.GaussianBlur(48))
    background = ImageEnhance.Brightness(background).enhance(1.06)
    # Foreground: the whole screen, nothing cropped, so painted titles and tables stay intact.
    fit = min(SIZE / picture.width, SIZE / picture.height)
    whole = picture.resize((max(1, round(picture.width * fit)), max(1, round(picture.height * fit))), Image.LANCZOS)
    shadow = Image.new("RGBA", (whole.width + 40, whole.height + 40), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 70), (20, 20, whole.width + 20, whole.height + 20))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas = background.convert("RGBA")
    x, y = (SIZE - whole.width) // 2, (SIZE - whole.height) // 2
    canvas.alpha_composite(shadow, (max(0, x - 20), max(0, y - 14)))
    canvas.paste(whole, (x, y))
    return canvas.convert("RGB")


def build(task_dir: Path, *, force: bool = False) -> list[dict]:
    """Write square_<kind>.jpg next to the task's screens; rebuild only what changed.
    Returns one entry per module, with url None and a reason when its source is missing."""
    task_dir = Path(task_dir)
    sources = _pick_sources(task_dir)
    results = []
    for kind, label in KINDS:
        source = sources.get(kind)
        target = task_dir / f"square_{kind}.jpg"
        entry = {"kind": kind, "label": label, "url": None, "reason": ""}
        if source is None:
            entry["reason"] = {"white": "没有找到上传的产品图", "spec": "这套图没有参数屏"}.get(kind, "对应的屏还没有生成成功")
            target.unlink(missing_ok=True)
            results.append(entry)
            continue
        try:
            if force or not target.is_file() or target.stat().st_mtime < source.stat().st_mtime:
                image = _white_square(source) if kind == "white" else _fit_square(source)
                partial = target.with_suffix(".part.jpg")
                image.save(partial, "JPEG", quality=92, optimize=True)
                partial.replace(target)
            entry["url"] = f"/static/ai_refine_v2/{task_dir.name}/{target.name}?v={int(target.stat().st_mtime)}"
        except (OSError, ValueError) as exc:
            entry["reason"] = "这张图没能生成：" + type(exc).__name__
        results.append(entry)
    return results
