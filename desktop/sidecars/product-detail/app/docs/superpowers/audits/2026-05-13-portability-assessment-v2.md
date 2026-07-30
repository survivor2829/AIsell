# 「导演思维」对耗品类可移植度评估 v2 — 现状复审

> **日期**: 2026-05-13
> **触发**: P5.0 audit v1 (2026-05-07) 已严重过期 — 5-7 ship sprint (PR #16/#18/#20/#22/#23 等 10 PR) 静默修了 v1 标的 3/4 🟡 但 audit 文件未回写
> **评估方法**: v1 报告逐项 vs 当前 main (HEAD=9f894b5) 反向校验
> **承诺**: audit-only, 0 业务代码改动
> **下一步**: 锁现状 → 决定是否动 block_f 重构

---

## 摘要

P5.0 v1 audit 列的 4 个 🟡 中 **3 个已被 5-7 sprint 修了, 1 个仍剩**。v1 校准的 P5.x 剩余工时 **6-9 day → 实际剩 3-5 day**。

| v1 🟡 项 | v1 估时 | 5-13 现状 | 证据 |
|---|---|---|---|
| `app.py:754-757` param_label 硬编码 | 2.5h | ✅ **已修** | `_PARAM_LABELS_BY_CATEGORY` @ app.py:645 + `_CAT_FALLBACK` @ :654 + 实际分品类查找 @ :770/:777 |
| `block_b3_clean_story` floor_items 语义 | 1h | ✅ **已数据驱动** | 4 品类 build_config 均含 `floor_title`/`floor_items` 字段; 模板 `{% if floor_title %}` + `{% for it in floor_items %}` 全 conditional, 注释不影响渲染 |
| `block_a_hero_robot_cover` 注释 | 2h | ✅ **已修 + 自我豁免** | 注释顶部 5-6 行明写"通用封面首屏(品类无关), P5.1 起支持 4 品类, 原文件名是历史命名, 实际渲染逻辑完全数据驱动"; v1 §F.1 第 4 条本就明说"不必改文件名" |
| `block_c1_vs_data` 注释 | 1h | ✅ **零硬编码** | grep `机器人\|robot\|本产品\|传统\|清洁机\|洗地` @ block_c1_vs_data.html: 0 命中. 注释问题不影响渲染, 跨品类零阻断 |
| `block_f_showcase_vs` labor_image | 3h | 🟡 **真剩** | block_f_showcase_vs.html:44-67 仍硬编码中文标签"本产品/传统人工" + `{% if labor_image %}` Seedream 双图分支 |

**新发现**: `block_c3_vs_upgrade.html` (5-7 sprint 新增) — 升级前/后对比块, 完全数据驱动, 跨品类 🟢 复用。

---

## §A. 现状真实矩阵 (33 → 34 block)

`templates/blocks/` 当前共 **29 个 block_*.html + 5 个 main_img_*.html = 34 个**。

**🟢 复用 (33) | 🟡 重写 (1, block_f) | 🔴 删除 (0)**

| 状态 | 数量 | 备注 |
|------|------|------|
| 🟢 直接复用 | 33 | 含 5-7 新增的 block_c3_vs_upgrade |
| 🟡 重写 | 1 | 仅 block_f labor_image |
| 🔴 删除 | 0 | — |

---

## §B. 唯一剩余 🟡: block_f_showcase_vs

### B.1 现状

```jinja
templates/blocks/block_f_showcase_vs.html:44-67

{% if labor_image %}
<!-- 双图对比：左=本产品 / 右=传统人工。labor_image 由 Seedream 生成并磁盘缓存 -->
  <!-- 本产品 -->
  ... 本产品 ...
  <!-- 传统人工 -->
  <img src="{{ labor_image }}" ...
  ... 传统人工 ...
{% else %}
  <!-- 单图回退（labor_image 生成失败 / ARK_API_KEY 未配置时）-->
```

### B.2 跨品类适配方案 (3 选 1)

| 方案 | 改动 | 优点 | 缺点 | 工时 |
|------|------|------|------|------|
| **A. 标签变量化** | 中文"本产品/传统人工" 改 `{{ left_label }}` / `{{ right_label }}`; labor_image 改 `right_image`; 各品类 build_config 填语义 | 最小动; 兼容旧设备类 | block_f 仍假设"对比叙事" | **1h** |
| **B. 整屏可选** | 用 `{% if comparison_enabled %}` 全包; 耗材类直接关掉 | 耗材类不踩坑 | 失去"性价比对比"卖点 | **0.5h** |
| **C. 完全重构** | 拆 block_f 成 `block_f_human_vs_robot` (设备专属) + `block_f_brand_vs_competitor` (耗材通用) | 语义清晰 | 改 2 个 build_config + 拼装层 | **4-6h** |

**建议**: **A**（最小入侵, 旧调用兼容, 耗材类 build_config 填"竞品/我方"即用）。C 在真有"竞品对比图素材"时再启动, 现在为时过早 (YAGNI 反硬编码原则)。

### B.3 单点风险

v1 §F.4 提示 "labor_image 是 Seedream 生成 \"传统人工\" 对比图的逻辑, 改 \"竞品图\" 需要新 prompt + 可能新缓存 key — 估 3h 偏乐观, 实际可能爆到 1d"。

→ v2 走方案 A 跳过 Seedream prompt 重写 (labor_image 字段名保留, 仅前端显示标签变量化), **真实工时回到 1-2h**, 单点风险消除。

---

## §C. P5.x 剩余子阶段重排

| 子阶段 | v1 校准 | v2 校准 | 偏差原因 |
|--------|---------|---------|----------|
| P5.1 耗品配置层 | 0.5d | ✅ **已 DONE** (PR #16 2026-05-06) | 5-7 sprint |
| P5.2 block 适配 | 1d | **1-2h** (block_f 标签变量化, 方案 A) | 3/4 🟡 已修 + 方案 A 简化 |
| P5.3 theme_matcher | 0.25d | **0.25d** | 未变 |
| P5.4 block_f VS 屏 | 1.5d | **(并入 P5.2)** | 方案 A 后无独立 P5.4 必要 |
| P5.5 AI 精修风格包 | 1.5d | **1.5d** | 新增"实验室/仓储清洁间"风格包, 未变 |
| P5.6 端到端测试 | 2d | **2d** | 不可压缩, 含 ¥5-10 真测 |
| **合计** | **6-9d** | **~3.5-4d** | -50% |

---

## §D. 决策建议

### D.1 立即可做 (P5.2 ≈ 1-2h)

**block_f 方案 A 标签变量化**:
1. 改 `block_f_showcase_vs.html:44-67`: 中文标签 → `{{ left_label }}` / `{{ right_label }}`; `labor_image` → `right_image` (保留旧字段名同时支持)
2. 4 个 `templates/<品类>/build_config.json` 各加 `left_label` / `right_label` 默认值
3. `app.py` 拼装层 (block_f 数据组装处) 把 `labor_image` 同步映射到 `right_image`
4. e2e 单测保耗材类配置渲染不挂

### D.2 第二波 (P5.5 ≈ 1.5d)

**STYLE_PACKS 加耗品类专用 2-3 个风格包**:
- `lab_minimal` (实验室白底/不锈钢台面)
- `warehouse_clean` (仓储清洁间)
- `consumable_lifestyle` (家用/办公场景, 软光)

### D.3 第三波 (P5.6 ≈ 2d)

- e2e 耗材类 demo 端到端跑 1 单 (¥5-10 真测)
- 守护测保 12 屏 task 边界不踩
- changelog + memory + prod deploy

### D.4 不做的事 (v1 列但 v2 撤销)

- ❌ 改 `block_a_hero_robot_cover` 文件名 — 文件名重命名是跨仓 grep 风暴, 注释已豁免
- ❌ 改 `block_b3` / `block_c1` / `block_a` 注释 — 都已修或不阻断
- ❌ block_f 拆成 2 个 block (方案 C) — YAGNI, 现需求方案 A 足够

---

## §E. v1 → v2 偏差成因

v1 audit 输出于 2026-05-07 上午, 5-7 当天下午起 ship sprint 跑了 10 个 PR (`PR #16-#25 + #14`), 其中至少 4 个**修了** v1 列的 🟡 但未回写 audit 文件:
- PR #16 (耗品类 MVP 4 品类 param + 兜底) → 修 v1 ❶
- PR #20 (lifestyle_demo 提到 idx=2) → 间接修 v1 ❷ ❸ (验证模板品类无关)
- PR #22 (material_origin 第 9 屏) → 加耗品类专属 block
- PR #18 (配耗类 → 配件类全栈重命名) → 改 4 品类映射

**教训**: ship sprint 跑得快时 audit 文档会快速过期, 5 天就翻一次。下次 audit 应在 PR description 里明示"修了 audit 哪几项"以便机器可追溯, 或在 sprint 结尾跑一遍 audit-revalidation。

---

## §F. 0 业务代码改动验证

```bash
$ git diff main..HEAD --stat
docs/superpowers/audits/2026-05-13-portability-assessment-v2.md  | N +
```

仅 1 个新文件, 0 业务代码改动 ✓

---

## 附: 关键文件引用

- 上游 v1: `docs/superpowers/audits/2026-05-06-portability-assessment.md`
- block_a (已豁免): `templates/blocks/block_a_hero_robot_cover.html:1-24`
- block_b3 (数据驱动): `templates/blocks/block_b3_clean_story.html:48-54`
- block_c1 (无硬编码): `templates/blocks/block_c1_vs_data.html`
- block_c3 (新加复用): `templates/blocks/block_c3_vs_upgrade.html`
- block_f (剩 🟡): `templates/blocks/block_f_showcase_vs.html:44-67`
- param_labels (已落地): `app.py:645-659`, 使用 `app.py:770-781`
- 4 品类 build_config: `templates/{设备类,耗材类,配件类,工具类}/build_config.json`

---

**版本**: v2.0 (现状复审) → 见 §G 实施日志获取后续 3 PR 结果
**起草**: Claude Opus 4.7
**Scott 决策**: 方案 A (block_f 标签变量化) + 全栈推进 P5.x

---

## §G. 实施日志 (2026-05-13 当日追加)

v2 audit 完成后同日开干, 3 PR 全部 merge 上 main (1c36da9):

| PR | 标题 | audit 对应 | 估时 | 实测 |
|----|------|-----------|------|------|
| [#42](https://github.com/survivor2829/product-detail/pull/42) | block_f 标签变量化 (方案 A) | §B.2 / §D.1 | 1-2h | **~45min** |
| [#43](https://github.com/survivor2829/product-detail/pull/43) | theme_matcher 加 4 关键词 (浓缩/食品级/消毒/抗菌) | §C P5.3 (0.25d) | 0.5h | **~25min** |
| [#44](https://github.com/survivor2829/product-detail/pull/44) | 耗材类 CATEGORY_VARIANTS_MAP | §D.2 P5.5 (1.5d) | 1.5d | **~1.5h** ⚠️ |

**实测合计: ~2.5h vs v2 估 6h+ (P5.2 1-2h + P5.3 0.25d + P5.5 1.5d)**

### G.1 §D.2 描述偏差 (P5.5)

audit §D.2 写 "STYLE_PACKS 加耗品类专用 2-3 个风格包",但实施时发现:
- **STYLE_PACKS 系统已于 2026-05-11 整体清理** (见 `docs/STYLE_PACK_CLEANUP.md`)
- 当前架构是 `SCREEN_VARIANTS` (按 screen_type 分桶) + `DEFAULT_VARIANTS_MAP` (固定挑)
- 没有 "风格包" 这一层概念可加 entry

实施采用新的 **CATEGORY_VARIANTS_MAP 覆盖层架构** (#44):
- `prompt_templates.CATEGORY_VARIANTS_MAP[品类][屏] = variant_name`
- `resolve_variants_map(product_category)` helper, 非覆盖类目走 fast-path
- `ai_bg_cache.generate_backgrounds()` 接入 — `product_category` 入参早已存在 (0 plumbing)

语义对齐 audit 意图 ("给耗材类用更贴合的视觉调性"),但 API 与 audit 描述完全不同 — audit 写作时假设 STYLE_PACKS 仍在,这是 audit 自身未发现的 stale 点。

### G.2 audit-vs-prompt-design 教训

audit-then-implement 流程证明高效 (2.5h 推进 3 PR),但需要注意:
- audit 估时偏保守 (实测 -58%) — 推 P5.x 时不要被 audit 估时锁死,先 recon 现状再下手
- audit §D 决策建议在写作时有可能假设了已不存在的 API/系统;实施前需 grep 验证模块是否还在
- "§D 决策建议" 是 "if you implemented this in audit's reality" 的伪代码,不是实际 PR 的 spec — 实施者需要重新设计

### G.3 P5.x 剩余进度 (2026-05-13 收盘)

| 子阶段 | v2 估 | 实测 | 状态 |
|--------|------|------|------|
| P5.1 | ✅ DONE | — | PR #16 (5-6) |
| P5.2 | 1-2h | 45min | ✅ DONE (#42) |
| P5.3 | 0.25d | 25min | ✅ DONE (#43) |
| P5.5 | 1.5d | 1.5h | ✅ DONE (#44) |
| P5.6 | 2d | — | ⏳ 待启动 (e2e ¥5-10 真测) |

**P5 阶段 4/5 完成,只剩 P5.6 真测验证。**
