# PRD · 历史批次详情页 (方向 B) + 磁盘丢失提示

> **日期**: 2026-04-22
> **状态**: 待用户 review
> **前置**: 任务1 lightbox / 任务2 stage-pill + toast / A1-A3 紧急3 孪生漏洞修复 + /simplify

---

## 一句话

独立详情页展示每个历史批次的所有产品 + 预览缩略 + HTML/AI 下载按钮, 磁盘丢失的文件明示置灰, 让用户"花钱生成的图当时没下载就找不回来"不再发生。

---

## 背景

**现状完成度 50%** (见 Phase 1 诊断):
- 后端 API 几乎全了: `/api/batches`, `/api/batches/<id>`, `/api/batch/<id>/download`, `/api/batch/<id>/download-all`
- 前端只有列表骨架 `history.html`, 点击跳回 upload 页复用其逻辑, 体验断层
- 没有独立详情页 / 下载按钮 / 批量 zip UI / 磁盘丢失提示

**生产数据现状**:
- 9 个历史批次 (5 completed / 1 failed / 3 uploaded)
- 25 个产品 (13 done / 12 failed)
- 4 个 AI 精修 done
- **2026-04-22 前的 5 个批次磁盘已丢失** (紧急3 UPLOAD_DIR 迁移前在容器临时层)
- `preview.png × 12`, `ai_refined.jpg × 4` 还在

---

## 范围

### ✅ 做 (方向 B)
1. 新独立详情页 `/batch/history/<batch_id>`
2. `history.html` 列表页加**查看详情按钮** + **磁盘状态小圆点** + **批量 zip 快捷按钮**
3. 详情页每个产品 card 含: 主图缩略 + HTML 预览缩略 + AI 精修缩略 + HTML↓/AI↓ 下载按钮
4. 磁盘丢失: 缩略位置显示 "文件已丢失" + 下载按钮置灰
5. 后端 `/api/batches/<id>` 返回值加 `disk_available` + per-item `preview_png_exists` / `ai_refined_exists`

### ❌ 不做
- 搜索 / 筛选 / 分页 (无需求, 9 条记录用不上)
- 删除 / 归档 (风险大, 以后单独做)
- 恢复丢失文件 (物理丢失不可恢复)
- 权限控制 (已有 `_check_batch_owner` 足够)
- 批次元数据编辑 (只读 + 下载)

---

## UI Wireframe (文字描述)

### history.html 改动点 (原文件不破坏, 表格列加 2, 每行加 2 个按钮)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 历史批次                                          [新建批次][返回首页]    │
│                                                                         │
│ ┌──────────────────────┬──────┬──────────┬───────────┬──────────────┐ │
│ │ 批次                 │ 磁盘 │ 状态     │ 产品数     │ 操作          │ │
│ ├──────────────────────┼──────┼──────────┼───────────┼──────────────┤ │
│ │ ●测试 (第4次)        │ 🟢   │[已完成]  │ 3/3       │ [查看详情]    │ │
│ │  原名: 测试          │      │          │           │ [批量zip↓]    │ │
│ ├──────────────────────┼──────┼──────────┼───────────┼──────────────┤ │
│ │ ●测试 (第1次)        │ 🟡   │[已完成]  │ 3/3       │ [查看详情]    │ │
│ │                      │      │          │           │ [批量zip↓]    │ │
│ ├──────────────────────┼──────┼──────────┼───────────┼──────────────┤ │
│ │ ●DZ600M 无人水面…    │ 🔴   │[已完成]  │ 1/1       │ [查看详情]    │ │
│ │                      │      │          │           │ (zip置灰)     │ │
│ └──────────────────────┴──────┴──────────┴───────────┴──────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**磁盘状态 tri-state**:
- 🟢 绿点 = 所有产品的文件全在 (disk_available=true)
- 🟡 黄点 = 部分文件丢失 (有的 item 有, 有的没)
- 🔴 红点 = 全部丢失 (所有 item 都无文件)

**批次名保留点击**: 跳回 `/batch/upload#batch=xxx` (现有行为), 方便"继续精修" 场景。
**新增**: "查看详情" 按钮 → `/batch/history/<batch_id>` 独立详情页。

### history_detail.html 新增页面

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [topbar 同 history.html, 复用]                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ ← 返回列表                                           [批量zip下载]       │
│                                                                         │
│ 测试 (第4次)                                                            │
│ 创建于 2026-04-22 08:23 · [✅ 已完成] · 3/3 产品 · 磁盘 🟢             │
│                                                                         │
│ ─────────────────────────────────────────────────────────────────────── │
│                                                                         │
│ ┌───────────────────────────────────────────────────────────────────┐ │
│ │ [主图缩略 100×100]  DZ70X 新品1                   [✅ 完成]        │ │
│ │                     型号: DZ70X                                    │ │
│ │                                                                    │ │
│ │    HTML 版预览            AI 精修版预览                            │ │
│ │  ┌────────────────┐    ┌────────────────┐                          │ │
│ │  │ [preview 缩略] │    │ [ai_refined]   │                          │ │
│ │  │   [lightbox]   │    │   [lightbox]   │                          │ │
│ │  └────────────────┘    └────────────────┘                          │ │
│ │        [↓HTML版]              [↓AI版]                              │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ ┌───────────────────────────────────────────────────────────────────┐ │
│ │ [主图]  DZ600M 无人水面...              [❌ 失败 hover 看错误]    │ │
│ │                                                                    │ │
│ │  ⚠️ 文件已丢失 — 磁盘侧产物不存在. 该批次生成于 2026-04-21,        │ │
│ │     在紧急3 UPLOAD_DIR 迁移前落在容器临时层, 重启已蒸发.           │ │
│ │                                                                    │ │
│ │        [↓HTML版 (disabled)]    [↓AI版 (disabled)]                  │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Card 结构**: 横向 3 列布局 — 左侧主图缩略 + 产品名/型号/状态 pill; 中间 HTML 缩略; 右侧 AI 缩略。手机端 (<768px) 变竖排堆叠。

**Lightbox**: 复用任务1 的 `#lightboxDlg` — 缩略图点击 → `openLightbox(full_url, caption)`。

**下载按钮**: 复用 A3 修好的 `/api/batch/<id>/download?name=X&kind=html|ai` 路径。

**磁盘丢失态**: 缩略位置用 `.thumb-missing` class 显示 ⚠️ + 文案, 下载按钮 `disabled` 属性 + `.btn-disabled` 样式 (灰色 + cursor:not-allowed)。

---

## 路由清单

| 方法 | 路径 | 状态 | 说明 |
|---|---|---|---|
| `GET` | `/batch/history` | ✅ 已有, **改动**: history.html 加新按钮/状态点 |
| `GET` | **`/batch/history/<batch_id>`** | ❌ **新增**: render `templates/batch/history_detail.html` |
| `GET` | `/api/batches` | ✅ 已有, 不改 (9 条记录不必加 disk_status) |
| `GET` | `/api/batches/<batch_id>` | ✅ 已有, **扩展**: 返回值加 disk_available 字段 |
| `GET` | `/api/batch/<id>/download?kind=html\|ai` | ✅ 已有 (A3 已修), 详情页按钮直调 |
| `GET` | `/api/batch/<id>/download-all` | ✅ 已有, 列表页 + 详情页按钮直调 |

---

## API 改动清单

### 1. `GET /api/batches/<batch_id>` 返回值扩展

现有返回 (从 `Batch.to_dict(with_items=True)`):
```json
{
  "id": 7, "batch_id": "batch_20260422_004_cb84",
  "name": "测试 (第4次)", "status": "completed",
  "total_count": 3, "valid_count": 3, "skipped_count": 0,
  "created_at": "2026-04-22T08:23:35",
  "items": [
    {"id": 22, "name": "DZ70X新品1", "status": "done",
     "ai_refine_status": "done",
     "result": {"preview_png": "/uploads/.../preview.png",
                "ai_refined_path": "/uploads/.../ai_refined.jpg", ...},
     ...}
  ]
}
```

**新增** (不动原字段, 只追加):
```json
{
  ...  // 原字段不变
  "disk_available": "full",  // "full" | "partial" | "missing"
  "items": [
    {
      ...
      "preview_png_exists": true,     // 磁盘上 preview.png 存在吗
      "ai_refined_exists": true,      // 磁盘上 ai_refined.jpg 存在吗
    }
  ]
}
```

**实现** (app.py 的 detail 端点 L1326-ish):
```python
@app.route("/api/batches/<batch_id>", methods=["GET"])
@login_required
def batch_detail(batch_id):
    b = _check_batch_owner(batch_id)
    data = b.to_dict(with_items=True)
    # 对每个 item, 检查磁盘文件存在
    product_dir_cache = {}  # 可选: 同批次同 item.id 不重复调 _resolve
    full = missing = 0
    for it_data in data["items"]:
        it_obj = next((x for x in b.items if x.id == it_data["id"]), None)
        if it_obj is None:
            it_data["preview_png_exists"] = False
            it_data["ai_refined_exists"] = False
            missing += 2; continue
        product_dir = _resolve_product_dir_from_result(it_obj, batch_id)
        png_ok = (product_dir / "preview.png").is_file()
        ai_ok  = (product_dir / "ai_refined.jpg").is_file()
        it_data["preview_png_exists"] = png_ok
        it_data["ai_refined_exists"]  = ai_ok
        if png_ok: full += 1
        else: missing += 1
        if ai_ok: full += 1
        else: missing += 1
    if missing == 0:
        data["disk_available"] = "full"
    elif full == 0:
        data["disk_available"] = "missing"
    else:
        data["disk_available"] = "partial"
    return jsonify(data)
```

**性能**: 每 item 2 次 `.is_file()` stat. 一批次最多 50 产品 → 100 stat, < 50ms. 可接受, 不需要批量 stat.

**pathlib**: 全链路用 `Path` + `.is_file()`, Windows/Linux 都 work.

### 2. `GET /api/batches` 列表值 — **不改**

9 条记录不做 disk_status 聚合 (每条要查 N 次 stat, 总 ~50 次). 列表页 UI 需要 tri-state 小圆点时, 前端在列表渲染后**按需异步**调 `/api/batches/<id>` 补充 (每行点开时才拉, 避免一次性 50 倍 I/O).

**但**: 如果用户显式要求**首屏就显示状态圆点**, 那就接受一次性聚合 (9 条批次 × ~3 件 stat = 30 stat, 仍 < 100ms, 能接受).

---

## 数据流 (谁调谁)

```
浏览器 "/batch/history"
    ↓ (GET /batch/history)
app.py batch_history_page()  ← 现有
    ↓ (render history.html with batches)
前端加载 → 遍历 batches 异步拉 /api/batches/<id> 补磁盘状态 (tri-state)
    ↓ (点击"查看详情")
浏览器 "/batch/history/<batch_id>"
    ↓ (GET /batch/history/<batch_id>)  ← 新路由
app.py batch_history_detail_page(batch_id)  ← 新函数
    ↓ _check_batch_owner → render history_detail.html with batch + items
前端加载 → JS 拉 /api/batches/<batch_id> 获取含 disk_available 字段的详情
    ↓
每个 item card 渲染 (HTML/AI 缩略 + 下载按钮 + 丢失态)
    ↓ (点缩略图)
openLightbox(full_url) → 任务1 lightbox 弹窗
    ↓ (点 ↓HTML版)
a href=/api/batch/<id>/download?name=X&kind=html → A3 修复的端点
    ↓
Content-Disposition 强制下载 + UTF-8 中文文件名
```

---

## 前端组件复用清单

| 组件 | 来源 | 用在哪 |
|---|---|---|
| `.stage-pill` (6 variant) | 任务2 design-tokens + design-system.css | item 状态徽章 |
| `#lightboxDlg` / `openLightbox()` | 任务1 v3 + upload.html | 点缩略图放大预览 |
| `showToast()` | 任务2 upload.html | 下载失败/文件丢失通知 (可选) |
| CSS tokens | design-system.css | 所有颜色 / 字体 / 间距 / 阴影 / 圆角 |
| topbar | history.html 已有 | 复用一字不改 |

**不新建**:
- 不自造按钮样式 → 用 `.btn-primary` / `.btn-ghost`
- 不自造颜色 → 用 `--color-success` / `--color-error` / `--color-warning`
- 不自造缩略图样式 → 用 `.preview-thumb` / `.ai-thumb` (upload.html 已有)

---

## 验收标准

### 功能测试 (10 项, 必全过)

1. 点击 topbar "历史批次" / "历史记录" → 看到列表 ✅
2. 每行磁盘状态**小圆点**: 🟢 全在 / 🟡 部分 / 🔴 全丢 ✅
3. 每行有 **查看详情** 按钮, 点进入 `/batch/history/<batch_id>` ✅
4. 详情页每个产品 card 显示: 主图缩略 + HTML/AI 缩略 + HTML↓/AI↓ 按钮 ✅
5. 点 HTML/AI 缩略图 → lightbox 放大 (复用任务1 `#lightboxDlg`) ✅
6. 点 "↓HTML版" → 下载中文文件名 `产品名_HTML版.png` (A3 已修) ✅
7. 点 "↓AI版" → 下载中文文件名 `产品名_AI精修版.jpg` ✅
8. 点 "批量zip下载" → zip 文件名 `<批次名>_<batch_id>.zip` ✅
9. 磁盘丢失的批次 (如 `batch_20260421_001_6238`) 进详情页 → 每个 card 显示 ⚠️ "文件已丢失" + 下载按钮置灰 + 页面不崩 ✅
10. 移动端 (<768px) 响应式: card 竖排堆叠, 按钮仍可点 ✅

### Playwright 证据脚本 (`scripts/verify_history_detail.py`)

5 viewport × 多断言, 复用任务1/任务2 框架。生产 `docker exec python3 ...` 跑:

- **viewport 1920/1600/1440/1366/375**
- 对每个 viewport mock 以下 3 种状态并截图 + computed-style 断言:
  1. **全磁盘 OK** 批次: 有 2 个下载按钮 (HTML/AI), lightbox 缩略 src 正确
  2. **部分丢失** 批次: 1 个按钮 disabled, 1 个可点
  3. **全丢失** 批次: 两个按钮 disabled + `.thumb-missing` 文案可见

- **CSS 断言**:
  - `.btn-disabled` 的 `cursor` = `not-allowed`
  - `.thumb-missing` 的 `color` 等于 `--color-text-muted` 或 `--color-warning`
  - `.disk-dot.disk-full` bg 等于 `--color-success` (#00d722)
  - `.disk-dot.disk-partial` bg 等于 `--color-warning` (#ffae13)
  - `.disk-dot.disk-missing` bg 等于 `--color-error` (#ee1d36)

- **功能断言** (可选, 复杂度高则只做可视):
  - test_client 拉 `/api/batches/<id>` 验证 response 含 `disk_available` + `preview_png_exists` + `ai_refined_exists` 字段
  - test_client 拉 `/batch/history/<bid>` 验证 HTML 包含产品名 + 2 个缩略图 `<img>`

### 回归测试 (不能破坏的老功能)

- `/batch/history` 列表页老表格结构不变, 50 条硬限保留
- 批次名点击仍跳 `/batch/upload#batch=xxx` (恢复 session)
- `/api/batches/<id>` 响应**老字段**一字不动 (只追加新字段)
- 所有 A1/A2/A3 修复 (scene match / ai_compose / download) 不受影响

---

## 时间估算

| 阶段 | 内容 | 耗时 |
|---|---|---|
| Phase 2a | 后端: `/batch/history/<batch_id>` 路由 + `/api/batches/<id>` 扩展 (disk_available / exists 字段) | **30 min** |
| Phase 2b | 新模板 `templates/batch/history_detail.html` (复用 topbar + tokens) | **60 min** |
| Phase 2c | `history.html` 加磁盘状态点 + 详情按钮 + 批量 zip 按钮 | **30 min** |
| Phase 2d | CSS: `.disk-dot` 三态 + `.thumb-missing` + `.btn-disabled` | **20 min** |
| Phase 3 | 本地 smoke + 手动点一遍 | **15 min** |
| Phase 4 | Playwright `scripts/verify_history_detail.py` 5 屏 + deploy | **30 min** |
| Phase 5 | 交付清单 + 你浏览器验收 | **10 min** |
| **合计** | | **~3 h** |

---

## 风险点

### R1 · `is_file()` stat 在列表页聚合慢 (低风险)
- 9 条批次现在不是问题, 若未来到 50+ 条可能 UI 卡顿
- **缓解**: 列表页**不聚合**, 详情页才查 (当前方案已选)
- **未来**: 前端懒加载圆点 (滚动到可见再拉)

### R2 · 详情页新路由 owner 校验泄露 (中风险)
- `/batch/history/<batch_id>` 必须套 `_check_batch_owner` (同 `/api/batches/<id>`)
- 忘了 → 任意用户可见任意批次详情
- **缓解**: 实现时复用 `_check_batch_owner` + code review 明确

### R3 · 新模板 CSS 和老页面冲突 (低风险)
- `history_detail.html` 是独立文件不 extends, 用 `<style>` 局部样式
- 若 `class` 名和 `history.html` 重复但意义不同 → 不同页面独立不影响
- **缓解**: 新 class 加前缀 `.hd-` 或引用 design-system.css 的公共 tokens

### R4 · `_resolve_product_dir_from_result` 在 ai_refined_path 缺失时走硬拼 (中风险)
- 对 2026-04-21 磁盘丢失的批次, `item.result` 可能空或不含 ai_refined_path
- `_resolve_product_dir_from_result` 落到硬拼 `UPLOAD_DIR/batches/<bid>/<name>/` (不含"测试/" 子目录)
- 硬拼路径下 stat preview.png / ai_refined.jpg → `.is_file()` = False → `exists=False` → 前端正确显示"文件已丢失"
- 行为正确 ✅, 不是 bug

### R5 · Batch/Item `to_dict` 修改影响下游 (中风险)
- 我打算**只在 `batch_detail` 路由里**扩展 dict, 不动 `to_dict()` 本身 —— 避免污染其他调用方 (workspace / upload.html WS event 等)
- **缓解**: 扩展放在路由函数里后再 `jsonify`, 不改 model 的 to_dict

---

## 执行清单 (Phase 2 开工后逐项勾)

- [ ] Phase 2a-1: 加路由 `/batch/history/<batch_id>` → render `history_detail.html`
- [ ] Phase 2a-2: `/api/batches/<id>` 加 `disk_available` + per-item `preview_png_exists` / `ai_refined_exists`
- [ ] Phase 2b-1: 创建 `templates/batch/history_detail.html`
- [ ] Phase 2b-2: 顶部 header (名称 / 日期 / 状态 / 返回 / 批量zip)
- [ ] Phase 2b-3: 产品 card 列表 (主图 / stage-pill / HTML 缩略 / AI 缩略 / 2 下载按钮)
- [ ] Phase 2b-4: lightbox 接入 (复用任务1 `#lightboxDlg`)
- [ ] Phase 2b-5: 磁盘丢失态 (`.thumb-missing` + `.btn-disabled`)
- [ ] Phase 2b-6: @media 768px 移动端响应
- [ ] Phase 2c-1: `history.html` 加 `.disk-dot` 三态
- [ ] Phase 2c-2: 加 "查看详情" 按钮列
- [ ] Phase 2c-3: 加 "批量zip" 快捷按钮 (可选)
- [ ] Phase 3: 本地 smoke (app boot + 点一遍)
- [ ] Phase 4: `scripts/verify_history_detail.py` Playwright 5屏
- [ ] deploy + 生产证据
- [ ] 你浏览器验收 10 项

---

## 与 /simplify 清理后基础对齐

- 复用 `_resolve_product_dir_from_result` (app.py, A3 helper) 查磁盘存在
- 复用 `_match_scene_smart` / `_load_scene_manifest` (A1 lru_cache 后的版本, 无相关调用)
- CSS 全走 design-system.css 的 tokens (任务2 已扩展)
- Lightbox 依赖任务1 的 `#lightboxDlg` + `openLightbox` (已在 `upload.html` 定义, 需要在 `history_detail.html` 同样注入)

---

**签收**: 此文档即方向 B 技术契约, 用户 review 后按"执行清单"逐项推进. 任何偏离需回文档解释。
