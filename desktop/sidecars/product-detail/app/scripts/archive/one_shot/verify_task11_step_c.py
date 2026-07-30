"""任务11 Step C 端到端验证 — 用 Flask test_client 不起服务器跑全链路。

覆盖点:
  1. refine_processor 可导入 (import-time 冒烟)
  2. batch_queue.submit_refine / get_refine_status / get_pool_stats 有效
  3. /api/batch/<id>/ai-refine-start
     - 未登录 → 302 (login_required 兜住)
     - 登录非 owner → 403
     - 登录 owner 但缺 ark_api_key → 400 + action=configure_ark_key + redirect
     - 登录 owner + ark_api_key + 有候选 → 200, submitted>=1, DB 里 ai_refine_status 变 queued
  4. processor_fn 真的带着 ark_api_key 调 refine_processor (monkey-patch 拦截)

全程 monkey-patch refine_processor.refine_one_product, 绝不烧真 Seedream。
使用 Flask test_client in-process — 不需要重启 app.py。
回滚安全: 所有 DB 变更在测试末尾回滚 (db.session.rollback)。
"""
from __future__ import annotations

import os
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# 静音 Clash 代理: 本机测试客户端绕过 (memory feedback_proxy_localhost)
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)


def _log(msg: str) -> None:
    print(f"[verify-C] {msg}", flush=True)


def main() -> int:
    failures: list[str] = []

    # ── 1. refine_processor 可导入 ─────────────────────────────
    try:
        import refine_processor
        assert callable(refine_processor.refine_one_product)
        _log("✓ refine_processor 导入成功")
    except Exception as e:
        failures.append(f"refine_processor 导入失败: {e!r}")
        traceback.print_exc()
        return 1  # 连包都导不进,下面全废

    # ── 2. batch_queue 接口 ────────────────────────────────────
    try:
        import batch_queue
        assert callable(batch_queue.submit_refine)
        assert callable(batch_queue.get_refine_status)
        stats = batch_queue.get_pool_stats()
        assert "refine_pool" in stats, f"get_pool_stats 缺 refine_pool: {stats}"
        assert stats["refine_pool"]["max_workers"] >= 1
        _log(f"✓ batch_queue 接口齐全 (refine_pool.max_workers={stats['refine_pool']['max_workers']})")
    except Exception as e:
        failures.append(f"batch_queue 接口异常: {e!r}")
        traceback.print_exc()

    # ── 3. monkey-patch refine_processor 拦真 Seedream ──────────
    captured_calls: list[dict] = []

    def _fake_refine(scope_id, payload, *, ark_api_key):
        captured_calls.append({
            "scope_id": scope_id,
            "payload": dict(payload),
            "ark_api_key": ark_api_key,
        })
        # 模拟精修产出
        return {
            "ai_refined_path": f"/uploads/fake/{payload.get('name')}/ai_refined.jpg",
            "ai_refined_at":   int(time.time()),
            "segments_count":  7,
            "total_elapsed":   0.01,
            "theme_id":        payload.get("resolved_theme_id"),
        }
    refine_processor.refine_one_product = _fake_refine
    _log("✓ refine_processor.refine_one_product 已被 monkey-patch")

    # ── 4. Flask test_client ───────────────────────────────────
    try:
        from app import app, db, User, Batch, BatchItem
    except Exception as e:
        failures.append(f"导入 app 失败: {e!r}")
        traceback.print_exc()
        return 1

    client = app.test_client()

    # 4.1 未登录 → login_required 302
    r = client.post("/api/batch/nonexistent/ai-refine-start", json={})
    if r.status_code not in (302, 401):
        failures.append(f"未登录应 302/401, 实际 {r.status_code}")
    else:
        _log(f"✓ 未登录访问返回 {r.status_code}")

    # 4.2 准备测试 fixture: 真 DB 插临时数据, 测完回滚
    with app.app_context():
        # 拿一个现成 user (避免密码哈希逻辑)
        owner = User.query.first()
        other = User.query.filter(User.id != (owner.id if owner else -1)).first() if owner else None
        if owner is None:
            failures.append("DB 里没有任何 User, 无法构造 owner, 测试终止")
            return 1 if failures else 0

        # 创建临时批次 + 3 个 item:
        #   item1: status=done, main_image_path 有, want_ai_refine=True, ai_refine_status=None → 候选
        #   item2: status=done, want_ai_refine=True, ai_refine_status=done → 候选(重跑) + already_done
        #   item3: status=pending (未 HTML 完成) → 跳过
        tid = f"TST_C_{int(time.time())}"
        b = Batch(
            batch_id=tid,
            name=tid,
            raw_name=tid,
            user_id=owner.id,
            product_category="设备类",
            total_count=3,
            status="completed",
            batch_dir=str(ROOT / "static" / "uploads" / tid),
        )
        db.session.add(b)
        db.session.flush()

        import json as _json
        fake_result = _json.dumps({
            "parsed_path": "/uploads/fake/parsed.json",
            "cutout_path": "/uploads/fake/cut.png",
        }, ensure_ascii=False)

        it1 = BatchItem(
            batch_pk=b.id, name="产品甲", status="done",
            main_image_path="/uploads/fake/甲.jpg",
            want_ai_refine=True, ai_refine_status=None,
            resolved_theme_id="tech-blue",
            result=fake_result,
        )
        it2 = BatchItem(
            batch_pk=b.id, name="产品乙", status="done",
            main_image_path="/uploads/fake/乙.jpg",
            want_ai_refine=True, ai_refine_status="done",
            resolved_theme_id="classic-red",
            result=fake_result,
        )
        it3 = BatchItem(
            batch_pk=b.id, name="产品丙", status="pending",
            main_image_path="/uploads/fake/丙.jpg",
            want_ai_refine=True, ai_refine_status=None,
            resolved_theme_id="tech-blue",
            result=None,
        )
        db.session.add_all([it1, it2, it3])
        db.session.commit()
        owner_id = owner.id
        other_id = other.id if other else None
        batch_pk = b.id
        _log(f"✓ fixture 批次 {tid} (pk={batch_pk}) 已建, 3 个 item")

    try:
        # 4.3 登录 owner
        with client.session_transaction() as sess:
            sess["_user_id"] = str(owner_id)
            sess["_fresh"] = True

        # 4.4 owner 但缺 ark_api_key → 400
        r = client.post(f"/api/batch/{tid}/ai-refine-start", json={})
        if r.status_code != 400:
            failures.append(f"缺 ark_api_key 应 400, 实际 {r.status_code}, body={r.data[:200]!r}")
        else:
            body = r.get_json() or {}
            if body.get("action") != "configure_ark_key" or "redirect" not in body:
                failures.append(f"400 响应缺 action/redirect: {body}")
            else:
                _log(f"✓ 缺 key 返回 400 + action=configure_ark_key + redirect={body['redirect']}")

        # 4.5 不存在的 batch → 404
        r = client.post("/api/batch/DOES_NOT_EXIST_XYZ/ai-refine-start",
                        json={"ark_api_key": "sk-fake"})
        if r.status_code != 404:
            failures.append(f"不存在 batch 应 404, 实际 {r.status_code}")
        else:
            _log("✓ 不存在 batch 返回 404")

        # 4.6 非 owner → 403
        if other_id is not None:
            with client.session_transaction() as sess:
                sess["_user_id"] = str(other_id)
                sess["_fresh"] = True
            r = client.post(f"/api/batch/{tid}/ai-refine-start",
                            json={"ark_api_key": "sk-fake"})
            if r.status_code != 403:
                failures.append(f"非 owner 应 403, 实际 {r.status_code}")
            else:
                _log("✓ 非 owner 返回 403")
            # 切回 owner
            with client.session_transaction() as sess:
                sess["_user_id"] = str(owner_id)
                sess["_fresh"] = True

        # 4.7 正常路径 → 200, submitted=2, skipped=1 (产品丙), already_done_count=1 (乙)
        r = client.post(f"/api/batch/{tid}/ai-refine-start",
                        json={"ark_api_key": "sk-TEST-KEY-xxx"})
        if r.status_code != 200:
            failures.append(f"正常路径应 200, 实际 {r.status_code}, body={r.data[:400]!r}")
        else:
            body = r.get_json() or {}
            if body.get("submitted") != 2:
                failures.append(f"submitted 应 2, 实际 {body.get('submitted')}")
            if body.get("already_done_count") != 1:
                failures.append(f"already_done_count 应 1, 实际 {body.get('already_done_count')}")
            if len(body.get("skipped", [])) != 1:
                failures.append(f"skipped 应有 1 条, 实际 {body.get('skipped')}")
            else:
                if body["skipped"][0].get("name") != "产品丙":
                    failures.append(f"跳过的应是'产品丙', 实际 {body['skipped']}")
            _log(f"✓ 正常路径 200, body={body}")

        # 4.8 DB 状态: it1/it2 的 ai_refine_status 应从 None/'done' → 'queued' 再到 (异步) 'done'
        #     因为 fake_refine 瞬间返回 result, 工作线程大概率已经跑完
        #     我们等一下让线程池消费完
        for _ in range(20):  # 最多等 2 秒
            with app.app_context():
                it1_db = BatchItem.query.filter_by(batch_pk=batch_pk, name="产品甲").first()
                it2_db = BatchItem.query.filter_by(batch_pk=batch_pk, name="产品乙").first()
                if it1_db and it1_db.ai_refine_status == "done" and \
                   it2_db and it2_db.ai_refine_status == "done":
                    break
            time.sleep(0.1)

        with app.app_context():
            it1_db = BatchItem.query.filter_by(batch_pk=batch_pk, name="产品甲").first()
            it2_db = BatchItem.query.filter_by(batch_pk=batch_pk, name="产品乙").first()
            it3_db = BatchItem.query.filter_by(batch_pk=batch_pk, name="产品丙").first()
            if it1_db.ai_refine_status != "done":
                failures.append(f"甲.ai_refine_status 应 done(fake 秒完), 实际 {it1_db.ai_refine_status}")
            else:
                _log(f"✓ 甲 ai_refine_status={it1_db.ai_refine_status}")
            if it2_db.ai_refine_status != "done":
                failures.append(f"乙.ai_refine_status 应 done, 实际 {it2_db.ai_refine_status}")
            else:
                _log(f"✓ 乙 ai_refine_status={it2_db.ai_refine_status} (重跑覆盖)")
            # 丙 被白名单拦住 — 只要没进入任何"被队列处理过"的状态即可
            #   None 或 'not_requested' (列默认) 都 OK
            if (it3_db.ai_refine_status or "not_requested") in ("queued", "processing", "done", "failed"):
                failures.append(f"丙 不应入队, 实际 ai_refine_status={it3_db.ai_refine_status}")
            else:
                _log(f"✓ 丙 ai_refine_status={it3_db.ai_refine_status!r} (被白名单跳过)")

            # 验证 result JSON 合并: 原 parsed_path 还在 + 新 ai_refined_path 进来
            import json as _json
            r1 = _json.loads(it1_db.result or "{}")
            if r1.get("parsed_path") != "/uploads/fake/parsed.json":
                failures.append(f"甲.result 丢了任务4 的 parsed_path: {r1}")
            elif "ai_refined_path" not in r1:
                failures.append(f"甲.result 缺 ai_refined_path: {r1}")
            else:
                _log(f"✓ 甲.result 合并 OK: parsed_path + ai_refined_path 都在 {r1.get('ai_refined_path')}")

        # 4.9 closure 真带上 ark_api_key?
        if not captured_calls:
            failures.append("monkey-patch 没被调用, processor_fn 未触发?")
        else:
            keys = {c["ark_api_key"] for c in captured_calls}
            if keys != {"sk-TEST-KEY-xxx"}:
                failures.append(f"ark_api_key 没被正确 closure 捕获: {keys}")
            else:
                _log(f"✓ closure 捕获 ark_api_key 正确 ({len(captured_calls)} 次调用)")

        # 4.10 get_refine_status 能拿到这个批次
        snap = batch_queue.get_refine_status(tid)
        if not snap:
            failures.append(f"get_refine_status({tid}) 返回空")
        else:
            names = [p.get("name") for p in snap.get("products", [])]
            _log(f"✓ get_refine_status: total={snap.get('total')} done={snap.get('done')} "
                 f"products={names}")

    finally:
        # 清理 fixture
        with app.app_context():
            try:
                b = Batch.query.filter_by(batch_id=tid).first()
                if b:
                    BatchItem.query.filter_by(batch_pk=b.id).delete()
                    db.session.delete(b)
                    db.session.commit()
                    _log(f"✓ fixture {tid} 已清理")
            except Exception as e:
                _log(f"清理 fixture 出错(忽略): {e}")

    # ── 总结 ───────────────────────────────────────────────────
    print("\n" + "═" * 60)
    if failures:
        print(f"✗ Step C 验证 {len(failures)} 项失败:")
        for f in failures:
            print(f"  - {f}")
        print("═" * 60)
        return 1
    print("✓ Step C 所有验证通过 — 端点/候选筛选/闭包/DB同步/池接口 全绿")
    print("═" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
