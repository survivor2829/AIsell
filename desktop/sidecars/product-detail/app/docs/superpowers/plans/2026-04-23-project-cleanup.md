# 项目清理实施计划 · A 档保守

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理 `clean-industry-ai-assistant` 项目根目录的视觉噪音（测试产物、孤儿目录、历史 markdown、未分桶脚本），释放约 350MB 磁盘，零业务代码改动。

**Architecture:** 按生命周期分桶——活代码留原位、一次性/历史工件归档到 `docs/archive/` 或 `scripts/archive/`、纯垃圾物理删除。每步一个 git commit，每步后跑 `/smoke` 或 `python -c "import app"` 做门禁验证，出错 `git revert` 即可。

**Tech Stack:** git / bash / Claude Code `/smoke` skill / Flask (仅用于运行冒烟，不改代码)

**Spec:** [`docs/superpowers/specs/2026-04-23-project-cleanup-design.md`](../specs/2026-04-23-project-cleanup-design.md)

---

## 执行顺序与依赖

```
Task 0 (preflight) → Task 1 (artifacts)
                   → Task 2 (orphan uploads/)
                   → Task 3 (build_long_image.py)
                   ↓
Task 4 (scripts/ 重整) ← 依赖 Task 3 先完成（build_long_image 唯一 real importer 在 legacy/）
                   ↓
Task 5 (markdown 归档)
                   ↓
Task 6 (optional: 缓存清空)
```

---

## Task 0: Preflight — 建立安全基线

**Files:** 无（仅验证）

- [ ] **Step 1: 确认 git 工作区无未提交改动会受影响**

Run:
```bash
git status --short
```
Expected: 只有已知的 untracked 文件（PRD_紧急3回归修复_20260422.md、scripts/assemble_smoke_v2.py、scripts/demo_gpt_image2.py、scripts/demo_refine_v2.py、scripts/refine_v1_with_gpt_image.py、scripts/smoke_test_refine_v2.py、smoke_output_v2/、v2_result/）。**没有 modified 文件**。

如果有意外 modified 文件：停止，先让用户处理。

- [ ] **Step 2: 确认当前在 main 分支，且和 origin 同步**

Run:
```bash
git branch --show-current && git log --oneline origin/main..HEAD 2>/dev/null | wc -l
```
Expected: `main` + `0`（无未 push 的本地 commit），或者用户确认未 push commit是已知状态。

- [ ] **Step 3: 用 `/smoke` 验证当前 app 能跑**

Run:
```bash
# 在 Claude Code 里执行
/smoke
```
Expected: 全绿。如果 smoke 已经红了，说明项目在清理前就坏的，得先修。**不要在红 smoke 的基础上开始清理**。

- [ ] **Step 4: 记录清理前磁盘快照**

Run:
```bash
du -sh . 2>/dev/null | head -1 && echo "---" && ls -1 | wc -l
```
Expected: 记住当前总大小与根目录条目数，用于 Task 6 之后的 before/after 对比。

---

## Task 1: 删根目录 9 个测试产物

**Files:**
- Delete: `demo_gpt2_test1_chinese.jpg` / `demo_gpt2_test2_dz600m.jpg` / `demo_gpt2_v2_dz600m.jpg` / `demo_v2_DZ600M.jpg` / `dz10_product.jpg` / `dz10_scene.png` / `preview_full.png` / `test_batch.zip` / `e2e_batch.zip`

- [ ] **Step 1: 验证这些文件确实未被 git 跟踪**

Run:
```bash
git ls-files demo_gpt2_test1_chinese.jpg demo_gpt2_test2_dz600m.jpg demo_gpt2_v2_dz600m.jpg demo_v2_DZ600M.jpg dz10_product.jpg dz10_scene.png preview_full.png test_batch.zip e2e_batch.zip
```
Expected: **空输出**（全在 .gitignore 下，git 根本没跟踪）。如果任一文件在 git 里，停止，换用 `git rm`。

- [ ] **Step 2: 物理删除**

Run:
```bash
rm -f demo_gpt2_test1_chinese.jpg demo_gpt2_test2_dz600m.jpg demo_gpt2_v2_dz600m.jpg demo_v2_DZ600M.jpg dz10_product.jpg dz10_scene.png preview_full.png test_batch.zip e2e_batch.zip
```
Expected: 无错误输出。

- [ ] **Step 3: 验证 git status 没有新变动**

Run:
```bash
git status --short | grep -E "(demo_gpt2|demo_v2|dz10_|preview_full|test_batch|e2e_batch)"
```
Expected: **空输出**（因为这些文件不在 git，删了 git 也察觉不到）。

- [ ] **Step 4: 验证 app 仍能启动**

Run:
```bash
python -c "import app; print('import OK')"
```
Expected: `import OK`（或 Flask 正常初始化输出，不报错）。

- [ ] **Step 5: 无需 commit**（因为文件从未在 git 里）

跳过 commit，直接进 Task 2。

---

## Task 2: 删根目录 uploads/ 孤儿目录（334MB）

**Files:**
- Delete: `uploads/`（整个目录，48 个用户上传文件）

- [ ] **Step 1: 二次验证 UPLOAD_DIR 指向 static/uploads**

Run:
```bash
grep -n "UPLOAD_DIR\s*=" app.py
```
Expected: 仅一行 `UPLOAD_DIR = BASE_DIR / "static" / "uploads"`（或等价路径）。**不应有任何赋值指向根 `uploads/`**。

- [ ] **Step 2: 验证没有代码从根 uploads/ 读取**

Run:
```bash
grep -rn --include="*.py" -E '["\x27]uploads/' . | grep -v "static/uploads" | grep -v "^./test" | grep -v "^./scripts/archive" | grep -v "^./scripts/legacy"
```
Expected: **空输出**。如果有命中，停止，逐行审查命中行是否是字符串常量、注释还是真引用。

- [ ] **Step 3: 验证 uploads/ 未被 git 跟踪**

Run:
```bash
git ls-files uploads/ | head -5
```
Expected: 空输出（整个目录在 .gitignore `uploads/` 规则下）。

- [ ] **Step 4: 备份目录大小（仅记录，方便回滚判断）**

Run:
```bash
du -sh uploads/ && ls uploads/ | wc -l
```
Expected: 约 334MB，约 48 文件。

- [ ] **Step 5: 物理删除**

Run:
```bash
rm -rf uploads/
```
Expected: 无输出。

- [ ] **Step 6: 后置验证 app 启动 + 上传路由仍指向 static/uploads**

Run:
```bash
python -c "import app; from pathlib import Path; print('UPLOAD_DIR=', app.UPLOAD_DIR, 'exists=', Path(app.UPLOAD_DIR).exists())"
```
Expected: `UPLOAD_DIR=<root>/static/uploads exists=True`。

- [ ] **Step 7: 跑 /smoke**

Run:
```bash
/smoke
```
Expected: 全绿。

- [ ] **Step 8: 无需 commit**（uploads/ 不在 git 里）

继续 Task 3。

---

## Task 3: 删 build_long_image.py 僵尸模块

**Files:**
- Delete: `build_long_image.py`（258 行，11KB）

- [ ] **Step 1: 最终 grep 确认没有真 import**

Run:
```bash
grep -rn --include="*.py" -E "^(from build_long_image|import build_long_image|from \.build_long_image)" . | grep -v "^./scripts/legacy"
```
Expected: **空输出**。`scripts/legacy/test_endpoint_html.py` 的引用不算（它马上会归档）。

- [ ] **Step 2: 验证文件目前被 git 跟踪**

Run:
```bash
git ls-files build_long_image.py
```
Expected: `build_long_image.py`（说明它在 git 里，要用 `git rm`）。

- [ ] **Step 3: git rm**

Run:
```bash
git rm build_long_image.py
```
Expected: `rm 'build_long_image.py'`。

- [ ] **Step 4: app import 冒烟**

Run:
```bash
python -c "import app; print('app imported OK')"
```
Expected: `app imported OK`。

- [ ] **Step 5: /smoke**

Run:
```bash
/smoke
```
Expected: 全绿。

- [ ] **Step 6: commit**

Run:
```bash
git commit -m "chore(cleanup): 删僵尸模块 build_long_image.py

- 唯一真 import 在 scripts/legacy/test_endpoint_html.py(下一步归档)
- app.py / ai_compose_pipeline.py 里只剩注释和 docstring 提到它
- 258 行 CLI 工具已由 ai_compose_pipeline 接管

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: 重整 scripts/ —— 建 archive/ 分桶

**Files:**
- Create dir: `scripts/archive/legacy/`
- Create dir: `scripts/archive/one_shot/`
- Rename: `scripts/legacy/` → `scripts/archive/legacy/`（20 个文件整体搬家）
- Move to `scripts/archive/one_shot/`（17 个一次性脚本）：
  - `verify_phase4_step_a.py` / `verify_phase4_step_b.py` / `verify_phase4_step_d.py`
  - `verify_task11_step_c.py` / `verify_task2_realtime.py`
  - `verify_refine_worker_context.py` / `verify_render_worker_context.py`
  - `verify_history_detail.py` / `verify_scene_match.py`
  - `smoke_task6_history.py` / `smoke_task7_csrf.py` / `smoke_task8_concurrency.py` / `smoke_stage_a.py`
  - `migrate_sqlite_to_pg.py` / `migrate_task9_theme_columns.py`
  - `test_batch_login_flow.py` / `test_ws_smoke.py`

**Preserved in scripts/ root（12 files）:**
- 活 WIP (7): `assemble_smoke_v2.py` / `demo_gpt_image2.py` / `demo_gpt_image2_v2.py` / `demo_refine_v2.py` / `smoke_test_refine_v2.py` / `test_deepseek_planner.py` / `refine_v1_with_gpt_image.py`
- 工具 (5): `generate_secrets.py` / `make_test_batch_zip.py` / `download_scene_bank.py` / `populate_scene_bank.py` / `cleanup_orphan_items.py`

- [ ] **Step 1: 确认没有活代码依赖 scripts/legacy/ 或要归档的文件名**

Run:
```bash
grep -rn --include="*.py" -E "scripts/(legacy|verify_phase4|verify_task11|verify_task2|verify_refine_worker|verify_render_worker|verify_history_detail|verify_scene_match|smoke_task|smoke_stage|migrate_sqlite|migrate_task9|test_batch_login|test_ws_smoke)" app.py *.py 2>/dev/null
```
Expected: 空输出。活业务代码不该引用 scripts/。

- [ ] **Step 2: 建目标桶**

Run:
```bash
mkdir -p scripts/archive/one_shot
```

- [ ] **Step 3: 把 scripts/legacy/ 整个目录改名到 archive/legacy/**

Run:
```bash
git mv scripts/legacy scripts/archive/legacy
```
Expected: git 识别为 rename，无错误。

- [ ] **Step 4: 把 12 个一次性脚本逐个 git mv 到 archive/one_shot/**

Run:
```bash
for f in \
  verify_phase4_step_a.py verify_phase4_step_b.py verify_phase4_step_d.py \
  verify_task11_step_c.py verify_task2_realtime.py \
  verify_refine_worker_context.py verify_render_worker_context.py \
  verify_history_detail.py verify_scene_match.py \
  smoke_task6_history.py smoke_task7_csrf.py smoke_task8_concurrency.py smoke_stage_a.py \
  migrate_sqlite_to_pg.py migrate_task9_theme_columns.py \
  test_batch_login_flow.py test_ws_smoke.py; do
  if [ -f "scripts/$f" ]; then
    git mv "scripts/$f" "scripts/archive/one_shot/$f"
  else
    echo "MISSING: scripts/$f"
  fi
done
```
Expected: 无 "MISSING" 输出。每行产生一个 rename。

- [ ] **Step 5: 验证 scripts/ 根目录现在只剩活 WIP + 工具**

Run:
```bash
ls scripts/ | grep -v __pycache__ | grep -v archive
```
Expected: 恰好 12 个条目——
```
assemble_smoke_v2.py
cleanup_orphan_items.py
demo_gpt_image2.py
demo_gpt_image2_v2.py
demo_refine_v2.py
download_scene_bank.py
generate_secrets.py
make_test_batch_zip.py
populate_scene_bank.py
refine_v1_with_gpt_image.py
smoke_test_refine_v2.py
test_deepseek_planner.py
```

- [ ] **Step 6: app import 冒烟**

Run:
```bash
python -c "import app; print('app imported OK')"
```
Expected: `app imported OK`（scripts/ 搬动对 app 毫无影响，但做一次防御性验证）。

- [ ] **Step 7: /smoke**

Run:
```bash
/smoke
```
Expected: 全绿。

- [ ] **Step 8: commit**

Run:
```bash
git commit -m "chore(cleanup): scripts/ 归档 —— 活 WIP+工具留根,历史脚本入 archive/

- scripts/legacy/ → scripts/archive/legacy/ (20 个古早 e2e/verify)
- scripts/archive/one_shot/ 新增 17 个一次性脚本:
  verify_phase4_*, verify_task11/2, verify_{refine,render}_worker_context,
  verify_history_detail, verify_scene_match, smoke_task6/7/8, smoke_stage_a,
  migrate_sqlite_to_pg, migrate_task9_theme_columns,
  test_batch_login_flow, test_ws_smoke
- scripts/ 根只留 12 个(活 v2 WIP 7 + 工具 5),从 30 文件 → 12 文件

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: 归档 4 份老 markdown 到 docs/archive/

**Files:**
- Move: `CLOUD_HANDOFF.md` → `docs/archive/CLOUD_HANDOFF.md`
- Move: `DESIGN.md` → `docs/archive/DESIGN.md`
- Move: `PRD_AI生图专业管线_v3.md` → `docs/archive/PRD_AI生图专业管线_v3.md`
- Move: `PRD_批量生成.md` → `docs/archive/PRD_批量生成.md`

- [ ] **Step 1: 验证这 4 个文件没被别处引用**

Run:
```bash
grep -rn --include="*.py" --include="*.md" --include="*.html" --include="*.yml" \
  -E "(CLOUD_HANDOFF|DESIGN\.md|PRD_AI生图专业管线|PRD_批量生成)" \
  . 2>/dev/null | grep -v "^./docs/archive" | grep -v "^./\.git"
```
Expected: 只能命中文件自身或 spec 引用。不应有 `include`/`import`/CI 规则命中。

- [ ] **Step 2: 确认 docs/archive/ 存在**

Run:
```bash
ls docs/archive/
```
Expected: 已有 3 份文件 (PRD_AI生图_无缝详情页补充.md / PRD_AI生图双引擎.md / PRD_极简模式_v2.md)。

- [ ] **Step 3: 逐个 git mv**

Run:
```bash
git mv CLOUD_HANDOFF.md docs/archive/CLOUD_HANDOFF.md
git mv DESIGN.md docs/archive/DESIGN.md
git mv "PRD_AI生图专业管线_v3.md" "docs/archive/PRD_AI生图专业管线_v3.md"
git mv "PRD_批量生成.md" "docs/archive/PRD_批量生成.md"
```
Expected: 4 个 rename 无错误。

- [ ] **Step 4: 验证根目录 markdown 只剩 6 份**

Run:
```bash
ls *.md 2>/dev/null
```
Expected: 恰好这 6 份（顺序不限）——
```
CLAUDE.md
DEPLOYMENT.md
ENV_TEMPLATE.md
PROJECT_STATUS_批量生成.md
PRD_紧急3回归修复_20260422.md
README.md
```

> 注意：`PRD_紧急3回归修复_20260422.md` 当前是 untracked 状态，不会被这步影响，保持不动。

- [ ] **Step 5: commit**

Run:
```bash
git commit -m "chore(cleanup): 归档 4 份老 PRD/设计文档到 docs/archive/

- CLOUD_HANDOFF.md (4/9, 已被 DEPLOYMENT.md 取代)
- DESIGN.md (4/9, 早期 UI 设计,已过期)
- PRD_AI生图专业管线_v3.md (4/14, 被后续 v2 重构取代)
- PRD_批量生成.md (4/21, 被 PROJECT_STATUS_批量生成.md 取代)

根目录 markdown 从 11 → 6 (保留活的: CLAUDE / DEPLOYMENT / ENV_TEMPLATE /
PROJECT_STATUS_批量生成 / PRD_紧急3回归修复 / README)。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6 (OPTIONAL): 清缓存与测试输出

> **执行前必须再次询问用户确认**。这步不影响功能，但会删掉你本地跑的所有历史 AI 图片输出缓存。

**Files:** 清空 `output/` / `smoke_output_v2/` / `v2_result/` / `test_batch_input/` 内容；清所有 `__pycache__/`

- [ ] **Step 1: 询问用户确认**

显式问："要不要顺便清掉 output/ (199MB)、smoke_output_v2/ (19MB)、v2_result/ (1.4MB) 里的 AI 图片缓存？这些都是 gitignored 的历史生成产物，删了不影响功能但下次生成要重跑。另外清所有 __pycache__/ (~1MB)。"

- [ ] **Step 2: 得到确认后清空（保留目录本身）**

Run:
```bash
find output smoke_output_v2 v2_result test_batch_input -mindepth 1 -delete 2>/dev/null
find . -type d -name __pycache__ -not -path "./.venv/*" -exec rm -rf {} + 2>/dev/null
```
Expected: 无错误。

- [ ] **Step 3: 验证目录存在但为空**

Run:
```bash
for d in output smoke_output_v2 v2_result test_batch_input; do
  [ -d "$d" ] && echo "$d: $(ls $d | wc -l) items"
done
```
Expected: 每个目录都 `0 items`。

- [ ] **Step 4: app import 最终冒烟**

Run:
```bash
python -c "import app; print('app imported OK')"
```
Expected: `app imported OK`（__pycache__ 被清会触发首次重新编译，可能慢一点但应成功）。

- [ ] **Step 5: 无 commit**（全是 gitignored 目录的内容）

---

## Task 7: 最终端到端验证

**Files:** 无

- [ ] **Step 1: 启动 Flask 并访问首页**

Run:
```bash
python app.py &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5000/
kill %1
```
Expected: `200`（或 302 重定向到 /login 也算正常）。

- [ ] **Step 2: 磁盘 before/after 对比**

Run:
```bash
du -sh . 2>/dev/null | head -1 && ls -1 | wc -l
```
Expected: 总大小比 Task 0 记录的少 ≥ 350MB；根目录条目数 ≤ 30。

- [ ] **Step 3: git log 检查 commit 历史清晰**

Run:
```bash
git log --oneline -6
```
Expected: 最近 3 个 commit 应该是：
1. `chore(cleanup): 归档 4 份老 PRD/设计文档`
2. `chore(cleanup): scripts/ 归档`
3. `chore(cleanup): 删僵尸模块 build_long_image.py`

（Task 1/2 没产生 commit，因为操作的是 gitignored 文件）

- [ ] **Step 4: 验证零业务代码 diff**

Run:
```bash
git diff HEAD~3 HEAD -- '*.py' | grep -E "^[+-]" | grep -vE "^(\+\+\+|\-\-\-) " | head -20
```
Expected: **空输出**（只 rename / delete，没有 .py 内容改动）。如果有非空输出，说明不小心改了代码，需要回查。

---

## 出错时的回滚指南

| Task | 如果失败 | 回滚 |
|------|---------|------|
| T1/T2 (rm gitignored) | 误删非 gitignored 文件 | `git checkout -- <file>`（gitignored 的那些无法恢复，但本来也不在 git 里） |
| T3 (rm build_long_image.py) | /smoke 红了 | `git revert HEAD` |
| T4 (scripts rename) | import 报错 | `git revert HEAD`；重查哪个 live module 在 import scripts/ 内容 |
| T5 (markdown 归档) | 某处 CI 或脚本依赖这些 md | `git revert HEAD`；把该 md 从 docs/archive/ 挪回根 |
| T6 (清缓存) | 下次生成变慢 | 正常现象，缓存会自动重建；不算失败 |

---

## 成功标准（验收 checklist）

- [ ] 根目录 `ls` 条目数 ≤ 30（当前 50+）
- [ ] 总磁盘占用减少 ≥ 350MB
- [ ] `python app.py` 启动不报错，访问 `/` 返回 200/302
- [ ] `/smoke` 全绿
- [ ] `git log --oneline -6` 显示 3 个 `chore(cleanup)` commit，顺序正确
- [ ] `git diff HEAD~3 HEAD -- '*.py'` 内容区无新增/修改行（只有 rename/delete）
- [ ] `docs/archive/` 有 7 个文件（原 3 + 新归档 4）
- [ ] `scripts/` 根目录有 12 个 `.py` 文件；`scripts/archive/legacy/` 有 20 个；`scripts/archive/one_shot/` 有 17 个
