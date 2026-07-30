"""AI 精修 v2 · 屏型库加载逻辑 (PRD §1.2 fallback 待命).

加载 ai_refine_v2/screen_types.yaml, 返回 ScreenTypesConfig dataclass.

设计原则 (PRD §阶段一·任务 1.2):
  1. 第一版 enabled: false 是铁律 — 主流程不会调本模块, 加载逻辑只是建好待命.
  2. enabled: false 时不依赖 pyyaml (用 _peek_enabled 纯文本扫描即可).
  3. enabled: true 时才真调 pyyaml; 未装 → raise 清晰错误, 提示阶段六依赖.
  4. 文件不存在不崩, 返 disabled state — 主流程绝不感知.

阶段六真启用 fallback 时的改动面 (供 Scott 心里有数):
  a. `pip install pyyaml` 并加进 requirements.txt
  b. 把 screen_types.yaml 的 `enabled: false` 改 `enabled: true`
  c. 在 plan_v2() 入口加 `cfg = load_screen_types()`, 若 cfg.enabled 把
     cfg.types 列表注入 SYSTEM_PROMPT_V2 (替换准则 3 的"自由发挥"段为
     "必须从下方 8 种屏型选 / 每种最多 N 次"硬约束)
  d. 在 _validate_schema_v2() 加 role 白名单校验 (screens[i].role 必须在
     cfg.types 的 id 列表里)
  e. (可选) pipeline_runner._worker 透传 fallback flag 让前端展示
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

# screen_types.yaml 默认路径 (与本模块同目录)
_YAML_PATH = Path(__file__).resolve().parent / "screen_types.yaml"

# enabled 字面解析的"真"值集合 (与 YAML 1.1/1.2 的 boolean truthy 子集对齐)
_TRUTHY_LITERALS = {"true", "yes", "on", "1"}


# ── 数据结构 ────────────────────────────────────────────────────
@dataclass
class ScreenType:
    """单个屏型描述. 5 个字段都是字符串, 阶段六真启用时由 plan_v2 注入 prompt."""
    id: str               # 程序识别用, 如 "hero" / "feature_wall"
    name: str             # 中文短名, 给前端展示
    purpose: str          # 屏的目的, 人类可读说明
    prompt_hint: str      # 给 DeepSeek 写这屏 prompt 时的核心引导 (英文为主)
    typical_position: str # "first" | "middle" | "mid_late" | "late"


@dataclass
class ScreenTypesConfig:
    """整个屏型库的配置载体.

    enabled=False 时 types=[], 主流程通过 `if cfg.enabled` 短路.
    """
    enabled: bool = False
    types: list[ScreenType] = field(default_factory=list)
    source_path: str = ""  # 从哪个文件加载, 空 = 文件缺失


# ── _peek_enabled: 不依赖 pyyaml 的最简 enabled 字面探测 ──────────
def _peek_enabled(text: str) -> bool:
    """扫 YAML 文本第一行 'enabled: <value>', 返 bool. 找不到视为 False.

    专为支持"pyyaml 未装 + enabled: false 仍能跳过"场景设计.
    支持: 行内注释 (# ...), 大小写不敏感, blank line 跳过.
    """
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("enabled:"):
            value = stripped.split(":", 1)[1]
            # 去掉行内注释
            value = value.split("#", 1)[0].strip().lower()
            return value in _TRUTHY_LITERALS
    return False


# ── _parse_yaml_text: enabled: true 路径才调 pyyaml ──────────────
def _parse_yaml_text(text: str) -> dict:
    """用 pyyaml 解析 YAML 全文, 返 dict.

    pyyaml 未装 → raise RuntimeError 含明确升级提示.
    本函数仅在 _peek_enabled 返 True 后调, 所以第一版根本到不了这里.
    """
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError as e:
        raise RuntimeError(
            "screen_types.yaml fallback 加载需要 pyyaml. "
            "阶段六启用前请先 `pip install pyyaml` 并加到 requirements.txt. "
            "第一版 enabled: false 状态下本函数不应被调用."
        ) from e
    return yaml.safe_load(text) or {}


# ── 主入口: load_screen_types ─────────────────────────────────────
def load_screen_types(yaml_path: Optional[Path] = None) -> ScreenTypesConfig:
    """加载屏型库配置. 第一版任何调用方都应通过 `if cfg.enabled` 守门.

    Args:
        yaml_path: 自定义路径, 默认 ai_refine_v2/screen_types.yaml

    Returns:
        ScreenTypesConfig:
          - 文件不存在 → ScreenTypesConfig(enabled=False, types=[], source_path="")
          - enabled: false → ScreenTypesConfig(enabled=False, types=[], source_path=str(p))
            (不调 pyyaml)
          - enabled: true → ScreenTypesConfig(enabled=True, types=[<8 个>], ...)
            (调 pyyaml, 未装则 raise RuntimeError)

    Raises:
        RuntimeError: enabled: true 但 pyyaml 未装
    """
    p = yaml_path or _YAML_PATH

    if not p.is_file():
        return ScreenTypesConfig(enabled=False, types=[], source_path="")

    text = p.read_text(encoding="utf-8")

    # 第一道闸: enabled: false → 不动 pyyaml, 直接返 disabled
    if not _peek_enabled(text):
        return ScreenTypesConfig(enabled=False, types=[], source_path=str(p))

    # 第二道闸: enabled: true 才走 pyyaml 全解析
    data = _parse_yaml_text(text)

    types_raw = data.get("screen_types") or []
    types: list[ScreenType] = []
    for t in types_raw:
        if not isinstance(t, dict):
            continue
        types.append(ScreenType(
            id=str(t.get("id", "")).strip(),
            name=str(t.get("name", "")).strip(),
            purpose=str(t.get("purpose", "")).strip(),
            prompt_hint=str(t.get("prompt_hint", "")).strip(),
            typical_position=str(t.get("typical_position", "middle")).strip(),
        ))

    return ScreenTypesConfig(
        enabled=True,
        types=types,
        source_path=str(p),
    )
