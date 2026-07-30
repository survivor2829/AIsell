"""生成一个测试用的批量上传 zip。

用法:
    python scripts/make_test_batch_zip.py
    python scripts/make_test_batch_zip.py --out my_batch.zip --no-wrapper

预期识别结果:
    valid  = 3  (产品A / 产品B / 产品C)
    skipped = 2 (产品D 缺主图 / 产品E 缺文案)
"""
from __future__ import annotations

import argparse
import io
import zipfile
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    raise SystemExit("请先安装 Pillow: pip install pillow")


def _img_bytes(color: tuple[int, int, int],
               size: tuple[int, int] = (512, 512),
               fmt: str = "JPEG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format=fmt)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="test_batch.zip", help="输出 zip 路径")
    ap.add_argument("--no-wrapper", action="store_true",
                    help="不加 '批量任务/' 包装层（直接产品文件夹在 zip 根）")
    args = ap.parse_args()

    prefix = "" if args.no_wrapper else "批量任务/"
    out = Path(args.out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        # 产品A：完整（主图 + 2 张细节图 + 文案）
        z.writestr(f"{prefix}产品A/product.jpg", _img_bytes((220, 50, 50)))
        z.writestr(f"{prefix}产品A/product_2.jpg", _img_bytes((50, 220, 50)))
        z.writestr(f"{prefix}产品A/product_3.jpg", _img_bytes((50, 50, 220)))
        z.writestr(
            f"{prefix}产品A/desc.txt",
            "工业洗地机X1 工作宽度 620mm 续航 8 小时 清水箱 60L\n"
            "适用商场超市，效率 3600㎡/h。\n"
        )

        # 产品B：最简（只有主图 + 文案）
        z.writestr(f"{prefix}产品B/product.jpg", _img_bytes((100, 200, 100)))
        z.writestr(f"{prefix}产品B/desc.txt",
                   "便携扫地机B 续航 4 小时 重量 5kg 适用办公区域。")

        # 产品C：PNG 主图 + 1 张细节图
        z.writestr(f"{prefix}产品C/product.png",
                   _img_bytes((180, 100, 200), fmt="PNG"))
        z.writestr(f"{prefix}产品C/product_2.jpg",
                   _img_bytes((200, 180, 100)))
        z.writestr(f"{prefix}产品C/desc.txt",
                   "高压清洗机C 压力 150 bar 流量 500L/h 重量 28kg。")

        # 产品D：缺主图（图片名错误）→ 应跳过
        z.writestr(f"{prefix}产品D/photo.jpg", _img_bytes((50, 50, 50)))
        z.writestr(f"{prefix}产品D/desc.txt", "命名错误的产品。")

        # 产品E：缺文案（文件名错误）→ 应跳过
        z.writestr(f"{prefix}产品E/product.jpg", _img_bytes((255, 200, 0)))
        z.writestr(f"{prefix}产品E/notes.txt", "文案文件名不对。")

        # 噪音文件 → 应被静默忽略
        z.writestr("__MACOSX/产品A/._product.jpg", b"\x00" * 16)
        z.writestr(f"{prefix}产品A/.DS_Store", b"\x00" * 16)

    abs_path = out.resolve()
    print(f"[OK] 已生成 {abs_path}")
    print(f"     预期识别：3 个产品成功 / 2 个跳过")
    print(f"     curl 测试：")
    print(f'       curl -X POST -F "file=@{out.name}" '
          f'-F "batch_name=测试批次" http://localhost:5000/api/batch/upload')


if __name__ == "__main__":
    main()
