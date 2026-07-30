"""AI 精修 v2 · Phase 2 W1 Day 1-2 · DeepSeek 规划官分类能力测试.

目标:
  1. 验证 PRD § 3.1/3.2 的 system + user prompt 能让 DeepSeek 稳定输出合规 JSON
  2. 验证 DeepSeek 对 visual_type 的分类准确率 (设备类 / 耗材类 / 工具类 全品类覆盖)
  3. 产出 10 个 JSON 样本给用户 eye-ball review

硬约束:
  - 不动 refine_processor.py
  - 不动 .env (只读 env var)
  - 不改前端
  - 不调 gpt-image-2 (这周不烧图片 API)
  - 预算: DeepSeek 10 次调用约 ¥0.5 上限

跑法 (本地或服务器均可, DeepSeek 国内 API 不走代理):
  # 本地 (需要提供 API key):
  DEEPSEEK_API_KEY=sk-xxxx python scripts/test_deepseek_planner.py

  # 服务器 (用 docker env 里已有的 key):
  docker cp scripts/test_deepseek_planner.py clean-industry-ai-assistant-web-1:/tmp/
  docker exec -e PYTHONPATH=/app clean-industry-ai-assistant-web-1 \
      python3 /tmp/test_deepseek_planner.py

输出:
  docs/PRD_AI_refine_v2/w2_samples/01_device_ds500x.json
  docs/PRD_AI_refine_v2/w2_samples/02_device_hp3000.json
  ... (10 个 JSON)
  docs/PRD_AI_refine_v2/w2_samples/_summary.json (汇总报告)

可选参数:
  --only N       只跑第 N 个产品 (1-10), 用于单点调试
  --dry-run      不真调 API, 只打印 prompt 结构
"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
import time
import traceback
import urllib.request
import urllib.error
from pathlib import Path


# ── 配置 ─────────────────────────────────────────────────────────
API_KEY = os.environ.get("DEEPSEEK_API_KEY", "").strip()
API_URL = "https://api.deepseek.com/v1/chat/completions"
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

# 在 docker 容器里脚本路径是 /tmp/*.py, 产物目录要用绝对路径兜底
DEFAULT_OUT_DIR = Path("docs/PRD_AI_refine_v2/w2_samples")
if not DEFAULT_OUT_DIR.parent.is_dir():
    # 容器内 /app/docs/...
    DEFAULT_OUT_DIR = Path("/app/docs/PRD_AI_refine_v2/w2_samples")
OUT_DIR = DEFAULT_OUT_DIR

TIMEOUT = 120
TEMPERATURE = 0.1
MAX_TOKENS = 4096

# Cloudflare / CN 绕代理 — 参考 app.py:2639
# urllib 不吃 proxies={} 参数; 我们通过 ProxyHandler(None) 显式关闭.


# ── PRD § 3.1 System Prompt · v2 (合并 w1_review §8 补丁 A/B/C/D) ─
SYSTEM_PROMPT = """你是 B2B 工业产品详情页的视觉策划总监。你的任务是把产品文案拆成"卖点 → 视觉"的结构化 JSON, 供下游 gpt-image-2 生图用。

关键原则:
1. 每个卖点必须判定 visual_type (product_in_scene / product_closeup / concept_visual)
2. visual_type 判定依据:
   - 卖点提到"用于/适用/场景/行业/地点" → product_in_scene
   - 卖点提到"结构/部件/涂层/技术/机构/工艺" → product_closeup
   - 卖点提到"续航/噪音/成本/速度/压力/效率等抽象指标" → concept_visual
3. 不能所有卖点都判成 product_in_scene (会重复)
4. 卖点最多 8 个, 超过时按优先级合并低优先级项
5. Hero 场景永远从最高优先级的 product_in_scene 卖点中取
6. 输出纯 JSON, 无额外文字, 不要 ```json 代码块包裹
7. selling_points[].text 必须是产品文案的**逐字连续片段** (或其子串):
   - 不得添加文案中没有的形容词 / 状语 / 程度副词
   - 不得改写同义词 (如 "500kg/m²" 不能写成 "500kg per square meter")
   - 不得合并两条独立卖点成一句 (保留结构, 信息密度均衡)
   反例: 原文"5升蓝色HDPE塑料桶包装"
         ❌ 输出"5升蓝色HDPE塑料桶包装，耐用便携" (加了"耐用便携")
         ✅ 输出"5升蓝色HDPE塑料桶包装" (原文照搬)

常见判定陷阱 — 即使含"适合/适用/可 XX"但 visual_type ≠ product_in_scene:
- "IP54 防尘防水适合室外半户外"   → concept_visual (主语是认证等级)
- "处理风量 900m³/h 适合 150m²"   → concept_visual (主语是性能指标)
- "可机洗可拼接延展"              → concept_visual (主语是功能能力)
- "500kg/m² 抗压可用于车间"       → concept_visual (主语是抗压强度)

判定口诀: 去掉"适合/适用/可"两三个字, 这卖点还在说**具体行业或地点**吗?
- 是 (商场/机场/河道/车间/厨房) → product_in_scene
- 否 (指标/等级/认证/能力)       → concept_visual

品类判定优先级 (冲突时按此顺序):
1. 文案明说"工具 / 设备 / 耗材" → 直接采纳
2. 看**形态**:
   - 便携手持 (< 10kg, 有握把, 人手操作) → 工具类
   - 固定安装 / 推车式 / 大型立柱 (≥ 20kg) → 设备类
   - 液体 / 片状 / 布片 / 膜 / 桶装 / 瓶装 / 喷雾 → 耗材类
3. 10-20kg 中间段: 看用法
   - 单人单手握持 → 工具类
   - 双手推行 / 定点部署 → 设备类
4. 不确定 → 设备类 (详情页视觉默认 fallback)

产品品类映射 (key_visual_parts 必须是 2-4 个**具体可视英文短语**, 不是类别名):

- 设备类 维度(主色机身/主要结构/传感器或显示/驱动或底座):
  示例(扫地机器人): ["matte gray metal body", "circular LiDAR sensor",
                     "bottom brush module", "drive wheels"]

- 耗材类 维度(外观颜色/包装形态/标签印刷/使用状态):
  示例(清洁剂桶): ["blue HDPE drum", "product label with specifications",
                   "sealed cap and handle", "diluted solution pouring"]

- 工具类 维度(主色机身/握把/功能头/控制按钮):
  示例(抛光机): ["orange-black plastic body", "ergonomic rubber handle",
                 "7-inch sponge pad", "speed control dial"]

⚠️ 禁止把维度类别名 (如 "color" / "packaging" / "grip" / "texture" /
"usage_state") 当 phrase 填入. 看到这类通用词**必须**换成具体英文短语,
例如 "color" → "matte yellow aluminum body", "grip" → "black ergonomic rubber handle".

若文案未明确颜色 (primary_color), 按品类推断合理默认值:
- 商用清洁机 → "matte gray" / "industrial gray"
- 工业重型设备 → "industrial yellow" / "safety orange"
- 家电型工具 → "matte white" / "glossy white"
- 化学耗材 → 按包装颜色 (HDPE 桶/PET 瓶/透明喷雾)
- 工具类 → "orange-black" / "red-black" (典型手持工具配色)
"""


# ── PRD § 3.2 User Prompt 模板 ───────────────────────────────────
USER_PROMPT_TEMPLATE = """产品文案:
\"\"\"
{product_text}
\"\"\"

产品图: (暂无, 请从文案和品类推断视觉特征)

用户 UI 勾选:
- 强制 VS 对比屏: {force_vs}
- 强制多场景屏:   {force_scenes}
- 强制规格参数表: {force_specs}

请输出 JSON, schema 如下 (严格遵循, 输出纯 JSON 不要加 ```json 包裹):

{{
  "product_meta": {{
    "name": "string, 产品名 + 型号 + 一句话描述, < 40 字",
    "category": "enum: 设备类 | 耗材类 | 工具类",
    "primary_color": "string, 英文色彩名, 如 'industrial yellow'",
    "key_visual_parts": ["string, 英文 phrase, 2-4 个"],
    "proportions": "string, 英文 phrase"
  }},
  "selling_points": [
    {{
      "idx": 1,
      "text": "原文关键句, 30 字内",
      "visual_type": "enum: product_in_scene | product_closeup | concept_visual",
      "priority": "enum: high | medium | low",
      "reason": "判定依据, 一句话"
    }}
  ],
  "planning": {{
    "total_blocks": "int",
    "block_order": ["hero", "selling_point_X", ...],
    "hero_scene_hint": "string, 英文, < 60 字, 从最高优先级 product_in_scene 卖点提取"
  }}
}}"""


# ── W2 · 5 个精准陷阱 case (对应 w1_review.md §9, 验证补丁 A/B/C/D) ──
# 每个 case 刻意打中一个 P0/P1 bug, ground truth 和"测什么"见注释
PRODUCTS = [
    # Case 11 · 测补丁 D 品类判定 (3kg 便携手持 → 工具类)
    {
        "id": 1, "cat": "tool", "slug": "pc80",
        "name": "PC-80 便携手持工业吸尘器",
        "text": (
            "PC-80 便携手持工业吸尘器, 亮黑色机身配橙色按钮, "
            "1200W 电机吸力 20kPa, "
            "单手提握 3kg 整机重, "
            "HEPA 过滤 99.97%, "
            "2 米长软管 + 4 种刷头, "
            "适用于车间地面 / 办公室死角 / 汽车内饰, "
            "续航 45 分钟."
        ),
    },
    # Case 12 · 测补丁 A key_visual_parts 具体化 (多色可选 + 通用包装)
    {
        "id": 2, "cat": "consumable", "slug": "ww20",
        "name": "WW-20 多色玻璃水液体",
        "text": (
            "WW-20 多色玻璃水液体, 500ml PET 透明喷雾瓶, "
            "柠檬黄 / 天空蓝 / 粉玫红三色可选, "
            "中性配方 pH7, "
            "一喷即净不留水痕, "
            "适用于家用车挡风 / 商用洗车店 / 办公楼落地窗."
        ),
    },
    # Case 13 · 测补丁 C 边界陷阱 (IP66/40L/2-8bar 三条含"适合/可"都应是 concept)
    {
        "id": 3, "cat": "device", "slug": "dr600",
        "name": "DR-600 商用洗地机",
        "text": (
            "DR-600 商用洗地机, 哑光蓝金属机身, "
            "IP66 防尘防水等级适合室外, "
            "40L 水箱适合 2000m² 连续作业, "
            "可调压力 2-8bar 适应不同地面, "
            "续航 4 小时, "
            "低噪音 < 58dB 适用于商场和写字楼, "
            "附带 3 种刷盘."
        ),
    },
    # Case 14 · 回归测 MF-50 bug (补丁 A 修: 不应再留 color/texture 占位)
    {
        "id": 4, "cat": "consumable", "slug": "cm50",
        "name": "CM-50 微纤维清洁布",
        "text": (
            "CM-50 微纤维清洁布, 35×35cm 5 色可选, "
            "80% 聚酯 + 20% 锦纶, 280gsm 克重厚实, "
            "吸水量自身 6 倍, "
            "机洗 300 次不变形, "
            "适用于餐饮后厨 / 医院病房 / 酒店客房."
        ),
    },
    # Case 15 · 测补丁 D 品类临界 (15kg 推车式 → 双手推行 → 设备类)
    {
        "id": 5, "cat": "device", "slug": "fs300",
        "name": "FS-300 半便携推车式扫地机",
        "text": (
            "FS-300 半便携推车式扫地机, 哑光灰金属, "
            "整机 15kg 带万向轮, "
            "人工推行或一键电动行进, "
            "24V 锂电续航 3 小时, "
            "吸力 8000Pa, "
            "适用于小型车间和商铺."
        ),
    },
]


# ── HTTP 调用 (urllib + 显式关代理, 兜底 DeepSeek 国内直连) ──────
def _http_post_nojproxy(url: str, body: dict) -> tuple[int, dict | str]:
    """POST JSON, 显式关代理 (不吃 HTTP_PROXY/HTTPS_PROXY)."""
    # 显式 ProxyHandler({}) 关闭代理
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(
        url, method="POST",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "ai-refine-v2-planner-test/1.0",
        },
    )
    try:
        with opener.open(req, timeout=TIMEOUT) as r:
            raw = r.read().decode("utf-8")
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, body


# ── DeepSeek 调用 + JSON 解析 ────────────────────────────────────
def call_deepseek(product: dict, user_opts: dict) -> dict:
    user_prompt = USER_PROMPT_TEMPLATE.format(
        product_text=product["text"],
        force_vs=str(user_opts.get("force_vs", False)).lower(),
        force_scenes=str(user_opts.get("force_scenes", False)).lower(),
        force_specs=str(user_opts.get("force_specs", False)).lower(),
    )

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
    }

    print(f"[POST] {API_URL}  product={product['slug']}  cat={product['cat']}")
    t0 = time.time()
    code, body = _http_post_nojproxy(API_URL, payload)
    elapsed = round(time.time() - t0, 2)
    print(f"[resp] HTTP {code}  {elapsed}s")

    if code != 200 or not isinstance(body, dict):
        raise RuntimeError(f"HTTP {code}: {body}")

    msg = body["choices"][0]["message"]
    raw = (msg.get("content") or "").strip()
    usage = body.get("usage", {})
    print(f"[usage] prompt={usage.get('prompt_tokens')} "
          f"completion={usage.get('completion_tokens')} "
          f"total={usage.get('total_tokens')}")

    # 剥离 ```json ... ``` 代码块
    if "```" in raw:
        m = re.search(r"```(?:json)?\s*([\s\S]+?)```", raw)
        if m:
            raw = m.group(1).strip()

    # 兜底: 从首个 { 截取
    if not raw.startswith("{"):
        start = raw.find("{")
        if start >= 0:
            raw = raw[start:]

    parsed = json.loads(raw)
    return {
        "_meta": {
            "product_slug": product["slug"],
            "product_cat": product["cat"],
            "elapsed_s": elapsed,
            "usage": usage,
            "model": MODEL,
        },
        "planner_output": parsed,
    }


# ── 后验: JSON schema 合规性检查 ─────────────────────────────────
def validate_schema(parsed: dict) -> list[str]:
    """返回 warning 列表, 空表示完全合规."""
    warnings = []
    po = parsed.get("planner_output", {})

    # product_meta
    pm = po.get("product_meta") or {}
    for k in ("name", "category", "primary_color", "key_visual_parts", "proportions"):
        if not pm.get(k):
            warnings.append(f"product_meta.{k} 缺失")
    if pm.get("category") not in ("设备类", "耗材类", "工具类"):
        warnings.append(f"product_meta.category 非法: {pm.get('category')!r}")

    # selling_points
    sps = po.get("selling_points") or []
    if not sps:
        warnings.append("selling_points 为空")
    elif len(sps) > 8:
        warnings.append(f"selling_points 超上限 {len(sps)} > 8")

    type_counts = {"product_in_scene": 0, "product_closeup": 0, "concept_visual": 0}
    for i, sp in enumerate(sps):
        vt = sp.get("visual_type")
        if vt not in type_counts:
            warnings.append(f"selling_points[{i}].visual_type 非法: {vt!r}")
        else:
            type_counts[vt] += 1
        if sp.get("priority") not in ("high", "medium", "low"):
            warnings.append(f"selling_points[{i}].priority 非法: {sp.get('priority')!r}")

    # 单类型独大检查 (超过 80% 就警告)
    total_sps = len(sps)
    if total_sps >= 4:
        for vt, cnt in type_counts.items():
            if cnt / total_sps > 0.8:
                warnings.append(f"visual_type 过度集中: {vt} 占 {cnt}/{total_sps}")

    # planning
    pl = po.get("planning") or {}
    if not pl.get("total_blocks"):
        warnings.append("planning.total_blocks 缺失")
    if not pl.get("block_order"):
        warnings.append("planning.block_order 缺失")
    if not pl.get("hero_scene_hint"):
        warnings.append("planning.hero_scene_hint 缺失")

    return warnings


# ── 主流程 ──────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=int, help="只跑第 N 个 (1-10)")
    ap.add_argument("--dry-run", action="store_true", help="只打 prompt 不调 API")
    args = ap.parse_args()

    if not args.dry_run and not API_KEY:
        print("[FAIL] DEEPSEEK_API_KEY 未配置"); sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[env] OUT_DIR={OUT_DIR.resolve()}")
    print(f"[env] MODEL={MODEL}  API={API_URL}")
    print(f"[env] API_KEY: {'已配置 len=' + str(len(API_KEY)) if API_KEY else '未配置'}")

    # 默认 UI 选项 (全否, 纯卖点驱动)
    user_opts = {"force_vs": False, "force_scenes": False, "force_specs": False}

    products = PRODUCTS
    if args.only:
        if not 1 <= args.only <= len(PRODUCTS):
            print(f"[FAIL] --only 范围 1-{len(PRODUCTS)}"); sys.exit(1)
        products = [PRODUCTS[args.only - 1]]

    if args.dry_run:
        print("\n── DRY RUN: system + user[0] prompt 预览 ──")
        print("[SYSTEM]", SYSTEM_PROMPT[:300], "...")
        print("[USER]", USER_PROMPT_TEMPLATE.format(
            product_text=products[0]["text"],
            force_vs="false", force_scenes="false", force_specs="false",
        )[:500], "...")
        return

    summary = {
        "ran_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "model": MODEL,
        "total": len(products),
        "results": [],
    }
    total_tokens = 0
    ok_count = 0
    total_warnings = 0

    for p in products:
        print(f"\n{'=' * 66}")
        print(f"[{p['id']:>2}/{len(PRODUCTS)}] {p['name']} ({p['cat']})")
        print("=" * 66)
        out_file = OUT_DIR / f"{p['id']:02d}_{p['cat']}_{p['slug']}.json"

        entry = {
            "id": p["id"], "slug": p["slug"], "cat": p["cat"],
            "out_file": out_file.name,
        }

        try:
            parsed = call_deepseek(p, user_opts)
            warnings = validate_schema(parsed)
            parsed["_meta"]["schema_warnings"] = warnings
            out_file.write_text(json.dumps(parsed, ensure_ascii=False, indent=2),
                                encoding="utf-8")
            ok_count += 1
            total_warnings += len(warnings)
            total_tokens += parsed["_meta"]["usage"].get("total_tokens", 0)

            entry["ok"] = True
            entry["warnings_count"] = len(warnings)
            entry["warnings"] = warnings
            entry["tokens"] = parsed["_meta"]["usage"].get("total_tokens")
            entry["visual_type_dist"] = {
                vt: sum(1 for sp in parsed["planner_output"].get("selling_points", [])
                        if sp.get("visual_type") == vt)
                for vt in ("product_in_scene", "product_closeup", "concept_visual")
            }

            print(f"[OK] → {out_file.name}  warnings={len(warnings)}  "
                  f"dist={entry['visual_type_dist']}")
            for w in warnings:
                print(f"     ⚠ {w}")

        except Exception as e:
            entry["ok"] = False
            entry["error"] = f"{type(e).__name__}: {e}"
            print(f"[FAIL] {entry['error']}")
            traceback.print_exc()

        summary["results"].append(entry)

    # 汇总
    summary["ok_count"] = ok_count
    summary["fail_count"] = len(products) - ok_count
    summary["total_tokens"] = total_tokens
    # DeepSeek 官方价: input ¥0.001/K / output ¥0.002/K. 粗估 token 按平均单价 ¥0.0015/K
    summary["estimated_cost_rmb"] = round(total_tokens * 0.0015 / 1000, 4)
    summary["total_schema_warnings"] = total_warnings

    (OUT_DIR / "_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n" + "=" * 66)
    print(f"[DONE] ok={ok_count}/{len(products)}  warnings={total_warnings}  "
          f"tokens={total_tokens}  est_cost≈¥{summary['estimated_cost_rmb']}")
    print(f"[DONE] 样本目录: {OUT_DIR.resolve()}")
    print("=" * 66)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[FATAL] {type(e).__name__}: {e}")
        traceback.print_exc()
        sys.exit(1)
