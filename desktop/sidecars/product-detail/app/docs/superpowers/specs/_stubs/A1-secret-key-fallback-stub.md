# [STUB] §A.1 SECRET_KEY 硬编码回退 — 生产 session 可伪造

> ⚠️ 草稿状态: 由 P2 audit 自动生成
> 来源: § Top 10 #2 / § §A.1
> 严重度: 严重
> 估时: 0.5h

## 问题简述

`app.py:68` 用 `_secret_key or "dev-change-me-in-production"` 在 SECRET_KEY 环境变量空时静默回退。生产 .env 一旦丢失 SECRET_KEY, 攻击者可用此公开字符串伪造任意用户 session cookie, 实现完整账号接管。

## 根因诊断

跟根因 3 (缺统一 config 体系) 一致。"代码默认值兜底"是反模式 —— 生产环境配置缺失应当 fail-fast 而非用 demo 默认值。

## 修复方案

### 方案 A — fail-fast (推荐)
```python
_secret_key = os.environ.get("SECRET_KEY")
if not _secret_key:
    if FLASK_ENV == "development":
        _secret_key = "dev-change-me-in-production"
    else:
        sys.stderr.write("FATAL: SECRET_KEY 未设, 拒绝在非 development 环境启动\n")
        sys.exit(1)
SECRET_KEY = _secret_key
```
- 优势: 攻击面立刻关闭
- 劣势: 部署时 .env 未配会启动失败 (这其实是 feature 不是 bug)
- 估时: 0.5h (含 smoke test 加 "无 SECRET_KEY 启动失败" 断言)

### 方案 B — 启动时随机生成 + 持久化
- 第一次启动若无 SECRET_KEY 自动生成一个 random key 写到 instance/secret.key
- 优势: 部署友好
- 劣势: 跨实例不一致 (容器重建丢, 多 worker 无法共享)
- 估时: 1h

## 兜底/回滚

回滚: `git revert`. 但回滚后再次面临 session 伪造风险 — 不建议回滚。

## 部署联动

修复需同步:
- 腾讯云 prod `.env` 必须有 SECRET_KEY (per `reference_tencent_prod_path.md`)
- `.env.example` 加上 `SECRET_KEY=` 提示
- Dockerfile / docker-compose 注入校验

## 转正式 spec checklist

- [ ] Scott 决策 "修"
- [ ] 选方案 (A / B)
- [ ] 加 smoke test
- [ ] 进入 P4

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
