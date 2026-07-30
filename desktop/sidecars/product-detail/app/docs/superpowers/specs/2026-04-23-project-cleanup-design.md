# 项目清理设计 · 保守档 A

- **日期**：2026-04-23
- **目标**：清理根目录视觉噪音、归档历史文件，不改业务代码、不动活 WIP
- **风险档位**：A（保守，零业务代码改动）
- **预期收益**：根目录从 50+ 条目 → ~25；磁盘释放 ~350MB；scripts/ 从 30 文件 → ~11

---

## 1. 背景与问题陈述

用户反馈：项目根目录"电线电路全部缠在一起"，希望清理冗余、捋顺管线，避免后续扩展越来越杂。

依赖分析结论（先澄清一个关键事实）：

**项目实际上没有死代码问题**。从 `app.py` 做传递闭包，根目录 15 个 Python 模块**全部活着**（直接或间接被 import）。所谓"缠绕"感其实来源于三类视觉噪音：

1. **根目录测试产物**：9 个 demo/test 图片与 zip 共 13.7MB，全部已在 `.gitignore`
2. **历史 PRD/设计文档**：11 份根目录 markdown 中有 4-5 份已被更新版本取代
3. **scripts/ 未分桶**：30 个文件混着 "活 WIP"、"一次性完成"、"上古遗留" 三种生命周期

此外还发现 2 个具体问题：

- **`uploads/` 根目录 334MB 孤儿**：commit `f613dd2`（"UPLOAD_DIR 迁到 static/uploads 修容器持久化 bug"）迁移前的残留。无 git 历史，无代码引用，但体积巨大。
- **`build_long_image.py` 是唯一真·僵尸**：258 行，仅 `scripts/legacy/test_endpoint_html.py` 还在 import，`app.py` 和 `ai_compose_pipeline.py` 里对它的出现都只是注释/docstring，不是 import 语句。

---

## 2. 设计原则

| 原则 | 含义 |
|------|------|
| **零业务代码改动** | 本次清理不重构 Python 模块位置、不改 import 路径、不动 app.py |
| **历史可追溯** | markdown 与一次性脚本走"归档"路线，移到 `docs/archive/` 或 `scripts/archive/`，不走物理删除 |
| **活 WIP 绝对保护** | `ai_refine_v2/`、`scripts/{assemble_smoke_v2,demo_gpt_image2*,demo_refine_v2,smoke_test_refine_v2,test_deepseek_planner,refine_v1_with_gpt_image}.py` 一律不动 |
| **验证门** | 每批改完跑 `/smoke` skill，最后跑一次 `python app.py` 启动冒烟 |
| **可回滚** | 所有操作走 git，删除/移动走 `git rm` / `git mv`，commit 按步骤分开，单步出问题可 revert |

---

## 3. 具体清理清单

### 3.1 根目录物理删除（零风险）

#### A. 测试产物（13.7MB，全部已 gitignored）

| 文件 | 大小 | 类别 |
|------|------|------|
| `demo_gpt2_test1_chinese.jpg` | 1.1MB | gpt-image-2 demo 产物 |
| `demo_gpt2_test2_dz600m.jpg` | 2.3MB | gpt-image-2 demo 产物 |
| `demo_gpt2_v2_dz600m.jpg` | 2.4MB | gpt-image-2 v2 demo 产物 |
| `demo_v2_DZ600M.jpg` | 402KB | v2 demo 产物 |
| `dz10_product.jpg` | 78KB | DZ10 参考图 |
| `dz10_scene.png` | 3.6MB | DZ10 参考图 |
| `preview_full.png` | 3.7MB | 截图残留 |
| `test_batch.zip` | 5.8KB | E2E 夹具 |
| `e2e_batch.zip` | 5.8KB | E2E 夹具 |

> 这些都在 `.gitignore` 的 `*.png` / `*.jpg` / `*.zip` 规则下已被排除。物理删除等价于清缓存。

#### B. 迁移前孤儿目录

- `uploads/`（334MB，48 个用户上传文件）——commit `f613dd2` 之前的 UPLOAD_DIR，已由 `static/uploads/` 接管（419 个真实用户文件）。无 git 历史（gitignored），无代码引用。

> **执行前再次确认**：`grep -r "^UPLOAD_DIR" *.py` 应返回 `static/uploads` 路径；根目录 `uploads/` 不被任何路由写入。

#### C. 真·僵尸 Python 模块

- `build_long_image.py`（258 行，11KB）
- 证据：
  - `app.py:3108` 提到 `build_long_image.py` 是**注释**（"同一条管线也在 CLI `build_long_image.py` 里用"）
  - `ai_compose_pipeline.py:2` 提到是 **docstring**（"AI 合成管线，阶段三抽取自 build_long_image.py"）
  - `scripts/legacy/test_endpoint_html.py` 是唯一真 import，但 `scripts/legacy/` 整个在本次归档范围内

### 3.2 scripts/ 归档重整

新建两桶：`scripts/archive/legacy/` 和 `scripts/archive/one_shot/`。

#### 保留在 scripts/ 根（活 WIP + 工具类，共 11 个）

**活 v2 WIP**（最近一周还在推）：
- `assemble_smoke_v2.py`
- `demo_gpt_image2.py` / `demo_gpt_image2_v2.py`
- `demo_refine_v2.py`
- `smoke_test_refine_v2.py`
- `test_deepseek_planner.py`
- `refine_v1_with_gpt_image.py`

**工具类**（可复用，随时可能再跑）：
- `generate_secrets.py`
- `make_test_batch_zip.py`
- `download_scene_bank.py`
- `populate_scene_bank.py`
- `cleanup_orphan_items.py`

#### 移入 `scripts/archive/legacy/`（原 `scripts/legacy/`，20 个文件）

整个 `scripts/legacy/` 目录改名为 `scripts/archive/legacy/`，内容不变。

#### 移入 `scripts/archive/one_shot/`（已完成的一次性脚本，12 个）

**阶段四/紧急回归 verify**（已跑过，生产稳定）：
- `verify_phase4_step_a.py` / `verify_phase4_step_b.py` / `verify_phase4_step_d.py`
- `verify_task11_step_c.py` / `verify_task2_realtime.py`
- `verify_refine_worker_context.py` / `verify_render_worker_context.py`
- `verify_history_detail.py` / `verify_scene_match.py`

**任务 6/7/8 一次性 smoke**（历史任务已完成）：
- `smoke_task6_history.py` / `smoke_task7_csrf.py` / `smoke_task8_concurrency.py`
- `smoke_stage_a.py`

**已执行过的数据库迁移**：
- `migrate_sqlite_to_pg.py`（Stage 6 上线迁移，跑过一次）
- `migrate_task9_theme_columns.py`（任务 9 加列，跑过一次）

**早期批量测试**：
- `test_batch_login_flow.py`
- `test_ws_smoke.py`

> 保留 `migrate_*.py` 归档（不删），因为生产故障时可能复查迁移 SQL。

### 3.3 markdown 归档

#### 保留根目录（6 份活文档）

| 文件 | 理由 |
|------|------|
| `CLAUDE.md` | Claude Code 协作约定（项目配置） |
| `DEPLOYMENT.md` | 生产部署手册，4/21 刚更新 |
| `ENV_TEMPLATE.md` | 环境变量参考，4/21 |
| `README.md` | 项目门面（即使旧了也留，择日更新） |
| `PROJECT_STATUS_批量生成.md` | 批量系统活设计文档，4/22 刚改，61KB |
| `PRD_紧急3回归修复_20260422.md` | 昨天的紧急修复 PRD |

#### 移入 `docs/archive/`（4 份历史文档）

`docs/archive/` 已存在且已放了 3 份老 PRD（`PRD_AI生图_无缝详情页补充.md` / `PRD_AI生图双引擎.md` / `PRD_极简模式_v2.md`），模式已确立。

- `CLOUD_HANDOFF.md`（5.7KB，4/9，初始上云手册，已被 DEPLOYMENT.md 取代）
- `DESIGN.md`（4.1KB，4/9，早期 UI 设计）
- `PRD_AI生图专业管线_v3.md`（13KB，4/14，被后续 v2 重构取代）
- `PRD_批量生成.md`（14KB，4/21，被 PROJECT_STATUS_批量生成.md 取代）

### 3.4 缓存/输出目录（保留目录，清空内容）

| 目录 | 大小 | 处理 |
|------|------|------|
| `output/` | 199MB | 清空（保留空目录，gitignored） |
| `smoke_output_v2/` | 19MB | 清空 |
| `v2_result/` | 1.4MB | 清空 |
| `test_batch_input/` | 70KB | 清空 |
| `__pycache__/`（多处） | 644KB 根 | `find . -name __pycache__ -exec rm -rf {} +` |

> 这一步可以放到最后一步、执行前单独确认（因为是本地环境的缓存，删了没事但也不是必须）。

### 3.5 绝对不动清单

- `app.py`（244KB Flask 入口，A 档不重构）
- 根目录 15 个活 Python 模块，位置不变：`ai_*.py` / `batch_*.py` / `admin.py` / `auth.py` / `extensions.py` / `models.py` / `crypto_utils.py` / `image_composer.py` / `theme_*.py` / `refine_processor.py` / `pricing_config.py` / `prompt_templates.py`
- `ai_refine_v2/`（活 WIP 子包）
- `static/`（1.3GB 生产数据，含 `static/uploads/` 419 真实文件）
- `templates/` / `migrations/` / `pubsub/`
- `.claude/` / `.gitignore` / `.dockerignore` / `Dockerfile` / `docker-compose*.yml`
- `requirements.txt` / `deploy.sh` / `render.yaml`

---

## 4. 执行顺序（6 步 · 每步一次 commit）

| 步 | 操作 | commit 前验证 |
|----|------|---------------|
| 1 | 删根目录 9 个测试产物 + 2 个 zip | git status 干净 |
| 2 | 删 `uploads/` 孤儿目录（确认 UPLOAD_DIR 指向 static/uploads 后） | `python -c "import app"` 不报错 |
| 3 | 删 `build_long_image.py` + 验证 app.py 启动 | `/smoke` 通过 |
| 4 | scripts/ 重整（新建 archive/，move legacy → archive/legacy/，move 12 个一次性脚本 → archive/one_shot/） | scripts/ 根只剩 11 个文件 |
| 5 | markdown 归档：4 份老 PRD/设计移到 docs/archive/ | 根目录 markdown 只剩 6 个 |
| 6 | （可选）清 output/ / smoke_output_v2/ / v2_result/ / __pycache__ | 执行前再问用户一次 |

### 4.1 每步之间的验证门

- **硬验证**：`/smoke` skill（30 秒）—— 每步 commit 前必跑
- **最终验证**：`python app.py` 启动 + 访问首页 + 生成一张 AI 图（端到端冒烟）
- **回滚策略**：每步独立 commit，出问题 `git revert <sha>` 即可

---

## 5. 不做什么（YAGNI）

- ❌ 不把 15 个根模块搬到 `core/` / `ai/` / `batch/` 子包（那是 B 档，在 ai_refine_v2 收尾前做风险高）
- ❌ 不拆 app.py 为 Flask Blueprints（C 档，需要半天以上 + 高回归风险）
- ❌ 不改任何 import（本次清理不产生 1 行业务代码 diff）
- ❌ 不动 static/ 下任何生产数据（哪怕 1.3GB 大部分是用户测试上传）
- ❌ 不清 `.venv/` / `.probe/` / `.omc/`（Claude/OMC 工具自己的东西，不归本次管）
- ❌ 不写任何新 README / 迁移说明文档（除了这份 spec 本身）

---

## 6. 成功标准

清理完成后：

1. **目录外观**：根目录 `ls` 输出 ≤ 25 行（当前 50+）
2. **磁盘**：`du -sh .` 比清理前少 ~350MB（主要来自 `uploads/` 334MB + `output/` 如清理）
3. **代码完整性**：`python app.py` 正常启动；`/smoke` 全绿；`/api/generate-ai-detail` 能跑通一次
4. **可追溯性**：所有归档文件都能在 `docs/archive/` 或 `scripts/archive/` 找到，git log 清晰可读
5. **零业务变更**：`git diff HEAD~6 -- *.py | grep -v "^[+-]--"` 应该是空（没有 .py 内容改动，只有 rename/delete）

---

## 7. 附录：依赖图验证数据

### 7.1 app.py 直接 import 的本地模块

```
ai_bg_cache, batch_upload, batch_queue, batch_processor, batch_pubsub,
extensions, models, auth, admin
```

### 7.2 app.py 路由内 lazy import（运行时加载）

```
ai_image, image_composer, ai_image_router, theme_color_flows,
refine_processor, ai_compose_pipeline, theme_matcher, crypto_utils,
pricing_config
```

### 7.3 传递 import（由上述模块间接拉入）

```
ai_image_volcengine  ← ai_bg_cache
prompt_templates     ← ai_bg_cache
pubsub.memory        ← batch_pubsub
pubsub.redis_backend ← batch_pubsub
```

### 7.4 唯一僵尸

```
build_long_image  ← 仅 scripts/legacy/test_endpoint_html.py
```
