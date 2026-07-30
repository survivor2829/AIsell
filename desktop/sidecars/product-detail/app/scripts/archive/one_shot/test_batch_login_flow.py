"""任务4a 验证脚本：登录 → 上传 → 启动批次 → 轮询 → 看 DB 结果。

用法（PowerShell 或 cmd 都行）:
    python scripts/test_batch_login_flow.py --user XXX --pass XXX --zip test_batch.zip

可选:
    --base-url http://localhost:5000
    --poll-interval 3      （秒，轮询间隔）
    --max-wait 300         （秒，超过则超时退出）

为什么不用 curl:
- 项目 CSRFProtect 全局启用，登录表单要 csrf_token，
  纯 curl 必须 GET /auth/login 抓 token + 维护 cookie 文件 + POST 时带 token，
  在 PowerShell 里太啰嗦。requests.Session 一句话搞定。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time

import requests


def _extract_csrf(html: str) -> str:
    m = re.search(r'name=["\']csrf_token["\']\s+value=["\']([^"\']+)["\']', html)
    if not m:
        raise RuntimeError("登录页没有 csrf_token，模板可能改过")
    return m.group(1)


def login(session: requests.Session, base: str, user: str, pwd: str) -> None:
    print(f"[1/5] 登录 {base}/auth/login as {user}…")
    r = session.get(f"{base}/auth/login", allow_redirects=True)
    r.raise_for_status()
    token = _extract_csrf(r.text)
    r = session.post(
        f"{base}/auth/login",
        data={"username": user, "password": pwd, "csrf_token": token},
        allow_redirects=False,
    )
    if r.status_code in (302, 303):
        print(f"      ✓ 登录成功（重定向到 {r.headers.get('Location')}）")
    else:
        # 登录失败一般会渲染表单 + flash 错误
        snippet = re.sub(r'\s+', ' ', r.text[:300])
        raise SystemExit(f"      ✗ 登录失败 status={r.status_code}\n{snippet}")


def upload_zip(session: requests.Session, base: str, zip_path: str,
               batch_name: str) -> str:
    print(f"[2/5] 上传 {zip_path}（batch_name={batch_name})…")
    with open(zip_path, "rb") as f:
        r = session.post(
            f"{base}/api/batch/upload",
            files={"file": (zip_path, f, "application/zip")},
            data={"batch_name": batch_name},
        )
    r.raise_for_status()
    data = r.json()
    print(f"      ✓ batch_id={data['batch_id']}  valid={data['valid_count']}  "
          f"skipped={data['skipped_count']}")
    if data["valid_count"] == 0:
        raise SystemExit(f"      ✗ 没有合规产品，skipped={data.get('skipped')}")
    return data["batch_id"]


def start_batch(session: requests.Session, base: str, batch_id: str) -> None:
    print(f"[3/5] 启动批次 {batch_id}…")
    r = session.post(f"{base}/api/batch/{batch_id}/start")
    if r.status_code != 200:
        raise SystemExit(
            f"      ✗ start 失败 status={r.status_code}\n      "
            f"{r.text[:400]}"
        )
    data = r.json()
    print(f"      ✓ 已提交 {data['submitted']} 个产品；状态={data['batch_status']}")


def poll_status(session: requests.Session, base: str, batch_id: str,
                interval: int, max_wait: int) -> dict:
    print(f"[4/5] 轮询 /api/batch/{batch_id}/status 每 {interval}s…")
    start = time.time()
    last_signature = None
    while True:
        r = session.get(f"{base}/api/batch/{batch_id}/status")
        if r.status_code == 404:
            print("      (内存里还没有，等下一轮)")
        else:
            r.raise_for_status()
            s = r.json()
            sig = (s["pending"], s["processing"], s["done"], s["failed"])
            if sig != last_signature:
                print(f"      ⏱ pending={s['pending']} processing={s['processing']}"
                      f" done={s['done']} failed={s['failed']}")
                last_signature = sig
            if s["pending"] == 0 and s["processing"] == 0:
                return s
        if time.time() - start > max_wait:
            raise SystemExit(f"      ✗ 超过 {max_wait}s 仍未完成")
        time.sleep(interval)


def show_db_result(session: requests.Session, base: str, batch_id: str) -> None:
    print(f"[5/5] 拉 DB 持久化结果…")
    r = session.get(f"{base}/api/batches/{batch_id}")
    r.raise_for_status()
    data = r.json()
    print(f"      batch.status={data['status']}  "
          f"valid={data['valid_count']}  skipped={data['skipped_count']}")
    for it in data.get("items", []):
        line = f"      • {it['name']:30s} status={it['status']:10s}"
        if it["status"] == "done":
            res = it.get("result") or {}
            line += (f"  parsed_keys={len(res.get('parsed_keys') or [])}"
                     f"  cutout={'OK' if res.get('cutout_path') else 'SKIP'}")
            if res.get("cutout_error"):
                line += f"  cutout_err={res['cutout_error'][:40]}"
        elif it["status"] == "failed":
            line += f"  err={(it.get('error') or '')[:80]}"
        elif it["status"] == "skipped":
            line += f"  reason={it.get('skip_reason') or ''}"
        print(line)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--pass", dest="pwd", required=True)
    ap.add_argument("--zip", default="test_batch.zip")
    ap.add_argument("--base-url", default="http://localhost:5000")
    ap.add_argument("--batch-name", default="任务4a验证")
    ap.add_argument("--poll-interval", type=int, default=3)
    ap.add_argument("--max-wait", type=int, default=300)
    args = ap.parse_args()

    session = requests.Session()
    login(session, args.base_url, args.user, args.pwd)
    batch_id = upload_zip(session, args.base_url, args.zip, args.batch_name)
    start_batch(session, args.base_url, batch_id)
    final = poll_status(session, args.base_url, batch_id,
                         args.poll_interval, args.max_wait)
    show_db_result(session, args.base_url, batch_id)

    print()
    if final["failed"] == 0:
        print(f"✅ 全部 {final['done']} 个产品 done，0 个失败")
        sys.exit(0)
    else:
        print(f"⚠️  {final['done']} done / {final['failed']} failed — 看上面 err 字段")
        sys.exit(1)


if __name__ == "__main__":
    main()
