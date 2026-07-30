"""Task 6 冒烟: /batch/history 和 /api/batches 的 user 过滤.

验证:
  1. 未登录访问 /batch/history → 302 (login_required)
  2. 登录后 /batch/history → 200, 含 '历史批次' 标题
  3. /api/batches 返回 JSON, 只含当前 user 的批次 + legacy 无主批次
  4. upload.html 顶栏含 '历史批次' 链接
  5. 不带实际 DB 也能跑 (用临时 sqlite)
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

db_path = (ROOT / "instance" / "smoke_task6.db").as_posix()
os.makedirs(os.path.dirname(db_path), exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"
os.environ["FLASK_ENV"] = "development"
os.environ["SECRET_KEY"] = "smoke-test-secret-key-for-task6"
os.environ.pop("HTTP_PROXY", None)

# 清理前一次
try:
    os.remove(db_path)
except OSError:
    pass

import app as app_mod  # noqa: E402
from models import db, User, Batch  # noqa: E402

flask_app = app_mod.app
flask_app.config["TESTING"] = True
flask_app.config["WTF_CSRF_ENABLED"] = False  # 只测路由逻辑


def test():
    with flask_app.app_context():
        # 建 2 个 user, 各 1 个 batch, 加 1 个 legacy batch
        u1 = User(username="alice", password_hash="x", is_approved=True)
        u2 = User(username="bob", password_hash="x", is_approved=True)
        db.session.add_all([u1, u2])
        db.session.commit()
        b1 = Batch(batch_id="b-alice-01", name="Alice 的批次", raw_name="a",
                   user_id=u1.id, batch_dir="/tmp/a", total_count=2, valid_count=2)
        b2 = Batch(batch_id="b-bob-01", name="Bob 的批次", raw_name="b",
                   user_id=u2.id, batch_dir="/tmp/b", total_count=3, valid_count=3)
        b_legacy = Batch(batch_id="b-legacy-01", name="无主历史批次",
                         raw_name="l", user_id=None, batch_dir="/tmp/l",
                         total_count=1, valid_count=1)
        db.session.add_all([b1, b2, b_legacy])
        db.session.commit()

    client = flask_app.test_client()

    # 1. 未登录访问 → 302
    r = client.get("/batch/history", follow_redirects=False)
    assert r.status_code in (302, 401), f"未登录应 302/401, 实际 {r.status_code}"
    print(f"✓ /batch/history 未登录 → {r.status_code}")

    # 2. 登录为 alice
    with client.session_transaction() as sess:
        sess["_user_id"] = "1"  # alice
        sess["_fresh"] = True
    r = client.get("/batch/history")
    assert r.status_code == 200, f"200 预期, 实际 {r.status_code}: {r.data[:200]}"
    html = r.data.decode("utf-8")
    assert "历史批次" in html, "缺页面标题"
    assert "Alice 的批次" in html, "alice 自己的批次应可见"
    assert "无主历史批次" in html, "legacy 批次应可见 (与 /api/batches 策略一致)"
    assert "Bob 的批次" not in html, "不应看见 Bob 的批次"
    print("✓ alice 登录 → 只见 alice + legacy, 不见 Bob")

    # 3. /api/batches 过滤
    r = client.get("/api/batches")
    assert r.status_code == 200
    data = r.get_json()
    ids = [b["batch_id"] for b in data["batches"]]
    assert "b-alice-01" in ids
    assert "b-legacy-01" in ids
    assert "b-bob-01" not in ids, f"跨用户泄露! 返回 {ids}"
    print(f"✓ /api/batches 返回 {ids}, 无跨用户泄露")

    # 4. upload.html 顶栏链接
    r = client.get("/batch/upload")
    assert r.status_code == 200
    assert "/batch/history" in r.data.decode("utf-8")
    print("✓ upload.html 顶栏有 /batch/history 链接")

    print("\n== Task 6 smoke PASSED ==")


try:
    test()
finally:
    try:
        os.remove(db_path)
    except OSError:
        pass
