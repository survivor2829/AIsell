# [STUB] §B.4 image_composer.py 硬编码 Windows 字体路径

> ⚠️ 草稿状态: 由 P2 audit 自动生成
> 来源: § Top 10 #3 / §B.4 (= §C.4)
> 严重度: 严重
> 估时: 0.5-2h

## 问题简述

`image_composer.py:13-15` 硬编码 `FONT_DIR = "C:/Windows/Fonts"` + `FONT_REGULAR/BOLD/EMOJI`。Linux Docker 容器路径不存在, 旧路由 `/api/generate-ai-images` (app.py:2825) 触发时即抛 IOError。

## 根因诊断

跟根因 3 (缺统一 config 体系) 一致。Windows 开发→Linux 部署的"跨平台债"。后续 line 826-844 加了 `_FONT_CANDIDATES` fallback 列表, 但顶部 3 行常量仍写死, `_emoji_font` 直接引用旧常量。

## 修复方案

### 方案 A — 删旧路由 (推荐如已废弃)
```python
@app.route("/api/generate-ai-images", methods=["POST"])
def generate_ai_images():
    return jsonify({"error": "v1 Pillow 路径已废弃, 请用 /api/ai-refine-v2"}), 501
```
- 优势: 一次性铲除, 0 维护成本
- 劣势: 需先确认前端无人调用
- 估时: 0.5h (含 grep 确认调用方)

### 方案 B — 跨平台字体解析
```python
def _resolve_font(name: str) -> str:
    candidates = [
        f"C:/Windows/Fonts/{name}",
        f"/usr/share/fonts/truetype/wqy/{name}",
        f"/System/Library/Fonts/{name}",  # macOS
    ]
    for p in candidates:
        if Path(p).exists():
            return p
    raise FileNotFoundError(f"找不到字体 {name}")

FONT_REGULAR = _resolve_font("msyh.ttc")
```
- 优势: 旧路由继续可用
- 劣势: 维护两条管线
- 估时: 2h

## 兜底/回滚

`git revert`, 影响仅 `image_composer.py` 1 文件。

## 转正式 spec checklist

- [ ] Scott 决策 "修"
- [ ] 先 grep `/api/generate-ai-images` 调用确认是否废弃
- [ ] 选方案 (A / B)
- [ ] 进入 P4

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
