# P3 — D1 API Key 托管砍刀流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"用户登录后必须再配 API key"这条交互删掉——`templates/auth/settings.html` 整块「API Key 配置卡」物理删除；所有调用从 `decrypt_api_key(user.custom_api_key_enc)` 改走 `os.environ['XXX_API_KEY']`；为支持第三方供应商加 `REFINE_API_BASE_URL` 环境变量；启动时校验 platform key 完整缺则报错。

**Architecture:** 单分支砍刀，零 schema 迁移（保留 `User.custom_api_key_enc` 字段不删，YAGNI 留扩展点）。fixture 改造走 monkeypatch + factory；调用点改造走"先 grep 全部出现处 → 集中改 → 跑全测验"三步。

**Tech Stack:** Flask · SQLAlchemy · Werkzeug · pytest monkeypatch · python-dotenv

**前置 Spec:** `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §8

**前置代码引用（必读）:**
- `app.py:1066-1100` — settings 路由 + custom key 写入
- `app.py:1944-1950` — refine 调用读 custom_api_key_enc
- `app.py:2955` — generation_log 记 key_source
- `app.py:5376` — fallback default
- `models.py:20` — `custom_api_key_enc` 字段（保留不删）
- `models.py:44` — `api_key_source` 字段
- `templates/auth/settings.html` — UI（整块删）
- `crypto_utils.py` — fernet 加解密（不动）
- `ai_refine_v2/refine_generator.py` — 加 base_url
- 现有 251 测中所有 fixture 设置 `custom_api_key_enc=encrypt_api_key(...)` 的位置

**工程原则（贯穿全 task）:**
1. 反硬编码 — `REFINE_API_BASE_URL` 走 env, 默认值不写死生产 URL
2. 根本性修复 — 不只是隐藏 UI, 整条 custom key write 路径删干净
3. PR-as-deliverable — 1 个 PR 包含全部砍刀 + fixture migration + 守护测
4. 写后必验 — 启动校验 (缺 key 立即报错) 是写后必验的 infra 化

---

## File Structure

| 路径 | 行为 | 责任 |
|------|------|------|
| `templates/auth/settings.html` | **修改** (-50/+0 行) | 物理删 「API Key 配置卡」整块 |
| `app.py` | **修改** (~80 行 diff) | 删 settings 路由 custom key write/read; 删 refine 调用 decrypt; 加启动校验; 改 GenerationLog.key_source |
| `ai_refine_v2/refine_generator.py` | **修改** (+10 行) | 加 `REFINE_API_BASE_URL` env 注入 |
| `ai_refine_v2/tests/conftest.py` | **修改** (+30 行) | factory 改 monkeypatch env vars 而非 set custom_api_key_enc |
| `ai_refine_v2/tests/test_*.py` | **修改** (n 处) | fixture 用法迁移 |
| `tests/test_*.py` | **修改** (n 处) | 同上 |
| `tests/test_p3_invariants.py` | **创建** (~50 行) | 守护测: settings.html 不再含 "API Key 卡"; app.py 启动缺 key 报错; refine_generator 接 env base_url |
| `.env.example` | **修改** | 列出所有 platform key 名 + REFINE_API_BASE_URL 示例 |
| `models.py` | **不动** | `custom_api_key_enc` / `api_key_source` 字段保留 |

---

## 执行顺序与依赖

```
T1 (grep 全调用点 + 写 catalog)
  ↓
T2 (TDD 红: 写 P3 守护测, 全测保持绿不变)
  ↓
T3 (改 conftest 加 monkeypatch fixture)
  ↓
T4 (迁移所有 test fixture 用 monkeypatch, 251 测保持绿)
  ↓
T5 (砍刀: 删 settings.html API Key 卡 + app.py 写入路由)
  ↓
T6 (砍刀: 改 refine 调用读 env)
  ↓
T7 (加启动校验 + .env.example 更新)
  ↓
T8 (refine_generator 加 base_url env 注入)
  ↓
T9 (跑全测 + 守护测 PASS)
  ↓
T10 (PR feat/p3-key-platform)
```

---

## Task 1: grep 调用点 + 写 catalog

**Files:**
- Create: `docs/superpowers/_scratch/p3-key-call-graph.md` (临时 catalog, 完工删)

- [ ] **Step 1: grep 全部 custom_api_key_enc 出现位置**

```bash
grep -rn "custom_api_key_enc" --include="*.py" --include="*.html" 2>&1 | tee /tmp/p3-grep-key.txt
grep -rn "decrypt_api_key" --include="*.py" 2>&1 | tee -a /tmp/p3-grep-key.txt
grep -rn "encrypt_api_key" --include="*.py" 2>&1 | tee -a /tmp/p3-grep-key.txt
grep -rn "api_key_source" --include="*.py" 2>&1 | tee -a /tmp/p3-grep-key.txt
```

- [ ] **Step 2: 把结果写成 catalog markdown**

写到 `docs/superpowers/_scratch/p3-key-call-graph.md`:

```markdown
# P3 调用点 catalog (临时, T10 删)

## A. 写入路径 (settings 路由)
- `app.py:1066-1100` — `@app.route("/settings")` POST 分支
- `templates/auth/settings.html` — 输入表单

→ T5 整块删

## B. 读取路径 (调用 refine 时取 key)
- `app.py:1944-1950` — refine 任务取 owner.custom_api_key_enc
- `app.py:2955` — GenerationLog 记 key_source

→ T6 改读 os.environ

## C. 测试 fixture (创建带 custom_api_key_enc 的 User)
- `ai_refine_v2/tests/test_regen_endpoint.py:28` — `u.custom_api_key_enc = encrypt_api_key("x")`
- (其他 grep 出来的位置...)

→ T3-T4 迁移到 monkeypatch

## D. 一次性脚本 (archive, 不动)
- `scripts/archive/one_shot/smoke_task8_concurrency.py:53,56` — 测试用脚本

→ 不改 (已在 archive)

## E. 模型/迁移 (字段定义, 保留)
- `models.py:20,44` — schema 字段定义
- `migrations/versions/a73747e2b475_*.py:29,69` — alembic baseline

→ 不改 (字段保留)
```

- [ ] **Step 3: 不 commit, 进 T2**

---

## Task 2: 写 P3 守护测 (TDD 红)

**Files:**
- Create: `tests/test_p3_invariants.py`

- [ ] **Step 1: 写守护测**

```python
"""P3 守护测: 砍刀流的关键不可逆变更必须永久守住."""
import os
import unittest
from pathlib import Path

import pytest


class TestSettingsHtmlNoApiKeyCard(unittest.TestCase):
    """settings.html 必须不再含 "API Key" 输入区."""

    def test_no_api_key_input(self):
        path = Path(__file__).parent.parent / "templates/auth/settings.html"
        text = path.read_text(encoding="utf-8")
        self.assertNotIn('name="api_key"', text)
        self.assertNotIn('"custom_api_key"', text)


class TestAppPyCustomKeyWriteRemoved(unittest.TestCase):
    """app.py 不许还有把 custom key 写进 DB 的代码 (写入路径已砍)."""

    def test_no_encrypt_api_key_write(self):
        path = Path(__file__).parent.parent / "app.py"
        text = path.read_text(encoding="utf-8")
        # encrypt_api_key 仍可在 import 行 / 旧路径见到, 但赋值给 custom_api_key_enc 必须没了
        self.assertNotIn(
            "current_user.custom_api_key_enc = encrypt_api_key",
            text,
            "app.py 仍有 custom key 写入逻辑, P3 砍刀未完成"
        )


class TestRefineGeneratorBaseUrl(unittest.TestCase):
    """refine_generator 必须接 REFINE_API_BASE_URL 环境变量."""

    def test_refine_generator_reads_base_url_env(self):
        path = Path(__file__).parent.parent / "ai_refine_v2/refine_generator.py"
        text = path.read_text(encoding="utf-8")
        self.assertIn("REFINE_API_BASE_URL", text)


class TestStartupValidation(unittest.TestCase):
    """app.py 必须在启动时校验 platform key, 缺则 raise."""

    def test_app_py_has_platform_key_check(self):
        path = Path(__file__).parent.parent / "app.py"
        text = path.read_text(encoding="utf-8")
        # 至少有一处 raise 或 sys.exit + DEEPSEEK_API_KEY 提示
        self.assertRegex(
            text,
            r"DEEPSEEK_API_KEY.{0,200}(raise|sys\.exit|RuntimeError)",
        )


class TestEnvExampleHasPlatformKeys(unittest.TestCase):
    """.env.example 必须列出 platform key 名."""

    def test_env_example_lists_platform_keys(self):
        path = Path(__file__).parent.parent / ".env.example"
        if not path.exists():
            self.skipTest(".env.example 还没创建 (T7 任务)")
        text = path.read_text(encoding="utf-8")
        self.assertIn("DEEPSEEK_API_KEY", text)
        self.assertIn("REFINE_API_BASE_URL", text)
```

- [ ] **Step 2: 跑测验证 FAIL**

```bash
python -m pytest tests/test_p3_invariants.py -v 2>&1 | tail -15
```
Expected: 5 fails (砍刀还没做)

- [ ] **Step 3: Commit 失败测**

```bash
git add tests/test_p3_invariants.py
git commit -m "test(p3): 加 5 守护测 (砍刀流 invariants), 当前预期 FAIL

定义 P3 完工的客观标准: settings.html 删 API Key 卡 / app.py 删写入逻辑 /
refine_generator 接 base_url env / 启动校验缺 key / .env.example 列 keys.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: conftest 加 monkeypatch env 工厂

**Files:**
- Modify: `ai_refine_v2/tests/conftest.py`

- [ ] **Step 1: 在 P0 已加的 conftest.py 里追加 fixture**

```python
@pytest.fixture(autouse=True)
def _platform_keys(monkeypatch):
    """所有测自动注入 fake platform keys, 取代 fixture 设 custom_api_key_enc."""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test-deepseek-fake")
    monkeypatch.setenv("REFINE_API_KEY", "sk-test-refine-fake")
    monkeypatch.setenv("REFINE_API_BASE_URL", "https://api.test-refine.local/v1")
    monkeypatch.setenv("ARK_API_KEY", "ark-test-fake")
    yield
    # monkeypatch 自动清


@pytest.fixture
def make_user_no_key(make_user):
    """简化版: 创建用户, 不需要再设 custom_api_key_enc."""
    return make_user
```

- [ ] **Step 2: 跑全测保持绿**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 252 passed (P0 base) + 5 fails (P3 守护测预期 fail) — 但**不是新增 fail**

- [ ] **Step 3: Commit**

```bash
git add ai_refine_v2/tests/conftest.py
git commit -m "test(p3): conftest 加 _platform_keys autouse 注入 fake env

未来 fixture 不再依赖 db 字段 custom_api_key_enc, 改走 env 路径.
为 T4 迁移既有 fixture 铺路.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 迁移既有 test fixture (custom_api_key_enc → env)

**Files:**
- Modify: `ai_refine_v2/tests/test_regen_endpoint.py`
- Modify: `tests/test_*.py` (任何 grep 命中的)

- [ ] **Step 1: grep 命中位置**

```bash
grep -rn "custom_api_key_enc" --include="*.py" tests/ ai_refine_v2/tests/ 2>&1
```

- [ ] **Step 2: 逐个改**

模式 1 — `setUp` 里设字段:

```python
# 旧
u = User(username="alice")
u.set_password("x")
u.custom_api_key_enc = encrypt_api_key("sk-fake")
db.session.add(u)

# 新 (依赖 conftest 自动注入 env)
u = make_user(username="alice")  # _platform_keys autouse fixture 已注入 env
```

模式 2 — 显式断言 key_source:

```python
# 旧
self.assertEqual(log.api_key_source, "custom")

# 新 (砍刀后所有 log 都是 platform)
self.assertEqual(log.api_key_source, "platform")
```

- [ ] **Step 3: 跑被影响的具体测验绿**

```bash
python -m pytest ai_refine_v2/tests/test_regen_endpoint.py -v 2>&1 | tail -15
```
Expected: 全 PASS (该测无回归)

- [ ] **Step 4: 跑全测**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 252 passed (P3 守护 5 测仍 fail, 预期)

- [ ] **Step 5: Commit**

```bash
git add ai_refine_v2/tests/ tests/
git commit -m "test(p3): 迁移 N 处 fixture 从 custom_api_key_enc 到 env (252 测保持绿)

模式: User row 不再设 custom_api_key_enc, 走 conftest _platform_keys autouse env.
log.api_key_source 断言全改 'platform'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 砍 settings.html API Key 卡 + app.py 写入路由

**Files:**
- Modify: `templates/auth/settings.html` (-50 行整块)
- Modify: `app.py` (settings POST 分支)

- [ ] **Step 1: 看 settings.html 结构**

```bash
grep -n "API.{0,5}Key\|api_key\|custom" templates/auth/settings.html
```

- [ ] **Step 2: 物理删整块「API Key 配置卡」**

删除从 `<div class="card">` 含 "API Key" 标题开始, 到对应 `</div>` 结束的整段. 不留注释 / 不留隐藏 input.

(如果还有显示"已配置/未配置"的 status 行, 也删)

- [ ] **Step 3: 改 settings 路由**

`app.py:1066` 附近的 settings 路由 POST 分支:

```python
# 旧 (砍掉)
@app.route("/settings", methods=["GET", "POST"])
@login_required
def settings():
    has_custom_key = bool(current_user.custom_api_key_enc)
    if request.method == "POST":
        new_key = request.form.get("api_key", "").strip()
        if new_key:
            current_user.custom_api_key_enc = encrypt_api_key(new_key)
            db.session.commit()
            flash("API Key 已保存", "success")
        # ...
    return render_template("auth/settings.html", has_custom_key=has_custom_key)

# 新 (settings 路由保留, 但只展示账号信息, 不再有 key 配置)
@app.route("/settings", methods=["GET"])
@login_required
def settings():
    return render_template("auth/settings.html")
```

POST 整块删除. GET 简化到只渲染账号信息.

- [ ] **Step 4: 跑相关测**

```bash
python -m pytest tests/test_p3_invariants.py::TestSettingsHtmlNoApiKeyCard -v
python -m pytest tests/test_p3_invariants.py::TestAppPyCustomKeyWriteRemoved -v
```
Expected: 2 个守护测 PASS (T2 那 5 个里的 2 个解锁)

- [ ] **Step 5: 跑全测**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 252 测保持绿 (settings 页相关 e2e 测可能要小调, 在 step 6 处理)

- [ ] **Step 6: 修任何被砍刀波及的测**

如果有专门测 settings POST 的 (`test_settings_save_key.py` 之类), 该测应当**直接删除** (功能不存在了, 不该再测).

- [ ] **Step 7: Commit**

```bash
git add templates/auth/settings.html app.py tests/
git commit -m "feat(p3): 砍 settings.html API Key 配置卡 + app.py POST 写入路由

物理删整块 UI + 删除 POST 分支. settings 页只渲染账号信息.
2 守护测 PASS (settings.html 不再含 input; app.py 不再有 custom key 写入).
保留 User.custom_api_key_enc 字段不删 (YAGNI 留扩展点).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 砍 refine 调用读 custom key, 改读 env

**Files:**
- Modify: `app.py:1944-1950` (refine 任务)
- Modify: `app.py:2955` (GenerationLog.key_source)

- [ ] **Step 1: 看 1944 附近**

```bash
sed -n '1940,1960p' app.py
```

- [ ] **Step 2: 改写**

```python
# 旧
if not owner.custom_api_key_enc:
    log.api_key_source = "none"
    raise RuntimeError("用户未配置 DeepSeek key")
try:
    api_key = decrypt_api_key(owner.custom_api_key_enc)
    log.api_key_source = "custom"
except Exception:
    raise RuntimeError("解密失败")

# 新
api_key = os.environ.get("DEEPSEEK_API_KEY")
if not api_key:
    raise RuntimeError("缺 DEEPSEEK_API_KEY, 请联系运维配 .env")
log.api_key_source = "platform"
```

注意: 把所有 `key_source = "custom"` 都改成 `"platform"`. `"none"` 路径删除.

- [ ] **Step 3: 跑相关测**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 252 仍绿; 守护测 P3 还有 3 个 fail (refine_generator base_url, startup, .env.example)

- [ ] **Step 4: Commit**

```bash
git add app.py
git commit -m "feat(p3): 砍 refine 任务读 user custom key, 改读 os.environ

key_source 字段统一记 'platform'; 'custom' 'none' 两条历史路径删除.
缺 platform key 报错抛 RuntimeError, 由 worker 顶层捕获标 batch_item.failed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 启动校验缺 key 报错 + .env.example

**Files:**
- Modify: `app.py` (启动钩子)
- Create or modify: `.env.example`

- [ ] **Step 1: 加启动校验**

在 `app.py` 启动入口附近 (能找到 `if __name__ == "__main__"` 或 `app.run` 之前的全局段落), 加:

```python
# ── 启动时校验 platform key ──
_REQUIRED_PLATFORM_KEYS = ["DEEPSEEK_API_KEY", "REFINE_API_KEY", "REFINE_API_BASE_URL"]
_missing = [k for k in _REQUIRED_PLATFORM_KEYS if not os.environ.get(k)]
if _missing:
    msg = (
        f"\n[启动校验] 缺以下 platform key: {_missing}\n"
        f"  请在 .env 配齐后重启. 参考 .env.example.\n"
        f"  (P3 砍刀流后用户不再自配 key, 必须 platform 全配)\n"
    )
    raise RuntimeError(msg)
```

注意位置: 应当在所有 import 完成 + os.environ 加载 (dotenv) 之后, 路由注册之前.

- [ ] **Step 2: 写/扩 .env.example**

```bash
ls .env.example 2>&1
```

如果不存在则创建; 存在则 edit. 内容:

```ini
# === Platform API Keys (P3 砍刀流后必填) ===
DEEPSEEK_API_KEY=sk-xxx-deepseek
REFINE_API_KEY=sk-xxx-gpt-image-2
REFINE_API_BASE_URL=https://api.example.com/v1   # P3 实施时填实际供应商
ARK_API_KEY=ark-xxx-doubao   # 已弃用但保留兼容历史

# === 加密 ===
FERNET_KEY=<openssl rand -base64 32>

# === 应用 ===
SECRET_KEY=<openssl rand -hex 32>

# === DB ===
DATABASE_URL=sqlite:///instance/app.db

# === 代理 ===
HTTP_PROXY=http://127.0.0.1:7890   # Clash, 跑国外 API 用; DeepSeek 已自动 bypass
HTTPS_PROXY=http://127.0.0.1:7890
```

- [ ] **Step 3: 跑测验证两个守护测 PASS**

```bash
python -m pytest tests/test_p3_invariants.py::TestStartupValidation -v
python -m pytest tests/test_p3_invariants.py::TestEnvExampleHasPlatformKeys -v
```
Expected: 2 PASS (5 守护现解锁 4 个, 还差 base_url)

- [ ] **Step 4: 跑全测**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 252 仍绿; conftest 已注入 fake env, 测试时启动校验通过.

- [ ] **Step 5: Commit**

```bash
git add app.py .env.example tests/
git commit -m "feat(p3): 启动校验缺 platform key 报错 + .env.example 列必配

3 个 platform key + base_url 任一缺则启动 raise RuntimeError.
.env.example 列出全部 platform 变量 + 注释标实际值在 P3 实施时填.
2 守护测 PASS (startup 校验, env.example).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: refine_generator 加 base_url 注入

**Files:**
- Modify: `ai_refine_v2/refine_generator.py`

- [ ] **Step 1: 看现有 OpenAI client 初始化**

```bash
grep -n "OpenAI\|client = " ai_refine_v2/refine_generator.py
```

- [ ] **Step 2: 改写**

```python
# 旧 (示意, 实际可能略不同)
from openai import OpenAI
client = OpenAI(api_key=os.environ["REFINE_API_KEY"])

# 新
from openai import OpenAI

# REFINE_API_BASE_URL 必填; 启动校验已确认非空 (app.py)
# 不在这里再硬编码任何 fallback URL — 严禁默认值写死生产 endpoint
client = OpenAI(
    api_key=os.environ["REFINE_API_KEY"],
    base_url=os.environ["REFINE_API_BASE_URL"],
)
```

注意:
- 不写默认 URL (启动校验已确保 env 有值)
- 反硬编码原则严守 (反例: `os.getenv("X", "https://default-url")` — 默认值是软硬编码, 跟 spec §3 #1 冲突)

- [ ] **Step 3: 跑测**

```bash
python -m pytest tests/test_p3_invariants.py::TestRefineGeneratorBaseUrl -v
```
Expected: PASS

- [ ] **Step 4: 跑全测**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 252 + 5 = 257 全绿 (P3 守护 5 测全 PASS)

- [ ] **Step 5: Commit**

```bash
git add ai_refine_v2/refine_generator.py
git commit -m "feat(p3): refine_generator 加 base_url 强制 env 注入 (反硬编码)

OpenAI client 不再写死 endpoint, 走 REFINE_API_BASE_URL.
反硬编码原则: 不留 fallback default URL, 必须启动校验保证 env 非空.
5 守护测全 PASS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 全测 + 跑 /smoke + 删 catalog

**Files:**
- Delete: `docs/superpowers/_scratch/p3-key-call-graph.md` (临时 catalog, 完工删)

- [ ] **Step 1: 跑全测**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 257 passed (252 P0 base + 5 P3 守护)

- [ ] **Step 2: 跑 /smoke skill**

```
# 通过 Skill 工具调
Skill(skill="smoke")
```
Expected: 5 步全过

- [ ] **Step 3: 删 catalog**

```bash
rm docs/superpowers/_scratch/p3-key-call-graph.md
rmdir docs/superpowers/_scratch 2>&1 || true   # 空目录则删
```

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "chore(p3): 全测 257 绿 + smoke 全过 + 清临时 catalog

P3 砍刀流闭环: settings.html 卡删 / app.py 写入读取改 env / refine_generator
接 base_url / 启动校验 / .env.example 同步.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: PR feat/p3-key-platform

**Files:** 不改代码

- [ ] **Step 1: push**

```bash
git checkout -b feat/p3-key-platform
git push -u origin feat/p3-key-platform
```

- [ ] **Step 2: 开 PR (5 节 description)**

```bash
gh pr create --title "P3: API Key 托管砍刀流 (用户登录即用, 257 测绿)" --body "$(cat <<'EOF'
## 背景

per master roadmap (\`docs/superpowers/specs/2026-05-06-master-roadmap-design.md\`) §8. Scott 选 Q6=A 砍刀流: 用户登录后不再需要配 API key, 全走 platform key (env 注入).

之前痛点:
1. 用户登录后必须再去 settings 页配 DeepSeek key, 摩擦大
2. 接口写死豆包形态, 无 base_url 支持, 配不了第三方
3. fernet 加密 fake-用户的 custom key, 安全收益 ~0 (只是把 key 放数据库)

## 改动 (反硬编码 + 根本性修复)

### UI 层
- \`templates/auth/settings.html\` 物理删 「API Key 配置卡」整块 (~50 行)
- settings 路由保留但仅展示账号信息

### 调用层
- \`app.py:1066-1100\` settings POST 分支删除
- \`app.py:1944-1950\` refine 任务从 \`decrypt_api_key(owner.custom_api_key_enc)\` 改读 \`os.environ['DEEPSEEK_API_KEY']\`
- \`app.py:2955\` GenerationLog.key_source 统一记 \"platform\"

### 基础设施
- 启动校验: 缺任一 platform key 立即 \`raise RuntimeError\` + 友好提示
- \`ai_refine_v2/refine_generator.py\` 接 \`REFINE_API_BASE_URL\` 强制 env 注入 (反硬编码: 不留 fallback default URL)
- \`.env.example\` 列出全部 platform key

### 测试 infra
- \`ai_refine_v2/tests/conftest.py\` 加 \`_platform_keys\` autouse fixture 注入 fake env
- N 处既有 fixture 从 \`custom_api_key_enc\` 字段迁移到 monkeypatch env

### 守护
- \`tests/test_p3_invariants.py\` 5 守护测: settings.html 无 input / app.py 无写入 / base_url env / startup 校验 / .env.example 列 keys

### 保留 (YAGNI 留扩展点)
- \`User.custom_api_key_enc\` 字段保留 (无 schema 迁移成本, 未来需要时 1 PR 即可加回 UI)
- \`User.api_key_source\` 字段保留

## 验证

- [x] 全测 \`python -m pytest -q\` → **257 passed** (P0 基线 252 + P3 守护 5)
- [x] /smoke skill → 全过
- [x] 启动 \`python app.py\` 在 fake env 下正常起 (校验通过)
- [x] grep \`custom_api_key_enc\` 仅剩 models 字段定义 + tests 历史断言
- [x] 反硬编码: \`REFINE_API_BASE_URL\` 没默认 URL, 启动校验严守

## 风险

| 风险 | 触发概率 | 缓解 |
|---|---|---|
| 现存 prod admin 的 \`custom_api_key_enc\` 仍有数据, 未来若 fix 需要回填 | 5% | 字段保留, 不删 row, 数据不丢 |
| 漏改某个 caller 仍读 \`custom_api_key_enc\` | 10% | T1 grep catalog 已穷尽; 守护测 + 全测兜底 |
| 启动校验对生产部署引入新 fail mode | 20% | 部署文档同步更新; .env.example 列齐 |

## 回滚

\`\`\`
git revert <merge-commit>
\`\`\`

回滚后字段 / UI / 调用全恢复. 但生产已注入的 env 不会自动回填到 \`custom_api_key_enc\`, 用户需重新配 settings (跟 P3 之前一样).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: STOP — 等 Scott merge**

merge 后 P3 闭环, 可起 P4 / P5.0.

---

## 完成标准

- [ ] T1-T10 全过
- [ ] 全测 ≥ 257 passed (252 P0 base + 5 P3 守护)
- [ ] `/smoke` skill 全过
- [ ] grep `custom_api_key_enc` 调用点 (排除 models / migrations / tests fixture) → 0 命中
- [ ] settings.html 无 `name="api_key"` / `"custom_api_key"` 字符串
- [ ] `.env.example` 含 4 条 platform 变量
- [ ] 启动校验缺 key 立即 raise (本机故意 unset 一个验证)
- [ ] PR 已开, 等 Scott merge

## 风险与回滚

| 风险 | 触发概率 | 应对 |
|---|---|---|
| fixture 迁移漏改某个测 (用 setUpClass 共享 user) | 30% | T4 step 4 跑全测必须绿; fail 的现场修 |
| settings.html 删过头, 误删账号信息节 | 15% | T5 step 2 仔细看节边界; PR review 时 Scott 校 |
| 启动校验在某个 dev 环境 .env 不全, 跑不起 | 25% | 友好提示 + .env.example 列齐变量名 |
| `User.custom_api_key_enc` 字段保留但不再被任何地方写, 未来 alembic autogen 可能建议删 | 10% | autogen 需手审, 不自动 apply; 字段定义旁加注释 "保留 per P3 spec" |
| OpenAI client 实际不接 `base_url` 参数 (旧版本) | 5% | T8 实施时验证 openai 包版本; 如果旧, 升级或换 raw httpx |

**回滚:** `git revert <PR-merge-commit>`. 配合: 提醒 prod 重新配 .env (因为字段 `custom_api_key_enc` 保留但回滚后又走 read 路径).

---

**Plan 起草日期**: 2026-05-06
**作者**: Claude Opus 4.7
**对应 Spec**: `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §8
**预计工时**: 0.5-1 day
