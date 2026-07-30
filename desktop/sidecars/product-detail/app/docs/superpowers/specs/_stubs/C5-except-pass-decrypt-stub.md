# [STUB] §C.5 `_get_user_api_key` 解密 except: pass 静默吞

> ⚠️ 草稿状态: 由 P2 audit 自动生成, 待 Scott review 决定是否转正式 spec.
> 来源: `docs/superpowers/audits/2026-05-06-tech-debt-audit.md` § Top 10 #1
> 严重度: 严重
> 估时: 10 min

## 问题简述

`app.py:1091-1093` 的 `_get_user_api_key` 解密失败时 `except Exception: pass` 完全静默吞。Fernet key 轮转或 DB 迁移导致解密失败时, 用户看到"未配置 Key"误导提示, 运维 0 信号。

## 根因诊断

跟根因 2 (缺统一 logging) 关联。但即便有 logging 也需要主动加; 这里是 demo 阶段习惯延续到生产。

## 修复方案

### 方案 A — 加 logger.warning (推荐)
```python
except Exception as e:
    logger.warning("[api-key] 解密失败 user_id=%s: %s", user.id, e, exc_info=True)
    return None
```
- 优势: 保留 fallback 行为, 但运维有信号
- 劣势: 依赖根因 2 (logging 体系) 先做
- 估时: 10 min

### 方案 B — 抛 RuntimeError
```python
except Exception as e:
    raise RuntimeError(f"API key 解密失败 (Fernet key 可能已轮转): {e}")
```
- 优势: 暴露问题最直接
- 劣势: 影响用户体验 (现状是回退到 platform key, 抛错会断开)
- 估时: 0.5h (含改 caller)

## 兜底/回滚

```bash
git revert <commit>
```
影响 caller: 5+ 路由调用 `_get_user_api_key`, 全走"返回 None 兜底" 路径不变。

## 转正式 spec checklist

- [ ] Scott 决策 "修"
- [ ] 选定方案 (A / B)
- [ ] 改 spec 文件名为 `2026-XX-XX-api-key-decrypt-error-handling-design.md`
- [ ] 移到 specs/ 根目录
- [ ] 进入 P4 队列

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
