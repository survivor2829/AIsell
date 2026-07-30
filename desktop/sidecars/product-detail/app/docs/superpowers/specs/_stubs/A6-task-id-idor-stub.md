# [STUB] §A.6 v2 精修 task_id IDOR — 越权访问其他用户精修任务

> ⚠️ 草稿状态: 由 P2 audit 自动生成
> 来源: § Top 10 #5 / §A.6
> 严重度: 中
> 估时: 1h

## 问题简述

`app.py:4543-4551` (`/api/ai-refine-v2/status/<task_id>`) 与 `app.py:5115-5121` (`/api/single/<task_id>/status`) 仅 `@login_required`, 不校验 task_id ownership。task_id (时间戳 + hex) 可预测程度中等, 任何已登录用户可枚举读取其他用户精修进度 + 结果 (含产品文案/生成图片 URL)。

## 根因诊断

设计 `pipeline_runner.start_task` 时未把 user_id 写入 task state dict。检查只有"是否存在", 没有"是否属于我"。

## 修复方案

### 方案 A — task state 加 user_id (推荐)
```python
# ai_refine_v2/pipeline_runner.py
def start_task(...):
    task_state = {
        ...
        "user_id": current_user.id,  # 新增
    }

# app.py 路由
@app.route("/api/ai-refine-v2/status/<task_id>")
@login_required
def refine_v2_status(task_id):
    state = pipeline_runner.get_task_status(task_id)
    if not state:
        abort(404)
    if state.get("user_id") != current_user.id and not current_user.is_admin:
        abort(403)
    return jsonify(state)
```
- 优势: 一次修两个端点
- 劣势: pipeline_runner 入参增加, 测试更新
- 估时: 1h

### 方案 B — task_id 改用 UUID4 (额外保护)
- task_id 不可预测后, 即便缺 owner check 也难枚举
- 但 ⚠️ 不该靠 obscurity 防 IDOR, 仅做加固
- 估时: 0.5h
- 建议**与方案 A 同时做**

## 兜底/回滚

`git revert` + `pipeline_runner.start_task` 入参回退兼容。

## 测试

新增 `tests/test_task_id_ownership.py`:
```python
def test_user_a_cannot_query_user_b_task():
    user_a 创建任务 → 拿 task_id
    user_b 登录 → GET /api/ai-refine-v2/status/<task_id>
    expect 403
```

## 转正式 spec checklist

- [ ] Scott 决策 "修"
- [ ] 选方案 (推荐 A + B)
- [ ] 加 owner test
- [ ] 进入 P4

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
