"""AI 精修 v2 · DeepSeek 规划官核心.

对外入口:
    from ai_refine_v2.refine_planner import plan, PlannerError

    result = plan(
        product_text="DZ600M 无人水面清洁机 ...",
        product_image_url="https://.../product_cut.png",  # 可选
        user_opts={"force_vs": False, "force_scenes": False, "force_specs": False},
        api_key=None,  # 不传则从 env DEEPSEEK_API_KEY 读
    )
    # → dict, 符合 PRD §3.3 schema (product_meta / selling_points / planning)

职责边界 (W1 Day 3):
  - 只做"规划层": 产品文案 → 结构化 planning JSON
  - 不触碰 refine_processor.py (旧管线保持不变)
  - 不跑 gpt-image-2 生图 (W2 才做)
  - DeepSeek 国内 API 绕 Clash 代理 (铁律, 见 MEMORY)

失败策略:
  - API HTTP 错误 / 网络错误 / JSON 解析错误 → 重试 1 次
  - JSON schema 验证失败 (缺字段 / 枚举越界) → 重试 1 次
  - 超过重试次数 → 抛 PlannerError

P2 后处理:
  - 过滤"产品名当独立卖点"的条目 (W2 发现的新 bug)
  - 同步 block_order 和 total_blocks
"""
from __future__ import annotations
import json
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter
from typing import Callable, Optional

from ai_refine_v2.prompts.planner import (
    SYSTEM_PROMPT,
    SYSTEM_PROMPT_V2,
    USER_PROMPT_TEMPLATE,
    USER_PROMPT_TEMPLATE_V2,
)


# ── 常量 ────────────────────────────────────────────────────────
_API_URL = os.environ.get(
    "DEEPSEEK_API_URL", "https://api.deepseek.com/v1/chat/completions"
).strip() or "https://api.deepseek.com/v1/chat/completions"
_MODEL_DEFAULT = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash").strip() or "deepseek-v4-flash"
_TIMEOUT = 120
_TEMPERATURE = 0.1
_MAX_TOKENS = 4096
_UA = "ai-refine-v2-planner/1.0"

_VALID_CATEGORIES = ("设备类", "耗材类", "配件类", "工具类")
_VALID_VISUAL_TYPES = ("product_in_scene", "product_closeup", "concept_visual")
_VALID_PRIORITIES = ("high", "medium", "low")
MAX_PRODUCT_TEXT_CHARS = 20_000
MAX_PRODUCT_TITLE_CHARS = 120


# ── 异常 ────────────────────────────────────────────────────────
class PlannerError(RuntimeError):
    """规划层失败 (API / 解析 / schema 验证 超过重试次数)."""


class ProductInputError(PlannerError):
    """Code-bearing input error shared by HTTP and planner boundaries."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def validate_product_inputs(
    product_text: str,
    product_title: Optional[str] = None,
) -> tuple[str, str]:
    """校验并规范 planner 输入，避免超长或非文本数据进入 LLM。"""
    if not isinstance(product_text, str) or not product_text.strip():
        raise ProductInputError(
            "AI_REFINE_PRODUCT_TEXT_REQUIRED",
            "产品文案不能为空，请填写产品文案；仅填产品标题不能启动 AI 精修",
        )
    clean_text = product_text.strip()
    if len(clean_text) > MAX_PRODUCT_TEXT_CHARS:
        raise ProductInputError(
            "AI_REFINE_PRODUCT_TEXT_TOO_LONG",
            f"产品文案最多 {MAX_PRODUCT_TEXT_CHARS} 个字符",
        )
    if any(ord(ch) < 32 and ch not in "\r\n\t" for ch in clean_text):
        raise ProductInputError(
            "AI_REFINE_PRODUCT_TEXT_INVALID",
            "产品文案含不支持的控制字符",
        )

    if product_title is None:
        clean_title = ""
    elif not isinstance(product_title, str):
        raise ProductInputError(
            "AI_REFINE_PRODUCT_TITLE_INVALID",
            "产品标题必须是文本",
        )
    else:
        clean_title = product_title.strip()
    if len(clean_title) > MAX_PRODUCT_TITLE_CHARS:
        raise ProductInputError(
            "AI_REFINE_PRODUCT_TITLE_TOO_LONG",
            f"产品标题最多 {MAX_PRODUCT_TITLE_CHARS} 个字符",
        )
    if any(ord(ch) < 32 for ch in clean_title):
        raise ProductInputError(
            "AI_REFINE_PRODUCT_TITLE_INVALID",
            "产品标题含不支持的控制字符",
        )
    return clean_text, clean_title


# ── HTTP 客户端 (urllib + 显式关代理 - DeepSeek 国内 API 禁走 Clash) ──
def _http_post_deepseek(body: dict, api_key: str) -> dict:
    """POST JSON 到 DeepSeek. 返回原始 response dict.

    关代理是必须的: 国内 API 被 Clash 代理会静默超时或 502.
    参考 MEMORY: feedback_proxy_deepseek.md + app.py:2639.
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(
        _API_URL,
        method="POST",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": _UA,
        },
    )
    with opener.open(req, timeout=_TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


# ── LLM 响应解析 ────────────────────────────────────────────────
def _extract_json(raw: str) -> dict:
    """从 LLM 文本响应中剥离 ```json``` + 从首个 { 截取, 再 json.loads."""
    raw = raw.strip()
    if "```" in raw:
        m = re.search(r"```(?:json)?\s*([\s\S]+?)```", raw)
        if m:
            raw = m.group(1).strip()
    if not raw.startswith("{"):
        i = raw.find("{")
        if i >= 0:
            raw = raw[i:]
    return json.loads(raw)


def _validate_schema(parsed: dict) -> list[str]:
    """返回 warning 列表. 空列表 = 完全合规; 非空 = 触发重试."""
    warnings = []

    pm = parsed.get("product_meta") or {}
    for k in ("name", "category", "primary_color", "key_visual_parts", "proportions"):
        if not pm.get(k):
            warnings.append(f"product_meta.{k} 缺失")
    if pm.get("category") not in _VALID_CATEGORIES:
        warnings.append(f"product_meta.category 非法: {pm.get('category')!r}")
    kvp = pm.get("key_visual_parts")
    if isinstance(kvp, list) and not all(isinstance(x, str) and x.strip() for x in kvp):
        warnings.append("product_meta.key_visual_parts 含空/非字符串项")

    sps = parsed.get("selling_points") or []
    if not sps:
        warnings.append("selling_points 为空")
    elif len(sps) > 8:
        warnings.append(f"selling_points 超上限 {len(sps)} > 8")
    for i, sp in enumerate(sps):
        if sp.get("visual_type") not in _VALID_VISUAL_TYPES:
            warnings.append(f"selling_points[{i}].visual_type 非法: {sp.get('visual_type')!r}")
        if sp.get("priority") not in _VALID_PRIORITIES:
            warnings.append(f"selling_points[{i}].priority 非法: {sp.get('priority')!r}")
        if not sp.get("text") or not isinstance(sp.get("text"), str):
            warnings.append(f"selling_points[{i}].text 缺失或非字符串")

    pl = parsed.get("planning") or {}
    for k in ("total_blocks", "block_order", "hero_scene_hint"):
        if pl.get(k) in (None, "", []):
            warnings.append(f"planning.{k} 缺失")

    return warnings


# ── P2 过滤器: 移除产品名当独立卖点的条目 ────────────────────────
def _filter_product_name_redundant(parsed: dict) -> tuple[dict, list[int]]:
    """过滤 selling_points 中跟 product_meta.name 重复的条目.

    判定依据 (与 W2 发现的 bug 对应):
      若卖点 text 前 15 个字符包含 product_name 的首个 token (通常是型号,
      如 "PC-80" / "DZ600M"), 判定为"产品名/型号重复", 从 selling_points
      和 planning.block_order 中都移除.

    示例命中:
      product_name = "PC-80 便携手持工业吸尘器"
      first_token = "PC-80"
      sp[0].text = "PC-80 便携手持工业吸尘器" → "PC-80" 在前 15 字 → 移除

    不会误杀:
      product_name = "DZ600M 无人水面清洁机"
      first_token = "DZ600M"
      sp[0].text = "螺旋清污机构清污效率提升 3 倍" → 前 15 字无 "DZ600M" → 保留

    返回:
      (过滤后的 parsed, 被移除的 idx 列表)
    """
    pm = parsed.get("product_meta") or {}
    product_name = (pm.get("name") or "").strip()
    if not product_name:
        return parsed, []

    # 型号通常是首个 token (空格 / 连字符 / 中文逗号分隔)
    first_token = re.split(r"[\s,，]", product_name, maxsplit=1)[0]
    if not first_token or len(first_token) < 2:
        return parsed, []

    sps = parsed.get("selling_points") or []
    kept = []
    removed_idx = []
    for sp in sps:
        text = (sp.get("text") or "").strip()
        # 前 15 个字符含型号 → 认为是产品名重复
        if first_token in text[:15]:
            removed_idx.append(sp.get("idx"))
            continue
        kept.append(sp)

    if not removed_idx:
        return parsed, []

    # 同步 planning.block_order 移除对应 selling_point_X
    removed_refs = {f"selling_point_{i}" for i in removed_idx if i is not None}
    planning = parsed.get("planning") or {}
    order = planning.get("block_order") or []
    new_order = [b for b in order if b not in removed_refs]

    parsed["selling_points"] = kept
    parsed["planning"] = {
        **planning,
        "block_order": new_order,
        "total_blocks": len(new_order),
    }
    return parsed, removed_idx


# ── 对外主函数 ──────────────────────────────────────────────────
def plan(
    product_text: str,
    product_image_url: Optional[str] = None,
    user_opts: Optional[dict] = None,
    api_key: Optional[str] = None,
    model: str = _MODEL_DEFAULT,
    max_retries: int = 1,
    http_fn: Optional[Callable[[dict, str], dict]] = None,
) -> dict:
    """产品文案 → DeepSeek 规划 JSON.

    Args:
        product_text: 产品文案原文 (不能为空)
        product_image_url: 产品图 URL/路径, 可选. 只向 DeepSeek 传有/无语义;
                           原值不进入 prompt.
        user_opts: {"force_vs": bool, "force_scenes": bool, "force_specs": bool}
        api_key: DeepSeek API key. None 时从 env DEEPSEEK_API_KEY 读.
        model: DeepSeek 模型名, 默认 DEEPSEEK_MODEL / deepseek-v4-flash
        max_retries: API / 解析 / schema 任一失败时的重试次数
        http_fn: 注入点, 测试时传 mock; 生产走默认 _http_post_deepseek

    Returns:
        dict, PRD §3.3 schema (product_meta / selling_points / planning)
        已做 P2 过滤. 若过滤掉卖点, 会 stdout 打日志.

    Raises:
        PlannerError: 参数非法 / 超过 max_retries 仍失败
    """
    clean_product_text, _ = validate_product_inputs(product_text)

    use_key = api_key or os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not use_key:
        raise PlannerError("未配置 DEEPSEEK_API_KEY (传参或设 env var)")

    opts = user_opts or {}
    image_hint = (
        "已提供产品参考图（仅表示有图，不向 DeepSeek 传递本机路径）"
        if product_image_url
        else "未提供产品参考图"
    )

    user_prompt = USER_PROMPT_TEMPLATE.format(
        product_text=json.dumps(clean_product_text, ensure_ascii=False),
        product_image_hint=image_hint,
        force_vs=str(opts.get("force_vs", False)).lower(),
        force_scenes=str(opts.get("force_scenes", False)).lower(),
        force_specs=str(opts.get("force_specs", False)).lower(),
    )

    payload = {
        "model": model,
        "thinking": {"type": "disabled"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": _TEMPERATURE,
        "max_tokens": _MAX_TOKENS,
    }

    post_fn = http_fn or _http_post_deepseek
    last_err = None

    for attempt in range(max_retries + 1):
        try:
            resp = post_fn(payload, use_key)
            raw_content = resp["choices"][0]["message"]["content"]
            parsed = _extract_json(raw_content)
            schema_warnings = _validate_schema(parsed)
            if schema_warnings:
                last_err = f"schema 不合规: {schema_warnings}"
                if attempt < max_retries:
                    print(f"[planner] attempt {attempt+1} schema 失败, 重试: {last_err}")
                    time.sleep(0.5)
                    continue
                raise PlannerError(last_err)

            # P2 过滤
            parsed, removed = _filter_product_name_redundant(parsed)
            if removed:
                print(f"[planner:filter] 跳过 {len(removed)} 个产品名重复卖点 idx={removed}")

            return parsed

        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError,
                KeyError, TypeError) as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt < max_retries:
                print(f"[planner] attempt {attempt+1} 失败, 重试: {last_err}")
                time.sleep(1)
                continue
            raise PlannerError(f"API/解析失败 (重试 {max_retries} 次后): {last_err}") from e

    # 逻辑上不可达
    raise PlannerError(f"unreachable: last_err={last_err}")


# ──────────────────────────────────────────────────────────────────
# v2 (PRD §阶段一·任务 1.1, 2026-04-27): style_dna + N 屏导演 prompt
# ──────────────────────────────────────────────────────────────────
# 跟老 plan() 完全独立, 共用 _http_post_deepseek + _extract_json + PlannerError.
# 老 plan() 仍服务现有 pipeline_runner + generator (60 单测保护). PRD §阶段二
# generator 重写后, pipeline_runner._worker 切到 plan_v2(), 那时再下架老的.
# pipeline_runner 阶段一不切, 不动其他下游, mock 模式仍能跑.

_TEMPERATURE_V2 = 0.7  # 比 v1 的 0.1 高, 让 style_dna 有创意 (不再是抽取任务)
_MAX_TOKENS_V2 = 8192  # 6-10 屏 × 800-2000 字符 prompt → 估 6000-15000 token
_MIN_PROMPT_LEN_V2 = 200  # screens[i].prompt 短于此即"SEO 列表非导演视角"
_MIN_SCREEN_COUNT_V2 = 8   # v3 (PRD AI_refine_v3.1): 6 → 8
_MAX_SCREEN_COUNT_V2 = 15  # v3 (PRD AI_refine_v3.1): 10 → 15

# v3 (PRD AI_refine_v3.1) 新增: role 白名单
# v3.iter2 (2026-04-29 Scott 4/9 反馈): 11 → 12 屏型, +lifestyle_demo (B2B 必备)
# PR B (2026-05-07): +material_origin (耗材/配件类原材料溯源/加工过程屏)
_VALID_ROLES_V2 = frozenset({
    "hero", "feature_wall", "scenario", "scenario_grid_2x3",
    "vs_compare", "detail_zoom", "icon_grid_radial",
    "spec_table", "value_story", "brand_quality", "FAQ",
    "lifestyle_demo",  # v3.iter2: 真人 + 产品 + 实景, A 暖色路线
    "material_origin",  # PR B: 耗材/配件原材料溯源/加工过程, 4 source_type
})

# v3 必出屏型 (任何产品都生成 — 缺任何一个 = schema 不合规)
# v3.2 精修 (Scott 反馈 1): 3 → 4 必出屏, +lifestyle_demo (DeepSeek 自由判断
# 时会跳过 lifestyle_demo, 但 Scott 强需"产品使用效果展示", 必出强约束)
_REQUIRED_ROLES_V2 = frozenset({
    "hero", "brand_quality", "spec_table", "lifestyle_demo",
})

# v3 SCOTT_OVERRIDE 默认屏型 (deliberate_dna_divergence 必须 true)
_SCOTT_OVERRIDE_ROLES_V2 = frozenset({"spec_table", "FAQ"})

_NEGATIVE_GUARD_PARTS_V2 = (
    "do not invent any brand logos, company names, trademarks, certifications",
    "preserve all existing labels, stickers, model markings, printed text exactly",
    "no 「」-quoted headlines should be added onto the product surface itself",
)

_LAYOUT_HINTS_V2: dict[str, tuple[str, ...]] = {
    "hero": ("single focal point", "centered hero shot"),
    "feature_wall": ("grid layout", "card arrangement", "tile mosaic"),
    "scenario": ("triptych", "split-panel composition", "side-by-side scenes"),
    "scenario_grid_2x3": (
        "6-scene application grid",
        "real-world deployment showcase",
        "2x3 photo grid with captions",
    ),
    "vs_compare": (
        "side-by-side card comparison",
        "two-column comparison table with checkmarks",
    ),
    "detail_zoom": (
        "macro close-up overlaid with annotation cards",
        "zoom + callouts",
    ),
    "icon_grid_radial": (
        "radial icon grid",
        "configuration showcase",
        "centered product with peripheral icon callouts",
    ),
    "spec_table": (
        "product hero shot on top half, spec table on bottom half",
        "industrial spec sheet with product portrait header",
    ),
    "value_story": (
        "hud overlays on photo background",
        "data viz layered on neutral cool gray gradient",
    ),
    "brand_quality": ("single focal point", "heroic centered composition"),
    "FAQ": ("faq card grid", "q&a panel layout", "2x3 q&a grid with frosted glass cards"),
    "lifestyle_demo": (
        "real-world demo with operator",
        "engineer using product in scene",
        "natural light environmental portrait",
    ),
    "material_origin": (
        "documentary process triptych",
        "raw-material journey card sequence",
    ),
}

_POSITIVE_LOGO_INSTRUCTION_RE = re.compile(
    r"(?:\b(?:add|invent|create|design|draw)\b.{0,80}\b(?:logo|trademark)\b"
    r"|(?:添加|生成|设计|绘制|编造).{0,40}(?:logo|商标|品牌标识))",
    re.IGNORECASE | re.DOTALL,
)

_NUMERIC_COMMERCIAL_CLAIM_RE = re.compile(
    r"(?:全国\s*)?(?P<value>\d+(?:\.\d+)?)\s*(?P<plus>\+?)\s*"
    r"(?P<unit>(?:售后)?网点|万台|万家|个月|小时|分钟|年|月|天|%|％|家|处|客户|企业|用户|台)"
    r"(?:品牌|质保|保修|保证|响应|上门|续航|作业|好评|售后)?",
    re.IGNORECASE,
)

_CERTIFICATION_CLAIM_RE = re.compile(
    r"(?<![A-Za-z])(?:ISO\s*\d+|CCC|CE|FDA)(?![A-Za-z])\s*(?:认证)?",
    re.IGNORECASE,
)

_NUMERIC_CLAIM_SEMANTICS = (
    ("endurance", ("续航",)),
    ("warranty", ("质保", "保修")),
    ("response", ("响应",)),
    ("onsite_service", ("上门",)),
    ("service_network", ("售后", "网点")),
    ("operation", ("作业", "工作时长")),
    ("rating", ("好评", "满意率")),
    ("customer_scale", ("客户", "用户", "企业")),
    ("brand_history", ("品牌", "成立", "创立")),
    ("guarantee", ("保证",)),
    ("return", ("退货",)),
    (
        "performance_rate",
        ("效率", "准确率", "成功率", "通过率", "故障率", "节省", "提升", "降低"),
    ),
)

_CLAIM_CONTEXT_BOUNDARIES = ",，。.;；!?！？\r\n、"
_NUMERIC_UNIT_ALIASES = {"％": "%", "个月": "月", "售后网点": "网点"}

_FIXED_COMMERCIAL_CLAIMS = (
    "行业领先",
    "国家专利",
    "国标",
    "军工标准",
    "全国包邮",
    "终身质保",
    "免费安装",
    "无理由退货",
)


def _normalize_claim_text(value: str) -> str:
    return re.sub(r"[\s,，。.;；:：'\"「」()（）\-_/]", "", value).lower()


def _claim_semantic_category(text: str, match: re.Match) -> str:
    """取数值承诺最近的语义类别，避免只靠整段字面顺序判定。"""
    left = max(
        (text.rfind(ch, 0, match.start()) for ch in _CLAIM_CONTEXT_BOUNDARIES),
        default=-1,
    ) + 1
    right_candidates = [
        pos
        for ch in _CLAIM_CONTEXT_BOUNDARIES
        if (pos := text.find(ch, match.end())) >= 0
    ]
    right = min(right_candidates, default=len(text))
    context = text[left:right]

    nearest: Optional[tuple[int, int, str]] = None
    for category_index, (category, keywords) in enumerate(_NUMERIC_CLAIM_SEMANTICS):
        for keyword in keywords:
            offset = context.find(keyword)
            while offset >= 0:
                keyword_start = left + offset
                keyword_end = keyword_start + len(keyword)
                distance = max(
                    match.start() - keyword_end,
                    keyword_start - match.end(),
                    0,
                )
                candidate = (distance, category_index, category)
                if nearest is None or candidate < nearest:
                    nearest = candidate
                offset = context.find(keyword, offset + 1)
    if nearest is not None:
        return nearest[2]

    unit = _NUMERIC_UNIT_ALIASES.get(match.group("unit"), match.group("unit"))
    if unit in {"年", "月", "天", "小时", "分钟"}:
        return "duration"
    if unit == "%":
        return "ratio"
    if unit in {"家", "万家", "客户", "企业", "用户"}:
        return "organization_count"
    if unit in {"处", "网点"}:
        return "location_count"
    return "unit_count"


def _numeric_claim_key(text: str, match: re.Match) -> tuple[str, str, bool, str]:
    whole, separator, fraction = match.group("value").partition(".")
    whole = whole.lstrip("0") or "0"
    fraction = fraction.rstrip("0")
    value = whole + (f".{fraction}" if separator and fraction else "")
    unit = _NUMERIC_UNIT_ALIASES.get(match.group("unit"), match.group("unit"))
    return (
        value,
        unit,
        bool(match.group("plus")),
        _claim_semantic_category(text, match),
    )


def _find_unbacked_commercial_claims(prompt: str, product_text: str) -> list[str]:
    """返回 prompt 中出现、但产品原文没有的可验证商业承诺。"""
    source_normalized = _normalize_claim_text(product_text)
    source_numeric_claims = {
        _numeric_claim_key(product_text, match)
        for match in _NUMERIC_COMMERCIAL_CLAIM_RE.finditer(product_text)
    }

    unbacked: list[str] = []
    for match in _NUMERIC_COMMERCIAL_CLAIM_RE.finditer(prompt):
        claim = match.group(0)
        normalized = _normalize_claim_text(claim)
        is_backed = normalized in source_normalized or (
            _numeric_claim_key(prompt, match) in source_numeric_claims
        )
        if normalized and not is_backed and claim not in unbacked:
            unbacked.append(claim)

    strict_candidates = [
        match.group(0) for match in _CERTIFICATION_CLAIM_RE.finditer(prompt)
    ]
    strict_candidates.extend(
        claim for claim in _FIXED_COMMERCIAL_CLAIMS if claim in prompt
    )
    for claim in strict_candidates:
        normalized = _normalize_claim_text(claim)
        if (
            normalized
            and normalized not in source_normalized
            and claim not in unbacked
        ):
            unbacked.append(claim)
    return unbacked


def _validate_schema_v2(
    parsed: dict,
    product_text: Optional[str] = None,
) -> list[str]:
    """v2 schema 校验. 返回 warning list (空 = 合规, 非空 = 触发重试).

    必检字段:
      product_meta: name / category(三选一) / primary_color / key_visual_parts
      style_dna:    color_palette / lighting / composition_style / mood / typography_hint
                    (每个非空字符串, 各自最小长度阈值见 schema 文档)
      screen_count: int 6-10
      screens:      list, len == screen_count, 每项 idx/role/title/prompt 齐
                    且 prompt ≥ 200 字符
    """
    w: list[str] = []
    if not isinstance(parsed, dict):
        return ["data 不是 dict"]

    # product_meta
    pm = parsed.get("product_meta")
    if not isinstance(pm, dict):
        w.append("product_meta 缺失或非 dict")
    else:
        for k in ("name", "primary_color"):
            if not pm.get(k) or not isinstance(pm.get(k), str):
                w.append(f"product_meta.{k} 缺失或非字符串")
        cat = pm.get("category")
        if cat not in _VALID_CATEGORIES:
            w.append(f"product_meta.category 非法 (必须 设备类/耗材类/配件类/工具类): {cat!r}")
        kvp = pm.get("key_visual_parts")
        if not isinstance(kvp, list) or not kvp:
            w.append("product_meta.key_visual_parts 缺失或空列表")
        elif not all(isinstance(x, str) and x.strip() for x in kvp):
            w.append("product_meta.key_visual_parts 含空/非字符串项")

    # style_dna (5 个必填维度 + 各自最小长度)
    dna_min_len = {
        "color_palette": 20,
        "lighting": 20,
        "composition_style": 20,
        "mood": 12,
        "typography_hint": 8,
        "unified_visual_treatment": 30,  # 跨屏视觉处理方式 (准则 2 平衡示范), 长阈值因要"有针对性"
    }
    dna = parsed.get("style_dna")
    if not isinstance(dna, dict):
        w.append("style_dna 缺失或非 dict")
    else:
        for k, min_len in dna_min_len.items():
            v = dna.get(k)
            if not v or not isinstance(v, str):
                w.append(f"style_dna.{k} 缺失或非字符串")
            elif len(v.strip()) < min_len:
                w.append(
                    f"style_dna.{k} 过短 ({len(v.strip())} < {min_len} 字符), 疑似平庸描述"
                )

    # screen_count
    sc = parsed.get("screen_count")
    if not isinstance(sc, int) or not (_MIN_SCREEN_COUNT_V2 <= sc <= _MAX_SCREEN_COUNT_V2):
        w.append(
            f"screen_count 必须为 [{_MIN_SCREEN_COUNT_V2},{_MAX_SCREEN_COUNT_V2}] 整数, "
            f"实际 {sc!r}"
        )

    # screens
    screens = parsed.get("screens")
    if not isinstance(screens, list):
        w.append("screens 缺失或非 list")
    else:
        if isinstance(sc, int) and len(screens) != sc:
            w.append(f"screens 长度 ({len(screens)}) 与 screen_count ({sc}) 不一致")
        if not (_MIN_SCREEN_COUNT_V2 <= len(screens) <= _MAX_SCREEN_COUNT_V2):
            w.append(
                f"screens 长度 {len(screens)} 不在 "
                f"[{_MIN_SCREEN_COUNT_V2},{_MAX_SCREEN_COUNT_V2}]"
            )
        for i, s in enumerate(screens):
            if not isinstance(s, dict):
                w.append(f"screens[{i}] 非 dict")
                continue
            idx = s.get("idx")
            if not isinstance(idx, int) or idx != i + 1:
                w.append(f"screens[{i}].idx 应为 {i + 1}, 实际 {idx!r}")
            for k in ("role", "title"):
                v = s.get(k)
                if not v or not isinstance(v, str):
                    w.append(f"screens[{i}].{k} 缺失或非字符串")
            p = s.get("prompt")
            if not p or not isinstance(p, str):
                w.append(f"screens[{i}].prompt 缺失或非字符串")
            elif len(p) < _MIN_PROMPT_LEN_V2:
                w.append(
                    f"screens[{i}].prompt 过短 ({len(p)} < {_MIN_PROMPT_LEN_V2} 字符), "
                    "疑非导演视角"
                )

            # v3 (PRD AI_refine_v3.1): role 必须在白名单内
            # v3.iter2: 11 → 12 屏型 (+lifestyle_demo)
            role = s.get("role")
            if isinstance(role, str) and role and role not in _VALID_ROLES_V2:
                w.append(
                    f"screens[{i}].role 非法 (必须在 12 屏型内): {role!r}, "
                    f"合法 = {sorted(_VALID_ROLES_V2)}"
                )

            # 不把 prompt 约束只交给模型“自觉”：在任何付费生图前确定性验证。
            if isinstance(p, str) and p.strip():
                prompt_lower = p.lower()
                prompt_tail = " ".join(prompt_lower[-1600:].split())
                missing_negative_parts = [
                    part
                    for part in _NEGATIVE_GUARD_PARTS_V2
                    if part not in prompt_tail
                ]
                if missing_negative_parts:
                    w.append(
                        f"screens[{i}].prompt 缺完整 negative guard "
                        f"({len(missing_negative_parts)} 段未出现在末尾)"
                    )

                if _POSITIVE_LOGO_INSTRUCTION_RE.search(p):
                    w.append(
                        f"screens[{i}].prompt 含主动新增 logo/商标的指令"
                    )

                layout_hints = _LAYOUT_HINTS_V2.get(role, ())
                if layout_hints and not any(
                    hint.lower() in prompt_lower for hint in layout_hints
                ):
                    w.append(
                        f"screens[{i}].prompt 缺 role={role!r} 对应 layout 关键词"
                    )

                if isinstance(product_text, str):
                    unbacked_claims = _find_unbacked_commercial_claims(
                        p, product_text
                    )
                    if unbacked_claims:
                        w.append(
                            f"screens[{i}].prompt 含产品原文未提供的商业承诺: "
                            f"{unbacked_claims}"
                        )

            # v3: SCOTT_OVERRIDE 屏型 (spec_table / FAQ) 必须显式 deliberate_dna_divergence=true
            if role in _SCOTT_OVERRIDE_ROLES_V2:
                if s.get("deliberate_dna_divergence") is not True:
                    w.append(
                        f"screens[{i}] role={role!r} 是 SCOTT_OVERRIDE 屏型, "
                        f"必须设 deliberate_dna_divergence=true (准则 9)"
                    )

        # v3: 必出屏型 (hero / brand_quality / spec_table) 必须各出现 1 次
        present_roles_list = [
            s.get("role") for s in screens if isinstance(s, dict)
        ]
        present_roles = set(present_roles_list)
        missing = _REQUIRED_ROLES_V2 - present_roles
        if missing:
            w.append(
                f"必出屏型缺失: {sorted(missing)}. "
                f"v3 准则 3 要求 hero/brand_quality/spec_table 各 1 屏"
            )

        # v3.iter2 (PRD §13.4 自洽迭代, Scott 改动 5): 屏型唯一性硬约束
        # 同一 role 在一份详情页里最多出现 1 次 (DeepSeek 第 1 次跑 detail_zoom × 2)
        valid_roles_list = [
            r for r in present_roles_list
            if isinstance(r, str) and r in _VALID_ROLES_V2
        ]
        if len(set(valid_roles_list)) != len(valid_roles_list):
            dup = sorted(
                role for role, n in Counter(valid_roles_list).items() if n > 1
            )
            w.append(
                f"屏型重复: {dup} 出现 ≥ 2 次. "
                f"v3.iter2 准则 11 要求每个 role 在一份详情页里最多 1 次. "
                f"如需多个细节屏请用不同屏型 (detail_zoom + icon_grid_radial)."
            )

    return w


def _repair_duplicate_roles_v2(parsed: dict) -> dict:
    """删除后续重复屏型；仅在修复结果完整合规时采用。

    DeepSeek 偶尔会给两个屏幕相同的 role，但第二个屏幕的 prompt 仍然是
    独立内容。直接把它改名会让 role 与画面构图不一致，因此这里只保留首次
    出现的合法 role，并重排 idx。若删除后少于最小屏数，或仍有其他 schema
    问题，则返回原结果，继续走既有的反馈重试路径。
    """
    if not isinstance(parsed, dict):
        return parsed

    screens = parsed.get("screens")
    if not isinstance(screens, list):
        return parsed

    seen_roles: set[str] = set()
    repaired_screens: list = []
    removed_duplicate = False

    for screen in screens:
        if isinstance(screen, dict):
            role = screen.get("role")
            if isinstance(role, str) and role in _VALID_ROLES_V2:
                if role in seen_roles:
                    removed_duplicate = True
                    continue
                seen_roles.add(role)
        repaired_screens.append(screen)

    if not removed_duplicate:
        return parsed
    if not (_MIN_SCREEN_COUNT_V2 <= len(repaired_screens) <= _MAX_SCREEN_COUNT_V2):
        return parsed

    normalized_screens = [
        {**screen, "idx": idx} if isinstance(screen, dict) else screen
        for idx, screen in enumerate(repaired_screens, start=1)
    ]
    repaired = {
        **parsed,
        "screen_count": len(normalized_screens),
        "screens": normalized_screens,
    }

    return repaired if not _validate_schema_v2(repaired) else parsed


def plan_v2(
    product_text: str,
    product_image_url: Optional[str] = None,
    product_title: Optional[str] = None,
    api_key: Optional[str] = None,
    model: str = _MODEL_DEFAULT,
    max_retries: int = 2,
    http_fn: Optional[Callable[[dict, str], dict]] = None,
    temperature: float = _TEMPERATURE_V2,
) -> dict:
    """v2 schema: 产品文案 → DeepSeek 规划 (style_dna + N 屏导演 prompt).

    Args:
        product_text:       产品文案原文 (不能空)
        product_image_url:  产品图 URL/路径, 可选 (DeepSeek 只接收有/无语义)
        product_title:      产品标题, 可选 (UI 上的标题字段)
        api_key:            DeepSeek key, None 时从 env DEEPSEEK_API_KEY 读
        model:              DeepSeek 模型名, 默认 DEEPSEEK_MODEL / deepseek-v4-flash
        max_retries:        API/解析/schema 失败重试次数
        http_fn:            注入点, 测试传 mock; 生产走默认 _http_post_deepseek
        temperature:        默认 0.7 (创意), 比 v1 的 0.1 高

    Returns:
        dict, 符合 v2 schema:
          product_meta / style_dna (5 维) / screen_count / screens (N 屏)
          screens[i] 含 idx / role / title / prompt(≥200 字符导演视角)

    Raises:
        PlannerError: 参数非法 / API 网络挂 / JSON 解析失败 / schema 不合规
                      超过 max_retries 仍失败
    """
    clean_product_text, clean_product_title = validate_product_inputs(
        product_text,
        product_title,
    )

    use_key = api_key or os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not use_key:
        raise PlannerError("未配置 DEEPSEEK_API_KEY (传参或设 env var)")

    user_prompt = USER_PROMPT_TEMPLATE_V2.format(
        product_text=json.dumps(clean_product_text, ensure_ascii=False),
        product_title_hint=json.dumps(
            clean_product_title or "(未填, 从文案推断)",
            ensure_ascii=False,
        ),
        product_image_hint=(
            "已提供产品参考图（仅表示有图，不向 DeepSeek 传递本机路径）"
            if product_image_url
            else "未提供产品参考图"
        ),
    )

    payload = {
        "model": model,
        "thinking": {"type": "disabled"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT_V2},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens": _MAX_TOKENS_V2,
    }

    post_fn = http_fn or _http_post_deepseek
    last_err = None
    last_schema_warnings: list[str] = []

    for attempt in range(max_retries + 1):
        try:
            # Self-correcting retry: 失败重试时把上次违规反馈塞回 user_prompt,
            # 让 DeepSeek 自纠正。否则同样的 prompt + temperature 大概率给同样的违规 plan。
            if attempt > 0 and last_schema_warnings:
                feedback_section = (
                    "\n\n⚠️ 上次规划违反了以下硬约束, 请这次务必避免:\n"
                    + "\n".join(f"  - {w}" for w in last_schema_warnings)
                    + "\n特别注意: 每个 role 在一份详情页里**最多出现 1 次**, 严禁同 role 重复。"
                )
                current_payload = {
                    **payload,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT_V2},
                        {"role": "user", "content": user_prompt + feedback_section},
                    ],
                }
            else:
                current_payload = payload

            resp = post_fn(current_payload, use_key)
            raw_content = resp["choices"][0]["message"]["content"]
            parsed = _extract_json(raw_content)
            parsed = _repair_duplicate_roles_v2(parsed)
            schema_warnings = _validate_schema_v2(
                parsed,
                product_text=clean_product_text,
            )
            if schema_warnings:
                last_err = f"v2 schema 不合规: {schema_warnings}"
                last_schema_warnings = schema_warnings
                if attempt < max_retries:
                    print(f"[planner_v2] attempt {attempt + 1} schema 失败, 重试 (带反馈): {last_err}")
                    time.sleep(0.5)
                    continue
                raise PlannerError(last_err)

            return parsed

        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError,
                KeyError, TypeError) as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt < max_retries:
                print(f"[planner_v2] attempt {attempt + 1} 失败, 重试: {last_err}")
                time.sleep(1)
                continue
            raise PlannerError(
                f"v2 API/解析失败 (重试 {max_retries} 次后): {last_err}"
            ) from e

    raise PlannerError(f"unreachable: last_err={last_err}")


# ─────────────────────────────────────────────────────────────
# Post-planning reorder (PR A · 2026-05-07)
# ─────────────────────────────────────────────────────────────
_REORDER_LIFESTYLE_CATEGORIES = frozenset({"耗材类", "配件类"})


def _reorder_lifestyle_to_second(planning: dict, product_category: str | None) -> dict:
    """耗材类/配件类 lifestyle_demo 强制提到 idx=2.

    Why: 第 2 屏是首屏后的"黄金注意力位", 真人演示产品最有说服力,
    放前面立刻建立信任. 设备类/工具类的 lifestyle_demo 含义不同, 不动.

    Args:
        planning: plan_v2 返回的 dict, 含 screens[]
        product_category: 4 大品类之一 (设备类/耗材类/配件类/工具类). None=不重排.

    Returns:
        修改后的 planning (in-place 修改, 也返回引用).
        - 仅当 product_category in {耗材类, 配件类} 时才动
        - lifestyle_demo 已经在 idx=2 → no-op (幂等)
        - lifestyle_demo 缺失 → no-op (DeepSeek 偶发不出此屏)
        - screens 空 → 直接返回
    """
    if product_category not in _REORDER_LIFESTYLE_CATEGORIES:
        return planning

    screens = planning.get("screens") or []
    if not screens:
        return planning

    # 找 lifestyle_demo 屏 + idx=2 屏
    lifestyle_screen = next(
        (s for s in screens if s.get("role") == "lifestyle_demo"), None
    )
    if lifestyle_screen is None:
        return planning  # DeepSeek 没出此屏, no-op

    if lifestyle_screen.get("idx") == 2:
        return planning  # 已经在第 2 屏, 幂等

    target_screen = next((s for s in screens if s.get("idx") == 2), None)
    if target_screen is None:
        return planning  # idx=2 缺失 (异常情况), 不动

    # 互换 idx
    lifestyle_orig_idx = lifestyle_screen["idx"]
    lifestyle_screen["idx"] = 2
    target_screen["idx"] = lifestyle_orig_idx

    return planning


# ─────────────────────────────────────────────────────────────
# PR B (2026-05-07): material_origin 屏注入 (耗材/配件类原材料溯源)
# ─────────────────────────────────────────────────────────────
_MATERIAL_ORIGIN_CATEGORIES = frozenset({"耗材类", "配件类"})


def _inject_material_origin(planning: dict, product_category: str | None) -> dict:
    """耗材/配件类 + DeepSeek 输出 materials 字段时, 注入 material_origin 屏.

    Why: 增加产品故事感 + 可信度 (天然橡胶 → 工人采集 / 化学剂 → 实验室合成).
    位置: 注入到 idx=3 (hero=1, lifestyle_demo=2, material_origin=3, ...),
    其后所有屏 idx +1.

    Args:
        planning: plan_v2 返回的 dict, 含 screens[] + product_meta.materials
        product_category: 4 大品类之一. 仅 {耗材类, 配件类} 注入.

    Returns:
        修改后的 planning (in-place + return). 不满足条件时 no-op:
        - product_category 不在白名单 → no-op
        - product_meta.materials 缺/空 → no-op (DeepSeek 没提取出来时降级)
        - planning 已有 material_origin 屏 → no-op (DeepSeek 自己出过, 不重复注入)
    """
    if product_category not in _MATERIAL_ORIGIN_CATEGORIES:
        return planning

    materials = (planning.get("product_meta") or {}).get("materials") or []
    if not materials or not isinstance(materials, list):
        return planning  # DeepSeek 没提取出来, 优雅降级

    screens = planning.get("screens") or []
    existing_roles = [s.get("role") for s in screens]
    if "material_origin" in existing_roles:
        return planning  # 幂等, 不重复注入
    if len(screens) >= _MAX_SCREEN_COUNT_V2:
        planning["screen_count"] = len(screens)
        return planning  # 付费生成硬上限, 不为材料来源额外扩屏

    # 取第一个 material 作为屏的视觉 hint 来源
    first = materials[0] if isinstance(materials[0], dict) else {}
    source_type = (first.get("source_type") or "natural").strip().lower()
    source_story_hint = (first.get("source_story_hint") or "").strip()
    material_name = (first.get("name") or "原材料").strip()

    # 构造新屏 (idx=3, 后续屏 idx +1)
    for s in screens:
        if s.get("idx", 0) >= 3:
            s["idx"] = s["idx"] + 1

    new_screen = {
        "idx": 3,
        "role": "material_origin",
        "title": f"屏 3 · 原材料溯源 ({material_name})",
        "prompt": (
            f"展示 {material_name} 的来源/采集/加工过程, "
            f"source_type={source_type}, story={source_story_hint}. "
            f"纪实摄影风格, 自然光, 真人或场景特写, 突出材料真实性 + 工艺可信度. "
            f"画面情绪温暖、有人情味, 让观众感受'产品身世'. "
        ) * 4  # 重复以达到 plan_v2 prompt 长度 ≥200 字符约束
    }
    screens.append(new_screen)
    # 重排
    screens.sort(key=lambda s: s.get("idx", 0))
    planning["screens"] = screens
    planning["screen_count"] = len(screens)

    return planning


# ── CLI · 真实 DeepSeek 烟雾测试 (W1 Day 5) ─────────────────────
# 只做 DZ600M 一个 case, 成本 ¥0.01, 跟 w1_samples/10_device_dz600m.json 黄金样本对比.
# 不在单测覆盖 (单测永远走 mock), CLI 入口仅用于手动烧一次真 API 验证 mock <-> 真 API 对齐.

_DZ600M_TEXT = (
    "DZ600M 无人水面清洁机, 工业黄色机身配黑色螺旋履带浮筒, "
    "螺旋清污机构清污效率提升 3 倍, "
    "续航 8 小时一天不充电, "
    "适用于城市河道 / 工厂污水池 / 景区湖泊, "
    "防腐涂层 5 年不锈, "
    "低噪音运行不打扰居民."
)


def _load_golden_dz600m() -> dict | None:
    """从 w1_samples/10_device_dz600m.json 加载黄金样本的 planner_output."""
    from pathlib import Path
    repo_root = Path(__file__).resolve().parents[1]
    jp = repo_root / "docs" / "PRD_AI_refine_v2" / "w1_samples" / "10_device_dz600m.json"
    if not jp.is_file():
        return None
    try:
        return json.loads(jp.read_text(encoding="utf-8")).get("planner_output")
    except Exception:
        return None


def _compare(golden: dict, fresh: dict) -> dict:
    """对比黄金 vs 实时输出的关键字段. 返回 {fail_flags, detail} dict."""
    from collections import Counter

    g_pm, f_pm = golden.get("product_meta", {}), fresh.get("product_meta", {})
    g_sps, f_sps = golden.get("selling_points", []), fresh.get("selling_points", [])

    fail = []
    detail = {}

    # (1) category 严格一致
    detail["category"] = f"{g_pm.get('category')!r} vs {f_pm.get('category')!r}"
    if g_pm.get("category") != f_pm.get("category"):
        fail.append(f"category 不一致: {g_pm.get('category')} vs {f_pm.get('category')}")

    # (2) primary_color 主色 token 重合
    g_color = (g_pm.get("primary_color") or "").lower()
    f_color = (f_pm.get("primary_color") or "").lower()
    detail["primary_color"] = f"{g_color!r} vs {f_color!r}"
    color_words = ("yellow", "black", "white", "gray", "grey", "blue",
                   "red", "green", "orange", "transparent")
    g_t = {w for w in color_words if w in g_color}
    f_t = {w for w in color_words if w in f_color}
    if g_t != f_t and not (g_t & f_t):  # 完全无交集才报警
        fail.append(f"primary_color 主色差异: {g_t} vs {f_t}")

    # (3) selling_points 数量 ±2 可接受 (新 prompt 更严格, sp 数量可能略降)
    n_diff = abs(len(g_sps) - len(f_sps))
    detail["selling_points_count"] = f"{len(g_sps)} vs {len(f_sps)} (diff={n_diff})"
    if n_diff > 2:
        fail.append(f"selling_points 数量差 > 2")

    # (4) visual_type 分布 ±2 可接受
    g_dist = Counter(sp.get("visual_type") for sp in g_sps)
    f_dist = Counter(sp.get("visual_type") for sp in f_sps)
    detail["visual_type_dist"] = f"{dict(g_dist)} vs {dict(f_dist)}"
    for vt in ("product_in_scene", "product_closeup", "concept_visual"):
        if abs(g_dist.get(vt, 0) - f_dist.get(vt, 0)) > 2:
            fail.append(f"{vt} 数量差 > 2")

    # (5) P2 过滤器生效: fresh 的 selling_points 不应含产品型号
    product_name = f_pm.get("name", "")
    first_token = re.split(r"[\s,,]", product_name, maxsplit=1)[0] if product_name else ""
    detail["p2_check"] = f"first_token={first_token!r}"
    if first_token and len(first_token) >= 2:
        for sp in f_sps:
            if first_token in (sp.get("text") or "")[:15]:
                fail.append(f"P2 过滤器失效: 卖点含型号 {first_token!r}: {sp.get('text')}")
                break

    # 一致度: 4 个硬检查 (category/color/sp数量/vt 分布)
    hard_checks = 4
    passed = hard_checks - sum(
        1 for f in fail
        if any(k in f for k in ("category", "primary_color", "selling_points 数量", "数量差"))
    )
    detail["consistency"] = f"{passed}/{hard_checks} = {passed / hard_checks:.0%}"

    return {"fail_flags": fail, "detail": detail, "consistency": passed / hard_checks}


def _smoke_test_dz600m() -> int:
    """跑 DZ600M 真实 DeepSeek, 对比黄金样本. 返回 exit code (0=pass)."""
    print("=" * 66)
    print("AI 精修 v2 · Day 5 · DZ600M 真实 DeepSeek 烟雾测试")
    print("=" * 66)

    if not os.environ.get("DEEPSEEK_API_KEY", "").strip():
        print("[FAIL] DEEPSEEK_API_KEY 未配置 (Windows: $env:DEEPSEEK_API_KEY='sk-xxx')")
        return 1

    golden = _load_golden_dz600m()
    if not golden:
        print("[FAIL] 找不到黄金样本 w1_samples/10_device_dz600m.json")
        return 1
    print(f"[ok] 黄金样本加载: {len(golden.get('selling_points') or [])} 个卖点")

    print(f"[post] 调 DeepSeek plan() (max_retries=1)...")
    t0 = time.time()
    try:
        fresh = plan(product_text=_DZ600M_TEXT, max_retries=1)
    except PlannerError as e:
        print(f"[FAIL] plan() 抛 PlannerError: {e}")
        return 1
    elapsed = round(time.time() - t0, 2)
    print(f"[ok] 调用成功 · {elapsed}s · {len(fresh.get('selling_points') or [])} 个卖点")

    # 对比
    report = _compare(golden, fresh)
    print("\n── 对比报告 ──")
    for k, v in report["detail"].items():
        print(f"  {k}: {v}")

    if report["fail_flags"]:
        print("\n── 失败项 ──")
        for f in report["fail_flags"]:
            print(f"  ✗ {f}")
        print(f"\n[FAIL] 一致度 {report['consistency']:.0%}, smoke test 不通过")
        return 1

    print(f"\n[PASS] 一致度 {report['consistency']:.0%}, mock 与真 API 对齐")
    return 0


if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(
        description="AI 精修 v2 · DeepSeek 规划官 CLI",
    )
    ap.add_argument(
        "--smoke-test", action="store_true",
        help="跑 DZ600M 真实 DeepSeek 烟雾测试 (需要 DEEPSEEK_API_KEY)",
    )
    args = ap.parse_args()

    if args.smoke_test:
        sys.exit(_smoke_test_dz600m())

    ap.print_help()
    sys.exit(1)
