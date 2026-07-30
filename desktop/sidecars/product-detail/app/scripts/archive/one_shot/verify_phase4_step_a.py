"""阶段四·Step A 验证 — /uploads/batches/<bid>/<path> 代理端点.

必须确认:
  1. 修好的端点能返图 (200 + 实际字节)
  2. 同路径以前 404 → 现在 200 (回归保护)
  3. 未登录 → 302
  4. 非 owner → 403
  5. path traversal → 404 (safe_join 拦住 ../)
  6. 不存在文件 → 404
  7. 中文路径 + 嵌套子目录 (DZ70X新品1/DZ70X白底图.jpg 这种真实形态) 能通

用真磁盘 fixture (不污染生产批次, 测完清理).
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

def _log(m: str) -> None:
    print(f"[step-a] {m}", flush=True)


def main() -> int:
    failures: list[str] = []

    from app import app, db, User, Batch, UPLOAD_DIR

    # 准备真磁盘 fixture — 模拟生产里中文嵌套结构
    tid = f"TST_A_{int(time.time())}"
    batch_dir = UPLOAD_DIR / "batches" / tid
    product_dir = batch_dir / "测试" / "DZ70X新品1"
    product_dir.mkdir(parents=True, exist_ok=True)
    img_path = product_dir / "DZ70X白底图.jpg"
    # 真 1x1 PNG (浏览器能识别的最小 PNG)
    png_1x1 = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f"
        b"\x00\x00\x01\x01\x00\x01\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    img_path.write_bytes(png_1x1)
    rel_url = f"/uploads/batches/{tid}/测试/DZ70X新品1/DZ70X白底图.jpg"

    # DB fixture
    with app.app_context():
        owner = User.query.first()
        other = User.query.filter(User.id != owner.id).first()
        if owner is None:
            print("DB 里无 User, 测试终止"); return 1
        b = Batch(batch_id=tid, name=tid, raw_name=tid, user_id=owner.id,
                  product_category="设备类", total_count=1,
                  status="completed", batch_dir=str(batch_dir))
        db.session.add(b); db.session.commit()
        owner_id, other_id, bpk = owner.id, (other.id if other else None), b.id
    _log(f"fixture {tid} — {rel_url}")

    client = app.test_client()
    try:
        # 1. 未登录 → 302
        r = client.get(rel_url)
        if r.status_code not in (302, 401):
            failures.append(f"未登录应 302/401, 实际 {r.status_code}")
        else:
            _log(f"✓ 未登录 → {r.status_code}")

        # 2. 登录 owner → 200 + 真 PNG 字节
        with client.session_transaction() as s:
            s["_user_id"] = str(owner_id); s["_fresh"] = True
        r = client.get(rel_url)
        if r.status_code != 200:
            failures.append(f"owner 应 200, 实际 {r.status_code}: {r.data[:200]!r}")
        elif r.data[:8] != b"\x89PNG\r\n\x1a\n":
            failures.append(f"返回不是 PNG 字节头: {r.data[:16]!r}")
        else:
            # Content-Type 是否对头
            ct = r.headers.get("Content-Type", "")
            _log(f"✓ owner GET → 200, PNG 头 OK, Content-Type={ct}, bytes={len(r.data)}")

        # 3. 以前被 404 的那条 URL (中文+嵌套) 现在能 304/200 (命中缓存时 304)
        r2 = client.get(rel_url, headers={"If-Modified-Since": r.headers.get("Last-Modified", "")})
        if r2.status_code not in (200, 304):
            failures.append(f"条件 GET 应 200/304, 实际 {r2.status_code}")
        else:
            _log(f"✓ 条件 GET → {r2.status_code} (缩略图多次加载不重传)")

        # 4. 非 owner → 403
        if other_id is not None:
            with client.session_transaction() as s:
                s["_user_id"] = str(other_id); s["_fresh"] = True
            r = client.get(rel_url)
            if r.status_code != 403:
                failures.append(f"非 owner 应 403, 实际 {r.status_code}")
            else:
                _log("✓ 非 owner → 403")
            with client.session_transaction() as s:
                s["_user_id"] = str(owner_id); s["_fresh"] = True

        # 5. path traversal → 404 (safe_join 拦住)
        bad_url = f"/uploads/batches/{tid}/../../../etc/passwd"
        r = client.get(bad_url)
        if r.status_code not in (404, 400):
            failures.append(f"traversal 应 404/400, 实际 {r.status_code}")
        else:
            _log(f"✓ path traversal → {r.status_code}")

        # 6. 不存在文件 → 404
        r = client.get(f"/uploads/batches/{tid}/no-such-file.jpg")
        if r.status_code != 404:
            failures.append(f"不存在文件应 404, 实际 {r.status_code}")
        else:
            _log("✓ 不存在文件 → 404")

        # 7. 不存在 batch → 404 (_check_batch_owner 挡住)
        r = client.get(f"/uploads/batches/DOES_NOT_EXIST/x.jpg")
        if r.status_code != 404:
            failures.append(f"不存在 batch 应 404, 实际 {r.status_code}")
        else:
            _log("✓ 不存在 batch → 404")

    finally:
        # 清理 fixture (db + 磁盘)
        with app.app_context():
            Batch.query.filter_by(id=bpk).delete()
            db.session.commit()
        import shutil
        shutil.rmtree(batch_dir, ignore_errors=True)
        _log(f"清理 {tid}")

    print("\n" + "═" * 60)
    if failures:
        print(f"✗ Step A 验证 {len(failures)} 项失败:")
        for f in failures: print(f"  - {f}")
        return 1
    print("✓ Step A 全绿 — /uploads/batches/ 代理 + owner 校验 + 安全防护 全到位")
    return 0


if __name__ == "__main__":
    sys.exit(main())
