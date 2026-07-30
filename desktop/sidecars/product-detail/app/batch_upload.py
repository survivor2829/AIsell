"""批量上传:zip 解压 + 文件夹结构解析。

PRD: PRD_批量生成.md F1/F2/F3
路径约定: uploads/batches/{batch_id}/{产品名}/...

只做"识别+落盘",不入库、不开队列、不调外部 API。
后续任务 2/3/4 复用 scan_batch() 的产出。
"""
from __future__ import annotations

import secrets
import zipfile
from datetime import datetime
from pathlib import Path

ALLOWED_MAIN_EXT = ("jpg", "jpeg", "png", "webp")
MAX_PRODUCTS_PER_BATCH = 50

# 主图关键词,**按优先级从高到低**(白底图最高,因为是电商标准最高质量素材)。
# 任意子串匹配(case-insensitive),所以 "DZ70X白底图.jpg" / "main_v2.png" / "product.jpg" 都能命中。
MAIN_IMAGE_KEYWORDS: tuple[str, ...] = (
    "白底图", "白底", "主图", "main",
    "product", "cover",
    "透图", "抠图", "transparent", "cut",
)

# 细节图优先排序关键词(只影响顺序,不影响是否被收;非主图都会被当细节图)
DETAIL_IMAGE_KEYWORDS: tuple[str, ...] = (
    "效果图", "场景图", "使用图", "scene", "detail",
)

# 文案文件关键词(.txt 扩展名前提下)
DESC_KEYWORDS: tuple[str, ...] = (
    "desc", "文案", "描述",
)

DESC_EXTS = (".txt",)
SKIP_FILES = {".ds_store", "thumbs.db"}
SKIP_DIR_PREFIXES = ("__MACOSX",)


def generate_batch_id(batches_root: Path, today: datetime | None = None) -> str:
    """格式: batch_YYYYMMDD_NNN_xxxx (NNN 当天序号, xxxx 4 字符随机后缀防并发碰撞)。"""
    today = today or datetime.now()
    date_str = today.strftime("%Y%m%d")
    prefix = f"batch_{date_str}_"
    existing = [p.name for p in batches_root.glob(f"{prefix}*") if p.is_dir()]
    seq = len(existing) + 1
    suffix = secrets.token_hex(2)
    return f"{prefix}{seq:03d}_{suffix}"


def _safe_decode_zipname(raw: str, flag_bits: int) -> str:
    """zipfile 默认拿 cp437 解码非 UTF-8 名;re-encode 后试 UTF-8 → GBK → 原值。

    flag_bits bit 11 (0x800) = 1 表示原本就是 UTF-8,无需修正。
    """
    if flag_bits & 0x800:
        return raw
    try:
        return raw.encode("cp437").decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        try:
            return raw.encode("cp437").decode("gbk")
        except (UnicodeDecodeError, UnicodeEncodeError):
            return raw


def extract_zip_safe(zip_path: Path, dest_dir: Path) -> int:
    """安全解压 zip 到 dest_dir,返回解压文件数。

    防御:
    - zip slip: resolve 后必须在 dest_dir 内
    - 跳过 __MACOSX/.DS_Store/Thumbs.db
    - 中文文件名 UTF-8/GBK 兜底
    """
    dest_dir = dest_dir.resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)
    extracted = 0

    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            fixed_name = _safe_decode_zipname(info.filename, info.flag_bits)
            normalized = fixed_name.replace("\\", "/").lstrip("/")
            if not normalized:
                continue
            parts = normalized.split("/")
            if any(part in ("..", "") for part in parts):
                continue
            if parts[0] in SKIP_DIR_PREFIXES:
                continue
            if parts[-1].lower() in SKIP_FILES:
                continue

            target = (dest_dir / normalized).resolve()
            try:
                target.relative_to(dest_dir)
            except ValueError:
                continue

            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue

            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                dst.write(src.read())
            extracted += 1

    return extracted


def _visible_children(path: Path) -> list[Path]:
    return [p for p in path.iterdir() if p.name.lower() not in SKIP_FILES]


def _is_image(p: Path) -> bool:
    return p.suffix.lower().lstrip(".") in ALLOWED_MAIN_EXT


def _is_text(p: Path) -> bool:
    return p.suffix.lower() in DESC_EXTS


def _has_main_image(folder: Path) -> bool:
    """scan_batch 自动下钻判定:只要文件夹下有任一允许格式的图片就算"有主图"。

    放宽到"任意 image"是任务8.5 灵活命名要求 — 让 "DZ70X白底图.jpg" 这种也能被识别。
    """
    return any(p.is_file() and _is_image(p)
               and p.name.lower() not in SKIP_FILES
               for p in folder.iterdir())


def _pick_main_image(images: list[Path]) -> tuple[Path | None, str]:
    """主图选择:按 MAIN_IMAGE_KEYWORDS 优先级从高到低找;否则字母序首张。

    返回 (主图Path 或 None, 命中的关键词 / "字母序首张")。
    """
    if not images:
        return None, ""
    sorted_imgs = sorted(images, key=lambda p: p.name.lower())
    for kw in MAIN_IMAGE_KEYWORDS:
        kw_l = kw.lower()
        for img in sorted_imgs:
            if kw_l in img.name.lower():
                return img, kw
    return sorted_imgs[0], "字母序首张"


def _pick_desc(texts: list[Path]) -> tuple[Path | None, str]:
    """文案选择:优先匹配 DESC_KEYWORDS;否则任一 .txt(字母序首个)。

    返回 (文件Path 或 None, 命中的文件名)。
    """
    if not texts:
        return None, ""
    sorted_texts = sorted(texts, key=lambda p: p.name.lower())
    for kw in DESC_KEYWORDS:
        kw_l = kw.lower()
        for t in sorted_texts:
            if kw_l in t.name.lower():
                return t, t.name
    return sorted_texts[0], sorted_texts[0].name


def _sort_details(others: list[Path]) -> list[Path]:
    """细节图排序:有 DETAIL_IMAGE_KEYWORDS 命中的排前面,然后按文件名字母序。

    e.g. ["DZ70X透图.png", "DZ70X效果图.png"] → 效果图在前(命中"效果图")。
    """
    def rank(name: str) -> int:
        name_l = name.lower()
        for i, kw in enumerate(DETAIL_IMAGE_KEYWORDS):
            if kw.lower() in name_l:
                return i
        return len(DETAIL_IMAGE_KEYWORDS)
    return sorted(others, key=lambda p: (rank(p.name), p.name.lower()))


def parse_product_folder(folder: Path, project_root: Path) -> dict:
    """识别单个产品文件夹。

    灵活命名规则(任务8.5 升级):
    - 主图: 按关键词优先级匹配,白底图 > 主图 > main > product > cover > 透图... > 字母序首张
    - 文案: desc/文案/描述 关键词匹配,否则任一 .txt
    - 细节图: 所有非主图的图片,按"效果图/场景图..."关键词排序优先

    返回:
      ok    → status="ok", + main_image_matched_by, desc_file_matched_by 调试字段
      skip  → status="skipped", + reason
    """
    name = folder.name
    visible = [p for p in folder.iterdir()
               if p.is_file() and p.name.lower() not in SKIP_FILES]
    images = [p for p in visible if _is_image(p)]
    texts  = [p for p in visible if _is_text(p)]

    main_image, main_matched = _pick_main_image(images)
    if main_image is None:
        return {"status": "skipped", "name": name,
                "reason": "缺少图片(.jpg/.jpeg/.png/.webp 至少一张)"}

    desc_file, desc_matched = _pick_desc(texts)
    if desc_file is None:
        return {"status": "skipped", "name": name,
                "reason": "缺少文案(任一 .txt 文件)"}

    try:
        desc_text = desc_file.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        try:
            desc_text = desc_file.read_text(encoding="gbk")
        except Exception as e:
            return {"status": "skipped", "name": name,
                    "reason": f"文案编码无法识别({type(e).__name__})"}
    if not desc_text.strip():
        return {"status": "skipped", "name": name,
                "reason": f"文案文件为空 ({desc_file.name})"}

    detail_images = _sort_details([p for p in images if p != main_image])

    def _to_url(p: Path) -> str:
        # 磁盘落在 static/uploads/... 但对外 URL 仍用 /uploads/... (serve_batch_upload 代理).
        # 这里剥掉 static/ 前缀, 让 DB 里 main_image_path 存的是用户可直接访问的 URL.
        rel = str(p.resolve().relative_to(project_root.resolve())).replace("\\", "/")
        if rel.startswith("static/uploads/"):
            rel = rel[len("static/"):]
        return "/" + rel

    return {
        "status": "ok",
        "name": name,
        "main_image_path": _to_url(main_image),
        "main_image_matched_by": main_matched,         # 任务8.5: 调试字段
        "detail_image_paths": [_to_url(p) for p in detail_images],
        "desc_text": desc_text,                        # 全文(任务3 入库,任务4 喂 DeepSeek)
        "desc_chars": len(desc_text),
        "desc_preview": desc_text.strip()[:80],
        "desc_file_matched_by": desc_matched,          # 任务8.5: 调试字段
    }


def scan_batch(batch_dir: Path, project_root: Path) -> dict:
    """扫描批次目录,返回识别报告。

    自适应 zip 结构:
    - 直接结构: batch_dir/产品A, batch_dir/产品B
    - 包装结构: batch_dir/批量任务/产品A, batch_dir/批量任务/产品B
      → 若 batch_dir 仅含 1 个子目录且其下无主图,自动下钻
    """
    top_dirs = [p for p in batch_dir.iterdir()
                if p.is_dir() and p.name not in SKIP_DIR_PREFIXES]
    scan_root = batch_dir
    if len(top_dirs) == 1 and not _has_main_image(top_dirs[0]):
        scan_root = top_dirs[0]

    product_dirs = sorted([p for p in scan_root.iterdir()
                           if p.is_dir()
                           and p.name not in SKIP_DIR_PREFIXES
                           and _visible_children(p)])

    products: list[dict] = []
    skipped: list[dict] = []
    for d in product_dirs:
        result = parse_product_folder(d, project_root)
        if result["status"] == "ok":
            products.append(result)
        else:
            skipped.append({"name": result["name"], "reason": result["reason"]})

    return {
        "scan_root": "/" + str(scan_root.resolve().relative_to(project_root.resolve())).replace("\\", "/"),
        "total_folders": len(product_dirs),
        "valid_count": len(products),
        "skipped_count": len(skipped),
        "products": products,
        "skipped": skipped,
    }
