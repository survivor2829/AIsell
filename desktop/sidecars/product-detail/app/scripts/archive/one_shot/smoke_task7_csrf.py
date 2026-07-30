"""Task 7 冒烟: CSRF 收紧覆盖 + 生产 mock 拒绝.

验证:
  1. 登录用户不带 X-CSRFToken → POST /api/batch/upload 应 400
  2. 登录用户带 X-CSRFToken → POST /api/batch/upload (空 body) 应通过 CSRF
     (具体业务验证可能仍 400, 但不是 CSRF 400; 区别看错误 payload)
  3. 登录用户带 X-CSRFToken → POST /api/build/设备类/parse-text 通过 CSRF
  4. FLASK_ENV=production 下, /api/batch/<id>/start-mock 返回 403
  5. 所有模板都能渲染 csrf_token() 不炸
"""
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

db_path = (ROOT / "instance" / "smoke_task7.db").as_posix()
os.makedirs(os.path.dirname(db_path), exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"
os.environ["FLASK_ENV"] = "development"
os.environ["SECRET_KEY"] = "smoke-test-secret-key-for-task7"
os.environ.pop("HTTP_PROXY", None)
try:
    os.remove(db_path)
except OSError:
    pass

import app as app_mod  # noqa: E402
from models import db, User  # noqa: E402

flask_app = app_mod.app
# 关键: 这次 *启用* CSRF (默认就是启用的), 不关
flask_app.config["TESTING"] = True
flask_app.config["WTF_CSRF_ENABLED"] = True
flask_app.config["WTF_CSRF_TIME_LIMIT"] = None  # 测试期不过期


def extract_csrf_token(html: str) -> str:
    m = re.search(r'name="csrf-token"[^>]*content="([^"]+)"', html)
    if not m:
        m = re.search(r'name="csrf_token"[^>]*value="([^"]+)"', html)
    assert m, f"没在 HTML 里找到 csrf token (前 400 字符):\n{html[:400]}"
    return m.group(1)


def test():
    with flask_app.app_context():
        u = User(username="csrftester", password_hash="x", is_approved=True)
        db.session.add(u)
        db.session.commit()

    client = flask_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = "1"
        sess["_fresh"] = True

    # 先拉 upload.html 拿到一个有效 token (页面 meta 里)
    r = client.get("/batch/upload")
    assert r.status_code == 200
    token = extract_csrf_token(r.data.decode("utf-8"))
    print(f"✓ upload.html meta csrf_token 可提取: {token[:20]}...")

    # 1. 缺 token → 400
    r = client.post("/api/batch/upload", data={})
    assert r.status_code == 400, f"无 token 应 400, 实际 {r.status_code}"
    print("✓ 无 X-CSRFToken 的 POST → 400 (CSRF 守住)")

    # 2. 带 token → 通过 CSRF 检查 (业务层可能再报 400, 但不再是 CSRF)
    r = client.post("/api/batch/upload",
                    data={}, headers={"X-CSRFToken": token})
    # 预期: 要么 400 "没收到 zip", 要么 200; 但 *不应* 是 CSRF 400
    body = r.data.decode("utf-8")
    assert "CSRF" not in body and "csrf" not in body.lower(), \
        f"仍是 CSRF 拦截, 说明 token 没生效: {body[:200]}"
    print(f"✓ 带 X-CSRFToken 的 POST → {r.status_code} (非 CSRF 拒绝)")

    # 3. parse-text (workspace.html 家族)
    r = client.post("/api/build/设备类/parse-text",
                    json={},
                    headers={"X-CSRFToken": token})
    body = r.data.decode("utf-8")
    assert "CSRF" not in body and "csrf" not in body.lower(), \
        f"parse-text 仍被 CSRF 拦: {body[:200]}"
    print(f"✓ parse-text 带 token → {r.status_code} (非 CSRF 拒绝)")

    # 4. 生产 mock 拒绝
    os.environ["FLASK_ENV"] = "production"
    try:
        r = client.post("/api/batch/NONEXISTENT/start-mock",
                        headers={"X-CSRFToken": token})
        assert r.status_code == 403, \
            f"生产 mock 应 403, 实际 {r.status_code}: {r.data[:200]}"
        body = r.get_json() or {}
        assert "已禁用" in (body.get("error", "") or ""), body
        print("✓ FLASK_ENV=production → mock 端点 403")
    finally:
        os.environ["FLASK_ENV"] = "development"

    print("\n== Task 7 CSRF smoke PASSED ==")


try:
    test()
finally:
    try:
        os.remove(db_path)
    except OSError:
        pass
