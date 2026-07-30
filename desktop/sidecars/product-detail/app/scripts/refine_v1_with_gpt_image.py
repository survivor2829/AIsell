"""v1 精修管线 × gpt-image-2 引擎 (保留 v1 全部拼接逻辑, 只替换生图).

拦截点: ai_image_volcengine.generate_segment + download_image (monkey-patch)
其它完全复用:
  - refine_processor.refine_one_product       v1 主入口, 不动
  - ai_bg_cache.generate_backgrounds          v1 并发 + 缓存 + prompt 模板, 不动
  - _build_ctxs_from_parsed                    v1 ctxs 构造, 不动
  - ai_compose_pipeline.compose_detail_page   v1 Playwright 截图 + 拼接, 不动
  - templates/blocks/*.html                   v1 所有 block 模板, 不动

跑法 (Windows PowerShell, 本地经 Clash):
  $env:GPT_IMAGE_API_KEY="sk-xxx"     # APIMart key
  python scripts/refine_v1_with_gpt_image.py

产物:
  v2_result/ai_refined.jpg                 完整详情页长图 (v1 结构 + gpt-image-2 画质)
  v2_result/_hero_render.html etc          中间 HTML
  v2_result/_summary.json                  成本/耗时/每屏 task_id

预算: 硬上限 ¥20 (6 屏 × ¥0.7 = ~¥4.2, 很充裕)
耗时: 10-15 分钟 (6 张图 × ~45s 并发后约 90s + 拼接)
"""
from __future__ import annotations

# ── 代理 (APIMart 要走, DeepSeek 和下 Seedream 自己关; v1 不调 Seedream 所以不冲突) ──
import os
os.environ.setdefault("HTTP_PROXY", "http://127.0.0.1:7890")
os.environ.setdefault("HTTPS_PROXY", "http://127.0.0.1:7890")

import base64
import json
import mimetypes
import re
import shutil
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT))


# ── 配置 ─────────────────────────────────────────────────────────
APIMART_BASE = "https://api.apimart.ai/v1"
APIMART_MODEL = "gpt-image-2"
APIMART_THINKING = "medium"

POLL_INTERVAL = 3
POLL_TIMEOUT = 240

MAX_TOTAL_COST = 20.0
IMAGE_COST_PER_CALL = 0.70  # gpt-image-2 + thinking=medium

_UA = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# 本地目录
DATA_DIR = _REPO_ROOT / "static" / "uploads" / "smoke_v1gpt" / "DZ600M"
OUT_DIR = _REPO_ROOT / "v2_result"
TMP_DIR = _REPO_ROOT / "static" / "cache" / "ai_bg" / "_gpt_image2_intake"  # 我的 patched segment 下载到这

# 运行时全局计数 (给预算守护)
_TOTAL_COST = 0.0
_GENERATED_URLS = []  # (zone, task_id, prompt_len)


# ── APIMart HTTP 辅助 (走代理) ──────────────────────────────────
def _http_post_json(url: str, payload: dict, api_key: str, timeout: int = 90):
    req = urllib.request.Request(
        url, method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": _UA,
        },
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


def _http_get_json(url: str, api_key: str, timeout: int = 30):
    req = urllib.request.Request(
        url, method="GET",
        headers={"Authorization": f"Bearer {api_key}", "User-Agent": _UA},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _download(url: str, out_path: Path):
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    if len(raw) < 10000:
        raise RuntimeError(f"下载图片过小: {len(raw)} bytes (url={url})")
    out_path.write_bytes(raw)


# ── 尺寸映射 (Seedream w×h → APIMart ratio string) ───────────────
def _map_size_to_ratio(width: int, height: int) -> str:
    """Seedream 用 w×h 像素, APIMart gpt-image-2 用 ratio 字符串.
    选 APIMart 支持的最接近 ratio. 13 种常见比例中挑最合适."""
    if height == 0:
        return "1:1"
    aspect = width / height

    # APIMart 支持的比例 (从近到远查表)
    # 纵横比 → 字符串
    candidates = [
        (9 / 21, "9:21"),     # 0.43
        (9 / 16, "9:16"),     # 0.5625
        (2 / 3,  "2:3"),      # 0.667
        (3 / 4,  "3:4"),      # 0.75
        (4 / 5,  "4:5"),      # 0.8
        (1.0,    "1:1"),      # 1.0
        (5 / 4,  "5:4"),      # 1.25
        (4 / 3,  "4:3"),      # 1.333
        (3 / 2,  "3:2"),      # 1.5
        (16 / 9, "16:9"),     # 1.778
        (21 / 9, "21:9"),     # 2.333
    ]
    best = min(candidates, key=lambda x: abs(x[0] - aspect))
    return best[1]


# ── Monkey-patch: vol.generate_segment → gpt-image-2 ─────────────
def _patched_generate_segment(zone: str, prompt: str, api_key: str,
                              width: int = 768, height: int = 1024,
                              negative_prompt: str = "",
                              reference_image_url: str = "") -> list[str]:
    """替代 Seedream 的 generate_segment.

    - api_key 参数忽略 (那是 ark/豆包 key, 我们用 APIMart).
    - 从 env 读 GPT_IMAGE_API_KEY.
    - 返回 [file:///<local_path>] 让 patched download_image 识别.
    """
    global _TOTAL_COST, _GENERATED_URLS

    # ── 诊断 print: 第一行立即出, 确认 patch 真的被调到 ──
    print(f"\n>>> [PATCHED] generate_segment CALLED for zone={zone!r} "
          f"width={width} height={height} prompt.len={len(prompt)} "
          f"ref={'Y' if reference_image_url else 'N'}")

    apimart_key = os.environ.get("GPT_IMAGE_API_KEY", "").strip()
    if not apimart_key:
        raise RuntimeError("GPT_IMAGE_API_KEY 未配置")

    # 预算守护
    if _TOTAL_COST + IMAGE_COST_PER_CALL > MAX_TOTAL_COST:
        raise RuntimeError(
            f"[BUDGET STOP] 累计 ¥{_TOTAL_COST:.2f} + ¥{IMAGE_COST_PER_CALL:.2f} "
            f"> 上限 ¥{MAX_TOTAL_COST:.2f}"
        )

    size_ratio = _map_size_to_ratio(width, height)

    payload = {
        "model": APIMART_MODEL,
        "prompt": prompt,
        "n": 1,
        "size": size_ratio,
        "thinking": APIMART_THINKING,
        "reasoning_effort": APIMART_THINKING,
    }
    if reference_image_url:
        # Seedream 的 ref 可能是 data:URL 或本地路径; APIMart 只吃 data:URL 或 https URL
        payload["image_urls"] = [reference_image_url]

    print(f"[gpt-image-2][{zone}] {width}x{height} → {size_ratio}  "
          f"prompt.len={len(prompt)}  ref={'Y' if reference_image_url else 'N'}")

    # 提交
    t0 = time.time()
    code, body = _http_post_json(f"{APIMART_BASE}/images/generations", payload, apimart_key)
    if code != 200 or not isinstance(body, dict) or body.get("code") != 200:
        raise RuntimeError(f"[gpt-image-2][{zone}] submit 失败 HTTP {code}: {body}")
    task_id = (body.get("data") or [{}])[0].get("task_id")
    if not task_id:
        raise RuntimeError(f"[gpt-image-2][{zone}] 响应缺 task_id: {body}")
    print(f"[gpt-image-2][{zone}] task_id={task_id}")

    # 轮询
    t_poll = time.time()
    while True:
        if time.time() - t_poll > POLL_TIMEOUT:
            raise TimeoutError(f"[gpt-image-2][{zone}] 轮询超时")
        data = _http_get_json(f"{APIMART_BASE}/tasks/{task_id}?language=en", apimart_key)
        node = data.get("data") or data
        status = node.get("status")
        if status == "completed":
            images = (node.get("result") or {}).get("images") or []
            if not images:
                raise RuntimeError(f"[gpt-image-2][{zone}] completed 但无 images")
            url = images[0].get("url")
            if isinstance(url, list):
                url = url[0] if url else None
            if not url:
                raise RuntimeError(f"[gpt-image-2][{zone}] completed 但无 url")
            break
        if status in ("failed", "cancelled"):
            raise RuntimeError(f"[gpt-image-2][{zone}] 任务 {status}: {node}")
        time.sleep(POLL_INTERVAL)

    # 下载到 TMP_DIR (走代理)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    local_path = TMP_DIR / f"{zone}_{int(time.time() * 1000)}_{task_id[-8:]}.png"
    _download(url, local_path)

    elapsed = round(time.time() - t0, 1)
    _TOTAL_COST += IMAGE_COST_PER_CALL
    _GENERATED_URLS.append({
        "zone": zone, "task_id": task_id, "prompt_len": len(prompt),
        "elapsed_s": elapsed, "local_path": str(local_path),
    })
    print(f"[gpt-image-2][{zone}] OK {elapsed}s · ¥{IMAGE_COST_PER_CALL:.2f} · "
          f"累计 ¥{_TOTAL_COST:.2f} · {local_path.name} "
          f"({local_path.stat().st_size // 1024}KB)")

    # 返回 file:// URL, 让 patched download_image 识别
    return [local_path.as_uri()]


# ── Monkey-patch: vol.download_image → 识别 file:// 走本地复制 ───
_original_generate_segment = None  # 运行时绑定, 用于 restore
_original_download_image = None


def _patched_download_image(url: str, save_dir, filename: str = "") -> str:
    """对 file:// URL 走本地移动 (同盘瞬时 rename); 其它 URL 交还原实现."""
    print(f">>> [PATCHED] download_image CALLED url={url[:80]!r} filename={filename!r}")
    if url and url.startswith("file:"):
        parsed = urllib.parse.urlparse(url)
        src_path = urllib.parse.unquote(parsed.path)
        # Windows file URI: "file:///C:/..." → path = "/C:/...", 去首个 /
        if re.match(r"^/[A-Za-z]:", src_path):
            src_path = src_path[1:]
        src = Path(src_path)
        if not src.is_file():
            print(f"[patched dl] file:// 源不存在: {src}")
            return ""
        save_dir = Path(save_dir)
        save_dir.mkdir(parents=True, exist_ok=True)
        dst = save_dir / (filename or src.name)
        # move 优先: 同盘是 rename 瞬时完成, 跨盘会自动 fallback copy+unlink
        try:
            shutil.move(str(src), str(dst))
        except OSError:
            shutil.copy2(src, dst)  # 极端情况兜底
        return str(dst)
    return _original_download_image(url, save_dir, filename)


# ── 主流程 ──────────────────────────────────────────────────────
def _patch_volcengine():
    """装 monkey-patch. 必须在 import 任何使用 vol 的模块之前调.

    配合 _restore_volcengine 用 try/finally 防异常污染全局 module state.
    """
    global _original_generate_segment, _original_download_image
    import ai_image_volcengine as vol
    _original_generate_segment = vol.generate_segment
    _original_download_image = vol.download_image
    vol.generate_segment = _patched_generate_segment
    vol.download_image = _patched_download_image
    print("[patch] ai_image_volcengine.generate_segment → gpt-image-2")
    print("[patch] ai_image_volcengine.download_image → file:// 感知")

    # ── 诊断 verify: 从 ai_bg_cache 视角确认 patch 生效 ──
    # 如果 ai_bg_cache 持有了 'vol' 引用, 必须跟主模块是同一对象, 且 attr 是我们的 patched 版
    import ai_bg_cache
    assert ai_bg_cache.vol is vol, (
        f"!!! ai_bg_cache.vol ({id(ai_bg_cache.vol)}) "
        f"不是同一个 module ({id(vol)}) — Python 不该出这种事, 检查是否有 reload"
    )
    assert ai_bg_cache.vol.generate_segment is _patched_generate_segment, (
        f"!!! patch 失败: ai_bg_cache.vol.generate_segment = "
        f"{ai_bg_cache.vol.generate_segment} (期望 {_patched_generate_segment})"
    )
    assert ai_bg_cache.vol.download_image is _patched_download_image, (
        f"!!! patch 失败: ai_bg_cache.vol.download_image = "
        f"{ai_bg_cache.vol.download_image}"
    )
    print("[patch] ✓ 从 ai_bg_cache 视角 verified, generate_segment + download_image 都生效")


def _restore_volcengine():
    """还原 ai_image_volcengine 的原函数, 防止脚本崩溃后同进程其它代码用到污染的 module."""
    import ai_image_volcengine as vol
    if _original_generate_segment is not None:
        vol.generate_segment = _original_generate_segment
    if _original_download_image is not None:
        vol.download_image = _original_download_image
    print("[patch] restored vol.generate_segment / download_image")


def main() -> int:
    print("=" * 66)
    print("v1 精修管线 × gpt-image-2 · DZ600M 完整详情页")
    print("=" * 66)

    if not os.environ.get("GPT_IMAGE_API_KEY", "").strip():
        print("[FAIL] GPT_IMAGE_API_KEY 未配置 (APIMart key)")
        return 1

    # 预检数据
    for need in ("parsed.json", "DZ600M.jpg", "product_cut.png"):
        f = DATA_DIR / need
        if not f.is_file():
            print(f"[FAIL] 缺 {f}")
            return 1

    OUT_DIR.mkdir(exist_ok=True)
    print(f"[env] DATA_DIR={DATA_DIR.relative_to(_REPO_ROOT)}")
    print(f"[env] OUT_DIR={OUT_DIR.relative_to(_REPO_ROOT)}")
    print(f"[env] 预算上限: ¥{MAX_TOTAL_COST:.2f}  单张: ¥{IMAGE_COST_PER_CALL:.2f}")

    # 装 patch
    _patch_volcengine()

    # 构造 payload (refine_processor.refine_one_product 的入参)
    # 所有路径走 URL 形式 /uploads/..., refine_processor 会映射到 static/uploads/...
    payload = {
        "name": "DZ600M",
        "main_image_path": "/uploads/smoke_v1gpt/DZ600M/DZ600M.jpg",
        "cutout_path": "/uploads/smoke_v1gpt/DZ600M/product_cut.png",
        "parsed_json_path": "/uploads/smoke_v1gpt/DZ600M/parsed.json",
        "resolved_theme_id": "tech-blue",       # 科技蓝, 跟 DZ600M 调性匹配
        "product_category": "设备类",
    }

    # ark_api_key 参数会被 patched vol 忽略 (内部不再真调豆包), 但 refine_one_product 校验非空
    fake_ark_key = "ark-unused-because-patched-to-gpt-image2"

    # 调 v1 主流程 (无论成败都必须 restore, 防全局污染)
    print("\n" + "─" * 66)
    print("Step: refine_processor.refine_one_product (走 v1 完整流程)")
    print("─" * 66)
    from refine_processor import refine_one_product
    t0 = time.time()
    try:
        try:
            result = refine_one_product(
                scope_id="smoke_v1gpt",
                payload=payload,
                ark_api_key=fake_ark_key,
            )
        except Exception as e:
            traceback.print_exc()
            print(f"\n[FAIL] refine_one_product 抛异常: {type(e).__name__}: {e}")
            return 2
    finally:
        _restore_volcengine()
    total_elapsed = round(time.time() - t0, 1)

    print("\n" + "─" * 66)
    print("Step: 复制产物到 v2_result/")
    print("─" * 66)

    # refine_one_product 的产物落在 product_dir = static/uploads/smoke_v1gpt/DZ600M/
    ai_refined_src = DATA_DIR / "ai_refined.jpg"
    if ai_refined_src.is_file():
        ai_refined_dst = OUT_DIR / "ai_refined.jpg"
        shutil.copy2(ai_refined_src, ai_refined_dst)
        print(f"[copy] {ai_refined_dst.relative_to(_REPO_ROOT)} "
              f"({ai_refined_dst.stat().st_size // 1024}KB)")
    else:
        print(f"[WARN] ai_refined.jpg 未生成, 检查 compose 日志")

    # 复制中间 HTML (给 debug)
    for f in DATA_DIR.glob("_*_render.html"):
        shutil.copy2(f, OUT_DIR / f.name)

    # 汇总
    summary = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_elapsed_s": total_elapsed,
        "total_cost_rmb": round(_TOTAL_COST, 2),
        "images_generated": len(_GENERATED_URLS),
        "gpt_image_model": APIMART_MODEL,
        "thinking": APIMART_THINKING,
        "refine_one_product_result": result,
        "zones": _GENERATED_URLS,
    }
    (OUT_DIR / "_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n" + "=" * 66)
    print(f"[DONE] 总耗时 {total_elapsed}s · 总成本 ¥{_TOTAL_COST:.2f}")
    print(f"[DONE] 生成 {len(_GENERATED_URLS)} 张 AI 背景, 合成 {result.get('segments_count')} 屏")
    print(f"[DONE] 交付: {OUT_DIR / 'ai_refined.jpg'}")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"\n[FATAL] {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
