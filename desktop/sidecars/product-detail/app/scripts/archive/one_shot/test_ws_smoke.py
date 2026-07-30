"""任务6 WebSocket 烟雾测试: 登录 → 上传 → 订阅 WS → start-mock → 收事件。

用法 (PowerShell):
    # 一窗起 app
    python app.py

    # 另一窗跑测试
    python scripts/test_ws_smoke.py --user XXX --pass XXX --zip test_batch.zip

预期:
    - WS 连上立刻收到 type=snapshot
    - start-mock 后陆续收到 type=product (status=processing → done/failed)
    - 最后一个 batch_complete 后退出, 0 = 成功

不依赖真实 DeepSeek key, 走 mock_processor。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.parse

# 必须在 import requests / websocket 之前清掉代理 env, 否则 Clash (7890) 会把
# localhost 的 WS Upgrade 请求拦下来 -> 表现为 "Connection to remote host was lost"。
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(_k, None)
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

import requests
import websocket  # websocket-client


def _csrf(html: str) -> str:
    m = re.search(r'name=["\']csrf_token["\']\s+value=["\']([^"\']+)["\']', html)
    if not m:
        raise RuntimeError("登录页缺 csrf_token")
    return m.group(1)


def login(s: requests.Session, base: str, u: str, p: str) -> None:
    s.trust_env = False  # 双保险: requests 别去读系统/conda 的代理配置
    r = s.get(f"{base}/auth/login")
    r.raise_for_status()
    token = _csrf(r.text)
    r = s.post(
        f"{base}/auth/login",
        data={"username": u, "password": p, "csrf_token": token},
        allow_redirects=False,
    )
    if r.status_code not in (302, 303):
        raise SystemExit(f"登录失败 {r.status_code}\n{r.text[:200]}")
    print(f"[1/4] 登录 OK -> {r.headers.get('Location')}")


def upload(s: requests.Session, base: str, zip_path: str) -> str:
    with open(zip_path, "rb") as f:
        r = s.post(
            f"{base}/api/batch/upload",
            files={"file": (zip_path, f, "application/zip")},
            data={"batch_name": "WS烟雾测试"},
        )
    r.raise_for_status()
    d = r.json()
    print(f"[2/4] 上传 OK batch_id={d['batch_id']} 有效={d['valid_count']}")
    if d["valid_count"] == 0:
        raise SystemExit("没有有效产品")
    return d["batch_id"]


def open_ws(base: str, batch_id: str, cookies: dict, events: list,
             stop: threading.Event) -> threading.Thread:
    """开一个 WS 连接;事件存到 events list。"""
    ws_base = base.replace("http://", "ws://").replace("https://", "wss://")
    url = f"{ws_base}/ws/batch/{batch_id}"
    cookie_hdr = "; ".join(f"{k}={v}" for k, v in cookies.items())
    print(f"[3/4] 连 WS {url}")

    def runner():
        try:
            ws = websocket.create_connection(url, header=[f"Cookie: {cookie_hdr}"])
        except Exception as e:
            print(f"  ✗ WS 握手失败: {e}")
            stop.set()
            return
        print(f"  ✓ WS 已连")
        ws.settimeout(2.0)
        while not stop.is_set():
            try:
                msg = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except Exception as e:
                print(f"  ! WS 异常: {e}")
                break
            if not msg:
                continue
            try:
                evt = json.loads(msg)
            except json.JSONDecodeError:
                continue
            events.append(evt)
            t = evt.get("type")
            if t == "snapshot":
                snap = evt.get("snapshot")
                print(f"  📸 snapshot: {snap}")
            elif t == "product":
                snap = evt.get("snapshot") or {}
                print(f"  ⏱ {evt.get('name'):20s} {evt.get('status'):10s} "
                      f"P={snap.get('pending')} R={snap.get('processing')} "
                      f"D={snap.get('done')} F={snap.get('failed')}")
            elif t == "batch_complete":
                print(f"  🎉 batch_complete")
                break
            elif t == "error":
                print(f"  ✗ WS error: {evt.get('code')}")
                break
        try:
            ws.close()
        except Exception:
            pass

    th = threading.Thread(target=runner, daemon=True)
    th.start()
    return th


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--pass", dest="pwd", required=True)
    ap.add_argument("--zip", default="test_batch.zip")
    ap.add_argument("--base-url", default="http://localhost:5000")
    ap.add_argument("--max-wait", type=int, default=60)
    args = ap.parse_args()

    s = requests.Session()
    login(s, args.base_url, args.user, args.pwd)
    batch_id = upload(s, args.base_url, args.zip)

    cookies = {c.name: c.value for c in s.cookies}
    events: list = []
    stop = threading.Event()

    th = open_ws(args.base_url, batch_id, cookies, events, stop)
    time.sleep(0.5)  # 等 WS 握手 + snapshot 到达

    if stop.is_set():
        print("✗ WS 都没连上,放弃")
        return 1

    print(f"[4/4] 触发 mock 流水线")
    r = s.post(f"{args.base_url}/api/batch/{batch_id}/start-mock")
    if r.status_code != 200:
        print(f"  ✗ start-mock 失败 {r.status_code}: {r.text[:200]}")
        stop.set()
        return 1
    print(f"  ✓ {r.json().get('message')}")

    # 等 batch_complete 或超时
    start = time.time()
    while th.is_alive() and time.time() - start < args.max_wait:
        time.sleep(0.5)
    stop.set()
    th.join(timeout=2)

    snapshot_n = sum(1 for e in events if e.get("type") == "snapshot")
    product_n  = sum(1 for e in events if e.get("type") == "product")
    complete_n = sum(1 for e in events if e.get("type") == "batch_complete")
    print(f"\n收到事件: snapshot={snapshot_n} product={product_n} batch_complete={complete_n}")

    ok = snapshot_n >= 1 and product_n >= 1
    if ok:
        print("✅ 任务6 烟雾测试通过 (WS 推送链路 OK)")
    else:
        print("❌ 烟雾测试失败")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
