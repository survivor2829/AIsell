# [STUB] §C.10 `_clear_proxy` 多线程 race condition

> ⚠️ 草稿状态: 由 P2 audit 自动生成
> 来源: § Top 10 #4 / §C.10
> 严重度: 严重
> 估时: 1h

## 问题简述

`ai_image.py:29-39` / `ai_image_volcengine.py:32-42` 的 `_clear_proxy()` pop `os.environ` 全局, `_restore_proxy()` 还原。多线程并发 (batch_queue 3-worker) 时:
- Thread A pop → A.saved 完整
- Thread B 同函数发现已无代理 → B.saved 空
- A restore → B 后续请求带回代理污染

实际取决于 GIL 调度时序, 理论上可重现的 race condition。

## 根因诊断

跟根因 4 (多 worker 状态管理简陋) 一致。`os.environ` 是进程级共享状态, 多线程不安全; 应当走线程局部 (TLS) 或绕开 env 直接配 SDK 参数。

## 修复方案

### 方案 A — volcengine 删除 (已有双保险), DashScope 进程级一次性 unset (推荐)
```python
# ai_image_volcengine.py: 删除 _clear_proxy / _restore_proxy 调用 (session 已 trust_env=False)

# ai_image.py: 模块加载时
def _disable_proxy_for_dashscope():
    """DashScope SDK 不允许配 session, 进程启动时一次性清."""
    for k in _PROXY_KEYS:
        os.environ.pop(k, None)
_disable_proxy_for_dashscope()
```
- 优势: 0 race condition; 代码更简洁
- 劣势: 进程内任何其他模块若需要代理会受影响 (实际项目无此情况)
- 估时: 1h

### 方案 B — TLS 包装
```python
import threading
_proxy_local = threading.local()

@contextmanager
def proxy_bypass():
    saved = {k: os.environ.pop(k, None) for k in _PROXY_KEYS}
    _proxy_local.saved = saved
    try:
        yield
    finally:
        for k, v in saved.items():
            if v: os.environ[k] = v
```
- 优势: 完全 thread-safe
- 劣势: `os.environ` 本身是进程共享, TLS 无法真隔离 — 这只是"看似"安全的表象
- 估时: 1.5h
- ⚠️ **不推荐** — 治标不治本

## 兜底/回滚

`git revert` 单文件可还原。

## 转正式 spec checklist

- [ ] Scott 决策 "修"
- [ ] 选方案 (强烈推荐 A)
- [ ] 加并发烧图 smoke 测验证
- [ ] 进入 P4

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
