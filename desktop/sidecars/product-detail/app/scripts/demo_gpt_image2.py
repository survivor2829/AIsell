"""AI 精修 v2 demo — GPT-image-2 via APIMart (中文 + 图生图 双测).

跑 2 张图, 预算 $3 (¥21) 上限保护 (每张超过 $1 立刻停).

测试 1: 纯文生图, 验证中文字符渲染 (真假判断)
测试 2: 图生图, DZ600M 产品锁定 + 淘宝风格

跑法:
  docker exec -e PYTHONPATH=/app clean-industry-ai-assistant-web-1 \
      python3 /tmp/demo_gpt_image2.py

输出:
  /tmp/demo_gpt2_test1_chinese.jpg  (测试1)
  /tmp/demo_gpt2_test2_dz600m.jpg   (测试2)
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
from pathlib import Path


# ── 配置 ─────────────────────────────────────────────────────────
API_KEY = os.environ.get("GPT_IMAGE_API_KEY", "").strip()
BASE_URL = os.environ.get("GPT_IMAGE_BASE_URL", "https://api.apimart.ai/v1").rstrip("/")

REF_PATH = Path(
    "/app/static/uploads/batches/batch_20260422_001_3858/测试/"
    "DZ600M无人水面清洁机新品1/product_cut.png"
)
OUT_DIR = Path("/tmp")

POLL_INTERVAL = 3    # 秒
POLL_TIMEOUT = 180   # 3 分钟 (gpt-image-2 慢于 Seedream)

# ── 测试 1 · 纯文生图 · 中文字符渲染真假测试 ────────────────────
TEST1_PROMPT = (
    "一张 B2B 产品详情页首屏 banner 图, 中文大标题文字 "
    "\"小玺AI·批量生成\" 居中置顶清晰显示, "
    "下方是科技感的深蓝色渐变背景配点缀光斑, "
    "极简主义设计, 专业商务风, 8K 超高清, 无水印."
)

# ── 测试 2 · 图生图 · DZ600M 产品锁定 + 淘宝风格 ────────────────
TEST2_PROMPT = """A Chinese water-treatment engineer in a professional dark blue uniform
stands on the bank of an urban river. In the far distance, a modern
Chinese city skyline at golden hour — skyscrapers softened by warm sunset
glow.

In the foreground, a white unmanned surface cleaning robot (DZ600M, its
body and hull MUST strictly match the reference image) operates on the
water surface — gentle ripples around the hull, floating pollutants
around it being collected.

The engineer holds a tablet reviewing real-time telemetry from the robot.

Color tone: modern technology blue dominant, warm amber sunset accent,
city silhouette subtly reflected on the water.

Professional environmental technology photography, 8K ultra-sharp,
cinematic grading, both the product and the operator clearly visible
and in focus.

Style reference: Taobao/Tmall e-commerce detail page hero image,
clean commercial composition, high-end B2B industrial product photography,
professional product-and-scene integration."""


# ── 核心函数 ─────────────────────────────────────────────────────
def to_data_url(p: Path) -> str:
    raw = p.read_bytes()
    mime, _ = mimetypes.guess_type(p.name)
    if not mime:
        mime = "image/png"
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{b64}"


# User-Agent 注入: Cloudflare 默认拦 Python-urllib/x.x 返 403
_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def http_post_json(url: str, payload: dict, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        url, method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {API_KEY}",
                 "Content-Type": "application/json",
                 "User-Agent": _UA},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def http_get_json(url: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(
        url, method="GET",
        headers={"Authorization": f"Bearer {API_KEY}",
                 "User-Agent": _UA},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def submit_task(prompt: str, size: str, image_urls: list[str] | None) -> str:
    payload = {
        "model": "gpt-image-2",
        "prompt": prompt,
        "n": 1,
        "size": size,
    }
    if image_urls:
        payload["image_urls"] = image_urls

    print(f"[submit] POST {BASE_URL}/images/generations")
    print(f"         prompt[:80]={prompt[:80]!r}")
    print(f"         size={size}  image_urls={len(image_urls) if image_urls else 0} refs")
    data = http_post_json(f"{BASE_URL}/images/generations", payload)

    # Expected: {"code": 200, "data": [{"status": "submitted", "task_id": "..."}]}
    if data.get("code") != 200:
        raise RuntimeError(f"提交失败: {data}")
    tasks = data.get("data") or []
    if not tasks:
        raise RuntimeError(f"响应 data 为空: {data}")
    task_id = tasks[0].get("task_id")
    if not task_id:
        raise RuntimeError(f"响应缺 task_id: {data}")
    print(f"[submit] task_id = {task_id}")
    return task_id


def poll_task(task_id: str) -> str:
    """轮询直到 completed, 返回 image URL. 失败/超时抛异常."""
    t0 = time.time()
    while True:
        elapsed = time.time() - t0
        if elapsed > POLL_TIMEOUT:
            raise TimeoutError(f"轮询超时 {POLL_TIMEOUT}s, task_id={task_id}")
        data = http_get_json(f"{BASE_URL}/tasks/{task_id}?language=en")
        node = data.get("data") or data  # APIMart 可能嵌一层 data
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


# ── 主流程 ────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print("AI 精修 v2 demo · GPT-image-2 via APIMart")
    print("=" * 60)

    if not API_KEY:
        print("[FAIL] GPT_IMAGE_API_KEY 未配置 (检查 .env + 容器 env)")
        sys.exit(1)
    print(f"[env] GPT_IMAGE_API_KEY len={len(API_KEY)}")
    print(f"[env] GPT_IMAGE_BASE_URL={BASE_URL}")

    # ── 测试 1: 纯文生图 中文字符 ─────────────────────────────
    print("\n" + "─" * 60)
    print("TEST 1 · 纯文生图 (中文字符渲染真假测试)")
    print("─" * 60)
    t0 = time.time()
    try:
        tid = submit_task(TEST1_PROMPT, size="16:9", image_urls=None)
        url1 = poll_task(tid)
    except Exception as e:
        print(f"[FAIL test1] {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
    out1 = download(url1, OUT_DIR / "demo_gpt2_test1_chinese.jpg")
    e1 = round(time.time() - t0, 1)
    print(f"[OK test1] {out1} ({out1.stat().st_size // 1024}KB)  耗时 {e1}s")

    # ── 测试 2: 图生图 DZ600M 产品锁定 ────────────────────────
    print("\n" + "─" * 60)
    print("TEST 2 · 图生图 (DZ600M 产品 + 淘宝风格)")
    print("─" * 60)
    if not REF_PATH.is_file():
        print(f"[FAIL test2] 参考图不存在: {REF_PATH}")
        sys.exit(1)
    print(f"[info] 参考图: {REF_PATH.name} ({REF_PATH.stat().st_size // 1024}KB)")
    data_url = to_data_url(REF_PATH)
    print(f"[info] Base64 data URL 长度: {len(data_url):,} 字符")

    t0 = time.time()
    try:
        tid = submit_task(TEST2_PROMPT, size="1:1", image_urls=[data_url])
        url2 = poll_task(tid)
    except Exception as e:
        print(f"[FAIL test2] {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
    out2 = download(url2, OUT_DIR / "demo_gpt2_test2_dz600m.jpg")
    e2 = round(time.time() - t0, 1)
    print(f"[OK test2] {out2} ({out2.stat().st_size // 1024}KB)  耗时 {e2}s")

    # ── 汇总 ──────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print(f"[OK all] test1 耗时 {e1}s, test2 耗时 {e2}s")
    print(f"  test1 → {out1}")
    print(f"  test2 → {out2}")
    print("=" * 60)


if __name__ == "__main__":
    main()
