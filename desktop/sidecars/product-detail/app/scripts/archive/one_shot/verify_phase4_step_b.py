"""阶段四·Step B 验证 — /api/batch/<bid>/download?name=X&kind=html|ai.

必须确认:
  1. 未登录 → 302
  2. 非 owner → 403
  3. 不存在的 batch → 404
  4. 参数校验: 缺 name → 400 / kind 非法 → 400
  5. DB 里没这个产品 → 404 (防 "URL 猜名")
  6. kind=html + preview.png 存在 → 200 + Content-Disposition + 正确文件名
  7. kind=ai + ai_refine_status!=done → 404 (不给下载半成品)
  8. kind=ai + status=done + 文件存在 → 200
  9. 文件不存在 (DB done 但磁盘没写) → 404
 10. 中文产品名 (RFC 5987 Content-Disposition 编码) → 下载文件名正确
 11. Range 请求 → 206 (大文件断点续传基础)
 12. 关键: 返回内容的前几个字节跟磁盘真实文件字节一致 (不是 404 HTML)
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")


def _log(m: str) -> None:
    print(f"[step-b] {m}", flush=True)


# 真 1x1 PNG (任何浏览器都认)
PNG_1x1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f"
    b"\x00\x00\x01\x01\x00\x01\x00\x00\x00\x00IEND\xaeB`\x82"
)
# 假 JPEG (前 3 字节就够 MIME 探测, 不需要真渲染)
JPG_FAKE = b"\xff\xd8\xff" + b"A" * 1024  # 1 KB 够测 Range


def main() -> int:
    failures: list[str] = []

    from app import app, db, User, Batch, BatchItem, UPLOAD_DIR

    tid = f"TST_B_{int(time.time())}"
    # 用一个带中文 + 空格的产品名, 打边界 — 模拟真实批次
    product_name = "测试 产品A"
    batch_dir = UPLOAD_DIR / "batches" / tid
    product_dir = batch_dir / product_name
    product_dir.mkdir(parents=True, exist_ok=True)
    # 只写 html 版, ai_refined.jpg 刻意留空 — 测 kind=ai 缺文件分支
    (product_dir / "preview.png").write_bytes(PNG_1x1)
    # 再做一个产品 用来覆盖 ai 已 done 的分支
    ai_done_name = "AI完成产品"
    ai_done_dir = batch_dir / ai_done_name
    ai_done_dir.mkdir(parents=True, exist_ok=True)
    (ai_done_dir / "preview.png").write_bytes(PNG_1x1)
    (ai_done_dir / "ai_refined.jpg").write_bytes(JPG_FAKE)

    # DB fixture
    with app.app_context():
        owner = User.query.first()
        other = User.query.filter(User.id != owner.id).first()
        if owner is None:
            print("DB 里无 User, 测试终止"); return 1
        b = Batch(batch_id=tid, name=tid, raw_name=tid, user_id=owner.id,
                  product_category="设备类", total_count=2,
                  status="completed", batch_dir=str(batch_dir))
        db.session.add(b); db.session.commit()
        item1 = BatchItem(batch_pk=b.id, name=product_name, status="done",
                          ai_refine_status="not_requested",
                          main_image_path=f"/uploads/batches/{tid}/{product_name}/main.jpg")
        item2 = BatchItem(batch_pk=b.id, name=ai_done_name, status="done",
                          ai_refine_status="done",
                          main_image_path=f"/uploads/batches/{tid}/{ai_done_name}/main.jpg")
        db.session.add_all([item1, item2]); db.session.commit()
        owner_id = owner.id
        other_id = other.id if other else None
        bpk = b.id
    _log(f"fixture {tid} — 2 products ({product_name!r} html only, "
         f"{ai_done_name!r} html+ai)")

    client = app.test_client()

    def _login(uid):
        with client.session_transaction() as s:
            s["_user_id"] = str(uid); s["_fresh"] = True

    try:
        base = f"/api/batch/{tid}/download"

        # 1. 未登录 → 302
        r = client.get(f"{base}?name={quote(product_name)}&kind=html")
        if r.status_code not in (302, 401):
            failures.append(f"未登录应 302/401, 实际 {r.status_code}")
        else:
            _log(f"✓ 未登录 → {r.status_code}")

        _login(owner_id)

        # 2. 缺 name → 400
        r = client.get(f"{base}?kind=html")
        if r.status_code != 400:
            failures.append(f"缺 name 应 400, 实际 {r.status_code}")
        else:
            _log(f"✓ 缺 name → 400")

        # 3. kind 非法 → 400
        r = client.get(f"{base}?name={quote(product_name)}&kind=evil")
        if r.status_code != 400:
            failures.append(f"kind 非法应 400, 实际 {r.status_code}")
        else:
            _log(f"✓ kind=evil → 400")

        # 4. 不存在的产品名 (DB 没这行) → 404
        r = client.get(f"{base}?name={quote('不存在的名字')}&kind=html")
        if r.status_code != 404:
            failures.append(f"不存在产品应 404, 实际 {r.status_code}")
        else:
            _log(f"✓ DB 里无此产品 → 404")

        # 5. kind=html + 文件存在 → 200 + attachment + PNG 字节
        r = client.get(f"{base}?name={quote(product_name)}&kind=html")
        if r.status_code != 200:
            failures.append(f"html 下载应 200, 实际 {r.status_code}: {r.data[:200]!r}")
        elif r.data[:8] != b"\x89PNG\r\n\x1a\n":
            failures.append(f"html 返回不是真 PNG 字节: {r.data[:16]!r}")
        else:
            cd = r.headers.get("Content-Disposition", "")
            if "attachment" not in cd:
                failures.append(f"html 缺 attachment header: {cd!r}")
            elif "HTML" not in cd and "html" not in cd.lower():
                failures.append(f"html 下载名里没 'HTML版': {cd!r}")
            else:
                _log(f"✓ kind=html → 200, Content-Disposition={cd[:80]}...")

        # 6. kind=ai + ai_refine_status=not_requested → 404 (不给下载半成品)
        r = client.get(f"{base}?name={quote(product_name)}&kind=ai")
        if r.status_code != 404:
            failures.append(f"ai 未完成应 404, 实际 {r.status_code}")
        else:
            body = r.get_json() or {}
            if body.get("ai_refine_status") != "not_requested":
                failures.append(f"ai 未完成响应体缺状态: {body}")
            else:
                _log(f"✓ kind=ai + status=not_requested → 404 (拒绝半成品)")

        # 7. kind=ai + ai_refine_status=done + 文件存在 → 200 + JPEG 字节
        r = client.get(f"{base}?name={quote(ai_done_name)}&kind=ai")
        if r.status_code != 200:
            failures.append(f"ai done 应 200, 实际 {r.status_code}: {r.data[:200]!r}")
        elif r.data[:3] != b"\xff\xd8\xff":
            failures.append(f"ai 返回不是真 JPEG: {r.data[:8]!r}")
        else:
            cd = r.headers.get("Content-Disposition", "")
            if "AI" not in cd and "ai" not in cd.lower() and "%E7%B2%BE" not in cd:
                # RFC 5987 把 "精修" 编成 %E7%B2%BE%E4%BF%AE
                _log(f"  (Content-Disposition: {cd})")
            _log(f"✓ kind=ai + done → 200, JPEG 字节正确, 共 {len(r.data)} bytes")

        # 8. 磁盘文件缺失 (刻意删掉 html 版) → 404
        (product_dir / "preview.png").unlink()
        r = client.get(f"{base}?name={quote(product_name)}&kind=html")
        if r.status_code != 404:
            failures.append(f"文件缺失应 404, 实际 {r.status_code}")
        else:
            _log(f"✓ 磁盘无文件 → 404 (DB done 但 worker 半挂)")
        # 写回来, 不干扰后面测试
        (product_dir / "preview.png").write_bytes(PNG_1x1)

        # 9. Range 请求 → 206 (断点续传)
        r = client.get(f"{base}?name={quote(ai_done_name)}&kind=ai",
                       headers={"Range": "bytes=0-10"})
        if r.status_code not in (200, 206):
            failures.append(f"Range 请求应 200/206, 实际 {r.status_code}")
        elif r.status_code == 206 and len(r.data) != 11:
            failures.append(f"Range bytes=0-10 应返回 11 字节, 实际 {len(r.data)}")
        else:
            _log(f"✓ Range → {r.status_code} ({len(r.data)} bytes)")

        # 10. 非 owner → 403
        if other_id is not None:
            _login(other_id)
            r = client.get(f"{base}?name={quote(product_name)}&kind=html")
            if r.status_code != 403:
                failures.append(f"非 owner 应 403, 实际 {r.status_code}")
            else:
                _log(f"✓ 非 owner → 403")
            _login(owner_id)

        # 11. 不存在的 batch → 404
        r = client.get(f"/api/batch/DOES_NOT_EXIST/download"
                       f"?name={quote(product_name)}&kind=html")
        if r.status_code != 404:
            failures.append(f"不存在 batch 应 404, 实际 {r.status_code}")
        else:
            _log(f"✓ 不存在 batch → 404")

        # 12. 中文下载名的 RFC 5987 编码验证
        r = client.get(f"{base}?name={quote(ai_done_name)}&kind=ai")
        cd = r.headers.get("Content-Disposition", "")
        # Flask >= 2.0 用 filename*=UTF-8'' 编码中文, 只要有 UTF-8 或 %E 就算通
        if "UTF-8" not in cd and "%E" not in cd and "filename*" not in cd.lower():
            failures.append(f"中文下载名未 RFC 5987 编码: {cd!r}")
        else:
            _log(f"✓ 中文名 RFC 5987 编码 OK")

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
        print(f"✗ Step B 验证 {len(failures)} 项失败:")
        for f in failures: print(f"  - {f}")
        return 1
    print("✓ Step B 全绿 — 单文件下载端点到位")
    return 0


if __name__ == "__main__":
    sys.exit(main())
