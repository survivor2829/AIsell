# [STUB] §C1 全局零 logging — 228 处 print() 无结构化日志

> ⚠️ 草稿状态: 由 P2 audit 自动生成
> 来源: § Top 10 #7 / §C.1
> 严重度: 严重
> 估时: 1d

## 问题简述

228 处 `print(f"[xxx]")` 散落在 12 个文件 (app.py / ai_image*.py / batch_processor.py / ai_refine_v2/*)。Docker gunicorn 下无级别 / 无时间戳 / 无 request_id。出问题时:
- 无法 grep ERROR 级别
- 无法静默 INFO 减噪音
- 无法关联同一请求的多条日志
- 无法对接 ELK / Sentry / Loki 等监控

## 根因诊断

**根因 2 — 缺统一 logging 体系**。修这一处 = 解决 §C.1 + §C.5 (except: pass 无 log) + 间接配合所有未来错误处理标准化。

## 修复方案

### 方案 A — 标准 logging.config.dictConfig (推荐)
1. 新建 `log_config.py`:
```python
import logging.config

LOG_CONFIG = {
    "version": 1,
    "formatters": {
        "default": {
            "format": "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            "datefmt": "%Y-%m-%d %H:%M:%S",
        },
        "json": {
            "()": "pythonjsonlogger.jsonlogger.JsonFormatter",
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "default"},
        "file": {
            "class": "logging.handlers.RotatingFileHandler",
            "filename": "logs/app.log",
            "maxBytes": 10 * 1024 * 1024, "backupCount": 5,
            "formatter": "json",
        },
    },
    "root": {"level": "INFO", "handlers": ["console", "file"]},
}

def setup_logging():
    logging.config.dictConfig(LOG_CONFIG)
```

2. `app.py` 启动时 `from log_config import setup_logging; setup_logging()`

3. 各模块顶部:
```python
import logging
logger = logging.getLogger(__name__)
```

4. 批量替换 (逐文件审过):
- `print(f"[ERROR]...")` → `logger.error(...)`
- `print(f"[WARN]...")` → `logger.warning(...)`
- `print(f"[INFO]...")` → `logger.info(...)`
- `print(f"...")` 无前缀 → 默认 `logger.debug(...)`, 后人 review 时再升级

- 优势: 标准库, 0 新依赖 (json 格式可选 python-json-logger)
- 劣势: 工作量大, 12 文件 ~228 处
- 估时: 1d

### 方案 B — 引入 loguru
- pip install loguru, 一行 `from loguru import logger`
- 优势: API 极简, 自带颜色 + traceback
- 劣势: 新依赖, 与 logging 不完全兼容 (Flask/Werkzeug 仍用 stdlib logging, 双轨)
- 估时: 0.5d
- **不推荐** (Flask 生态系统全用 stdlib logging)

## 兜底/回滚

`git revert <PR-merge-commit>` 整个 logging 改动可还原。批量 print → logger 替换可用 git diff 抽样验证。

## 转正式 spec checklist

- [ ] Scott 决策 "修"
- [ ] 选方案 (强烈推荐 A)
- [ ] 决定 console-only / 加 file rotation / 加 json (后两者省事直接全开)
- [ ] 进入 P4 (建议作为修根因 2 的 sprint, 一次性扫掉)

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
