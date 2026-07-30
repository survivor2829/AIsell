# [STUB] §B1 app.py 5417 行 God Object — Blueprint 拆分

> ⚠️ 草稿状态: 由 P2 audit 自动生成
> 来源: § Top 10 #8 / §B.1 (= §C.3)
> 严重度: 严重
> 估时: 2d
> **阻塞 P5/P6**: yes

## 问题简述

`app.py` 单文件 5417 行, 82 个 def, 42 个 `@app.route`。混合 Flask 路由 / 业务逻辑 / 数据转换 / AI 调用四层职责。`_map_parsed_to_form_fields` (269 行) / `_build_category_prompt` (330 行) / `_assemble_all_blocks` (287 行) 均不依赖 Flask request 但嵌在路由层。

## 根因诊断

**根因 1 — app.py 单文件累积**。修这一处 = 解决 §B.1 + §C.3 + §B.5 + §B.7 + §C.8 + 部分 §C.5 + §C.6 共 6+ 表象。

每新增品类要在同一文件加 if/else, P5/P6 (耗品/工具/配耗) 必爆破到 7000+ 行不可维护。

## 修复方案

### 方案 A — Blueprint + 纯函数模块拆分 (推荐, 必做)

按职责拆 4 Blueprint + 2 纯函数模块:
1. `routes/batch.py` Blueprint (app.py:1112-2210, 21 routes 关于 batch)
2. `routes/ai.py` Blueprint (app.py:2752-3630, 8 routes 关于 AI 生图)
3. `routes/build.py` Blueprint (app.py:4557-5290, build/preview 路由)
4. `routes/auth.py` (auth.py 已是, 仅 ensure 一致)
5. `services/parse_utils.py` 纯函数 (app.py:252-880 的数据转换 - 不依赖 Flask)
6. `services/deepseek_client.py` (app.py:2296-2723 的 prompt + HTTP)

剩 `app.py` 仅: app factory + extension init + Blueprint 注册, 目标 < 500 行。

**实施顺序** (低风险增量):
- Step 1: 抽 services/parse_utils.py (纯函数, 0 路由依赖, 测试最容易)
- Step 2: 抽 services/deepseek_client.py
- Step 3: 抽 routes/batch.py (最大 Blueprint, 最难)
- Step 4: 抽 routes/ai.py
- Step 5: 抽 routes/build.py
- Step 6: app.py 减肥到 app factory

每 step 1 PR, 全测 ≥ 245 通过才合下一步。

- 优势: 解耦根因 1, 解锁 P5/P6, 修循环 import (§B.2)
- 劣势: 工作量大; 需要小心 import 顺序; batch_processor / refine_processor 的 `from app import` 需同步改
- 估时: 2d (机械移动 + 修 import + 全量跑测; 实际可能 3d)

### 方案 B — 不拆, 仅加注释分区
- 在 app.py 内用 `# === BATCH ROUTES === ` 大注释分块
- 优势: 0 风险
- 劣势: 不解决任何实质问题, P5/P6 仍卡
- 估时: 1h
- **不推荐**

## 兜底/回滚

每个 Step 独立 PR, 出问题 revert 一个 Step 不影响其他。

## 测试要求

- 全测 ≥ 245 通过 (基线)
- 加: app factory 测试 (确认 Blueprint 都注册 + 路由都注册)
- 加: 各 Blueprint 独立测试 (不需 import app)

## 转正式 spec checklist

- [ ] Scott 决策 "修" (强烈建议作为 P4 第一个 sprint)
- [ ] 拆为 6 个独立 PR (per Step)?
- [ ] 进入 P4

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
