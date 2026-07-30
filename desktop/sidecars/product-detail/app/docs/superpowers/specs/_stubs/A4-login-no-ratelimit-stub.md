# [STUB] §A.4 登录无 rate-limit — 5 客户上线前必修

> ⚠️ 草稿状态: 由 P2 audit 自动生成
> 来源: § Top 10 #6 / §A.4
> 严重度: 中 (但商业紧急度高 — 5 客户上线前必修)
> 估时: 2h

## 问题简述

`auth.py:13-36` `/auth/login` POST 端点无任何频率限制。攻击者可无限次尝试用户名+密码组合。密码最低 6 字符 (auth.py:55) 弱密码秒破。5 个 demo 客户即将试用, 公网可达, 风险窗口已打开。

## 根因诊断

demo 阶段未引入限流组件; master roadmap §3 工程原则未把"商业上线前必备的运维加固"显式列出。

## 修复方案

### 方案 A — flask-limiter (推荐)
```python
# requirements.txt
flask-limiter>=3.5

# extensions.py
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
limiter = Limiter(key_func=get_remote_address, default_limits=[])

# app.py
limiter.init_app(app)

# auth.py
@auth_bp.route("/login", methods=["POST"])
@limiter.limit("5 per minute; 20 per hour")
def login_post():
    ...
```
- 优势: 业界标准方案, 配置简单
- 劣势: 需新增依赖, 默认 in-memory 存储 (单 worker 够用; 阶段七多 worker 需 Redis)
- 估时: 2h

### 方案 B — 自实现轻量 rate limiter
- 自己写 IP+timestamp 字典做计数
- 优势: 0 依赖
- 劣势: 重复造轮子, 易出 bug
- 估时: 4h
- **不推荐**

## 加固组合 (与方案 A 配合)

- 连续 5 次失败 → 账号锁定 15 分钟 (DB 加 `last_failed_at` / `failed_count` 字段)
- failed_count 累积重置策略: 成功登录或 24h 自动归零

## 兜底/回滚

`git revert` 即停限流, 用户体验恢复。

## 转正式 spec checklist

- [ ] Scott 决策 "修" (强烈建议 5 客户上线前)
- [ ] 选方案 (A 推荐)
- [ ] 加 lockout 字段?
- [ ] migration
- [ ] 进入 P4

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
