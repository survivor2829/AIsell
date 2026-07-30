# 单屏重生成（reroll）· 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 v3.2.2 已完成精修的 batch item 加"重生第 N 屏"逃逸阀——前端分屏视图 + 单屏 🔄 按钮 + ¥0.70 确认弹窗，后端复用 `_generate_one_block_v2` 重生单屏 + 重拼长图，零回归到 236 测基线。

**Architecture:** 后端纯函数 `regenerate_screen(task_dir, block_index, ...)` 分离业务/IO，端点薄壳做权限+锁；前端在 `history_detail.html` 加分屏 toggle + WS 监听 `screen_regenerated` 事件刷图。

**Tech Stack:** Python 3.x · Pillow · Flask · pytest unittest · 不引新依赖

**前置 Spec:** `docs/superpowers/specs/2026-04-30-regenerate-screen-design.md`

**前置代码引用（必读）：**
- `ai_refine_v2/refine_generator.py:675` - `_generate_one_block_v2` 函数签名
- `ai_refine_v2/color_extractor.py` - `extract_color_anchor` API
- `ai_refine_v2/pipeline_runner.py:36-39` - `_OUTPUT_BASE` 路径
- `app.py:1614` - `/ai-refine-start` 端点（owner 校验/锁/WS 模式参考）
- `batch_pubsub.py:33` - `publish(batch_id, event)` API
- `models.py:105` - `BatchItem` 字段
- `pricing_config.py` - `SEEDREAM_UNIT_PRICE_YUAN` 常量风格

---

## File Structure

| 路径 | 行为 | 责任 |
|------|------|------|
| `ai_refine_v2/regen_single.py` | **创建** (~120 行) | 单屏重生成纯函数 + 拼接 helper；无 Flask 依赖 |
| `ai_refine_v2/tests/test_regen_single.py` | **创建** (~150 行) | 11 测：成功/越界/缺文件/cutout 缺/拼接/锚定 |
| `app.py` | **修改** (+~80 行) | `/api/batch/<bid>/items/<pk>/regenerate-screen` 端点 + 锁 + WS publish |
| `tests/test_regen_endpoint.py` | **创建** (~200 行) | 11 测覆盖 4xx/200/WS |
| `pricing_config.py` | **修改** (+~5 行) | 加 `REGEN_SCREEN_UNIT_PRICE_YUAN` 常量 |
| `templates/batch/history_detail.html` | **修改** (+~150 行) | split-view toggle + 12 屏 grid + 确认 modal + WS 刷图 |

---

## 执行顺序与依赖

```
Task 1 (骨架 + dataclass + 第一个失败测)
  ↓
Task 2 (regenerate_screen 实现，mock API)
  ↓
Task 3 (assemble_long_image helper 抽出)
  ↓
Task 4 (pricing_config 加常量)
  ↓
Task 5 (端点 4xx 验权/边界)
  ↓
Task 6 (端点 200 + 锁 + WS publish)
  ↓
Task 7 (history_detail.html split toggle UI)
  ↓
Task 8 (12 屏 grid + reroll 按钮 + 确认 modal)
  ↓
Task 9 (WS 客户端监听 + 图刷新 + cache-bust)
  ↓
Task 10 (回归全测 + 真测 1 次 + 文档)
```

每个 Task 后 commit，commit message 用 PRD §9.8 模板（feat(regen-v1): / chore(regen-v1): 等）。

---

## Task 1: regen_single.py 骨架 + 第一个失败测

**Files:**
- Create: `ai_refine_v2/regen_single.py`
- Create: `ai_refine_v2/tests/test_regen_single.py`

- [ ] **Step 1：写第一个失败测（API 形状）**

新建 `ai_refine_v2/tests/test_regen_single.py`：

```python
"""regen_single 单测.

所有 fixture 用 PIL 程序生成 + tempdir, 绝不依赖任何真实产品图.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from PIL import Image

from ai_refine_v2.regen_single import RegenResult, regenerate_screen


def _make_task_dir(tmp: Path, n_blocks: int = 12) -> Path:
    """造一个假的 v2 task_dir, 含 _planning.json + n 张 block_*.jpg + assembled.png."""
    task_dir = tmp / "v2_test_abc123"
    task_dir.mkdir()
    planning = {
        "version": "v2",
        "blocks": [
            {"block_id": f"b{i}", "visual_type": "screen",
             "prompt": f"测试 prompt {i} " * 30}
            for i in range(n_blocks)
        ],
    }
    (task_dir / "_planning.json").write_text(
        json.dumps(planning, ensure_ascii=False), encoding="utf-8"
    )
    for i in range(n_blocks):
        Image.new("RGB", (300, 400), (i * 20, 100, 200)).save(
            task_dir / f"block_{i}.jpg", quality=85
        )
    Image.new("RGB", (300, 4800), (50, 50, 50)).save(task_dir / "assembled.png")
    return task_dir


class TestRegenResultDataclass(unittest.TestCase):
    """验返回 dataclass schema 跟 spec §3.3 D4 一致."""

    def test_regen_result_fields(self):
        r = RegenResult(
            new_block_path=Path("/tmp/x.jpg"),
            new_assembled_path=Path("/tmp/y.png"),
            cost_rmb=0.7,
        )
        self.assertEqual(r.cost_rmb, 0.7)
        self.assertTrue(str(r.new_block_path).endswith(".jpg"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2：跑测看它失败**

```bash
python -m pytest ai_refine_v2/tests/test_regen_single.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'ai_refine_v2.regen_single'`.

- [ ] **Step 3：建模块骨架让 import 通过**

新建 `ai_refine_v2/regen_single.py`：

```python
"""单屏重生成模块 (v3.3 reroll).

职责: 已完成的 v2 task 内, 重新生成第 N 屏, 重拼长图.
纯函数, 无 Flask / DB 依赖. 调用方 (app.py 端点) 负责权限/锁/WS.

Spec: docs/superpowers/specs/2026-04-30-regenerate-screen-design.md
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class RegenResult:
    """单屏重生成结果. spec §3.3 D4."""

    new_block_path: Path
    new_assembled_path: Path
    cost_rmb: float


def regenerate_screen(
    task_dir: Path,
    block_index: int,
    cutout_path: Optional[Path],
    deepseek_key: str,
    gpt_image_key: str,
) -> RegenResult:
    """重生第 block_index 屏, 重拼长图.

    raises:
        FileNotFoundError: task_dir / _planning.json / block_<idx>.jpg 缺
        IndexError: block_index 越界
        RuntimeError: gpt-image-2 调用失败 (透传 _generate_one_block_v2 错)
    """
    raise NotImplementedError("Task 2 实现")
```

- [ ] **Step 4：跑测确认 dataclass 测过**

```bash
python -m pytest ai_refine_v2/tests/test_regen_single.py::TestRegenResultDataclass -v
```
Expected: PASS (1 测)

- [ ] **Step 5：commit**

```bash
git add ai_refine_v2/regen_single.py ai_refine_v2/tests/test_regen_single.py
git commit -m "$(cat <<'EOF'
feat(regen-v1): task1 — RegenResult dataclass + 模块骨架 (1 测绿)

【主要改动】
- 新建 ai_refine_v2/regen_single.py: RegenResult frozen dataclass +
  regenerate_screen 函数签名 (raise NotImplementedError, 留待 task2)
- 新建 ai_refine_v2/tests/test_regen_single.py: TestRegenResultDataclass

【验收】
- python -m pytest ai_refine_v2/tests/test_regen_single.py
  → 1 passed (dataclass 测)

【遗留】
- regenerate_screen 真实实现 (Task 2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: regenerate_screen 实现 + mock API 测

**Files:**
- Modify: `ai_refine_v2/regen_single.py`
- Modify: `ai_refine_v2/tests/test_regen_single.py`

- [ ] **Step 1：加失败测——成功路径**

在 `test_regen_single.py` 加：

```python
class TestRegenerateScreenSuccess(unittest.TestCase):
    """成功重生第 N 屏 (mock _generate_one_block_v2)."""

    def test_regenerate_block_4_replaces_jpg(self):
        with TemporaryDirectory() as tmp:
            task_dir = _make_task_dir(Path(tmp), n_blocks=12)
            old_block_4 = (task_dir / "block_4.jpg").read_bytes()

            new_jpg_bytes = Image.new("RGB", (300, 400), (255, 0, 0))
            buf = task_dir / "_mock_new.jpg"
            new_jpg_bytes.save(buf, quality=85)
            new_bytes_payload = buf.read_bytes()

            from ai_refine_v2.refine_generator import BlockResult
            mock_block_result = BlockResult(
                block_id="b4", visual_type="screen",
                prompt="测试 prompt 4", image_url=str(task_dir / "block_4.jpg"),
                placeholder=False,
            )

            with mock.patch(
                "ai_refine_v2.regen_single._generate_one_block_v2",
                return_value=(mock_block_result, 0.7),
            ) as mocked:
                from ai_refine_v2.regen_single import regenerate_screen
                # 也 mock 写文件 (mock 的 _generate_one_block_v2 拿到 image_url 但
                # 不真下载, 在测里我们把 new_bytes_payload 直接写到 block_4.jpg)
                with mock.patch(
                    "ai_refine_v2.regen_single._download_block_to_disk",
                    side_effect=lambda url, dst: dst.write_bytes(new_bytes_payload),
                ):
                    result = regenerate_screen(
                        task_dir=task_dir,
                        block_index=4,
                        cutout_path=None,
                        deepseek_key="fake",
                        gpt_image_key="fake",
                    )

            self.assertEqual(mocked.call_count, 1)
            self.assertEqual(result.cost_rmb, 0.7)
            new_block_4 = (task_dir / "block_4.jpg").read_bytes()
            self.assertNotEqual(old_block_4, new_block_4)
            self.assertEqual(result.new_block_path, task_dir / "block_4.jpg")
            self.assertTrue(result.new_assembled_path.exists())
```

- [ ] **Step 2：跑测看失败**

```bash
python -m pytest ai_refine_v2/tests/test_regen_single.py::TestRegenerateScreenSuccess -v
```
Expected: FAIL（NotImplementedError 或缺 `_download_block_to_disk`）

- [ ] **Step 3：实现 regenerate_screen**

替换 `ai_refine_v2/regen_single.py` 整文件：

```python
"""单屏重生成模块 (v3.3 reroll). Spec: 2026-04-30-regenerate-screen-design.md"""
from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PIL import Image

from ai_refine_v2.color_extractor import extract_color_anchor
from ai_refine_v2.refine_generator import (
    _generate_one_block_v2,
    _http_post_apimart,
    _to_data_url,
)


@dataclass(frozen=True)
class RegenResult:
    new_block_path: Path
    new_assembled_path: Path
    cost_rmb: float


def _download_block_to_disk(url: str, dst: Path) -> None:
    """下载 image_url (可能是 http(s)/data:/local path) 到 dst."""
    if url.startswith(("http://", "https://")):
        with urllib.request.urlopen(url, timeout=30) as r:
            dst.write_bytes(r.read())
    elif url.startswith("data:"):
        # data:image/jpeg;base64,xxx  ← _to_data_url 反向
        import base64
        _, b64 = url.split(",", 1)
        dst.write_bytes(base64.b64decode(b64))
    else:
        # 视为本地路径
        dst.write_bytes(Path(url).read_bytes())


def _assemble_long_image(task_dir: Path) -> Path:
    """把 task_dir 下所有 block_*.jpg 按 index 顺序竖向拼成 assembled.png.

    **DRY 原则**: 复用 pipeline_runner._run_assembler_v2 + _validate_assembled_png,
    避免拼接逻辑漂移 (paste 左对齐 / 体积守门 / 100KB 防纯白等). pipeline 内部用
    `canvas.paste(im, (0, y))` 左对齐, 不是居中 — 必须保持一致, 否则 rerolled
    assembled.png 排版会跟原始 assembled.png 不同, 用户视觉混乱.

    实现细节: _run_assembler_v2 期望 blocks 是 **runtime state** (含 file/success
    字段), 不是 _planning.json 的 raw planning. 所以扫盘上的 block_*.jpg, 构造
    synthetic block dicts 喂给它. 这等价于 "所有 on-disk 的 block 都进拼接", 比
    依赖 _planning.json/_summary.json 鲁棒.
    """
    from ai_refine_v2.pipeline_runner import _run_assembler_v2, _validate_assembled_png

    block_files = sorted(
        task_dir.glob("block_*.jpg"),
        key=lambda p: int(p.stem.split("_")[1]),
    )
    if not block_files:
        raise FileNotFoundError(f"无 block_*.jpg in {task_dir}")
    synthetic_blocks = [
        {"file": p.name, "success": True} for p in block_files
    ]
    _run_assembler_v2(task_dir, synthetic_blocks)  # 内部覆盖 task_dir/assembled.png
    out = task_dir / "assembled.png"
    _validate_assembled_png(out)  # < 100KB raise (防纯白)
    return out


def regenerate_screen(
    task_dir: Path,
    block_index: int,
    cutout_path: Optional[Path],
    deepseek_key: str,
    gpt_image_key: str,
) -> RegenResult:
    if not task_dir.is_dir():
        raise FileNotFoundError(f"task_dir 不存在: {task_dir}")
    planning_path = task_dir / "_planning.json"
    if not planning_path.is_file():
        raise FileNotFoundError(f"_planning.json 不在: {planning_path}")
    planning = json.loads(planning_path.read_text(encoding="utf-8"))
    blocks = planning.get("blocks") or []
    if not (0 <= block_index < len(blocks)):
        raise IndexError(
            f"block_index={block_index} 越界 (0..{len(blocks) - 1})"
        )
    block = blocks[block_index]

    color_anchor = None
    image_data_url = None
    if cutout_path and cutout_path.is_file():
        try:
            color_anchor = extract_color_anchor(cutout_path)
        except Exception:
            color_anchor = None
        try:
            image_data_url = _to_data_url(str(cutout_path))
        except Exception:
            image_data_url = None

    block_result, cost = _generate_one_block_v2(
        block=block,
        image_data_url=image_data_url,
        api_key=gpt_image_key,
        api_call_fn=_http_post_apimart,
        max_retries=2,
        thinking="medium",
        size="3:4",
        color_anchor=color_anchor,
    )
    if block_result.image_url is None:
        raise RuntimeError(
            f"_generate_one_block_v2 失败: {block_result.error or 'unknown'}"
        )

    block_jpg = task_dir / f"block_{block_index}.jpg"
    _download_block_to_disk(block_result.image_url, block_jpg)
    new_assembled = _assemble_long_image(task_dir)
    return RegenResult(
        new_block_path=block_jpg,
        new_assembled_path=new_assembled,
        cost_rmb=cost,
    )
```

- [ ] **Step 4：跑测确认成功路径过**

```bash
python -m pytest ai_refine_v2/tests/test_regen_single.py -v
```
Expected: 2 passed

- [ ] **Step 5：commit**

```bash
git add ai_refine_v2/regen_single.py ai_refine_v2/tests/test_regen_single.py
git commit -m "feat(regen-v1): task2 — regenerate_screen 实现 + mock 成功测 (2 测绿)

【主要改动】
- regen_single.py: regenerate_screen 完整实现, 调 _generate_one_block_v2
- _download_block_to_disk: 支持 http(s)/data:/local path 三种 URL
- _assemble_long_image: 复用 pipeline_runner._run_assembler_v2 (左对齐, 与原始 batch 一致)
  + _validate_assembled_png (< 100KB raise) — 避免重复实现造成拼接漂移
- color_anchor / image_data_url 从 cutout_path 派生, 缺则传 None

【验收】
- 2 passed (dataclass + 成功路径 mock)

【遗留】
- 边界测 (Task 3): 越界/缺文件/拼接

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 边界测 + 拼接独立测

**Files:**
- Modify: `ai_refine_v2/tests/test_regen_single.py`

- [ ] **Step 1：加 6 个边界测**

```python
class TestRegenerateScreenEdgeCases(unittest.TestCase):
    def test_task_dir_not_exist(self):
        with self.assertRaises(FileNotFoundError):
            regenerate_screen(
                task_dir=Path("/nonexistent/xxxx"),
                block_index=0, cutout_path=None,
                deepseek_key="x", gpt_image_key="x",
            )

    def test_planning_json_missing(self):
        with TemporaryDirectory() as tmp:
            task_dir = Path(tmp) / "v2_x"
            task_dir.mkdir()
            with self.assertRaises(FileNotFoundError):
                regenerate_screen(task_dir, 0, None, "x", "x")

    def test_block_index_out_of_range_negative(self):
        with TemporaryDirectory() as tmp:
            task_dir = _make_task_dir(Path(tmp), n_blocks=12)
            with self.assertRaises(IndexError):
                regenerate_screen(task_dir, -1, None, "x", "x")

    def test_block_index_out_of_range_too_large(self):
        with TemporaryDirectory() as tmp:
            task_dir = _make_task_dir(Path(tmp), n_blocks=12)
            with self.assertRaises(IndexError):
                regenerate_screen(task_dir, 12, None, "x", "x")


class TestAssembleLongImage(unittest.TestCase):
    def test_assemble_no_blocks_raises(self):
        from ai_refine_v2.regen_single import _assemble_long_image
        with TemporaryDirectory() as tmp:
            empty_dir = Path(tmp) / "empty"
            empty_dir.mkdir()
            with self.assertRaises(FileNotFoundError):
                _assemble_long_image(empty_dir)

    def test_assemble_12_blocks_height_sum(self):
        from ai_refine_v2.regen_single import _assemble_long_image
        with TemporaryDirectory() as tmp:
            task_dir = _make_task_dir(Path(tmp), n_blocks=12)
            out = _assemble_long_image(task_dir)
            self.assertTrue(out.is_file())
            assembled = Image.open(out)
            self.assertEqual(assembled.height, 12 * 400)  # 12 屏 × 400 height
```

- [ ] **Step 2：跑测**

```bash
python -m pytest ai_refine_v2/tests/test_regen_single.py -v
```
Expected: 8 passed

- [ ] **Step 3：commit**

```bash
git add ai_refine_v2/tests/test_regen_single.py
git commit -m "test(regen-v1): task3 — 边界 + 拼接 6 测 (8 测绿)

【验收】
- 8 passed (含 task_dir 缺/planning 缺/index 越界 ±/拼接空目录/拼接 12 屏)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: pricing_config 加 reroll 单价常量

**Files:**
- Modify: `pricing_config.py`

- [ ] **Step 1：先看现有常量结构**

```bash
grep -n "UNIT_PRICE\|YUAN" pricing_config.py
```
Expected: 看到 `SEEDREAM_UNIT_PRICE_YUAN`（任务10 加的，给批次估算用）

- [ ] **Step 2：加 reroll 常量**

在 `pricing_config.py` 现有单价常量旁加：

```python
# v3.3 单屏 reroll 单价 (gpt-image-2 一次调用约 ¥0.7, 与批次 v2 path 同级 model).
# 改这个值的运维场景: APIMart 调价, 或换 model.
REGEN_SCREEN_UNIT_PRICE_YUAN = 0.70
```

- [ ] **Step 3：跑全测确认零回归**

```bash
python -m pytest -q 2>&1 | tail -3
```
Expected: 仍 236+ passed（新增常量不应影响）

- [ ] **Step 4：commit**

```bash
git add pricing_config.py
git commit -m "feat(regen-v1): task4 — pricing_config 加 REGEN_SCREEN_UNIT_PRICE_YUAN

【主要改动】
- 新增 REGEN_SCREEN_UNIT_PRICE_YUAN=0.70 给 reroll 端点 + 前端弹窗读

【验收】
- python -m pytest -q → 236+ passed (零回归)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 端点 4xx 验权 + 边界测

**Files:**
- Create: `tests/test_regen_endpoint.py`
- Modify: `app.py`

- [ ] **Step 1：先看测试目录是否在 testpaths 里**

```bash
cat pytest.ini | grep testpaths
```
Expected: `testpaths = ai_refine_v2/tests`

需要扩 testpaths 包含 `tests/` 或把测试放到 `ai_refine_v2/tests/test_regen_endpoint.py`。**选后者**：放到现有测试目录，文件名加 `endpoint` 后缀区分。

修改 path：`ai_refine_v2/tests/test_regen_endpoint.py`

- [ ] **Step 2：写 4xx 测**

```python
"""regenerate-screen 端点 单测 (v3.3 task5/6).

mock 掉 ai_refine_v2.regen_single.regenerate_screen, 只测 endpoint 自己的
权限/边界/锁/WS publish 行为. 真实重生成走 ai_refine_v2/tests/test_regen_single.py.
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from app import app, db
from models import User, Batch, BatchItem


def _make_authed_client(username="testuser"):
    client = app.test_client()
    with app.app_context():
        u = User.query.filter_by(username=username).first()
        if u is None:
            u = User(username=username, is_approved=True, is_paid=True)
            u.set_password("x")
            db.session.add(u)
            db.session.commit()
        uid = u.id
    with client.session_transaction() as sess:
        sess["_user_id"] = str(uid)
    return client, uid


class TestRegenEndpoint4xx(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_unauthed_redirects_login(self):
        client = app.test_client()
        r = client.post("/api/batch/x/items/1/regenerate-screen", json={})
        self.assertIn(r.status_code, (302, 401))

    def test_batch_not_exist_404(self):
        client, _ = _make_authed_client()
        r = client.post(
            "/api/batch/NOTEXIST/items/1/regenerate-screen",
            json={"block_index": 0},
        )
        self.assertEqual(r.status_code, 404)

    def test_batch_other_owner_403(self):
        client, my_uid = _make_authed_client("alice")
        with app.app_context():
            other = User(username="bob_other", is_approved=True)
            other.set_password("x")
            db.session.add(other)
            db.session.commit()
            b = Batch(batch_id="bob_batch", name="b", raw_name="b",
                      user_id=other.id, batch_dir="x")
            db.session.add(b)
            db.session.commit()
        r = client.post(
            "/api/batch/bob_batch/items/1/regenerate-screen",
            json={"block_index": 0},
        )
        self.assertEqual(r.status_code, 403)

    def test_item_not_done_409(self):
        client, uid = _make_authed_client("done_user")
        with app.app_context():
            b = Batch(batch_id="d_b", name="b", raw_name="b", user_id=uid,
                      batch_dir="x")
            db.session.add(b)
            db.session.commit()
            it = BatchItem(batch_pk=b.id, name="p", status="done",
                           ai_refine_status="processing",  # 不是 done
                           result=json.dumps({"task_id": "v2_test"}))
            db.session.add(it)
            db.session.commit()
            it_pk = it.id
        r = client.post(
            f"/api/batch/d_b/items/{it_pk}/regenerate-screen",
            json={"block_index": 0},
        )
        self.assertEqual(r.status_code, 409)

    def test_block_index_missing_400(self):
        client, uid = _make_authed_client("bi_user")
        with app.app_context():
            b = Batch(batch_id="bi_b", name="b", raw_name="b", user_id=uid,
                      batch_dir="x")
            db.session.add(b)
            db.session.commit()
            it = BatchItem(batch_pk=b.id, name="p", status="done",
                           ai_refine_status="done",
                           result=json.dumps({"task_id": "v2_test"}))
            db.session.add(it)
            db.session.commit()
            it_pk = it.id
        r = client.post(
            f"/api/batch/bi_b/items/{it_pk}/regenerate-screen",
            json={},
        )
        self.assertEqual(r.status_code, 400)
```

- [ ] **Step 3：跑测看 4xx 全失败（端点不存在）**

```bash
python -m pytest ai_refine_v2/tests/test_regen_endpoint.py -v
```
Expected: 全部 5 测 FAIL（404 端点不存在或 405）

- [ ] **Step 4：在 app.py 加端点骨架（仅 4xx 路径）**

在 app.py 紧跟 `/ai-refine-start` 端点（约 1614 行附近）后加：

```python
# ── v3.3 单屏 reroll 锁字典 (per-process, gthread worker 共享) ──
import threading as _threading_regen
_REGEN_LOCKS: dict[str, _threading_regen.Lock] = {}
_REGEN_LOCKS_GUARD = _threading_regen.Lock()

def _get_regen_lock(item_pk: int, block_index: int) -> _threading_regen.Lock:
    key = f"{item_pk}:{block_index}"
    with _REGEN_LOCKS_GUARD:
        lk = _REGEN_LOCKS.get(key)
        if lk is None:
            lk = _threading_regen.Lock()
            _REGEN_LOCKS[key] = lk
        return lk


@app.route(
    "/api/batch/<batch_id>/items/<int:item_pk>/regenerate-screen",
    methods=["POST"],
)
@login_required
def batch_item_regenerate_screen(batch_id, item_pk):
    """v3.3 单屏 reroll. spec: 2026-04-30-regenerate-screen-design.md"""
    batch = Batch.query.filter_by(batch_id=batch_id).first()
    if batch is None:
        return jsonify({"error": f"批次不存在: {batch_id}"}), 404
    # owner 校验严格度跟 /ai-refine-start 拉齐 (app.py:1631):
    # "user_id is None or != current_user.id" — 拒绝 NULL owner (legacy 数据安全).
    # 不能写成 "is not None and !=" — 那样 NULL owner 任何人都能 reroll → 跨用户扣费漏洞.
    if batch.user_id is None or batch.user_id != current_user.id:
        return jsonify({"error": "只有批次上传者可以重生"}), 403

    item = BatchItem.query.filter_by(id=item_pk, batch_pk=batch.id).first()
    if item is None:
        return jsonify({"error": f"产品不存在: {item_pk}"}), 404

    if item.ai_refine_status != "done":
        return jsonify({
            "error": "仅完成的产品可 reroll",
            "current_status": item.ai_refine_status,
        }), 409

    data = request.get_json(silent=True) or {}
    if "block_index" not in data:
        return jsonify({"error": "block_index 必填"}), 400
    try:
        block_index = int(data["block_index"])
    except (TypeError, ValueError):
        return jsonify({"error": "block_index 必须是整数"}), 400

    # Task 6 补: 锁 + 真实调用 + WS publish
    return jsonify({"todo": "task6"}), 501
```

- [ ] **Step 5：跑测确认 4xx 都过**

```bash
python -m pytest ai_refine_v2/tests/test_regen_endpoint.py::TestRegenEndpoint4xx -v
```
Expected: 5 passed

- [ ] **Step 6：commit**

```bash
git add app.py ai_refine_v2/tests/test_regen_endpoint.py
git commit -m "feat(regen-v1): task5 — 端点 4xx 骨架 + 5 测覆盖 (5 测绿)

【主要改动】
- app.py: /api/batch/<bid>/items/<pk>/regenerate-screen 端点骨架, 4xx 路径
  完整 (404/403/409/400), 200 路径暂返 501 占位
- _REGEN_LOCKS / _get_regen_lock helper (Task 6 用)

【验收】
- 5 passed: 未登录/批次不存在/不属于当前用户/item 未 done/block_index 缺

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 端点 200 + 锁 + WS publish

**Files:**
- Modify: `app.py`
- Modify: `ai_refine_v2/tests/test_regen_endpoint.py`

- [ ] **Step 1：写 200 测 + 锁测 + WS publish 测**

加到 test_regen_endpoint.py：

```python
class TestRegenEndpoint200(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_success_calls_regenerate_screen_and_publishes_ws(self):
        from pathlib import Path
        client, uid = _make_authed_client("ok_user")
        with app.app_context():
            b = Batch(batch_id="ok_b", name="b", raw_name="b", user_id=uid,
                      batch_dir="x")
            db.session.add(b)
            db.session.commit()
            it = BatchItem(batch_pk=b.id, name="p", status="done",
                           ai_refine_status="done",
                           result=json.dumps({
                               "task_id": "v2_test_xyz",
                               "ai_refined_path": "/uploads/x/p/ai_refined.jpg",
                           }))
            db.session.add(it)
            db.session.commit()
            it_pk = it.id

        from ai_refine_v2.regen_single import RegenResult
        fake_result = RegenResult(
            new_block_path=Path("/tmp/block_4.jpg"),
            new_assembled_path=Path("/tmp/assembled.png"),
            cost_rmb=0.7,
        )
        with mock.patch(
            "ai_refine_v2.regen_single.regenerate_screen",
            return_value=fake_result,
        ) as mocked, mock.patch(
            "batch_pubsub.publish",
            return_value=1,
        ) as ws_pub:
            r = client.post(
                f"/api/batch/ok_b/items/{it_pk}/regenerate-screen",
                json={"block_index": 4},
            )
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["block_index"], 4)
        self.assertEqual(body["cost_rmb"], 0.7)
        self.assertIn("new_assembled_url", body)
        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(ws_pub.call_count, 1)
        ev = ws_pub.call_args.args[1]
        self.assertEqual(ev["type"], "screen_regenerated")
        self.assertEqual(ev["block_index"], 4)


class TestRegenEndpointLock(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_locked_returns_423(self):
        from app import _get_regen_lock
        client, uid = _make_authed_client("lock_user")
        with app.app_context():
            b = Batch(batch_id="l_b", name="b", raw_name="b", user_id=uid,
                      batch_dir="x")
            db.session.add(b)
            db.session.commit()
            it = BatchItem(batch_pk=b.id, name="p", status="done",
                           ai_refine_status="done",
                           result=json.dumps({"task_id": "v2_t"}))
            db.session.add(it)
            db.session.commit()
            it_pk = it.id

        lk = _get_regen_lock(it_pk, 4)
        self.assertTrue(lk.acquire(blocking=False))
        try:
            r = client.post(
                f"/api/batch/l_b/items/{it_pk}/regenerate-screen",
                json={"block_index": 4},
            )
            self.assertEqual(r.status_code, 423)
        finally:
            lk.release()
```

- [ ] **Step 2：跑测看失败**

```bash
python -m pytest ai_refine_v2/tests/test_regen_endpoint.py -v
```
Expected: 2 测 FAIL (200 / 423 都返 501)

- [ ] **Step 3：把 app.py 端点 200 路径补完整**

把 Task 5 留下的 `return jsonify({"todo": "task6"}), 501` 替换为：

```python
    # Task 6: 锁 + 真实调用 + WS publish
    lock = _get_regen_lock(item_pk, block_index)
    if not lock.acquire(blocking=False):
        return jsonify({
            "error": "另一个 reroll 进行中, 请稍候",
        }), 423

    try:
        # 解析 result JSON 拿 task_id
        try:
            result_dict = json.loads(item.result or "{}")
        except json.JSONDecodeError:
            return jsonify({"error": "item.result 不是合法 JSON"}), 500
        task_id = (result_dict.get("task_id") or "").strip()
        if not task_id:
            return jsonify({
                "error": "item 缺 task_id, 无法 reroll. 重启精修.",
            }), 410

        task_dir = BASE_DIR / "static" / "ai_refine_v2" / task_id
        if not task_dir.is_dir():
            return jsonify({
                "error": "原始任务产物已清理, 无法 reroll. 重启精修.",
            }), 410

        # cutout: 从 main_image_path / parsed_json_path 推算 product_dir
        cutout_path = None
        try:
            main_url = (item.main_image_path or "").lstrip("/")
            if main_url.startswith("uploads/"):
                main_url = "static/" + main_url
            elif not main_url.startswith("static/"):
                main_url = ""
            if main_url:
                product_dir = (BASE_DIR / main_url).parent
                cand = product_dir / "product_cut.png"
                if cand.is_file():
                    cutout_path = cand
        except Exception:
            cutout_path = None

        deepseek_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
        gpt_image_key = os.environ.get("GPT_IMAGE_API_KEY", "").strip()
        if not (deepseek_key and gpt_image_key):
            return jsonify({
                "error": "服务端 v2 key 未配齐",
            }), 503

        from ai_refine_v2.regen_single import regenerate_screen
        try:
            regen = regenerate_screen(
                task_dir=task_dir,
                block_index=block_index,
                cutout_path=cutout_path,
                deepseek_key=deepseek_key,
                gpt_image_key=gpt_image_key,
            )
        except IndexError as e:
            return jsonify({"error": str(e)}), 400
        except FileNotFoundError as e:
            return jsonify({"error": str(e)}), 410
        except Exception as e:
            return jsonify({
                "error": f"重生成失败: {type(e).__name__}: {e}",
            }), 500

        # 把 regen.new_assembled_path (PNG) 转 JPG 覆盖到产品目录的 ai_refined.jpg
        # 找 product_dir 同上
        ai_refined_url = (result_dict.get("ai_refined_path") or "").strip()
        new_assembled_url = ai_refined_url  # default fallback
        if ai_refined_url:
            try:
                rel = ai_refined_url.lstrip("/")
                if rel.startswith("uploads/"):
                    rel = "static/" + rel
                ai_refined_fs = BASE_DIR / rel
                if ai_refined_fs.parent.is_dir():
                    from PIL import Image as _PIL_Image
                    img = _PIL_Image.open(regen.new_assembled_path).convert("RGB")
                    img.save(ai_refined_fs, format="JPEG", quality=90, optimize=True)
                    cache_bust = int(time.time())
                    new_assembled_url = f"{ai_refined_url}?v={cache_bust}"
            except Exception as _conv_e:
                print(f"[regen] 转 JPG 失败 (保留旧 assembled): {_conv_e}", flush=True)

        # WS publish (cache-bust query)
        cache_bust = int(time.time())
        new_block_url = (
            f"/static/ai_refine_v2/{task_id}/block_{block_index}.jpg?v={cache_bust}"
        )
        batch_pubsub_mod.publish(batch_id, {
            "type": "screen_regenerated",
            "batch_id": batch_id,
            "item_pk": item_pk,
            "block_index": block_index,
            "new_block_url": new_block_url,
            "new_assembled_url": new_assembled_url,
            "cost_rmb": regen.cost_rmb,
            "ts": cache_bust,
        })

        return jsonify({
            "ok": True,
            "block_index": block_index,
            "new_block_url": new_block_url,
            "new_assembled_url": new_assembled_url,
            "cost_rmb": regen.cost_rmb,
        }), 200
    finally:
        lock.release()
```

- [ ] **Step 4：跑全测**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 250+ passed (236 baseline + 8 regen_single + 7 regen_endpoint)

- [ ] **Step 5：commit**

```bash
git add app.py ai_refine_v2/tests/test_regen_endpoint.py
git commit -m "feat(regen-v1): task6 — 端点 200 + 锁 + WS publish (250+ 测绿)

【主要改动】
- app.py 端点 200 路径完整: 锁 acquire/release / 解析 task_id / 推算
  cutout / 调 regenerate_screen / 转 JPG 覆盖 ai_refined.jpg / WS publish
  screen_regenerated 事件 (含 cache-bust ?v=ts)
- 错误映射: IndexError→400 / FileNotFoundError→410 / 其他→500

【验收】
- python -m pytest → 250+ passed (零回归 236, 新增 14 regen 测)

【遗留】
- 前端 split-view UI (Task 7-9)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 前端 split-view toggle 骨架

**Files:**
- Modify: `templates/batch/history_detail.html`

- [ ] **Step 1：找到 ai_refined.jpg 当前渲染位置**

```bash
grep -n "ai_refined" templates/batch/history_detail.html
```
记下行号. 假设在 L<X>.

- [ ] **Step 2：在 ai_refined img 上方加 toggle 按钮**

在 ai_refined 区域插入：

```html
<div class="hd-view-toggle" data-item-id="{{ it.id }}">
  <button type="button" class="btn-toggle btn-active" data-mode="full">长图视图</button>
  <button type="button" class="btn-toggle" data-mode="split">分屏视图 (12 屏)</button>
</div>

<div class="hd-view-full">
  <!-- 原有 ai_refined img 不动 -->
  <img src="{{ it.ai_refined_url }}" class="hd-ai-img" alt="精修长图">
</div>

<div class="hd-view-split" style="display:none;">
  <!-- Task 8 填 12 屏 grid -->
  <div class="hd-split-loading">加载分屏中...</div>
</div>
```

加 CSS:

```css
.hd-view-toggle { display: flex; gap: 8px; margin: 12px 0; }
.btn-toggle { padding: 6px 14px; border: 1px solid var(--color-border);
              background: var(--color-bg-card); cursor: pointer;
              border-radius: var(--radius-sm); }
.btn-toggle.btn-active { background: var(--color-primary); color: white;
                         border-color: var(--color-primary); }
```

加 JS（在原有 script 块末尾）：

```js
document.addEventListener('click', (e) => {
  if (!e.target.classList.contains('btn-toggle')) return;
  const wrap = e.target.closest('.hd-view-toggle').parentElement;
  const mode = e.target.dataset.mode;
  wrap.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('btn-active'));
  e.target.classList.add('btn-active');
  wrap.querySelector('.hd-view-full').style.display = mode === 'full' ? '' : 'none';
  wrap.querySelector('.hd-view-split').style.display = mode === 'split' ? '' : 'none';
});
```

- [ ] **Step 3：手动验证（不写自动化测）**

```bash
python app.py
# 浏览器打开 batch detail, 验证 toggle 切换显示 / 隐藏
```
Expected: 长图 ↔ "加载分屏中..." 切换正常.

- [ ] **Step 4：commit**

```bash
git add templates/batch/history_detail.html
git commit -m "feat(regen-v1): task7 — split-view toggle UI 骨架

【主要改动】
- history_detail.html: 长图旁加 toggle 按钮 + 双视图容器
- CSS: btn-toggle / btn-active 样式
- JS: 点击切换显隐

【验收】
- 手动浏览器验证 toggle 切换正常 (Task 8 填分屏内容)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 12 屏 grid + reroll 按钮 + 确认 modal

**Files:**
- Modify: `templates/batch/history_detail.html`

- [ ] **Step 1：填 12 屏 grid HTML**

把 `<div class="hd-split-loading">` 替换为：

```html
<div class="hd-split-grid" data-task-id="{{ it.task_id or '' }}">
  {% set blocks_count = it.segments_count or 12 %}
  {% for i in range(blocks_count) %}
    <div class="hd-screen-card" data-index="{{ i }}">
      <img src="/static/ai_refine_v2/{{ it.task_id }}/block_{{ i }}.jpg"
           class="hd-screen-img" alt="第 {{ i+1 }} 屏" loading="lazy">
      <button type="button" class="btn-reroll" data-index="{{ i }}"
              data-item-pk="{{ it.id }}" data-batch-id="{{ batch.batch_id }}">
        🔄 重生此屏
      </button>
    </div>
  {% endfor %}
</div>
```

- [ ] **Step 2：加 confirm modal**

在 history_detail.html `<body>` 末尾加：

```html
<div id="rerollConfirmModal" class="modal-mask" style="display:none;">
  <div class="modal-card">
    <h3>重生第 <span id="rerollIdx"></span> 屏？</h3>
    <p>本次操作消耗 <strong>¥0.70</strong>，约 30 秒完成。</p>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button type="button" id="rerollCancel" class="btn">取消</button>
      <button type="button" id="rerollConfirm" class="btn btn-primary">确认</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3：CSS + JS**

```css
.hd-split-grid { display: grid; grid-template-columns: repeat(2, 1fr);
                 gap: 12px; }
.hd-screen-card { position: relative; }
.hd-screen-img { width: 100%; display: block; border-radius: var(--radius-sm); }
.btn-reroll { position: absolute; top: 8px; right: 8px; padding: 4px 10px;
              background: rgba(0,0,0,0.7); color: white; border: none;
              border-radius: 999px; cursor: pointer; font-size: 12px; }
.btn-reroll:hover { background: rgba(0,0,0,0.9); }
.btn-reroll:disabled { opacity: 0.5; cursor: wait; }
```

```js
let _pendingReroll = null;

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('btn-reroll')) {
    _pendingReroll = {
      batch_id: e.target.dataset.batchId,
      item_pk: e.target.dataset.itemPk,
      block_index: parseInt(e.target.dataset.index, 10),
      btn: e.target,
    };
    document.getElementById('rerollIdx').textContent = (_pendingReroll.block_index + 1).toString();
    document.getElementById('rerollConfirmModal').style.display = 'flex';
  }
  if (e.target.id === 'rerollCancel') {
    document.getElementById('rerollConfirmModal').style.display = 'none';
    _pendingReroll = null;
  }
  if (e.target.id === 'rerollConfirm') {
    if (!_pendingReroll) return;
    const p = _pendingReroll;
    document.getElementById('rerollConfirmModal').style.display = 'none';
    p.btn.disabled = true;
    p.btn.textContent = '⏳ 生成中…';
    fetch(`/api/batch/${p.batch_id}/items/${p.item_pk}/regenerate-screen`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({block_index: p.block_index}),
    }).then(r => r.json().then(j => ({ok: r.ok, status: r.status, body: j})))
      .then(({ok, status, body}) => {
        if (ok) {
          // WS 会推 screen_regenerated, 由 Task 9 监听刷图.
          // 这里 fallback 直接刷:
          const card = p.btn.closest('.hd-screen-card');
          const img = card.querySelector('.hd-screen-img');
          img.src = body.new_block_url;
          p.btn.disabled = false;
          p.btn.textContent = '🔄 重生此屏';
        } else {
          alert(`重生失败 (${status}): ${body.error || '未知错误'}`);
          p.btn.disabled = false;
          p.btn.textContent = '🔄 重生此屏';
        }
        _pendingReroll = null;
      })
      .catch(err => {
        alert(`网络错误: ${err.message}`);
        p.btn.disabled = false;
        p.btn.textContent = '🔄 重生此屏';
        _pendingReroll = null;
      });
  }
});
```

- [ ] **Step 4：手动验证**

```bash
python app.py
# 1) 打开一个已完成精修的 batch detail
# 2) toggle 到分屏视图 → 看 12 屏 grid 渲染
# 3) 点 🔄 → 弹 confirm modal
# 4) 点取消 → 关闭
# 5) 点确认 → fetch 触发 (会真烧 ¥0.7, 暂时只在本地非生产 key 模式跑或绕过)
```

- [ ] **Step 5：commit**

```bash
git add templates/batch/history_detail.html
git commit -m "feat(regen-v1): task8 — 12 屏 grid + reroll 按钮 + 确认 modal

【主要改动】
- 12 屏 grid (2 列), 每屏角上 🔄 按钮
- Confirm modal (¥0.70 提示)
- JS: fetch /regenerate-screen, 同步刷图 (WS 监听 Task 9 加)
- 错误处理: alert + 复位按钮状态

【验收】
- 手动浏览器: toggle/grid/modal/cancel/confirm 流程通

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: WS 客户端监听 + 长图 cache-bust 刷新

**Files:**
- Modify: `templates/batch/history_detail.html`

- [ ] **Step 1：找现有 WS 订阅代码**

```bash
grep -n "ws/batch\|new WebSocket\|onmessage" templates/batch/history_detail.html
```
Expected: 找到现有 WS 监听（任务2 实时进度推送时已有）

- [ ] **Step 2：扩展 onmessage 处理 screen_regenerated**

在现有 `ws.onmessage = (e) => { ... }` 内加分支：

```js
if (msg.type === 'screen_regenerated') {
  // 替换该屏 img
  const card = document.querySelector(
    `.hd-screen-card[data-index="${msg.block_index}"]`
  );
  if (card) {
    const img = card.querySelector('.hd-screen-img');
    img.src = msg.new_block_url; // 已带 ?v=ts
  }
  // 同时刷长图 (cache-bust)
  document.querySelectorAll('.hd-ai-img').forEach(el => {
    el.src = msg.new_assembled_url;
  });
  // toast
  if (window._showToast) {
    window._showToast(`第 ${msg.block_index + 1} 屏已重生 (¥${msg.cost_rmb})`, 'success');
  }
}
```

- [ ] **Step 3：手动验证**

```bash
# 真测 (本地 dev 起 mock 模式, V2_ALLOW_REAL_API 不开):
# 1) 打开 batch detail (一个已完成精修的)
# 2) 分屏视图
# 3) 点 🔄 一屏 → 确认
# 4) 验证: 该屏图刷新, 长图也刷新, toast 出现
```

- [ ] **Step 4：commit**

```bash
git add templates/batch/history_detail.html
git commit -m "feat(regen-v1): task9 — WS 监听 screen_regenerated + 长图刷新

【主要改动】
- ws.onmessage 加 type='screen_regenerated' 分支
- 替换该屏 img.src + 同步刷长图 (cache-bust ?v=ts 让浏览器避开 304)
- toast 通知 (用现有 _showToast helper)

【验收】
- 本地 mock 模式手动验证 reroll → 单屏 + 长图都刷新

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 真测 + 全测 + push + deploy

**Files:**
- Read-only

- [ ] **Step 1：跑完整测试套件**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 250+ passed, 1 skipped (236 baseline + 8 regen_single + 7 regen_endpoint - 1 skipped 一直在)

- [ ] **Step 2：本机 mock 真测**（不烧钱）

```bash
# 起 dev:
python app.py &
# 浏览器走完整流程: 上传 → 精修 (mock 模式) → batch detail → toggle → reroll
# 验证 4 个点: toggle / 12 屏 grid / confirm modal / WS 刷图
```

- [ ] **Step 3：腾讯云真测 1 次**（烧 ¥0.7）

```bash
# 等 deploy 后, 在 prod 真跑一次 reroll:
# 1) 进 prod batch detail (已完成的)
# 2) 分屏视图
# 3) 点 🔄 → 确认 (真扣 ¥0.7)
# 4) 等 ~30s 看图刷新
```

- [ ] **Step 4：用户授权后 push**

```bash
# 用户说 "push" 后:
git push
```

- [ ] **Step 5：用户授权后 deploy**

```bash
# 用户说 "deploy" 后, 走 /deploy skill 或:
ssh tencent-prod "cd /root/clean-industry-ai-assistant && git pull && docker compose restart && sleep 5 && docker compose ps"
```

- [ ] **Step 6：更新 memory（v3.3 单屏 reroll 上线）**

新建 memory 文件 `~/.claude/projects/.../memory/project_v33_regen_single_complete.md` 记录上线情况.

- [ ] **Step 7：完成 commit（如果有零碎收尾）**

```bash
git add -A
git commit -m "chore(regen-v1): task10 — v3.3 单屏 reroll 全套上线 (250+ 测绿)

【验收】
- 全测: 250+ passed
- 本机 mock 真测: toggle/grid/modal/WS 全通
- 腾讯云真测: ¥0.7 一次, 第 N 屏刷新成功
- v3.2.2 主路径零回归

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## 完成标准

- [ ] 全测 ≥ 250 passed (236 baseline + 14 新增)
- [ ] 0 个 v3.2.2 主路径回归 (test_refine_generator_v2 / test_pipeline_runner_v2 / test_color_extractor 全过)
- [ ] 本机手动验证 4 点: toggle / 12 屏 grid / confirm modal / WS 刷图
- [ ] prod 真测 1 次 reroll 成功 (¥0.7)
- [ ] 至少 6 个 commit (1 个 task = 1 commit)
- [ ] memory 更新 (v3.3 上线记录)

## 风险与回滚

**主要风险**：
- D3（assembled.png 重拼）: 如果 pipeline_runner 拼接代码无法抽，task 2 会用 fallback 独立实现，留 TODO 给下个 PR 重构
- 锁字典进程内: 多 worker 场景下不共享, 但生产 1 worker × N threads, OK; 真要扩多 worker, 加 redis lock 是独立任务
- gpt-image-2 失败: 端点已不计费 + 返 500, 用户重试; assembled.png 仍是旧版

**回滚**：
- 任何 task 出问题, `git revert <task_n_commit>` 即可（每 task 独立 commit）
- 端点单独可禁用：在 app.py 端点首行加 `return jsonify({"error": "v3.3 暂时下线"}), 503` 即关
- v3.2.2 主路径零依赖 v3.3，可单独冻结

---

**Plan 起草日期**：2026-04-30
**作者**：Claude Opus 4.7（design A1+A2+B3 by 用户）
**对应 Spec**：`docs/superpowers/specs/2026-04-30-regenerate-screen-design.md`
