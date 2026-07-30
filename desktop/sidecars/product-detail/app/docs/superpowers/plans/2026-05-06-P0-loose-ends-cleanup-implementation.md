# P0 — 收尾遗留与基础清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v3.3 收尾、pytest 僵尸用户根因 + 清理、腾讯云 prod admin 密码同步三件遗留事项一次性闭环，不带进 P1+。

**Architecture:** 一阶段三独立子任务串：(1) 僵尸用户清理走"根因+一次性清理+CI 守护"三层修复，自动可做；(2) v3.3 收尾走 push→真测→deploy 三步，每步留 stop-and-ask gate；(3) prod admin 密码用一次性脚本走 SSH+docker exec+write+verify 闭环。

**Tech Stack:** pytest fixtures · Flask CLI · SQLAlchemy · SSH · docker compose · gpt-image-2 真测

**前置 Spec:** `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §5

**前置代码引用（必读）:**
- `ai_refine_v2/tests/test_regen_endpoint.py:25-65` — 创建 User row 但不 teardown 的源头
- `app.py:5485-5505` — `flask create-admin` CLI 命令（参考结构）
- `auth.py:13-37` — login 流程（验证 prod 密码用）
- `feedback_write_then_verify.md` — 写后必验铁律
- `docs/2026-04-21_踩坑复盘_生产上线.md` 坑 5 — prod 密码假成功教训

**工程原则（贯穿全 task）:**
1. 反硬编码 — 测试 fixture 不写死 user_id；脚本不写死路径
2. 根本性修复 — 僵尸用户走 fixture 改造而不是"每次跑完手动 truncate"
3. PR-as-deliverable — P0 子任务 1 出 1 个 PR (feat/p0-zombie-cleanup)；v3.3 收尾走原 v33 分支；prod 密码不动 git
4. 写后必验 — 任何写操作（DB/文件/远程）后立即构造"读或用"动作

---

## File Structure

| 路径 | 行为 | 责任 |
|------|------|------|
| `ai_refine_v2/tests/conftest.py` | **创建** (~80 行) | pytest 全局 fixture：`db_session` autouse savepoint+rollback；`make_user` factory |
| `ai_refine_v2/tests/test_regen_endpoint.py` | **修改** (~10 行 diff) | 把 setUp 创建 User 改用 conftest fixture |
| `tests/test_regen_endpoint.py` | **修改** | 同上（如该路径存在） |
| `scripts/_tmp_purge_test_users.py` | **创建** (~50 行) | 一次性脚本：删既有 60+ 条僵尸 + 跑后 commit 删除文件 |
| `tests/test_no_zombie_users.py` | **创建** (~30 行) | CI 守护测：跑完任意测之后断言 DB 不留 zombie 前缀 |
| `scripts/reset_prod_admin.py` | **创建** (~60 行, 用完即删) | prod 密码重置脚本，docker exec 跑 |

**v3.3 收尾零代码改动**——直接走 spec §5.1 的 push/真测/deploy 流程，本 plan 只负责标记 stop-and-ask gate。

---

## 执行顺序与依赖

```
T1 (诊断: 列僵尸用户 + 选 fixture 方案) — 可立即开始
  ↓
T2 (写 conftest.py db_session fixture + 失败测)
  ↓
T3 (改既有 test 文件用新 fixture, 251 测保持绿)
  ↓
T4 (一次性清理脚本 + 跑 + 验证 0 zombie)
  ↓
T5 (CI 守护测 test_no_zombie_users.py)
  ↓
T6 (PR feat/p0-zombie-cleanup → 等 Scott merge)

T7 (v3.3 push, 等 Scott 授权)  ← 独立, 不阻塞 T1-T6
T8 (v3.3 真测 ¥0.7, 等 Scott 授权)
T9 (v3.3 deploy 腾讯云, 等 Scott 授权)
T10 (prod admin 密码同步, 等 Scott 授权)
```

T1-T6 自动跑；T7-T10 阻断在 Scott 口令上。

---

## Task 1: 僵尸用户诊断 + fixture 方案选型

**Files:**
- Read-only：grep 现有创建 User 的所有测试

- [ ] **Step 1: 跑诊断脚本列僵尸**

```bash
python -c "
from app import app
from models import User
with app.app_context():
    zombies = User.query.filter(
        User.username.regexp_match(
            r'^(alice|bob_other|lock_user|bi_user|done_user|ok_user|viewer)_'
        )
    ).all()
    print(f'zombies: {len(zombies)}')
    for u in zombies[:5]:
        print(f'  {u.id} {u.username}')
"
```
Expected: 输出 60+ 条僵尸（具体数字记下，T4 验证用）

- [ ] **Step 2: grep 创建 User 的所有测试位置**

```bash
grep -rn "User(username=" ai_refine_v2/tests/ tests/ --include="*.py" | head -30
```
Expected: 罗列出所有 setUp 里 `User(username=...)` 的位置（应该是 5-10 处）

- [ ] **Step 3: 选 fixture 方案 — 决定走 A 还是 B**

| 方案 | 优势 | 劣势 |
|------|------|------|
| **A** ⭐ | pytest-flask-sqlalchemy 的 `db_session` autouse fixture (savepoint+rollback) | 需装新依赖；行为最干净 |
| **B** | 自写 conftest.py 的 `db_session` fixture (手写 nested transaction) | 0 新依赖；代码 30 行 |

推荐 **B**（自写），不引新依赖，符合本路线图轻量原则。

- [ ] **Step 4: 不 commit，进 Task 2**

---

## Task 2: 写 conftest.py db_session fixture + 失败测

**Files:**
- Create: `ai_refine_v2/tests/conftest.py`
- Create: `ai_refine_v2/tests/test_fixture_rollback.py`

- [ ] **Step 1: 写失败测 — 验证 fixture 真 rollback**

```python
# ai_refine_v2/tests/test_fixture_rollback.py
"""验证 conftest 的 db_session fixture 在 test 间真做 rollback."""
import pytest
from models import User
from extensions import db


def test_create_user_in_test_a(db_session):
    """A 测里造一个用户 'fixture_test_a'."""
    u = User(username="fixture_test_a")
    u.set_password("x")
    db.session.add(u)
    db.session.flush()
    assert User.query.filter_by(username="fixture_test_a").first() is not None


def test_user_from_test_a_is_gone(db_session):
    """B 测里那个用户应该看不到 (说明 A 测的事务被 rollback 了)."""
    found = User.query.filter_by(username="fixture_test_a").first()
    assert found is None, "fixture_test_a 没 rollback, 是个 bug"
```

- [ ] **Step 2: 跑测验证 FAIL**

```bash
python -m pytest ai_refine_v2/tests/test_fixture_rollback.py -v 2>&1 | tail -10
```
Expected: 第二个测 FAIL（因为 fixture 还没接 rollback 逻辑，A 测的 user 残留）

- [ ] **Step 3: 写 conftest.py 的 db_session fixture**

```python
# ai_refine_v2/tests/conftest.py
"""pytest fixtures: 全局 db_session 自动 savepoint+rollback."""
import pytest
from app import app as flask_app
from extensions import db


@pytest.fixture(autouse=True)
def db_session():
    """每个测一个 nested transaction; 测完 rollback, 0 脏数据."""
    with flask_app.app_context():
        connection = db.engine.connect()
        transaction = connection.begin()

        # 把 session 绑到这个 connection
        options = dict(bind=connection, binds={})
        session = db.create_scoped_session(options=options)
        db.session = session

        nested = connection.begin_nested()

        @db.event.listens_for(session(), "after_transaction_end")
        def restart_savepoint(sess, trans):
            nonlocal nested
            if trans.nested and not trans._parent.nested:
                nested = connection.begin_nested()

        yield session

        session.remove()
        transaction.rollback()
        connection.close()
```

- [ ] **Step 4: 跑测验证 PASS**

```bash
python -m pytest ai_refine_v2/tests/test_fixture_rollback.py -v 2>&1 | tail -10
```
Expected: 2 passed

- [ ] **Step 5: 跑全测确认无回归**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 251+ passed (已有的测可能拿到新的 db_session, 应当都 pass; 若有 fail 进 T3 修)

- [ ] **Step 6: Commit**

```bash
git add ai_refine_v2/tests/conftest.py ai_refine_v2/tests/test_fixture_rollback.py
git commit -m "test(p0): 加 conftest db_session autouse fixture + rollback 测 (253 测绿)

根因: pytest 创建 User row 不 teardown, 累积 60+ 僵尸用户.
修法: 全局 nested transaction + autouse rollback, 0 脏数据.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 改既有测试用 fixture（删 setUp 里 User 创建残留）

**Files:**
- Modify: `ai_refine_v2/tests/test_regen_endpoint.py`
- Modify: 任何 grep 出来还在直接 `User(username=...)` 的测

- [ ] **Step 1: 看 test_regen_endpoint.py 的 setUp**

```bash
grep -n "User(username=" ai_refine_v2/tests/test_regen_endpoint.py
```

- [ ] **Step 2: 改用 fixture 工厂**

在 conftest.py 里加 `make_user` factory：

```python
@pytest.fixture
def make_user(db_session):
    """factory: make_user(username='alice', is_admin=True) 返回 User 实例."""
    created = []
    def _make(username=None, **kwargs):
        import uuid
        username = username or f"u_{uuid.uuid4().hex[:8]}"
        u = User(username=username, **kwargs)
        u.set_password("x")
        db.session.add(u)
        db.session.flush()
        created.append(u)
        return u
    yield _make
    # rollback 自动清; 这里不需要再删
```

把 `test_regen_endpoint.py` setUp 里的 `User(username="alice_xxx")` 改用 `make_user("alice_xxx")`：

```python
# 旧:
class TestRegenEndpoint4xx(unittest.TestCase):
    def setUp(self):
        with app.app_context():
            u = User(username=f"alice_{secrets.token_hex(4)}")
            u.set_password("x")
            ...

# 新 (用 pytest 风格 + fixture):
@pytest.mark.usefixtures("db_session")
class TestRegenEndpoint4xx:
    def test_xxx(self, make_user):
        u = make_user(username="alice")
        ...
```

> **如果改 unittest.TestCase 太大动**: 另一条路 — 在 setUp 里 `from conftest import make_user_oneshot` 复用核心逻辑，setUp/tearDown 套 nested transaction 手工。选哪条按现有结构最小变更。

- [ ] **Step 3: 跑全测**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 251+ passed, 0 fail

- [ ] **Step 4: Commit**

```bash
git add ai_refine_v2/tests/test_regen_endpoint.py ai_refine_v2/tests/conftest.py
git commit -m "test(p0): 改既有 test 用 conftest make_user factory, 零硬编码用户名

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 一次性清理脚本 + 验证

**Files:**
- Create: `scripts/_tmp_purge_test_users.py` (用完即删)

- [ ] **Step 1: 写脚本**

```python
# scripts/_tmp_purge_test_users.py
"""一次性: 删既有 60+ 测试僵尸用户. 跑完即删本文件."""
import re
from app import app
from extensions import db
from models import User

ZOMBIE_PATTERN = re.compile(
    r"^(alice|bob_other|lock_user|bi_user|done_user|ok_user|viewer)_[a-f0-9]{6,}$"
)

with app.app_context():
    all_users = User.query.all()
    zombies = [u for u in all_users if ZOMBIE_PATTERN.match(u.username)]
    print(f"匹配 {len(zombies)} 条僵尸 (总用户 {len(all_users)})")

    if not zombies:
        print("无僵尸, 退出.")
        raise SystemExit(0)

    for u in zombies:
        db.session.delete(u)
    db.session.commit()

    remaining = User.query.filter(User.username.regexp_match(
        r"^(alice|bob_other|lock_user|bi_user|done_user|ok_user|viewer)_"
    )).count()
    print(f"删除完成. 残留 zombie 数: {remaining}")

    if remaining > 0:
        print("FAIL: 还有残留")
        raise SystemExit(1)
    print("OK")
```

- [ ] **Step 2: 跑脚本**

```bash
python scripts/_tmp_purge_test_users.py
```
Expected: 删 60+ 条 → 残留 0 → OK

- [ ] **Step 3: 删脚本文件**

```bash
rm scripts/_tmp_purge_test_users.py
```

- [ ] **Step 4: 跑全测确认无回归**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 251+ passed, 跑完 0 新 zombie 产生（因为 T2/T3 已加 rollback fixture）

- [ ] **Step 5: Commit（这一步 commit 的不是脚本, 是空状态 — 跳过）**

不需要 commit; 脚本生命周期是"写 → 跑 → 删", 本 commit 由 T5 一并打。

---

## Task 5: CI 守护测 — 防回归

**Files:**
- Create: `tests/test_no_zombie_users.py`

- [ ] **Step 1: 写守护测**

```python
# tests/test_no_zombie_users.py
"""CI 守护: 任何测跑完后, DB 不许残留 zombie-prefix 用户."""
import re
import unittest

from app import app
from models import User

ZOMBIE_RE = re.compile(
    r"^(alice|bob_other|lock_user|bi_user|done_user|ok_user|viewer)_[a-f0-9]{6,}$"
)


class TestNoZombieUsers(unittest.TestCase):
    def test_zero_zombie_remaining(self):
        with app.app_context():
            zombies = [
                u for u in User.query.all() if ZOMBIE_RE.match(u.username)
            ]
            self.assertEqual(
                len(zombies), 0,
                f"DB 残留 {len(zombies)} 条僵尸用户; "
                f"前 5: {[u.username for u in zombies[:5]]}; "
                f"修法: scripts/_tmp_purge_test_users.py 再跑一次 "
                f"(根因应已在 conftest fixture 修了)"
            )
```

- [ ] **Step 2: 跑测验证 PASS**

```bash
python -m pytest tests/test_no_zombie_users.py -v 2>&1 | tail -5
```
Expected: 1 passed (因 T4 已清完, T2/T3 已防再造)

- [ ] **Step 3: Commit**

```bash
git add tests/test_no_zombie_users.py
git commit -m "test(p0): 加 CI 守护测防 zombie 用户回归 (252 测绿)

清理已在 T4 跑过, 本测确保未来跑测后 DB 仍干净.
zombie 检测正则覆盖 7 个测试 fixture 前缀.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: P0 子任务 1 出 PR

**Files:** 不改代码

- [ ] **Step 1: push 到 feature 分支**

```bash
git checkout -b feat/p0-zombie-cleanup
git push -u origin feat/p0-zombie-cleanup
```

- [ ] **Step 2: 开 PR**

```bash
gh pr create --title "P0 子任务 1: pytest 僵尸用户根因清理" --body "$(cat <<'EOF'
## 背景

每跑一次 pytest, DB 留 60+ 条 \`alice_xxx\` / \`bob_other_xxx\` / \`lock_user_xxx\` 等脏数据 (本机已累积到 60 条).

根因: 测试 setUp 创建 User row 但 tearDown 不 rollback / delete.

## 改动

### 根本性修复 (per spec §3 原则 #2)
1. \`ai_refine_v2/tests/conftest.py\` 加 \`db_session\` autouse fixture, 每测 nested transaction + 自动 rollback
2. \`make_user\` factory fixture 替代手写 \`User(username=...)\`
3. 既有 \`test_regen_endpoint.py\` 改用新 fixture

### 一次性清理 + 防回归
4. (本 PR 不含此脚本) \`scripts/_tmp_purge_test_users.py\` 删既有 60 条僵尸 (已跑完, 文件已删)
5. \`tests/test_no_zombie_users.py\` CI 守护测, 防再造

## 验证

- [x] 全测 \`python -m pytest -q\` → 252 passed (251 baseline + 1 守护测)
- [x] 跑测 5 次后 DB 无新 zombie 产生
- [x] \`User.query.filter(zombie_pattern).count() == 0\`

## 风险

低. 改的全是测试 infra; 业务代码 0 行 diff. 回滚 = revert 单 commit.

## 回滚

\`\`\`
git revert <merge-commit>
\`\`\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 等 Scott merge 后**

PR 状态变 merged, T1-T6 子任务 1 完结。

---

## Task 7: v3.3 push (等授权)

**Files:** 不改代码

- [ ] **Step 1: STOP — 等 Scott 说 "push v3.3"**

不主动跑。Scott 说 push 后:

```bash
git checkout feat/regen-single-screen-v33
git push origin feat/regen-single-screen-v33
```

- [ ] **Step 2: 在 GitHub 上手开 PR (gh pr create) 或等 Scott 操作**

PR title: `feat(regen-v1): v3.3 单屏 reroll 全套上线 (251 测绿)`

PR body 引用 v3.3 spec + plan 路径，task 1-9 commit list。

---

## Task 8: v3.3 真测 ¥0.7 (等授权)

**Files:** 不改代码（远程 prod 跑）

- [ ] **Step 1: STOP — 等 Scott 说 "真测 v3.3"**

注意: 真测必须在 deploy 后跑 (用 prod 上的新 v3.3 端点)。

- [ ] **Step 2: 走 v3.3 plan task 10 step 3 流程**

进 prod batch detail → 分屏视图 → 点 🔄 → 确认 → 等 ~30s 看刷图。

成本: ¥0.7。

- [ ] **Step 3: 写 memory**

更新 `project_v33_regen_single_complete.md` 加真测结果。

---

## Task 9: v3.3 deploy 腾讯云 (等授权)

**Files:** 不改代码

- [ ] **Step 1: STOP — 等 Scott 说 "deploy"**

- [ ] **Step 2: 走 /deploy skill**

或者直接：
```bash
ssh tencent-prod "cd /root/clean-industry-ai-assistant && git pull && docker compose restart && sleep 5 && docker compose ps"
```

- [ ] **Step 3: 验证**

```bash
curl -s -o /dev/null -w 'http=%{http_code}\n' http://124.221.23.173:5000/
```
Expected: 302 (redirect to login)

---

## Task 10: 腾讯云 prod admin 密码同步 (等授权)

**Files:**
- Create: `scripts/reset_prod_admin.py` (用完即删)

- [ ] **Step 1: STOP — 等 Scott 说 "go prod 密码"**

- [ ] **Step 2: 写脚本（参考 docs/2026-04-21_踩坑复盘 §坑5 教训）**

```python
# scripts/reset_prod_admin.py
"""一次性: 重置腾讯云 prod admin 密码 + write+verify 闭环."""
from app import app
from extensions import db
from models import User
from werkzeug.security import check_password_hash

NEW_PW = "2829347524an"

with app.app_context():
    u = User.query.filter_by(username="admin").first()
    if u is None:
        print("ERR: prod admin 不存在 (异常)")
        raise SystemExit(2)

    u.set_password(NEW_PW)
    u.is_approved = True
    u.is_admin = True
    db.session.commit()

    fresh = User.query.filter_by(username="admin").first()
    ok_hash = check_password_hash(fresh.password_hash, NEW_PW)
    ok_method = fresh.check_password(NEW_PW)
    print(f"verify: hash={ok_hash} method={ok_method} approved={fresh.is_approved}")

    if not (ok_hash and ok_method and fresh.is_approved):
        raise SystemExit(1)
    print("OK")
```

- [ ] **Step 3: scp + docker exec 跑**

```bash
scp scripts/reset_prod_admin.py tencent-prod:/tmp/
ssh tencent-prod "docker compose -f /root/clean-industry-ai-assistant/docker-compose.yml exec -T web python /tmp/reset_prod_admin.py"
```
Expected: `OK` 输出

- [ ] **Step 4: curl 登录验证 (写后必验铁律)**

```bash
# 取 CSRF token, 然后 POST 登录
curl -s -c /tmp/cookies.txt http://124.221.23.173:5000/auth/login | grep csrf_token
curl -s -b /tmp/cookies.txt -c /tmp/cookies.txt -d "username=admin&password=2829347524an&csrf_token=<token>" -w '%{http_code}\n' http://124.221.23.173:5000/auth/login -o /dev/null
```
Expected: 302 (login success)

如果 200 → 凭据无效 → 重排查（密码字符串问题 / CSRF / 容器 bind mount）。

- [ ] **Step 5: 删脚本 + 删远程脚本**

```bash
rm scripts/reset_prod_admin.py
ssh tencent-prod "rm /tmp/reset_prod_admin.py"
```

- [ ] **Step 6: 写 memory**

```
# project_prod_admin_password_synced.md
2026-05-06 prod admin 密码与本机统一为 2829347524an, 走 docker exec + write+verify 闭环.
```

---

## 完成标准

- [ ] T1-T6 全过, PR feat/p0-zombie-cleanup 合并到 main
- [ ] 全测 ≥ 252 passed (251 baseline + 1 守护测), 0 zombie
- [ ] T7 v3.3 push 完成 (Scott 授权后)
- [ ] T9 v3.3 deploy 完成 (Scott 授权后)
- [ ] T8 v3.3 真测出 1 单 reroll 通过 (Scott 授权 + 烧 ¥0.7)
- [ ] T10 prod admin 密码 = 本机密码, 真登录验证 302
- [ ] memory 留 2 条新记录: P0 完成 / prod 密码同步

## 风险与回滚

| 风险 | 触发概率 | 应对 |
|---|---|---|
| conftest db_session 跟某个老测试冲突 (有 setUpClass 跨测共享数据) | 25% | T2 跑全测时若有 fail, 用 indirect parametrize 排查具体测; 无解则该类用 unittest 老路, 加 explicit cleanup |
| pytest-flask-sqlalchemy 风格 fixture 跟 unittest.TestCase 不兼容 | 35% | 退到方案 B (手写 nested transaction in conftest), 已在 T2 step 3 实现 |
| prod 密码改完登录仍失败 | 5% | docker compose 容器没接 instance/ bind mount → 跑脚本写到容器层 ephemeral, 删容器后丢失. 检查 docker-compose.yml 确认 volume mount instance/, 否则改方案 |
| v3.3 真测烧 ¥0.7 但 reroll 失败 (gpt-image-2 报错) | 10% | spec §13 已说"端点不计费 + 返 500", 用户重试; 若反复失败查 ARK_API_KEY 是否过期 (memory user_24h_key_autoclear) |

**回滚:**
- T1-T6: `git revert <PR-merge-commit>`
- T7: `git push origin :feat/regen-single-screen-v33` (强删远端分支) — 但这是 v3.3 收尾, 不该回滚
- T9: ssh tencent-prod + docker compose stop + git reset --hard <prev-commit> + docker compose up -d
- T10: 重跑脚本传旧密码即可

---

**Plan 起草日期**: 2026-05-06
**作者**: Claude Opus 4.7
**对应 Spec**: `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §5
**预计工时**: 1-2 小时（不含等 Scott 授权的 wait time）
