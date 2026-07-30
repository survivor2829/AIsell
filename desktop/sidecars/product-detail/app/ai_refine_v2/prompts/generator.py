"""gpt-image-2 生图 prompt 模板渲染器.

设计决策:
  - 用 Jinja2 (项目已依赖, Flask 带) 加载 .j2 文件, 不内嵌字符串, 方便单独迭代
  - 3 类 visual_type 对应 3 个独立 .j2: in_scene / closeup / concept
  - STYLE_BASE 在 Python 常量, 渲染后自动追加 (避免每个模板重复)

对外:
  render(visual_type, **context) -> str

W2 Day 1 (2026-04-23): 3 模板按 PRD §4.1/4.2/4.3 初版就位. render() 可用.
W2 Day 3+ 会根据实际 gpt-image-2 效果迭代 .j2 文件内容 (改 prompt 不改 API).
"""
from __future__ import annotations
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined, TemplateNotFound


_TEMPLATE_DIR = Path(__file__).parent / "templates"

# StrictUndefined: 模板里用了未传值的变量就抛异常, 避免 prompt 里出现空洞
_env = Environment(
    loader=FileSystemLoader(str(_TEMPLATE_DIR)),
    undefined=StrictUndefined,
    trim_blocks=True,
    lstrip_blocks=True,
    autoescape=False,  # prompt 不是 HTML, 不需要转义
)

# 3 类 visual_type 对应文件
TEMPLATES = {
    "product_in_scene": "in_scene.j2",
    "product_closeup": "closeup.j2",
    "concept_visual": "concept.j2",
}

# 所有模板共享的 STYLE_BASE (渲染后自动追加到末尾)
STYLE_BASE = (
    "Taobao/Tmall e-commerce detail page quality,\n"
    "professional 8K, sharp focus,\n"
    "commercial photography standard."
)


class PromptRenderError(RuntimeError):
    """模板渲染失败 (变量缺失 / 模板不存在)."""


def render(visual_type: str, **context) -> str:
    """渲染指定 visual_type 的完整 prompt (body + STYLE_BASE).

    Args:
        visual_type: "product_in_scene" / "product_closeup" / "concept_visual"
        **context: 变量字典, 按模板要求的 key 传

    模板变量需求 (失配会抛 PromptRenderError):

        product_in_scene:
          product = dict(name, primary_color, key_visual_parts, proportions)
          scene = str (英文场景描述)
          hero = bool (True 时用 hero 上下文, False 时用 selling_point.text)
          selling_point = dict(text)       # hero=False 时必传
          human_hint = str | None          # 可选

        product_closeup:
          product = dict(name, primary_color)
          focus_part = str (英文具体部件名)

        concept_visual:
          selling_point = dict(text)       # 可中文

    Returns:
        str, 完整 prompt (尾部已追加 STYLE_BASE)

    Raises:
        PromptRenderError: 未知 visual_type / 模板变量缺失
    """
    tmpl_file = TEMPLATES.get(visual_type)
    if not tmpl_file:
        raise PromptRenderError(
            f"unknown visual_type: {visual_type!r}. "
            f"expected one of {list(TEMPLATES)}"
        )
    try:
        template = _env.get_template(tmpl_file)
        body = template.render(**context)
    except TemplateNotFound as e:
        raise PromptRenderError(f"模板文件缺失: {e}") from e
    except Exception as e:
        raise PromptRenderError(f"渲染 {visual_type} 失败: {e}") from e

    return f"{body.rstrip()}\n\n{STYLE_BASE}"
