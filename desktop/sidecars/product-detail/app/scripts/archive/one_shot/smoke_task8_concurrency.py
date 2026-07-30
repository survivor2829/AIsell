"""Task 8 冒烟: 并发 + 跨用户隔离.

在 SQLite + 单进程下尽可能还原多 worker 竞态:
  C1. 10 个线程同时 POST /api/batch/<id>/start → 恰好 1 个 200, 其它 409
  C2. 10 个线程同时 POST .../ai-refine-start (同 3 个 item) → 总 claim 数 == 3
  C3. 用户 B 读 / 改 用户 A 的批次 → 403 或 404 (不泄漏元数据)
  C4. legacy batch (user_id=NULL) 的 /start → 400 "没有归属用户" (阶段六会收紧)
  C5. 内存 pub/sub: 3 个 subscriber + publish 1 次 → 每个都拿到 1 条

生产 Postgres + Redis 下 skip_locked + Redis pattern-subscribe 的真正跨进程
语义需要 docker-compose 起整栈后跑, 见 DEPLOYMENT.md(待写).
"""
import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

db_path = (ROOT / "instance" / "smoke_task8.db").as_posix()
os.makedirs(os.path.dirname(db_path), exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"
os.environ["FLASK_ENV"] = "development"
os.environ["SECRET_KEY"] = "smoke-test-secret-key-for-task8"
# 生成一次性 Fernet key, 测完丢
from cryptography.fernet import Fernet  # noqa: E402
os.environ["FERNET_KEY"] = Fernet.generate_key().decode()
os.environ.pop("HTTP_PROXY", None)

try:
    os.remove(db_path)
except OSError:
    pass

import app as app_mod  # noqa: E402
from models import db, User, Batch, BatchItem  # noqa: E402
import batch_queue as batch_queue_mod  # noqa: E402
from crypto_utils import encrypt_api_key  # noqa: E402

flask_app = app_mod.app
flask_app.config["TESTING"] = True
flask_app.config["WTF_CSRF_ENABLED"] = False  # 本测试不测 CSRF


def setup_fixtures():
    """建 2 用户 + 1 个 batch (A 拥有) + 3 个 pending item + 1 个 legacy batch."""
    with flask_app.app_context():
        alice = User(username="alice",
                     password_hash="x", is_approved=True,
                     custom_api_key_enc=encrypt_api_key("sk-fake-deepseek-key-for-test"))
        bob = User(username="bob",
                   password_hash="x", is_approved=True,
                   custom_api_key_enc=encrypt_api_key("sk-fake-2"))
        db.session.add_all([alice, bob])
        db.session.commit()

        b = Batch(batch_id="b-conc-01", name="并发测试批次", raw_name="c",
                  user_id=alice.id, batch_dir="/tmp/c",
                  total_count=3, valid_count=3, status="uploaded")
        db.session.add(b)
        db.session.commit()
        # 3 个 pending item (给 C1 用) + 3 个 done item (给 C2 用)
        for i in range(3):
            db.session.add(BatchItem(
                batch_pk=b.id, name=f"pending_{i}",
                status="pending",
                ai_refine_status="not_requested",
                want_ai_refine=False))
        for i in range(3):
            db.session.add(BatchItem(
                batch_pk=b.id, name=f"done_{i}",
                status="done",
                ai_refine_status="not_requested",
                main_image_path=f"/tmp/done_{i}.png",
                resolved_theme_id="tech_blue",
                want_ai_refine=True))
        # legacy batch (没人拥有)
        leg = Batch(batch_id="b-legacy-99", name="legacy", raw_name="l",
                    user_id=None, batch_dir="/tmp/l",
                    total_count=1, valid_count=1, status="uploaded")
        db.session.add(leg)
        db.session.flush()  # 拿到 leg.id, 不然下面 batch_pk=None 会 NOT NULL 报错
        db.session.add(BatchItem(batch_pk=leg.id, name="i", status="pending"))
        db.session.commit()
        return {"alice_id": alice.id, "bob_id": bob.id}


def client_as(user_id: int):
    c = flask_app.test_client()
    with c.session_transaction() as sess:
        sess["_user_id"] = str(user_id)
        sess["_fresh"] = True
    return c


# ── C1. 并发 start 争抢 ──────────────────────────────────────────────
def test_c1_batch_start_race(alice_id):
    # 把 submit_batch 换成 no-op, 避免真跑 DeepSeek
    _orig = batch_queue_mod.submit_batch
    batch_queue_mod.submit_batch = lambda **kw: None
    try:
        results = []
        lock = threading.Lock()

        def attempt():
            c = client_as(alice_id)
            r = c.post("/api/batch/b-conc-01/start")
            with lock:
                results.append((r.status_code, (r.get_json() or {})))

        threads = [threading.Thread(target=attempt) for _ in range(10)]
        for t in threads: t.start()
        for t in threads: t.join()

        codes = [t[0] for t in results]
        wins = codes.count(200)
        losses = codes.count(409)
        other = [t for t in results if t[0] not in (200, 409)]
        print(f"  C1: 10 线程 start → {wins}x200, {losses}x409, others={len(other)}")
        if other:
            print(f"  C1 other 样本 (前3):")
            for s, body in other[:3]:
                print(f"    [{s}] {str(body)[:200]}")
        assert wins == 1, f"应恰好 1 人赢, 实际 {wins} (全部: {codes})"
        assert losses == 9, f"应 9 人拿 409, 实际 {losses}"
        print("✓ C1 原子 Batch claim: 跨线程恰好 1 次成功")
    finally:
        batch_queue_mod.submit_batch = _orig


# ── C2. refine 端到端流程 (SQLite 下不测真正 skip_locked) ──────────
# SQLite 不支持 SELECT ... FOR UPDATE SKIP LOCKED (SQLAlchemy 降级成普通 SELECT),
# 而 SQLite 本身是 DB 级锁不是行级, 所以这里只能验证:
#   - 端到端流程不抛异常
#   - 至少有 3 个 item 被 claim (总数 >= 3)
#   - 每次调用都返回 200 (成功) 或 409 (全部已 claim), 不出 500
# 真正的跨 worker 行级互斥需要 Postgres + docker-compose, 在 DEPLOYMENT.md 里单独测.
def test_c2_refine_race(alice_id):
    # refine 路径会调 refine_processor — mock 掉 submit_refine 避免真跑
    _orig_submit_refine = batch_queue_mod.submit_refine
    batch_queue_mod.submit_refine = lambda **kw: None

    try:
        # 先把 3 个 item 设回 not_requested, 等待被 claim
        with flask_app.app_context():
            for it in BatchItem.query.filter_by(
                ai_refine_status="queued").all():
                it.ai_refine_status = "not_requested"
            db.session.commit()

        results = []
        claimed_total = []
        lock = threading.Lock()

        def attempt():
            c = client_as(alice_id)
            r = c.post("/api/batch/b-conc-01/ai-refine-start",
                       json={"ark_api_key": "sk-fake-ark-for-test"})
            data = r.get_json() or {}
            with lock:
                results.append(r.status_code)
                # 成功路径返回 "submitted", 409 路径返回 error
                claimed_total.append(data.get("submitted", 0))

        threads = [threading.Thread(target=attempt) for _ in range(10)]
        for t in threads: t.start()
        for t in threads: t.join()

        total_claimed = sum(claimed_total)
        status_dist = {s: results.count(s) for s in set(results)}
        print(f"  C2: submitted 总和 = {total_claimed} (SQLite 下 >=3 即可)")
        print(f"  C2: HTTP 状态分布: {status_dist}")
        # SQLite 下没有真正的行锁 — 只验证: 无 500 崩溃, 至少 3 个 item 被 claim
        assert 500 not in results, f"refine 路径出现 500 错误: {results}"
        assert total_claimed >= 3, \
            f"应至少 claim 3 个 item (SQLite 下可能 >3 due to 无行锁), 实际 {total_claimed}"
        assert all(s in (200, 409) for s in results), \
            f"状态码应只有 200/409, 实际 {set(results)}"
        print("✓ C2 refine 并发端到端: 无崩溃 + 总 claim>=3 (行锁真实验证留 Postgres E2E)")
    finally:
        batch_queue_mod.submit_refine = _orig_submit_refine


# ── C3. 用户 B 读/改 用户 A 的批次 ──────────────────────────────────
def test_c3_cross_user_isolation(bob_id):
    c_bob = client_as(bob_id)
    # 读详情 → 403
    r = c_bob.get("/api/batches/b-conc-01")
    assert r.status_code == 403, f"bob 读 alice 的 batch 应 403, 实际 {r.status_code}"
    # 改 item → 403
    r = c_bob.patch("/api/batches/b-conc-01/items/item_0",
                    json={"want_ai_refine": False})
    assert r.status_code == 403, f"bob 改 alice 的 item 应 403, 实际 {r.status_code}"
    # start → 403
    r = c_bob.post("/api/batch/b-conc-01/start")
    assert r.status_code == 403, f"bob 启动 alice 的 batch 应 403, 实际 {r.status_code}"
    # 列表不泄漏
    r = c_bob.get("/api/batches")
    data = r.get_json()
    ids = [b["batch_id"] for b in data["batches"]]
    assert "b-conc-01" not in ids, f"bob 不应看见 alice 的 batch, 拿到 {ids}"
    print("✓ C3 跨用户隔离: bob 所有访问点全部 403/不可见")


# ── C4. legacy batch 的 start ───────────────────────────────────────
def test_c4_legacy_rejected(alice_id):
    c = client_as(alice_id)
    r = c.post("/api/batch/b-legacy-99/start")
    assert r.status_code == 400, f"legacy start 应 400, 实际 {r.status_code}"
    err = (r.get_json() or {}).get("error", "")
    assert "归属用户" in err or "历史遗留" in err, f"错误信息不对: {err}"
    print(f"✓ C4 legacy batch start → 400 ({err[:40]}...)")


# ── C5. pub/sub 扇出 ────────────────────────────────────────────────
def test_c5_pubsub_fanout():
    import pubsub as pubsub_mod
    backend = pubsub_mod.get_backend()

    received_a = []
    received_b = []
    received_c = []

    class FakeWS:
        def __init__(self, name, sink):
            self.name = name
            self.sink = sink
        def send(self, msg):
            self.sink.append(msg)

    ws_a = FakeWS("a", received_a)
    ws_b = FakeWS("b", received_b)
    ws_c = FakeWS("c", received_c)

    backend.subscribe("b-conc-01", ws_a)
    backend.subscribe("b-conc-01", ws_b)
    backend.subscribe("b-conc-01", ws_c)

    delivered = backend.publish("b-conc-01", {"name": "item_0", "status": "done"})
    # memory backend 是同步的, 不用等; Redis backend 下, 对象被自己进程收到前
    # 要走 redis 一圈, 这测试覆盖不到跨进程 (需 docker 起 redis).
    time.sleep(0.05)

    print(f"  C5: delivered={delivered}, a={len(received_a)}, "
          f"b={len(received_b)}, c={len(received_c)}")
    assert len(received_a) == 1
    assert len(received_b) == 1
    assert len(received_c) == 1
    print("✓ C5 pub/sub 扇出: 3 subscriber 各收到 1 条")

    backend.unsubscribe("b-conc-01", ws_a)
    backend.unsubscribe("b-conc-01", ws_b)
    backend.unsubscribe("b-conc-01", ws_c)


def main():
    print("=" * 60)
    print("  Task 8 并发 + 跨用户 smoke")
    print("=" * 60)
    fx = setup_fixtures()
    test_c1_batch_start_race(fx["alice_id"])
    test_c2_refine_race(fx["alice_id"])
    test_c3_cross_user_isolation(fx["bob_id"])
    test_c4_legacy_rejected(fx["alice_id"])
    test_c5_pubsub_fanout()
    print("\n== Task 8 smoke PASSED (5/5) ==")


try:
    main()
finally:
    try:
        os.remove(db_path)
    except OSError:
        pass
