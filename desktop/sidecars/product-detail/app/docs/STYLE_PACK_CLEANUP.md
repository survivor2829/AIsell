# AI 风格包(STYLE_PACK)代码清理 — ✅ 已完成

**创建**:2026-05-11
**完成日期**:**2026-05-11**(同日完成,跳过观察期 — 用户决定一次性清理)
**完成范围**:175 行 dead code 全部删除,167 测全绿,routes 56→55(/api/style-packs 移除)

> **历史文档** — 以下内容是当时的清理计划 + 风险评估,作为完成依据保留。
> 实际执行差异:Step 1-3 全部 1 天内做完,无 2 周观察期。

---

## 背景:为什么清理

**核心发现**:经实证,前端 `generateAiHtmlV2()`(workspace.html)在 POST `/api/ai-refine-v2/execute` 时**根本没有传 `style_pack` 参数**,即用户在右栏点击的 6 个风格按钮(industrial_authority / commercial_showroom / luxury_hospitality / tech_minimal / outdoor_architectural / workshop_utility)+ 1 个盲盒(random)从未真正生效——后端 `pick_style_pack("")` 一直走 `DEFAULT_STYLE_PACK="commercial_showroom"` 兜底。

也就是说:UI 上的"AI 风格"区是一个**视觉假按钮**,删除对用户感知零影响。

2026-05-11 通过 PR `feat/workspace-layout-presets-and-style-pack-hide` 已:
- 隐藏前端 UI(`<div hidden>` 包裹 `#style_pack_section_deprecated`)
- 短路 `loadStylePacks()` 函数
- 保留所有后端代码 + 前端 JS 函数符号(便于回滚)

本文档定义**第二阶段:彻底清理**的执行步骤。

---

## 预清理验证(执行前必跑)

### 1. Grep 基线验证

**当前基线(2026-05-11)**:51 处引用,分布在 4 个文件:
- `ai_bg_cache.py`
- `app.py`
- `prompt_templates.py`
- `templates/workspace.html`

清理日(2026-05-25 后)再跑一遍:
```bash
grep -rn "style_pack\|STYLE_PACK\|pick_style_pack\|list_style_packs\|loadStylePacks\|applyStylePack\|renderStylePackGrid" --include="*.py" --include="*.html" --include="*.js" | wc -l
```

**判断标准**:
- 如果 ≤ 51 处且仍是 4 文件 → 安全,按下面清单清理
- 如果 > 51 或文件数 > 4 → **STOP**,有人复活了它(或新依赖),先与作者沟通再决定是否清理

### 2. 测试基线

```bash
pytest tests/ -k "ai_refine or build or style"
```
应全绿。tests/ 目录当前 0 处 `style_pack` 引用,清理不应影响测试。

### 3. 关键路径 smoke

跑 `/skill smoke` 全绿。AI 精修生成走完整链路确认 `commercial_showroom` 仍兜底正常。

---

## 清理执行清单(按依赖反序删,前端 → 后端)

### Step 1:前端(workspace.html)

- [ ] 删 line 627-639(已隐藏的 `#style_pack_section_deprecated` 整段)
- [ ] 删全局变量声明 `currentStylePack` / `currentRandomStyle` / `allStylePacks`(在 line 705-720 附近)
- [ ] 删函数:`STYLE_PACK_ICONS`(常量 obj)/ `loadStylePacks`(已短路) / `renderStylePackGrid` / `applyStylePack`(line 895-948)
- [ ] 删 `DOMContentLoaded` 里的 `loadStylePacks()` 调用(line ~1580)

### Step 2:后端 API 路由(app.py)

- [ ] 删 `/api/style-packs` endpoint(行 1104-1114 — 清理日复确认行号)
- [ ] 在 `/api/ai-refine-v2/execute`(及其他用到 `data.get("style_pack")` / `data.get("random_style")` 的处理函数)删读取参数的代码

### Step 3:核心库

- [ ] `ai_bg_cache.py`:删 `style_pack` / `random_style` 形参,`generate_backgrounds()` 内部直接用 `commercial_showroom`(或新常量 `DEFAULT_VARIANTS_MAP`)
- [ ] `prompt_templates.py`:删 `STYLE_PACKS` dict(行 330-385)/ `DEFAULT_STYLE_PACK` / `pick_style_pack()` / `list_style_packs()`
  - **但保留** `commercial_showroom` 对应的 variants dict 提取为模块级常量 `DEFAULT_VARIANTS_MAP`,因为 `ai_bg_cache.py` 还需要这个映射作为 prompt 元素

### Step 4:测试 + 文档

- [ ] 跑 `pytest tests/` 全绿
- [ ] grep 一遍最终再确认 0 引用:
  ```bash
  grep -rn "style_pack\|STYLE_PACK\|pick_style_pack\|list_style_packs" --include="*.py" --include="*.html"
  ```
- [ ] `docs/PRD_AI_refine_v2/PRD_final.md:660` 提到 style_packs_v1 — 加历史注脚:"2026-05 简化为单一 commercial_showroom 默认,UI 隐藏 + 后端清理"
- [ ] memory:更新 `project_style_packs_v1.md` → 标 `[DEPRECATED]` + 引此文档

---

## 风险点(清理前必读)

### 风险 1:批量生成路径的隐式依赖

**未验证**:`templates/batch_*` 是否调 style_pack。清理前必须:
```bash
grep -rn "style_pack" templates/batch_*
```
如有,先评估批量生成是否需要保留风格选项(可能批量场景反而需要差异化风格)。

### 风险 2:legacy v1 端点的外部调用

`app.py` 里可能有 v1(老版)精修路径仍在读 `style_pack`,如果有内部脚本/curl 直接调 v1 端点,清理时会 break 那个调用。

**清理前必查**:
```bash
git log -p app.py | grep -B3 "style_pack ="
```
找出所有 v1 端点路径,加 `print` 1 周观察 access log,**无人调用**才删。

### 风险 3:后端 `commercial_showroom` variants 依赖

`ai_bg_cache.py:271-280` 调用 `pick_style_pack()` 后用其返回的 variants dict 喂 Seedream prompt。**清理时必须保留 variants 映射**为常量,否则 AI 精修生成的提示词会缺一段关键描述。

### 风险 4:线上数据库 / 用户偏好

```bash
grep -rn "style_pack" migrations/ models/ instance/
```
如有用户偏好表存了 `last_style_pack`,先 migration 删字段。

---

## 回滚方案

如果清理后发现回归(用户反馈精修效果变差等),立即:
```bash
git revert <cleanup-commit-sha>
git push origin main
ssh prod "cd /root/clean-industry-ai-assistant && git pull && docker compose up -d --build"
```

**回滚前必须确认**:
- 是回归还是巧合(对比清理前/后的真测样本)
- 若是回归,定位是 prompt 缺失导致还是其他原因

---

## 完成判据

- [ ] 上述所有 step 1-4 ✅
- [ ] 主仓 main 通过 PR merge,deploy 上 prod
- [ ] prod 跑 1-2 个 AI 精修 case 视觉打分 ≥ 清理前基线
- [ ] memory 更新完毕
- [ ] 此文档移到 `docs/archive/` 并加完成日期

---

**联系人 / 沟通**:清理前如有疑问,在 GitHub issue 或 commit 里 @ 项目 owner 沟通。
