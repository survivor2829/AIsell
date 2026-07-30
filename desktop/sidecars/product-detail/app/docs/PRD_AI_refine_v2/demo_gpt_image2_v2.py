"""AI 精修 v2.1 demo — gpt-image-2 via APIMart (edits-first, thinking-enabled).

修复第 1 版的 4 个错误:
  A. prompt 描述矛盾 (写 "white unmanned robot" 但参考图是黄色机身)
  B. 没用官方 PRESERVE/CHANGE/CONSTRAINTS 结构
  C. 只打 /images/generations (生成端点) 而非 /images/edits (编辑端点)
  D. 没尝试 thinking mode

跑法 (腾讯云):
  cd /opt/xiaoxi && git pull
  docker cp scripts/demo_gpt_image2_v2.py clean-industry-ai-assistant-web-1:/tmp/
  docker exec -e PYTHONPATH=/app clean-industry-ai-assistant-web-1 \
      python3 /tmp/demo_gpt_image2_v2.py
  docker cp clean-industry-ai-assistant-web-1:/tmp/demo_gpt2_v2_dz600m.jpg /tmp/
  # 本地 scp 回来
  scp tencent-prod:/tmp/demo_gpt2_v2_dz600m.jpg .

成本上限:
  - edits 端点 $0.04/张
  - thinking=medium 约 +50%  → $0.06
  - 最多跑 2 次 (端点探测 + 正式) → $0.12 (远低于 $0.5 预算)
"""
from __future__ import annotations
import base64
import json
import mimetypes
import os
import sys
import time
import traceback
import urllib.request
import urllib.error
from pathlib import Path


# ── 配置 ─────────────────────────────────────────────────────────
API_KEY = os.environ.get("GPT_IMAGE_API_KEY", "").strip()
BASE_URL = os.environ.get("GPT_IMAGE_BASE_URL", "https://api.apimart.ai/v1").rstrip("/")

REF_PATH = Path(
    "/app/static/uploads/batches/batch_20260422_001_3858/测试/"
    "DZ600M无人水面清洁机新品1/product_cut.png"
)
OUT_DIR = Path("/tmp")
OUT_NAME = "demo_gpt2_v2_dz600m.jpg"

POLL_INTERVAL = 3
POLL_TIMEOUT = 240  # thinking mode 慢, 给足 4 分钟

# Cloudflare 403 兜底
_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


# ── 新 Prompt (PRESERVE/CHANGE/CONSTRAINTS 结构, 匹配黄色机身真相) ──
PROMPT_V2 = """Image 1 is the reference photo of DZ600M — an unmanned water surface cleaning robot. Preserve its exact visual identity.

PRESERVE from Image 1 (exactly match):
- Main body color: industrial yellow
- Structural parts: two large black cylindrical auger floats
- Top: transparent dome camera housing
- Front: black propeller blade
- Proportions: compact, flat, float-style watercraft

CHANGE (new scene):
- Setting: modern Chinese urban riverbank at golden hour sunset
- Background: Chinese city skyline, skyscrapers softened by warm light, water reflecting the cityscape
- Foreground: DZ600M operating on water surface, gentle ripples, floating trash and pollutants being collected around it
- Add: Chinese environmental engineer in dark navy work uniform standing on bank, holding a tablet reviewing real-time data from robot

CONSTRAINTS:
- NO redesign of the robot
- NO color drift — yellow body stays industrial yellow
- NO added propellers or parts not in Image 1
- NO text, NO logo, NO watermark
- NO tilt-shift or miniature effects

STYLE:
Taobao/Tmall e-commerce detail page hero shot,
commercial product-in-scene photography,
sharp focus on both product and operator,
cinematic golden-hour grading, professional 8K"""


# ── HTTP 辅助 ───────────────────────────────────────────────────
def to_data_url(p: Path) -> str:
    raw = p.read_bytes()
    mime, _ = mimetypes.guess_type(p.name) or ("image/png", None)
    if not mime:
        mime = "image/png"
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{b64}"


def http_post_json(url: str, payload: dict, timeout: int = 60) -> tuple[int, dict | str]:
    """POST JSON, 返回 (status_code, body_as_json_or_str). 不抛 HTTPError."""
    req = urllib.request.Request(
        url, method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {API_KEY}",
                 "Content-Type": "application/json",
                 "User-Agent": _UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8")
            try:
                return r.status, json.loads(body)
            except json.JSONDecodeError:
                return r.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, body


def http_get_json(url: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(
        url, method="GET",
        headers={"Authorization": f"Bearer {API_KEY}", "User-Agent": _UA},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ── 端点探测 ────────────────────────────────────────────────────
def probe_edits_endpoint(data_url: str) -> bool:
    """发一个最小 POST /images/edits, 看 APIMart 是否暴露.

    策略: 用 gpt-image-2 + minimal prompt, 如果返回 200/submit → 有
         如果 404/405/unknown endpoint → 没有, 降级 generations.
    """
    print("[probe] 探测 /images/edits 端点是否可用...")
    probe_payload = {
        "model": "gpt-image-2",
        "prompt": "test probe, return any image",
        "n": 1,
        "size": "1:1",
        "image_urls": [data_url],
    }
    code, body = http_post_json(f"{BASE_URL}/images/edits", probe_payload, timeout=20)
    print(f"[probe] edits 端点返回: HTTP {code}")
    if isinstance(body, dict):
        print(f"[probe]   response: code={body.get('code')}  msg={body.get('message') or body.get('error') or ''}")
    else:
        print(f"[probe]   response: {str(body)[:200]}")

    # 成功标志: HTTP 200 且 APIMart code=200 (有 task_id) 或 202 submitted
    if code == 200 and isinstance(body, dict) and body.get("code") == 200:
        return True
    # 明确拒绝: 404 路由不存在 / 405 方法不允许 / "not found"
    return False


# ── 提交任务 (支持 edits 或 generations, 可加 thinking) ──────────
def submit_task(endpoint: str, prompt: str, data_url: str, size: str,
                thinking: str | None) -> str:
    payload = {
        "model": "gpt-image-2",
        "prompt": prompt,
        "n": 1,
        "size": size,
        "image_urls": [data_url],
    }
    if thinking:
        # 两种可能的参数名, 都塞进去. 上游不认识会忽略, APIMart 不认会返 400.
        payload["thinking"] = thinking
        payload["reasoning_effort"] = thinking

    url = f"{BASE_URL}/{endpoint}"
    print(f"[submit] POST {url}")
    print(f"         prompt.len={len(prompt)} size={size} thinking={thinking!r}")

    code, body = http_post_json(url, payload, timeout=90)
    if code != 200:
        raise RuntimeError(f"HTTP {code}: {body}")
    if not isinstance(body, dict) or body.get("code") != 200:
        raise RuntimeError(f"APIMart 错误: {body}")
    tasks = body.get("data") or []
    if not tasks:
        raise RuntimeError(f"响应 data 为空: {body}")
    task_id = tasks[0].get("task_id")
    if not task_id:
        raise RuntimeError(f"响应缺 task_id: {body}")
    print(f"[submit] task_id = {task_id}")
    return task_id


def poll_task(task_id: str) -> str:
    t0 = time.time()
    while True:
        elapsed = time.time() - t0
        if elapsed > POLL_TIMEOUT:
            raise TimeoutError(f"轮询超时 {POLL_TIMEOUT}s, task_id={task_id}")
        data = http_get_json(f"{BASE_URL}/tasks/{task_id}?language=en")
        node = data.get("data") or data
        status = node.get("status")
        progress = node.get("progress", 0)
        print(f"[poll]  status={status}  progress={progress}%  t={elapsed:.1f}s")

        if status == "completed":
            images = (node.get("result") or {}).get("images") or []
            if not images:
                raise RuntimeError(f"completed 但无 images: {node}")
            url = images[0].get("url")
            if isinstance(url, list):
                url = url[0] if url else None
            if not url:
                raise RuntimeError(f"completed 但无 url: {images}")
            return url
        if status in ("failed", "cancelled"):
            raise RuntimeError(f"任务 {status}: {node}")
        time.sleep(POLL_INTERVAL)


def download(url: str, out: Path) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    if len(raw) < 10000:
        raise RuntimeError(f"下载图片过小: {len(raw)} bytes")
    out.write_bytes(raw)
    return out


# ── 主流程 ──────────────────────────────────────────────────────
def main():
    print("=" * 66)
    print("AI 精修 v2.1 demo · gpt-image-2 · edits-first + thinking")
    print("=" * 66)

    if not API_KEY:
        print("[FAIL] GPT_IMAGE_API_KEY 未配置"); sys.exit(1)
    if not REF_PATH.is_file():
        print(f"[FAIL] 参考图不存在: {REF_PATH}"); sys.exit(1)

    print(f"[env] API_KEY len={len(API_KEY)}  BASE={BASE_URL}")
    print(f"[env] ref={REF_PATH.name} ({REF_PATH.stat().st_size // 1024}KB)")

    data_url = to_data_url(REF_PATH)
    print(f"[env] base64 data url: {len(data_url):,} chars")

    # Step 1: 探测 edits 端点
    print("\n" + "─" * 66)
    print("Step 1 · 探测 /v1/images/edits")
    print("─" * 66)
    has_edits = probe_edits_endpoint(data_url)
    endpoint = "images/edits" if has_edits else "images/generations"
    print(f"[decide] 用端点: /{endpoint}  ({'edits' if has_edits else 'generations (降级)'})")

    # Step 2: 正式提交 (先试 thinking=medium, 失败降级 None)
    print("\n" + "─" * 66)
    print("Step 2 · 提交任务")
    print("─" * 66)
    t0 = time.time()
    task_id = None
    thinking_used = None
    for thinking in ("medium", None):
        try:
            print(f"[try] thinking={thinking!r}")
            task_id = submit_task(endpoint, PROMPT_V2, data_url,
                                  size="1:1", thinking=thinking)
            thinking_used = thinking
            break
        except Exception as e:
            print(f"[try FAIL] thinking={thinking!r}: {e}")
            if thinking is None:
                raise  # 彻底失败
            continue

    # Step 3: 轮询 + 下载
    print("\n" + "─" * 66)
    print("Step 3 · 轮询 + 下载")
    print("─" * 66)
    url = poll_task(task_id)
    out = download(url, OUT_DIR / OUT_NAME)
    elapsed = round(time.time() - t0, 1)

    print("\n" + "=" * 66)
    print(f"[OK] endpoint={endpoint} thinking={thinking_used!r}")
    print(f"[OK] 产物: {out} ({out.stat().st_size // 1024}KB)")
    print(f"[OK] 耗时: {elapsed}s")
    print("=" * 66)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[FATAL] {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
