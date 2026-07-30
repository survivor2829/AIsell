"""AI 精修 v2 · 最小端到端 smoke test (今天就要看到真实图).

流程: DeepSeek 规划 → 逐 block 渲染 prompt → 调 gpt-image-2 → 保存 JPG

不做: 并发 / 占位降级 / 前端 / 拼接 / WebSocket. 失败直接 raise.

跑法 (Windows PowerShell, 本地环境, 经 Clash):
    $env:DEEPSEEK_API_KEY="sk-xxx"          # DeepSeek key
    $env:GPT_IMAGE_API_KEY="sk-xxx"         # APIMart key (跟 demo v2 一样)
    python scripts/smoke_test_refine_v2.py

产物:
    ./smoke_output_v2/block_01_product_in_scene.jpg   (hero)
    ./smoke_output_v2/block_02_product_closeup.jpg
    ./smoke_output_v2/block_NN_xxxx.jpg
    ./smoke_output_v2/_summary.json

硬预算: 超 ¥5 立即停 (raise, 不继续烧).
"""
from __future__ import annotations

# ── 代理 (只影响 APIMart; DeepSeek 在 refine_planner 里强制关代理, 不受此影响) ──
import os
os.environ.setdefault("HTTP_PROXY", "http://127.0.0.1:7890")
os.environ.setdefault("HTTPS_PROXY", "http://127.0.0.1:7890")

import json
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

# 让 scripts/ 下脚本能 import 到仓库根下的 ai_refine_v2
_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT))

from ai_bg_cache import _to_data_url as _bg_to_data_url
from ai_refine_v2.prompts.generator import render
from ai_refine_v2.refine_planner import PlannerError, plan


# ── 配置 ─────────────────────────────────────────────────────────
DZ600M_TEXT = (
    "DZ600M 无人水面清洁机, 工业黄色机身配黑色螺旋履带浮筒, "
    "螺旋清污机构清污效率提升 3 倍, "
    "续航 8 小时一天不充电, "
    "适用于城市河道 / 工厂污水池 / 景区湖泊, "
    "防腐涂层 5 年不锈, "
    "低噪音运行不打扰居民."
)

DZ600M_IMAGE = (
    _REPO_ROOT / "uploads" / "batches" / "batch_20260420_019_3932" /
    "测试" / "DZ600M无人水面清洁机新品1" / "product_cut.png"
)

OUT_DIR = _REPO_ROOT / "smoke_output_v2"

# APIMart gpt-image-2
APIMART_BASE = "https://api.apimart.ai/v1"
APIMART_MODEL = "gpt-image-2"
APIMART_THINKING = "medium"   # +50% 成本换 +3 分质量 (PRD 决策)
APIMART_SIZE = "1:1"

# 成本 (¥)
DEEPSEEK_COST = 0.05
IMAGE_COST_PER_CALL = 0.70  # gpt-image-2 + thinking=medium
MAX_TOTAL_COST = 5.00       # 硬上限

# 轮询
POLL_INTERVAL = 3
POLL_TIMEOUT = 240

# Cloudflare 403 兜底 UA
_UA = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


# ── 工具 ────────────────────────────────────────────────────────
# base64 data URL 复用 ai_bg_cache._to_data_url (原版支持 data:/http 透传 + 相对路径 resolve)


def _http_post_json(url: str, payload: dict, api_key: str, timeout: int = 90) -> tuple[int, dict | str]:
    """POST JSON, 用默认 urllib (读环境变量 HTTP_PROXY)."""
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


def _http_get_json(url: str, api_key: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(
        url, method="GET",
        headers={"Authorization": f"Bearer {api_key}", "User-Agent": _UA},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ── APIMart gpt-image-2 封装 ────────────────────────────────────
def _submit_image_task(prompt: str, image_data_url: str | None, api_key: str) -> str:
    payload = {
        "model": APIMART_MODEL,
        "prompt": prompt,
        "n": 1,
        "size": APIMART_SIZE,
        "thinking": APIMART_THINKING,
        "reasoning_effort": APIMART_THINKING,
    }
    if image_data_url:
        payload["image_urls"] = [image_data_url]

    code, body = _http_post_json(f"{APIMART_BASE}/images/generations", payload, api_key)
    if code != 200 or not isinstance(body, dict) or body.get("code") != 200:
        raise RuntimeError(f"APIMart 提交失败 HTTP {code}: {body}")
    tasks = body.get("data") or []
    if not tasks or not tasks[0].get("task_id"):
        raise RuntimeError(f"APIMart 响应缺 task_id: {body}")
    return tasks[0]["task_id"]


def _poll_image_task(task_id: str, api_key: str) -> str:
    t0 = time.time()
    while True:
        elapsed = time.time() - t0
        if elapsed > POLL_TIMEOUT:
            raise TimeoutError(f"APIMart 轮询超时 {POLL_TIMEOUT}s, task_id={task_id}")
        data = _http_get_json(f"{APIMART_BASE}/tasks/{task_id}?language=en", api_key)
        node = data.get("data") or data
        status = node.get("status")
        if status == "completed":
            images = (node.get("result") or {}).get("images") or []
            if not images:
                raise RuntimeError(f"APIMart completed 但无 images: {node}")
            url = images[0].get("url")
            if isinstance(url, list):
                url = url[0] if url else None
            if not url:
                raise RuntimeError(f"APIMart completed 但无 url: {images}")
            return url
        if status in ("failed", "cancelled"):
            raise RuntimeError(f"APIMart 任务 {status}: {node}")
        time.sleep(POLL_INTERVAL)


def _download(url: str, out_path: Path) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    if len(raw) < 10000:
        raise RuntimeError(f"下载图片过小: {len(raw)} bytes")
    out_path.write_bytes(raw)
    return out_path


# ── 核心: 从 planning 构造 blocks 并渲染 prompt ──────────────────
def _build_blocks(planning_json: dict) -> list[dict]:
    """展开 planning.block_order → [{block_id, visual_type, is_hero, selling_point}, ...]"""
    sps_by_idx = {sp["idx"]: sp for sp in planning_json.get("selling_points", [])}
    pl = planning_json["planning"]
    result = []
    for bid in pl.get("block_order", []):
        if bid == "hero":
            result.append({
                "block_id": "hero",
                "visual_type": "product_in_scene",
                "is_hero": True,
                "selling_point": None,
            })
        elif bid.startswith("selling_point_"):
            try:
                idx = int(bid.split("_")[-1])
            except ValueError:
                continue
            sp = sps_by_idx.get(idx)
            if not sp:
                continue
            result.append({
                "block_id": bid,
                "visual_type": sp["visual_type"],
                "is_hero": False,
                "selling_point": sp,
            })
    return result


def _render_prompt_for_block(block: dict, planning_json: dict) -> str:
    """按 visual_type 调对应 Jinja2 模板. 全部参数从 planning 取."""
    pm = planning_json["product_meta"]
    pl = planning_json["planning"]
    vt = block["visual_type"]

    if vt == "product_in_scene":
        if block["is_hero"]:
            scene = pl.get("hero_scene_hint") or "product in application scene"
            sp_for_context = {"text": "hero shot"}
            human_hint = "operator with tablet reviewing real-time data"
        else:
            sp = block["selling_point"]
            scene = sp.get("text") or "product in scene"
            sp_for_context = sp
            human_hint = ""
        return render("product_in_scene",
                      product=pm, scene=scene, hero=block["is_hero"],
                      human_hint=human_hint, selling_point=sp_for_context)

    if vt == "product_closeup":
        sp = block["selling_point"]
        # focus_part: 优先用 key_visual_parts 的首条英文 phrase (更适合特写)
        # 否则回退用卖点 text (中文也可, gpt-image-2 能理解)
        key_parts = pm.get("key_visual_parts") or []
        focus_part = (key_parts[0] if key_parts else None) or sp.get("text", "key part")
        return render("product_closeup", product=pm, focus_part=focus_part)

    if vt == "concept_visual":
        return render("concept_visual", selling_point=block["selling_point"])

    raise ValueError(f"unknown visual_type: {vt}")


# ── 主流程 ──────────────────────────────────────────────────────
def main() -> int:
    print("=" * 66)
    print("AI 精修 v2 · DZ600M 端到端 smoke test")
    print("=" * 66)

    # 预检
    if not os.environ.get("DEEPSEEK_API_KEY", "").strip():
        print("[FAIL] DEEPSEEK_API_KEY 未配置")
        return 1
    apimart_key = os.environ.get("GPT_IMAGE_API_KEY", "").strip()
    if not apimart_key:
        print("[FAIL] GPT_IMAGE_API_KEY 未配置 (APIMart key)")
        return 1
    if not DZ600M_IMAGE.is_file():
        print(f"[FAIL] 产品图不存在: {DZ600M_IMAGE}")
        return 1

    OUT_DIR.mkdir(exist_ok=True)
    print(f"[env] OUT_DIR={OUT_DIR}")
    print(f"[env] 代理: HTTP_PROXY={os.environ.get('HTTP_PROXY')}")
    print(f"[env] 预算上限: ¥{MAX_TOTAL_COST:.2f}")

    total_cost = 0.0
    t_start = time.time()
    summary = {"blocks": []}

    # ── Step 1 · DeepSeek 规划 ──────────────────────
    print("\n" + "─" * 66)
    print("Step 1 · DeepSeek 规划 (DZ600M)")
    print("─" * 66)
    t0 = time.time()
    try:
        planning_json = plan(product_text=DZ600M_TEXT)
    except PlannerError as e:
        print(f"[FAIL] DeepSeek 规划失败: {e}")
        return 1
    plan_elapsed = round(time.time() - t0, 1)
    total_cost += DEEPSEEK_COST
    print(f"[ok] 规划 {plan_elapsed}s, ¥{DEEPSEEK_COST:.2f}, "
          f"category={planning_json['product_meta']['category']}, "
          f"{len(planning_json['selling_points'])} 卖点")

    # 保存 planning 给后续 review
    (OUT_DIR / "_planning.json").write_text(
        json.dumps(planning_json, ensure_ascii=False, indent=2), encoding="utf-8")

    # ── Step 2 · 准备产品图 base64 ──────────────────
    image_data_url = _bg_to_data_url(str(DZ600M_IMAGE))
    print(f"[env] 参考图: {DZ600M_IMAGE.name} ({DZ600M_IMAGE.stat().st_size // 1024}KB)"
          f"  base64 长度={len(image_data_url):,}")

    # ── Step 3 · 串行生成每个 block ─────────────────
    blocks = _build_blocks(planning_json)
    print(f"\n[env] 计划生成 {len(blocks)} 个 block:")
    for i, b in enumerate(blocks, 1):
        print(f"  {i:>2}. {b['block_id']:<20} visual_type={b['visual_type']}")

    est_total = total_cost + IMAGE_COST_PER_CALL * len(blocks)
    print(f"[env] 预估总成本 ¥{est_total:.2f} (当前 ¥{total_cost:.2f} + "
          f"{len(blocks)}×¥{IMAGE_COST_PER_CALL:.2f})")
    if est_total > MAX_TOTAL_COST:
        print(f"[WARN] 预估超上限 ¥{MAX_TOTAL_COST:.2f}, 将按 block 逐个检查, 超即停")

    print("\n" + "─" * 66)
    print("Step 3 · 串行生成")
    print("─" * 66)

    for i, block in enumerate(blocks, 1):
        # 预算检查 — 下一张会不会超?
        if total_cost + IMAGE_COST_PER_CALL > MAX_TOTAL_COST:
            raise RuntimeError(
                f"[BUDGET STOP] 累计 ¥{total_cost:.2f} + 下一张 ¥{IMAGE_COST_PER_CALL:.2f} "
                f"> 上限 ¥{MAX_TOTAL_COST:.2f}; 已生成 {i-1} 张, 见 {OUT_DIR}"
            )

        # 渲染 prompt
        try:
            prompt = _render_prompt_for_block(block, planning_json)
        except Exception as e:
            raise RuntimeError(f"block {i} prompt 渲染失败: {type(e).__name__}: {e}")

        # product_in_scene / product_closeup → 图生图 (传 base64)
        # concept_visual → 纯文生图 (不传)
        use_image = block["visual_type"] in ("product_in_scene", "product_closeup")
        image_arg = image_data_url if use_image else None

        t0 = time.time()
        print(f"\n[{i}/{len(blocks)}] {block['block_id']} · {block['visual_type']} · "
              f"{'图生图' if use_image else '文生图'} · prompt.len={len(prompt)}")
        task_id = _submit_image_task(prompt, image_arg, apimart_key)
        print(f"         task_id={task_id}")
        img_url = _poll_image_task(task_id, apimart_key)
        out_path = OUT_DIR / f"block_{i:02d}_{block['visual_type']}.jpg"
        _download(img_url, out_path)
        total_cost += IMAGE_COST_PER_CALL
        elapsed = round(time.time() - t0, 1)
        print(f"         [ok] {elapsed}s · ¥{IMAGE_COST_PER_CALL:.2f} · "
              f"累计 ¥{total_cost:.2f} → {out_path.name} ({out_path.stat().st_size // 1024}KB)")
        summary["blocks"].append({
            "i": i, "block_id": block["block_id"],
            "visual_type": block["visual_type"], "file": out_path.name,
            "elapsed_s": elapsed, "task_id": task_id,
        })

    # ── Step 4 · 汇总 ──────────────────────────────
    total_elapsed = round(time.time() - t_start, 1)
    summary.update({
        "total_cost_rmb": round(total_cost, 2),
        "total_elapsed_s": total_elapsed,
        "deepseek_cost_rmb": DEEPSEEK_COST,
        "image_cost_per_call": IMAGE_COST_PER_CALL,
        "model": APIMART_MODEL,
        "thinking": APIMART_THINKING,
    })
    (OUT_DIR / "_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n" + "=" * 66)
    print(f"[DONE] 总耗时 {total_elapsed}s  总成本 ¥{total_cost:.2f}")
    print(f"[DONE] 产物目录: {OUT_DIR}")
    for b in summary["blocks"]:
        print(f"  {b['i']:>2}. {b['file']}  ({b['visual_type']}, {b['elapsed_s']}s)")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"\n[FATAL] {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
