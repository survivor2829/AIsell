"""
AI 精修数据流审计 — 用户要求的"步骤1+2"执行器

目的: 一次运行打印 3 组数据 + 自动生成"模板要什么 vs ctxs 有什么"对比表
     不碰任何 bug fix,只做审计。

数据来源:
  1) parsed_data: 用 test_endpoint_html_parsed.PARSED_DEMO(已模拟真实 DeepSeek 输出结构)
  2) ctxs: 调 app._build_ctxs_from_parsed(parsed, "", "classic-red")
  3) 模板需求: 从 templates/ai_compose/*.html 里用正则提取所有 {{ var }} / {{ obj.key }}
              + 从 templates/ai_compose/_registry.json 里读 required/optional

输出:
  - STEP 1: 打印 parsed_data 结构
  - STEP 2: 打印每屏 ctx 完整字段值 + 空字段清单
  - STEP 3: 打印每屏模板实际读的变量清单(正则扫描 HTML)
  - STEP 4: 对比表 — 哪些模板要但 ctxs 缺 / 哪些 ctxs 给了但模板不读
"""
import json
import re
from pathlib import Path


BASE = Path(__file__).parent
TMPL_DIR = BASE / "templates" / "ai_compose"
REGISTRY = TMPL_DIR / "_registry.json"


# ── Jinja 变量提取 ─────────────────────────────────────────
# 匹配 {{ var }} 或 {{ var.key }} 或 {{ var | default('x') }}
# 不深入 {% for x in list %} 语义,只抓顶层标识符 + 属性名
_VAR_RE = re.compile(r'\{\{\s*([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)', re.MULTILINE)
_IF_RE = re.compile(r'\{%\s*if\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)', re.MULTILINE)
_FOR_RE = re.compile(r'\{%\s*for\s+(\w+)\s+in\s+(\w+)', re.MULTILINE)


def extract_template_vars(html: str):
    """
    返回 (top_level, item_attrs)
      top_level  : set{"main_title", "subtitle", ...} 顶层 ctx 字段
      item_attrs : dict{"advantages": set{"icon","title","stat_num",...}} 列表元素属性
    """
    # Step A: 收集所有 {% for loop_var in collection %} 对
    loop_map = {}  # loop_var → collection_name
    for m in _FOR_RE.finditer(html):
        loop_map[m.group(1)] = m.group(2)

    top_level = set()
    item_attrs = {name: set() for name in loop_map.values()}

    for m in list(_VAR_RE.finditer(html)) + list(_IF_RE.finditer(html)):
        ident = m.group(1)
        if '.' in ident:
            obj, attr = ident.split('.', 1)
            if obj in loop_map:
                # 这是 {{ loop_var.xxx }} → 真正读的是 collection[].xxx
                coll = loop_map[obj]
                item_attrs.setdefault(coll, set()).add(attr)
            else:
                top_level.add(obj)
        else:
            # 不是循环变量本身就是顶层变量
            if ident not in loop_map:
                top_level.add(ident)
            else:
                # 纯 {{ loop_var }} 被循环驱动,对应集合需要在 ctx 里
                top_level.add(loop_map[ident])

    # 清理 Jinja 内置 / 循环控制
    for junk in ("loop", "default", "if", "else", "endif", "for", "endfor"):
        top_level.discard(junk)

    return top_level, item_attrs


# ── 主流程 ─────────────────────────────────────────────────

def main():
    import sys
    sys.path.insert(0, str(BASE))
    import app  # noqa
    from test_endpoint_html_parsed import PARSED_DEMO

    print("═" * 80)
    print("  STEP 1 · parsed_data (DeepSeek 输出模拟)")
    print("═" * 80)
    print(f"keys = {sorted(PARSED_DEMO.keys())}\n")
    for k, v in PARSED_DEMO.items():
        if isinstance(v, (list, dict)):
            snippet = json.dumps(v, ensure_ascii=False)
            if len(snippet) > 160:
                snippet = snippet[:160] + "..."
            print(f"  {k:20s} = {type(v).__name__}[len={len(v)}]")
            print(f"                         {snippet}")
        else:
            print(f"  {k:20s} = {v!r}")
    print()

    print("═" * 80)
    print("  STEP 2 · ctxs = _build_ctxs_from_parsed(parsed, '', 'classic-red')")
    print("═" * 80)
    # 走 app 上下文(某些 helper 如 url_for 需要)
    with app.app.app_context(), app.app.test_request_context():
        ctxs = app._build_ctxs_from_parsed(PARSED_DEMO, "", "classic-red")
    print(f"ctxs.keys() = {list(ctxs.keys())}")
    print(f"缺屏      = {set(['hero','advantages','specs','vs','scene','brand','cta']) - set(ctxs.keys())}\n")

    for screen, ctx in ctxs.items():
        print(f"── [{screen}] ─────────────────────────────────────────")
        empties = []
        for k, v in ctx.items():
            kind = type(v).__name__
            if v in ("", None, [], {}) or (isinstance(v, str) and not v.strip()):
                empties.append(k)
                print(f"    {k:20s} = {v!r}  <EMPTY>")
            elif isinstance(v, list):
                print(f"    {k:20s} = list[{len(v)}]")
                for i, item in enumerate(v[:6]):
                    if isinstance(item, dict):
                        print(f"        [{i}] {json.dumps(item, ensure_ascii=False)}")
                    else:
                        print(f"        [{i}] {item!r}")
            elif isinstance(v, dict):
                print(f"    {k:20s} = {json.dumps(v, ensure_ascii=False)[:120]}")
            else:
                val = str(v)
                print(f"    {k:20s} = {val[:120]!r}")
        if empties:
            print(f"    【空字段】{empties}")
        print()

    print("═" * 80)
    print("  STEP 3 · 模板实际读的变量(正则扫描 templates/ai_compose/*.html)")
    print("═" * 80)
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    tmpl_needs = {}
    for screen, meta in registry.items():
        if screen.startswith("_"):
            continue
        tmpl = TMPL_DIR / meta["template"]
        html = tmpl.read_text(encoding="utf-8")
        top, items = extract_template_vars(html)
        tmpl_needs[screen] = {
            "required":   meta.get("required_keys", []),
            "optional":   meta.get("optional_keys", []),
            "reads_top":  top,
            "reads_items": items,
        }
        print(f"── [{screen}] (registry required={meta.get('required_keys')})")
        print(f"    reads_top_level  = {sorted(top)}")
        for coll, attrs in items.items():
            print(f"    reads_items[{coll:14s}] = {sorted(attrs)}")
        print()

    print("═" * 80)
    print("  STEP 4 · 对比表 · 断裂点")
    print("═" * 80)
    print(f"{'屏幕':<12s}{'维度':<16s}{'模板需要':<50s}{'ctxs 实际':<40s}状态")
    print("-" * 130)

    for screen in registry:
        if screen.startswith("_"):
            continue
        ctx = ctxs.get(screen, {})
        needs = tmpl_needs[screen]

        # A: 屏幕是否被生成
        if not ctx:
            print(f"{screen:<12s}{'屏幕缺失':<16s}{'(必生成)':<50s}{'<不存在>':<40s}❌ 缺屏")
            continue

        # B: required_keys 是否齐全
        for rk in needs["required"]:
            val = ctx.get(rk)
            has = val not in ("", None, [], {}) and not (isinstance(val, str) and not val.strip())
            mark = "✅" if has else "❌ 必需字段为空"
            sv = str(val)[:38] if has else "<空/缺>"
            print(f"{screen:<12s}{'required':<16s}{rk:<50s}{sv:<40s}{mark}")

        # C: 模板实际读的 top-level 变量,但 ctx 里没有
        for tk in sorted(needs["reads_top"]):
            # 理论性内置/已在 required 里过的跳过
            if tk in needs["required"]:
                continue
            val = ctx.get(tk)
            if val in ("", None, [], {}):
                print(f"{screen:<12s}{'opt top-level':<16s}{tk:<50s}{'<缺或空>':<40s}⚠️  模板会读但 ctx 无")

        # D: 列表字段的元素属性缺失
        for coll, attrs in needs["reads_items"].items():
            items = ctx.get(coll)
            if not isinstance(items, list) or not items:
                continue
            sample = items[0]
            if not isinstance(sample, dict):
                continue
            for a in sorted(attrs):
                if a not in sample or sample.get(a) in ("", None, [], {}):
                    print(f"{screen:<12s}{'item attr':<16s}{coll+'[].'+a:<50s}{'<第0项缺此属性>':<40s}⚠️  每行都空")

        # E: ctx 给了但模板不读(多余)
        tmpl_known = set(needs["required"]) | set(needs["optional"]) | set(needs["reads_top"]) | {
            "theme_primary", "theme_primary_dark", "theme_accent",
            "canvas_width", "canvas_height",
        }
        for ck in ctx:
            if ck not in tmpl_known:
                print(f"{screen:<12s}{'ctx 多余':<16s}{ck:<50s}{str(ctx[ck])[:38]:<40s}ℹ️  模板不消费")

    print()
    print("═" * 80)
    print("  审计完成 · 上面表里所有 ❌/⚠️ 就是数据流断裂点")
    print("═" * 80)


if __name__ == "__main__":
    main()
