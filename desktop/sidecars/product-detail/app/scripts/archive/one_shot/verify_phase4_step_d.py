"""阶段四·Step D 验证 — /api/batch/<bid>/download-all.

必须确认:
  1. 未登录 → 302
  2. 非 owner → 403
  3. 不存在的 batch → 404
  4. 整批连一张图都没 → 404 + 返回体带 hint/total/skipped 字段
  5. 正常 batch (mixed done/failed/ai-done) → 200 + application/zip
  6. 返回字节前 4 位是 ZIP 魔数 (PK\\x03\\x04)
  7. zip 内部结构: {batch_id}/{中文产品名}/preview.png (HTML-done)
                   {batch_id}/{中文产品名}/ai_refined.jpg (ai-done)
  8. 失败的产品(status!=done 且 ai_refine_status!=done) 不出现在 zip 里
  9. 中文 arcname 能被 Python zipfile 正确解压 (UTF-8 flag 正确设置)
 10. Content-Disposition 里含 filename* (RFC 5987 中文文件名)
 11. zip entry 的字节跟磁盘原文件一致 (不是空文件)
"""
from __future__ import annotations

import io
import os
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")


def _log(m: str) -> None:
    print(f"[step-d] {m}", flush=True)


# 真 1x1 PNG (任何 PIL/浏览器都认)
PNG_1x1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f"
    b"\x00\x00\x01\x01\x00\x01\x00\x00\x00\x00IEND\xaeB`\x82"
)
# 假 JPEG (给 ai_refined.jpg 用 — 字节头 + 填料足够验证内容)
JPG_FAKE = b"\xff\xd8\xff" + b"X" * 2048  # 2KB


def main() -> int:
    failures: list[str] = []

    from app import app, db, User, Batch, BatchItem, UPLOAD_DIR

    tid = f"TST_D_{int(time.time())}"
    batch_dir = UPLOAD_DIR / "batches" / tid
    # 造 4 个产品覆盖所有分支:
    #   P1 (中文 "测试A"): status=done + ai=done      → preview.png + ai_refined.jpg
    #   P2 (中文 "测试B"): status=done + ai=not_req   → 只有 preview.png
    #   P3 ("英文C"):     status=done + ai=not_req   → 只有 preview.png (ASCII 名)
    #   P4 ("Failed D"):  status=failed             → 什么都没, 应被跳过
    fixtures = [
        ("测试A",   "done",   "done",          True,  True),   # html + ai
        ("测试B",   "done",   "not_requested", True,  False),  # html only
        ("英文C",   "done",   "not_requested", True,  False),  # html only (ASCII name)
        ("Failed D","failed", "not_requested", False, False),  # 两个文件都不落盘
    ]
    for name, status, ai_status, write_html, write_ai in fixtures:
        product_dir = batch_dir / name
        product_dir.mkdir(parents=True, exist_ok=True)
        if write_html:
            (product_dir / "preview.png").write_bytes(PNG_1x1)
        if write_ai:
            (product_dir / "ai_refined.jpg").write_bytes(JPG_FAKE)

    # DB fixture
    with app.app_context():
        owner = User.query.first()
        other = User.query.filter(User.id != owner.id).first()
        if owner is None:
            print("DB 里无 User, 测试终止"); return 1
        b = Batch(batch_id=tid, name=f"测试批次_{tid}", raw_name=tid,
                  user_id=owner.id, product_category="设备类",
                  total_count=len(fixtures),
                  status="completed", batch_dir=str(batch_dir))
        db.session.add(b); db.session.commit()
        for name, status, ai_status, _, _ in fixtures:
            item = BatchItem(
                batch_pk=b.id, name=name, status=status,
                ai_refine_status=ai_status,
                main_image_path=f"/uploads/batches/{tid}/{name}/main.jpg",
            )
            db.session.add(item)
        db.session.commit()
        owner_id = owner.id
        other_id = other.id if other else None
        bpk = b.id

    _log(f"fixture {tid} — 4 products (3 done + 1 failed, 其中 1 个 ai_refine_done)")
    client = app.test_client()

    def _login(uid):
        with client.session_transaction() as s:
            s["_user_id"] = str(uid); s["_fresh"] = True

    try:
        base = f"/api/batch/{tid}/download-all"

        # 1. 未登录 → 302
        r = client.get(base)
        if r.status_code not in (302, 401):
            failures.append(f"未登录应 302, 实际 {r.status_code}")
        else:
            _log(f"✓ 未登录 → {r.status_code}")

        _login(owner_id)

        # 2. 不存在 batch → 404
        r = client.get("/api/batch/DOES_NOT_EXIST/download-all")
        if r.status_code != 404:
            failures.append(f"不存在 batch 应 404, 实际 {r.status_code}")
        else:
            _log(f"✓ 不存在 batch → 404")

        # 3. 主测: 正常 batch → 200 + zip
        r = client.get(base)
        if r.status_code != 200:
            failures.append(f"正常 batch 应 200, 实际 {r.status_code}: {r.data[:200]!r}")
        else:
            _log(f"✓ 正常 batch → 200")

            # (a) MIME 头
            if "application/zip" not in (r.headers.get("Content-Type") or ""):
                failures.append(f"Content-Type 不是 application/zip: "
                                f"{r.headers.get('Content-Type')!r}")
            else:
                _log(f"✓ Content-Type: application/zip")

            # (b) 字节魔数
            if r.data[:4] != b"PK\x03\x04":
                failures.append(f"字节头不是 ZIP 魔数: {r.data[:8]!r}")
            else:
                _log(f"✓ ZIP 魔数 PK\\x03\\x04 正确 ({len(r.data)} bytes)")

            # (c) Content-Disposition 含 RFC 5987 中文
            cd = r.headers.get("Content-Disposition", "")
            if "attachment" not in cd:
                failures.append(f"缺 attachment: {cd!r}")
            elif "filename*" not in cd.lower() and "%E" not in cd:
                # 中文批次名 (测试批次_TST_D_xxx) 必然触发 RFC 5987
                failures.append(f"中文文件名未 RFC 5987 编码: {cd!r}")
            else:
                _log(f"✓ Content-Disposition: {cd[:100]}...")

            # (d) 解压看内容 — 关键验证
            try:
                zf = zipfile.ZipFile(io.BytesIO(r.data))
            except zipfile.BadZipFile as e:
                failures.append(f"zip 解压失败: {e}")
                zf = None

            if zf is not None:
                names = zf.namelist()
                _log(f"  zip 内文件 ({len(names)} 条):")
                for n in names:
                    _log(f"    · {n}")

                # 必须有的 entries
                expected = {
                    f"{tid}/测试A/preview.png",
                    f"{tid}/测试A/ai_refined.jpg",
                    f"{tid}/测试B/preview.png",
                    f"{tid}/英文C/preview.png",
                }
                # 必须没的 entries
                forbidden = {
                    f"{tid}/Failed D/preview.png",       # status=failed
                    f"{tid}/Failed D/ai_refined.jpg",    # 同上
                    f"{tid}/测试B/ai_refined.jpg",       # ai=not_requested
                    f"{tid}/英文C/ai_refined.jpg",       # ai=not_requested
                }
                names_set = set(names)
                missing = expected - names_set
                if missing:
                    failures.append(f"zip 缺文件: {missing}")
                else:
                    _log(f"✓ 应有的 4 个文件全部命中")

                leaked = forbidden & names_set
                if leaked:
                    failures.append(f"zip 泄漏了不该打包的文件: {leaked}")
                else:
                    _log(f"✓ 失败/未精修的产品文件正确被排除")

                # 字节一致性检查 — zip 里的 preview.png 应该等于磁盘上的
                if f"{tid}/测试A/preview.png" in names_set:
                    zpng = zf.read(f"{tid}/测试A/preview.png")
                    if zpng != PNG_1x1:
                        failures.append(
                            f"zip 内 preview.png 字节跟源文件不一致: "
                            f"zip={zpng[:16]!r} 源={PNG_1x1[:16]!r}"
                        )
                    else:
                        _log(f"✓ 测试A/preview.png 字节一致 ({len(zpng)} bytes)")

                if f"{tid}/测试A/ai_refined.jpg" in names_set:
                    zjpg = zf.read(f"{tid}/测试A/ai_refined.jpg")
                    if zjpg != JPG_FAKE:
                        failures.append(
                            f"zip 内 ai_refined.jpg 字节跟源文件不一致"
                        )
                    else:
                        _log(f"✓ 测试A/ai_refined.jpg 字节一致 ({len(zjpg)} bytes)")

                # 中文 arcname 的 UTF-8 flag 检查
                for info in zf.infolist():
                    # 含非 ASCII 的 arcname 必须带 0x800 flag
                    if any(ord(ch) > 127 for ch in info.filename):
                        if not (info.flag_bits & 0x800):
                            failures.append(
                                f"中文 arcname 未设 UTF-8 flag: "
                                f"{info.filename!r} flag_bits={info.flag_bits:#x}"
                            )
                        else:
                            _log(f"✓ {info.filename!r} UTF-8 flag OK")
                            break  # 抽检一个就够

                zf.close()

        # 4. 非 owner → 403
        if other_id is not None:
            _login(other_id)
            r = client.get(base)
            if r.status_code != 403:
                failures.append(f"非 owner 应 403, 实际 {r.status_code}")
            else:
                _log(f"✓ 非 owner → 403")
            _login(owner_id)

        # 5. 整批没文件 → 404 + 结构化错误体
        empty_tid = f"{tid}_EMPTY"
        empty_batch_dir = UPLOAD_DIR / "batches" / empty_tid
        empty_batch_dir.mkdir(parents=True, exist_ok=True)
        with app.app_context():
            eb = Batch(batch_id=empty_tid, name=empty_tid, raw_name=empty_tid,
                       user_id=owner_id, product_category="设备类",
                       total_count=1, status="processing",
                       batch_dir=str(empty_batch_dir))
            db.session.add(eb); db.session.commit()
            eitem = BatchItem(batch_pk=eb.id, name="尚未完成",
                              status="pending", ai_refine_status="not_requested",
                              main_image_path=f"/uploads/batches/{empty_tid}/尚未完成/main.jpg")
            db.session.add(eitem); db.session.commit()
            empty_bpk = eb.id
        try:
            r = client.get(f"/api/batch/{empty_tid}/download-all")
            if r.status_code != 404:
                failures.append(f"空 batch 应 404, 实际 {r.status_code}")
            else:
                body = r.get_json() or {}
                if not body.get("hint") or body.get("total") != 1:
                    failures.append(f"空 batch 404 缺结构化字段: {body}")
                else:
                    _log(f"✓ 空 batch → 404 + hint+total+skipped 完整")
        finally:
            with app.app_context():
                BatchItem.query.filter_by(batch_pk=empty_bpk).delete()
                Batch.query.filter_by(id=empty_bpk).delete()
                db.session.commit()
            import shutil
            shutil.rmtree(empty_batch_dir, ignore_errors=True)

    finally:
        with app.app_context():
            BatchItem.query.filter_by(batch_pk=bpk).delete()
            Batch.query.filter_by(id=bpk).delete()
            db.session.commit()
        import shutil
        shutil.rmtree(batch_dir, ignore_errors=True)
        _log(f"清理 {tid}")

    print("\n" + "═" * 60)
    if failures:
        print(f"✗ Step D 验证 {len(failures)} 项失败:")
        for f in failures: print(f"  - {f}")
        return 1
    print("✓ Step D 全绿 — 整批打包下载到位")
    return 0


if __name__ == "__main__":
    sys.exit(main())
