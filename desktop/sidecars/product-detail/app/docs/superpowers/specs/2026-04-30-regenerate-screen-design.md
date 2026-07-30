# 单屏重生成（reroll）· 设计规范

> 决策点 A1 (长图 + 分屏 toggle) / A2 (仅 batch detail 完成后) / B3 (¥0.70 确认弹窗)

## 1. 背景与目标

### 1.1 问题陈述

v3.2.2 双图锚定（`color_anchor` hex + cutout）把跨屏颜色一致率从 v3.0 的 ~50% 推到 ~85-90%，这是 prompt 工程对 gpt-image-2 的事实天花板——每屏 1 次独立 API 调用 → 11~12 次独立采样 → model attention 对 anchor 的"听话率"天然有方差。

**用户实测**：偶尔出现"上一屏跟主图颜色一致，下下下屏跳成另一种颜色"，**形态一致**但**配色不稳**。

继续追 v3.3 颜色优化的边际收益估计 < 5%，且每个 cycle 引入新边界 case 风险。

### 1.2 解决方案

**不追完美，给逃逸阀**：让用户对个别跳色的屏一键 reroll。

类比：Midjourney / Stable Diffusion 的标准答案——给用户 reroll/variation 按钮，把"机器 85% 自动" + "用户 2 秒微调" 拼成"实际 ~99% 满意"。

### 1.3 范围与非目标

**做**：
- batch detail 页加分屏视图 + 单屏 🔄 按钮
- 后端单屏重生成端点（复用 `_generate_one_block_v2`）
- ¥0.70 单次确认弹窗（复用 estimate modal pattern）
- 重生成后重拼 `ai_refined.jpg` + WS 推 `screen_regenerated` 事件

**不做**：
- 批量生成中介入（仅完成后才能 reroll，不引入运行中状态机复杂度）
- 跨屏批量 reroll（一次只动一屏）
- v1 path 兼容（v1 早期没有分屏 jpg，仅 v3.2 v2 path 支持）
- 历史 reroll 记录持久化到 DB（用日志足够）

## 2. 用户故事

```
作为已完成精修的批次 owner，
我打开 batch detail 页看 ai_refined.jpg，发现第 5 屏颜色不对，
点击页面顶部"分屏视图"toggle，
看到 12 屏 grid + 每屏角上 🔄 按钮，
点第 5 屏的 🔄，
弹"重生此屏将消耗 ¥0.70，确认？"，
点确认后看到第 5 屏开始转圈 (~30s)，
重生成完成 → 第 5 屏图刷新 + 长图也同步刷新 + 通知"已重生第 5 屏"。
```

## 3. 架构设计

### 3.1 数据流

```
Frontend                        Backend                     Disk / API
─────────                       ────────                    ──────────
点 🔄 → 弹确认                   
确认 → POST /regenerate-screen ──► 验权
                                ─► 加 per-(item, idx) lock
                                ─► 读 result.task_id
                                ─► 读 _planning.json ◄────── static/ai_refine_v2/<tid>/
                                ─► 重算 color_anchor（cutout 还在）
                                ─► _generate_one_block_v2 ──► gpt-image-2 (¥0.70)
                                ─► 覆盖 block_<idx>.jpg ───► static/ai_refine_v2/<tid>/
                                ─► 重拼 12 屏 → assembled.png
                                ─► 转 JPG 覆盖 ai_refined.jpg
                                ─► WS publish screen_regenerated ─► 浏览器
                                ─► 释放锁
                                ─► return { new_block_url, new_assembled_url, cost }
浏览器 WS 收事件 → 替换该屏 img
                + 长图 cache-bust
```

### 3.2 关键文件结构

| 路径 | 职责 |
|------|------|
| `ai_refine_v2/regen_single.py` (**新建**) | 单屏重生成纯函数：输入 `(task_dir, block_index, deepseek_key, gpt_key)`，输出 `(new_block_path, new_assembled_path, cost_rmb)`。无 Flask 依赖，可单测 |
| `ai_refine_v2/tests/test_regen_single.py` (**新建**) | 单测，全 PIL 程序生成 fixture，绝不依赖真实产品图 |
| `app.py` (**修改 +~80 行**) | 加 `/api/batch/<batch_id>/items/<item_pk>/regenerate-screen` 端点 |
| `tests/test_regen_endpoint.py` (**新建**) | 端点单测：404 / 403 / 409（item 未完成）/ 423（锁住）/ 200 |
| `templates/batch/history_detail.html` (**修改 +~150 行**) | split-view toggle + 12 屏 grid + reroll 按钮 + 确认弹窗 |
| `pricing_config.py` (**修改 +~5 行**) | 加常量 `REGEN_SCREEN_UNIT_PRICE_YUAN`（复用 SEEDREAM 单价分支即可） |

### 3.3 关键决策细节

#### D1：**per-(item, block_index) 锁的实现**

用进程内 `threading.Lock()` 字典，key=`f"{item_pk}:{block_index}"`：
- gunicorn 默认 1 worker × N threads（项目配置 `gthread`），单 worker 内的 dict 锁就够
- 多 worker 场景下会有"两 worker 同时收到同一 item 的 reroll"概率，但生产是 SQLite 单写 + 用户连点 reroll 概率极低；不为这个场景上 redis lock，YAGNI
- 锁字典本身的并发安全用 `threading.Lock()` 保护

#### D2：**color_anchor 是从 cutout 重算还是缓存？**

**重算**。原因：
- cutout 文件路径在 BatchItem.parsed_json_path 旁边可推算（`<product_dir>/product_cut.png`），存在
- `extract_color_anchor` Pillow quantize 跑一次 ~50ms，可忽略
- 不引缓存避免一致性 bug

#### D3：**12 屏重拼的接口**

`pipeline_runner.py` 的 assembler 阶段是把 12 张 `block_*.jpg` PIL paste 到一张长图。需要把这段拼接逻辑**抽出**成纯函数 `assemble_long_image(task_dir: Path) -> Path`，新模块 `regen_single.py` 调用它。原 pipeline_runner 也改成调它。

如果 pipeline_runner 内联难抽，**fallback**：在 `regen_single.py` 内重写一份独立拼接（12 张 jpg → 1 张 PNG → 转 JPG），代价是临时 DRY 违反，等下个 PR 抽公共模块。**任务执行时根据现场决定**。

#### D4：**WS 事件 schema**

新事件类型 `screen_regenerated`，沿用 batch_pubsub 现有 publish 接口：

```json
{
  "type": "screen_regenerated",
  "batch_id": "<bid>",
  "item_pk": 123,
  "block_index": 4,
  "new_block_url": "/static/ai_refine_v2/v2_xxx/block_4.jpg?v=1714467890",
  "new_assembled_url": "/uploads/batches/.../ai_refined.jpg?v=1714467890",
  "cost_rmb": 0.7,
  "ts": 1714467890.123
}
```

cache-bust query string `?v=<unix_ts>` 让浏览器拿到新版本（避免 304）。

#### D5：**前端 split-view toggle 状态**

不存 localStorage（YAGNI）。每次进 detail 页默认长图视图，toggle 切成分屏视图，刷新页面回长图。

## 4. 安全 / 边界

| 场景 | 处理 |
|------|------|
| BatchItem 不属于当前用户 | 403 |
| BatchItem 不存在 / 已删除 | 404 |
| BatchItem.ai_refine_status != "done" | 409 "仅完成的产品可 reroll" |
| block_index 越界 (< 0 或 >= len(blocks)) | 400 |
| task_dir / `_planning.json` 缺失（task_id 已过期清理） | 410 "原始任务产物已清理，无法 reroll，请重启精修" |
| 同一 (item, block) 锁住中 | 423 "另一个 reroll 进行中，请稍候" |
| gpt-image-2 调用失败 | 500 + 错误透传，**不扣费**（_generate_one_block_v2 失败已不计费） |
| 重拼失败 | 500，但**新 block_*.jpg 保留** + 旧 assembled.png 保留 → 用户下次 reroll 任意屏会触发重拼 |
| 用户连续点 reroll 不同屏 | 不冲突（锁 key 不同），并行处理 |

## 5. 测试策略

### 5.1 单测覆盖

**`test_regen_single.py`** (TDD 必经):
- ✅ `regenerate_screen` 调 `_generate_one_block_v2` 一次（mock API）
- ✅ block_<idx>.jpg 被覆盖（旧文件 mtime 改变）
- ✅ assembled.png 被重生成（旧文件被替换）
- ✅ 返回 `(new_block_path, new_assembled_path, cost_rmb)` schema
- ✅ block_index 越界抛 IndexError
- ✅ task_dir 不存在抛 FileNotFoundError
- ✅ `_planning.json` 缺失抛 FileNotFoundError
- ✅ color_anchor 在 cutout 不存在时 None（不阻塞，传给 generator）

**`test_regen_endpoint.py`** (TDD 必经):
- ✅ 未登录 → 302 redirect to login
- ✅ 不属于当前用户 → 403
- ✅ 批次不存在 → 404
- ✅ item_pk 不属于该批次 → 404
- ✅ ai_refine_status="processing" → 409
- ✅ block_index 越界 → 400
- ✅ task_id 找不到产物 → 410
- ✅ 锁住 → 423
- ✅ 成功 200 + payload schema
- ✅ 成功后 ai_refine_status 仍是 "done"（不变）
- ✅ 成功后 WS publish 一次 screen_regenerated 事件

### 5.2 不写 e2e

项目无前端 e2e 框架。前端改动靠**手动 prod 真测**确认（A1 toggle / 弹窗 / WS 收事件 / 图刷新）。

### 5.3 回归保护

- 跑全套 `python -m pytest`，必须 236 passed → ≥ 250 passed（新增测试）
- 关键回归：`test_refine_generator_v2.py` / `test_pipeline_runner_v2.py` 不能动，证 v3.2.2 主路径不破

## 6. 上线策略

按 v3.2.2 同款节奏：
1. 本地 TDD 落地，全测绿
2. 加 fixture 到一个真测脚本，跑 1 次真 reroll 验证（成本 ¥0.70）
3. push origin → tencent-prod git pull + restart
4. 用户在 prod 跑一次真 reroll 确认体验
5. 文档：在 README 或 CHANGELOG 加一段"v3.3 单屏 reroll"说明

## 7. 估时

- Backend (Task 1-3): 4-5h
- Frontend (Task 4-6): 2-3h
- E2E + Polish (Task 7): 1h
- 真测 + deploy: 0.5h
- **合计：~8-10h**（1-2 个工作日）

成本预算（开发期间真测）：
- 单测全 mock，¥0
- 真测脚本 1-2 次 reroll：~¥1.40

---

**Spec 起草日期**：2026-04-30
**作者**：Claude Opus 4.7（与用户共同 design review，A1+A2+B3 决策）
**前置 PRD**：`docs/PRD_AI_refine_v3.1.md`（v3.x 主线）
**前置 Spec**：`docs/superpowers/specs/2026-04-29-color-anchor-hex-design.md`（v3.2.2 颜色保真）
**对应 Plan**：`docs/superpowers/plans/2026-04-30-regenerate-screen-implementation.md`
